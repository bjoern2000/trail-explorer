// Workstream D — per-source GeoJSON sources/layers, selection layer, click/hover.
// Owns trail rendering, the selection halo/core/endpoint treatment, hover feedback,
// and click → select. Data flow: the loader (workstream B) pushes FeatureCollections
// here via setSourceData / clearSource (imported by the loader). Click lookup resolves
// full (un-clipped) features from the loader cache by __fid.

import maplibregl from 'maplibre-gl';
import type { SourceId, AppState } from '../types';
import type { Store } from '../store';
import { SOURCE_IDS, SOURCES } from '../registry';
import { getMap } from './map';
import * as loaderMod from '../data/loader';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const trailSourceId = (id: SourceId) => `trail-${id}`;
const trailLayerId = (id: SourceId) => `trail-${id}-line`;
const OSM_DASH_LAYER = 'trail-osm-dashed';

const SEL_LINE_SOURCE = 'selected-line';
const SEL_PTS_SOURCE = 'selected-endpoints';

// Latest data per source, applied once the style is ready (tolerate early init).
const pendingData = new Map<SourceId, GeoJSON.FeatureCollection>();
let ready = false;
let mapRef: maplibregl.Map | null = null;

// Currently hovered feature (for feature-state driven width bump).
let hovered: { source: string; id: string | number } | null = null;

// --- resilient loader binding (name may differ at integration) ----------------
function lookupFeatureByFid(fid: string): GeoJSON.Feature | undefined {
  const m = loaderMod as unknown as Record<string, unknown>;
  const fn = (m.featureByFid ?? m.getFeatureByFid) as
    | ((fid: string) => GeoJSON.Feature | undefined)
    | undefined;
  try {
    return typeof fn === 'function' ? fn(fid) : undefined;
  } catch {
    return undefined;
  }
}

// Data-driven color for the selection layers, keyed off the injected __source.
function sourceColorMatch(): maplibregl.ExpressionSpecification {
  const stops: (string | string[])[] = [];
  for (const id of SOURCE_IDS) stops.push(id, SOURCES[id].color);
  return ['match', ['get', '__source'], ...stops, '#ffffff'] as unknown as maplibregl.ExpressionSpecification;
}

// Width: interpolate z10 1.2 → z15 3, bumped while hovered.
function trailWidthExpr(): maplibregl.ExpressionSpecification {
  const hover = ['boolean', ['feature-state', 'hover'], false];
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    10,
    ['case', hover, 2.4, 1.2],
    15,
    ['case', hover, 4.6, 3],
  ] as unknown as maplibregl.ExpressionSpecification;
}

// OSM informal / access-restricted predicate → dashed rendering.
const osmRestrictedExpr = [
  'any',
  ['==', ['get', 'informal'], 'yes'],
  ['in', ['get', 'access'], ['literal', ['no', 'private', 'discouraged']]],
] as unknown as maplibregl.ExpressionSpecification;

function whenStyleReady(map: maplibregl.Map, cb: () => void): void {
  if (map.isStyleLoaded()) cb();
  else map.once('load', cb);
}

function ensureSetup(): void {
  if (ready || !mapRef) return;
  const map = mapRef;

  for (const id of SOURCE_IDS) {
    const def = SOURCES[id];
    if (!map.getSource(trailSourceId(id))) {
      map.addSource(trailSourceId(id), {
        type: 'geojson',
        data: EMPTY_FC,
        promoteId: '__fid',
      });
    }

    if (id === 'osm') {
      // Solid layer excludes restricted; dashed layer draws restricted.
      if (!map.getLayer(trailLayerId('osm'))) {
        map.addLayer({
          id: trailLayerId('osm'),
          type: 'line',
          source: trailSourceId('osm'),
          filter: ['!', osmRestrictedExpr] as unknown as maplibregl.FilterSpecification,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': def.color,
            'line-width': trailWidthExpr(),
            'line-opacity': 0.92,
          },
        });
      }
      if (!map.getLayer(OSM_DASH_LAYER)) {
        map.addLayer({
          id: OSM_DASH_LAYER,
          type: 'line',
          source: trailSourceId('osm'),
          filter: osmRestrictedExpr as unknown as maplibregl.FilterSpecification,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': def.color,
            'line-width': trailWidthExpr(),
            'line-opacity': 0.92,
            'line-dasharray': [2.2, 1.8],
          },
        });
      }
    } else if (!map.getLayer(trailLayerId(id))) {
      map.addLayer({
        id: trailLayerId(id),
        type: 'line',
        source: trailSourceId(id),
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': def.color,
          'line-width': trailWidthExpr(),
          'line-opacity': 0.92,
        },
      });
    }
  }

  // Selection sources + layers, drawn above all trails.
  if (!map.getSource(SEL_LINE_SOURCE)) {
    map.addSource(SEL_LINE_SOURCE, { type: 'geojson', data: EMPTY_FC });
  }
  if (!map.getSource(SEL_PTS_SOURCE)) {
    map.addSource(SEL_PTS_SOURCE, { type: 'geojson', data: EMPTY_FC });
  }
  const color = sourceColorMatch();
  if (!map.getLayer('sel-halo')) {
    map.addLayer({
      id: 'sel-halo',
      type: 'line',
      source: SEL_LINE_SOURCE,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
    });
  }
  if (!map.getLayer('sel-underlay')) {
    map.addLayer({
      id: 'sel-underlay',
      type: 'line',
      source: SEL_LINE_SOURCE,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#10201b', 'line-width': 5.4, 'line-opacity': 0.85 },
    });
  }
  if (!map.getLayer('sel-core')) {
    map.addLayer({
      id: 'sel-core',
      type: 'line',
      source: SEL_LINE_SOURCE,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': 3, 'line-opacity': 1 },
    });
  }
  // Start/finish markers: white halo ring + green (start) / red (finish) core,
  // sized up so they read at a glance against the topo paper and the trail line.
  if (!map.getLayer('sel-endpoints-halo')) {
    map.addLayer({
      id: 'sel-endpoints-halo',
      type: 'circle',
      source: SEL_PTS_SOURCE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 7, 13, 10],
        'circle-color': '#ffffff',
        'circle-stroke-width': 1,
        'circle-stroke-color': '#10201b',
      },
    });
  }
  if (!map.getLayer('sel-endpoints')) {
    map.addLayer({
      id: 'sel-endpoints',
      type: 'circle',
      source: SEL_PTS_SOURCE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 6.5],
        'circle-color': ['match', ['get', 'role'], 'start', '#1a7a45', '#b23a2e'],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff',
      },
    });
  }

  ready = true;

  // Flush any data that arrived before the style settled.
  for (const [id, fc] of pendingData) applyData(id, fc);
  pendingData.clear();
}

function applyData(id: SourceId, fc: GeoJSON.FeatureCollection): void {
  const src = mapRef?.getSource(trailSourceId(id)) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(fc);
}

function trailLayerIds(): string[] {
  const ids: string[] = [];
  for (const id of SOURCE_IDS) {
    if (id === 'osm') ids.push(trailLayerId('osm'), OSM_DASH_LAYER);
    else ids.push(trailLayerId(id));
  }
  return ids.filter((lid) => mapRef?.getLayer(lid));
}

function wireInteractions(map: maplibregl.Map, store: Store<AppState>): void {
  const clearHover = () => {
    if (hovered && map.getSource(hovered.source)) {
      map.setFeatureState(hovered, { hover: false });
    }
    hovered = null;
    map.getCanvas().style.cursor = '';
  };

  map.on('mousemove', (e) => {
    const layers = trailLayerIds();
    if (layers.length === 0) return;
    const hits = map.queryRenderedFeatures(e.point, { layers });
    if (hits.length === 0) {
      clearHover();
      return;
    }
    const f = hits[0];
    const src = f.source;
    const id = f.id ?? (f.properties?.__fid as string | undefined);
    if (id == null) return;
    if (hovered && (hovered.source !== src || hovered.id !== id)) {
      if (map.getSource(hovered.source)) map.setFeatureState(hovered, { hover: false });
    }
    hovered = { source: src, id };
    map.setFeatureState(hovered, { hover: true });
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseout', clearHover);

  map.on('click', (e) => {
    const layers = trailLayerIds();
    if (layers.length === 0) return;
    const hits = map.queryRenderedFeatures(e.point, { layers });
    if (hits.length === 0) return; // click on empty map leaves selection intact
    const top = hits[0];
    const props = top.properties || {};
    const fid = props.__fid as string | undefined;
    const source = props.__source as SourceId | undefined;
    if (!source) return;
    const full = (fid ? lookupFeatureByFid(fid) : undefined) ?? (top as unknown as GeoJSON.Feature);
    const def = SOURCES[source];
    const name = (full.properties?.[def.nameField] as string) || '(unnamed)';
    store.set({ selected: { sourceId: source, feature: full, name } });
  });
}

/** Render (or clear) the selection halo + core line + endpoints. */
export function setSelected(feature: GeoJSON.Feature | null): void {
  if (!mapRef || !ready) return;
  const lineSrc = mapRef.getSource(SEL_LINE_SOURCE) as maplibregl.GeoJSONSource | undefined;
  const ptsSrc = mapRef.getSource(SEL_PTS_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!lineSrc || !ptsSrc) return;

  if (!feature || !feature.geometry) {
    lineSrc.setData(EMPTY_FC);
    ptsSrc.setData(EMPTY_FC);
    return;
  }

  lineSrc.setData({ type: 'FeatureCollection', features: [feature] });

  const ends = endpointCoords(feature);
  const source = (feature.properties?.__source as string) || '';
  ptsSrc.setData({
    type: 'FeatureCollection',
    features: ends.map((c, i) => ({
      type: 'Feature',
      properties: { __source: source, role: i === 0 ? 'start' : 'end' },
      geometry: { type: 'Point', coordinates: c },
    })),
  });
}

function endpointCoords(feature: GeoJSON.Feature): number[][] {
  const g = feature.geometry;
  if (g.type === 'LineString' && g.coordinates.length) {
    return [g.coordinates[0], g.coordinates[g.coordinates.length - 1]];
  }
  if (g.type === 'MultiLineString' && g.coordinates.length) {
    const first = g.coordinates[0];
    const last = g.coordinates[g.coordinates.length - 1];
    if (first.length && last.length) return [first[0], last[last.length - 1]];
  }
  return [];
}

/** Replace a source's rendered features with the latest FeatureCollection. */
export function setSourceData(sourceId: SourceId, fc: GeoJSON.FeatureCollection): void {
  if (!ready) {
    pendingData.set(sourceId, fc);
    return;
  }
  applyData(sourceId, fc);
}

/** Clear a source's layer (below-zoom / disabled). */
export function clearSource(sourceId: SourceId): void {
  if (!ready) {
    pendingData.set(sourceId, EMPTY_FC);
    return;
  }
  applyData(sourceId, EMPTY_FC);
}

/** Add all per-source line layers + the selection layers; wire click/hover. */
export function initLayers(store: Store<AppState>): void {
  const map = getMap();
  mapRef = map;

  whenStyleReady(map, () => {
    ensureSetup();
    wireInteractions(map, store);
    setSelected(store.get().selected?.feature ?? null);
  });

  // Keep the selection layer in sync with the store (covers click, search, and
  // the inspector ✕ which sets selected = null).
  store.subscribe(['selected'], (state) => {
    setSelected(state.selected?.feature ?? null);
  });

  // If the loader prefers a callback sink, register it too (integration-tolerant).
  const lm = loaderMod as unknown as Record<string, unknown>;
  const setSink = lm.setLayerSink as
    | ((fn: (id: SourceId, fc: GeoJSON.FeatureCollection | null) => void) => void)
    | undefined;
  if (typeof setSink === 'function') {
    setSink((id, fc) => (fc ? setSourceData(id, fc) : clearSource(id)));
  }
}
