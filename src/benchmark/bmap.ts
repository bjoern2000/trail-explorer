// Benchmark page — lightweight 2D MapLibre map (no store, no terrain, no 3D).
//
// Mirrors the map app's USGS Topo raster source def (src/map/map.ts) but stands alone:
// its own map instance, one basemap, a dashed region-bbox rectangle, one trailhead
// circle layer colored by outcome, a selected-halo treatment, and a segment-highlight
// pair (white halo underlay + source-colored core) mirroring src/map/layers.ts.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { SOURCE_IDS, SOURCES } from '../registry';
import { OUTCOME_COLOR, type Outcome, type Route } from './model';

const TOPO_SOURCE = 'bm-usgs-topo';
const TOPO_LAYER = 'bm-usgs-topo-layer';
const BBOX_SOURCE = 'bm-bbox';
const BBOX_LAYER = 'bm-bbox-line';
const THEAD_SOURCE = 'bm-trailheads';
const THEAD_LAYER = 'bm-trailheads-circle';
const SEG_SOURCE = 'bm-segments';
const SEG_HALO_LAYER = 'bm-segments-halo';
const SEG_CORE_LAYER = 'bm-segments-core';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

type BBox = [number, number, number, number]; // [w, s, e, n]

export interface BenchmarkMapHandlers {
  onSelect: (trailId: string) => void;
}

export class BenchmarkMap {
  readonly map: maplibregl.Map;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private loaded = false;
  private readyCbs: (() => void)[] = [];

  constructor(container: HTMLElement, bbox: BBox, handlers: BenchmarkMapHandlers) {
    const [w, s, e, n] = bbox;
    this.map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {
          [TOPO_SOURCE]: {
            type: 'raster',
            tiles: [
              'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
            ],
            tileSize: 256,
            maxzoom: 16,
            attribution: 'USGS The National Map',
          },
        },
        layers: [{ id: TOPO_LAYER, type: 'raster', source: TOPO_SOURCE }],
      },
      bounds: [
        [w, s],
        [e, n],
      ],
      fitBoundsOptions: { padding: 48 },
      attributionControl: false,
    });

    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    this.map.on('load', () => {
      this.setupLayers(bbox);
      this.wire(handlers);
      // Re-fit once the style is up (padding is honoured after the container has size).
      this.map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 48, duration: 0 },
      );
      this.loaded = true;
      for (const cb of this.readyCbs) cb();
      this.readyCbs = [];
    });
  }

  /** Run `cb` once the style + layers are ready (immediately if already loaded). */
  whenReady(cb: () => void): void {
    if (this.loaded) cb();
    else this.readyCbs.push(cb);
  }

  /** Fit the camera to a region bbox (used on region switch). */
  fitToBBox(bbox: BBox): void {
    this.whenReady(() => {
      const [w, s, e, n] = bbox;
      this.map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 48, duration: 500 },
      );
    });
  }

  private setupLayers(bbox: BBox): void {
    const m = this.map;
    const [w, s, e, n] = bbox;

    // Region bbox as a thin dashed accent rectangle.
    m.addSource(BBOX_SOURCE, {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        },
      },
    });
    m.addLayer({
      id: BBOX_LAYER,
      type: 'line',
      source: BBOX_SOURCE,
      paint: { 'line-color': '#a35e00', 'line-width': 1.2, 'line-dasharray': [4, 3], 'line-opacity': 0.8 },
    });

    // Segment highlight pair (below trailheads): white halo underlay + source-colored core.
    m.addSource(SEG_SOURCE, { type: 'geojson', data: EMPTY_FC });
    m.addLayer({
      id: SEG_HALO_LAYER,
      type: 'line',
      source: SEG_SOURCE,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 },
    });
    m.addLayer({
      id: SEG_CORE_LAYER,
      type: 'line',
      source: SEG_SOURCE,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': this.sourceColorMatch(), 'line-width': 2.6, 'line-opacity': 1 },
    });

    // Trailheads (above everything): circle colored by outcome, larger on hover/selection.
    m.addSource(THEAD_SOURCE, { type: 'geojson', data: EMPTY_FC, promoteId: 'trailId' });
    m.addLayer({
      id: THEAD_LAYER,
      type: 'circle',
      source: THEAD_SOURCE,
      paint: {
        'circle-radius': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          7,
          ['boolean', ['feature-state', 'hover'], false],
          6,
          4.5,
        ],
        'circle-color': [
          'match',
          ['get', 'outcome'],
          'exact',
          OUTCOME_COLOR.exact,
          'fuzzy',
          OUTCOME_COLOR.fuzzy,
          'unmatched',
          OUTCOME_COLOR.unmatched,
          'excluded',
          OUTCOME_COLOR.excluded,
          '#888888',
        ],
        'circle-stroke-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          '#ffffff',
          '#1f2a24',
        ],
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          3,
          1,
        ],
      },
    });
  }

  private sourceColorMatch(): maplibregl.ExpressionSpecification {
    const stops: string[] = [];
    for (const id of SOURCE_IDS) stops.push(id, SOURCES[id].color);
    return ['match', ['get', '__source'], ...stops, '#ffffff'] as unknown as maplibregl.ExpressionSpecification;
  }

  private wire(handlers: BenchmarkMapHandlers): void {
    const m = this.map;
    m.on('mousemove', THEAD_LAYER, (e) => {
      const f = e.features?.[0];
      const id = f?.properties?.trailId as string | undefined;
      if (id == null) return;
      if (this.hoveredId && this.hoveredId !== id) this.setHover(this.hoveredId, false);
      this.hoveredId = id;
      this.setHover(id, true);
      m.getCanvas().style.cursor = 'pointer';
    });
    m.on('mouseleave', THEAD_LAYER, () => {
      if (this.hoveredId) this.setHover(this.hoveredId, false);
      this.hoveredId = null;
      m.getCanvas().style.cursor = '';
    });
    m.on('click', THEAD_LAYER, (e) => {
      const id = e.features?.[0]?.properties?.trailId as string | undefined;
      if (id != null) handlers.onSelect(id);
    });
  }

  private setHover(id: string, on: boolean): void {
    this.map.setFeatureState({ source: THEAD_SOURCE, id }, { hover: on });
  }

  // All mutators below self-defer via whenReady: a call made before MapLibre 'load'
  // (e.g. the user selects a route while tiles are still coming up) is queued and
  // applied in call order once the style + layers exist, so the LAST user action
  // wins instead of erroring against a missing source and then being wiped.

  /** Load the trailhead points (one per route) as a FeatureCollection. */
  setTrailheads(routes: Route[], outcomeFor: (r: Route) => Outcome): void {
    this.whenReady(() => {
      const fc: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: routes.map((r) => ({
          type: 'Feature',
          id: r.trailId,
          properties: { trailId: r.trailId, outcome: outcomeFor(r) },
          geometry: { type: 'Point', coordinates: [r.longitude, r.latitude] },
        })),
      };
      const src = this.map.getSource(THEAD_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(fc);
    });
  }

  /** Toggle the white-halo ring on the selected trailhead. */
  setSelected(trailId: string | null): void {
    this.whenReady(() => {
      if (this.selectedId && this.selectedId !== trailId) {
        this.map.setFeatureState({ source: THEAD_SOURCE, id: this.selectedId }, { selected: false });
      }
      this.selectedId = trailId;
      if (trailId) {
        this.map.setFeatureState({ source: THEAD_SOURCE, id: trailId }, { selected: true });
      }
    });
  }

  /** Draw the matched segment geometry for a selection (or clear it). */
  setSegments(features: GeoJSON.Feature[]): void {
    this.whenReady(() => {
      const src = this.map.getSource(SEG_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData({ type: 'FeatureCollection', features });
    });
  }

  /** Ease to cover the trailhead point plus any matched segment geometry. */
  fitToSelection(trailhead: [number, number], segments: GeoJSON.Feature[]): void {
    this.whenReady(() => {
      const b = new maplibregl.LngLatBounds(trailhead, trailhead);
      for (const f of segments) extendBounds(b, f.geometry);
      this.map.fitBounds(b, { padding: 90, maxZoom: 15, duration: 700 });
    });
  }
}

function extendBounds(b: maplibregl.LngLatBounds, g: GeoJSON.Geometry | null): void {
  if (!g) return;
  if (g.type === 'LineString') {
    for (const c of g.coordinates) b.extend(c as [number, number]);
  } else if (g.type === 'MultiLineString') {
    for (const part of g.coordinates) for (const c of part) b.extend(c as [number, number]);
  } else if (g.type === 'Point') {
    b.extend(g.coordinates as [number, number]);
  }
}
