// Cross-source trail switcher support (inspector "VIEW IN" chips).
//
// Given the current selection, decide which OTHER sources plausibly hold the same
// trail (findCandidateSources — cheap, cache-first) and, on demand, re-resolve that
// same trail from a chosen source (selectFromSource — cache first, then an exact-name
// ArcGIS fetch), clustering on the current selection's location so the corridor
// matches rather than a same-named trail elsewhere. Imitates search.ts/pickArcgisGroup's
// cluster→merge→stamp flow but anchored on the live selection and without moving camera.

import type { SourceId, SelectedTrail } from '../types';
import type { TrailSourceDef } from '../types';
import { SOURCES, SOURCE_IDS } from '../registry';
import {
  getCachedFeatures,
  normalizeTrailName,
  clusterSegmentsDetailed,
  mergeSegmentsToFeature,
} from './loader';
import { fetchArcgisByExactName, arcgisFetch } from './arcgis';

// Matching thresholds (meters).
const CANDIDATE_MAX_GAP_M = 5000; // cache feature must be within ~5 km of the selection
const CLUSTER_MAX_REACH_M = 10000; // chosen cluster must be within ~10 km, else not-the-same-trail

// --- geometry helpers ---------------------------------------------------------
type BBox = [number, number, number, number]; // [w,s,e,n]

function lineParts(feature: GeoJSON.Feature): number[][][] {
  const g = feature.geometry;
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  return [];
}

function featureBBox(feature: GeoJSON.Feature): BBox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const part of lineParts(feature)) {
    for (const c of part) {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    }
  }
  return e >= w && n >= s ? [w, s, e, n] : null;
}

function bboxesForFeatures(features: GeoJSON.Feature[]): BBox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const f of features) {
    const bb = featureBBox(f);
    if (!bb) continue;
    if (bb[0] < w) w = bb[0];
    if (bb[1] < s) s = bb[1];
    if (bb[2] > e) e = bb[2];
    if (bb[3] > n) n = bb[3];
  }
  return e >= w && n >= s ? [w, s, e, n] : null;
}

/** Shortest gap (meters) between two bboxes; 0 when they overlap. */
function bboxGapMeters(a: BBox, b: BBox): number {
  const dLon = Math.max(a[0] - b[2], b[0] - a[2], 0);
  const dLat = Math.max(a[1] - b[3], b[1] - a[3], 0);
  const midLat = (a[1] + a[3] + b[1] + b[3]) / 4;
  const latM = dLat * 111320;
  const lonM = dLon * 111320 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  return Math.hypot(latM, lonM);
}

/** A vertex near the middle of the selection's geometry — always on the trail. */
function representativePoint(feature: GeoJSON.Feature): [number, number] | null {
  const coords = lineParts(feature).flat();
  if (coords.length === 0) return null;
  const c = coords[Math.floor(coords.length / 2)];
  return [c[0], c[1]];
}

// --- name matching ------------------------------------------------------------
/** Case-insensitive property read (ArcGIS field casing varies across services). */
function readName(feature: GeoJSON.Feature, def: TrailSourceDef): string {
  const props = (feature.properties || {}) as Record<string, unknown>;
  const direct = props[def.nameField];
  if (direct != null) return String(direct);
  const lower = def.nameField.toLowerCase();
  for (const k in props) {
    if (k.toLowerCase() === lower) return String(props[k] ?? '');
  }
  return '';
}

/** Expand a bbox outward by `meters` on all sides (latitude-adjusted longitude). */
function expandBBox(bb: BBox, meters: number): BBox {
  const midLat = (bb[1] + bb[3]) / 2;
  const latDeg = meters / 111320;
  const lonDeg = meters / (111320 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)));
  return [bb[0] - lonDeg, bb[1] - latDeg, bb[2] + lonDeg, bb[3] + latDeg];
}

/** Cached features in `sourceId` whose normalized name equals `normName`. */
function cacheMatches(sourceId: SourceId, normName: string): GeoJSON.Feature[] {
  const fc = getCachedFeatures(sourceId);
  if (!fc) return [];
  const def = SOURCES[sourceId];
  const out: GeoJSON.Feature[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    if (normalizeTrailName(readName(f, def)) === normName) out.push(f);
  }
  return out;
}

// --- ArcGIS exact fetch (UPPER retry for cross-source case differences) --------
const EXACT_RECORD_COUNT = 2000;

/** Exact-name fetch using UPPER(nameField)=UPPER('…') — bridges casing differences
 *  between sources (e.g. USGS "Fern Lake Trail" vs NPS "FERN LAKE TRAIL"). Queries
 *  every layer URL (BLM has two) and flattens. */
async function fetchArcgisByExactNameUpper(
  def: TrailSourceDef,
  name: string,
  signal: AbortSignal,
): Promise<GeoJSON.Feature[]> {
  const escaped = name.replace(/'/g, "''");
  const params = new URLSearchParams({
    f: 'geojson',
    where: `UPPER(${def.nameField}) = UPPER('${escaped}')`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: String(EXACT_RECORD_COUNT),
  });
  const all: GeoJSON.Feature[] = [];
  for (const url of def.queryUrls) {
    const resp = await arcgisFetch(`${url}?${params.toString()}`, signal);
    if (!resp.ok) throw new Error(`ArcGIS ${resp.status} ${resp.statusText}`);
    const json = (await resp.json()) as {
      features?: GeoJSON.Feature[];
      error?: { message?: string };
    };
    if (json.error) throw new Error(`ArcGIS error: ${json.error.message ?? 'unknown'}`);
    if (Array.isArray(json.features)) all.push(...json.features);
  }
  return all;
}

// --- public API ---------------------------------------------------------------

/**
 * Cache-only existence test: does `target` already hold a same-named trail near the
 * selection (within ~5 km, or any name match when the selection lacks geometry)?
 * Zero network — mirrors the cache-hit branch findCandidateSources uses, and lets the
 * inspector render a cache-verified chip as available instantly (no spinner flash).
 */
export function cacheHasTrail(sel: SelectedTrail, target: SourceId): boolean {
  const normName = normalizeTrailName(sel.name);
  if (!normName) return false;
  const selBBox = featureBBox(sel.feature);
  if (selBBox) {
    for (const f of cacheMatches(target, normName)) {
      const bb = featureBBox(f);
      if (bb && bboxGapMeters(selBBox, bb) <= CANDIDATE_MAX_GAP_M) return true;
    }
    return false;
  }
  // Selection has no usable geometry: fall back to any cache name match.
  return cacheMatches(target, normName).length > 0;
}

/**
 * Cheap synchronous pass: which sources should render a "VIEW IN" chip. The chip
 * set is stable — EVERY enabled source other than the selection's own gets a chip
 * (in SOURCE_IDS order), regardless of cache presence, so the row doesn't change
 * shape as the cache warms. The per-chip state resolves later: cache-matching or
 * probe-verified sources render `available`; sources with no match render `absent`.
 * OSM (and any non-searchable source) is cache-only — a cache miss shows `absent`.
 * Unnamed selections → no chips (nothing to match on).
 */
export function findCandidateSources(
  sel: SelectedTrail,
  enabled: Record<SourceId, boolean>,
): SourceId[] {
  if (!sel.name) return [];
  const normName = normalizeTrailName(sel.name);
  if (!normName) return [];
  const out: SourceId[] = [];
  for (const id of SOURCE_IDS) {
    if (id === sel.sourceId || !enabled[id]) continue;
    out.push(id);
  }
  return out;
}

// --- upfront availability probing (chip states) -------------------------------
// Cheapest existence check per candidate source, run concurrently as the card
// builds so absent sources are flagged before the user clicks. Results memoized so
// reopening the same trail never refetches.
const probeCache = new Map<string, boolean>();

function probeKey(normName: string, target: SourceId, envelope: BBox | null): string {
  const bboxKey = envelope ? envelope.map((v) => v.toFixed(2)).join(',') : 'nobbox';
  return `${normName}|${target}|${bboxKey}`;
}

/** returnCountOnly probe: UPPER(name)=UPPER(sel.name) within the reach envelope.
 *  Iterates every layer URL (BLM has two); true as soon as one reports count > 0. */
async function arcgisHasNamedInEnvelope(
  def: TrailSourceDef,
  name: string,
  envelope: BBox | null,
  signal: AbortSignal,
): Promise<boolean> {
  const escaped = name.replace(/'/g, "''");
  for (const url of def.queryUrls) {
    const params = new URLSearchParams({
      f: 'json',
      where: `UPPER(${def.nameField}) = UPPER('${escaped}')`,
      returnCountOnly: 'true',
    });
    if (envelope) {
      params.set('geometry', envelope.join(','));
      params.set('geometryType', 'esriGeometryEnvelope');
      params.set('inSR', '4326');
      params.set('spatialRel', 'esriSpatialRelIntersects');
    }
    const resp = await arcgisFetch(`${url}?${params.toString()}`, signal);
    if (!resp.ok) throw new Error(`ArcGIS ${resp.status} ${resp.statusText}`);
    const json = (await resp.json()) as { count?: number; error?: { message?: string } };
    if (json.error) throw new Error(`ArcGIS error: ${json.error.message ?? 'unknown'}`);
    if ((json.count ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Does `target` hold this same trail near the selection? Cheapest possible check:
 *   1. Cache hit (findCandidateSources' logic) → true, no network.
 *   2. Memoized prior probe (name + target + rounded reach envelope) → that result.
 *   3. ArcGIS: a returnCountOnly query bounded by the selection bbox expanded ~10 km.
 *   4. OSM / non-searchable: cache-only, so a cache miss resolves false.
 * Rejects (AbortError, HTTP/ArcGIS errors) propagate so the caller can fall back to
 * treating the chip as available rather than falsely marking it absent.
 */
export async function probeSource(
  sel: SelectedTrail,
  target: SourceId,
  signal: AbortSignal,
): Promise<boolean> {
  if (cacheHasTrail(sel, target)) return true;

  const def = SOURCES[target];
  const normName = normalizeTrailName(sel.name);
  const selBBox = featureBBox(sel.feature);
  const envelope = selBBox ? expandBBox(selBBox, CLUSTER_MAX_REACH_M) : null;
  const key = probeKey(normName, target, envelope);
  const memo = probeCache.get(key);
  if (memo !== undefined) return memo;

  // OSM / non-searchable: no nationwide name scan; cache miss means absent.
  if (def.kind !== 'arcgis' || !def.searchable) {
    probeCache.set(key, false);
    return false;
  }

  const found = await arcgisHasNamedInEnvelope(def, sel.name, envelope, signal);
  if (!signal.aborted) probeCache.set(key, found);
  return found;
}

/**
 * Re-resolve the SAME trail (as `sel`) from `target`. Cache matches first; for a
 * searchable ArcGIS source with no cache hit, an exact-name fetch (with an UPPER
 * retry for casing). Clusters on the current selection's location so the corridor
 * matches, merges, and stamps __segments / __other_clusters like search.ts. Returns
 * null when nothing is found or the nearest cluster is beyond ~10 km (i.e. a
 * same-named trail elsewhere, not this one). Does not touch the camera.
 */
export async function selectFromSource(
  sel: SelectedTrail,
  target: SourceId,
  signal: AbortSignal,
): Promise<GeoJSON.Feature | null> {
  const def = SOURCES[target];
  const normName = normalizeTrailName(sel.name);
  const anchorPt = representativePoint(sel.feature);
  const selBBox = featureBBox(sel.feature);

  // 1. Resolve candidate segments: cache first, then exact ArcGIS fetch.
  let features = cacheMatches(target, normName);
  if (features.length === 0 && def.kind === 'arcgis' && def.searchable) {
    features = await fetchArcgisByExactName(def, sel.name, signal);
    if (signal.aborted) return null;
    if (features.length === 0) {
      // Case differs between sources; retry case-insensitively.
      features = await fetchArcgisByExactNameUpper(def, sel.name, signal);
      if (signal.aborted) return null;
    }
  }
  if (features.length === 0) return null;

  // 2. Cluster on the selection's location, merge the chosen cluster.
  const anchor = anchorPt ?? undefined;
  const { features: clustered, clusterCount } = clusterSegmentsDetailed(features, anchor);
  if (clustered.length === 0) return null;

  // 3. Reject a cluster that is too far — that's a same-named trail elsewhere.
  const clusterBBox = bboxesForFeatures(clustered);
  if (selBBox && clusterBBox && bboxGapMeters(selBBox, clusterBBox) > CLUSTER_MAX_REACH_M) {
    return null;
  }

  const merged = mergeSegmentsToFeature(clustered, target, sel.name);
  if (!merged) return null;
  if (clusterCount > 1) {
    (merged.properties as Record<string, unknown>).__other_clusters = clusterCount - 1;
  }
  return merged;
}

/** Display name carried by a merged feature from `target` (falls back to `fallback`). */
export function nameFromMerged(
  merged: GeoJSON.Feature,
  target: SourceId,
  fallback: string,
): string {
  const props = (merged.properties || {}) as Record<string, unknown>;
  const def = SOURCES[target];
  const v = props[def.nameField];
  if (v != null && String(v) !== '') return String(v);
  const lower = def.nameField.toLowerCase();
  for (const k in props) {
    if (k.toLowerCase() === lower && props[k] != null && String(props[k]) !== '') {
      return String(props[k]);
    }
  }
  return fallback;
}
