// Benchmark page — TABLE view: a full-width, sortable route table with inline
// accordion detail rows, in the matrix page's table idiom (sticky header,
// overflow-x auto wrapper). Pure static content from the derived JSON — no
// fetches; the lazy segment fetch stays map-view-only.

import type { Units } from '../types';
import { SOURCE_IDS, SOURCES } from '../registry';
import { h, displayTrailName, fmtDistance, fmtElevation, fmtNumber } from '../ui/dom';
import {
  OUTCOME_COLOR,
  REASON_LABEL,
  lengthMismatch,
  lengthWithType,
  outcomeOf,
  type Outcome,
  type RegionEntry,
  type Route,
} from './model';
import { matchRow } from './detail';
import { getSegmentState } from './segments';

export interface TableCallbacks {
  onShowOnMap: (trailId: string) => void;
}

type SortKey = 'name' | 'reviews' | 'length' | 'nearest';

interface SortableCol {
  key: SortKey;
  label: string;
  defaultDir: 1 | -1; // asc for name, desc for numerics
}

const SORTABLE: Record<SortKey, SortableCol> = {
  name: { key: 'name', label: 'Route', defaultDir: 1 },
  reviews: { key: 'reviews', label: 'Reviews', defaultDir: -1 },
  length: { key: 'length', label: 'Length', defaultDir: -1 },
  nearest: { key: 'nearest', label: 'Nearest open data', defaultDir: 1 },
};

const OUTCOME_TEXT: Record<Outcome, string> = {
  exact: 'EXACT',
  fuzzy: 'FUZZY',
  unmatched: 'UNMATCHED',
  excluded: 'EXCLUDED',
};

// ---- module state (sort + expansion; expansion resets on any re-render) ------

let sortKey: SortKey = 'reviews';
let sortDir: 1 | -1 = -1;
const expanded = new Set<string>();

/** Reset sort + expansion (region switch). */
export function resetTableState(): void {
  sortKey = 'reviews';
  sortDir = -1;
  expanded.clear();
}

// ---- helpers ------------------------------------------------------------------

function nearestOf(r: Route): number | null {
  const v = r.nearestFeatureM?.overall;
  return typeof v === 'number' ? v : null;
}

function compareRoutes(a: Route, b: Route): number {
  let d: number;
  switch (sortKey) {
    case 'name':
      d = a.name.localeCompare(b.name);
      break;
    case 'reviews':
      d = a.numReviews - b.numReviews;
      break;
    case 'length': {
      // Null lengths sort last in either direction (snapshot may lack a length).
      const al = a.lengthMeters ?? (sortDir === 1 ? Infinity : -Infinity);
      const bl = b.lengthMeters ?? (sortDir === 1 ? Infinity : -Infinity);
      d = al - bl;
      break;
    }
    case 'nearest': {
      // Null distances sort last in either direction.
      const av = nearestOf(a) ?? (sortDir === 1 ? Infinity : -Infinity);
      const bv = nearestOf(b) ?? (sortDir === 1 ? Infinity : -Infinity);
      d = av - bv;
      break;
    }
  }
  return d * sortDir;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- cell builders --------------------------------------------------------------

function outcomeCell(o: Outcome): HTMLElement {
  return h('td', { class: 'bmt-outcome' },
    h('span', { class: 'bm-dot', style: `background:${OUTCOME_COLOR[o]}` }),
    h('span', { class: 'bmt-outcome-label' }, OUTCOME_TEXT[o]),
  );
}

function nameCell(r: Route): HTMLElement {
  const td = h('td', { class: 'bmt-name' }, displayTrailName(r.name));
  if (r.excluded && r.exclusionReason) {
    td.append(
      h('span', { class: 'bmt-reason' }, REASON_LABEL[r.exclusionReason] ?? r.exclusionReason),
    );
  }
  return td;
}

/** Six swatches in source order: filled with tier color when matched, hollow otherwise. */
function sourcesCell(r: Route): HTMLElement {
  const td = h('td', { class: 'bmt-sources' });
  for (const id of SOURCE_IDS) {
    const m = r.matches[id];
    const tier = m?.tier;
    const title = `${SOURCES[id].label}: ${m?.matched ? tier : 'no match'}`;
    if (m?.matched && tier) {
      td.append(h('span', {
        class: 'bmt-sw bmt-sw-filled',
        style: `background:${tier === 'exact' ? OUTCOME_COLOR.exact : OUTCOME_COLOR.fuzzy}`,
        title,
      }));
    } else {
      td.append(h('span', { class: 'bmt-sw bmt-sw-hollow', title }));
    }
  }
  return td;
}

function numCell(text: string, extraClass = ''): HTMLElement {
  return h('td', { class: `bmt-num${extraClass ? ' ' + extraClass : ''}` }, text);
}

// ---- expansion row -------------------------------------------------------------

function expansionRow(
  r: Route,
  region: RegionEntry,
  units: Units,
  colspan: number,
  cb: TableCallbacks,
): HTMLTableRowElement {
  // Runtime segment-fetch state (populated once map view has fetched this region):
  // matched sources flagged 'partial data' (amber) or 'fetch failed' (red).
  const segState = getSegmentState(region.id);
  const matches = h('div', { class: 'bmt-exp-matches' });
  for (const id of SOURCE_IDS) {
    const m = r.matches[id];
    if (!m) continue;
    const metaErr = region.data.meta.sources[id]?.error;
    matches.append(
      matchRow(id, m, units, {
        maxNames: Infinity,
        noMatchText: metaErr ? 'fetch n/a' : 'no name match',
        failedText: m.matched && segState?.failed.has(id) ? 'fetch failed' : null,
        partialText: m.matched && segState?.partial.has(id) ? 'partial data' : null,
        mismatch: lengthMismatch(r, m),
      }),
    );
  }

  const nearest = nearestOf(r);
  const netpres = h('div', { class: 'bmt-exp-netpres' },
    'nearest open-data feature: ',
    h('strong', null, nearest == null ? '—' : fmtElevation(nearest, units)),
  );

  const showBtn = h('button', { class: 'bmt-showmap', type: 'button' }, 'SHOW ON MAP →');
  showBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cb.onShowOnMap(r.trailId);
  });

  const inner = h('div', { class: 'bmt-exp' }, matches, h('div', { class: 'bmt-exp-foot' }, netpres, showBtn));
  return h('tr', { class: 'bmt-exp-row' }, h('td', { colspan: String(colspan) }, inner)) as HTMLTableRowElement;
}

// ---- render ---------------------------------------------------------------------

/**
 * Render the table into `host`. Called on view switch, filter change, sort click,
 * and region change. `resetExpansion` collapses all open accordions (filter/sort).
 */
export function renderTable(
  host: HTMLElement,
  region: RegionEntry,
  filter: string,
  units: Units,
  cb: TableCallbacks,
  resetExpansion = false,
): void {
  if (resetExpansion) expanded.clear();

  const q = filter.trim().toLowerCase();
  const rows = region.data.routes
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .sort(compareRoutes);

  const cols: { label: string; sort?: SortKey; cls?: string }[] = [
    { label: 'Match' },
    { label: 'Route', sort: 'name' },
    { label: 'Reviews', sort: 'reviews', cls: 'bmt-h-num' },
    { label: 'Length', sort: 'length', cls: 'bmt-h-num' },
    { label: 'Difficulty' },
    { label: 'Nearest open data', sort: 'nearest', cls: 'bmt-h-num' },
    { label: 'Sources' },
  ];

  const headRow = h('tr', null);
  for (const c of cols) {
    const th = h('th', { class: c.cls });
    if (c.sort) {
      const key = c.sort;
      th.classList.add('bmt-sortable');
      th.append(c.label);
      if (sortKey === key) th.append(h('span', { class: 'bmt-sort-ind' }, sortDir === 1 ? ' ▲' : ' ▼'));
      th.addEventListener('click', () => {
        if (sortKey === key) sortDir = sortDir === 1 ? -1 : 1;
        else {
          sortKey = key;
          sortDir = SORTABLE[key].defaultDir;
        }
        renderTable(host, region, filter, units, cb, true);
      });
    } else {
      th.textContent = c.label;
    }
    headRow.append(th);
  }

  const tbody = h('tbody', null);
  for (const r of rows) {
    const nearest = nearestOf(r);
    const tr = h('tr', { class: 'bmt-row' + (expanded.has(r.trailId) ? ' open' : '') },
      outcomeCell(outcomeOf(r)),
      nameCell(r),
      numCell(r.numReviews ? fmtNumber(r.numReviews) : '—'),
      numCell(
        r.lengthMeters == null
          ? '—'
          : lengthWithType(fmtDistance(r.lengthMeters, units), r.routeType),
      ),
      h('td', { class: 'bmt-diff' }, r.difficulty ? titleCase(r.difficulty) : '—'),
      numCell(nearest == null ? '—' : fmtElevation(nearest, units)),
      sourcesCell(r),
    ) as HTMLTableRowElement;

    tr.addEventListener('click', () => {
      if (expanded.has(r.trailId)) {
        expanded.delete(r.trailId);
        tr.classList.remove('open');
        const next = tr.nextElementSibling;
        if (next?.classList.contains('bmt-exp-row')) next.remove();
      } else {
        expanded.add(r.trailId);
        tr.classList.add('open');
        tr.after(expansionRow(r, region, units, cols.length, cb));
      }
    });

    tbody.append(tr);
    if (expanded.has(r.trailId)) tbody.append(expansionRow(r, region, units, cols.length, cb));
  }

  const table = h('table', { class: 'bmt' }, h('thead', null, headRow), tbody);
  const scroll = h('div', { class: 'bmt-scroll' }, table);
  const foot = h('div', { class: 'bmt-count' },
    `${fmtNumber(rows.length)} of ${fmtNumber(region.data.routes.length)} routes`,
  );
  host.replaceChildren(scroll, foot);
}
