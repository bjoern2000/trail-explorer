// Benchmark page — one-time lazy fetch of open-source segment geometry.
//
// The derived JSON carries per-route matches.<source>.featureIds but no geometry. To
// draw matched segments on selection we fetch every source for the region bbox,
// index features by their injected __fid, and cache them in memory per region.
//
// Completeness matters here: derive.mjs built featureIds from UNCAPPED paginated
// fetches, so this module must match that. ArcGIS sources are paginated past the
// 2,000-record cap with the same stop conditions as derive.mjs (advance by the
// returned page length; stop when a page is empty or exceededTransferLimit is false;
// safety guard at 25 pages → 'partial'). The shared viewport adapters are NOT changed
// — the map app keeps its single-page behavior; this module queries /api/arcgis
// directly via arcgisFetch with the same params + __fid injection (injectIds).
// OSM still goes through fetchOverpassViewport; its 6,000-way cap is surfaced as a
// per-source 'partial' state (amber), distinct from 'failed' (red).
//
// Failure model: results are cached per region with per-source granularity. A later
// loadRegionSegments() call retries ONLY the sources currently in the failed set;
// successful sources stay cached, and a failed retry keeps the failed flag without
// clearing good data.

import type { SourceId } from '../types';
import { SOURCES, SOURCE_IDS } from '../registry';
import type { BBox } from '../data/loader';
import { arcgisFetch, injectIds } from '../data/arcgis';
import { fetchOverpassViewport } from '../data/overpass';

const ARCGIS_PAGE_SIZE = 2000;
const ARCGIS_MAX_PAGES = 25; // mirror derive.mjs: 25 * 2000 = 50k features, then call it partial

export interface SegmentCache {
  /** __fid → full feature (with geometry), across every source that answered. */
  byFid: Map<string, GeoJSON.Feature>;
  /** Sources whose fetch failed entirely (match rows show "fetch failed"). */
  failed: Set<SourceId>;
  /** Sources whose fetch was truncated (match rows show "partial data"). */
  partial: Set<SourceId>;
}

const caches = new Map<string, SegmentCache>();
const inflight = new Map<string, Promise<SegmentCache>>();

function fidOf(f: GeoJSON.Feature): string | undefined {
  const p = f.properties as Record<string, unknown> | null;
  const fid = p?.__fid;
  return typeof fid === 'string' ? fid : undefined;
}

// ---- ArcGIS paginated fetch (derive.mjs stop conditions) ----------------------

async function arcgisPage(
  url: string,
  bbox: BBox,
  offset: number,
): Promise<{ features: GeoJSON.Feature[]; exceeded: boolean }> {
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
    resultRecordCount: String(ARCGIS_PAGE_SIZE),
    resultOffset: String(offset),
  });
  const resp = await arcgisFetch(`${url}?${params.toString()}`);
  if (!resp.ok) throw new Error(`ArcGIS ${resp.status} ${resp.statusText}`);
  const json = (await resp.json()) as {
    features?: GeoJSON.Feature[];
    exceededTransferLimit?: boolean;
    error?: { message?: string };
  };
  if (json.error) throw new Error(`ArcGIS error: ${json.error.message ?? 'unknown'}`);
  return {
    features: Array.isArray(json.features) ? json.features : [],
    exceeded: json.exceededTransferLimit === true,
  };
}

async function fetchArcgisAll(
  id: SourceId,
  bbox: BBox,
): Promise<{ features: GeoJSON.Feature[]; partial: boolean }> {
  const def = SOURCES[id];
  const all: GeoJSON.Feature[] = [];
  let partial = false;
  for (let layerIdx = 0; layerIdx < def.queryUrls.length; layerIdx++) {
    let offset = 0;
    let pages = 0;
    for (;;) {
      const { features, exceeded } = await arcgisPage(def.queryUrls[layerIdx], bbox, offset);
      injectIds(features, def, layerIdx);
      all.push(...features);
      pages++;
      // Advance by the ACTUAL page length; exceededTransferLimit says "more remain".
      if (features.length === 0 || !exceeded) break;
      offset += features.length;
      if (pages >= ARCGIS_MAX_PAGES) {
        partial = true;
        break;
      }
    }
  }
  return { features: all, partial };
}

async function fetchOsm(bbox: BBox): Promise<{ features: GeoJSON.Feature[]; partial: boolean }> {
  const res = await fetchOverpassViewport(SOURCES.osm, bbox, new AbortController().signal);
  // capped = element count hit the adapter's 6,000-way limit → data is truncated.
  return { features: res.features, partial: res.capped };
}

// ---- per-region cache with per-source retry ------------------------------------

async function fetchInto(cache: SegmentCache, ids: SourceId[], bbox: BBox): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      try {
        const { features, partial } =
          SOURCES[id].kind === 'overpass' ? await fetchOsm(bbox) : await fetchArcgisAll(id, bbox);
        for (const f of features) {
          const fid = fidOf(f);
          if (fid) cache.byFid.set(fid, f);
        }
        cache.failed.delete(id);
        if (partial) cache.partial.add(id);
        else cache.partial.delete(id);
      } catch {
        // Keep any previously-good data; just (re)flag the source as failed.
        cache.failed.add(id);
      }
    }),
  );
}

/**
 * Load (or top up) a region's segment cache. First call fetches every source; later
 * calls retry only the sources still in the failed set (successes stay cached).
 */
export function loadRegionSegments(regionId: string, bbox: BBox): Promise<SegmentCache> {
  const existing = inflight.get(regionId);
  if (existing) return existing;

  const cached = caches.get(regionId);
  if (cached && cached.failed.size === 0) return Promise.resolve(cached);

  const cache: SegmentCache = cached ?? { byFid: new Map(), failed: new Set(), partial: new Set() };
  const toFetch: SourceId[] = cached ? [...cached.failed] : [...SOURCE_IDS];

  const p = (async () => {
    await fetchInto(cache, toFetch, bbox);
    caches.set(regionId, cache);
    return cache;
  })();
  inflight.set(regionId, p);
  void p.finally(() => inflight.delete(regionId));
  return p;
}

/** Whether a region's first segment fetch has completed (skip the loading state). */
export function segmentsResolved(regionId: string): boolean {
  return caches.has(regionId);
}

/** Current failed/partial state for a region, if any fetch has completed (table view). */
export function getSegmentState(regionId: string): Pick<SegmentCache, 'failed' | 'partial'> | null {
  const c = caches.get(regionId);
  return c ? { failed: c.failed, partial: c.partial } : null;
}
