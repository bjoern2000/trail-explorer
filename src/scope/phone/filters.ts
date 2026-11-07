// Trail Scope phone — the filter chip row and the filter sheet.
//
// Chip order is fixed: conditions, effort, character (SCOPE_PLAN §6). Conditions lead
// deliberately, and they lead as FIVE DIRECT TOGGLES rather than a group chip, because
// "conditions are a first-class filter dimension" is the page's whole claim and burying
// them one tap deep would understate it. Effort and character open the sheet at their own
// group, which is where the ranges and the long surface list belong.
//
// Standard discovery mechanics throughout, because they are learned and there is no
// advantage in making a hiker relearn them: active state and value on the chip, a count
// badge, per-group clear, global clear, a live result count, and no silent dead ends (a
// filter that would return nothing still shows its own count so the reader can see why).
//
// Edits apply immediately rather than into a draft. The result count behind the sheet
// moves as the reader taps, which is the behaviour that makes conditions-as-a-filter
// legible in a five second demo.

import { h } from '../../ui/dom';
import { chip, dragScroll, icon, optionRow, sheet } from './ui';
import {
  ACTIVITY_LABEL,
  CONDITION_FILTER_LABEL,
  DIFFICULTY_LABEL,
  OUT_OF_SCOPE_ACTIVITIES,
  ROUTE_TYPE_LABEL,
  activeFilterCount,
  emptyFilters,
  formatDuration,
  formatElevation,
  formatLength,
} from '../model';
import { CONDITION_FILTERS, conditionFilterDegraded } from '../weather/grade';
import { firstOutlookDay } from './grading';
import { regionSurfaces } from '../data';
import type { Ctx, FilterGroupId } from './ctx';
import type { Units } from '../../types';
import type {
  Activity,
  ConditionFilterId,
  Difficulty,
  Filters,
  GradeConfidence,
  Range,
  RouteType,
  ScopeTrail,
} from '../types';

// ============================================================================
// RANGE PRESETS
// ============================================================================

interface Preset {
  label: string;
  range: Range;
}

const UNBOUNDED: Range = { min: null, max: null };

function rangeEq(a: Range, b: Range): boolean {
  return a.min === b.min && a.max === b.max;
}

function isSet(r: Range): boolean {
  return r.min !== null || r.max !== null;
}

/** Percentile of a sorted-on-demand sample, for region-relative elevation bands. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

function bandPresets(lo: number, hi: number, fmt: (v: number) => string): Preset[] {
  return [
    { label: `Under ${fmt(lo)}`, range: { min: null, max: lo } },
    { label: `${fmt(lo)} to ${fmt(hi)}`, range: { min: lo, max: hi } },
    { label: `Over ${fmt(hi)}`, range: { min: hi, max: null } },
  ];
}

function lengthPresets(units: Units): Preset[] {
  return bandPresets(2000, 8000, (v) => formatLength(v, units));
}

function gainPresets(units: Units): Preset[] {
  return bandPresets(150, 600, (v) => formatElevation(v, units));
}

function timePresets(): Preset[] {
  return bandPresets(60, 180, (v) => formatDuration(v));
}

/**
 * Max elevation bands from the region's OWN distribution, rounded to 50 m. A fixed pair of
 * thresholds cannot serve a 3,850 m region and a 350 m one: in Lake of the Ozarks every
 * fixed mountain band would be empty, which is a dead end rather than a filter.
 */
function maxElevPresets(pool: ScopeTrail[], units: Units): Preset[] {
  const vals = pool.map((t) => t.maxElevM);
  const round50 = (v: number): number => Math.round(v / 50) * 50;
  let lo = round50(percentile(vals, 0.4));
  let hi = round50(percentile(vals, 0.78));
  if (hi <= lo) hi = lo + 50;
  return bandPresets(lo, hi, (v) => formatElevation(v, units));
}

// ============================================================================
// GROUP SUMMARIES (the value shown on a chip)
// ============================================================================

function rangeLabel(r: Range, presets: Preset[]): string | null {
  if (!isSet(r)) return null;
  const hit = presets.find((p) => rangeEq(p.range, r));
  return hit ? hit.label : 'custom';
}

function effortSummary(f: Filters, pool: ScopeTrail[], units: Units): string | null {
  const parts: string[] = [];
  if (f.difficulty.length) parts.push(f.difficulty.map((d) => DIFFICULTY_LABEL[d]).join(', '));
  const len = rangeLabel(f.lengthM, lengthPresets(units));
  if (len) parts.push(len);
  const gain = rangeLabel(f.gainM, gainPresets(units));
  if (gain) parts.push(gain);
  const elev = rangeLabel(f.maxElevM, maxElevPresets(pool, units));
  if (elev) parts.push(elev);
  const time = rangeLabel(f.estMinutes, timePresets());
  if (time) parts.push(time);
  return parts.length ? parts.join(' · ') : null;
}

function characterSummary(f: Filters): string | null {
  const parts: string[] = [];
  if (f.activities.length) parts.push(f.activities.map((a) => ACTIVITY_LABEL[a]).join(', '));
  if (f.routeTypes.length) parts.push(f.routeTypes.map((r) => ROUTE_TYPE_LABEL[r]).join(', '));
  if (f.surfaces.length) parts.push(f.surfaces.join(', '));
  return parts.length ? parts.join(' · ') : null;
}

function effortCount(f: Filters): number {
  let n = f.difficulty.length;
  for (const r of [f.lengthM, f.gainM, f.maxElevM, f.estMinutes]) if (isSet(r)) n++;
  return n;
}

function characterCount(f: Filters): number {
  return f.activities.length + f.routeTypes.length + f.surfaces.length;
}

// ============================================================================
// MUTATION HELPERS
// ============================================================================

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function clearedGroup(f: Filters, group: FilterGroupId): Filters {
  if (group === 'conditions') return { ...f, conditions: [] };
  if (group === 'effort') {
    return { ...f, difficulty: [], lengthM: UNBOUNDED, gainM: UNBOUNDED, maxElevM: UNBOUNDED, estMinutes: UNBOUNDED };
  }
  return { ...f, activities: [], routeTypes: [], surfaces: [] };
}

// ============================================================================
// THE CHIP ROW
// ============================================================================

export function filterChipRow(ctx: Ctx): HTMLElement {
  const f = ctx.state.filters;
  const total = activeFilterCount(f);

  const openSheet = (group: FilterGroupId): void => {
    ctx.setUi({ sheet: 'filters', filterGroup: group });
  };

  // Eight chips in a 390 px frame: most of the row is past the fold, and on a mouse there is
  // no way to reach it (no horizontal wheel axis, and the scrollbar is hidden). dragScroll
  // makes press-and-move scroll the row, and swallows the click when the pointer travelled,
  // so dragging across "Dry" does not toggle Dry. See ui.ts.
  const row = dragScroll(h('div', { class: 'chip-row' }));

  const all = chip('Filters', total > 0, () => openSheet('conditions'), {
    glyph: 'filters',
    badge: total,
  });
  all.classList.add('fc-lead');
  row.appendChild(all);

  // Conditions, inline and one tap each. Every one of them is evaluated against the day
  // selected in the day bar directly below, so none of them names a day: a chip reading
  // "Good today" above a bar set to Tomorrow was two answers to the same question.
  for (const id of ['good-conditions', 'dry', 'storm-free', 'below-treeline', 'shaded'] as ConditionFilterId[]) {
    row.appendChild(
      chip(CONDITION_FILTER_LABEL[id], f.conditions.includes(id), () => {
        ctx.set({ filters: { ...f, conditions: toggle(f.conditions, id) } });
      }, { glyph: 'sun' }),
    );
  }

  const eff = effortSummary(f, ctx.pool, ctx.units);
  row.appendChild(
    chip('Effort', effortCount(f) > 0, () => openSheet('effort'), {
      value: eff ?? undefined,
      caret: true,
    }),
  );

  const chr = characterSummary(f);
  row.appendChild(
    chip('Character', characterCount(f) > 0, () => openSheet('character'), {
      value: chr ?? undefined,
      caret: true,
    }),
  );

  if (total > 0) {
    const clear = h('button', { type: 'button', class: 'f-chip is-clear' }, icon('close', 12), h('span', {}, 'Clear all'));
    clear.addEventListener('click', () => ctx.set({ filters: emptyFilters() }));
    row.appendChild(clear);
  }

  return row;
}

// ============================================================================
// THE FILTER SHEET
// ============================================================================

function groupHead(title: string, count: number, onClear: () => void): HTMLElement {
  const head = h('div', { class: 'fg-head' }, h('div', { class: 'fg-title' }, title));
  if (count > 0) {
    const btn = h('button', { type: 'button', class: 'fg-clear' }, `Clear ${count}`);
    btn.addEventListener('click', onClear);
    head.appendChild(btn);
  }
  return head;
}

function pillGroup(...items: HTMLElement[]): HTMLElement {
  return h('div', { class: 'fg-pills' }, ...items);
}

function selectPill(label: string, on: boolean, onTap: () => void): HTMLElement {
  const el = h('button', { type: 'button', class: `sel-pill${on ? ' on' : ''}` }, label);
  el.setAttribute('aria-pressed', String(on));
  el.addEventListener('click', onTap);
  return el;
}

function rangeRow(
  label: string,
  current: Range,
  presets: Preset[],
  apply: (r: Range) => void,
): HTMLElement {
  return h(
    'div',
    { class: 'fg-range' },
    h('div', { class: 'fg-sub' }, label),
    pillGroup(
      ...presets.map((p) =>
        selectPill(p.label, rangeEq(p.range, current), () => apply(rangeEq(p.range, current) ? UNBOUNDED : p.range)),
      ),
    ),
  );
}

/**
 * The exclusion disclosure, as a filter group.
 *
 * Two display rules keep things out of the default list: subdivision streets that are
 * tagged as tracks, and named fragments shorter than the display floor. Silent filtering
 * is not acceptable here, because in Lake of the Ozarks the share of named path features
 * that are resort streets IS the finding. The reader can put them back in one tap.
 */
function hiddenGroup(ctx: Ctx): HTMLElement | null {
  const { roadCount, shortCount, excludedCount, floorM } = ctx.display;
  if (excludedCount === 0) return null;

  // With one reason the leading count already covers it, so repeating the number reads as
  // a bug ("25 trails ... : 25 shorter than 200 m").
  const reasons: string[] = [];
  const only = (roadCount > 0 ? 1 : 0) + (shortCount > 0 ? 1 : 0) === 1;
  if (roadCount > 0) reasons.push(only ? 'all named like subdivision streets rather than trails' : `${roadCount} named like subdivision streets rather than trails`);
  if (shortCount > 0) reasons.push(only ? `all shorter than ${floorM} m` : `${shortCount} shorter than ${floorM} m`);

  const toggle = h(
    'button',
    { type: 'button', class: `sel-pill${ctx.ui.includeExcluded ? ' on' : ''}` },
    ctx.ui.includeExcluded ? 'Showing them' : 'Show them anyway',
  );
  toggle.setAttribute('aria-pressed', String(ctx.ui.includeExcluded));
  toggle.addEventListener('click', () => ctx.setUi({ includeExcluded: !ctx.ui.includeExcluded }));

  return h(
    'section',
    { class: 'fg', id: 'fg-hidden' },
    h('div', { class: 'fg-head' }, h('div', { class: 'fg-title' }, 'Hidden from results')),
    h('p', { class: 'fg-note' }, `${excludedCount} paths in ${ctx.region.name} are out of the default list: ${reasons.join(', ')}.`),
    pillGroup(toggle),
    // The closing line was about the pipeline (the highway tag, the merge, three-metre
    // fragments). What the reader of a filter sheet needs is what turning this on does to
    // their list, so that is what it says now.
    roadCount > 0
      ? h('p', { class: 'fg-note' }, 'Nothing is deleted. Turn this on to see them alongside the trails.')
      : h('p', { class: 'fg-note' }, 'Nothing is deleted. Turn this on to see every named path, however short.'),
  );
}

export function filterSheet(ctx: Ctx): HTMLElement {
  const f = ctx.state.filters;
  const set = (next: Partial<Filters>): void => ctx.set({ filters: { ...f, ...next } });
  const units = ctx.units;

  const close = (): void => ctx.setUi({ sheet: null });

  // ---- conditions ----------------------------------------------------------
  //
  // Every chip here is evaluated on the day selected in the day bar. That was always true
  // of the mechanics; the labels used to say otherwise, which is why they no longer name a
  // day at all.
  //
  // PAST THE HORIZON THIS GROUP SPLITS IN TWO, and the split is the page's whole argument
  // restated for free. Three of the five chips read the forecast, so past +36 h they answer
  // a coarser question than their label promises and each says so in its own help line. Two
  // of them, Below treeline and Shaded, are terrain facts computed from the route's own
  // profile against the regional treeline. They involve no forecast at all and mean exactly
  // the same thing on the first day and on the last.
  //
  // That is the terrain half of the grade being real and the weather half being the half
  // with a horizon, demonstrated in the product rather than asserted in prose. It costs two
  // subheadings, and only on the days where it is true: inside the horizon the group renders
  // as a flat list exactly as before.
  const outlookFrom = firstOutlookDay(ctx.provider);
  // One day for the whole group, because every chip reads the same one: the selected day.
  const dayConfidence: GradeConfidence = ctx.state.day >= outlookFrom ? 'outlook' : 'route-specific';

  const conditionRow = (cf: (typeof CONDITION_FILTERS)[number]): HTMLElement => {
    const degraded = conditionFilterDegraded(cf.id, dayConfidence);
    const row = optionRow(
      cf.label,
      f.conditions.includes(cf.id),
      () => set({ conditions: toggle(f.conditions, cf.id) }),
      degraded ? (cf.coarseHelp ?? cf.help) : cf.help,
      undefined,
      degraded ? 'coarse' : undefined,
    );
    if (degraded) row.classList.add('is-coarse');
    return row;
  };

  const degradedNow = CONDITION_FILTERS.filter((cf) => conditionFilterDegraded(cf.id, dayConfidence));
  const exactNow = CONDITION_FILTERS.filter((cf) => !conditionFilterDegraded(cf.id, dayConfidence));

  const conditions = h(
    'section',
    { class: 'fg', id: 'fg-conditions' },
    groupHead('Conditions', f.conditions.length, () => ctx.set({ filters: clearedGroup(f, 'conditions') })),
    // Was: "The dimension AllTrails does not filter on." A product does not name a
    // competitor in its own filter sheet; that line is a positioning claim and it belongs
    // in the prose column. What it says instead is the binding: these are the day's
    // conditions, and the day is the one the reader picked.
    h('p', { class: 'fg-note' }, 'Graded along each route, for the day you picked.'),
    ...(degradedNow.length === 0
      ? [...CONDITION_FILTERS.map(conditionRow)]
      : [
          h('div', { class: 'fg-sub' }, 'Still exact', h('span', { class: 'fg-tag' }, 'terrain')),
          h('p', { class: 'fg-note' }, 'Read from the route itself, so these do not change with the forecast.'),
          ...exactNow.map(conditionRow),
          h('div', { class: 'fg-sub' }, 'Coarser on this day', h('span', { class: 'fg-tag' }, 'forecast')),
          h('p', { class: 'fg-note' }, `Beyond the ${Math.round(ctx.provider.horizonHours)} hour forecast these read the regional outlook rather than the route, so they still answer, just less precisely.`),
          ...degradedNow.map(conditionRow),
        ]),
  );

  // ---- effort --------------------------------------------------------------
  const effort = h(
    'section',
    { class: 'fg', id: 'fg-effort' },
    groupHead('Effort', effortCount(f), () => ctx.set({ filters: clearedGroup(f, 'effort') })),
    h('div', { class: 'fg-sub' }, 'Difficulty', h('span', { class: 'fg-tag' }, 'computed')),
    pillGroup(
      ...(['easy', 'moderate', 'hard'] as Difficulty[]).map((d) =>
        selectPill(DIFFICULTY_LABEL[d], f.difficulty.includes(d), () => set({ difficulty: toggle(f.difficulty, d) })),
      ),
    ),
    h(
      'p',
      { class: 'fg-note' },
      'Calculated from elevation gain and length, on the National Park Service scale. The same trail always rates the same.',
    ),
    rangeRow('Length', f.lengthM, lengthPresets(units), (r) => set({ lengthM: r })),
    rangeRow('Elevation gain', f.gainM, gainPresets(units), (r) => set({ gainM: r })),
    rangeRow('Max elevation', f.maxElevM, maxElevPresets(ctx.pool, units), (r) => set({ maxElevM: r })),
    h(
      'p',
      { class: 'fg-note' },
      `How high a route goes decides how exposed it is when a storm builds. Treeline here is ${formatElevation(ctx.region.treelineM, units)}.`,
    ),
    rangeRow('Estimated time', f.estMinutes, timePresets(), (r) => set({ estMinutes: r })),
  );

  // ---- character -----------------------------------------------------------
  const surfaces = regionSurfaces(ctx.state.region);
  const character = h(
    'section',
    { class: 'fg', id: 'fg-character' },
    groupHead('Character', characterCount(f), () => ctx.set({ filters: clearedGroup(f, 'character') })),
    h('div', { class: 'fg-sub' }, 'Activity'),
    pillGroup(
      ...(['hike', 'run', 'bike'] as Activity[]).map((a) =>
        selectPill(ACTIVITY_LABEL[a], f.activities.includes(a), () => set({ activities: toggle(f.activities, a) })),
      ),
      ...OUT_OF_SCOPE_ACTIVITIES.map((label) => {
        const el = h('button', { type: 'button', class: 'sel-pill is-out', disabled: true }, label);
        el.setAttribute('aria-disabled', 'true');
        return el;
      }),
    ),
    // The winter pills are visibly present and visibly off, which is the product statement.
    // Why they are off (the science response defers snow state) is a prose-column argument
    // and used to be printed here; a hiker filtering for a bike ride does not need it.
    h('p', { class: 'fg-note' }, 'Skiing and snowboarding arrive with the winter release.'),
    h('div', { class: 'fg-sub' }, 'Route type'),
    pillGroup(
      ...(['loop', 'point-to-point'] as RouteType[]).map((r) =>
        selectPill(ROUTE_TYPE_LABEL[r], f.routeTypes.includes(r), () => set({ routeTypes: toggle(f.routeTypes, r) })),
      ),
    ),
    h('div', { class: 'fg-sub' }, 'Surface'),
    pillGroup(
      ...surfaces.map((s) => selectPill(s.replace(/_/g, ' '), f.surfaces.includes(s), () => set({ surfaces: toggle(f.surfaces, s) }))),
    ),
    h(
      'p',
      { class: 'fg-note' },
      `Surface is what decides how fast a trail dries out. ${Math.round((ctx.pool.filter((t) => t.surface).length / Math.max(1, ctx.pool.length)) * 100)}% of trails here have it recorded.`,
    ),
  );

  // ---- what the display rules removed ---------------------------------------
  //
  // This disclosure used to sit under the result count, on the strip the reader crosses on
  // the way to the first card. It is a real disclosure and the exclusions ARE the finding
  // (src/scope/data.ts), so it has not been dropped: it moved here, because a rule about
  // what is and is not in the list is a filter, and this is the filter sheet.
  const hidden = hiddenGroup(ctx);

  const clearAll = h('button', { type: 'button', class: 'sh-action' }, 'Clear all');
  clearAll.addEventListener('click', () => ctx.set({ filters: emptyFilters() }));

  const n = ctx.filteredCount;
  const apply = h(
    'button',
    { type: 'button', class: 'sh-apply' },
    n === 0 ? 'No trails match' : `Show ${n} trail${n === 1 ? '' : 's'}`,
  );
  apply.addEventListener('click', close);
  if (n === 0) apply.classList.add('is-empty');

  const el = sheet(
    {
      title: 'Filters',
      action: activeFilterCount(f) > 0 ? clearAll : null,
      onClose: close,
      footer: h('div', { class: 'sh-foot' }, apply),
      class: 'sh-filters',
    },
    conditions,
    effort,
    character,
    hidden,
  );

  // Open at the group the chip named, without losing the rest of the sheet.
  const target = ctx.ui.filterGroup;
  if (target !== 'conditions') {
    queueMicrotask(() => {
      const body = el.querySelector('.sh-body');
      const sec = el.querySelector(`#fg-${target}`);
      if (body instanceof HTMLElement && sec instanceof HTMLElement) body.scrollTop = sec.offsetTop - 8;
    });
  }
  return el;
}
