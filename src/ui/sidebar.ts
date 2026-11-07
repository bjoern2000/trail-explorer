// Workstream C — source rack + map controls, bound both ways to the store.
// Brand/tabs are static markup in index.html. The search box markup also lives in
// index.html; its BEHAVIOR is owned by search.ts (workstream D) — see hook IDs below.
//
// Search hooks left for workstream D:
//   #search-input    — the <input> (Enter-to-search; Nominatim forbids autocomplete)
//   #search-results  — empty container to fill with grouped .result rows
// Sidebar does not read or write those elements.

import type { AppState, SourceId } from '../types';
import type { Store } from '../store';
import { SOURCE_IDS, SOURCES } from '../registry';
import { h, fmtNumber, fmtDistance, fmtElevation, displayTrailName } from './dom';
import { getMap } from '../map/map';
import { flyToTrail } from '../map/camera';
import {
  getCachedFeatures,
  featureLengthMeters,
  mergeSegmentsToFeature,
  clusterSegments,
  clusterSegmentsDetailed,
  normalizeTrailName,
} from '../data/loader';
import type { BBox, Peak, StatePlace } from '../data/places';
import {
  US_STATES,
  fetchParkUnits,
  fetchParkExtent,
  fetchForests,
  fetchForestExtent,
  fetchPeaksInView,
} from '../data/places';

const LIC_CLASS: Record<string, string> = {
  'PUB DOM': 'pd',
  ODbL: 'odbl',
  STATE: 'state',
};

interface RowRefs {
  row: HTMLElement;
  checkbox: HTMLInputElement;
  stats: HTMLElement;
}

/** A small source-colored spinner for in-flight loads. */
function spinner(id: SourceId): HTMLElement {
  return h('span.spinner', { style: `border-top-color:${SOURCES[id].color}` });
}

/** Build the stats-line children for one source from current state. */
function statsChildren(state: Readonly<AppState>, id: SourceId): (Node | null)[] {
  if (!state.enabled[id]) return [h('span.zoom-req', null, 'enable to load')];
  const vp = state.viewport[id];
  switch (vp.status) {
    case 'ready':
      return [
        h('span', null, `${fmtNumber(vp.featureCount)} in view`),
        vp.capped ? h('span.cap', null, '▲ capped') : null,
      ];
    case 'loading':
      return [spinner(id), h('span', null, 'loading…')];
    case 'below-zoom':
      return [h('span.zoom-req', null, 'zoom in to load')];
    case 'error':
      return [h('span.err', null, vp.error || 'request failed')];
    default:
      // 'idle' — enabled but not yet fetched (before first load).
      return [spinner(id), h('span', null, 'loading…')];
  }
}

/** Wire the sidebar (source rack, controls) to the store, both directions. */
export function initSidebar(root: HTMLElement, store: Store<AppState>): void {
  buildRack(root, store);
  wireControls(root, store);
  initDiscover(root, store);
}

// ============ DISCOVER: region quick-picks + trails-in-view browser ============

const INVIEW_TOP = 20;
const INVIEW_MAX = 60;

interface Region {
  label: string;
  bbox: [number, number, number, number]; // [w, s, e, n]
}

const REGIONS: Region[] = [
  { label: 'Rocky Mtn NP', bbox: [-105.75, 40.25, -105.55, 40.42] },
  { label: 'Moab', bbox: [-109.65, 38.45, -109.35, 38.75] },
  { label: 'Lake Tahoe', bbox: [-120.25, 38.75, -119.85, 39.25] },
  { label: 'Santa Monica Mtns', bbox: [-118.85, 33.98, -118.45, 34.15] },
  { label: 'White Mtns NH', bbox: [-71.55, 43.95, -71.05, 44.35] },
  { label: 'St. George UT', bbox: [-113.75, 36.98, -113.45, 37.25] },
];

/** One named trail present in the current viewport, possibly across sources. */
interface InViewGroup {
  name: string;
  totalM: number;
  sources: Set<SourceId>;
  bySource: Map<SourceId, GeoJSON.Feature[]>;
}

/** Build the trails-in-view groups from the loader cache of enabled sources. */
function buildInView(state: Readonly<AppState>): InViewGroup[] {
  const groups = new Map<string, InViewGroup>();
  for (const id of SOURCE_IDS) {
    if (!state.enabled[id]) continue;
    const fc = getCachedFeatures(id);
    if (!fc) continue;
    const nameField = SOURCES[id].nameField;
    for (const f of fc.features) {
      const props = f.properties as Record<string, unknown> | null;
      if (!props) continue;
      const raw = props[nameField];
      if (raw == null || String(raw).trim() === '') continue;
      const name = String(raw);
      const key = normalizeTrailName(name);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) {
        g = { name, totalM: 0, sources: new Set(), bySource: new Map() };
        groups.set(key, g);
      }
      g.sources.add(id);
      const arr = g.bySource.get(id);
      if (arr) arr.push(f);
      else g.bySource.set(id, [f]);
    }
  }
  // A name's mileage is the DOMINANT source's largest spatial cluster: measuring each
  // source separately avoids double-counting the same corridor present in several
  // sources (cross-source sum), and clustering avoids summing same-named but disjoint
  // trails. Matches pickInView, which selects the dominant source.
  const list = [...groups.values()];
  for (const g of list) {
    let best = 0;
    for (const feats of g.bySource.values()) {
      const len = featuresLengthM(clusterSegments(feats));
      if (len > best) best = len;
    }
    g.totalM = best;
  }
  return list.sort((a, b) => b.totalM - a.totalM);
}

function featuresLengthM(features: GeoJSON.Feature[]): number {
  let m = 0;
  for (const f of features) m += featureLengthMeters(f);
  return m;
}

/** Merge a group's cached segments (dominant source wins) and select + fly to it. */
function pickInView(group: InViewGroup, store: Store<AppState>): void {
  let best: { id: SourceId; feats: GeoJSON.Feature[]; len: number } | null = null;
  for (const [id, feats] of group.bySource) {
    let len = 0;
    for (const f of feats) len += featureLengthMeters(f);
    if (!best || len > best.len) best = { id, feats, len };
  }
  if (!best) return;
  // Cluster around the viewport center so same-named disjoint trails don't merge.
  let anchor: [number, number] | undefined;
  try {
    const c = getMap().getCenter();
    anchor = [c.lng, c.lat];
  } catch {
    /* map not ready */
  }
  const { features: clustered, clusterCount } = clusterSegmentsDetailed(best.feats, anchor);
  const merged = mergeSegmentsToFeature(clustered, best.id, group.name);
  if (!merged) return;
  if (clusterCount > 1) {
    (merged.properties as Record<string, unknown>).__other_clusters = clusterCount - 1;
  }
  store.set({ selected: { sourceId: best.id, feature: merged, name: group.name } });
  try {
    flyToTrail(merged);
  } catch {
    /* camera not ready */
  }
}

function inViewRow(group: InViewGroup, store: Store<AppState>): HTMLElement {
  const swatches = h(
    'span.iv-swatches',
    null,
    ...[...group.sources].map((id) =>
      h('span.swatch', { style: `background:${SOURCES[id].color}`, title: SOURCES[id].label }),
    ),
  );
  const row = h('div.iv-row', { role: 'button', tabindex: '0' },
    h('span.iv-name', { title: group.name }, displayTrailName(group.name)),
    swatches,
    h('span.iv-mi', null, fmtDistance(group.totalM, store.get().units)),
  );
  const go = () => pickInView(group, store);
  row.addEventListener('click', go);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go();
    }
  });
  return row;
}

// ============ DISCOVER: places comboboxes (State / Park / Forest) ============

interface ComboOpts {
  /** Button/placeholder label, e.g. "State". */
  label: string;
  /** Lazily resolve the option names (called on first open). */
  load: (signal: AbortSignal) => Promise<string[]>;
  /** Navigate to the picked place. May be async; throw to flag a locate failure. */
  onSelect: (name: string) => void | Promise<void>;
}

/** Imperative handle over a combobox: its element plus scoping controls. */
interface ComboHandle {
  el: HTMLElement;
  /** Drop cached options; if the panel is open, reload now, else reload on next open. */
  reset(): void;
  /** Update the filter input placeholder (used to show the active state scope). */
  setPlaceholder(text: string): void;
}

/**
 * One compact filterable combobox: a chip-styled button that opens a panel with a
 * filter input + scrollable option list. Client-side filtering, keyboard up/down +
 * Enter/ESC, lazy list load with spinner + retry-on-error, and a brief busy/error
 * state on the chip while onSelect runs. Returns an imperative handle.
 *
 * The open panel is a viewport overlay (position: fixed, positioned from the button's
 * rect) so a list wider than the remaining sidebar width overlays the map instead of
 * extending the sidebar's scroll area and h-scrolling it.
 */
function createCombobox(opts: ComboOpts): ComboHandle {
  const lower = opts.label.toLowerCase();
  const btnLabel = h('span.cb-label', null, opts.label);
  const btn = h(
    'button.cb-btn',
    {
      type: 'button',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-label': `Choose ${opts.label}`,
    },
    btnLabel,
    h('span.cb-caret', { 'aria-hidden': 'true' }, '▾'),
  );
  const input = h('input.cb-filter', {
    type: 'text',
    placeholder: `Filter ${lower}…`,
    'aria-label': `Filter ${opts.label}`,
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const listEl = h('div.cb-list', { role: 'listbox', 'aria-label': opts.label });
  const panel = h('div.cb-panel', null, input, listEl);
  panel.hidden = true;
  const wrap = h('div.cb-wrap', null, btn, panel);

  let options: string[] | null = null;
  let loading = false;
  let errored = false;
  let filtered: string[] = [];
  let activeIdx = -1;
  let loadCtrl: AbortController | null = null;
  let errTimer: ReturnType<typeof setTimeout> | null = null;

  const renderList = (): void => {
    listEl.replaceChildren();
    if (loading) {
      listEl.append(h('div.cb-status', null, h('span.spinner'), h('span', null, 'loading…')));
      return;
    }
    if (errored || options === null) {
      const retry = h('button.cb-retry', { type: 'button' }, 'retry');
      retry.addEventListener('click', () => void load());
      listEl.append(h('div.cb-status.err', null, h('span', null, 'failed to load'), retry));
      return;
    }
    const q = input.value.trim().toLowerCase();
    filtered = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    if (filtered.length === 0) {
      listEl.append(h('div.cb-status', null, 'no matches'));
      return;
    }
    filtered.forEach((name, i) => {
      const opt = h(
        'div.cb-opt',
        { role: 'option', 'aria-selected': String(i === activeIdx) },
        name,
      );
      if (i === activeIdx) opt.classList.add('active');
      // mousedown (not click) so it fires before the input blur/close.
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        void choose(name);
      });
      listEl.append(opt);
    });
  };

  const load = async (): Promise<void> => {
    loadCtrl?.abort();
    loadCtrl = new AbortController();
    loading = true;
    errored = false;
    renderList();
    try {
      options = await opts.load(loadCtrl.signal);
      loading = false;
    } catch (err) {
      if (loadCtrl.signal.aborted) return;
      loading = false;
      errored = true;
      options = null;
    }
    activeIdx = -1;
    renderList();
  };

  const move = (delta: number): void => {
    if (filtered.length === 0) return;
    activeIdx = activeIdx < 0 ? 0 : (activeIdx + delta + filtered.length) % filtered.length;
    renderList();
    listEl.querySelector('.cb-opt.active')?.scrollIntoView({ block: 'nearest' });
  };

  const flashError = (): void => {
    wrap.classList.add('cb-error');
    btn.title = `Couldn't locate ${lower}`;
    if (errTimer) clearTimeout(errTimer);
    errTimer = setTimeout(() => {
      wrap.classList.remove('cb-error');
      btn.removeAttribute('title');
    }, 2400);
  };

  const choose = async (name: string): Promise<void> => {
    btnLabel.textContent = name;
    wrap.classList.add('has-value');
    close();
    let ret: void | Promise<void>;
    try {
      ret = opts.onSelect(name);
    } catch {
      flashError();
      return;
    }
    if (ret && typeof (ret as Promise<void>).then === 'function') {
      wrap.classList.add('cb-busy');
      try {
        await ret;
      } catch {
        flashError();
      } finally {
        wrap.classList.remove('cb-busy');
      }
    }
  };

  const onDocDown = (e: MouseEvent): void => {
    // The panel is a viewport overlay (not a descendant of wrap in the layout sense,
    // but still a DOM child), so a click inside it must not close.
    if (!wrap.contains(e.target as Node) && !panel.contains(e.target as Node)) close();
  };

  // Sidebar scroll container we listen on (to close the fixed overlay on scroll).
  let scrollEl: HTMLElement | null = null;
  const onScrollOrResize = (): void => close();

  /** Position the open panel as a fixed viewport overlay under the button. */
  function positionPanel(): void {
    const rect = btn.getBoundingClientRect();
    const width = Math.max(rect.width, 230);
    let left = rect.left;
    // Clamp so the right edge stays within the viewport (Forest sits at the sidebar
    // edge; its list must overlay the map, not clip or scroll off-screen).
    if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
    if (left < 8) left = 8;
    panel.style.top = `${rect.bottom + 3}px`;
    panel.style.left = `${left}px`;
    panel.style.width = `${width}px`;
  }

  function open(): void {
    if (!panel.hidden) return;
    panel.hidden = false;
    positionPanel();
    btn.setAttribute('aria-expanded', 'true');
    wrap.classList.add('cb-open');
    input.value = '';
    activeIdx = -1;
    if (options === null && !loading) void load();
    else renderList();
    requestAnimationFrame(() => input.focus());
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('resize', onScrollOrResize);
    scrollEl = wrap.closest('.sidebar');
    scrollEl?.addEventListener('scroll', onScrollOrResize, { passive: true });
  }

  function close(): void {
    if (panel.hidden) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('cb-open');
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('resize', onScrollOrResize);
    scrollEl?.removeEventListener('scroll', onScrollOrResize);
    scrollEl = null;
  }

  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  input.addEventListener('input', () => {
    activeIdx = -1;
    renderList();
    if (filtered.length) {
      activeIdx = 0;
      renderList();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && filtered[activeIdx]) void choose(filtered[activeIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      btn.focus();
    }
  });

  const reset = (): void => {
    loadCtrl?.abort();
    options = null;
    errored = false;
    loading = false;
    activeIdx = -1;
    filtered = [];
    if (!panel.hidden) void load(); // panel open: refresh in place
  };

  const setPlaceholder = (text: string): void => {
    input.placeholder = text;
  };

  return { el: wrap, reset, setPlaceholder };
}

/** Fit the map to a bbox (pad 40), throwing if the extent is null/map unready. */
function fitBBox(bbox: BBox | null): void {
  if (!bbox) throw new Error('no extent');
  const [w, s, e, n] = bbox;
  getMap().fitBounds(
    [
      [w, s],
      [e, n],
    ],
    { padding: 40 },
  );
}

// "All states" sentinel prepended to the State list to clear the spatial filter.
const ALL_STATES = 'All states';

/** Build the three place comboboxes into #places-row.
 *
 * State selection spatially scopes the Park and Forest lists to that state's bbox
 * (neither service has a reliable state attribute, so we filter by envelope
 * intersection). Border parks/forests appear under both neighboring states — an
 * accepted prototype imperfection since state bboxes overlap. */
function initPlaces(root: HTMLElement): void {
  const row = root.querySelector<HTMLElement>('#places-row');
  if (!row) return;

  // Selected state scopes Park/Forest; null = unfiltered (all states).
  let selectedState: StatePlace | null = null;

  const parkCombo = createCombobox({
    label: 'Park',
    load: (signal) => fetchParkUnits(signal, selectedState?.bbox),
    onSelect: async (name) => fitBBox(await fetchParkExtent(name)),
  });

  const forestCombo = createCombobox({
    label: 'Forest',
    load: (signal) => fetchForests(signal, selectedState?.bbox),
    onSelect: async (name) => fitBBox(await fetchForestExtent(name)),
  });

  // Reflect the active scope in the Park/Forest filter placeholders + drop their
  // cached (previously-scoped) option lists so the next open reloads scoped.
  const applyScope = (): void => {
    const label = selectedState?.name;
    parkCombo.setPlaceholder(label ? `Filter parks in ${label}…` : 'Filter park…');
    forestCombo.setPlaceholder(label ? `Filter forests in ${label}…` : 'Filter forest…');
    parkCombo.reset();
    forestCombo.reset();
  };

  const stateCombo = createCombobox({
    label: 'State',
    load: async () => [ALL_STATES, ...US_STATES.map((s) => s.name)],
    onSelect: (name) => {
      if (name === ALL_STATES) {
        selectedState = null;
        applyScope();
        return; // clearing the filter must NOT move the camera
      }
      selectedState = US_STATES.find((s) => s.name === name) ?? null;
      applyScope();
      fitBBox(selectedState ? selectedState.bbox : null);
    },
  });

  row.append(stateCombo.el, parkCombo.el, forestCombo.el);
}

// ============ DISCOVER: peaks-in-view (collapsible, lazy) ============

function peakRow(peak: Peak, store: Store<AppState>): HTMLElement {
  const ele = peak.ele != null ? fmtElevation(peak.ele, store.get().units) : '—';
  const row = h(
    'div.iv-row',
    { role: 'button', tabindex: '0' },
    h('span.iv-name', { title: peak.name }, peak.name),
    h('span.iv-mi', null, ele),
  );
  const go = (): void => {
    try {
      getMap().flyTo({ center: [peak.lng, peak.lat], zoom: 13.5 });
    } catch {
      /* map not ready */
    }
  };
  row.addEventListener('click', go);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go();
    }
  });
  return row;
}

/** Wire the collapsible "Peaks in view" sub-list. Fetches only while expanded. */
function initPeaks(root: HTMLElement, store: Store<AppState>): void {
  const head = root.querySelector<HTMLElement>('#peaks-head');
  const list = root.querySelector<HTMLElement>('#peaks-list');
  const caret = head?.querySelector<HTMLElement>('.disc-sub-caret');
  if (!head || !list) return;

  let expanded = false;
  let ctrl: AbortController | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let lastPeaks: Peak[] | null = null;

  const render = (peaks: Peak[]): void => {
    lastPeaks = peaks;
    list.replaceChildren();
    if (peaks.length === 0) {
      list.append(h('div.iv-empty', null, 'No named peaks in view'));
      return;
    }
    for (const p of peaks) list.append(peakRow(p, store));
  };

  // Re-render elevations in place when the unit preference changes.
  store.subscribe(['units'], () => {
    if (expanded && lastPeaks && lastPeaks.length) render(lastPeaks);
  });

  const fetchNow = async (): Promise<void> => {
    ctrl?.abort();
    ctrl = new AbortController();
    const mine = ctrl;
    list.replaceChildren(
      h('div.iv-empty', null, h('span.spinner'), h('span', { style: 'margin-left:6px' }, 'loading peaks…')),
    );
    let bbox: BBox;
    try {
      const b = getMap().getBounds();
      bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    } catch {
      return;
    }
    try {
      const peaks = await fetchPeaksInView(bbox, mine.signal);
      if (mine.signal.aborted) return;
      render(peaks);
    } catch (err) {
      if (mine.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      list.replaceChildren(h('div.iv-empty', null, 'Could not load peaks'));
    }
  };

  const onMoveEnd = (): void => {
    if (!expanded) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void fetchNow();
    }, 500);
  };

  const toggle = (): void => {
    expanded = !expanded;
    list.hidden = !expanded;
    head.setAttribute('aria-expanded', String(expanded));
    if (caret) caret.textContent = expanded ? '▾' : '▸';
    if (expanded) {
      getMap().on('moveend', onMoveEnd);
      void fetchNow();
    } else {
      getMap().off('moveend', onMoveEnd);
      ctrl?.abort();
      if (debounce) clearTimeout(debounce);
    }
  };

  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
}

function initDiscover(root: HTMLElement, store: Store<AppState>): void {
  const section = root.querySelector<HTMLElement>('#discover');
  const head = root.querySelector<HTMLElement>('#discover-head');
  const chips = root.querySelector<HTMLElement>('#region-chips');
  const list = root.querySelector<HTMLElement>('#inview-list');
  if (!section || !head || !chips || !list) return;

  initPlaces(root);
  initPeaks(root, store);

  // Region quick-picks → fitBounds.
  for (const region of REGIONS) {
    const chip = h('span.xchip', { role: 'button', tabindex: '0' }, region.label);
    const fit = () => {
      const [w, s, e, n] = region.bbox;
      try {
        getMap().fitBounds([[w, s], [e, n]], { padding: 40 });
      } catch {
        /* map not ready */
      }
    };
    chip.addEventListener('click', fit);
    chip.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        fit();
      }
    });
    chips.append(chip);
  }

  // Collapsible header (open by default).
  const toggle = () => {
    const collapsed = section.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!collapsed));
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  // Reload indicator in the "Trails in view" sub-header: visible whenever any
  // enabled source is fetching, immediate (not debounced), even when the list
  // already has rows from the previous viewport. Anchor to #trails-head
  // specifically — a bare '.disc-sub' matches the static "Quick picks" header first.
  const sub = root.querySelector<HTMLElement>('#trails-head');
  const reloadSpinner = h('span.iv-loading', { 'aria-label': 'Reloading trails in view' }, h('span.spinner'));
  reloadSpinner.hidden = true;
  sub?.append(reloadSpinner);
  const updateLoading = () => {
    const state = store.get();
    const anyLoading = SOURCE_IDS.some(
      (id) =>
        state.enabled[id] &&
        (state.viewport[id].status === 'loading' || state.viewport[id].status === 'idle'),
    );
    reloadSpinner.hidden = !anyLoading;
    list.classList.toggle('reloading', anyLoading);
  };

  // Trails-in-view list, rebuilt (debounced) on loader data changes.
  let showAll = false;
  const render = () => {
    const state = store.get();
    const groups = buildInView(state);
    list.replaceChildren();
    if (groups.length === 0) {
      // Distinguish "still fetching" from a genuinely empty viewport.
      const anyLoading = SOURCE_IDS.some(
        (id) =>
          state.enabled[id] &&
          (state.viewport[id].status === 'loading' || state.viewport[id].status === 'idle'),
      );
      if (anyLoading) {
        list.append(
          h('div.iv-empty', null, h('span.spinner'), h('span', { style: 'margin-left:6px' }, 'loading trails…')),
        );
      } else {
        list.append(h('div.iv-empty', null, 'No named trails in view yet'));
      }
      return;
    }
    const limit = showAll ? INVIEW_MAX : INVIEW_TOP;
    for (const g of groups.slice(0, limit)) list.append(inViewRow(g, store));
    if (!showAll && groups.length > INVIEW_TOP) {
      const more = h('button.iv-more', null, `show more (${Math.min(groups.length, INVIEW_MAX) - INVIEW_TOP})`);
      more.addEventListener('click', () => {
        showAll = true;
        render();
      });
      list.append(more);
    }
  };

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const scheduleRender = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      render();
    }, 300);
  };
  store.subscribe(['viewport', 'enabled'], () => {
    updateLoading();
    scheduleRender();
  });
  // Unit changes re-render the mileage column immediately (no debounce).
  store.subscribe(['units'], render);
  updateLoading();
  render();
}

function buildRack(root: HTMLElement, store: Store<AppState>): void {
  const rack = root.querySelector<HTMLElement>('#source-rack');
  if (!rack) return;
  rack.replaceChildren();

  const refs: Record<string, RowRefs> = {};

  for (const id of SOURCE_IDS) {
    const def = SOURCES[id];
    const checkbox = h('input', {
      type: 'checkbox',
      'aria-label': `Toggle ${def.label}`,
    }) as HTMLInputElement;

    const stats = h('span.stats');
    const swatch = h('span.swatch', { style: `background:${def.color}` });
    const name = h('span.name', {
      title: `About ${def.label}`,
      role: 'button',
      tabindex: '0',
    }, def.label);
    const lic = h(`span.lic.${LIC_CLASS[def.licenseChip] || 'pd'}`, null, def.licenseChip);
    const info = h('button.info-btn', { 'aria-label': `About ${def.label}` }, 'i');

    const openDossier = () => store.set({ dossierOpen: id });
    name.addEventListener('click', openDossier);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDossier();
      }
    });
    info.addEventListener('click', openDossier);

    checkbox.addEventListener('change', () => {
      store.set({ enabled: { ...store.get().enabled, [id]: checkbox.checked } });
    });

    const row = h('div.source', { dataset: { source: id } },
      checkbox, swatch, name, lic, info, stats,
    );
    rack.append(row);
    refs[id] = { row, checkbox, stats };
  }

  const render = (state: Readonly<AppState>) => {
    for (const id of SOURCE_IDS) {
      const r = refs[id];
      const on = state.enabled[id];
      r.checkbox.checked = on;
      r.row.classList.toggle('off', !on);
      r.row.classList.toggle('active', state.dossierOpen === id);
      r.stats.replaceChildren(...statsChildren(state, id).filter((n): n is Node => n != null));
    }
  };

  store.subscribe(['enabled', 'viewport', 'dossierOpen'], render);
  render(store.get());
}

function wireControls(root: HTMLElement, store: Store<AppState>): void {
  // Basemap segmented control
  const seg = root.querySelector<HTMLElement>('#basemap-seg');
  const segButtons = seg ? Array.from(seg.querySelectorAll<HTMLButtonElement>('button')) : [];
  for (const btn of segButtons) {
    btn.addEventListener('click', () => {
      const bm = btn.dataset.basemap as AppState['basemap'] | undefined;
      if (bm) store.set({ basemap: bm });
    });
  }

  // Units segmented control (MI·FT | KM·M)
  const unitsSeg = root.querySelector<HTMLElement>('#units-seg');
  const unitsButtons = unitsSeg ? Array.from(unitsSeg.querySelectorAll<HTMLButtonElement>('button')) : [];
  for (const btn of unitsButtons) {
    btn.addEventListener('click', () => {
      const u = btn.dataset.units as AppState['units'] | undefined;
      if (u) store.set({ units: u });
    });
  }

  // 3D terrain toggle
  const toggle3d = root.querySelector<HTMLButtonElement>('#toggle-3d');
  toggle3d?.addEventListener('click', () => store.set({ terrain3d: !store.get().terrain3d }));

  // Hillshade toggle
  const toggleHs = root.querySelector<HTMLButtonElement>('#toggle-hillshade');
  toggleHs?.addEventListener('click', () => store.set({ hillshade: !store.get().hillshade }));

  // Exaggeration range
  const exag = root.querySelector<HTMLInputElement>('#exaggeration');
  const exagVal = root.querySelector<HTMLElement>('#exaggeration-val');
  exag?.addEventListener('input', () => store.set({ exaggeration: Number(exag.value) }));

  const render = (state: Readonly<AppState>) => {
    for (const btn of segButtons) {
      btn.classList.toggle('on', btn.dataset.basemap === state.basemap);
    }
    for (const btn of unitsButtons) {
      btn.classList.toggle('on', btn.dataset.units === state.units);
    }
    if (toggle3d) {
      toggle3d.classList.toggle('on', state.terrain3d);
      toggle3d.setAttribute('aria-label', state.terrain3d ? '3D terrain on' : '3D terrain off');
    }
    if (toggleHs) {
      toggleHs.classList.toggle('on', state.hillshade);
      toggleHs.setAttribute('aria-label', state.hillshade ? 'Hillshade on' : 'Hillshade off');
    }
    if (exag) {
      exag.disabled = !state.terrain3d;
      if (Number(exag.value) !== state.exaggeration) exag.value = String(state.exaggeration);
    }
    if (exagVal) exagVal.textContent = `${state.exaggeration.toFixed(1)}×`;
  };

  store.subscribe(['basemap', 'terrain3d', 'hillshade', 'exaggeration', 'units'], render);
  render(store.get());
}
