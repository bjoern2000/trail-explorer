// Trail segment merging — the pure geometry/naming logic shared by search, the
// sidebar's "trails in view" grouping, cross-source lookup (altsources) and the
// segment-merge explainer page (src/merge/).
//
// Extracted verbatim from data/loader.ts so it can run with no browser imports
// (loader.ts pulls in MapLibre): this module is importable from plain Node, which
// is what lets merge/pipeline verification run headless. loader.ts re-exports every
// symbol here, so existing importers are unaffected.
//
// The pipeline, in the order the app applies it:
//   1. normalizeTrailName  — group fetched segments by name
//   2. clusterSegmentsAll  — split a name's segments into spatially distinct trails
//   3. chainSegmentsDetailed — order + orient one cluster's segments into chains
//   4. mergeSegmentsToFeature — emit a single Feature with provenance properties
//
// The *Detailed / *All variants exist so the explainer page can show which input
// segment ended up where. The plain variants delegate to them: one implementation.

import type { SourceId } from '../types';

// ---- naming -------------------------------------------------------------------

/** Normalized trail name for grouping: lowercase, trimmed, whitespace-collapsed. */
export function normalizeTrailName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ---- length -------------------------------------------------------------------

export function haversineMeters(a: number[], b: number[]): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function partLengthMeters(coords: number[][]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversineMeters(coords[i - 1], coords[i]);
  return m;
}

/** Total haversine length (meters) of a LineString / MultiLineString feature. */
export function featureLengthMeters(feature: GeoJSON.Feature): number {
  const g = feature.geometry;
  if (!g) return 0;
  if (g.type === 'LineString') return partLengthMeters(g.coordinates);
  if (g.type === 'MultiLineString') {
    let m = 0;
    for (const p of g.coordinates) m += partLengthMeters(p);
    return m;
  }
  return 0;
}

/** Line parts of a feature: [] for anything that is not a Line/MultiLine. */
export function featureParts(feature: GeoJSON.Feature): number[][][] {
  const g = feature.geometry;
  if (g?.type === 'LineString') return [g.coordinates];
  if (g?.type === 'MultiLineString') return g.coordinates;
  return [];
}

// ---- topological chaining (orient + join connected segments end-to-start) ----

/** Endpoint connection tolerance (meters). Segments whose endpoints meet within this
 *  are joined into one continuous LineString. ~35 m absorbs source vertex jitter and
 *  small gaps at agency tile/segment boundaries without bridging distinct trails. */
export const CHAIN_TOLERANCE_M = 35;

/** Stable ordering key for a segment (first vertex, then last), for deterministic ties. */
function segSortKey(coords: number[][]): string {
  const a = coords[0];
  const b = coords[coords.length - 1];
  return `${a[0].toFixed(6)},${a[1].toFixed(6)}|${b[0].toFixed(6)},${b[1].toFixed(6)}`;
}

/** One continuous chain: its coordinates plus which input parts built it, in order. */
export interface ChainDetail {
  coords: number[][];
  /** Indices into the `parts` array passed in, in the order they were appended. */
  members: number[];
  /** Parallel to `members`: true where that part was reversed to fit the chain. */
  flipped: boolean[];
}

/**
 * Order and orient trail segments into maximal continuous chains. Segments whose
 * endpoints meet within `toleranceM` are joined head-to-tail into a single LineString
 * (a segment is flipped when its END, not its start, meets the chain; the shared vertex
 * is de-duplicated). Segments that connect to nothing remain separate parts. Greedy: at
 * a Y-junction / branch one arm is followed and the other(s) start new chains. Made
 * deterministic so repeated merges of the same input yield identical geometry: chains
 * start at a degree-1 endpoint where one exists (else any vertex, e.g. a pure loop), and
 * candidate ties break by a stable segment ordering. Input parts with < 2 vertices are
 * dropped. Returns one ChainDetail per chain.
 */
export function chainSegmentsDetailed(
  parts: number[][][],
  toleranceM: number = CHAIN_TOLERANCE_M,
): ChainDetail[] {
  // Keep the original index alongside each segment so callers can trace inputs → chains.
  const segs = parts
    .map((coords, idx) => ({ coords: coords.slice(), idx }))
    .filter((s) => s.coords.length >= 2)
    .sort((a, b) => {
      const ka = segSortKey(a.coords);
      const kb = segSortKey(b.coords);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const n = segs.length;
  if (n === 0) return [];
  if (n === 1) return [{ coords: segs[0].coords, members: [segs[0].idx], flipped: [false] }];

  const used = new Array<boolean>(n).fill(false);
  const first = (i: number): number[] => segs[i].coords[0];
  const last = (i: number): number[] => segs[i].coords[segs[i].coords.length - 1];
  const near = (a: number[], b: number[]): boolean => haversineMeters(a, b) <= toleranceM;

  // Endpoint `pt` is free (degree-1) when no OTHER still-unused segment endpoint meets it.
  const isFree = (pt: number[], selfIdx: number): boolean => {
    for (let i = 0; i < n; i++) {
      if (i === selfIdx || used[i]) continue;
      if (near(pt, first(i)) || near(pt, last(i))) return false;
    }
    return true;
  };

  // First unused segment (sorted order) meeting `pt`, oriented so its START meets `pt`.
  const connectAtTail = (pt: number[]): { i: number; coords: number[][]; flipped: boolean } | null => {
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      if (near(pt, first(i))) return { i, coords: segs[i].coords, flipped: false };
      if (near(pt, last(i))) return { i, coords: segs[i].coords.slice().reverse(), flipped: true };
    }
    return null;
  };

  // First unused segment meeting `pt`, oriented so its END meets `pt` (for prepending).
  const connectAtHead = (pt: number[]): { i: number; coords: number[][]; flipped: boolean } | null => {
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      if (near(pt, last(i))) return { i, coords: segs[i].coords, flipped: false };
      if (near(pt, first(i))) return { i, coords: segs[i].coords.slice().reverse(), flipped: true };
    }
    return null;
  };

  const chains: ChainDetail[] = [];
  for (;;) {
    // Pick a start: prefer an unused segment with a free endpoint (a true trail end),
    // oriented so the free endpoint leads. Else the first unused segment (loops/tangles).
    let startCoords: number[][] | null = null;
    let startIdx = -1;
    let startFlipped = false;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      if (isFree(first(i), i)) {
        used[i] = true;
        startCoords = segs[i].coords.slice();
        startIdx = segs[i].idx;
        break;
      }
      if (isFree(last(i), i)) {
        used[i] = true;
        startCoords = segs[i].coords.slice().reverse();
        startIdx = segs[i].idx;
        startFlipped = true;
        break;
      }
    }
    if (!startCoords) {
      for (let i = 0; i < n; i++) {
        if (!used[i]) {
          used[i] = true;
          startCoords = segs[i].coords.slice();
          startIdx = segs[i].idx;
          break;
        }
      }
    }
    if (!startCoords) break; // all consumed

    const chain = startCoords;
    const members = [startIdx];
    const flipped = [startFlipped];
    // Extend at the tail (dedupe the shared vertex).
    for (;;) {
      const conn = connectAtTail(chain[chain.length - 1]);
      if (!conn) break;
      used[conn.i] = true;
      for (let k = 1; k < conn.coords.length; k++) chain.push(conn.coords[k]);
      members.push(segs[conn.i].idx);
      flipped.push(conn.flipped);
    }
    // Extend at the head (prepend all but the shared last vertex).
    for (;;) {
      const conn = connectAtHead(chain[0]);
      if (!conn) break;
      used[conn.i] = true;
      for (let k = conn.coords.length - 2; k >= 0; k--) chain.unshift(conn.coords[k]);
      members.unshift(segs[conn.i].idx);
      flipped.unshift(conn.flipped);
    }
    chains.push({ coords: chain, members, flipped });
  }
  return chains;
}

/** Chain coordinates only (see chainSegmentsDetailed). */
export function chainSegments(
  parts: number[][][],
  toleranceM: number = CHAIN_TOLERANCE_M,
): number[][][] {
  return chainSegmentsDetailed(parts, toleranceM).map((c) => c.coords);
}

// ---- merge --------------------------------------------------------------------

/**
 * Merge trail segments into one feature. Segments are first topologically chained
 * (oriented + joined end-to-start, see chainSegments) so a fragmented trail returned in
 * arbitrary order becomes ONE continuous LineString rather than a MultiLineString whose
 * flattened parts get bridged into phantom distance/gain. Genuinely disconnected chains
 * remain separate MultiLineString parts. Properties come from the longest input segment,
 * plus __fid (`source:merged:normalized-name`), __source, __segments (ORIGINAL fetched
 * count — the source's fragmentation signal) and __parts (resulting chain count).
 */
export function mergeSegmentsToFeature(
  features: GeoJSON.Feature[],
  sourceId: SourceId,
  name: string,
): GeoJSON.Feature | null {
  const rawParts: number[][][] = [];
  let longest: GeoJSON.Feature | null = null;
  let longestLen = -1;
  for (const f of features) {
    const fparts = featureParts(f);
    let flen = 0;
    for (const p of fparts) {
      if (p.length >= 2) {
        rawParts.push(p);
        flen += partLengthMeters(p);
      }
    }
    if (flen > longestLen) {
      longestLen = flen;
      longest = f;
    }
  }
  if (rawParts.length === 0) return null;
  const parts = chainSegments(rawParts);
  if (parts.length === 0) return null;
  const props = { ...(longest?.properties ?? {}) } as Record<string, unknown>;
  props.__fid = `${sourceId}:merged:${normalizeTrailName(name)}`;
  props.__source = sourceId;
  props.__segments = features.length;
  props.__parts = parts.length;
  const geometry: GeoJSON.Geometry =
    parts.length === 1
      ? { type: 'LineString', coordinates: parts[0] }
      : { type: 'MultiLineString', coordinates: parts };
  return { type: 'Feature', properties: props, geometry };
}

// ---- spatial clustering (keeps same-named but disjoint trails from merging) ----

export const CLUSTER_GAP_M = 2000; // segments whose bboxes come within ~2 km join one cluster

/** Axis-aligned bbox [w,s,e,n] of a Line/MultiLine feature, or null if it has no vertices. */
export function featureBBox(feature: GeoJSON.Feature): [number, number, number, number] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of featureParts(feature)) {
    for (const c of p) {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    }
  }
  return e >= w && n >= s ? [w, s, e, n] : null;
}

/** True if bbox `a`, expanded by `gapM` (latitude-adjusted degrees), intersects bbox `b`. */
function bboxesWithinGap(
  a: [number, number, number, number],
  b: [number, number, number, number],
  gapM: number,
): boolean {
  const latDeg = gapM / 111320;
  const midLat = (a[1] + a[3] + b[1] + b[3]) / 4;
  const lonDeg = gapM / (111320 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)));
  return (
    a[0] - lonDeg <= b[2] &&
    a[2] + lonDeg >= b[0] &&
    a[1] - latDeg <= b[3] &&
    a[3] + latDeg >= b[1]
  );
}

function totalLengthM(features: GeoJSON.Feature[]): number {
  let m = 0;
  for (const f of features) m += featureLengthMeters(f);
  return m;
}

function anchorPoint(anchor?: GeoJSON.Feature | [number, number]): [number, number] | null {
  if (!anchor) return null;
  if (Array.isArray(anchor)) return [anchor[0], anchor[1]];
  const bb = featureBBox(anchor);
  return bb ? [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] : null;
}

/** Distance (degrees) from a point to a bbox; 0 when the point is inside. */
function pointBBoxDistDeg(pt: [number, number], bb: [number, number, number, number]): number {
  const dx = Math.max(bb[0] - pt[0], 0, pt[0] - bb[2]);
  const dy = Math.max(bb[1] - pt[1], 0, pt[1] - bb[3]);
  return Math.hypot(dx, dy);
}

/** One spatial cluster of same-named segments. */
export interface ClusterInfo {
  features: GeoJSON.Feature[];
  /** Indices into the feature array passed to clusterSegmentsAll. */
  memberIndices: number[];
  bbox: [number, number, number, number];
  lengthM: number;
  /** Distance in degrees from the anchor to this cluster's bbox (null with no anchor). */
  anchorDistDeg: number | null;
}

/** Every cluster the input split into, plus which one the app keeps. */
export interface ClusterAll {
  clusters: ClusterInfo[];
  /** Index into `clusters` of the kept cluster; -1 when there is nothing to choose. */
  chosen: number;
  /** Inputs with no usable geometry: they cannot be placed, so they cluster with nothing. */
  degenerate: GeoJSON.Feature[];
}

/**
 * Spatially cluster trail segments so same-named but geographically disjoint trails
 * (the many distinct "Nature Trail"s across a state) don't merge into one blob.
 * Two segments join a cluster when their bboxes, expanded by a ~2 km gap tolerance,
 * intersect (union-find) — connecting a trail's consecutive/parallel segments while
 * separating trails in different regions. The kept cluster is the one containing or
 * nearest `anchor` (a Feature or [lng,lat]) when given, else the longest.
 */
export function clusterSegmentsAll(
  features: GeoJSON.Feature[],
  anchor?: GeoJSON.Feature | [number, number],
): ClusterAll {
  // Only features with geometry can be placed spatially.
  const withGeom: GeoJSON.Feature[] = [];
  const srcIndex: number[] = [];
  const bboxes: [number, number, number, number][] = [];
  const degenerate: GeoJSON.Feature[] = [];
  features.forEach((f, i) => {
    const bb = featureBBox(f);
    if (bb) {
      withGeom.push(f);
      srcIndex.push(i);
      bboxes.push(bb);
    } else {
      degenerate.push(f);
    }
  });
  if (withGeom.length === 0) return { clusters: [], chosen: -1, degenerate };

  const parent = withGeom.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 0; i < withGeom.length; i++) {
    for (let j = i + 1; j < withGeom.length; j++) {
      if (find(i) === find(j)) continue;
      if (bboxesWithinGap(bboxes[i], bboxes[j], CLUSTER_GAP_M)) parent[find(i)] = find(j);
    }
  }

  // Gather members + a union bbox per cluster root, in first-seen order (deterministic).
  const order: number[] = [];
  const members = new Map<number, number[]>();
  const clusterBBox = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < withGeom.length; i++) {
    const r = find(i);
    const arr = members.get(r);
    if (arr) arr.push(i);
    else {
      members.set(r, [i]);
      order.push(r);
    }
    const bb = bboxes[i];
    const cur = clusterBBox.get(r);
    if (!cur) clusterBBox.set(r, [...bb]);
    else {
      if (bb[0] < cur[0]) cur[0] = bb[0];
      if (bb[1] < cur[1]) cur[1] = bb[1];
      if (bb[2] > cur[2]) cur[2] = bb[2];
      if (bb[3] > cur[3]) cur[3] = bb[3];
    }
  }

  const pt = anchorPoint(anchor);
  const clusters: ClusterInfo[] = order.map((r) => {
    const idxs = members.get(r)!;
    const feats = idxs.map((i) => withGeom[i]);
    const bb = clusterBBox.get(r)!;
    return {
      features: feats,
      memberIndices: idxs.map((i) => srcIndex[i]),
      bbox: bb,
      lengthM: totalLengthM(feats),
      anchorDistDeg: pt ? pointBBoxDistDeg(pt, bb) : null,
    };
  });

  let chosen = 0;
  if (pt) {
    // Nearest cluster to the anchor (0 = anchor inside its bbox); ties → longer cluster.
    let bestDist = Infinity;
    let bestLen = -1;
    clusters.forEach((c, i) => {
      const dist = c.anchorDistDeg!;
      if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && c.lengthM > bestLen)) {
        bestDist = dist;
        bestLen = c.lengthM;
        chosen = i;
      }
    });
  } else {
    // Longest cluster by total segment length.
    let bestLen = -1;
    clusters.forEach((c, i) => {
      if (c.lengthM > bestLen) {
        bestLen = c.lengthM;
        chosen = i;
      }
    });
  }

  return { clusters, chosen, degenerate };
}

/** The chosen cluster's features plus the total number of clusters the input split into. */
export interface ClusterResult {
  features: GeoJSON.Feature[];
  clusterCount: number;
}

/** The kept cluster + how many clusters there were (see clusterSegmentsAll). */
export function clusterSegmentsDetailed(
  features: GeoJSON.Feature[],
  anchor?: GeoJSON.Feature | [number, number],
): ClusterResult {
  const { clusters, chosen } = clusterSegmentsAll(features, anchor);
  // No feature carried usable geometry: pass the input through unclustered, as before.
  if (chosen < 0) return { features: features.slice(), clusterCount: features.length ? 1 : 0 };
  return { features: clusters[chosen].features, clusterCount: clusters.length };
}

/** The chosen cluster's features (see clusterSegmentsDetailed). */
export function clusterSegments(
  features: GeoJSON.Feature[],
  anchor?: GeoJSON.Feature | [number, number],
): GeoJSON.Feature[] {
  return clusterSegmentsDetailed(features, anchor).features;
}
