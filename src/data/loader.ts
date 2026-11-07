// Workstream B — viewport orchestration: debounce, abort, cache, cap detection.
//
// On moveend (+ initial load, 400 ms debounce) fetches every enabled source whose
// zoom >= minZoom with a per-source AbortController (aborting any in-flight request
// first), updates store.viewport statuses, keeps the latest FeatureCollection per
// source in memory (backs click lookup + inspector), and pushes FCs to the map via
// a sink callback registered by layers.ts (setLayerSink). Late sink registration
// still receives all currently-cached data via replay.

import type { SourceId, AppState } from '../types';
import type { Store } from '../store';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { SOURCES, SOURCE_IDS } from '../registry';
import { getMap } from '../map/map';
import { fetchArcgisViewport } from './arcgis';
import { fetchOverpassViewport } from './overpass';

/** Geographic bbox as [west, south, east, north] in EPSG:4326. */
export type BBox = [number, number, number, number];

/** Result of one adapter fetch for a source's current viewport. */
export interface AdapterResult {
  features: GeoJSON.Feature[];
  capped: boolean;
}

/** Callback layers.ts registers to receive per-source FeatureCollections. */
export type LayerSink = (sourceId: SourceId, fc: GeoJSON.FeatureCollection) => void;

const DEBOUNCE_MS = 400;
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// ---- module singletons ----
let map: MapLibreMap | null = null;
let store: Store<AppState> | null = null;
let sink: LayerSink | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let prevEnabled: Record<SourceId, boolean> | null = null;

const controllers = new Map<SourceId, AbortController>();
// Latest FeatureCollection per source (only ready/non-empty results kept).
const cache = new Map<SourceId, GeoJSON.FeatureCollection>();

// ---- public cache accessors (needed by layers.ts / inspector.ts / search.ts) ----

/** Latest FeatureCollection cached for a source (backs click lookup + inspector). */
export function getCachedFeatures(sourceId: SourceId): GeoJSON.FeatureCollection | undefined {
  return cache.get(sourceId);
}

/** Look up a full cached feature by its injected `__fid` across all sources. */
export function getFeatureByFid(fid: string): GeoJSON.Feature | undefined {
  for (const fc of cache.values()) {
    for (const f of fc.features) {
      if (f.properties && (f.properties as Record<string, unknown>).__fid === fid) return f;
    }
  }
  return undefined;
}

/** Register the map layer sink; replays currently-cached FCs so late registration still paints. */
export function setLayerSink(fn: LayerSink): void {
  sink = fn;
  for (const [id, fc] of cache) fn(id, fc);
}

// ---- trail grouping / segment merging (shared by search + discovery) ----
//
// The implementation lives in ./merge.ts (no browser imports, so it also runs
// headless for the segment-merge page). Re-exported here because search, sidebar,
// altsources and metrics have always imported these from loader.

export {
  normalizeTrailName,
  featureLengthMeters,
  featureBBox,
  chainSegments,
  chainSegmentsDetailed,
  mergeSegmentsToFeature,
  clusterSegments,
  clusterSegmentsDetailed,
  clusterSegmentsAll,
  CHAIN_TOLERANCE_M,
  CLUSTER_GAP_M,
} from './merge';
export type { ClusterResult, ClusterInfo, ClusterAll, ChainDetail } from './merge';

// ---- internals ----

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function currentBBox(m: MapLibreMap): BBox {
  const b = m.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

function pushToSink(id: SourceId, fc: GeoJSON.FeatureCollection): void {
  if (sink) sink(id, fc);
}

function setViewport(id: SourceId, patch: Partial<AppState['viewport'][SourceId]>): void {
  if (!store) return;
  const cur = store.get().viewport;
  const next = { ...cur, [id]: { ...cur[id], ...patch } };
  store.set({ viewport: next });
}

/** Clear a source's data + layer and set a terminal status (below-zoom / disabled). */
function clearSource(id: SourceId, status: 'below-zoom' | 'disabled'): void {
  cache.delete(id);
  pushToSink(id, EMPTY_FC);
  setViewport(id, {
    status,
    featureCount: 0,
    capped: false,
    elapsedMs: null,
    error: undefined,
  });
}

async function fetchSource(id: SourceId): Promise<void> {
  if (!map || !store) return;
  const def = SOURCES[id];

  // abort any in-flight request for this source first
  controllers.get(id)?.abort();
  controllers.delete(id);

  if (map.getZoom() < def.minZoom) {
    clearSource(id, 'below-zoom');
    return;
  }

  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  setViewport(id, { status: 'loading', error: undefined });

  const adapter = def.kind === 'overpass' ? fetchOverpassViewport : fetchArcgisViewport;
  const t0 = performance.now();
  try {
    const res = await adapter(def, currentBBox(map), ctrl.signal);
    if (ctrl.signal.aborted) return;
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: res.features };
    cache.set(id, fc);
    pushToSink(id, fc);
    setViewport(id, {
      status: 'ready',
      featureCount: res.features.length,
      capped: res.capped,
      elapsedMs: Math.round(performance.now() - t0),
      error: undefined,
    });
  } catch (err) {
    if (isAbort(err)) return;
    setViewport(id, {
      status: 'error',
      featureCount: 0,
      capped: false,
      elapsedMs: Math.round(performance.now() - t0),
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (controllers.get(id) === ctrl) controllers.delete(id);
  }
}

function disableSource(id: SourceId): void {
  controllers.get(id)?.abort();
  controllers.delete(id);
  clearSource(id, 'disabled');
}

/** Fetch every enabled source for the current viewport. */
function refreshAll(): void {
  if (!store) return;
  const { enabled } = store.get();
  for (const id of SOURCE_IDS) {
    if (enabled[id]) void fetchSource(id);
  }
}

function scheduleRefresh(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    refreshAll();
  }, DEBOUNCE_MS);
}

/**
 * Core loader wiring: map moveend + initial load, enabled subscription.
 * (initLoader — what main.ts calls — delegates here with getMap().)
 */
export function startLoader(m: MapLibreMap, s: Store<AppState>): void {
  map = m;
  store = s;
  prevEnabled = { ...s.get().enabled };

  // Sources off by default start in the 'disabled' status.
  for (const id of SOURCE_IDS) {
    if (!s.get().enabled[id]) setViewport(id, { status: 'disabled' });
  }

  m.on('moveend', scheduleRefresh);

  // Re-fetch a newly enabled source; clear a newly disabled one.
  s.subscribe(['enabled'], (state) => {
    const prev = prevEnabled ?? state.enabled;
    for (const id of SOURCE_IDS) {
      if (prev[id] === state.enabled[id]) continue;
      if (state.enabled[id]) void fetchSource(id);
      else disableSource(id);
    }
    prevEnabled = { ...state.enabled };
  });

  // Initial load once the style is ready.
  if (m.loaded()) refreshAll();
  else m.once('load', refreshAll);
}

/** Wire the loader to the store + map moveend. Called by main.ts (map from getMap()). */
export function initLoader(s: Store<AppState>): void {
  startLoader(getMap(), s);
}

// ---- Phase 0 stub-name aliases ----
export const getCache = getCachedFeatures;
export const featureByFid = getFeatureByFid;
