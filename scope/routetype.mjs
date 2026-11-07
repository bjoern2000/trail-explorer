// Trail Scope — topological loop detection, and an offline repair for derived data.
//
// WHY THIS EXISTS. The first/last coordinate test derive.mjs originally used cannot
// survive two things it has no control over:
//
//   1. The greedy chaining walk (MERGE_PLAN §6) emits parts in an arbitrary order, so
//      "the first coordinate of the first part" and "the last coordinate of the last
//      part" are frequently not the trail's two ends at all.
//   2. Orienting each trail low-end-first reverses parts independently, which scrambles
//      that ordering further.
//
// Together they collapsed the measured loop share to 3 percent in every region, which is
// obviously wrong: identical percentages across three unrelated regions is the signature
// of a broken test, not a finding.
//
// THE FIX is topological and order-independent. Collect both endpoints of every part. An
// endpoint is "open" when no other endpoint lies within tolerance. A closed figure has no
// open ends; an open path has exactly two. Part order and part direction cannot affect
// the answer, which is the whole point.
//
//   node scope/routetype.mjs            repair all three committed regions in place
//   node scope/routetype.mjs <region>   repair one
//
// This runs entirely on the committed geometry. It makes no network call, which matters:
// Overpass rate-limits hard, and re-fetching to fix a classification bug would be absurd.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DERIVED = join(HERE, 'derived');

/** Endpoints within this distance are treated as the same node. */
export const LOOP_CLOSE_M = 100;
/** Below this, "loop" is noise: a 30 m stub whose ends nearly touch is not a loop. */
export const LOOP_MIN_LENGTH_M = 200;

function haversineMeters(a, b) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** LineString → one part; MultiLineString → n parts. */
export function geometryParts(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/**
 * Classify a merged geometry as a closed figure or an open path.
 *
 * Returns the route type plus the open-end count, which is worth keeping: 0 is a loop,
 * 2 is a clean open path, and 4 or more means the trail is in genuinely disjoint pieces
 * (a real gap, like the 2 km break in Longs Peak, not a merge artifact).
 */
export function classifyRouteType(geometry, lengthM) {
  const parts = geometryParts(geometry).filter((p) => p && p.length >= 2);
  if (parts.length === 0) return { routeType: 'point-to-point', openEnds: 0 };

  // Every endpoint, tagged with which part and which end it came from.
  const ends = [];
  for (let p = 0; p < parts.length; p++) {
    ends.push({ p, e: 0, c: parts[p][0] });
    ends.push({ p, e: 1, c: parts[p][parts[p].length - 1] });
  }

  let openEnds = 0;
  for (let i = 0; i < ends.length; i++) {
    let matched = false;
    for (let j = 0; j < ends.length; j++) {
      // An endpoint may match the other end of its OWN part: that is exactly what a
      // single-part closed loop looks like. It just may not match itself.
      if (i === j) continue;
      if (haversineMeters(ends[i].c, ends[j].c) <= LOOP_CLOSE_M) {
        matched = true;
        break;
      }
    }
    if (!matched) openEnds++;
  }

  const routeType = openEnds === 0 && lengthM > LOOP_MIN_LENGTH_M ? 'loop' : 'point-to-point';
  return { routeType, openEnds };
}

// ---- repair -----------------------------------------------------------------

function repair(region) {
  const file = join(DERIVED, `${region}.json`);
  const data = JSON.parse(readFileSync(file, 'utf8'));

  let changed = 0;
  let loops = 0;
  let disjoint = 0;
  for (const t of data.trails) {
    const { routeType, openEnds } = classifyRouteType(t.geometry, t.lengthM);
    if (t.routeType !== routeType) changed++;
    t.routeType = routeType;
    if (routeType === 'loop') loops++;
    if (openEnds > 2) disjoint++;
  }

  writeFileSync(file, JSON.stringify(data));
  const n = data.trails.length;
  const pct = (x) => `${Math.round((x / n) * 100)}%`;
  console.log(
    `${region.padEnd(7)} ${String(n).padStart(4)} trails · ${String(loops).padStart(3)} loops ` +
      `(${pct(loops).padStart(4)}) · ${changed} reclassified · ${disjoint} in disjoint pieces`,
  );
}

const arg = process.argv[2];
const regions = arg ? [arg] : ['rmnp', 'adk', 'ozarks'];
for (const r of regions) repair(r);
