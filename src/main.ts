// index.html entry: build the app store, then wire store ↔ map ↔ ui.
// Phase 0: UI inits are no-op stubs; map init throws until workstream A lands (caught below).

import './tokens.css';
import { createStore } from './store';
import type { AppState, SourceId, SourceViewportState } from './types';
import { SOURCE_IDS, SOURCES } from './registry';
import { initSidebar } from './ui/sidebar';
import { initDossier } from './ui/dossier';
import { initStatusbar } from './ui/statusbar';
import { initInspector } from './ui/inspector';
import { initSearch } from './search/search';
import { initLayers } from './map/layers';
import { initLoader } from './data/loader';
import { initMap } from './map/map';
import { mountNav } from './ui/nav';

function idleViewport(): SourceViewportState {
  return { status: 'idle', featureCount: 0, capped: false, elapsedMs: null };
}

function buildInitialState(): AppState {
  const enabled = {} as Record<SourceId, boolean>;
  const viewport = {} as Record<SourceId, SourceViewportState>;
  for (const id of SOURCE_IDS) {
    enabled[id] = SOURCES[id].enabledByDefault;
    viewport[id] = idleViewport();
  }
  return {
    enabled,
    viewport,
    selected: null,
    dossierOpen: null,
    basemap: 'usgs-topo',
    terrain3d: true,
    exaggeration: 1.4,
    hillshade: true,
    units: localStorage.getItem('trailscope-units') === 'imperial' ? 'imperial' : 'metric',
  };
}

export const store = createStore<AppState>(buildInitialState());

// Persist the units preference whenever it changes.
store.subscribe(['units'], (s) => {
  try {
    localStorage.setItem('trailscope-units', s.units);
  } catch {
    /* storage unavailable (private mode, quota) — non-fatal */
  }
});

function boot(): void {
  mountNav('map');
  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  const mapEl = document.querySelector<HTMLElement>('.map');
  const mapContainer = document.getElementById('map');

  // UI wiring (no-op stubs in Phase 0; operate on the static shell).
  if (sidebar) initSidebar(sidebar, store);
  initSearch(store);
  if (mapEl) {
    initDossier(mapEl, store);
    initStatusbar(mapEl, store);
    initInspector(mapEl, store);
  }

  // Map + data pipeline land in Phase 1; guard so the shell renders until then.
  try {
    if (mapContainer) initMap(mapContainer, store);
    initLayers(store);
    initLoader(store);
  } catch (err) {
    console.info('[TrailScope] map/data pipeline pending (Phase 1):', (err as Error).message);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
