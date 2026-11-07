// Segment-merge page — standalone 2D MapLibre map, one instance for all five stages.
//
// Mirrors benchmark/bmap.ts: same USGS Topo raster basemap, no terrain, no store. One
// GeoJSON source drives every stage; the stage decides the paint expression, so moving
// between stages recolors the SAME geometry in place instead of swapping layers. That
// is the point of the page: the reader watches one set of segments get filtered,
// grouped, and joined.
//
// Per-feature colour arrives as a `__color` property (set by the caller) so a single
// data-driven paint expression covers "colour by name", "colour by cluster" and
// "colour by chain" without a layer per stage. Orientation is shown with start/finish
// markers rather than arrow glyphs: symbols would need an external glyph host, and the
// app is deliberately keyless.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const TOPO_SOURCE = 'mg-usgs-topo';
const TOPO_LAYER = 'mg-usgs-topo-layer';
const SEG_SOURCE = 'mg-segments';
const SEG_HALO = 'mg-segments-halo';
const SEG_CORE = 'mg-segments-core';
const ENDS_SOURCE = 'mg-ends';
const ENDS_LAYER = 'mg-ends-circle';
const MARK_SOURCE = 'mg-marks';
const MARK_LAYER = 'mg-marks-circle';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// Base paint. Features carry a `__key` naming the group they belong to (a name, a
// cluster, a chain), which is what legend hover highlights against.
type NumExpr = maplibregl.DataDrivenPropertyValueSpecification<number>;
const HALO_WIDTH = ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9] as unknown as NumExpr;
const CORE_WIDTH = ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 5] as unknown as NumExpr;
const CORE_WIDTH_HI = ['interpolate', ['linear'], ['zoom'], 10, 3.5, 16, 7] as unknown as NumExpr;
const HALO_OPACITY = ['case', ['boolean', ['get', '__faded'], false], 0.6, 0.9] as unknown as NumExpr;
const CORE_OPACITY = ['case', ['boolean', ['get', '__faded'], false], 0.75, 1] as unknown as NumExpr;
const MARK_OPACITY = ['case', ['boolean', ['get', 'faded'], false], 0.55, 1] as unknown as NumExpr;

export type BBox = [number, number, number, number];

export interface MergeMapHandlers {
  /** Click on a segment: the feature's properties, for the figure's readout. */
  onPick: (props: Record<string, unknown> | null) => void;
}

export class MergeMap {
  readonly map: maplibregl.Map;
  private loaded = false;
  private readyCbs: (() => void)[] = [];

  constructor(container: HTMLElement, bbox: BBox, handlers: MergeMapHandlers) {
    const [w, s, e, n] = bbox;
    this.map = new maplibregl.Map({
      container,
      // The page is a long scrolling document: a map that swallowed the wheel would
      // trap the reader. Pan and the zoom buttons still work.
      scrollZoom: false,
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
            attribution: 'USGS The National Map · © OpenStreetMap contributors (ODbL)',
          },
        },
        layers: [{ id: TOPO_LAYER, type: 'raster', source: TOPO_SOURCE }],
      },
      bounds: [
        [w, s],
        [e, n],
      ],
      fitBoundsOptions: { padding: 56 },
      attributionControl: false,
    });

    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    this.map.on('load', () => {
      this.setupLayers();
      this.wire(handlers);
      this.loaded = true;
      for (const cb of this.readyCbs) cb();
      this.readyCbs = [];
    });
  }

  whenReady(cb: () => void): void {
    if (this.loaded) cb();
    else this.readyCbs.push(cb);
  }

  private setupLayers(): void {
    const m = this.map;
    m.addSource(SEG_SOURCE, { type: 'geojson', data: EMPTY_FC });

    // White halo underlay so source colours stay legible on the topo raster.
    m.addLayer({
      id: SEG_HALO,
      type: 'line',
      source: SEG_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': HALO_WIDTH,
        'line-opacity': HALO_OPACITY,
      },
    });
    m.addLayer({
      id: SEG_CORE,
      type: 'line',
      source: SEG_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', '__color'], '#d93a52'],
        'line-width': CORE_WIDTH,
        'line-opacity': CORE_OPACITY,
        'line-dasharray': ['case', ['boolean', ['get', '__dashed'], false], ['literal', [2, 2]], ['literal', [1, 0]]],
      },
    });
    // Locator dots. A 1 km trail is sub-pixel on a statewide view, so when the drawn
    // extent is wide the page marks each segment/cluster with a dot in its own colour —
    // otherwise the clustering example renders as an empty map of Colorado.
    m.addSource(MARK_SOURCE, { type: 'geojson', data: EMPTY_FC });
    m.addLayer({
      id: MARK_LAYER,
      type: 'circle',
      source: MARK_SOURCE,
      paint: {
        'circle-radius': ['case', ['boolean', ['get', 'faded'], false], 5, 7],
        'circle-color': ['get', 'color'],
        'circle-opacity': MARK_OPACITY,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });

    // Start (green) / finish (red) markers, matching the map app's treatment. Used at
    // the chained + merged stages: they are how orientation is shown, since every
    // chain is emitted start-to-finish in one consistent direction.
    m.addSource(ENDS_SOURCE, { type: 'geojson', data: EMPTY_FC });
    m.addLayer({
      id: ENDS_LAYER,
      type: 'circle',
      source: ENDS_SOURCE,
      paint: {
        'circle-radius': 5.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });
  }

  private wire(handlers: MergeMapHandlers): void {
    const m = this.map;
    m.on('mouseenter', SEG_CORE, () => {
      m.getCanvas().style.cursor = 'pointer';
    });
    m.on('mouseleave', SEG_CORE, () => {
      m.getCanvas().style.cursor = '';
    });
    m.on('click', SEG_CORE, (ev) => {
      const f = ev.features?.[0];
      handlers.onPick(f ? ((f.properties ?? {}) as Record<string, unknown>) : null);
    });
    m.on('click', (ev) => {
      const hits = m.queryRenderedFeatures(ev.point, { layers: [SEG_CORE] });
      if (hits.length === 0) handlers.onPick(null);
    });
  }

  /** Replace the drawn geometry. Features carry __color / __faded / __dashed / __arrows. */
  setFeatures(features: GeoJSON.Feature[]): void {
    this.whenReady(() => {
      const src = this.map.getSource(SEG_SOURCE) as maplibregl.GeoJSONSource | undefined;
      src?.setData({ type: 'FeatureCollection', features });
    });
  }

  /**
   * Emphasise one legend group and mute the rest; null restores the base paint.
   * Driven by paint expressions rather than re-uploading data, so hover is cheap.
   */
  setHighlight(key: string | null): void {
    this.whenReady(() => {
      const m = this.map;
      const is = (a: unknown, b: unknown): NumExpr =>
        ['case', ['==', ['get', '__key'], key], a, b] as unknown as NumExpr;
      m.setPaintProperty(SEG_CORE, 'line-opacity', key == null ? CORE_OPACITY : is(1, 0.12));
      m.setPaintProperty(SEG_HALO, 'line-opacity', key == null ? HALO_OPACITY : is(0.95, 0.08));
      m.setPaintProperty(SEG_CORE, 'line-width', key == null ? CORE_WIDTH : is(CORE_WIDTH_HI, CORE_WIDTH));
      m.setPaintProperty(
        MARK_LAYER,
        'circle-opacity',
        key == null ? MARK_OPACITY : (['case', ['==', ['get', 'key'], key], 1, 0.15] as unknown as NumExpr),
      );
    });
  }

  /** Locator dots (empty array clears them). */
  setMarkers(points: { lng: number; lat: number; color: string; faded?: boolean; key?: string }[]): void {
    this.whenReady(() => {
      const src = this.map.getSource(MARK_SOURCE) as maplibregl.GeoJSONSource | undefined;
      src?.setData({
        type: 'FeatureCollection',
        features: points.map((p) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: { color: p.color, faded: p.faded === true, key: p.key ?? '' },
        })),
      });
    });
  }

  /** Start/finish markers for the merged result (empty array clears them). */
  setEnds(points: { lng: number; lat: number; color: string }[]): void {
    this.whenReady(() => {
      const src = this.map.getSource(ENDS_SOURCE) as maplibregl.GeoJSONSource | undefined;
      src?.setData({
        type: 'FeatureCollection',
        features: points.map((p) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: { color: p.color },
        })),
      });
    });
  }

  /** Fit to the given features; no-op when they carry no vertices. */
  fitTo(features: GeoJSON.Feature[], padding = 64): void {
    this.whenReady(() => {
      const b = new maplibregl.LngLatBounds();
      let any = false;
      for (const f of features) {
        const g = f.geometry;
        const parts =
          g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
        for (const p of parts) {
          for (const c of p) {
            b.extend([c[0], c[1]]);
            any = true;
          }
        }
      }
      if (any) this.map.fitBounds(b, { padding, duration: 600, maxZoom: 16 });
    });
  }
}
