// Benchmark page entry — AllTrails vs open-data coverage explorer.
//
// Static, keyless page: the derived aggregates are bundled (model.ts), the map draws
// trailhead points colored by match outcome, and segment geometry is fetched ONCE per
// region on first selection through the same adapters the map app uses (segments.ts).
// All headline numbers are read from the JSON at runtime — nothing is hardcoded.

import '../tokens.css';
import './benchmark.css';

import type { BBox } from '../data/loader';
import type { Units } from '../types';
import { SOURCE_IDS, SOURCES } from '../registry';
import { h, displayTrailName, fmtDistance, fmtNumber } from '../ui/dom';
import { mountNav } from '../ui/nav';
import {
  REGIONS,
  OUTCOME_COLOR,
  OUTCOME_LABEL,
  REASON_SHORT,
  outcomeOf,
  readUnits,
  type Outcome,
  type RegionEntry,
  type Route,
} from './model';
import { BenchmarkMap } from './bmap';
import { loadRegionSegments, segmentsResolved } from './segments';
import { renderDetail, SHORT_LABEL } from './detail';
import { renderTable, resetTableState } from './table';

const OUTCOME_ORDER: Outcome[] = ['exact', 'fuzzy', 'unmatched', 'excluded'];

// ---- page state -------------------------------------------------------------

type View = 'map' | 'table';
const VIEW_KEY = 'trailscope-bm-view';

let region: RegionEntry = REGIONS[0];
let selectedId: string | null = null;
let filterText = '';
let bmap: BenchmarkMap | null = null; // lazy: created on first map-view display
let view: View = 'map';
const units = readUnits();

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'map';
  } catch {
    return 'map';
  }
}

function regionBBox(r: RegionEntry): BBox {
  return r.data.meta.bbox as BBox;
}

function routeById(id: string): Route | undefined {
  return region.data.routes.find((r) => r.trailId === id);
}

// ---- view toggle (MAP | TABLE) ------------------------------------------------

/** Create the map lazily so landing in table view pays no map init cost. */
function ensureMap(): BenchmarkMap {
  if (!bmap) {
    const container = document.getElementById('map');
    if (!container) throw new Error('#map container missing');
    bmap = new BenchmarkMap(container, regionBBox(region), { onSelect: (id) => void selectRoute(id) });
    bmap.setTrailheads(region.data.routes, outcomeOf);
    // Dev-only handle so tests can assert map state (feature-states, selection).
    if (import.meta.env?.DEV) (window as unknown as Record<string, unknown>).__bmap = bmap;
  }
  return bmap;
}

function renderTableView(resetExpansion = false): void {
  const host = document.getElementById('bm-table-wrap');
  if (!host) return;
  renderTable(host, region, filterText, units, {
    onShowOnMap: (id) => {
      setView('map');
      ensureMap().whenReady(() => void selectRoute(id));
    },
  }, resetExpansion);
}

function setView(v: View, persist = true): void {
  view = v;
  if (persist) {
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  }
  document.body.classList.toggle('bm-view-table', v === 'table');
  const wrap = document.getElementById('bm-table-wrap');
  if (wrap) wrap.hidden = v !== 'table';
  const seg = document.getElementById('bm-view-seg');
  if (seg) {
    for (const btn of Array.from(seg.querySelectorAll('button'))) {
      const on = btn.dataset.view === v;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }
  if (v === 'map') {
    const m = ensureMap();
    // The canvas may have been created or left while display:none; re-measure.
    m.map.resize();
  } else {
    renderTableView();
  }
}

function initViewToggle(): void {
  const seg = document.getElementById('bm-view-seg');
  if (!seg) return;
  seg.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    const v = btn?.dataset.view;
    if (v === 'map' || v === 'table') setView(v);
  });
}

// ---- headline stat block ----------------------------------------------------

/** Whole-unit long length with thousands separators: "1,404 km" / "873 mi". */
function fmtLongLength(meters: number, units: Units): string {
  const v = units === 'metric' ? meters / 1000 : meters / 1609.344;
  return `${fmtNumber(Math.round(v))} ${units === 'metric' ? 'km' : 'mi'}`;
}

function renderStats(): void {
  const host = document.getElementById('bm-stats');
  if (!host) return;
  const s = region.data.summary;
  const any = s.anySource;
  const eligible = s.denominators.adjusted;
  const raw = s.denominators.raw;
  const netPct = s.networkPresence.within100m?.pct ?? 0;

  const excludedParts = Object.entries(s.excluded.byReason)
    .map(([reason, n]) => `${n} ${REASON_SHORT[reason] ?? reason}`)
    .join(', ');

  const lw = s.lengthWeighted;
  host.replaceChildren(
    h('div', { class: 'bm-stat' },
      h('div', { class: 'bm-stat-k' }, 'Any-source coverage'),
      h('div', { class: 'bm-stat-big' },
        h('span', { class: 'bm-stat-num' }, `${fmtNumber(any.exact.coveragePct)}%`),
        h('span', { class: 'bm-stat-sub' }, ' exact'),
        h('span', { class: 'bm-stat-div' }, ' / '),
        h('span', { class: 'bm-stat-num' }, `${fmtNumber(any.inclFuzzy.coveragePct)}%`),
        h('span', { class: 'bm-stat-sub' }, ' incl. fuzzy'),
      ),
      h('div', { class: 'bm-stat-note' }, `${fmtNumber(eligible)} eligible routes`),
    ),
    h('div', { class: 'bm-stat' },
      h('div', { class: 'bm-stat-k' }, 'By route length'),
      h('div', { class: 'bm-stat-big' },
        h('span', { class: 'bm-stat-num' }, `${fmtNumber(lw.anySource.exactPct)}%`),
        h('span', { class: 'bm-stat-sub' }, ' exact'),
        h('span', { class: 'bm-stat-div' }, ' / '),
        h('span', { class: 'bm-stat-num' }, `${fmtNumber(lw.anySource.inclFuzzyPct)}%`),
        h('span', { class: 'bm-stat-sub' }, ' incl. fuzzy'),
      ),
      h('div', { class: 'bm-stat-note' }, `of ${fmtLongLength(lw.denomM, units)} of routes`),
    ),
    h('div', { class: 'bm-stat' },
      h('div', { class: 'bm-stat-k' }, 'Network presence'),
      h('div', { class: 'bm-stat-big' },
        h('span', { class: 'bm-stat-num' }, `${fmtNumber(netPct)}%`),
        h('span', { class: 'bm-stat-sub' }, ' within 100 m'),
      ),
      h('div', { class: 'bm-stat-note' }, 'trailhead near an open-data feature'),
    ),
    h('div', { class: 'bm-counts' },
      `${fmtNumber(raw)} routes · ${fmtNumber(s.excluded.count)} excluded${excludedParts ? ` (${excludedParts})` : ''}`,
    ),
  );
}

// ---- open network matched block ----------------------------------------------

const NPS_SEG_NOTE =
  'NPS serves long uncut features extending beyond the region bbox, inflating its denominator — see methodology';

function renderNetworkMatched(): void {
  const host = document.getElementById('bm-netmatch');
  if (!host) return;
  const nm = region.data.summary.networkMatched;
  host.replaceChildren();
  for (const id of SOURCE_IDS) {
    const entry = nm[id];
    const row = h('div', { class: 'bm-nm-row' },
      h('span', { class: 'bm-nm-sw', style: `background:${SOURCES[id].color}` }),
      h('span', { class: 'bm-nm-label' },
        SHORT_LABEL[id],
        // Segmentation caveat marker: NPS's uncut features inflate its denominator.
        id === 'nps' && entry?.pct != null
          ? h('sup', { class: 'bm-nm-note', title: NPS_SEG_NOTE }, '*')
          : null,
      ),
    );
    if (!entry) {
      row.append(h('span', { class: 'bm-nm-val bm-nm-muted' }, 'n/a'));
    } else if (entry.pct == null && entry.featureCounts.named === 0) {
      row.append(h('span', { class: 'bm-nm-val bm-nm-muted' }, 'no data in region'));
    } else if (entry.pct == null) {
      row.append(h('span', { class: 'bm-nm-val bm-nm-muted' }, 'n/a'));
    } else {
      // "182 of 505 km (36%)" — unit once, on the denominator.
      const matchedVal = units === 'metric' ? entry.matchedM / 1000 : entry.matchedM / 1609.344;
      row.append(
        h('span', { class: 'bm-nm-val' },
          `${fmtNumber(Math.round(matchedVal))} of ${fmtLongLength(entry.namedM, units)} (${fmtNumber(entry.pct)}%)`,
        ),
      );
    }
    host.append(row);
  }
}

// ---- route list -------------------------------------------------------------

function sortedRoutes(): Route[] {
  return region.data.routes.slice().sort((a, b) => b.numReviews - a.numReviews);
}

function renderList(): void {
  const host = document.getElementById('bm-list');
  const countEl = document.getElementById('bm-list-count');
  if (!host) return;

  const q = filterText.trim().toLowerCase();
  const rows = sortedRoutes().filter((r) => !q || r.name.toLowerCase().includes(q));
  if (countEl) countEl.textContent = `${fmtNumber(rows.length)} of ${fmtNumber(region.data.routes.length)}`;

  host.replaceChildren();
  if (rows.length === 0) {
    host.append(h('div', { class: 'bm-list-empty' }, 'No routes match.'));
    return;
  }
  for (const r of rows) {
    const outcome = outcomeOf(r);
    const row = h('div', { class: 'bm-row' + (r.trailId === selectedId ? ' sel' : ''), dataset: { id: r.trailId } },
      h('span', { class: 'bm-dot', style: `background:${OUTCOME_COLOR[outcome]}` }),
      h('span', { class: 'bm-row-name' }, displayTrailName(r.name)),
      h('span', { class: 'bm-row-meta' },
        r.numReviews ? h('span', { class: 'bm-row-rev' }, `${fmtNumber(r.numReviews)}★`) : null,
        h('span', { class: 'bm-row-len' }, r.lengthMeters == null ? '—' : fmtDistance(r.lengthMeters, units)),
      ),
    );
    row.addEventListener('click', () => void selectRoute(r.trailId));
    host.append(row);
  }
}

// ---- legend -----------------------------------------------------------------

function renderLegend(): void {
  const host = document.getElementById('bm-legend');
  if (!host) return;
  const items = OUTCOME_ORDER.map((o) =>
    h('div', { class: 'bm-legend-item' },
      h('span', { class: 'bm-dot', style: `background:${OUTCOME_COLOR[o]}` }),
      OUTCOME_LABEL[o],
    ),
  );
  host.replaceChildren(
    h('div', { class: 'bm-legend-row' }, ...items),
    h('div', { class: 'bm-legend-lic' },
      `AllTrails data: scraped snapshot ${region.data.meta.scrapedAt} · restricted, benchmark only`,
    ),
  );
}

// ---- selection --------------------------------------------------------------

function closeDetail(): void {
  selectedId = null;
  bmap?.setSelected(null);
  bmap?.setSegments([]);
  const card = document.getElementById('bm-detail');
  if (card) card.hidden = true;
  renderList();
}

function paintDetail(
  route: Route,
  loading: boolean,
  failed: Set<import('../types').SourceId>,
  partial: Set<import('../types').SourceId>,
): void {
  const card = document.getElementById('bm-detail');
  if (!card) return;
  card.replaceChildren(
    ...renderDetail(route, units, { loadingSegments: loading, failed, partial }, closeDetail),
  );
  card.hidden = false;
  card.scrollTop = 0;
}

async function selectRoute(id: string): Promise<void> {
  const route = routeById(id);
  if (!route) return;
  selectedId = id;
  renderList();
  bmap?.setSelected(id);

  // Capture the region BEFORE any await: switching regions mid-fetch must not
  // attribute this fetch (or its resolved state) to the newly selected region.
  const regionId = region.id;
  const bbox = regionBBox(region);
  const alreadyLoaded = segmentsResolved(regionId);
  paintDetail(route, !alreadyLoaded, new Set(), new Set());

  const cache = await loadRegionSegments(regionId, bbox);
  // Bail if the selection or region changed while segments were loading.
  if (selectedId !== id || region.id !== regionId) return;

  // Collect matched segment features across all sources for this route.
  const seen = new Set<string>();
  const segments: GeoJSON.Feature[] = [];
  for (const m of Object.values(route.matches)) {
    for (const fid of m.featureIds) {
      if (seen.has(fid)) continue;
      const f = cache.byFid.get(fid);
      if (f) {
        seen.add(fid);
        segments.push(f);
      }
    }
  }

  paintDetail(route, false, cache.failed, cache.partial);
  bmap?.setSegments(segments);
  bmap?.fitToSelection([route.longitude, route.latitude], segments);
}

// ---- methodology ------------------------------------------------------------

function renderMethodology(): void {
  const body = document.getElementById('bm-method-body');
  if (!body) return;
  const meta = region.data.meta;
  const points: (string | Node)[] = [
    `Snapshot: AllTrails scraped ${meta.scrapedAt}; open-source segments fetched live from the same six endpoints and bboxes as the map app.`,
    'Routes vs segments: AllTrails records are curated routes (loops / out-and-backs); open sources are segment networks. The relationship is one-to-many, so raw counts are never compared, only route coverage.',
    'Name matching is a lower bound: a route counts as covered only when a constituent trail name matches within proximity. Physically-present-but-differently-named trails read as unmatched.',
    'Fuzzy tier: a normalized-token match that is close but not exact (e.g. a shared stem or a subset of the name), reported separately from exact matches.',
    'Matched-segment length is the summed length of name-matched segments; AllTrails out-and-back lengths count the round trip, so the comparable corridor is roughly half.',
    'Route-length-weighted coverage is demand-side: kilometers of AllTrails routes, which overlap heavily on shared corridors, not physical trail kilometers.',
    'Open-network-matched is inventory-side: the share of each source\'s named network referenced by at least one route, deduplicated by feature.',
    'Important: per-source network percentages are not comparable across sources because segmentation differs. NPS serves long uncut features extending beyond the region bbox, inflating its denominator (505 km vs roughly 240-260 km for USGS/COTREX carrying the same trails). Read them as "well under 100%", not as a source ranking.',
    'Network presence is a trailhead proxy: with no route geometry available, it measures whether an open-data feature sits near the trailhead, not whether the full route is mapped.',
    'NPS, USGS, and COTREX largely carry the same upstream network in this region, so their per-source numbers are not independent.',
    'AllTrails data is restricted and used here for benchmarking only: names, points, and aggregates only, no descriptions, photos, or review text.',
  ];
  body.replaceChildren(...points.map((p) => h('p', { class: 'bm-method-p' }, p)));
}

// ---- region wiring ----------------------------------------------------------

function renderRegion(): void {
  renderStats();
  renderNetworkMatched();
  renderLegend();
  renderList();
  renderMethodology();
  if (bmap) {
    // Mutators self-defer until the style is ready; apply the CURRENT selection
    // (which may have been made while the map was still loading) instead of
    // wiping it — the queue preserves call order, so the last user action wins.
    bmap.setTrailheads(region.data.routes, outcomeOf);
    bmap.setSelected(selectedId);
    if (!selectedId) {
      bmap.setSegments([]);
      bmap.fitToBBox(regionBBox(region));
    }
  }
}

function initRegionSelect(): void {
  const sel = document.getElementById('bm-region') as HTMLSelectElement | null;
  if (!sel) return;
  sel.replaceChildren(
    ...REGIONS.map((r) => h('option', { value: r.id }, r.label) as HTMLOptionElement),
  );
  sel.value = region.id;
  sel.addEventListener('change', () => {
    const next = REGIONS.find((r) => r.id === sel.value);
    if (!next) return;
    region = next;
    selectedId = null;
    resetTableState();
    closeDetail();
    renderRegion();
    if (view === 'table') renderTableView();
  });
}

function initFilter(): void {
  const input = document.getElementById('bm-filter') as HTMLInputElement | null;
  if (!input) return;
  input.addEventListener('input', () => {
    filterText = input.value;
    renderList();
    if (view === 'table') renderTableView(true);
  });
}

function initMethodologyToggle(): void {
  const head = document.getElementById('bm-method-head');
  const body = document.getElementById('bm-method-body');
  if (!head || !body) return;
  const toggle = (): void => {
    const open = body.hidden;
    body.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
    head.classList.toggle('open', open);
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
}

// ---- boot -------------------------------------------------------------------

function boot(): void {
  mountNav('benchmark');
  initViewToggle();
  initRegionSelect();
  initFilter();
  initMethodologyToggle();
  // setView lazily creates the map only when landing in (or switching to) map view.
  setView(readView(), false);
  renderRegion();

  // Dev-time invariant: outcome tallies computed here must equal the JSON summary.
  if (import.meta.env?.DEV) verifyOutcomeCounts();
}

/** Assert the runtime outcome tally matches summary.anySource (exact + fuzzy). */
function verifyOutcomeCounts(): void {
  const counts: Record<Outcome, number> = { exact: 0, fuzzy: 0, unmatched: 0, excluded: 0 };
  for (const r of region.data.routes) counts[outcomeOf(r)]++;
  const s = region.data.summary;
  const exactOk = counts.exact === s.anySource.exact.matched;
  const inclFuzzyOk = counts.exact + counts.fuzzy === s.anySource.inclFuzzy.matched;
  const excludedOk = counts.excluded === s.excluded.count;
  if (!exactOk || !inclFuzzyOk || !excludedOk) {
    console.warn('[benchmark] outcome tally mismatch vs summary', { counts, summary: s.anySource, excluded: s.excluded.count });
  } else {
    console.info('[benchmark] outcome tally matches summary', counts);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
