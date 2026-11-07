// DISCOVER places data: state bboxes + NPS park / USFS forest name+extent lookups
// + OSM peaks-in-view. Pure navigation helpers — no store/filtering state.
//
// ArcGIS pattern mirrors data/arcgis.ts (distinct-values + returnExtentOnly, GeoJSON
// spatial ref requested as 4326). Peaks reuse the /api/overpass proxy like data/overpass.ts.
// Endpoints verified live 2026-07-08:
//   NPS trails      mapservices.nps.gov/.../NPS_Public_Trails_Geographic/FeatureServer/0 (UNITNAME, 329 units)
//   USFS forests    apps.fs.usda.gov/arcx/.../EDW_ForestSystemBoundaries_01/MapServer/0 (forestname, 112 forests)

import { arcgisFetch } from './arcgis';

/** Geographic bbox as [west, south, east, north] in EPSG:4326. */
export type BBox = [number, number, number, number];

const NPS_TRAILS_URL =
  'https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails_Geographic/FeatureServer/0/query';
const NPS_UNIT_FIELD = 'UNITNAME';

// USFS Administrative Forest Boundaries - National Extent. The service returns the
// name field as lowercase `forestname` regardless of requested casing, so all
// attribute reads below are case-insensitive.
const USFS_FORESTS_URL =
  'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer/0/query';
const USFS_FOREST_FIELD = 'FORESTNAME';

// ---- US states (+ DC): reasonable bounding boxes [w, s, e, n] ----------------

export interface StatePlace {
  name: string;
  bbox: BBox;
}

export const US_STATES: StatePlace[] = [
  { name: 'Alabama', bbox: [-88.47, 30.22, -84.89, 35.01] },
  { name: 'Alaska', bbox: [-179.15, 51.21, -129.98, 71.44] },
  { name: 'Arizona', bbox: [-114.82, 31.33, -109.05, 37.0] },
  { name: 'Arkansas', bbox: [-94.62, 33.0, -89.64, 36.5] },
  { name: 'California', bbox: [-124.41, 32.53, -114.13, 42.01] },
  { name: 'Colorado', bbox: [-109.06, 36.99, -102.04, 41.0] },
  { name: 'Connecticut', bbox: [-73.73, 40.98, -71.79, 42.05] },
  { name: 'Delaware', bbox: [-75.79, 38.45, -75.05, 39.84] },
  { name: 'District of Columbia', bbox: [-77.12, 38.79, -76.91, 38.996] },
  { name: 'Florida', bbox: [-87.63, 24.52, -80.03, 31.0] },
  { name: 'Georgia', bbox: [-85.61, 30.36, -80.84, 35.0] },
  { name: 'Hawaii', bbox: [-160.25, 18.91, -154.81, 22.24] },
  { name: 'Idaho', bbox: [-117.24, 41.99, -111.04, 49.0] },
  { name: 'Illinois', bbox: [-91.51, 36.97, -87.02, 42.51] },
  { name: 'Indiana', bbox: [-88.1, 37.77, -84.78, 41.76] },
  { name: 'Iowa', bbox: [-96.64, 40.38, -90.14, 43.5] },
  { name: 'Kansas', bbox: [-102.05, 36.99, -94.59, 40.0] },
  { name: 'Kentucky', bbox: [-89.57, 36.5, -81.96, 39.15] },
  { name: 'Louisiana', bbox: [-94.04, 28.93, -88.82, 33.02] },
  { name: 'Maine', bbox: [-71.08, 43.06, -66.95, 47.46] },
  { name: 'Maryland', bbox: [-79.49, 37.91, -75.05, 39.72] },
  { name: 'Massachusetts', bbox: [-73.51, 41.24, -69.93, 42.89] },
  { name: 'Michigan', bbox: [-90.42, 41.7, -82.41, 48.31] },
  { name: 'Minnesota', bbox: [-97.24, 43.5, -89.49, 49.38] },
  { name: 'Mississippi', bbox: [-91.66, 30.17, -88.1, 35.0] },
  { name: 'Missouri', bbox: [-95.77, 35.99, -89.1, 40.61] },
  { name: 'Montana', bbox: [-116.05, 44.36, -104.04, 49.0] },
  { name: 'Nebraska', bbox: [-104.05, 39.99, -95.31, 43.0] },
  { name: 'Nevada', bbox: [-120.01, 35.0, -114.04, 42.0] },
  { name: 'New Hampshire', bbox: [-72.56, 42.7, -70.61, 45.31] },
  { name: 'New Jersey', bbox: [-75.56, 38.93, -73.9, 41.36] },
  { name: 'New Mexico', bbox: [-109.05, 31.33, -103.0, 37.0] },
  { name: 'New York', bbox: [-79.76, 40.5, -71.86, 45.02] },
  { name: 'North Carolina', bbox: [-84.32, 33.84, -75.46, 36.59] },
  { name: 'North Dakota', bbox: [-104.05, 45.94, -96.55, 49.0] },
  { name: 'Ohio', bbox: [-84.82, 38.4, -80.52, 41.98] },
  { name: 'Oklahoma', bbox: [-103.0, 33.62, -94.43, 37.0] },
  { name: 'Oregon', bbox: [-124.57, 41.99, -116.46, 46.29] },
  { name: 'Pennsylvania', bbox: [-80.52, 39.72, -74.69, 42.27] },
  { name: 'Rhode Island', bbox: [-71.91, 41.15, -71.12, 42.02] },
  { name: 'South Carolina', bbox: [-83.35, 32.03, -78.54, 35.22] },
  { name: 'South Dakota', bbox: [-104.06, 42.48, -96.44, 45.95] },
  { name: 'Tennessee', bbox: [-90.31, 34.98, -81.65, 36.68] },
  { name: 'Texas', bbox: [-106.65, 25.84, -93.51, 36.5] },
  { name: 'Utah', bbox: [-114.05, 36.99, -109.04, 42.0] },
  { name: 'Vermont', bbox: [-73.44, 42.73, -71.46, 45.02] },
  { name: 'Virginia', bbox: [-83.68, 36.54, -75.24, 39.47] },
  { name: 'Washington', bbox: [-124.85, 45.54, -116.92, 49.0] },
  { name: 'West Virginia', bbox: [-82.64, 37.2, -77.72, 40.64] },
  { name: 'Wisconsin', bbox: [-92.89, 42.49, -86.8, 47.31] },
  { name: 'Wyoming', bbox: [-111.06, 40.99, -104.05, 45.01] },
];

// ---- shared ArcGIS helpers ---------------------------------------------------

interface ArcgisFeature {
  attributes?: Record<string, unknown>;
}
interface ArcgisExtent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}
interface ArcgisResponse {
  features?: ArcgisFeature[];
  extent?: ArcgisExtent;
  error?: { message?: string };
}

/** Case-insensitive first-attribute read (ArcGIS field casing varies by service). */
function firstAttrValue(attrs: Record<string, unknown> | undefined): unknown {
  if (!attrs) return undefined;
  for (const k in attrs) return attrs[k];
  return undefined;
}

/** Fetch sorted, de-duplicated distinct string values of one field from an ArcGIS layer.
 * When `bbox` is given, restrict to features intersecting that envelope (EPSG:4326). */
async function fetchDistinct(
  queryUrl: string,
  field: string,
  signal?: AbortSignal,
  bbox?: BBox,
): Promise<string[]> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: field,
    returnDistinctValues: 'true',
    returnGeometry: 'false',
    f: 'json',
  });
  if (bbox) {
    const [w, s, e, n] = bbox;
    params.set('geometry', `${w},${s},${e},${n}`);
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
  }
  const resp = await arcgisFetch(`${queryUrl}?${params.toString()}`, signal);
  if (!resp.ok) throw new Error(`ArcGIS ${resp.status} ${resp.statusText}`);
  const json = (await resp.json()) as ArcgisResponse;
  if (json.error) throw new Error(`ArcGIS error: ${json.error.message ?? 'unknown'}`);
  const seen = new Set<string>();
  for (const f of json.features ?? []) {
    const v = firstAttrValue(f.attributes);
    if (v == null) continue;
    const s = String(v).trim();
    // Drop empty and numeric-only data artifacts (NPS has a stray UNITNAME "1").
    if (s && /[a-z]/i.test(s)) seen.add(s);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Fetch the 4326 extent of the features matching `field = value`, or null. */
async function fetchExtent(
  queryUrl: string,
  field: string,
  value: string,
  signal?: AbortSignal,
): Promise<BBox | null> {
  const escaped = value.replace(/'/g, "''");
  const params = new URLSearchParams({
    where: `${field}='${escaped}'`,
    returnExtentOnly: 'true',
    outSR: '4326',
    f: 'json',
  });
  const resp = await arcgisFetch(`${queryUrl}?${params.toString()}`, signal);
  if (!resp.ok) throw new Error(`ArcGIS ${resp.status} ${resp.statusText}`);
  const json = (await resp.json()) as ArcgisResponse;
  if (json.error) throw new Error(`ArcGIS error: ${json.error.message ?? 'unknown'}`);
  const ex = json.extent;
  if (
    !ex ||
    ![ex.xmin, ex.ymin, ex.xmax, ex.ymax].every((n) => typeof n === 'number' && isFinite(n))
  ) {
    return null;
  }
  return [ex.xmin, ex.ymin, ex.xmax, ex.ymax];
}

// ---- NPS park units ----------------------------------------------------------

// Cache keyed by bbox ("all" when unfiltered, else the state name/bbox key).
const parkUnitsCache = new Map<string, Promise<string[]>>();

/** Distinct NPS park unit names (UNITNAME), sorted. Optionally scoped to a bbox.
 * Cached per bbox key for the session. */
export function fetchParkUnits(signal?: AbortSignal, bbox?: BBox): Promise<string[]> {
  const key = bbox ? bbox.join(',') : 'all';
  let cached = parkUnitsCache.get(key);
  if (!cached) {
    cached = fetchDistinct(NPS_TRAILS_URL, NPS_UNIT_FIELD, signal, bbox).catch((err) => {
      parkUnitsCache.delete(key); // allow retry after a failure
      throw err;
    });
    parkUnitsCache.set(key, cached);
  }
  return cached;
}

/** 4326 extent of an NPS park unit's trails, or null if none. */
export function fetchParkExtent(unitname: string, signal?: AbortSignal): Promise<BBox | null> {
  return fetchExtent(NPS_TRAILS_URL, NPS_UNIT_FIELD, unitname, signal);
}

// ---- USFS national forests ---------------------------------------------------

const forestsCache = new Map<string, Promise<string[]>>();

/** Distinct USFS administrative forest names (forestname), sorted. Optionally scoped
 * to a bbox. Cached per bbox key for the session. */
export function fetchForests(signal?: AbortSignal, bbox?: BBox): Promise<string[]> {
  const key = bbox ? bbox.join(',') : 'all';
  let cached = forestsCache.get(key);
  if (!cached) {
    cached = fetchDistinct(USFS_FORESTS_URL, USFS_FOREST_FIELD, signal, bbox).catch((err) => {
      forestsCache.delete(key);
      throw err;
    });
    forestsCache.set(key, cached);
  }
  return cached;
}

/** 4326 extent of a USFS forest boundary, or null if none. */
export function fetchForestExtent(name: string, signal?: AbortSignal): Promise<BBox | null> {
  return fetchExtent(USFS_FORESTS_URL, USFS_FOREST_FIELD, name, signal);
}

// ---- OSM peaks in view -------------------------------------------------------

export interface Peak {
  name: string;
  ele: number | null; // meters
  lng: number;
  lat: number;
}

interface OverpassNode {
  type: string;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

/** Parse a messy OSM `ele` tag (meters, may carry units/commas) into a number or null. */
function parseEle(raw: string | undefined): number | null {
  if (!raw) return null;
  // Take the first numeric token; tolerate "3,764", "3764 m", "3764m".
  const m = raw.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return isFinite(n) ? n : null;
}

const PEAKS_URL = '/api/overpass';
const PEAKS_TOP = 30;

/**
 * Named natural=peak nodes within `bbox`, sorted by elevation desc (unknown ele last),
 * top 30. POSTs to the /api/overpass proxy (same contract as data/overpass.ts).
 */
export async function fetchPeaksInView(bbox: BBox, signal?: AbortSignal): Promise<Peak[]> {
  const [w, s, e, n] = bbox;
  const query = `[out:json][timeout:25];\nnode["natural"="peak"]["name"](${s},${w},${n},${e});\nout qt 200;`;
  const resp = await fetch(PEAKS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status} ${resp.statusText}`);
  const json = (await resp.json()) as { elements?: OverpassNode[] };
  const peaks: Peak[] = [];
  for (const el of json.elements ?? []) {
    if (el.type !== 'node' || el.lat == null || el.lon == null) continue;
    const name = el.tags?.name;
    if (!name) continue;
    peaks.push({ name, ele: parseEle(el.tags?.ele), lng: el.lon, lat: el.lat });
  }
  peaks.sort((a, b) => (b.ele ?? -Infinity) - (a.ele ?? -Infinity));
  return peaks.slice(0, PEAKS_TOP);
}
