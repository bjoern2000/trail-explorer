// Segment-merge page — a long-form explainer document.
//
// Audience: TWC's technical PM and a research scientist. The page reads top to bottom
// as prose, with a map figure at every step that the reader can pan and zoom, the
// numbers underneath each figure, and the GeoJSON one disclosure away.
//
// It does not describe the algorithm; it runs the shipped one. Every count, length and
// part number is computed at load by pipeline.ts calling src/data/merge.ts — the same
// functions search.ts and sidebar.ts call when a user picks a search result.
//
// Each step is illustrated by whichever worked example actually exercises it: Bear Lake
// is clean, so the clustering step borrows a statewide search and the chaining step
// borrows a heavily fragmented Adirondack trail. Figures are lazily created when they
// scroll into view — there are nine maps on the page.

import '../tokens.css';
import './merge.css';

import { mountNav } from '../ui/nav';
import { h, fmtNumber } from '../ui/dom';
import { EXAMPLES, readUnits, type Example, type FixtureWay } from './model';
import { runPipeline, stageGeoJSON, lengthOf, type PipelineResult, type StageId } from './pipeline';
import { MergeMap, type BBox } from './mmap';
import { CHAIN_TOLERANCE_M, CLUSTER_GAP_M } from '../data/merge';

const units = readUnits();

/**
 * Lengths here span 10 m stubs to 12 km trails, and the shared fmtDistance renders a
 * 10 m stub as "0.0 km". Below a kilometre this page shows metres (or feet).
 */
function fmtLen(meters: number): string {
  if (units === 'metric') {
    return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
  }
  const miles = meters / 1609.344;
  return miles < 0.5 ? `${fmtNumber(Math.round(meters * 3.28084))} ft` : `${miles.toFixed(1)} mi`;
}

// ---- palettes ----------------------------------------------------------------

const CATEGORICAL = ['#d93a52', '#2277cc', '#1f8f55', '#7757e0', '#d07e00', '#0e9c97', '#b23a2e', '#5c6a60'];
// Stage 4 draws green start / red finish markers, so its line palette excludes both:
// a green line beside a green dot reads as one thing.
const CHAIN_PALETTE = ['#2277cc', '#7757e0', '#d07e00', '#0e9c97', '#5c6a60', '#a35e00', '#2b6bb0'];
const DROPPED_COLOR = '#5c6a60';
const KEPT_COLOR = '#d93a52';
const START_COLOR = '#1a7a45';
const FINISH_COLOR = '#b23a2e';

const color = (i: number): string => CATEGORICAL[i % CATEGORICAL.length];
const chainColor = (i: number): string => CHAIN_PALETTE[i % CHAIN_PALETTE.length];

// ---- per-example pipeline state ------------------------------------------------
// Results are memoised per example. "Run live" replaces one example's input elements
// and invalidates just that entry, so the figures using it re-render.

const liveInput = new Map<string, { elements: FixtureWay[]; at: string }>();
const results = new Map<string, PipelineResult>();

function ex(id: string): Example {
  const e = EXAMPLES.find((x) => x.fixture.id === id);
  if (!e) throw new Error(`unknown example '${id}'`);
  return e;
}

function resultFor(id: string): PipelineResult {
  const cached = results.get(id);
  if (cached) return cached;
  const example = ex(id);
  const live = liveInput.get(id);
  const r = runPipeline(live ? live.elements : example.fixture.elements, example.fixture.trailName);
  results.set(id, r);
  return r;
}

// ---- figures -------------------------------------------------------------------

interface Figure {
  exampleId: string;
  stage: StageId;
  mapHost: HTMLElement;
  legendHost: HTMLElement;
  statsHost: HTMLElement;
  gjHost: HTMLElement;
  map: MergeMap | null;
}

const figures: Figure[] = [];

function stageFeatures(r: PipelineResult, s: StageId): GeoJSON.Feature[] {
  const paint = (f: GeoJSON.Feature, props: Record<string, unknown>): GeoJSON.Feature => ({
    ...f,
    properties: { ...(f.properties ?? {}), ...props },
  });
  switch (s) {
    case 'raw':
      return r.groups.flatMap((g, gi) =>
        g.features.map((f) => paint(f, { __color: color(gi), __key: `g${gi}` })),
      );
    case 'named':
      return [
        ...r.dropped.map((f) =>
          paint(f, { __color: DROPPED_COLOR, __faded: true, __dashed: true, __key: 'dropped' }),
        ),
        ...r.kept.map((f) => paint(f, { __color: KEPT_COLOR, __key: 'kept' })),
      ];
    case 'clustered':
      return r.clusters.flatMap((c, ci) =>
        c.features.map((f) =>
          paint(f, {
            __color: ci === r.chosenCluster ? KEPT_COLOR : color(ci + 1),
            __faded: ci !== r.chosenCluster,
            __key: ci === r.chosenCluster ? 'kept' : `c${ci}`,
          }),
        ),
      );
    case 'chained':
      return r.chainFeatures.map((f, i) => paint(f, { __color: chainColor(i), __key: `ch${i}` }));
    case 'merged':
      return r.merged ? [paint(r.merged, { __color: KEPT_COLOR, __key: 'merged' })] : [];
  }
}

function stageEnds(r: PipelineResult, s: StageId): { lng: number; lat: number; color: string }[] {
  const parts: number[][][] = [];
  if (s === 'chained') parts.push(...r.chains.map((c) => c.coords));
  else if (s === 'merged' && r.merged) {
    const g = r.merged.geometry;
    if (g.type === 'LineString') parts.push(g.coordinates);
    else if (g.type === 'MultiLineString') parts.push(...g.coordinates);
  }
  const out: { lng: number; lat: number; color: string }[] = [];
  for (const p of parts) {
    if (p.length < 2) continue;
    out.push({ lng: p[0][0], lat: p[0][1], color: START_COLOR });
    out.push({ lng: p[p.length - 1][0], lat: p[p.length - 1][1], color: FINISH_COLOR });
  }
  return out;
}

function spanOf(features: GeoJSON.Feature[]): number {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const f of features) {
    const g = f.geometry;
    const parts =
      g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
    for (const p of parts) {
      for (const c of p) {
        if (c[0] < w) w = c[0];
        if (c[0] > e) e = c[0];
        if (c[1] < s) s = c[1];
        if (c[1] > n) n = c[1];
      }
    }
  }
  return e >= w ? Math.max(e - w, n - s) : 0;
}

function midpoint(f: GeoJSON.Feature): [number, number] | null {
  const g = f.geometry;
  const parts =
    g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
  const p = parts[0];
  if (!p || p.length === 0) return null;
  const c = p[Math.floor(p.length / 2)];
  return [c[0], c[1]];
}

/** A 1 km trail is sub-pixel on a statewide view, so wide figures get locator dots. */
const WIDE_SPAN_DEG = 0.6;

function markersFor(
  r: PipelineResult,
  s: StageId,
  feats: GeoJSON.Feature[],
): { lng: number; lat: number; color: string; faded?: boolean }[] {
  if (spanOf(feats) < WIDE_SPAN_DEG) return [];
  if (s === 'clustered') {
    return r.clusters.map((c, ci) => ({
      lng: (c.bbox[0] + c.bbox[2]) / 2,
      lat: (c.bbox[1] + c.bbox[3]) / 2,
      color: ci === r.chosenCluster ? KEPT_COLOR : color(ci + 1),
      faded: ci !== r.chosenCluster,
      key: ci === r.chosenCluster ? 'kept' : `c${ci}`,
    }));
  }
  const out: { lng: number; lat: number; color: string; faded?: boolean; key?: string }[] = [];
  for (const f of feats) {
    const mid = midpoint(f);
    if (!mid) continue;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    out.push({
      lng: mid[0],
      lat: mid[1],
      color: typeof props.__color === 'string' ? props.__color : KEPT_COLOR,
      faded: props.__faded === true,
      key: typeof props.__key === 'string' ? props.__key : '',
    });
  }
  return out;
}

interface LegendItem {
  label: string;
  color: string;
  /** Matches the `__key` on the features this row stands for. */
  key: string;
}

function legendItems(r: PipelineResult, s: StageId, e: Example): LegendItem[] {
  switch (s) {
    case 'raw':
      return r.groups.map((g, gi) => ({
        label: `${g.name} · ${g.features.length}`,
        color: color(gi),
        key: `g${gi}`,
      }));
    case 'named':
      return [
        { label: `Kept · ${e.fixture.trailName}`, color: KEPT_COLOR, key: 'kept' },
        ...(r.dropped.length
          ? [{ label: `Dropped · ${r.dropped.length} ways`, color: DROPPED_COLOR, key: 'dropped' }]
          : []),
      ];
    case 'clustered':
      return [
        { label: 'Cluster kept', color: KEPT_COLOR, key: 'kept' },
        ...r.clusters
          .map((c, ci) => ({ c, ci }))
          .filter(({ ci }) => ci !== r.chosenCluster)
          .map(({ c, ci }) => ({
            label: `Discarded · ${c.features.length} ways`,
            color: color(ci + 1),
            key: `c${ci}`,
          })),
      ];
    case 'chained':
      return [
        ...r.chains.map((c, i) => ({
          label: `Chain ${i + 1} · ${c.members.length} seg`,
          color: chainColor(i),
          key: `ch${i}`,
        })),
        { label: 'Start', color: START_COLOR, key: '' },
        { label: 'Finish', color: FINISH_COLOR, key: '' },
      ];
    case 'merged':
      return [
        { label: 'Merged trail', color: KEPT_COLOR, key: 'merged' },
        { label: 'Start of a part', color: START_COLOR, key: '' },
        { label: 'End of a part', color: FINISH_COLOR, key: '' },
      ];
  }
}

/** Per-stage numbers, rendered as a small definition grid under the figure. */
function statsFor(r: PipelineResult, s: StageId): HTMLElement {
  const rows: [string, string][] = [];
  switch (s) {
    case 'raw':
      rows.push(['Ways returned', fmtNumber(r.raw.length)]);
      rows.push(['Distinct names', fmtNumber(r.groups.length)]);
      rows.push(['Total length', fmtLen(lengthOf(r.raw))]);
      break;
    case 'named':
      rows.push(['Kept', `${r.kept.length} ways`]);
      rows.push(['Dropped', `${r.dropped.length} ways`]);
      rows.push(['Kept length', fmtLen(lengthOf(r.kept))]);
      break;
    case 'clustered':
      rows.push(['Clusters', fmtNumber(r.clusters.length)]);
      rows.push(['Ways kept', fmtNumber(r.clusterFeatures.length)]);
      rows.push(['Kept length', fmtLen(lengthOf(r.clusterFeatures))]);
      break;
    case 'chained': {
      const flips = r.chains.reduce((n, c) => n + c.flipped.filter(Boolean).length, 0);
      rows.push(['Segments in', fmtNumber(r.clusterFeatures.length)]);
      rows.push(['Chains out', fmtNumber(r.chains.length)]);
      rows.push(['Segments reversed', fmtNumber(flips)]);
      break;
    }
    case 'merged': {
      const m = r.merged;
      if (!m) {
        rows.push(['Result', 'nothing to merge']);
        break;
      }
      const props = m.properties as Record<string, unknown>;
      rows.push(['Geometry', m.geometry.type]);
      rows.push(['Parts', fmtNumber(Number(props.__parts))]);
      rows.push(['Length', fmtLen(lengthOf([m]))]);
      break;
    }
  }
  return h(
    'div',
    { class: 'fig-stats' },
    ...rows.map(([k, v]) =>
      h('div', { class: 'fs-item' }, h('span', { class: 'fs-k' }, k), h('span', { class: 'fs-v' }, v)),
    ),
  );
}

const MAX_GJ_CHARS = 120_000;

function renderGeoJSON(host: HTMLElement, r: PipelineResult, s: StageId): void {
  const gj = stageGeoJSON(r, s);
  const text = JSON.stringify(gj, null, 2);
  const count = 'features' in gj ? gj.features.length : 1;
  const truncated = text.length > MAX_GJ_CHARS;
  host.replaceChildren(
    h(
      'summary',
      {},
      'GeoJSON at this step',
      h('span', { class: 'gj-meta' }, `${count} feature${count === 1 ? '' : 's'} · ${fmtNumber(Math.round(text.length / 1024))} KB`),
    ),
    h(
      'div',
      { class: 'gj-body' },
      h(
        'button',
        {
          class: 'doc-btn gj-copy',
          type: 'button',
          onclick: () => void copyText(text, 'GeoJSON'),
        },
        'COPY',
      ),
      h(
        'pre',
        { class: 'code' },
        truncated ? text.slice(0, MAX_GJ_CHARS) + '\n… truncated for display; COPY returns the full document.' : text,
      ),
    ),
  );
}

function renderFigure(fig: Figure): void {
  const r = resultFor(fig.exampleId);
  const e = ex(fig.exampleId);
  const feats = stageFeatures(r, fig.stage);

  fig.legendHost.replaceChildren(
    ...legendItems(r, fig.stage, e).map((item) => {
      const row = h(
        'span',
        {
          class: 'leg-item' + (item.key ? ' hoverable' : ''),
          ...(item.key ? { tabindex: '0' } : {}),
        },
        h('span', { class: 'dot', style: `background:${item.color}` }),
        item.label,
      );
      if (item.key) {
        const on = (): void => fig.map?.setHighlight(item.key);
        const off = (): void => fig.map?.setHighlight(null);
        row.addEventListener('mouseenter', on);
        row.addEventListener('mouseleave', off);
        row.addEventListener('focus', on);
        row.addEventListener('blur', off);
      }
      return row;
    }),
  );
  fig.statsHost.replaceChildren(statsFor(r, fig.stage));
  if (fig.gjHost.hasAttribute('open')) renderGeoJSON(fig.gjHost, r, fig.stage);
  else fig.gjHost.replaceChildren(h('summary', {}, 'GeoJSON at this step'));

  if (fig.map) {
    fig.map.setFeatures(feats);
    fig.map.setEnds(stageEnds(r, fig.stage));
    fig.map.setMarkers(markersFor(r, fig.stage, feats));
    // Steps 1–3 are comparisons, so what was dropped stays in frame; 4–5 are results.
    const compare = fig.stage === 'raw' || fig.stage === 'named' || fig.stage === 'clustered';
    const fitTo = compare
      ? feats
      : feats.filter((f) => !(f.properties as Record<string, unknown>)?.__faded);
    fig.map.fitTo(fitTo.length ? fitTo : feats, 40);
  }
}

function ensureFigureMap(fig: Figure): void {
  if (fig.map) return;
  fig.map = new MergeMap(fig.mapHost, ex(fig.exampleId).fixture.bbox as BBox, { onPick: () => undefined });
  renderFigure(fig);
}

/** Build one figure: label strip, map, legend, numbers, GeoJSON disclosure, caption. */
function figure(exampleId: string, stage: StageId, caption: string, tall = false): HTMLElement {
  const e = ex(exampleId);
  const mapHost = h('div', { class: 'fig-map' + (tall ? ' tall' : '') });
  const legendHost = h('div', { class: 'fig-legend' });
  const statsHost = h('div', { class: 'fig-stats-wrap' });
  const gjHost = h('details', { class: 'fig-gj' }) as HTMLDetailsElement;

  const fig: Figure = { exampleId, stage, mapHost, legendHost, statsHost, gjHost, map: null };
  figures.push(fig);

  gjHost.addEventListener('toggle', () => {
    if (gjHost.open) renderGeoJSON(gjHost, resultFor(exampleId), stage);
  });

  const el = h(
    'figure',
    { class: 'fig' },
    h(
      'div',
      { class: 'fig-head' },
      h('span', { class: 'fig-ex' }, e.label),
      h('span', { class: 'fig-where' }, e.where),
      h('span', { class: 'fig-src' }, liveInput.has(exampleId) ? 'LIVE' : `SNAPSHOT ${e.fixture.fetchedAt}`),
    ),
    mapHost,
    legendHost,
    statsHost,
    h('figcaption', {}, caption),
    gjHost,
  );

  // Nine maps on one page: only build one when it is close to the viewport.
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          ensureFigureMap(fig);
          io.disconnect();
        }
      }
    },
    { rootMargin: '500px' },
  );
  io.observe(el);
  return el;
}

// ---- the request block ---------------------------------------------------------

function queryBlock(exampleId: string): HTMLElement {
  const e = ex(exampleId);
  const badge = h('span', { class: 'q-badge' }, `SNAPSHOT · ${e.fixture.fetchedAt}`);
  const note = h('div', { class: 'q-note' });
  const runBtn = h('button', { class: 'doc-btn', type: 'button' }, 'RUN LIVE') as HTMLButtonElement;

  runBtn.addEventListener('click', () => {
    void runLive(exampleId, badge, note, runBtn);
  });

  return h(
    'div',
    { class: 'qblock' },
    h('pre', { class: 'code' }, e.fixture.query),
    h(
      'div',
      { class: 'q-actions' },
      badge,
      h('button', { class: 'doc-btn', type: 'button', onclick: () => void copyText(e.fixture.query, 'query') }, 'COPY QUERY'),
      runBtn,
    ),
    note,
  );
}

async function runLive(
  exampleId: string,
  badge: HTMLElement,
  note: HTMLElement,
  btn: HTMLButtonElement,
): Promise<void> {
  const e = ex(exampleId);
  note.textContent = 'Querying Overpass…';
  btn.disabled = true;
  try {
    const resp = await fetch('/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: e.fixture.query }),
    });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const json = (await resp.json()) as { elements?: unknown[] };
    const ways = (json.elements ?? []).filter(
      (el): el is FixtureWay =>
        !!el && (el as FixtureWay).type === 'way' && Array.isArray((el as FixtureWay).geometry),
    );
    if (ways.length === 0) throw new Error('the live query returned no ways');
    const at = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    liveInput.set(exampleId, { elements: ways, at });
    results.delete(exampleId);
    badge.textContent = `LIVE · ${at}`;
    badge.classList.add('live');
    const delta = ways.length - e.fixture.wayCount;
    note.textContent =
      delta === 0
        ? `Live query returned ${ways.length} ways, identical to the snapshot. Every figure below has been recomputed from it.`
        : `Live query returned ${ways.length} ways (${delta > 0 ? '+' : ''}${delta} vs the snapshot). Every figure below has been recomputed from it.`;
    for (const fig of figures) {
      if (fig.exampleId === exampleId) {
        const src = fig.mapHost.parentElement?.querySelector('.fig-src');
        if (src) src.textContent = 'LIVE';
        renderFigure(fig);
      }
    }
  } catch (err) {
    note.textContent = `Live query failed: ${(err as Error).message}. The frozen snapshot is still shown.`;
  } finally {
    btn.disabled = false;
  }
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash(`${what} copied`);
  } catch {
    flash('Copy failed — select the text manually');
  }
}

let flashTimer: number | undefined;
function flash(msg: string): void {
  let el = document.getElementById('doc-flash');
  if (!el) {
    el = h('div', { class: 'doc-flash', id: 'doc-flash' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('on');
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => el?.classList.remove('on'), 2200);
}

// ---- prose helpers --------------------------------------------------------------

const p = (...children: (string | Node)[]): HTMLElement => h('p', {}, ...children);
const strong = (t: string): HTMLElement => h('strong', {}, t);
const em = (t: string): HTMLElement => h('em', {}, t);
const code = (t: string): HTMLElement => h('code', {}, t);
const ul = (...items: string[]): HTMLElement => h('ul', {}, ...items.map((t) => h('li', {}, t)));
const ol = (...items: string[]): HTMLElement => h('ol', {}, ...items.map((t) => h('li', {}, t)));

interface SectionSpec {
  id: string;
  kicker: string;
  title: string;
  body: (HTMLElement | string)[];
}

function section(spec: SectionSpec): HTMLElement {
  return h(
    'section',
    { class: 'sec', id: spec.id },
    h('div', { class: 'sec-kicker' }, spec.kicker),
    h('h2', {}, spec.title),
    ...spec.body,
  );
}

/** The at-a-glance table: every example, what went in, what came out. */
function summaryTable(): HTMLElement {
  const head = h(
    'tr',
    {},
    h('th', {}, 'Trail'),
    h('th', { class: 'num' }, 'Ways returned'),
    h('th', { class: 'num' }, 'Names'),
    h('th', { class: 'num' }, 'Kept'),
    h('th', { class: 'num' }, 'Clusters'),
    h('th', { class: 'num' }, 'Parts out'),
    h('th', { class: 'num' }, 'Length'),
  );
  const rows = EXAMPLES.map((e) => {
    const r = resultFor(e.fixture.id);
    const parts = r.merged
      ? r.merged.geometry.type === 'LineString'
        ? 1
        : (r.merged.geometry as GeoJSON.MultiLineString).coordinates.length
      : 0;
    return h(
      'tr',
      {},
      h('td', {}, h('span', { class: 'tbl-name' }, e.label), h('span', { class: 'tbl-where' }, e.where)),
      h('td', { class: 'num' }, String(r.raw.length)),
      h('td', { class: 'num' }, String(r.groups.length)),
      h('td', { class: 'num' }, String(r.kept.length)),
      h('td', { class: 'num' }, String(r.clusters.length)),
      h('td', { class: 'num' + (parts > 1 ? ' warn' : '') }, String(parts)),
      h('td', { class: 'num' }, r.merged ? fmtLen(lengthOf([r.merged])) : '—'),
    );
  });
  return h(
    'div',
    { class: 'tbl-wrap' },
    h('table', { class: 'tbl' }, h('thead', {}, head), h('tbody', {}, ...rows)),
  );
}

/** Name breakdown for the "what comes back" step. */
function nameTable(exampleId: string): HTMLElement {
  const r = resultFor(exampleId);
  return h(
    'div',
    { class: 'tbl-wrap' },
    h(
      'table',
      { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name as OSM carries it'), h('th', { class: 'num' }, 'Ways'), h('th', {}, ''))),
      h(
        'tbody',
        {},
        ...r.groups.map((g, gi) =>
          h(
            'tr',
            { class: g.target ? 'is-target' : '' },
            h('td', {}, h('span', { class: 'dot', style: `background:${color(gi)}` }), g.name),
            h('td', { class: 'num' }, String(g.features.length)),
            h('td', { class: 'tbl-tag' }, g.target ? 'kept' : 'dropped'),
          ),
        ),
      ),
    ),
  );
}

/** Cluster breakdown for the geography step. */
function clusterTable(exampleId: string): HTMLElement {
  const r = resultFor(exampleId);
  return h(
    'div',
    { class: 'tbl-wrap' },
    h(
      'table',
      { class: 'tbl' },
      h(
        'thead',
        {},
        h('tr', {}, h('th', {}, 'Cluster centre'), h('th', { class: 'num' }, 'Ways'), h('th', { class: 'num' }, 'Length'), h('th', {}, '')),
      ),
      h(
        'tbody',
        {},
        ...r.clusters.map((c, ci) => {
          const chosen = ci === r.chosenCluster;
          return h(
            'tr',
            { class: chosen ? 'is-target' : '' },
            h(
              'td',
              {},
              h('span', { class: 'dot', style: `background:${chosen ? KEPT_COLOR : color(ci + 1)}` }),
              `${((c.bbox[1] + c.bbox[3]) / 2).toFixed(3)}, ${((c.bbox[0] + c.bbox[2]) / 2).toFixed(3)}`,
            ),
            h('td', { class: 'num' }, String(c.features.length)),
            h('td', { class: 'num' }, fmtLen(c.lengthM)),
            h('td', { class: 'tbl-tag' }, chosen ? 'kept' : 'discarded'),
          );
        }),
      ),
    ),
  );
}

/** Chain breakdown for the joining step. */
function chainTable(exampleId: string): HTMLElement {
  const r = resultFor(exampleId);
  return h(
    'div',
    { class: 'tbl-wrap' },
    h(
      'table',
      { class: 'tbl' },
      h(
        'thead',
        {},
        h('tr', {}, h('th', {}, 'Chain'), h('th', { class: 'num' }, 'Segments'), h('th', { class: 'num' }, 'Reversed'), h('th', { class: 'num' }, 'Length')),
      ),
      h(
        'tbody',
        {},
        ...r.chains.map((c, i) => {
          const len = (r.chainFeatures[i].properties as Record<string, number>).__lengthM;
          return h(
            'tr',
            {},
            h('td', {}, h('span', { class: 'dot', style: `background:${chainColor(i)}` }), `Chain ${i + 1}`),
            h('td', { class: 'num' }, String(c.members.length)),
            h('td', { class: 'num' }, String(c.flipped.filter(Boolean).length)),
            h('td', { class: 'num' }, fmtLen(len)),
          );
        }),
      ),
    ),
  );
}

/** The merged feature's carried-through properties. */
function propsBlock(exampleId: string): HTMLElement {
  const r = resultFor(exampleId);
  const props = (r.merged?.properties ?? {}) as Record<string, unknown>;
  return h('pre', { class: 'code' }, JSON.stringify(props, null, 2));
}

// ---- the document ----------------------------------------------------------------

const ENDPOINT = 'https://overpass-api.de/api/interpreter';

function buildDoc(): HTMLElement[] {
  const bear = 'bear-lake';
  const nature = 'nature-trail';
  const vh = 'van-hoevenberg';
  const rocky = 'rocky-top';
  const longs = 'longs-peak';

  const rBear = resultFor(bear);
  const rVh = resultFor(vh);
  const rNature = resultFor(nature);
  const rLongs = resultFor(longs);
  const vhFlips = rVh.chains.reduce((n, c) => n + c.flipped.filter(Boolean).length, 0);
  const vhStubs = rVh.chains.filter((c) => c.members.length === 1).length;

  const header = h(
    'header',
    { class: 'doc-head' },
    h('div', { class: 'doc-kicker' }, 'TrailScope · open trail data evaluation'),
    h('h1', {}, 'How a trail search becomes one trail'),
    h(
      'p',
      { class: 'lede' },
      'OpenStreetMap stores way fragments, not trails. A trail is whatever a name is shared by. Five steps turn one search into one route. Three of them can leave it in pieces, for three different reasons.',
    ),
    h(
      'div',
      { class: 'doc-meta' },
      h('div', {}, h('span', {}, 'Endpoint'), ENDPOINT),
      h('div', {}, h('span', {}, 'Snapshots'), EXAMPLES[0].fixture.fetchedAt),
    ),
  );

  const tldr = h(
    'div',
    { class: 'tldr' },
    h('div', { class: 'tldr-head' }, 'TLDR'),
    ul(
      'Open map data does not store trails. It stores short pieces of line, and a trail is however many of those pieces happen to share a name.',
      `Stitching them back together works well on ordinary trails. A search for Bear Lake returns ${rBear.raw.length} pieces and comes out as one ${fmtLen(lengthOf(rBear.merged ? [rBear.merged] : []))} path.`,
      'When a trail comes back in more than one piece there are three reasons. Two are correct: the trail really does branch, or there is a real gap in the map. The third is a flaw in our stitching, and it is fixable.',
      'Some routes cannot be stitched at all. What hikers call "Longs Peak via the Keyhole" is recorded under seven separate names, so there is nothing to match on. That is a naming problem, not a mapping one.',
      'The free map service this page queries is fine for a prototype. A real product would need its own copy of the map data.',
    ),
  );

  const sections = [
    section({
      id: 'problem',
      kicker: 'Context',
      title: 'What OpenStreetMap stores',
      body: [
        p(
          'OSM has no trail object. It stores ',
          em('ways'),
          ': line fragments, each with its own tags. One trail is split at tag changes, bridges, surface changes, or wherever a mapper stopped drawing.',
        ),
        ul(
          'Fragments of one trail usually share a name, but not always.',
          'One path can carry different names along its length.',
          'Unrelated trails in different places carry identical names.',
        ),
        p(
          'A route, its length, and any forecast attached to it therefore require deciding which fragments are one trail and joining them in order. That is the merge. Applied to five real searches:',
        ),
        summaryTable(),
      ],
    }),

    section({
      id: 'rules',
      kicker: 'The logic',
      title: 'Three rules',
      body: [
        p('The merge is three rules applied in sequence, then a join.'),
        h(
          'div',
          { class: 'tbl-wrap' },
          h(
            'table',
            { class: 'tbl' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Rule'), h('th', {}, 'Value'), h('th', {}, 'If you moved it'))),
            h(
              'tbody',
              {},
              h(
                'tr',
                {},
                h('td', {}, 'Name match'),
                h('td', {}, 'exact, after lowercase and whitespace collapse'),
                h('td', {}, 'Looser merges trails that share a prefix.'),
              ),
              h(
                'tr',
                {},
                h('td', {}, 'Cluster gap'),
                h('td', {}, `${CLUSTER_GAP_M} m between bounding boxes`),
                h('td', {}, 'Smaller splits long trails at their gaps; larger merges distinct trails in one valley.'),
              ),
              h(
                'tr',
                {},
                h('td', {}, 'Join tolerance'),
                h('td', {}, `${CHAIN_TOLERANCE_M} m between endpoints`),
                h('td', {}, 'Smaller leaves trails in pieces at source seams; larger bridges trails that merely pass close.'),
              ),
            ),
          ),
        ),
        ol(
          'Query the API for named footpath ways in a bounding box.',
          'Bucket by name, keep one bucket.',
          'Split that bucket into spatially separate clusters, keep one.',
          'Walk the cluster head to tail into continuous chains.',
          'Emit one feature: LineString if one chain, MultiLineString if more.',
        ),
        p(
          'All three rules live in ',
          code('src/data/merge.ts'),
          ', the code this page runs to produce every number below.',
        ),
      ],
    }),

    section({
      id: 'request',
      kicker: 'Step 0',
      title: 'The request',
      body: [
        p(
          'One Overpass query: ways tagged ',
          code('path'),
          ', ',
          code('footway'),
          ' or ',
          code('track'),
          ' whose name contains the search term, inside a bounding box. Identical to the map explorer\'s filter.',
        ),
        queryBlock(bear),
        p(
          'Responses are cached so the page reads the same for everyone. ',
          strong('Run live'),
          ' re-issues this query and recomputes every figure below.',
        ),
      ],
    }),

    section({
      id: 'returns',
      kicker: 'Step 1',
      title: 'What comes back',
      body: [
        p(
          '"Bear Lake" in Rocky Mountain National Park returns ',
          strong(`${rBear.raw.length} ways under ${rBear.groups.length} names`),
          '. One name is the trail meant; the rest are a stock trail, an old road, and two routes named after the junctions they connect.',
        ),
        figure(bear, 'raw', 'Every returned way, coloured by name. Hover a legend row to isolate it. The trail is the small loop at bottom left.'),
      ],
    }),

    section({
      id: 'keep',
      kicker: 'Step 2',
      title: 'Keep one trail',
      body: [
        p(
          'Ways are bucketed by name; one bucket is kept. Names are normalised for case and spacing only. No stemming, no fuzzy matching, no dropping the word "Trail".',
        ),
        p(
          'Strict by design: "Bear Lake Stock Trail" is a horse route on different ground, and merging it would produce a route that does not exist, with a length and elevation profile to match.',
        ),
        figure(bear, 'named', `${rBear.kept.length} kept, ${rBear.dropped.length} dropped and drawn dashed.`),
        nameTable(bear),
      ],
    }),

    section({
      id: 'geography',
      kicker: 'Step 3',
      title: 'Split by geography',
      body: [
        p(
          'Names are not unique. Searched across Colorado, "Nature Trail" returns ',
          strong(`${rNature.raw.length} ways under one name`),
          ', belonging to ',
          strong(`${rNature.clusters.length} unrelated trails`),
          '. Bear Lake needs no split, so this step uses that search instead.',
        ),
        p(
          'Kept ways are grouped into clusters: two ways join when their bounding boxes come within the gap tolerance, applied transitively. Each cluster is a candidate trail. The one nearest the clicked map location wins; with no location, the longest.',
        ),
        figure(nature, 'clustered', `${rNature.clusters.length} clusters, kept one in red. Dots mark each cluster: a 1 km trail is sub-pixel at this zoom.`, true),
        clusterTable(nature),
        p('Without this step the merge emits one "trail" whose parts are 200 km apart, with a length to match.'),
      ],
    }),

    section({
      id: 'join',
      kicker: 'Step 4',
      title: 'Join end to end',
      body: [
        p('Ways arrive in arbitrary order and direction. Joined as they arrive, they draw a zig-zag. Instead they are walked head to tail:'),
        ol(
          'Start at a loose end.',
          `Find the way whose endpoint meets it within ${CHAIN_TOLERANCE_M} m.`,
          'Reverse that way if it points the wrong direction.',
          'Drop the vertex the two share.',
          'Repeat until nothing connects. Leftovers start another chain.',
        ),
        figure(bear, 'chained', `Clean case: ${rBear.kept.length} ways, ${rBear.chains.length} chain.`),
        p(
          'Van Hoevenberg is the fragmented case: ',
          strong(`${rVh.raw.length} ways returned, ${rVh.kept.length} with the exact name`),
          `, joining into ${rVh.chains.length} chains with ${vhFlips} segments reversed.`,
        ),
        figure(vh, 'chained', `${rVh.kept.length} segments in, ${rVh.chains.length} chains out. Two carry almost all the distance; the other ${vhStubs} are stubs. Step 6 explains why.`, true),
        chainTable(vh),
      ],
    }),

    section({
      id: 'one',
      kicker: 'Step 5',
      title: 'One trail',
      body: [
        p(
          'The chains become one GeoJSON feature: a ',
          code('LineString'),
          ' for one chain, a ',
          code('MultiLineString'),
          ' for several, which keeps separate stretches separate instead of drawing invisible distance between them.',
        ),
        figure(bear, 'merged', `One LineString, ${fmtLen(lengthOf(rBear.merged ? [rBear.merged] : []))}.`),
        p('It carries the tags of its longest input way, plus a record of the merge:'),
        propsBlock(bear),
        p('This feature is what everything downstream reads:'),
        ul(
          'Distance and elevation profile.',
          'Start and finish markers.',
          'The point a forecast is attached to.',
        ),
      ],
    }),

    section({
      id: 'pieces',
      kicker: 'Step 6',
      title: 'When it comes back in pieces',
      body: [
        p('Three of the five examples return more than one part. The causes differ.'),

        h('h3', {}, 'A branch, correctly kept apart'),
        p(
          'Rocky Top is five ways, one name, one trail, two parts. Their nearest endpoints are 600 m apart, but one part ends ',
          strong('on a vertex in the middle'),
          ' of the other: a T-junction. Joining connects ends to ends, never an end to a mid-line vertex. A branching trail has no single path through it.',
        ),
        figure(rocky, 'merged', 'A loop and a spur, correctly held as two parts.'),

        h('h3', {}, 'A real gap, correctly kept apart'),
        p(
          'Longs Peak returns two parts nearly 2 km apart with nothing between them under that name. The gap is in the data; bridging it would invent 2 km of trail.',
        ),

        h('h3', {}, 'A stranded branch, a defect'),
        p(
          'Van Hoevenberg\'s ',
          strong(`${rVh.kept.length} ways are fully connected`),
          ': every stranded stub sits 0 m from a neighbour. It still returns ',
          strong(`${rVh.chains.length} parts, ${vhStubs} of them around 10 m`),
          '. The walk is greedy: at a junction it consumes one arm, and the others find their neighbours already taken.',
        ),
        ul(
          'Geometry and length are unaffected, so nothing user-facing is wrong today.',
          'The part count is not a continuity signal.',
          'Per-part start and finish markers draw spurious pairs.',
          'Fix: walk an endpoint graph longest-path-first from a true trail end. Written up, not applied.',
        ),
        p(
          'Separately, each join absorbs its gap into the line, adding up to ',
          code(`${CHAIN_TOLERANCE_M} m`),
          ` of geometry not in the source. Across ${rVh.kept.length} segments, `,
          fmtLen(lengthOf(rVh.clusterFeatures)),
          ' in becomes ',
          fmtLen(lengthOf(rVh.merged ? [rVh.merged] : [])),
          ' out.',
        ),
      ],
    }),

    section({
      id: 'naming',
      kicker: 'The limit',
      title: 'Merging fixes fragmentation, not naming',
      body: [
        p(
          'All of the above assumes fragments share a name. "Longs Peak via the Keyhole" returns ',
          strong(`${rLongs.raw.length} ways under ${rLongs.groups.length} names`),
          ': East Longs Peak Trail for the approach, then five separately named summit sections (The Boulderfield, The Ledges, The Trough, The Narrows, The Homestretch). All correctly mapped. No shared name, so no merge can assemble the route.',
        ),
        figure(longs, 'named', `${rLongs.raw.length} ways, ${rLongs.groups.length} names. Solid red is the largest single name; dashed grey includes the five summit sections.`, true),
        p(
          'The AllTrails benchmark measures this gap from the other side. Plain canonical names match open data almost exactly; composite consumer routes do not, even where every metre is mapped. A curation problem, not a geometry one, and worth costing separately.',
        ),
      ],
    }),
    section({
      id: 'production',
      kicker: 'Production',
      title: 'From prototype to production',
      body: [
        p(
          'This page queries a public Overpass instance. That is within the terms for evaluation work. A production service would require a different arrangement.',
        ),
        ul(
          'Licence. OSM data is published under ODbL. Commercial use is permitted. The obligations are attribution and share-alike, the latter applying to derived databases. Counsel should review it before a build commitment.',
          'Endpoint. overpass-api.de is operated by FOSSGIS e.V., a donation-funded German non-profit. Stated fair use is 10,000 queries and 1 GB per day. No service level is offered.',
          'Location. No public instance in the US carries global data. The one US instance holds a Virginia extract and returned zero results for a Colorado query in 0.98 s. The German instance returned 17 results for the same query in 0.87 s, and a 504 on an earlier attempt. Measured 2026-07-29.',
        ),
        h(
          'div',
          { class: 'tbl-wrap' },
          h(
            'table',
            { class: 'tbl' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Option'), h('th', {}, 'Cost'), h('th', {}, 'Fit'))),
            h(
              'tbody',
              {},
              h(
                'tr',
                {},
                h('td', {}, 'Public Overpass instance'),
                h('td', {}, 'free, within fair use'),
                h('td', {}, 'Evaluation only'),
              ),
              h(
                'tr',
                {},
                h('td', {}, 'Hosted Overpass (Geofabrik)'),
                h('td', {}, '€40 to €550+ per month, no stated SLA'),
                h('td', {}, 'Interim, or ad-hoc querying'),
              ),
              h(
                'tr',
                { class: 'is-target' },
                h('td', {}, 'Own ingest from free OSM extracts'),
                h('td', {}, 'engineering time'),
                h('td', {}, 'Production'),
              ),
            ),
          ),
        ),
        p(
          'Overpass is designed for ad-hoc extraction rather than per-request production lookups. A production implementation would load the free daily OSM extracts into a store TWC operates and query that. The cost of that ingest belongs in the build estimate.',
        ),
      ],
    }),
  ];

  const footer = h(
    'footer',
    { class: 'doc-foot' },
    h('p', {}, 'OpenStreetMap data © OpenStreetMap contributors, ODbL, via the Overpass API. Basemap: USGS The National Map.'),
    h('p', {}, 'TrailScope · trail data source evaluation for The Weather Company.'),
  );

  return [header, tldr, ...sections, footer];
}

// ---- contents rail + scroll spy ---------------------------------------------------

function buildToc(): void {
  const toc = document.getElementById('doc-toc');
  if (!toc) return;
  const secs = [...document.querySelectorAll<HTMLElement>('.sec')];
  const links = secs.map((s) => {
    const title = s.querySelector('h2')?.textContent ?? s.id;
    const a = h('a', { class: 'toc-link', href: `#${s.id}` }, title) as HTMLAnchorElement;
    return a;
  });
  toc.replaceChildren(h('div', { class: 'toc-head' }, 'Contents'), ...links);

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const i = secs.indexOf(entry.target as HTMLElement);
        if (i < 0) continue;
        if (entry.isIntersecting) {
          for (const l of links) l.classList.remove('on');
          links[i].classList.add('on');
        }
      }
    },
    { rootMargin: '-20% 0px -70% 0px' },
  );
  for (const s of secs) io.observe(s);
}

// ---- boot ---------------------------------------------------------------------------

function boot(): void {
  mountNav('merge');
  const doc = document.getElementById('doc');
  if (doc) doc.replaceChildren(...buildDoc());
  buildToc();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
