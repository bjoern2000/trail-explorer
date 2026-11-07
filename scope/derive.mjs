// Trail Scope — trail derivation pipeline (standalone Node, no deps).
//
// SCOPE_PLAN §4 in one file: Overpass → merge → elevation → derive → committed JSON.
// The page imports scope/derived/<region>.json statically, so the prototype is
// deterministic, instant, offline-safe, and cannot flake in front of an exec.
//
// Three modes, mirroring benchmark/derive.mjs and merge/fixture.mjs:
//
//   node scope/derive.mjs probe <region|all>
//       Count-only Overpass reconnaissance. Free. Prints named ways and distinct names
//       so we know the region fits under the 6,000-element cap BEFORE doing real work.
//       Run this first: a capped fetch truncates silently, which is how you end up
//       quoting a coverage number from a region you only half downloaded.
//
//   node scope/derive.mjs <region|all> [--refetch]
//       The full pipeline. Writes scope/derived/<region>.json. The raw Overpass response
//       is cached under .cache/scope-overpass/ keyed by query text, so re-deriving after a
//       change to the maths costs no network at all; --refetch forces a fresh pull.
//
//   node scope/derive.mjs verify
//       Re-runs the Longs Peak elevation anchor and prints per-region counts and sanity
//       aggregates from the derived files already on disk. No trail fetch.
//
// Two rules this file exists to enforce:
//   1. It calls the SHIPPED merge functions from src/data/merge.ts (Node 24 strips the
//      types; merge.ts deliberately has no browser imports). Nothing is reimplemented,
//      so the derived trails and the map app's search can never disagree.
//   2. Elevation goes through scope/terrarium.mjs, which reproduces src/data/elevation.ts
//      numerically. Anchor: Longs Peak summit decodes to 4346.4 m against a known 4346 m.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeTrailName,
  clusterSegmentsAll,
  mergeSegmentsToFeature,
  featureParts,
  featureLengthMeters,
  CLUSTER_GAP_M,
} from '../src/data/merge.ts';

import {
  buildProfile,
  verifyAnchor,
  haversineMeters,
  ELEVATION_SOURCE,
  SAMPLES,
} from './terrarium.mjs';

// Canopy and terrain aspect. A separate file because it is a separate question with a
// separate frozen snapshot (scope/canopy/<region>.json), and because it has its own CLI:
// re-deriving canopy after a change to the maths must not mean re-deriving every trail.
// It runs here as well so a full derive from scratch produces a complete payload.
import { canopyBlockFor, deriveCanopyAndAspect, readCanopy } from './canopy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DERIVED_DIR = join(HERE, 'derived');
/** Raw Overpass responses, keyed by query text. Gitignored via the .cache/ line, exactly
 *  as server.js caches its own Overpass proxy calls. Everything after the fetch is pure
 *  computation, so this makes re-deriving free and keeps us off a public endpoint that
 *  rate-limits. `--refetch` forces a fresh pull. */
const RAW_DIR = join(HERE, '..', '.cache', 'scope-overpass');

/** Must stay identical to merge/fixture.mjs BBOXES and benchmark/derive.mjs, so every
 *  page in TrailScope is talking about the same three patches of ground. */
const REGIONS = {
  rmnp: [-105.75, 40.25, -105.55, 40.42],
  adk: [-74.02, 44.05, -73.78, 44.26],
  ozarks: [-92.85, 37.95, -92.55, 38.2],
};

// Single upstream endpoint by choice; see the note in server.js. The retries below cover
// the overload 504s that are Overpass's actual failure mode.
const ENDPOINTS = ['https://overpass-api.de/api/interpreter'];

/** Same cap as src/data/overpass.ts. Above this Overpass truncates and says nothing. */
const OVERPASS_MAX_ELEMENTS = 6000;

/** src/scope/types.ts PROFILE_POINTS. Duplicated because a .mjs cannot import a const
 *  from a .ts type module without pulling GeoJSON types in; kept in sync by hand and
 *  asserted below so a drift fails loudly rather than rendering a wrong sparkline. */
const PROFILE_POINTS = 48;

/** Window over which a grade must hold to count as "sustained". 200 m is roughly five
 *  samples on a 5 km trail, so a single-sample DEM spike cannot set the number. */
const GRADE_WINDOW_M = 200;

/** A part shorter than this cannot set a trail's grade. Merging leaves 2-vertex stubs a
 *  few metres long (MERGE_PLAN §6), and one DEM pixel step across a 6 m stub reads as a
 *  100%+ "sustained" grade. Measured: this was giving Fern Lake Trail 86.7% off a 2 m
 *  fragment. Parts below the threshold are skipped unless the whole trail is that small,
 *  in which case the longest part is used so the field is still populated. */
const GRADE_MIN_RUN_M = 50;

/** Loop test: the overall first and last coordinate come back within this distance. */
const LOOP_CLOSE_M = 100;
/** …and the trail is at least this long, so a 6 m stub whose ends nearly touch is not a loop. */
const LOOP_MIN_LENGTH_M = 200;

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Overpass -----------------------------------------------------------------

/**
 * Every NAMED path/footway/track way in the bbox. The highway filter is character-for-
 * character src/data/overpass.ts's, plus an existence filter on `name`: an unnamed way
 * cannot become a discoverable trail, and the whole page is about the naming layer.
 *
 * `mode`: 'geom' is the real query (recorded verbatim into the output and shown on the
 * page); 'tags' is the free probe. The probe deliberately omits the element cap so it
 * reports the TRUE count and therefore true headroom, rather than a clipped 6,000.
 */
function buildQuery(bbox, mode = 'geom') {
  const [w, s, e, n] = bbox;
  const out = mode === 'geom' ? `out geom qt ${OVERPASS_MAX_ELEMENTS};` : 'out tags;';
  return `[out:json][timeout:180];
way["highway"~"^(path|footway|track)$"]["name"](${s},${w},${n},${e});
${out}`;
}

/** Rounds are generous and back off hard: a burst of queries gets the endpoint to drop TLS
 *  connections outright, and that cooldown is minutes, not seconds. */
async function overpass(query, rounds = 6) {
  let lastErr;
  for (let round = 0; round < rounds; round++) {
    for (const url of ENDPOINTS) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'TrailScope/0.1 (trail data source evaluation)',
          },
          body: new URLSearchParams({ data: query }),
        });
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        return await resp.json();
      } catch (err) {
        lastErr = err;
      }
    }
    if (round < rounds - 1) {
      const wait = 15000 * 2 ** round;
      console.log(`  overpass retry ${round + 1}/${rounds - 1} in ${wait / 1000}s (${lastErr?.message})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Overpass response for `query`, from .cache/scope-overpass/ when the same query text is
 *  already there. The key is a hash of the query, so editing the query invalidates it. */
async function overpassCached(query, label, refetch = false) {
  mkdirSync(RAW_DIR, { recursive: true });
  const key = createHash('sha1').update(query).digest('hex').slice(0, 12);
  const file = join(RAW_DIR, `${label}-${key}.json`);
  if (!refetch && existsSync(file)) {
    console.log(`  overpass            : cached (${file.replace(HERE + '/..', '.')})`);
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  const json = await overpass(query);
  writeFileSync(file, JSON.stringify(json));
  console.log(`  overpass            : fetched and cached`);
  return json;
}

/** Same conversion as src/data/overpass.ts osmToGeoJSON, and as merge/verify.mjs. */
function toFeatures(elements) {
  return elements.map((el) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [p.lon, p.lat]) },
    properties: { ...(el.tags ?? {}), '@id': `way/${el.id}`, __fid: `osm:way/${el.id}`, __source: 'osm' },
  }));
}

// ---- derivation helpers -------------------------------------------------------

/** Id slug from a normalized name: the id has to survive being a URL fragment and a
 *  filename, and OSM names carry slashes, commas, apostrophes and parentheses. */
function slugify(normalizedName) {
  const s = normalizedName.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'unnamed';
}

function allCoords(parts) {
  const out = [];
  for (const p of parts) for (const c of p) out.push(c);
  return out;
}

function bboxOf(parts) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of parts) {
    for (const c of p) {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    }
  }
  return [w, s, e, n];
}

/** Mean of every vertex. Preferred over the bbox centre because the "closest" sort ranks
 *  by distance from the assumed location, and an L-shaped trail's bbox centre can sit
 *  well off the trail itself. */
function centroidOf(parts) {
  let sx = 0, sy = 0, n = 0;
  for (const p of parts) {
    for (const c of p) {
      sx += c[0];
      sy += c[1];
      n++;
    }
  }
  return n > 0 ? [sx / n, sy / n] : [0, 0];
}

/**
 * Steepest grade that HOLDS over GRADE_WINDOW_M, from the smoothed series, never spanning
 * a part seam. Absolute value: the stored direction of an OSM way is arbitrary, so a
 * descent in the data is a climb walked the other way. Parts between GRADE_MIN_RUN_M and
 * the window fall back to their overall rise over run; parts below GRADE_MIN_RUN_M are
 * ignored, because a stub that short cannot evidence a sustained anything.
 */
function maxSustainedGradePct(distM, smoothM, partIndex, windowM = GRADE_WINDOW_M) {
  // Part boundaries as [start, end) index ranges, with their real lengths.
  const ranges = [];
  let start = 0;
  for (let k = 1; k <= distM.length; k++) {
    if (k === distM.length || partIndex[k] !== partIndex[start]) {
      if (k - start >= 2) ranges.push({ start, end: k, len: distM[k - 1] - distM[start] });
      start = k;
    }
  }
  if (ranges.length === 0) return 0;
  // Normally only parts long enough to mean something. If none qualifies the whole trail
  // is a fragment, so fall back to its longest part rather than reporting a flat 0.
  let usable = ranges.filter((r) => r.len >= GRADE_MIN_RUN_M);
  if (usable.length === 0) usable = [ranges.reduce((a, b) => (b.len > a.len ? b : a))];

  let best = 0;
  for (const r of usable) {
    if (r.len <= 0) continue;
    if (r.len < windowM) {
      const g = (Math.abs(smoothM[r.end - 1] - smoothM[r.start]) / r.len) * 100;
      if (g > best) best = g;
      continue;
    }
    // Monotone two-pointer: for each i, the nearest j at least windowM further along.
    let j = r.start;
    for (let i = r.start; i < r.end; i++) {
      if (j < i) j = i;
      while (j < r.end - 1 && distM[j] - distM[i] < windowM) j++;
      const dx = distM[j] - distM[i];
      if (dx < windowM) break; // ran out of part; every later i has less room
      const g = (Math.abs(smoothM[j] - smoothM[i]) / dx) * 100;
      if (g > best) best = g;
    }
  }
  return best;
}

/**
 * Resample the 120-point series to exactly PROFILE_POINTS by linear interpolation in index
 * space, so every card's sparkline costs the same to render, and report which output
 * indices begin a new disconnected part.
 *
 * Interpolation stops at a part boundary: blending the last sample of one part with the
 * first of the next averages two elevations that are not connected on the ground, which is
 * how you get a phantom mid-air value. Straddling pairs snap to the nearer sample instead.
 *
 * `seamIndices` describes the SERIES THAT IS DRAWN, so a part too short to win an output
 * index contributes no seam. That means seamIndices.length + 1 can be less than `parts`,
 * which is correct: an undrawn part needs no break in the line.
 */
function downsampleProfile(elevM, partIndex, points = PROFILE_POINTS) {
  if (elevM.length === 0) return { profile: new Array(points).fill(0), seamIndices: [] };
  if (elevM.length === 1) return { profile: new Array(points).fill(elevM[0]), seamIndices: [] };
  const profile = [];
  const outPart = [];
  for (let i = 0; i < points; i++) {
    const t = (i * (elevM.length - 1)) / (points - 1);
    const lo = Math.floor(t);
    const hi = Math.min(elevM.length - 1, lo + 1);
    const f = t - lo;
    if (partIndex[lo] === partIndex[hi]) {
      profile.push(elevM[lo] + (elevM[hi] - elevM[lo]) * f);
      outPart.push(partIndex[lo]);
    } else {
      const pick = f < 0.5 ? lo : hi;
      profile.push(elevM[pick]);
      outPart.push(partIndex[pick]);
    }
  }
  const seamIndices = [];
  for (let i = 1; i < points; i++) if (outPart[i] !== outPart[i - 1]) seamIndices.push(i);
  return { profile, seamIndices };
}

/** Reverse a part list end to end: parts in reverse order, each part's vertices reversed. */
function reverseParts(parts) {
  return parts
    .slice()
    .reverse()
    .map((p) => p.slice().reverse());
}

/**
 * Road-style name suffixes, spelled out and abbreviated. Tested against the LAST token
 * only, so "Trail Court" is caught: what the name ends in decides, not whether the word
 * "trail" appears somewhere in it.
 */
const ROAD_SUFFIXES = new Set([
  'lane', 'ln',
  'court', 'ct',
  'drive', 'dr',
  'circle', 'cir',
  'road', 'rd',
  'street', 'st',
  'way',
  'terrace', 'ter',
  'place', 'pl',
  'boulevard', 'blvd',
  'avenue', 'ave', 'av',
  'parkway', 'pkwy',
  'cove', 'isle',
]);

/** Tags that mean somebody deliberately mapped this as a trail. Any one vetoes the flag. */
const TRAILISH_TAGS = ['sac_scale', 'trail_visibility', 'mtb:scale', 'trailblazed', 'ski', 'piste:type'];

/**
 * True when this looks like a subdivision street rather than a trail (types.ts likelyRoad).
 * Three conditions, all required, and deliberately conservative: a false positive hides a
 * real trail from the default list, which is worse than leaving a driveway in it.
 *
 *   1. Every member way that carries a `highway` tag carries `track`. One path or footway
 *      member means a mapper called this a trail, so we do not overrule them.
 *   2. No trail-ish tagging anywhere: no hiking grade, no visibility rating, no formal
 *      `designated` access for a travel mode. Streets do not get these.
 *   3. The name's last token is a road suffix.
 */
function classifyLikelyRoad(features, name) {
  let sawHighway = false;
  for (const f of features) {
    const h = f.properties?.highway;
    if (typeof h !== 'string' || h === '') continue;
    sawHighway = true;
    if (h !== 'track') return false;
  }
  if (!sawHighway) return false;
  for (const f of features) {
    const t = f.properties ?? {};
    for (const key of TRAILISH_TAGS) {
      if (typeof t[key] === 'string' && t[key].trim() !== '') return false;
    }
    if (t.foot === 'designated' || t.bicycle === 'designated' || t.horse === 'designated') return false;
  }
  const tokens = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // A single-token name ("Road") is not evidence of a street; it needs a proper name too.
  if (tokens.length < 2) return false;
  return ROAD_SUFFIXES.has(tokens[tokens.length - 1]);
}

/** Dominant OSM `surface` across member ways, weighted by way LENGTH: a trail that is
 *  400 m of rock and 30 m of gravel is a rock trail. null when nothing is tagged. */
function dominantSurface(features) {
  const byValue = new Map();
  for (const f of features) {
    const v = f.properties?.surface;
    if (typeof v !== 'string' || v.trim() === '') continue;
    byValue.set(v, (byValue.get(v) ?? 0) + featureLengthMeters(f));
  }
  if (byValue.size === 0) return null;
  return [...byValue.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

const ALLOWS = new Set(['yes', 'designated']);

/**
 * Activities from OSM access tags. `any member way allows it` rather than `all do`,
 * because OSM access tagging on trails is patchy enough that requiring unanimity would
 * make almost everything untagged.
 *
 * Two honest limits, both reported by the CLI:
 *   * A trail with no foot/bicycle/horse tag on any member way defaults to ['hike','run']
 *     and is counted as untagged, so the page can state the fraction rather than imply
 *     the data said so.
 *   * `horse` is read but cannot be stored: src/scope/types.ts Activity is hike|run|bike
 *     only (SCOPE_PLAN §2 scopes discovery to the three summer activities). The count is
 *     surfaced in the console report instead of being silently dropped.
 */
function deriveActivities(features) {
  let tagged = false;
  let foot = false;
  let bike = false;
  let horse = false;
  for (const f of features) {
    const t = f.properties ?? {};
    for (const key of ['foot', 'bicycle', 'horse']) {
      if (typeof t[key] === 'string' && t[key].trim() !== '') tagged = true;
    }
    if (ALLOWS.has(t.foot)) foot = true;
    if (ALLOWS.has(t.bicycle)) bike = true;
    if (ALLOWS.has(t.horse)) horse = true;
  }
  if (!tagged) return { activities: ['hike', 'run'], tagged: false, horse: false };
  const activities = [];
  if (foot) activities.push('hike', 'run');
  if (bike) activities.push('bike');
  // Tagged, but every relevant tag is a restriction (foot=no, bicycle=dismount…). Falling
  // back to the default beats emitting a trail no activity filter can ever match.
  if (activities.length === 0) return { activities: ['hike', 'run'], tagged: false, horse };
  return { activities, tagged: true, horse };
}

const round = (v, dp) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};
const roundCoords = (parts) => parts.map((p) => p.map((c) => [round(c[0], 6), round(c[1], 6)]));

// ---- pipeline -----------------------------------------------------------------

async function probe(regionIds) {
  for (const region of regionIds) {
    const bbox = REGIONS[region];
    let json;
    try {
      json = await overpass(buildQuery(bbox, 'tags'));
    } catch (err) {
      console.log(`\n${region} → FAILED: ${err.message}`);
      continue;
    }
    const ways = (json.elements ?? []).filter((el) => el.type === 'way');
    const names = new Map();
    for (const el of ways) {
      const key = normalizeTrailName(String(el.tags?.name ?? ''));
      names.set(key, (names.get(key) ?? 0) + 1);
    }
    const headroom = OVERPASS_MAX_ELEMENTS - ways.length;
    const pct = Math.round((ways.length / OVERPASS_MAX_ELEMENTS) * 100);
    console.log(
      `\n${region} ${JSON.stringify(bbox)}\n` +
        `  named ways      : ${ways.length}\n` +
        `  distinct names  : ${names.size}\n` +
        `  cap ${OVERPASS_MAX_ELEMENTS}        : ${pct}% used, ${headroom} headroom` +
        (headroom <= 500 ? '   ** NEAR CAP — do not derive **' : ''),
    );
    const top = [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [name, count] of top) console.log(`   ${String(count).padStart(3)} × ${name}`);
    if (names.size > 8) console.log(`   … ${names.size - 8} more names`);
  }
}

async function derive(region, refetch = false) {
  const bbox = REGIONS[region];
  const query = buildQuery(bbox, 'geom');
  console.log(`\n=== ${region} ${JSON.stringify(bbox)} ===`);
  const json = await overpassCached(query, region, refetch);
  const elements = (json.elements ?? []).filter(
    (el) => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2,
  );
  if ((json.elements ?? []).length >= OVERPASS_MAX_ELEMENTS) {
    throw new Error(
      `${region}: Overpass returned ${json.elements.length} elements, at or above the ` +
        `${OVERPASS_MAX_ELEMENTS} cap. The fetch is truncated. Refusing to write a partial region.`,
    );
  }
  // Sort by way id so cluster enumeration and mergeSegmentsToFeature's "properties from
  // the longest member" tie-break are identical run to run, which is what makes ids stable.
  elements.sort((a, b) => a.id - b.id);
  const raw = toFeatures(elements);
  console.log(`  named ways returned : ${raw.length}`);

  // Stage 1 — name grouping, with the shipped normalizer.
  const groups = new Map();
  for (const f of raw) {
    const key = normalizeTrailName(String(f.properties.name ?? ''));
    if (key === '') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  console.log(`  distinct names      : ${groups.size}`);

  // Stage 2 — spatial clustering, then merge. A single name can legitimately be several
  // trails in different places (MERGE_PLAN §3: the many "Nature Trail"s), so every
  // surviving cluster becomes its own trail rather than the app's "keep the longest".
  const candidates = [];
  let multiClusterNames = 0;
  for (const [key, feats] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const { clusters } = clusterSegmentsAll(feats);
    const merged = clusters
      .map((c) => ({ cluster: c, feature: mergeSegmentsToFeature(c.features, 'osm', key) }))
      .filter((m) => m.feature !== null);
    if (merged.length === 0) continue;
    if (merged.length > 1) multiClusterNames++;
    // Deterministic order for the numeric suffix: west to east, then south to north.
    merged.sort((a, b) => {
      const ca = centroidOf(featureParts(a.feature));
      const cb = centroidOf(featureParts(b.feature));
      return ca[0] - cb[0] || ca[1] - cb[1];
    });
    merged.forEach((m, i) => {
      candidates.push({
        key,
        name: m.cluster.features[0].properties?.name ?? key,
        feature: m.feature,
        members: m.cluster.features,
        // Suffix only when the name yielded more than one cluster (types.ts id contract).
        idSuffix: merged.length > 1 ? `-${i + 1}` : '',
      });
    });
  }
  console.log(`  clusters (${CLUSTER_GAP_M} m)     : ${candidates.length} trails (${multiClusterNames} names split)`);

  // Stage 3 — elevation and everything derived from geometry.
  const trails = [];
  const stats = { untaggedActivities: 0, horse: 0, withSurface: 0, loops: 0, multiPart: 0, reoriented: 0, likelyRoad: 0 };
  const usedIds = new Set();
  let done = 0;
  for (const c of candidates) {
    let parts = featureParts(c.feature).filter((p) => p.length >= 2);
    if (parts.length === 0) continue;
    let prof = await buildProfile(parts);

    // Orient low-end-first BEFORE anything is measured (types.ts gainM). OSM way direction
    // is arbitrary, so a naive walk reports whichever of ascent/descent the mapper's
    // digitising order happens to produce: North Inlet Trail descends monotonically as
    // stored and measured 3 m of gain over 18 km. Orienting uphill also makes the sparkline
    // read left to right ascending, the way a hiker and AllTrails both draw a profile.
    //
    // The assumption is that a walker starts at the low end and climbs. Right for mountain
    // trails, wrong for a canyon descent, where gain and descent are simply swapped. The
    // page states this. Loops are not special-cased: both ends are the same place, so the
    // orientation barely moves the numbers.
    //
    // Decided on the SMOOTHED endpoints, not raw samples: one noisy DEM pixel at a trail
    // end should not flip the whole profile. Re-sampling after the flip rather than
    // mirroring the arrays by hand keeps the stored geometry and the numbers provably in
    // step, and costs nothing: every tile it needs is already in memory.
    const n = prof.smoothM.length;
    if (n >= 2 && prof.smoothM[n - 1] < prof.smoothM[0]) {
      parts = reverseParts(parts);
      prof = await buildProfile(parts);
      stats.reoriented++;
    }

    // Longest part supplies the trailhead, as types.ts specifies.
    let longest = 0;
    let longestLen = -1;
    parts.forEach((p, i) => {
      let m = 0;
      for (let k = 1; k < p.length; k++) m += haversineMeters(p[k - 1], p[k]);
      if (m > longestLen) {
        longestLen = m;
        longest = i;
      }
    });

    const lengthM = prof.lengthM;
    const gainM = prof.gainM;
    const lengthMi = lengthM / METERS_PER_MILE;
    const gainFt = gainM * FEET_PER_METER;
    const difficultyScore = Math.sqrt(gainFt * 2 * lengthMi);
    const difficulty = difficultyScore < 50 ? 'easy' : difficultyScore <= 150 ? 'moderate' : 'hard';

    // Loop when the overall first and last coordinate come back to the same place, at any
    // part count. Requiring a single part instead made the merge fragmentation defect
    // (MERGE_PLAN §6) suppress loop detection: Emerald Lake Trail is 15 connected ways that
    // still emit 6 parts, so a genuine loop read as point-to-point.
    //
    // The loop share is STILL A FLOOR. The greedy chaining walk can emit parts in an order
    // where the overall first and last coordinate are not the trail's two ends, and no
    // first/last test can recover a loop from that. Out-and-back stays out of scope: it is
    // a fact about how people walk a line, not about the line (SCOPE_PLAN §2).
    const first = parts[0][0];
    const last = parts[parts.length - 1][parts[parts.length - 1].length - 1];
    const routeType =
      lengthM > LOOP_MIN_LENGTH_M && haversineMeters(first, last) <= LOOP_CLOSE_M
        ? 'loop'
        : 'point-to-point';

    // Naismith: 5 km/h on the flat plus 10 minutes per 100 m of ascent.
    const estMinutes = (lengthM / 5000) * 60 + (gainM / 100) * 10;

    const act = deriveActivities(c.members);
    const surface = dominantSurface(c.members);
    const likelyRoad = classifyLikelyRoad(c.members, c.name);
    if (!act.tagged) stats.untaggedActivities++;
    if (act.horse) stats.horse++;
    if (surface) stats.withSurface++;
    if (routeType === 'loop') stats.loops++;
    if (parts.length > 1) stats.multiPart++;
    if (likelyRoad) stats.likelyRoad++;

    const spark = downsampleProfile(prof.elevM, prof.partIndex);

    let id = `${region}/${slugify(c.key)}${c.idSuffix}`;
    if (usedIds.has(id)) {
      // Two different raw names can slugify to the same string ("Ridge Trail (E)" and
      // "Ridge Trail E"). Disambiguate rather than emit a duplicate id.
      let k = 2;
      while (usedIds.has(`${id}~${k}`)) k++;
      id = `${id}~${k}`;
    }
    usedIds.add(id);

    trails.push({
      id,
      name: String(c.name),
      region,
      geometry: null, // filled below, after rounding, so the raw coords drive the maths
      _parts: parts,
      parts: parts.length,
      start: [round(parts[longest][0][0], 6), round(parts[longest][0][1], 6)],
      bbox: bboxOf(parts).map((v) => round(v, 6)),
      centroid: centroidOf(parts).map((v) => round(v, 6)),
      lengthM: round(lengthM, 1),
      gainM: round(gainM, 1),
      descentM: round(prof.descentM, 1),
      minElevM: round(prof.minElevM, 1),
      maxElevM: round(prof.maxElevM, 1),
      maxGradePct: round(maxSustainedGradePct(prof.distM, prof.smoothM, prof.partIndex), 1),
      profile: spark.profile.map((v) => round(v, 1)),
      seamIndices: spark.seamIndices,
      routeType,
      difficulty,
      difficultyScore: round(difficultyScore, 1),
      estMinutes: Math.round(estMinutes),
      surface,
      likelyRoad,
      activities: act.activities,
      prominence: 0, // needs region-wide extremes; second pass below
      osmWayIds: c.members
        .map((f) => Number(String(f.properties?.['@id'] ?? '').replace('way/', '')))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b),
      _wayCount: c.members.length,
      _key: c.key,
    });

    if (++done % 200 === 0) console.log(`  elevation           : ${done}/${candidates.length}`);
  }
  console.log(`  elevation           : ${done}/${candidates.length} trails sampled (${SAMPLES} pts each)`);

  // Stage 4 — prominence. A transparent WEAK proxy for the popularity signal open data
  // does not carry (SCOPE_PLAN §6), deliberately built from three things anyone can check:
  //
  //   prominence = 0.55 × length + 0.30 × member ways + 0.15 × name recurs in region
  //
  // Length and way count are min-maxed on a log scale (trail lengths span three orders of
  // magnitude, so a linear scale would put every trail at ~0 next to one long one) and the
  // recurrence term is a flat 0/1. Recurrence is treated as a small POSITIVE: a name that
  // shows up as several clusters is usually a network of signed, mapped trail. The sign is
  // arguable — a recurring generic name ("Nature Trail") is arguably less notable, not
  // more — which is exactly why the weight is the smallest of the three and why the page
  // calls this a proxy rather than popularity.
  const nameClusterCount = new Map();
  for (const t of trails) nameClusterCount.set(t._key, (nameClusterCount.get(t._key) ?? 0) + 1);
  const logLen = trails.map((t) => Math.log1p(t.lengthM));
  const logWays = trails.map((t) => Math.log1p(t._wayCount));
  const span = (arr) => {
    const lo = Math.min(...arr);
    const hi = Math.max(...arr);
    return (v) => (hi > lo ? (v - lo) / (hi - lo) : 0);
  };
  const normLen = span(logLen);
  const normWays = span(logWays);
  trails.forEach((t, i) => {
    const recurs = (nameClusterCount.get(t._key) ?? 1) > 1 ? 1 : 0;
    t.prominence = round(0.55 * normLen(logLen[i]) + 0.3 * normWays(logWays[i]) + 0.15 * recurs, 3);
  });

  // Stage 5 — freeze. Coordinates to 6 dp (~11 cm, more than the source carries),
  // elevations to 1 dp. Compact, no pretty-printing: this file is committed and read by
  // the bundler, not by a human.
  for (const t of trails) {
    const rounded = roundCoords(t._parts);
    t.geometry =
      rounded.length === 1
        ? { type: 'LineString', coordinates: rounded[0] }
        : { type: 'MultiLineString', coordinates: rounded };
    delete t._parts;
    delete t._wayCount;
    delete t._key;
  }
  trails.sort((a, b) => (a.id < b.id ? -1 : 1));

  // Stage 6 — canopy and aspect, from scope/canopy.mjs. It runs LAST, on the finished
  // trail objects, because it samples positions through the shipped `routeSamplePoints`,
  // which reads `geometry` and `profile`: both only exist after stage 5.
  //
  // A NOTE ON PIPELINE ORDER, verified rather than assumed. This function alone does NOT
  // reproduce the committed file: `scope/routetype.mjs` is a required second pass and
  // reclassifies 3 of RMNP's 112 trails as loops that the endpoint test here calls
  // point-to-point (its own header explains why the endpoint test cannot work). Run
  // `node scope/derive.mjs <region> && node scope/routetype.mjs <region>` or the loop share
  // silently reverts. routetype.mjs rewrites the payload in place and preserves every other
  // field, so the canopy work below survives it.
  //
  // A missing snapshot is a warning, not a failure. The rest of the pipeline needs no
  // network beyond Overpass and terrarium, and refusing to write a region because nobody
  // has run `canopy.mjs freeze` yet would make the trail data hostage to a later feature.
  // src/scope/data.ts reconciles the absence on load, the same way it does for descentM.
  let canopyBlock = null;
  const frozenCanopy = readCanopy(region);
  if (frozenCanopy === null) {
    console.log(`  canopy              : ** no scope/canopy/${region}.json — run: node scope/canopy.mjs freeze ${region} **`);
  } else {
    const cstats = await deriveCanopyAndAspect(trails, frozenCanopy.polygons);
    canopyBlock = canopyBlockFor(bbox, frozenCanopy);
    console.log(
      `  canopy              : ${cstats.canopySamples}/${cstats.samples} samples under trees ` +
        `(${Math.round((cstats.canopySamples / Math.max(1, cstats.samples)) * 100)}%), ` +
        `${frozenCanopy.polygonCount} polygons frozen ${frozenCanopy.fetchedAt}`,
    );
  }

  const payload = {
    region,
    query,
    bbox,
    fetchedAt: new Date().toISOString().slice(0, 10),
    wayCount: raw.length,
    trailCount: trails.length,
    elevationSource: ELEVATION_SOURCE,
    ...(canopyBlock ? { canopy: canopyBlock, aspectSource: `Horn 3x3 on ${ELEVATION_SOURCE}` } : {}),
    trails,
  };
  mkdirSync(DERIVED_DIR, { recursive: true });
  const file = join(DERIVED_DIR, `${region}.json`);
  writeFileSync(file, JSON.stringify(payload));
  report(payload, stats);
  console.log(`  wrote ${file} (${(Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0)} kB)`);
  return payload;
}

// ---- reporting ----------------------------------------------------------------

function quantiles(values) {
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  return { min: s[0], p50: at(0.5), p90: at(0.9), max: s[s.length - 1] };
}

function report(data, stats) {
  const t = data.trails;
  if (t.length === 0) {
    console.log('  no trails');
    return;
  }
  const len = quantiles(t.map((x) => x.lengthM));
  const gain = quantiles(t.map((x) => x.gainM));
  const desc = quantiles(t.map((x) => x.descentM));
  const grade = quantiles(t.map((x) => x.maxGradePct));
  const bins = { easy: 0, moderate: 0, hard: 0 };
  for (const x of t) bins[x.difficulty]++;
  const loops = t.filter((x) => x.routeType === 'loop').length;
  const withSurface = t.filter((x) => x.surface !== null).length;
  const roads = t.filter((x) => x.likelyRoad).length;
  const seamed = t.filter((x) => x.seamIndices.length > 0).length;
  // Display-floor sizing: how much of the list is too short to be worth a card.
  const floors = [50, 100, 200, 400].map((m) => `<${m} m ${t.filter((x) => x.lengthM < m).length}`);
  const pct = (n) => `${Math.round((n / t.length) * 100)}%`;
  console.log(`  trails              : ${t.length} (from ${data.wayCount} ways)`);
  console.log(`  length m            : min ${len.min} · p50 ${len.p50} · p90 ${len.p90} · max ${len.max}`);
  console.log(`  gain m              : min ${gain.min} · p50 ${gain.p50} · p90 ${gain.p90} · max ${gain.max}`);
  console.log(`  descent m           : min ${desc.min} · p50 ${desc.p50} · p90 ${desc.p90} · max ${desc.max}`);
  console.log(`  max grade %         : min ${grade.min} · p50 ${grade.p50} · p90 ${grade.p90} · max ${grade.max}`);
  console.log(`  difficulty          : easy ${bins.easy} (${pct(bins.easy)}) · moderate ${bins.moderate} (${pct(bins.moderate)}) · hard ${bins.hard} (${pct(bins.hard)})`);
  console.log(`  route type          : loop ${loops} (${pct(loops)}) · point-to-point ${t.length - loops} (${pct(t.length - loops)})`);
  console.log(`  surface tagged      : ${withSurface} (${pct(withSurface)})`);
  console.log(`  likelyRoad          : ${roads} (${pct(roads)}) flagged, kept in the data`);
  console.log(`  profiles with seams : ${seamed} (${pct(seamed)})`);
  console.log(`  short trails        : ${floors.join(' · ')}`);
  if (stats) {
    const tagged = t.length - stats.untaggedActivities;
    console.log(`  activity tagged     : ${tagged} (${pct(tagged)}); ${stats.untaggedActivities} defaulted to hike+run`);
    console.log(`  horse=yes|designated: ${stats.horse} (read, not storable — Activity has no 'horse')`);
    console.log(`  multi-part trails   : ${stats.multiPart} (${pct(stats.multiPart)})`);
    console.log(`  reoriented low-first: ${stats.reoriented} (${pct(stats.reoriented)}) — stored uphill against OSM direction`);
  }
}

async function verify() {
  const a = await verifyAnchor();
  const ok = Math.abs(a.deltaM) <= 1;
  console.log(
    `\nelevation anchor · ${a.name} (${a.lon}, ${a.lat})\n` +
      `  known    : ${a.knownM} m\n` +
      `  decoded  : ${a.decodedM.toFixed(3)} m\n` +
      `  delta    : ${a.deltaM >= 0 ? '+' : ''}${a.deltaM.toFixed(3)} m  ${ok ? 'OK (within 1 m)' : '** FAIL **'}`,
  );
  if (!ok) process.exitCode = 1;

  console.log(`\nprofile points      : ${PROFILE_POINTS}`);
  for (const region of Object.keys(REGIONS)) {
    const file = join(DERIVED_DIR, `${region}.json`);
    if (!existsSync(file)) {
      console.log(`\n=== ${region} === not derived yet (run: node scope/derive.mjs ${region})`);
      continue;
    }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`\n=== ${region} (fetched ${data.fetchedAt}) ===`);
    const bad = data.trails.filter((t) => t.profile.length !== PROFILE_POINTS);
    if (bad.length) console.log(`  ** ${bad.length} trails have a profile that is not ${PROFILE_POINTS} points **`);
    // Seams must index into the drawn series, never be 0 (a break before the first point
    // is meaningless), and never exceed the part count minus one.
    const badSeams = data.trails.filter(
      (t) =>
        t.seamIndices.some((i) => !Number.isInteger(i) || i < 1 || i >= PROFILE_POINTS) ||
        t.seamIndices.length > t.parts - 1 ||
        (t.parts === 1 && t.seamIndices.length > 0),
    );
    if (badSeams.length) console.log(`  ** ${badSeams.length} trails have out-of-range seamIndices **`);
    // Orientation sanity. The flip is decided on the SMOOTHED endpoints, so a handful of
    // trails whose raw first/last pixels disagree with the smoothed ones can still show up
    // here; a small count is expected, a large one means orientation is not running.
    const misoriented = data.trails.filter(
      (t) => t.routeType === 'point-to-point' && t.profile[PROFILE_POINTS - 1] < t.profile[0] - 1,
    );
    console.log(`  raw ends lower first : ${misoriented.length} point-to-point (small count expected, see comment)`);
    report(data, null);
  }
}

// ---- CLI ----------------------------------------------------------------------

function resolveRegions(arg) {
  if (!arg || arg === 'all') return Object.keys(REGIONS);
  if (!REGIONS[arg]) {
    console.error(`unknown region '${arg}' (have: ${Object.keys(REGIONS).join(', ')})`);
    process.exit(1);
  }
  return [arg];
}

// Only run the CLI when invoked directly, so the pure helpers above can be imported and
// exercised against the merge/fixtures snapshots without triggering a fetch.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const refetch = args.includes('--refetch');
  const [mode, ...rest] = args.filter((a) => a !== '--refetch');
  if (mode === 'probe') {
    await probe(resolveRegions(rest[0]));
  } else if (mode === 'verify') {
    await verify();
  } else {
    for (const region of resolveRegions(mode)) await derive(region, refetch);
  }
}

export {
  buildQuery,
  toFeatures,
  slugify,
  downsampleProfile,
  reverseParts,
  classifyLikelyRoad,
  maxSustainedGradePct,
  dominantSurface,
  deriveActivities,
  centroidOf,
  REGIONS,
  PROFILE_POINTS,
  LOOP_CLOSE_M,
  LOOP_MIN_LENGTH_M,
};
