// Workstream B — ArcGIS query adapter (viewport fetch + LIKE name search).
//
// Implements the PLAN §5 shared ArcGIS query pattern. All ArcGIS sources use
// f=geojson / esriGeometryEnvelope / outFields=* / resultRecordCount=2000.
// BLM merges two sublayers (4 non-motorized, 5 non-mechanized); its __fid is
// prefixed with the sublayer index so OBJECTIDs from the two layers can't collide.

import type { TrailSourceDef } from '../types';
import type { BBox, AdapterResult } from './loader';

const VIEWPORT_RECORD_COUNT = 2000;
const SEARCH_RECORD_COUNT = 50;
const EXACT_RECORD_COUNT = 2000;

// All ArcGIS traffic is routed through the local server cache proxy
// (server.js /api/arcgis) so on Railway every user shares one warm cache and
// demos survive flaky government endpoints via stale-on-error. Escape hatch:
// add ?direct=1 to the page URL to hit upstreams directly (browser CORS works)
// and evaluate the real API. Read once at module init.
const ARCGIS_DIRECT =
  typeof location !== 'undefined' && /(?:^|[?&])direct=1(?:&|$)/.test(location.search);

/**
 * Low-level ArcGIS fetch used at EVERY ArcGIS call site (here + places.ts +
 * altsources.ts). Rewrites `url` to `/api/arcgis?u=<encoded>` unless ?direct=1.
 * AbortController signals pass straight through the proxy.
 */
export function arcgisFetch(url: string, signal?: AbortSignal): Promise<Response> {
  const target = ARCGIS_DIRECT ? url : `/api/arcgis?u=${encodeURIComponent(url)}`;
  return fetch(target, { signal });
}

/** Case-insensitive property lookup (ArcGIS field casing varies by service). */
function getProp(props: Record<string, unknown>, field: string): unknown {
  if (props[field] !== undefined) return props[field];
  const lower = field.toLowerCase();
  for (const k in props) {
    if (k.toLowerCase() === lower) return props[k];
  }
  return undefined;
}

/** Inject __fid / __source (and __sublayer for BLM) into a batch of features.
 *  Exported for the benchmark page's paginated segment fetch (src/benchmark/segments.ts). */
export function injectIds(
  features: GeoJSON.Feature[],
  def: TrailSourceDef,
  layerIdx: number,
): void {
  const isBlm = def.id === 'blm';
  for (const f of features) {
    const props = (f.properties ?? (f.properties = {})) as Record<string, unknown>;
    const idVal = getProp(props, def.idField);
    props.__fid = isBlm
      ? `${def.id}:${layerIdx}:${idVal}`
      : `${def.id}:${idVal}`;
    props.__source = def.id;
    if (isBlm) {
      props.__sublayer = layerIdx === 0 ? 'non-motorized' : 'non-mechanized';
    }
  }
}

async function runQuery(
  url: string,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<{ features: GeoJSON.Feature[]; exceeded: boolean }> {
  const resp = await arcgisFetch(`${url}?${params.toString()}`, signal);
  if (!resp.ok) throw new Error(`ArcGIS ${resp.status} ${resp.statusText}`);
  const json = (await resp.json()) as {
    features?: GeoJSON.Feature[];
    exceededTransferLimit?: boolean;
    error?: { message?: string };
  };
  if (json.error) throw new Error(`ArcGIS error: ${json.error.message ?? 'unknown'}`);
  const features = Array.isArray(json.features) ? json.features : [];
  return { features, exceeded: json.exceededTransferLimit === true };
}

/**
 * Query one ArcGIS layer (or merge multiple, e.g. BLM 4+5) intersecting the bbox.
 * Cap = exceededTransferLimit OR a layer returned >= maxRecordCount features.
 */
export async function fetchArcgisViewport(
  def: TrailSourceDef,
  bbox: BBox,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const [w, s, e, n] = bbox;
  const params = new URLSearchParams({
    f: 'geojson',
    where: '1=1',
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    resultRecordCount: String(def.maxRecordCount || VIEWPORT_RECORD_COUNT),
  });

  const results = await Promise.all(
    def.queryUrls.map((url, i) =>
      runQuery(url, params, signal).then((r) => {
        injectIds(r.features, def, i);
        return r;
      }),
    ),
  );

  let capped = false;
  const features: GeoJSON.Feature[] = [];
  for (const r of results) {
    features.push(...r.features);
    if (r.exceeded || r.features.length >= (def.maxRecordCount || VIEWPORT_RECORD_COUNT)) {
      capped = true;
    }
  }
  return { features, capped };
}

/**
 * Name search: UPPER(nameField) LIKE UPPER('%term%'), returnGeometry=true,
 * resultRecordCount=15, no geometry filter. Single quotes escaped by doubling.
 * Exported for the search workstream (search/search.ts) to import.
 */
export async function searchArcgisByName(
  def: TrailSourceDef,
  term: string,
  signal: AbortSignal,
): Promise<GeoJSON.Feature[]> {
  const escaped = term.replace(/'/g, "''");
  const params = new URLSearchParams({
    f: 'geojson',
    where: `UPPER(${def.nameField}) LIKE UPPER('%${escaped}%')`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: String(SEARCH_RECORD_COUNT),
  });

  const results = await Promise.all(
    def.queryUrls.map((url, i) =>
      runQuery(url, params, signal).then((r) => {
        injectIds(r.features, def, i);
        return r.features;
      }),
    ),
  );

  const features = results.flat();
  return features.slice(0, SEARCH_RECORD_COUNT);
}

/**
 * Fetch every segment whose name matches `name` exactly: nameField = 'value',
 * returnGeometry=true, resultRecordCount=2000, no geometry filter. Used when a
 * grouped search/discovery result is clicked to gather all of a trail's segments
 * before merging them into one feature. Single quotes escaped by doubling.
 */
export async function fetchArcgisByExactName(
  def: TrailSourceDef,
  name: string,
  signal: AbortSignal,
): Promise<GeoJSON.Feature[]> {
  const escaped = name.replace(/'/g, "''");
  const params = new URLSearchParams({
    f: 'geojson',
    where: `${def.nameField} = '${escaped}'`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: String(EXACT_RECORD_COUNT),
  });

  const results = await Promise.all(
    def.queryUrls.map((url, i) =>
      runQuery(url, params, signal).then((r) => {
        injectIds(r.features, def, i);
        return r.features;
      }),
    ),
  );

  return results.flat();
}

// ---- Phase 0 stub-name aliases (kept so any importer of the original names compiles) ----
export const fetchArcgis = fetchArcgisViewport;
export const searchArcgis = searchArcgisByName;
