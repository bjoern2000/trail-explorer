// Workstream C — renders the consolidated source matrix page.
//
// ONE master table, transposed: columns = the six open sources, rows in two
// clearly labelled bands:
//   REPORTED  — desk research / source documentation, distilled from MATRIX_ROWS.
//   MEASURED  — live benchmark across 6 regions, one identical method (metrics.ts).
// Below it, a compact restricted-benchmarks block for Trailforks + AllTrails
// (claims only, not measurable).
//
// matrix.html loads this module directly; it fills the master table on load and
// fills the MEASURED band once the (cached or live) benchmark returns.

import '../tokens.css';
import { mountNav } from '../ui/nav';
import {
  MATRIX_ROWS,
  BENCHMARKS,
  SOURCES,
  SOURCE_IDS,
  type MatrixRow,
} from '../registry';
import type { SourceId, Units } from '../types';
import { h, fmtNumber, fmtDistance } from '../ui/dom';
import {
  REGIONS,
  COVERAGE_FIELDS,
  measureMetrics,
  loadCachedMetrics,
  saveCachedMetrics,
  clearCachedMetrics,
  readUnits,
  type MetricsResult,
  type SourceMetrics,
} from './metrics';

const SHORT_LABEL: Record<SourceId, string> = {
  osm: 'OSM',
  usfs: 'USFS',
  nps: 'NPS',
  blm: 'BLM',
  usgs: 'USGS',
  cotrex: 'COTREX',
  dec: 'DEC',
};

// MATRIX_ROWS is authored in SOURCE_IDS order; index-align it into a per-id map so
// the transpose is explicit rather than positional at every call site.
const MATRIX_BY_ID: Record<SourceId, MatrixRow> = SOURCE_IDS.reduce(
  (acc, id, i) => {
    acc[id] = MATRIX_ROWS[i];
    return acc;
  },
  {} as Record<SourceId, MatrixRow>,
);

// ---- shared cell type -------------------------------------------------------

interface Cell {
  text: string;
  title?: string; // tooltip carrying the longer original phrasing
  fit?: 'a' | 'b' | 'c'; // colour emphasis (verdict lead)
  lead?: string; // coloured lead phrase, followed by `text`
  dim?: boolean; // muted (e.g. "None")
  mono?: boolean; // mono numerals (volume, access, updated)
  na?: boolean; // italic faint (measured n/a)
  dash?: boolean; // em dash (measured, no data)
}

function cellEl(c: Cell | null, align: 'left' | 'right'): HTMLElement {
  const cls = ['mxm-cell', align === 'right' ? 'mxm-r' : 'mxm-l'];
  if (!c || c.dash) {
    cls.push('mxm-dash');
    return h('td', { class: cls.join(' ') }, '—');
  }
  if (c.mono) cls.push('mxm-mono');
  if (c.dim) cls.push('mxm-dim');
  if (c.na) cls.push('mxm-na');
  const td = h('td', { class: cls.join(' '), title: c.title });
  if (c.fit && c.lead) {
    td.append(h('span', { class: `fit-${c.fit}` }, c.lead), ' ' + c.text);
  } else {
    td.textContent = c.text;
  }
  return td;
}

// ---- REPORTED band ----------------------------------------------------------
// Column cells are narrower than the old row layout, so each phrasing is trimmed
// to a scannable short form; the full original MATRIX_ROWS text rides along as a
// tooltip so nothing is lost.

interface ReportedShort {
  coverage: string;
  attributes: string;
  license: string;
  access: string;
}

const REPORTED_SHORT: Record<SourceId, ReportedShort> = {
  osm: {
    coverage: 'Nationwide; best overall, incl. informal/social',
    attributes: 'Geometry + names strong; surface 56%, difficulty 3–4%',
    license: 'ODbL — attribution + share-alike',
    access: 'Overpass live · bulk extracts',
  },
  usfs: {
    coverage: 'USFS lands, CONUS + AK (~160k mi)',
    attributes: 'Richest schema: class, surface, grade, per-use + e-bike',
    license: 'Public domain',
    access: 'ArcGIS REST · bulk GDB/SHP',
  },
  nps: {
    coverage: 'National parks; varies park to park',
    attributes: 'Thin: name, uses, surface, maintainer',
    license: 'Public domain',
    access: 'ArcGIS REST · open data',
  },
  blm: {
    coverage: 'BLM lands; strong where planned (Moab)',
    attributes: 'Transport modes, surface, OHV. No class/grade',
    license: 'Public domain',
    access: 'ArcGIS REST',
  },
  usgs: {
    coverage: "Nat'l aggregate: fed + state + local PD",
    attributes: 'FTDS + maintainer + lineage + per-use e-bike',
    license: 'Public domain',
    access: 'ArcGIS REST · bulk by state',
  },
  cotrex: {
    coverage: 'Colorado only; all managers merged',
    attributes: 'Per-activity: hike/bike/horse/ski…; elevation',
    license: 'State open data (verify redist.)',
    access: 'ArcGIS REST · full export',
  },
  dec: {
    coverage: 'New York only; DEC state land (Adirondacks, Catskills)',
    attributes: 'Per-use flags: foot/bike/horse/ski/snowmb; no surface or difficulty',
    license: 'State open data (verify redist.)',
    access: 'ArcGIS REST',
  },
};

interface ReportedRow {
  label: string;
  cell: (id: SourceId, r: MatrixRow) => Cell;
}

const REPORTED_ROWS: ReportedRow[] = [
  {
    label: 'Coverage',
    cell: (id, r) => ({ text: REPORTED_SHORT[id].coverage, title: r.coverage }),
  },
  {
    label: 'Volume (claimed)',
    cell: (_id, r) => ({ text: r.volume, mono: true }),
  },
  {
    label: 'Attributes',
    cell: (id, r) => ({ text: REPORTED_SHORT[id].attributes, title: r.attributes }),
  },
  {
    label: 'Conditions',
    cell: (_id, r) => ({ text: r.conditions, dim: r.conditionsDim }),
  },
  {
    label: 'License',
    cell: (id, r) => ({ text: REPORTED_SHORT[id].license, title: r.license }),
  },
  {
    label: 'Access',
    cell: (id, r) => ({ text: REPORTED_SHORT[id].access, title: r.access, mono: true }),
  },
  {
    label: 'Updated',
    cell: (_id, r) => ({ text: r.updated, mono: true }),
  },
  {
    label: 'Product fit',
    cell: (_id, r) => {
      const pf = r.productFit;
      if (pf.fit && pf.lead) return { text: pf.rest, fit: pf.fit, lead: pf.lead };
      return { text: pf.rest };
    },
  },
];

// ---- MEASURED band ----------------------------------------------------------

function fmtMedian(n: number): string {
  return Number.isInteger(n) ? fmtNumber(n) : n.toFixed(1);
}
function pctText(p: number): string {
  return `${Math.round(p)}%`;
}
function altDistance(meters: number, units: Units): string {
  return fmtDistance(meters, units === 'metric' ? 'imperial' : 'metric');
}

interface MetricRow {
  label: string;
  labelTitle?: (id: SourceId) => string;
  cell: (m: SourceMetrics, units: Units) => { text: string; title?: string; na?: boolean } | null;
}

const METRIC_ROWS: MetricRow[] = [
  {
    label: 'Segments fetched',
    cell: (m) => ({ text: fmtNumber(m.segments) }),
  },
  {
    label: 'Total distance',
    labelTitle: () => 'summed geometry length — volume independent of how the source segments its trails',
    cell: (m, units) =>
      m.segments ? { text: fmtDistance(m.totalLengthM, units), title: altDistance(m.totalLengthM, units) } : null,
  },
  {
    label: 'Named distance',
    labelTitle: () => 'length on segments that carry a name — the product-usable share of the volume',
    cell: (m, units) =>
      m.segments
        ? {
            text: `${fmtDistance(m.namedLengthM, units)} (${pctText(m.totalLengthM ? (m.namedLengthM / m.totalLengthM) * 100 : 0)})`,
            title: altDistance(m.namedLengthM, units),
          }
        : null,
  },
  {
    label: 'Named',
    cell: (m) => (m.segments ? { text: pctText(m.namedPct) } : null),
  },
  {
    label: 'Distinct trails',
    cell: (m) => ({ text: fmtNumber(m.distinctTrails) }),
  },
  {
    label: 'Segments / trail',
    cell: (m) =>
      m.distinctTrails
        ? { text: fmtMedian(m.segsPerTrailMedian), title: `median · mean ${m.segsPerTrailMean.toFixed(1)}` }
        : null,
  },
  {
    label: 'Attributes / segment',
    cell: (m) => {
      if (!m.segments) return null;
      const base = fmtMedian(m.attrsPerSegMedian);
      const text = m.schemaFields != null ? `${base} / ${m.schemaFields}` : base;
      const title =
        m.schemaFields != null
          ? `median populated / ${m.schemaFields} schema fields · mean ${m.attrsPerSegMean.toFixed(1)}`
          : `median populated tags · mean ${m.attrsPerSegMean.toFixed(1)}`;
      return { text, title };
    },
  },
  {
    label: 'Median trail length',
    cell: (m, units) =>
      m.distinctTrails
        ? { text: fmtDistance(m.trailLenMedianM, units), title: altDistance(m.trailLenMedianM, units) }
        : null,
  },
  {
    label: 'Surface tagged',
    labelTitle: (id) => `field: ${COVERAGE_FIELDS.surface[id]}`,
    cell: (m) => (m.segments ? { text: pctText(m.surfacePct) } : null),
  },
  {
    label: 'Bike info',
    labelTitle: (id) => `field: ${COVERAGE_FIELDS.bike[id]}`,
    cell: (m) => (m.segments ? { text: pctText(m.bikePct) } : null),
  },
  {
    label: 'Difficulty',
    labelTitle: (id) => `field: ${COVERAGE_FIELDS.difficulty[id]}`,
    cell: (m) =>
      m.difficultyPct == null ? { text: 'n/a', title: 'no difficulty field', na: true } : { text: pctText(m.difficultyPct) },
  },
];

// ---- header + reported render (immediate) -----------------------------------

// header source cells, kept so the record-cap flag can be added once metrics land
const headerColById = {} as Record<SourceId, HTMLElement>;

function renderHead(thead: HTMLElement): void {
  const row = h('tr', null, h('th', { class: 'mxm-corner' }, 'Source →'));
  for (const id of SOURCE_IDS) {
    const th = h('th', { class: 'mxm-col', title: SOURCES[id].label },
      h('span', { class: 'mxm-swatch', style: `background:${SOURCES[id].color}` }),
      SHORT_LABEL[id],
    );
    headerColById[id] = th;
    row.append(th);
  }
  thead.replaceChildren(row);
}

function bandRow(cls: string, title: string, subline?: Node): HTMLTableRowElement {
  const inner = h('div', { class: 'mxm-band-inner' }, h('span', { class: 'mxm-band-title' }, title));
  if (subline) inner.append(subline);
  return h('tr', { class: `mxm-band ${cls}` }, h('td', { colspan: '7' }, inner)) as HTMLTableRowElement;
}

function renderReported(tbody: HTMLElement): void {
  tbody.replaceChildren();
  tbody.append(bandRow('mxm-band-reported', 'REPORTED · desk research & source documentation'));
  for (const row of REPORTED_ROWS) {
    const tr = h('tr', null, h('td', { class: 'mxm-metric' }, row.label));
    for (const id of SOURCE_IDS) tr.append(cellEl(row.cell(id, MATRIX_BY_ID[id]), 'left'));
    tbody.append(tr);
  }
}

// ---- measured render (async) ------------------------------------------------

function measuredBand(): { row: HTMLTableRowElement; button: HTMLButtonElement } {
  const sub = h('span', { class: 'mxm-band-sub' }, REGIONS.map((r) => r.label).join(' · '));
  const button = h('button', {
    class: 'mm-remeasure', id: 'mm-remeasure', type: 'button',
  }, 'REMEASURE') as HTMLButtonElement;
  const inner = h('div', { class: 'mxm-band-inner' },
    h('span', { class: 'mxm-band-title' }, 'MEASURED · live benchmark, 6 regions, identical method'),
    button,
  );
  inner.append(sub);
  const row = h('tr', { class: 'mxm-band mxm-band-measured' }, h('td', { colspan: '7' }, inner)) as HTMLTableRowElement;
  return { row, button };
}

/** measuring / error status row while the benchmark runs. */
function statusRow(text: string): HTMLTableRowElement {
  return h('tr', { class: 'mxm-status' }, h('td', { class: 'mxm-status-cell', colspan: '7' }, text)) as HTMLTableRowElement;
}

/** Rebuild the MEASURED tbody: band header (+ button) then either a status row or the metric rows. */
function renderMeasured(state: { status: string } | { result: MetricsResult; units: Units }): void {
  const tbody = document.getElementById('mxm-measured');
  if (!tbody) return;
  tbody.replaceChildren();
  const { row, button } = measuredBand();
  tbody.append(row);
  button.hidden = 'result' in state ? false : true;
  button.addEventListener('click', onRemeasure);

  if ('status' in state) {
    tbody.append(statusRow(state.status));
    return;
  }

  const { result, units } = state;
  for (const mrow of METRIC_ROWS) {
    const labelCell = h('td', { class: 'mxm-metric' }, mrow.label);
    if (mrow.labelTitle) {
      labelCell.title = SOURCE_IDS.map((id) => `${SHORT_LABEL[id]}: ${mrow.labelTitle!(id)}`).join('  ·  ');
      labelCell.classList.add('mxm-has-tip');
    }
    const tr = h('tr', null, labelCell);
    for (const id of SOURCE_IDS) {
      const entry = mrow.cell(result.sources[id], units);
      tr.append(cellEl(entry ? { text: entry.text, title: entry.title, na: entry.na, mono: true } : null, 'right'));
    }
    tbody.append(tr);
  }

  // record-cap flag on the affected source column headers
  for (const id of SOURCE_IDS) {
    headerColById[id].querySelector('.mxm-cap')?.remove();
    if (result.sources[id].capped) {
      headerColById[id].append(h('span', { class: 'mxm-cap', title: 'hit the record cap in a region' }, '▲'));
    }
  }

  renderFoot(result);
}

function renderFoot(result: MetricsResult): void {
  const foot = document.getElementById('mm-foot');
  if (!foot) return;
  const notes: string[] = [];
  const capped = SOURCE_IDS.filter((id) => result.sources[id].capped).map((id) => SHORT_LABEL[id]);
  if (capped.length) notes.push(`▲ hit the 2,000-record cap in ≥1 region: ${capped.join(', ')}.`);
  const errs = SOURCE_IDS.filter((id) => result.sources[id].regionsErrored.length).map(
    (id) => `${SHORT_LABEL[id]} (${result.sources[id].regionsErrored.join(', ')})`,
  );
  if (errs.length) notes.push(`Fetch failed for: ${errs.join('; ')} — those cells excluded.`);
  const when = new Date(result.computedAt).toLocaleString('en-US');
  notes.push(`Measured ${when}. Cached 24h.`);
  foot.textContent = notes.join('  ');
  foot.hidden = false;
}

// ---- measurement control ----------------------------------------------------

let measuring = false;

async function runMeasurement(units: Units): Promise<void> {
  if (measuring) return;
  measuring = true;
  const foot = document.getElementById('mm-foot');
  if (foot) foot.hidden = true;
  renderMeasured({ status: `measuring… 0/${REGIONS.length * SOURCE_IDS.length} fetches` });
  try {
    const result = await measureMetrics((p) => {
      const cell = document.querySelector('.mxm-status-cell');
      if (cell) cell.textContent = `measuring… ${p.done}/${p.total} fetches`;
    });
    saveCachedMetrics(result);
    renderMeasured({ result, units });
  } catch (err) {
    renderMeasured({ status: `measurement failed: ${err instanceof Error ? err.message : String(err)}` });
    const btn = document.getElementById('mm-remeasure') as HTMLButtonElement | null;
    if (btn) btn.hidden = false;
  } finally {
    measuring = false;
  }
}

function onRemeasure(): void {
  clearCachedMetrics();
  void runMeasurement(readUnits());
}

function bootMeasured(): void {
  const units = readUnits();
  const cached = loadCachedMetrics();
  if (cached) renderMeasured({ result: cached, units });
  else void runMeasurement(units);
}

// ---- restricted benchmarks block --------------------------------------------

function restrictedCard(b: MatrixRow): HTMLElement {
  const rows: [string, string, boolean?][] = [
    ['Coverage', b.coverage],
    ['Volume', b.volume, true],
    ['Attributes', b.attributes],
    ['Conditions', b.conditions],
    ['License', b.license],
    ['Access', b.access, true],
    ['Updated', b.updated, true],
    ['Role', b.productFit.rest],
  ];
  const dl = h('div', { class: 'mx-rdl' });
  for (const [k, v, mono] of rows) {
    dl.append(
      h('span', { class: 'mx-rk' }, k),
      h('span', { class: mono ? 'mx-rv mxm-mono' : 'mx-rv' }, v),
    );
  }
  return h('div', { class: 'mx-rcard' },
    h('div', { class: 'mx-rcard-head' },
      h('span', { class: 'mxm-swatch', style: `background:${b.color}` }),
      h('span', { class: 'mx-rname' }, b.label),
      b.chipNot ? h('span', { class: 'chip-not' }, b.chipNot) : null,
    ),
    dl,
  );
}

function renderRestricted(): void {
  const grid = document.getElementById('mxm-restricted');
  if (!grid) return;
  grid.replaceChildren(...BENCHMARKS.map(restrictedCard));
}

// ---- boot -------------------------------------------------------------------

function boot(): void {
  mountNav('matrix');
  const thead = document.getElementById('mxm-head');
  const reported = document.getElementById('mxm-reported');
  if (thead) renderHead(thead);
  if (reported) renderReported(reported);
  renderRestricted();
  bootMeasured();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
