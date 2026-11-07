// Trail Scope phone — the results list, the card, and the sort sheet.
//
// THE CARD IS THE POINT. AllTrails' card leads with a hero photo and a star rating, and
// open data has neither. Rather than fake them, this card replaces them with the two
// things AllTrails structurally cannot put on a card (SCOPE_PLAN §1):
//
//   the elevation profile as the hero graphic, broken at seams, tinted by the condition
//   level so a scrolled list reads at a glance, and
//   the conditions pill: tinted, glyphed, and carrying a time.
//
// FIVE THINGS AT MOST: hero, pill, name, rating, and one measures line
// (difficulty, length, gain, time). The card carried eleven before, and the review verdict
// was that the screen was cramped and overloaded. Route type, distance away, the
// best-window line, the elevation range, the parts count and the `computed` badge all came
// off. None of them was wrong; all of them were explanation, and explanation belongs in the
// prose column beside the phone rather than repeated on every card in a scrolling list.
//
// Difficulty was cut in that pass and put back: it is a measure, not an explanation, the
// reference AllTrails row shows it, and it is one of the first things a hiker filters on.
//
// Route type is back too, but not as the full text label that came off in that pass: it is
// a single glyph, and it appears on loops only (ui.ts, `routeTypeGlyph`, has the full
// noise-versus-ambiguity reasoning). Its return is coupled to the time figure right beside
// it: once the row can say a trail is point-to-point, an unlabelled duration reads as the
// whole outing rather than the walk out, so a point-to-point duration is now suffixed
// "one way" (`needsOneWayLabel` in model.ts has the Naismith reasoning). A loop needs
// neither the suffix nor the glyph: the circuit already is the whole walk, and there is
// nothing left to disambiguate.
//
// The rating row is the one part that is not always there. Almost nothing is rated on day
// one, so an unrated card drops the row entirely rather than printing an empty star row or
// repeating "No ratings yet" down eighty rows (the reasoning is in ui.ts, ratingLine). The
// ratings that do appear are seeded (src/scope/ugc.ts); that they are simulated is now said
// in the prose column rather than tagged on every card. See the note in ui.ts.
//
// The header always names the active sort. Ranking is never silent (SCOPE_PLAN §6).

import { h } from '../../ui/dom';
import { conditionPill, difficultyDot, icon, optionRow, profileSparkline, ratingLine, routeTypeGlyph, sheet } from './ui';
import { conditionsRow, frameFor, routeReading } from './conditions';
import {
  DEFAULT_SORT,
  SORTS,
  formatDuration,
  formatElevation,
  formatLength,
  needsOneWayLabel,
} from '../model';
import { getUgc, isRated } from '../ugc';
import { weekdayLabel } from '../weather/provider';
import { firstOutlookDay } from './grading';
import type { Ctx } from './ctx';
import type { ConditionGrade, ScopeTrail, SortId, WeatherProvider, WeatherResult } from '../types';
import type { Units } from '../../types';

// ============================================================================
// THE CARD
// ============================================================================

// The hero is the card's photograph substitute, so it gets photograph-like proportions:
// a third taller than it was, and roughly 3:1, which is enough for a profile to have a
// shape rather than a wobble.
export const HERO_W = 320;
export const HERO_H = 96;

/**
 * "Best window 08:00 to 08:00" is what a twenty minute route produces once both ends round
 * to the hour, and it reads as a bug rather than as a short walk. Below an hour the window
 * is stated as a start, which is the only part that carries advice anyway.
 */
export function bestWindowText(ctx: Ctx, window: { startHour: number; endHour: number }): string {
  const clock = (hoursFromNow: number): string => {
    const abs = Math.round(ctx.provider.now().hourOfDay + hoursFromNow);
    return `${String(((abs % 24) + 24) % 24).padStart(2, '0')}:00`;
  };
  return window.endHour - window.startHour < 1
    ? `Best from ${clock(window.startHour)}`
    : `Best window ${clock(window.startHour)} to ${clock(window.endHour)}`;
}

/**
 * The card's conditions row: the same five fields the area strip carries, measured at the
 * highest point this route's own forecast samples reach (conditions.ts owns the contract).
 *
 * WHY A FIFTH ELEMENT ON A CARD THAT WAS DELIBERATELY CUT TO FOUR. §10's simplification took
 * eleven elements to four because ten of them were explanation. This one is not: it is the
 * measured half of what the pill above it judges, and it is the only thing on the card that
 * can disagree with the area strip at the top of the screen. That disagreement IS the page's
 * argument (a valley reference reads benign while a ridge route does not), and it is the one
 * form of the argument that needs no prose, which is what the frame rule leaves us. It costs
 * one line at the label type scale and it never grows.
 *
 * WHY LAST. It could sit under the pill, pairing the words with the numbers, but that puts two
 * conditions rows between the hero and the trail's own name, and the name is what the reader
 * is scanning for. As the last row it closes the card with measurements next to the other
 * measurements, and the mono treatment keeps it from reading as another verdict.
 *
 * THE STORM NUMBER IS PRINTED ONCE PER CARD, and the pill wins it. A route-specific headline
 * is the only copy on the card that can carry a number, and the only number it can carry is a
 * storm percentage ("70% storms from 13:00"; grade.ts's storm factor is the sole template with
 * a `pct` in it, verified). That percentage is the plan window's peak while this row's is the
 * daytime peak at one point, so printing both would put two nearly-equal storm percentages on
 * one card, which is worse than a stutter: it reads as a contradiction. The pill's version
 * carries the hour the storms arrive, which is the more useful of the two, so the row drops
 * its own storm field on exactly those cards. Resolved card-locally and by omission, never by
 * rewriting `grade.headline`, which the peek and the map also read.
 *
 * PAST THE HORIZON THERE IS NO ROW AT ALL, and that is the honest degradation rather than a
 * gap. Every field here is elevation-specific, and past +36 h the grader refuses all terrain
 * claims by construction (grade.ts's `outlookGrade`: no exposure, no drainage, no hour), so a
 * route-specific readout out there would be a claim the grade itself will not make. The
 * alternative was to keep the row and fill it with the "regional outlook, not hour by hour"
 * note, and that fails the same test the empty rating row failed (ui.ts, `ratingLine`): an
 * apology repeated down eighty cards reads as a broken screen, and the fact is already said
 * once by the day bar, once by the pill's Outlook, once by the faded profile and once by the
 * area strip, which is where a regional statement belongs. The route-specific numbers
 * vanishing at the wall is itself the clearest thing the horizon does to this product.
 */
/*
 * CTX-FREE ON PURPOSE, and exported. The digest page's Day screen draws the same card off a
 * `RegionDigest` rather than off a `Ctx`, and the three rules above (drop the row past the
 * horizon, drop the storm field when the pill already prints one, render the pending state
 * rather than nothing) are exactly the kind of small rule that gets re-implemented slightly
 * differently on a second surface and then disagrees. One function, two callers.
 */
export function cardConditionsRow(
  trail: ScopeTrail,
  weather: WeatherResult | null,
  provider: WeatherProvider,
  units: Units,
  day: number,
  dayLabel: string,
  grade: ConditionGrade | null,
): HTMLElement | null {
  if (frameFor(provider, day) === 'outlook') return null;
  // A null reading renders the row's own pending state rather than nothing, so the card does
  // not change height when the provider call lands a frame later. Same reasoning as the
  // pill's "Grading" state, which is the other half of the same wait.
  const reading = weather ? routeReading(trail, weather, provider, day) : null;
  return conditionsRow(reading, units, {
    omitStorm: grade?.headline.includes('%') ?? false,
    lead: `On this route ${day === 0 ? 'now' : `for ${dayLabel} daytime`}`,
    class: 'cr-card',
  });
}

export function trailCard(ctx: Ctx, trail: ScopeTrail, opts: { onOpen: () => void } ): HTMLElement {
  const grade = ctx.grade(trail);
  const units = ctx.units;
  const outlook = grade?.confidence === 'outlook';
  const ugc = getUgc(trail.id);

  // The only thing left overlaying the hero. A subdivision street that reached the list
  // is a data-quality claim the reader has to see on the row itself, because it changes
  // what the whole card means; the elevation range and the parts count did not.
  const hero = h(
    'div',
    { class: 'card-hero' },
    profileSparkline(trail, {
      w: HERO_W,
      h: HERO_H,
      level: grade ? grade.level : null,
      outlook,
    }),
    trail.likelyRoad ? h('div', { class: 'hero-tags' }, h('span', { class: 'hero-tag is-warn' }, 'looks like a road')) : null,
  );

  // Difficulty is back on the card. It came off with the `computed` badge during the
  // simplification pass, which went one element too far: the reference AllTrails row shows
  // it, it is one of the first things a hiker filters on, and unlike the badge it is a
  // measure rather than an explanation. The badge stays gone; the page prose says once
  // that difficulty is computed rather than curated.
  // A point-to-point duration carries its own qualifier now that the row can also state the
  // type (below): "one way" rather than a bare figure a reader would otherwise assume covers
  // the whole outing. See `needsOneWayLabel` for why this is a label and never a multiplier.
  const oneWay = needsOneWayLabel(trail.routeType);
  const loopGlyph = routeTypeGlyph(trail.routeType);
  const meta = h(
    'div',
    { class: 'card-meta' },
    // `label: false` drops the `computed` tag. It belongs on the peek, where a reader is
    // deciding, not repeated down a scrolling list; the prose says it once.
    difficultyDot(trail.difficulty, { label: false }),
    h('span', { class: 'cm-dot' }, '·'),
    h('span', {}, formatLength(trail.lengthM, units)),
    h('span', { class: 'cm-dot' }, '·'),
    h('span', { class: 'cm-gain' }, icon('up', 13), formatElevation(trail.gainM, units)),
    h('span', { class: 'cm-dot' }, '·'),
    h('span', {}, formatDuration(trail.estMinutes) + (oneWay ? ' one way' : '')),
    // The loop glyph is the row's only conditional item: absent on point-to-point (95
    // percent of RMNP's display set), present with its own separator on the 5 percent that
    // are loops. Nothing else in the row shifts either way.
    loopGlyph ? h('span', { class: 'cm-dot' }, '·') : null,
    loopGlyph,
  );

  const card = h(
    'article',
    { class: 'card' },
    hero,
    conditionPill(grade),
    h('h3', { class: 'card-name' }, trail.name),
    ratingLine(ugc.ratingAvg, ugc.ratingCount),
    meta,
    cardConditionsRow(
      trail,
      ctx.weather(trail),
      ctx.provider,
      ctx.units,
      ctx.state.day,
      dayName(ctx, ctx.state.day),
      grade,
    ),
  );
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.dataset.trail = trail.id;
  card.addEventListener('click', opts.onOpen);
  card.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      opts.onOpen();
    }
  });
  return card;
}

// ============================================================================
// THE LIST
// ============================================================================

function sortLabel(id: SortId): string {
  return SORTS.find((s) => s.id === id)?.label ?? SORTS[0].label;
}

/**
 * The selected day, named the way the day bar names it: Today, Tomorrow, then a weekday.
 * Derived from the provider's own day index rather than a fixed list, so it keeps working
 * whatever the day bar's length is.
 */
export function dayName(ctx: Ctx, day: number): string {
  if (day === 0) return 'Today';
  if (day === 1) return 'Tomorrow';
  return weekdayLabel(ctx.provider.now().dayIndex + day).slice(0, 3);
}

/**
 * What the header says the list is ordered by.
 *
 * A conditions sort ranks on a grade FOR A DAY, and which day is the day bar's answer, not
 * the sort's. So the sort labels carry no day (Best conditions, Conditions only) and the
 * header restates the binding: "Best for Tomorrow". Both conditions sorts stay
 * distinguishable here, because a header that read the same for two different orderings
 * would be exactly the silent ranking this page argues against.
 */
export function orderLabel(ctx: Ctx, sort: SortId): string {
  const when = dayName(ctx, ctx.state.day);
  if (sort === 'best-conditions') return `Best for ${when}`;
  if (sort === 'conditions-only') return `Conditions only, for ${when}`;
  return sortLabel(sort);
}

/**
 * Conditions-based sorts are meaningless past the forecast horizon, and the reason is now
 * sharper than "no grade exists". A grade DOES exist out there: the grader returns a real
 * prime / mixed / poor from the regional air mass. But it is REGIONAL, so every route in
 * the region shares it, and a key every row ties on is not a ranking. Rather than silently
 * ordering by it, the header names the fallback.
 */
export const CONDITION_SORTS: SortId[] = ['best-conditions', 'conditions-only'];

export function sortIsUnavailable(ctx: Ctx): boolean {
  return ctx.state.day >= firstOutlookDay(ctx.provider) && CONDITION_SORTS.includes(ctx.state.sort);
}

/** What the list is actually ordered by once the conditions sort falls away. */
export const OUTLOOK_FALLBACK_SORT: SortId = 'closest';

/**
 * How many of the current results carry a seeded rating. Cheap: the seed is memoised per
 * trail id, so this is a map lookup per row.
 */
function ratedCount(ctx: Ctx): number {
  let n = 0;
  for (const t of ctx.results) if (isRated(t.id)) n++;
  return n;
}

export function listHeader(ctx: Ctx): HTMLElement {
  const n = ctx.results.length;
  const fellBack = sortIsUnavailable(ctx);
  const shownSort = fellBack ? OUTLOOK_FALLBACK_SORT : ctx.state.sort;
  // Top rated has to say out loud what it does with the unrated majority, because that IS
  // most of the list. A sort that silently buries eighty of eighty-seven rows is exactly
  // the unexplained ranking this page argues against.
  const rated = shownSort === 'top-rated' ? ratedCount(ctx) : 0;

  // A conditions sort names its day here and drops the "sorted by" lead-in, because "87
  // trails, best for Tomorrow" is one statement and "sorted by Best conditions for
  // Tomorrow" is three. Everything else keeps the plain form.
  const conditionsActive = CONDITION_SORTS.includes(shownSort);

  const sortBtn = h(
    'button',
    { type: 'button', class: 'lh-sort' + (fellBack ? ' is-fallback' : '') },
    h('span', { class: 'lh-sort-label' }, orderLabel(ctx, shownSort)),
    icon('chevron', 13),
  );
  sortBtn.addEventListener('click', () => ctx.setUi({ sheet: 'sort' }));

  // The exclusion disclosure used to live here. It is a real disclosure and has not been
  // dropped: it moved into the filter sheet, where a rule about what is in the list
  // belongs, and off the one strip the reader reads on the way to the first card.
  return h(
    'div',
    { class: 'list-head' },
    h(
      'div',
      { class: 'lh-row' },
      h('span', { class: 'lh-count' }, `${n} trail${n === 1 ? '' : 's'}`),
      conditionsActive ? h('span', { class: 'lh-sorted is-dot' }, '·') : h('span', { class: 'lh-sorted' }, 'sorted by'),
      sortBtn,
    ),
    fellBack
      ? h(
          'div',
          { class: 'lh-fallback' },
          `Beyond the ${Math.round(ctx.provider.horizonHours)} hour forecast every trail shares one regional outlook, so ${sortLabel(ctx.state.sort)} has nothing to rank on.`,
        )
      : null,
    shownSort === 'top-rated' && !fellBack
      ? h('div', { class: 'lh-note' }, `${rated} of ${n} are rated. Unrated trails follow below.`)
      : null,
  );
}

export function resultsList(ctx: Ctx, onOpen: (t: ScopeTrail) => void): HTMLElement {
  if (ctx.results.length === 0) {
    return h(
      'div',
      { class: 'empty-state' },
      icon('search', 22, 'es-glyph'),
      h('div', { class: 'es-title' }, 'Nothing matches'),
      h(
        'div',
        { class: 'es-body' },
        ctx.state.query
          ? `No trail in ${ctx.region.name} matches "${ctx.state.query}" with the current filters.`
          : 'Every trail in this region is filtered out. Loosen a filter to see results.',
      ),
    );
  }

  // Top rated splits the list in two, so the list draws the seam rather than leaving the
  // reader to notice that the stars stopped. Below the divider nothing is ranked by
  // rating, and the divider says which rows those are and how many.
  const splitAt =
    ctx.state.sort === 'top-rated' && !sortIsUnavailable(ctx)
      ? ctx.results.findIndex((t) => !isRated(t.id))
      : -1;
  const split = splitAt > 0 && splitAt < ctx.results.length ? splitAt : -1;

  const rows: (HTMLElement | null)[] = [];
  ctx.results.forEach((t, i) => {
    if (i === split) {
      const rest = ctx.results.length - split;
      rows.push(
        h(
          'div',
          { class: 'list-split' },
          h('span', { class: 'ls-label' }, 'No ratings yet'),
          h('span', { class: 'ls-note' }, `${rest} trail${rest === 1 ? '' : 's'}, in the usual order`),
        ),
      );
    }
    rows.push(trailCard(ctx, t, { onOpen: () => onOpen(t) }));
  });

  return h('div', { class: 'card-list' }, ...rows);
}

// ============================================================================
// THE SORT SHEET
// ============================================================================

/**
 * What each sort does, in the reader's language.
 *
 * These lines used to describe the IMPLEMENTATION: "a prominence proxy", "sample rating",
 * "straight line from the assumed location". Every one of them is true and every one of
 * them belongs in the prose column beside the phone, not in a sheet a hiker opens to pick
 * an order. A sort description says what the list will look like afterwards.
 */
const SORT_HELP: Record<SortId, string> = {
  'best-conditions': 'Best conditions on the day you picked, then the better known trails, then the closest',
  'conditions-only': 'Conditions on the day you picked, and nothing else',
  'top-rated': 'Highest rated first',
  closest: 'Nearest to you first',
  shortest: 'Shortest first',
  longest: 'Longest first',
  'least-gain': 'Least climbing first',
  'most-gain': 'Most climbing first',
  easiest: 'Easiest first',
  hardest: 'Hardest first',
};

const SORT_GLYPH: Record<SortId, string> = {
  'best-conditions': 'sun',
  'conditions-only': 'suncloud',
  'top-rated': 'star',
  closest: 'locate',
  shortest: 'ruler',
  longest: 'ruler',
  'least-gain': 'down',
  'most-gain': 'up',
  easiest: 'peak',
  hardest: 'peak',
};

export function sortSheet(ctx: Ctx): HTMLElement {
  const close = (): void => ctx.setUi({ sheet: null });
  const pastHorizon = ctx.state.day >= firstOutlookDay(ctx.provider);
  const reset = h('button', { type: 'button', class: 'sh-action' }, 'Reset');
  reset.addEventListener('click', () => ctx.set({ sort: DEFAULT_SORT }));

  return sheet(
    {
      title: 'Sort',
      action: ctx.state.sort === DEFAULT_SORT ? null : reset,
      onClose: close,
      class: 'sh-sort',
    },
    ...SORTS.map((s) => {
      // Past the horizon the grade is regional, so every route ties and the conditions
      // sorts have nothing to rank on. Show them as unavailable with the reason, rather
      // than letting a tap silently do nothing.
      const unavailable = pastHorizon && CONDITION_SORTS.includes(s.id);
      const row = optionRow(
        s.label,
        !unavailable && ctx.state.sort === s.id,
        () => {
          if (unavailable) return;
          ctx.set({ sort: s.id });
          close();
        },
        unavailable
          ? `Beyond the ${Math.round(ctx.provider.horizonHours)} hour forecast, every trail shares one regional outlook`
          : SORT_HELP[s.id],
        SORT_GLYPH[s.id],
      );
      if (unavailable) {
        row.classList.add('is-unavailable');
        row.setAttribute('aria-disabled', 'true');
      }
      return row;
    }),
  );
}
