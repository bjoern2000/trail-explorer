// Workstream D — cross-source name search (Nominatim + ArcGIS LIKE).
// `runSearch` fans out to Nominatim (OSM, only when enabled) and every enabled +
// searchable ArcGIS source in parallel (8s timeout each) and returns grouped hits.
// `initSearch` owns the search-box DOM: Enter to search, Escape to clear, grouped
// result rendering, and result → selection + flyTo. (Sidebar delegates this to us.)

import type { SourceId, AppState, TrailSourceDef, Units } from '../types';
import type { Store } from '../store';
import { SOURCE_IDS, SOURCES } from '../registry';
import { getMap } from '../map/map';
import { flyToTrail } from '../map/camera';
import { h, displayTrailName, fmtDistance } from '../ui/dom';
import * as arcgisMod from '../data/arcgis';
import { fetchArcgisByExactName } from '../data/arcgis';
import { mergeSegmentsToFeature, clusterSegmentsDetailed, normalizeTrailName } from '../data/loader';

const SEARCH_TIMEOUT_MS = 8000;
const NOMINATIM_CLASSES = new Set(['highway', 'route', 'leisure', 'natural']);

const BADGE: Record<SourceId, string> = {
  osm: 'OSM',
  usfs: 'USFS',
  nps: 'NPS',
  blm: 'BLM',
  usgs: 'USGS',
  cotrex: 'COTREX',
  dec: 'DEC',
};

/** One search hit, grouped by source in the dropdown. */
export interface SearchHit {
  sourceId: SourceId; // 'osm' covers Nominatim results
  name: string;
  meta: string; // subtitle, e.g. "USFS · 4 segments · 3.2 mi" or "OSM · way"
  feature: GeoJSON.Feature | null; // Line → selectable; Point+bbox → flyTo only
  error?: boolean;
  // Set on grouped ArcGIS rows: click fetches every segment by exact name and
  // merges them into one feature before selecting (see pickArcgisGroup). `anchor`
  // is one geometry-bearing LIKE hit, used to pick the right spatial cluster.
  arcgisGroup?: { def: TrailSourceDef; exactName: string; anchor?: GeoJSON.Feature };
}

// --- resilient arcgis binding (name may differ at integration) ----------------
function arcgisSearchFn():
  | ((def: (typeof SOURCES)[SourceId], term: string, signal: AbortSignal) => Promise<GeoJSON.Feature[]>)
  | undefined {
  const m = arcgisMod as unknown as Record<string, unknown>;
  return (m.searchArcgis ?? m.searchArcgisByName) as
    | ((def: (typeof SOURCES)[SourceId], term: string, signal: AbortSignal) => Promise<GeoJSON.Feature[]>)
    | undefined;
}

function timeoutController(ms: number): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

function milesFromProps(props: Record<string, unknown> | null | undefined): number | null {
  if (!props) return null;
  const direct = ['gis_miles', 'GIS_MILES', 'lengthmiles', 'length_mi_', 'length_mi'];
  for (const k of direct) {
    const v = props[k];
    if (v != null && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  }
  const shape = props['Shape__Length'] ?? props['shape__length'];
  if (shape != null && !Number.isNaN(Number(shape))) return Number(shape) / 1609.344;
  return null;
}

function errorHit(id: SourceId): SearchHit {
  return { sourceId: id, name: 'search failed', meta: '', feature: null, error: true };
}

// --- Nominatim ----------------------------------------------------------------
async function searchNominatim(term: string): Promise<SearchHit[]> {
  const { signal, done } = timeoutController(SEARCH_TIMEOUT_MS);
  try {
    const url =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=us&polygon_geojson=1&q=' +
      encodeURIComponent(term);
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return [errorHit('osm')];
    const rows = (await res.json()) as NominatimRow[];
    const hits: SearchHit[] = [];
    for (const r of rows) {
      if (!NOMINATIM_CLASSES.has(r.class)) continue;
      const name = r.name || r.display_name.split(',')[0] || '(unnamed)';
      const geom = r.geojson;
      if (geom && (geom.type === 'LineString' || geom.type === 'MultiLineString')) {
        hits.push({
          sourceId: 'osm',
          name,
          meta: `OSM · ${r.type || 'way'}`,
          feature: {
            type: 'Feature',
            properties: { __source: 'osm', name },
            geometry: geom,
          },
        });
      } else {
        const bb = r.boundingbox?.map(Number);
        const feature: GeoJSON.Feature = {
          type: 'Feature',
          properties: { __source: 'osm', name },
          geometry: { type: 'Point', coordinates: [Number(r.lon), Number(r.lat)] },
        };
        if (bb && bb.length === 4) feature.bbox = [bb[2], bb[0], bb[3], bb[1]];
        hits.push({ sourceId: 'osm', name, meta: `OSM · ${r.type || r.class}`, feature });
      }
    }
    return hits;
  } catch {
    return [errorHit('osm')];
  } finally {
    done();
  }
}

interface NominatimRow {
  display_name: string;
  name?: string;
  class: string;
  type?: string;
  lon: string;
  lat: string;
  boundingbox?: string[];
  geojson?: GeoJSON.Geometry;
}

// --- ArcGIS -------------------------------------------------------------------
// Agencies store trails as many segments sharing one name; the raw LIKE query
// returns near-identical rows. Group them by normalized name so each trail is a
// single row (with a segment count + summed length); the click then fetches all
// segments by exact name and merges them.
interface NameGroup {
  name: string; // original casing from the first hit
  count: number;
  miles: number;
  hasMiles: boolean;
  anchor?: GeoJSON.Feature; // first geometry-bearing hit, anchors the spatial cluster
}

async function searchArcgisSource(def: TrailSourceDef, term: string, units: Units): Promise<SearchHit[]> {
  const fn = arcgisSearchFn();
  if (!fn) return [];
  const { signal, done } = timeoutController(SEARCH_TIMEOUT_MS);
  try {
    const features = await fn(def, term, signal);
    const groups = new Map<string, NameGroup>();
    for (const f of features) {
      const props = (f.properties || {}) as Record<string, unknown>;
      const name = (props[def.nameField] as string) || '(unnamed)';
      const key = normalizeTrailName(name);
      let g = groups.get(key);
      if (!g) {
        g = { name, count: 0, miles: 0, hasMiles: false };
        groups.set(key, g);
      }
      g.count += 1;
      if (!g.anchor && f.geometry) g.anchor = f;
      const mi = milesFromProps(props);
      if (mi != null) {
        g.miles += mi;
        g.hasMiles = true;
      }
    }
    return [...groups.values()].map((g) => {
      const parts = [BADGE[def.id]];
      if (g.count > 1) parts.push(`${g.count} segments`);
      if (g.hasMiles) parts.push(fmtDistance(g.miles * 1609.344, units));
      return {
        sourceId: def.id,
        name: g.name,
        meta: parts.join(' · '),
        feature: null, // click fetches + merges all segments by exact name
        arcgisGroup: { def, exactName: g.name, anchor: g.anchor },
      };
    });
  } catch {
    return [errorHit(def.id)];
  } finally {
    done();
  }
}

/** Fetch every segment of a grouped ArcGIS trail, merge, select, and fly to it. */
async function pickArcgisGroup(hit: SearchHit, store: Store<AppState>): Promise<void> {
  const grp = hit.arcgisGroup;
  if (!grp) return;
  const { signal, done } = timeoutController(SEARCH_TIMEOUT_MS);
  try {
    const features = await fetchArcgisByExactName(grp.def, grp.exactName, signal);
    // The exact-name query hits the whole national layer, so many distinct trails
    // share the name. Cluster spatially and merge only the cluster the clicked hit
    // belongs to; note any other clusters as same-named trails elsewhere.
    const { features: clustered, clusterCount } = clusterSegmentsDetailed(features, grp.anchor);
    const merged = mergeSegmentsToFeature(clustered, grp.def.id, grp.exactName);
    if (!merged) return;
    if (clusterCount > 1) {
      (merged.properties as Record<string, unknown>).__other_clusters = clusterCount - 1;
    }
    const name = (merged.properties?.[grp.def.nameField] as string) || hit.name;
    store.set({ selected: { sourceId: grp.def.id, feature: merged, name } });
    try {
      flyToTrail(merged);
    } catch {
      /* camera not ready */
    }
  } finally {
    done();
  }
}

/** Fan out to Nominatim + enabled ArcGIS sources; return grouped hits. */
export async function runSearch(term: string, store: Store<AppState>): Promise<SearchHit[]> {
  const t = term.trim();
  if (!t) return [];
  const state = store.get();
  const tasks: Promise<SearchHit[]>[] = [];
  if (state.enabled.osm) tasks.push(searchNominatim(t));
  for (const id of SOURCE_IDS) {
    if (id === 'osm') continue;
    const def = SOURCES[id];
    if (!state.enabled[id] || !def.searchable || def.kind !== 'arcgis') continue;
    tasks.push(searchArcgisSource(def, t, state.units));
  }
  const groups = await Promise.all(tasks);
  return groups.flat();
}

// --- DOM wiring ---------------------------------------------------------------
function isLine(feature: GeoJSON.Feature | null): boolean {
  return (
    !!feature &&
    !!feature.geometry &&
    (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString')
  );
}

function pick(hit: SearchHit, store: Store<AppState>): void {
  const feature = hit.feature;
  if (!feature) return;
  if (isLine(feature)) {
    const props = (feature.properties || {}) as Record<string, unknown>;
    if (props.__source == null) props.__source = hit.sourceId;
    if (props.__fid == null) props.__fid = `${hit.sourceId}:${Math.random().toString(36).slice(2)}`;
    feature.properties = props;
    store.set({ selected: { sourceId: hit.sourceId, feature, name: hit.name } });
    try {
      flyToTrail(feature);
    } catch {
      /* camera not ready */
    }
  } else if (feature.bbox && feature.bbox.length === 4) {
    try {
      const b = feature.bbox as [number, number, number, number];
      getMap().fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, duration: 1200 });
    } catch {
      /* map not ready */
    }
  }
}

function renderResults(container: HTMLElement, hits: SearchHit[], store: Store<AppState>): void {
  container.replaceChildren();
  if (hits.length === 0) {
    container.append(h('div.result', null, h('span.r-name', { style: 'color:var(--faint)' }, 'No matches')));
    return;
  }
  for (const id of SOURCE_IDS) {
    const group = hits.filter((x) => x.sourceId === id);
    if (group.length === 0) continue;
    container.append(h('div.result-group', null, SOURCES[id].label));
    for (const hit of group) {
      if (hit.error) {
        container.append(
          h('div.result', null,
            h('span.swatch', { style: `background:${SOURCES[id].color}` }),
            h('span.r-name', { style: 'color:var(--bad)' }, `${BADGE[id]} search failed`),
          ),
        );
        continue;
      }
      const meta = h('span.r-meta', null, hit.meta);
      const row = h('div.result', null,
        h('span.swatch', { style: `background:${SOURCES[id].color}` }),
        h('span.r-name', { title: hit.name }, displayTrailName(hit.name)),
        meta,
      );
      row.addEventListener('click', () => {
        container.querySelectorAll('.result.sel').forEach((el) => el.classList.remove('sel'));
        row.classList.add('sel');
        if (hit.arcgisGroup) {
          if (row.classList.contains('loading')) return;
          row.classList.add('loading');
          meta.textContent = 'loading…';
          pickArcgisGroup(hit, store).finally(() => {
            row.classList.remove('loading');
            meta.textContent = hit.meta;
          });
        } else {
          pick(hit, store);
        }
      });
      container.append(row);
    }
  }
}

/** Attach Enter-to-search / Escape-to-clear behavior to the sidebar search box. */
export function initSearch(store: Store<AppState>): void {
  const input =
    document.querySelector<HTMLInputElement>('#search-input') ||
    document.querySelector<HTMLInputElement>('#trail-search-input');
  const results =
    document.querySelector<HTMLElement>('#search-results') ||
    document.querySelector<HTMLElement>('#trail-search-results');
  if (!input || !results) return;

  let token = 0;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      results.replaceChildren();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const term = input.value.trim();
    if (!term) {
      results.replaceChildren();
      return;
    }
    const my = ++token;
    results.replaceChildren(
      h('div.result', null, h('span.r-name', { style: 'color:var(--faint)' }, 'Searching…')),
    );
    runSearch(term, store)
      .then((hits) => {
        if (my !== token) return;
        renderResults(results, hits, store);
      })
      .catch(() => {
        if (my !== token) return;
        results.replaceChildren(
          h('div.result', null, h('span.r-name', { style: 'color:var(--bad)' }, 'Search failed')),
        );
      });
  });
}
