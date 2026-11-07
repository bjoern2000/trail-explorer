// Workstream A — MapLibre bootstrap: basemaps, terrain, sky, hillshade.
//
// Design notes (PLAN §5):
// - Three raster basemaps are ALL present as sources+layers; switching only toggles
//   layer visibility (never setStyle) so overlay/trail layers survive a basemap change.
// - Two independent raster-dem sources from AWS Terrarium: one drives setTerrain, the
//   other backs the hillshade layer (MapLibre requires separate raster-dem instances
//   for terrain vs. hillshade).
// - The AttributionControl reflects active sources automatically: MapLibre only shows a
//   source's `attribution` while a visible layer references it, so toggling basemap
//   visibility / hillshade visibility keeps the credit line correct.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { AppState } from '../types';
import type { Store } from '../store';

let map: maplibregl.Map | null = null;

// ---- Constants ------------------------------------------------------------

const INITIAL_CENTER: [number, number] = [-105.646, 40.313]; // RMNP / Bear Lake
const INITIAL_ZOOM = 12;

type Basemap = AppState['basemap'];

// Source + layer ids. Sources and layers live in separate namespaces, but distinct
// names keep debugging clear.
const BASEMAP_SOURCE: Record<Basemap, string> = {
  'usgs-topo': 'bm-usgs-topo',
  'usgs-imagery': 'bm-usgs-imagery',
  opentopo: 'bm-opentopo',
};
const BASEMAP_LAYER: Record<Basemap, string> = {
  'usgs-topo': 'bm-usgs-topo-layer',
  'usgs-imagery': 'bm-usgs-imagery-layer',
  opentopo: 'bm-opentopo-layer',
};
const BASEMAP_ORDER: Basemap[] = ['usgs-topo', 'usgs-imagery', 'opentopo'];

const DEM_TERRAIN_SOURCE = 'dem-terrain';
const DEM_HILLSHADE_SOURCE = 'dem-hillshade';
const HILLSHADE_LAYER = 'hillshade';

const TERRARIUM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
const TERRARIUM_ATTRIB = 'Terrain: AWS Terrarium / Mapzen';

const BASEMAP_ATTRIB: Record<Basemap, string> = {
  'usgs-topo': 'USGS The National Map',
  'usgs-imagery': 'USGS The National Map',
  opentopo: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
};

// ---- Style construction ---------------------------------------------------

function rasterDemSource(): maplibregl.RasterDEMSourceSpecification {
  return {
    type: 'raster-dem',
    tiles: TERRARIUM_TILES,
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 15,
    attribution: TERRARIUM_ATTRIB,
  };
}

function buildStyle(active: Basemap): maplibregl.StyleSpecification {
  const sources: maplibregl.StyleSpecification['sources'] = {
    [BASEMAP_SOURCE['usgs-topo']]: {
      type: 'raster',
      tiles: [
        'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 16,
      attribution: BASEMAP_ATTRIB['usgs-topo'],
    },
    [BASEMAP_SOURCE['usgs-imagery']]: {
      type: 'raster',
      tiles: [
        'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 16,
      attribution: BASEMAP_ATTRIB['usgs-imagery'],
    },
    [BASEMAP_SOURCE.opentopo]: {
      type: 'raster',
      tiles: [
        'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
        'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
        'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 17,
      attribution: BASEMAP_ATTRIB.opentopo,
    },
    [DEM_TERRAIN_SOURCE]: rasterDemSource(),
    [DEM_HILLSHADE_SOURCE]: rasterDemSource(),
  };

  const layers: maplibregl.LayerSpecification[] = [
    ...BASEMAP_ORDER.map(
      (bm): maplibregl.LayerSpecification => ({
        id: BASEMAP_LAYER[bm],
        type: 'raster',
        source: BASEMAP_SOURCE[bm],
        layout: { visibility: bm === active ? 'visible' : 'none' },
      })
    ),
    {
      id: HILLSHADE_LAYER,
      type: 'hillshade',
      source: DEM_HILLSHADE_SOURCE,
      layout: { visibility: 'visible' },
      paint: {
        // Subtle relief shading that reads under the topo linework.
        'hillshade-exaggeration': 0.35,
        'hillshade-shadow-color': '#0e1b16',
        'hillshade-accent-color': '#0e1b16',
        'hillshade-highlight-color': '#f2efe6',
      },
    },
  ];

  return {
    version: 8,
    sources,
    layers,
    sky: {
      'sky-color': '#9dc3f0',
      'horizon-color': '#dfeaf0',
      'fog-color': '#e2e9e4',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.5,
      'fog-ground-blend': 0.4,
      'atmosphere-blend': 0.5,
    },
  };
}

// ---- Control chrome offset ------------------------------------------------
// The status bar occupies the bottom 30px of the map. Lift MapLibre's bottom
// controls (attribution) above it. Self-contained; injected once from this module.
function injectCtrlOffset(): void {
  if (document.getElementById('ts-map-ctrl-css')) return;
  const style = document.createElement('style');
  style.id = 'ts-map-ctrl-css';
  style.textContent =
    '.maplibregl-ctrl-bottom-right,.maplibregl-ctrl-bottom-left{bottom:30px;}';
  document.head.appendChild(style);
}

// ---- Terrain / hillshade / basemap appliers -------------------------------

function applyBasemap(m: maplibregl.Map, active: Basemap): void {
  for (const bm of BASEMAP_ORDER) {
    m.setLayoutProperty(BASEMAP_LAYER[bm], 'visibility', bm === active ? 'visible' : 'none');
  }
}

function applyTerrain(m: maplibregl.Map, on: boolean, exaggeration: number): void {
  if (on) {
    m.setTerrain({ source: DEM_TERRAIN_SOURCE, exaggeration });
  } else {
    m.setTerrain(null);
  }
}

function applyHillshade(m: maplibregl.Map, on: boolean): void {
  m.setLayoutProperty(HILLSHADE_LAYER, 'visibility', on ? 'visible' : 'none');
}

// ---- Public API -----------------------------------------------------------

/** Create the MapLibre map in `container` and wire it to the store. */
export function initMap(container: HTMLElement, store: Store<AppState>): maplibregl.Map {
  const s = store.get();

  injectCtrlOffset();

  map = new maplibregl.Map({
    container,
    style: buildStyle(s.basemap),
    center: INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
    pitch: 0,
    bearing: 0,
    maxPitch: 75,
    attributionControl: false,
    // Terrarium DEM only covers CONUS-ish usefully; keep it keyless/simple.
  });

  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  const m = map;

  m.on('load', () => {
    // Apply initial store-derived state now that sources/layers exist.
    applyBasemap(m, s.basemap);
    applyHillshade(m, s.hillshade);
    applyTerrain(m, s.terrain3d, s.exaggeration);
  });

  // React to store changes. Read current state each time; apply only what changed
  // is unnecessary — each applier is idempotent and cheap.
  store.subscribe(['basemap', 'terrain3d', 'exaggeration', 'hillshade'], (state) => {
    if (!m.isStyleLoaded()) {
      // Very early changes are covered by the 'load' handler above.
      return;
    }
    applyBasemap(m, state.basemap);
    applyHillshade(m, state.hillshade);
    applyTerrain(m, state.terrain3d, state.exaggeration);
  });

  return m;
}

/**
 * Cross-workstream contract (PLAN §7): the singleton map instance.
 * Workstream A assigns `map` inside initMap; other workstreams read it here.
 */
export function getMap(): maplibregl.Map {
  if (!map) throw new Error('getMap called before initMap (workstream A)');
  return map;
}

/**
 * Convenience for the status bar: fire `cb` on every camera move with the current
 * center/zoom/pitch/bearing. Returns an unsubscribe. The status bar may use this or
 * subscribe to `getMap().on('move', …)` directly — both are equivalent.
 */
export function onCameraChange(
  cb: (info: { lng: number; lat: number; zoom: number; pitch: number; bearing: number }) => void
): () => void {
  const m = getMap();
  const handler = (): void => {
    const c = m.getCenter();
    cb({ lng: c.lng, lat: c.lat, zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() });
  };
  m.on('move', handler);
  handler();
  return () => {
    m.off('move', handler);
  };
}
