// Trail Scope phone — the trail peek (screen 5).
//
// The smallest thing that supports a go or no-go decision, ordered VERDICT FIRST:
//
//   1. name and core measures      what the route is
//   1b. how you're walking it      one way / incl. return, or clockwise / counterclockwise
//   2. the conditions brief        what the grade means, then the facts that made it
//   3. the week on this trail      which day, if not this one
//   4. the time window             when to go
//   5. the elevation profile       what it will feel like, treeline marked
//   5b. the trail on a map         where it is, tilted, tinted by the same verdict
//   6. ratings and photos          what other people who went say
//
// STEP 2 USED TO BE A SENTENCE AND A SEPARATE FACTOR BLOCK AT STEP 6. Review asked for a
// structured, scannable brief rather than a paragraph, and the honest way to give it one
// was to merge the two: the paragraph was built from the same factors the block listed, so
// running both was the sheet stating every reason twice at two lengths. The brief is now
// one block — the level's gloss, then one line per fact with its own time and glyph,
// ordered by the penalty each fact actually contributes — and it leads with the best
// window, which used to sit under a title two blocks down. `briefLines` carries the full
// de-duplication note.
//
// 1b IS THE ONE CONTROL THAT CHANGES THE VERDICT ITSELF, not just how it is worded. A
// scrolling card list has no room to ask how a reader means to walk a trail, so the peek is
// the only place that can, and everything from here down — the duration in the measures
// row, the grade, the best-window timeline, the driving factors, the profile shape — reads
// the SAME per-trail selection (`traversalFor`, module state keyed by trail id). The
// results list, the map, the sort and the filters never see it: they grade at each trail's
// own default (`defaultGradeTraversal` in `weather/grade.ts`), so a choice made in one
// peek can never silently re-rank the list behind it. See `peekGrade` below, which is the
// one seam between "the app's shared grade" (`ctx.grade`, default-traversal, used
// everywhere else) and "this peek's own" (traversal-aware, used only in this file).
//
// That order is the answer to two pieces of stakeholder feedback on the first cut. The
// grade word appeared with no definition at point of use ("what does Prime mean?"), and
// the hourly strip led with storm probability, which is the provider's rawest signal
// rather than the question a reader actually arrives with ("when should I go?"). So the
// level word is still never rendered without a plain-language gloss beside it, and storms
// are still one line among six in the brief plus the shading and tooltips of the cells,
// never the frame the sheet is read through.
//
// TWO HONESTY RULES, unchanged by the reorder.
//
// 1. The strip plots the PROVIDER's own hourly values. It does not re-derive the grade per
//    hour: the grade is a route-and-day judgement and inventing an hourly version of it
//    here would put a second, differently-computed answer next to the pill on the same
//    sheet. The brief is built from the SAME `ConditionGrade` the pill reads, never from a
//    second pass over the weather.
// 2. Past the provider's horizon there is no strip at all. Drawing hourly cells for a day
//    the model cannot resolve would be exactly the false precision the whole page argues
//    against, so that day gets a sentence instead.
//
// COPY REGISTER: everything inside the phone frame reads as a real product. No method
// notes, no data-source names, no counts of parts or sample points. Where the prototype
// has a limit worth stating, it is stated in the prose column beside the phone, not in the
// product's own voice.

import { h } from '../../ui/dom';
import {
  PRECIP_FLOOR_MM,
  conditionPill,
  difficultyDot,
  dragScroll,
  icon,
  measure,
  profileSparkline,
  starGlyphs,
  starPicker,
} from './ui';
import { bestWindowText } from './list';
import { conditionsRow, frameFor, routeSpread } from './conditions';
import { SCRUB_DAYS, ensureGrades, firstOutlookDay, gradeOf } from './grading';
import { PhoneMap, trailFeature, treelineExposedFeature } from './pmap';
import {
  formatDuration,
  formatElevation,
  formatLength,
  formatPercent,
  formatPrecip,
  formatTemp,
  hasTreeline,
} from '../model';
import { hasDescent } from '../data';
import { defaultGradeTraversal, roundTripHours, terrainFacts } from '../weather/grade';
import {
  addComment,
  addPhoto,
  clearUgcDraft,
  getUgc,
  setMyRating,
  setUgcDraft,
  ugcDraft,
} from '../ugc';
import { clockLabel, weekdayLabel } from '../weather/provider';
import type { Ctx } from './ctx';
import type { GradeTraversal } from '../weather/grade';
import type {
  ConditionFactor,
  ConditionGrade,
  GradeLevel,
  RouteType,
  ScopeTrail,
  UgcComment,
  UgcPhoto,
  WeatherResult,
  WeatherSample,
} from '../types';

const STRIP_FROM = 6;
const STRIP_TO = 20;

/**
 * One glyph per factor kind, and every one of them a WEATHER OR TERRAIN glyph.
 *
 * LUCIDE, NOT EMOJI, and that is a decision rather than a default. Emoji was floated for the
 * brief and is the wrong call here for three reasons that all point the same way: this app
 * has one deliberate visual language (Lucide paths on a 24x24 grid, inlined, plus IBM Plex
 * Mono — see the ICONS block in ui.ts), an emoji renders as a different picture on every
 * platform and as a colour blob inside an otherwise two-ink interface, and this page gets
 * screenshotted into a deck where whichever machine took the screenshot would decide what
 * the brief looks like. A structured brief gains its scannability from the leading mark
 * being consistent and aligned, which is exactly what a glyph set does and emoji does not.
 *
 * NOTHING HERE IS A WARNING MARK. No triangle, no shield, no exclamation. `TRAIL_PLAN.md`
 * §1 records the pure-mapping decision and states its cost: the screen says what the
 * conditions are and when, and does not name a hazard or tell anyone what to avoid. The
 * brief is the same promise in a denser format, so the vocabulary is sky, mountain,
 * thermometer, wind, water and sunset — the things being measured, never a judgement about
 * them.
 *
 * These moved when the brief replaced the old factor list, and the move is the point: in
 * that list the glyph sat BEFORE a text label ("Wetness", "Storms") which carried the
 * meaning, so a loose glyph cost nothing. Here the glyph IS the label, so `wetness` reading
 * as a sun-behind-cloud and `wind` reading as the same glyph as wetness are both defects
 * the old layout hid. Every entry now names its own kind, and no two kinds share a glyph.
 */
const FACTOR_GLYPH: Record<ConditionFactor['kind'], string> = {
  wetness: 'droplets',
  storm: 'bolt',
  exposure: 'peak',
  heat: 'thermometer',
  wind: 'wind',
  // Sunset, not the clock: the daylight factor's own `fromHour` IS sunset (grade.ts), and
  // the clock belongs to the best-window line at the top of the brief, which must not be
  // mistaken for one of the factors under it.
  daylight: 'sunset',
};

/**
 * The reassurance glyph, for a factor that is present but not pushing the grade down.
 *
 * `grade.ts` pushes exactly two clauses with a hard-coded sub-1 penalty — "dry underfoot"
 * at 0.4 and "settled through the afternoon" at 0.3 (plus the outlook fallback "settled
 * across the area", also 0.3) — and both are there to say a thing is FINE. A lightning bolt
 * beside "settled through the afternoon" reads as its opposite. Keyed off the penalty rather
 * than off the string, so a new reassurance clause is covered the day it is written.
 */
const REASSURANCE_MAX_PENALTY = 1;

function factorGlyph(f: ConditionFactor): string {
  return f.penalty < REASSURANCE_MAX_PENALTY ? 'sun' : FACTOR_GLYPH[f.kind];
}

/**
 * The kind, as a word. No longer printed: the glyph carries it, and a mono "WETNESS"
 * column beside "wet underfoot from Tuesday rain" was the category stated twice on one
 * line. It survives as the ACCESSIBLE NAME for the line, because `icon()` sets
 * `aria-hidden` on every glyph it makes and a screen reader would otherwise get a bare
 * clause with no idea what kind of thing it is about. Same test TRAIL_PLAN §13 applied to
 * Concept C's row glyph: it earns a name if it says something the text does not.
 */
const FACTOR_LABEL: Record<ConditionFactor['kind'], string> = {
  wetness: 'Wetness',
  storm: 'Storms',
  exposure: 'Exposure',
  heat: 'Heat',
  wind: 'Wind',
  daylight: 'Daylight',
};

// ============================================================================
// TRAVERSAL — how you're walking it
// ============================================================================
//
// The one control the discovery page has no other room for: a scrolling card list cannot
// ask how a reader means to walk a trail, and the peek is the only screen with a reader's
// full attention on one route. `routeType` decides which two options exist, exactly as
// `src/trail/journey.ts`'s `Traversal` argues for trail mode — a single OSM geometry
// carries no record of turning around or of which stored direction is clockwise, so those
// are choices, never derived facts.
//
// `GradeTraversal` (imported from `weather/grade.ts`) is shared with the grading pipeline
// on purpose: it is the same four values threaded into `terrainFacts`/`gradeTrail`, so a
// selection made here and a duration computed there can never drift onto two different
// vocabularies. Only the LABELS are peek-specific, and deliberately not a re-import of
// `journey.ts`'s `TRAVERSAL_LABEL`: Björn's wording is "one way or incl return", not trail
// mode's "Out and back", and "Counterclockwise" rather than trail mode's "Anticlockwise"
// (this is a US-facing product on a CONUS-only forecast domain). Reconciling the two is
// tracked as debt on the trail-mode side, not fixed here.
//
// STATE IS PER TRAIL AND LIVES HERE, keyed by trail id in module state rather than folded
// into `PhoneState`: a choice made in one trail's peek must not leak into the card list
// (which keeps showing every trail at its own default, unconditionally — see
// `defaultGradeTraversal`) or into another trail's peek.
const traversalByTrail = new Map<string, GradeTraversal>();

/** Default first, so `traversalFor`'s fallback and the grading pipeline's default can
 *  never name two different traversals for the same trail. */
function traversalOptionsFor(routeType: RouteType): GradeTraversal[] {
  const def = defaultGradeTraversal(routeType);
  const other: GradeTraversal =
    routeType === 'loop' ? (def === 'cw' ? 'ccw' : 'cw') : def === 'incl-return' ? 'one-way' : 'incl-return';
  return [def, other];
}

const TRAVERSAL_LABEL: Record<GradeTraversal, string> = {
  'one-way': 'One way',
  'incl-return': 'Incl. return',
  cw: 'Clockwise',
  ccw: 'Counterclockwise',
};

/** This trail's current selection, clamped to what its own `routeType` supports (a stale
 *  selection cannot survive a trail swap, since the map is keyed by id, but a defensive
 *  clamp costs nothing and matches `journey.ts`'s own `normalizeTraversal`). */
function traversalFor(trail: ScopeTrail): GradeTraversal {
  const options = traversalOptionsFor(trail.routeType);
  const stored = traversalByTrail.get(trail.id);
  return stored && options.includes(stored) ? stored : options[0];
}

function traversalRow(ctx: Ctx, trail: ScopeTrail): HTMLElement {
  const current = traversalFor(trail);
  const options = traversalOptionsFor(trail.routeType);
  return h(
    'div',
    { class: 'trav-row', role: 'group', 'aria-label': 'How you plan to walk this route' },
    ...options.map((opt) => {
      const on = opt === current;
      const btn = h('button', { type: 'button', class: `trav-btn${on ? ' on' : ''}` }, TRAVERSAL_LABEL[opt]);
      btn.setAttribute('aria-pressed', String(on));
      btn.addEventListener('click', () => {
        if (opt === current) return;
        traversalByTrail.set(trail.id, opt);
        // Nothing in PhoneState changed, so nothing else needs telling: `setUi({})` is the
        // same no-op patch `weekRow`'s own fill uses purely to trigger a re-render.
        ctx.setUi({});
      });
      return btn;
    }),
  );
}

/**
 * THE ONE SEAM between the app's shared grade (`ctx.grade`, always default-traversal,
 * read by the list, the map, the sort and the filters) and this peek's own. Every other
 * screen must keep reading `ctx.grade` unchanged; only this file calls this instead, and
 * only for the trail currently open in it.
 */
function peekGrade(ctx: Ctx, trail: ScopeTrail, day: number = ctx.state.day): ConditionGrade | null {
  return gradeOf(ctx.state.scenario, ctx.state.region, trail, day, traversalFor(trail));
}

/**
 * Duration for the measures row, following the selection. `routeType === 'loop'` and
 * `'one-way'` both read the same one-way Naismith figure (`trail.estMinutes`) the card
 * shows, so nothing here can disagree with the card for the case the card also claims.
 * `'incl-return'` uses `roundTripHours` — the SAME function `terrainFacts` calls to grade
 * the whole outing — so the number on screen and the number the grade was computed from
 * can never drift apart.
 */
function peekDuration(trail: ScopeTrail, traversal: GradeTraversal): { minutes: number; label: string } {
  if (trail.routeType === 'loop') return { minutes: trail.estMinutes, label: 'Est. time' };
  if (traversal === 'one-way') return { minutes: trail.estMinutes, label: 'Est. time, one way' };
  return { minutes: Math.round(roundTripHours(trail) * 60), label: 'Est. time' };
}

/**
 * The conditions readout, and the one place in the app that shows a route's own SPREAD.
 *
 * The card shows one reading, at the route's high point, because a card has room for one
 * (conditions.ts, `routeReading`). The sheet has room for two, and prints both ends: the
 * lowest sampled point and the highest, each naming its own elevation. Two reasons, and the
 * second is why this earns space next to a factor list that already discusses the weather.
 *
 * The SPREAD is within-route variation, which is the one thing a point forecast structurally
 * cannot produce and the thing this whole prototype argues for. Nine degrees between a
 * trailhead and a summit on the same trail, at the same minute, is the argument made in two
 * lines rather than asserted in prose. And where the factor list INTERPRETS the route as a
 * whole ("60% storms from 13:00"), these MEASURE two named places, so the two are answering
 * different questions rather than repeating one.
 *
 * A low-relief route collapses to a single row (`routeSpread` returns a null `high`), because
 * two identical readings would invent a contrast that is not in the data.
 *
 * STORMS ARE OMITTED whenever the brief below already prints a storm percentage — the same
 * rule and the same reason as the card's row, one fact one place on a sheet, with the OWNER
 * of that number moved. It used to test `grade.headline.includes('%')`, which was already
 * vestigial: the pill in this sheet is `levelOnly`, so the headline is not printed here at
 * all, and the test was standing in for "the top clause has a percentage in it" by accident.
 * Now it asks the brief directly what the brief is about to say, and the brief either carries
 * the percentage in its storm clause ("60% storms from 13:00") or in that line's measure
 * ("peaks 46% at 16:00"). Either way this row stands down on that one field.
 *
 * The spread survives that omission intact, because what actually differs between a trailhead
 * and a summit is temperature and wind, not usually convection, which is regional — and
 * temperature and wind are exactly the two fields this row KEEPS and the brief's own measures
 * defer to it on (see `factorMeasure`). The two blocks divide the numbers rather than sharing
 * them: this row owns the magnitudes at two named places, the brief owns the hours.
 *
 * PAST THE HORIZON there is no row at all, matching the card. Every field here is
 * elevation-specific, and out there the grader itself refuses all terrain claims
 * (grade.ts, `outlookGrade`), so a route-specific readout would be a claim the grade will not
 * make. The area strip is where a regional statement belongs and it keeps making one.
 *
 * The TRAVERSAL selection deliberately does not change these numbers. It changes which hours
 * the grade weighs, not where the route's two ends are, and a readout that moved when the
 * reader chose "one way" would imply the mountain had moved with it.
 */
function peekConditions(ctx: Ctx, trail: ScopeTrail, brief: BriefLine[]): HTMLElement | null {
  if (frameFor(ctx.provider, ctx.state.day) === 'outlook') return null;
  const weather = ctx.weather(trail);
  const omitStorm = brief.some(
    (l) => l.kind === FACTOR_LABEL.storm && (l.measure !== undefined || l.text.includes('%')),
  );
  const spread = weather ? routeSpread(trail, weather, ctx.provider, ctx.state.day) : { low: null, high: null };
  // `weekdayLabel` takes an ABSOLUTE provider day index, not the scrubber's offset: the two
  // agree only on day 0, so passing the offset would name the wrong weekday from tomorrow on.
  // Same form the week row and the verdict already use.
  const when =
    ctx.state.day === 0
      ? 'now'
      : `for ${weekdayLabel(ctx.provider.now().dayIndex + ctx.state.day)} daytime`;

  const rows: HTMLElement[] = [];
  const push = (reading: Parameters<typeof conditionsRow>[0], what: string): void => {
    rows.push(
      h(
        'div',
        { class: 'pc-line' },
        h('span', { class: 'pc-where' }, what),
        conditionsRow(reading, ctx.units, {
          omitStorm,
          lead: `At the route's ${what.toLowerCase()} ${when}`,
          class: 'cr-peek',
        }),
      ),
    );
  };

  // Highest first. It is the reading the card already showed, so the sheet opens by
  // confirming what brought the reader here rather than making them find it again.
  if (spread.high) push(spread.high, 'Highest');
  push(spread.low, spread.high ? 'Lowest' : 'On route');

  return h('div', { class: 'peek-conditions' }, ...rows);
}

/**
 * The profile CHART follows the selection; the card's own sparkline never does (it has no
 * traversal control to reflect, and it stays the trail's fingerprint in a scrolling list,
 * not a picture of one outing). `'incl-return'` draws the whole walk, out then back,
 * sharing the turnaround point once rather than duplicating it. `'ccw'` mirrors the same
 * shape left to right, matching `journey.ts`'s own convention that clockwise is a label for
 * the profile's STORED direction, not a compass check.
 *
 * A shallow clone rather than a change to `profileSparkline`'s contract: the function still
 * takes a `ScopeTrail` and reads `.profile`/`.seamIndices`/`.lengthM` off it exactly as
 * before, so nothing about how the card calls it has to change. Seam indices are re-mapped
 * rather than dropped, so a real discontinuity still draws as a break on the mirrored or
 * doubled chart instead of inventing a cliff that is not there.
 */
function displayProfileTrail(trail: ScopeTrail, traversal: GradeTraversal): ScopeTrail {
  const prof = trail.profile;
  const n = prof?.length ?? 0;
  if (n < 2) return trail;
  const seams = trail.seamIndices.filter((i) => i > 0 && i < n);

  if (traversal === 'ccw') {
    // A seam at i sits between i-1 and i; reversed, that same gap sits between (n-1-i) and
    // (n-i), and the convention (the higher of the pair) makes the new marker `n - i`.
    return { ...trail, profile: [...prof].reverse(), seamIndices: seams.map((i) => n - i) };
  }
  if (traversal === 'incl-return') {
    // The return leg is the same profile walked backwards, minus the point already shared
    // with the outbound leg's far end (the turnaround), so 2n-1 points cover 2x the length.
    const back = prof.slice(0, -1).reverse();
    return {
      ...trail,
      profile: [...prof, ...back],
      // The outbound leg's seams are unchanged; the return leg's mirror at `2n-1-i` (the
      // same reflection as `ccw` above, offset by the outbound leg's own n points).
      seamIndices: [...seams, ...seams.map((i) => 2 * n - 1 - i)],
      lengthM: trail.lengthM * 2,
    };
  }
  return trail;
}

/**
 * The treeline rule the peek's profile draws, or `undefined` where there is nothing to
 * draw. THE OZARKS IS THE CASE THIS EXISTS FOR: its `treelineM` is `NO_TREELINE_M`, a
 * sentinel set above any possible route so the exposure term stays inert, and `model.ts`
 * says in as many words that it must never reach the UI as a number. `hasTreeline` is that
 * file's own guard, used here rather than a second comparison against the sentinel, so a
 * region that gains or loses a treeline changes one place.
 *
 * The label is uppercased here rather than in CSS: `text-transform` on an SVG `<text>` is
 * not reliably applied across engines, and Concept B's chart (route.ts) already writes its
 * own label uppercase in the string for the same reason. Same words, same order, same case.
 */
function peekTreeline(ctx: Ctx): { elevM: number; label: string } | undefined {
  if (!hasTreeline(ctx.region)) return undefined;
  return {
    elevM: ctx.region.treelineM,
    label: `Treeline ${formatElevation(ctx.region.treelineM, ctx.units)}`.toUpperCase(),
  };
}

/**
 * Worst value across the sampled route points for one hour-from-now offset.
 *
 * `gustKph` is carried alongside the two the strip draws with, and nothing about the strip
 * changes: it reads `thunder` for the cell colour and `tempC` for the tooltip exactly as
 * before. The third field exists so `dayPeaks` below can find the windiest hour of the day
 * from the SAME route-wide reduction the strip is built on, rather than from a second pass
 * with its own idea of what "on the route" means.
 */
function routeHour(
  series: WeatherSample[][],
  hour: number,
): { thunder: number; tempC: number; gustKph: number } | null {
  let thunder = -1;
  let tempC = -999;
  let gustKph = -1;
  for (const s of series) {
    const hit = s.find((x) => x.hour === hour);
    if (!hit) continue;
    thunder = Math.max(thunder, hit.thunderProb);
    tempC = Math.max(tempC, hit.tempC);
    gustKph = Math.max(gustKph, hit.gustKph);
  }
  return thunder < 0 ? null : { thunder, tempC, gustKph };
}

function stripCellClass(thunder: number): string {
  if (thunder >= 0.55) return 'st-cell lv-3';
  if (thunder >= 0.3) return 'st-cell lv-2';
  if (thunder >= 0.12) return 'st-cell lv-1';
  return 'st-cell lv-0';
}

/**
 * Why a cell is the colour it is, in one clause.
 *
 * Review asked for exactly this ("would be good to hover over these bars to see why
 * something is green versus orange"), and the shading was the one mark on the sheet with no
 * key anywhere. The thresholds below are THE SAME NUMBERS `stripCellClass` switches on, read
 * in the same order, so the sentence cannot drift from the colour it is explaining. If a
 * threshold moves, it moves in both places or the tooltip starts lying.
 *
 * A green cell says what makes it fine rather than saying nothing: an hour with no reason
 * attached reads as an hour the forecast has no opinion about.
 */
function cellReason(thunder: number): string {
  if (thunder >= 0.55) return 'a high storm risk, so the hour reads red';
  if (thunder >= 0.3) return 'storm risk enough to turn the hour amber';
  if (thunder >= 0.12) return 'a slight storm chance, so the hour is tinted';
  return 'low storm risk, so the hour stays clear';
}

// ============================================================================
// THE VERDICT
// ============================================================================
//
// The block that answers "what does Prime mean?" before anyone has to ask.
//
// A level word on its own is a private vocabulary: three of them, learned nowhere, printed
// in a tinted pill that already looks like a rating. The fix is not a legend or a tooltip,
// both of which move the definition somewhere the reader is not looking. The definition
// travels WITH the word, on the same line, every time it is shown.
//
// The sentence is generated from the grade, never hand-written per scenario, so it cannot
// drift from the pill beside it or go stale when the weather changes:
//
//   "<what the level means for this route>. <what is actually driving it>."
//
// The second half is `grade.headline`, which is the grader's own top one or two clauses,
// so the verdict and the pill are literally the same judgement stated at two lengths.
// Only the timing advice is added here, and only where it is not already in the headline.
//
// THE LEVEL WORD IS SAID EXACTLY ONCE, in the pill. The sentence used to open with it too
// ("Prime: a good day for this route"), which review called out as a stutter, and it is:
// the pill is three centimetres to the left saying the same word in the same colour. What
// made the pill self-explanatory was never the repetition, it was the MEANING CLAUSE that
// follows, so that is what stays. The rule from SCOPE_PLAN §10 is unchanged: the level word
// never appears without its plain-language gloss beside it. It just does not appear twice.

const LEVEL_LABEL: Record<GradeLevel, string> = { prime: 'Good', mixed: 'Mixed', poor: 'Poor' };

/**
 * What each level means for THIS ROUTE on a day the forecast can actually resolve.
 *
 * Written as advice rather than as a definition of the word, because a reader deciding
 * whether to drive two hours wants the recommendation, not the taxonomy.
 */
const ROUTE_MEANING: Record<GradeLevel, string> = {
  // The pill says GOOD, so this clause must not repeat the word (the same stutter the
  // level prefix had before it was cut). See `primeMeaning`: this absolute form is only
  // honest on a day that stays clear, and prime does not guarantee that.
  prime: 'nothing working against this route',
  mixed: 'worth doing if you time it right',
  poor: 'not a day for this route',
};

/**
 * Prime has TWO shapes, for the same reason mixed has three.
 *
 * A route grades prime when nothing works against it DURING THE WINDOW IT WOULD BE WALKED
 * IN, which is not the same claim as the day being clear. Storms that arrive after the walk
 * ends barely score (grade.ts caps that branch at a token penalty precisely because they do
 * not touch the walk), so an afternoon that peaks at 57% can still total under PRIME_MAX.
 * That is the grade working correctly. It was the GLOSS that overreached: "nothing working
 * against this route" is an absolute, and Björn read it directly above a brief line stating
 * a 57% storm peak, which reads as the screen contradicting itself within two lines.
 *
 * The test is on the data, not on the string. `fromHour` is only ever set from `stormFrom`,
 * and grade.ts derives that from the first hour crossing STORM_ONSET_PROB, so a non-daylight
 * factor carrying an onset hour means real storms at a known hour. Daylight is excluded
 * because its `fromHour` is sunset, which arrives every day and is not the day turning.
 *
 * No clock time and no percentage here: the gloss says what the level MEANS, and the brief
 * line under it already carries both ("Clear until 13:00, storm chance peaks 57% at 15:00").
 */
function primeMeaning(grade: ConditionGrade): string {
  const turnsLater = grade.factors.some((f) => f.kind !== 'daylight' && f.fromHour !== undefined);
  return turnsLater ? 'clear while you would be out, storms later in the day' : ROUTE_MEANING.prime;
}

/**
 * Mixed has THREE shapes and one gloss cannot cover them.
 *
 * A convective afternoon that still leaves a window long enough for the whole route IS a
 * timing problem: leave early and the route is fine, so "time it right" is advice the reader
 * can act on. Ground that is wet from Monday's rain is not a timing problem at all, and
 * telling someone to time that right is advice they cannot act on. And a convective
 * afternoon that leaves NO window long enough for the route is neither of those: it is
 * bound to an hour, same as the first shape, but no timing fixes it, so promising "time it
 * right" directly contradicts the "no window long enough for the route" clause the sentence
 * goes on to state below (this is the Fern Lake Trail bug: the pill promised a route that
 * could not be timed). So the mixed clause is chosen off the data twice, not once: is
 * anything driving this grade actually bound to an hour, and if it is, does a window that
 * fits the route actually exist?
 */
/**
 * The third shape of mixed: the day is time-bound AND no window fits the route, so timing
 * cannot rescue it. Named rather than inlined because the clause list below compares
 * against it to avoid stating the same fact twice.
 */
const NO_WINDOW_MEANING = 'not enough day to fit this route';

function mixedMeaning(grade: ConditionGrade): string {
  const timeBound = grade.factors.some(
    (f) => f.kind !== 'daylight' && f.penalty >= 6 && f.fromHour !== undefined,
  );
  if (!timeBound) return 'doable, with something to watch';
  // Time-bound, but the day still does not have a window long enough for the route, so
  // this cannot promise resolvable timing without contradicting itself immediately after.
  // The clause list below suppresses its own no-window clause when this gloss fires: see
  // NO_WINDOW_MEANING's use there.
  if (grade.bestWindow === null) return NO_WINDOW_MEANING;
  return ROUTE_MEANING.mixed;
}

/**
 * The same three words past the horizon, where the claim is about the AREA on that DAY and
 * not about this route at any hour. The copy has to say "area" every time, or an outlook
 * pill reads as a route-specific promise the forecast cannot keep.
 */
const OUTLOOK_MEANING: Record<GradeLevel, string> = {
  prime: 'the area looks clear that day',
  mixed: 'the area could go either way that day',
  poor: 'a day to write off across the area',
};

/** Grade clauses are lower case by contract, and this one starts a sentence. */
function upperFirst(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

// ============================================================================
// THE MEASURE BEHIND EACH CLAUSE
// ============================================================================
//
// Björn on the brief: "I like it but it should be maybe a little bit more detailed. Doesn't
// have to be long sentences. I like the bullet points but maybe a little bit more detail."
//
// Every line of the brief states a conclusion and withholds what it was concluded from.
// "Dry underfoot" is a judgement about the ground; the reader cannot tell whether it rests
// on a fortnight of sun or on a shower that stopped an hour ago. So each line now carries a
// SECOND column: the claim, then the evidence, the evidence quieter than the claim.
//
// THE MEASURES ARE MEASUREMENTS, NOT GRADE INTERNALS, and that distinction is load-bearing
// rather than a technicality. `ConditionFactor` carries a penalty, a kind, a clause and
// sometimes an onset hour — it does not carry the numbers `gradeTrail` reduced to reach
// them, and `grade.ts` is not this change's to widen. Re-implementing that file's window
// arithmetic here to recover them would put a second, differently-computed copy of the
// model in the UI layer, which is the exact failure this file's own header rule 1 forbids
// ("The brief is built from the SAME `ConditionGrade` the pill reads, never from a second
// pass over the weather"). So the measures are read off the PROVIDER's own series and the
// derived terrain instead, in the same reductions this file already runs for the hourly
// strip. That leaves the division of labour clean and, better, checkable: the clause is the
// grader's judgement, the measure is a fact about the day that the reader can verify
// against the strip a few blocks down without taking the grade's word for anything.
//
// ONE MEASURE PER LINE, AND NEVER THE ONE THE SHEET ALREADY PRINTS. This is the fifth time
// the verdict has had to be de-duplicated (see `briefLines` for the first four), and a
// measure column makes a sixth very cheap, because the measure and the clause can restate
// each other and because `peekConditions` two blocks up is already a row of measured
// numbers. The rule that resolves it, applied per kind below:
//
//   the measure names WHAT the sheet does not already say, and WHEN.
//
// Which is why temperature and wind get an hour and no value. Their magnitudes are
// `peekConditions`' first two fields, printed at two named elevations directly above this
// block, and that row is a shared contract with the card and the area strip (conditions.ts)
// that exists precisely so the reader can compare three readouts of the same five fields.
// Reprinting either number here — as a value, or as the low-to-high route range, which is
// those same two readings subtracted — would be one fact in two places on one sheet. What
// that row cannot say is when the peak lands, so that is what these two lines add.
//
// PAST THE HORIZON THERE ARE NO MEASURES AT ALL. `outlookGrade` refuses every hour and every
// terrain term by construction, and its clauses are about the AREA on that DAY. An hour or a
// route share attached to one of them would be the brief re-asserting exactly what the grade
// just declined to claim. The 72 h antecedent is the one number that would still be true out
// there and it is dropped with the rest, because past the horizon the wetness clause is about
// rain forecast for that day, not about the ground's current state, so the antecedent would
// be evidence for a different claim than the one it sat beside.

/** A day's peak in one quantity, taken across the route's sample points. */
interface DayPeak {
  value: number;
  /** Hours-from-now the peak lands on. */
  hour: number;
}

interface DayPeaks {
  thunder: DayPeak;
  temp: DayPeak;
  gust: DayPeak;
}

/**
 * The selected day's route-wide peaks, over exactly the hours the strip below draws.
 *
 * STRIP_FROM..STRIP_TO and `routeHour` are reused rather than re-chosen, so "peaks 46% at
 * 16:00" always names the darkest cell in the hourly strip further down the same sheet.
 * Two different windows would give the reader a measure they could not find, which is worse
 * than no measure at all. Past hours are skipped for the same reason the strip greys them
 * out: a peak that has already happened is not something to plan around.
 */
function dayPeaks(ctx: Ctx, weather: WeatherResult): DayPeaks | null {
  const { hourOfDay } = ctx.provider.now();
  let thunder: DayPeak | null = null;
  let temp: DayPeak | null = null;
  let gust: DayPeak | null = null;
  for (let hod = STRIP_FROM; hod <= STRIP_TO; hod++) {
    const hour = 24 * ctx.state.day + hod - hourOfDay;
    if (hour < 0) continue;
    const sample = routeHour(weather.series, hour);
    if (!sample) continue;
    if (!thunder || sample.thunder > thunder.value) thunder = { value: sample.thunder, hour };
    if (!temp || sample.tempC > temp.value) temp = { value: sample.tempC, hour };
    if (!gust || sample.gustKph > gust.value) gust = { value: sample.gustKph, hour };
  }
  return thunder && temp && gust ? { thunder, temp, gust } : null;
}

/**
 * The evidence for one clause, or `null` where there is none worth printing.
 *
 * Per kind, and each choice is the quantity that clause's own threshold test actually ran
 * on, never a decorative extra that happened to be available:
 *
 *   wetness   the antecedent rainfall the ground model is seeded from
 *             (`WeatherResult.antecedentPrecipMm`, the provider's own 72 h total, taken as
 *             the mean across sample points exactly as `gradeTrail` takes it). This is the
 *             one line where the measure can flip the reader's reading of the clause: "dry
 *             underfoot" after three dry days and "dry underfoot" the morning after 6 mm
 *             are different facts wearing the same words.
 *
 *             THE DRYING HALF LIFE IS DELIBERATELY NOT PRINTED, though `GRADE_MODEL.ground`
 *             exposes it and it is what makes this term route-specific. Three reasons and
 *             they agree: it is a model parameter rather than a measurement of the day, a
 *             second number on this line would start the column being read as a table, and
 *             a product telling a walker how fast its soil model thinks their trail drains
 *             is method copy inside the phone frame (SCOPE_PLAN §10). Its effect is already
 *             visible where it matters — two routes under the same rain differ in WHICH
 *             clause fires, which is the thing the reader can act on.
 *
 *   storm     the day's peak probability and the hour it lands, minus whichever half the
 *             clause already carries. `grade.ts` writes the ONSET hour into its copy ("60%
 *             storms from 13:00"), never the peak's, so the hour here is a different fact
 *             even when the clause is at its most detailed.
 *
 *   exposure  the share of the route above the region's treeline, which is `exposedShare`,
 *             the exact multiplier the exposure penalty is scaled by. The treeline's own
 *             ELEVATION is left out: the profile chart on this sheet already draws it as a
 *             labelled rule ("TREELINE 3,400 M"), and the clause already says "above
 *             treeline", so the share is the only part of this that is not already on
 *             screen or in the sentence beside it.
 *
 *   heat      when the route is hottest. See the block comment above for why not how hot.
 *   wind      when it is windiest, for the same reason.
 *
 *   daylight  sunset, which is the factor's OWN `fromHour` (grade.ts writes `dayEnd` into
 *             it) read back rather than recomputed, so the clause and its measure cannot
 *             name two different ends of the day. Every daylight clause is about running
 *             out of it and not one of them says when, which is the number a reader
 *             deciding whether to set off actually needs.
 */
function factorMeasure(
  ctx: Ctx,
  trail: ScopeTrail,
  factor: ConditionFactor,
  weather: WeatherResult | null,
  peaks: DayPeaks | null,
): string | undefined {
  const at = (hour: number): string => clockLabel(ctx.provider, hour);
  switch (factor.kind) {
    case 'wetness': {
      if (!weather || weather.antecedentPrecipMm.length === 0) return undefined;
      const mm = weather.antecedentPrecipMm.reduce((s, x) => s + x, 0) / weather.antecedentPrecipMm.length;
      // The same floor the conditions row and the weather glyph apply, imported rather than
      // re-chosen: below it `formatPrecip` prints "0 mm", which reads as a broken field
      // instead of as a dry three days.
      return mm < PRECIP_FLOOR_MM ? 'no rain in 72 h' : `${formatPrecip(mm, ctx.units)} in 72 h`;
    }
    case 'storm': {
      if (!peaks) return undefined;
      // A bare percentage has to name what it counts. The row's `aria-label` prefixes the
      // kind ("Storms: ..."), so a screen reader always knows; a sighted reader gets a sun
      // glyph and the claim, and three of the five storm clauses state neither the number
      // nor the noun. Against "Stays clear through the afternoon", the old measure read
      // "peaks 8% at 16:00" and Björn asked, fairly, what peaks — sun? rain chance?
      //
      // The test stays on the CLAIM rather than moving to the clause kind, because what
      // decides this is whether the reader has already been told: "60% storms from 13:00"
      // supplies both noun and number, so repeating them shrinks the measure to the one
      // thing it adds, the hour. Everything else names the quantity in full. That covers
      // "clear until 15:00" and "a chance of showers" too, which had the same hole and
      // which nobody had reported yet.
      //
      // Note the low number is not a contradiction of a clear claim, it is the EVIDENCE
      // for it: 8% sits well under STORM_ONSET_PROB, which is why the clause says clear.
      return factor.text.includes('%')
        ? `peaks at ${at(peaks.thunder.hour)}`
        : `storm chance peaks ${formatPercent(peaks.thunder.value)} at ${at(peaks.thunder.hour)}`;
    }
    case 'exposure': {
      // This peek's own traversal, the same one the grade was computed at (`peekGrade`), so
      // the share and the clause can never be measured off two different walks. It happens
      // not to move `exposedShare` — an out-and-back covers the same ground twice — and it
      // is passed anyway rather than relying on that staying true.
      const share = terrainFacts(trail, ctx.region, traversalFor(trail)).exposedShare;
      return `${formatPercent(share)} of the route`;
    }
    case 'heat':
      return peaks ? `hottest at ${at(peaks.temp.hour)}` : undefined;
    case 'wind':
      return peaks ? `windiest at ${at(peaks.gust.hour)}` : undefined;
    case 'daylight':
      return factor.fromHour === undefined ? undefined : `sunset ${at(factor.fromHour)}`;
  }
}

/**
 * THE BRIEF: one fact per line, each with its own time and its own leading glyph.
 *
 * It replaces a paragraph. The old shape was a generated sentence — a meaning clause, the
 * grade's headline, and a comma-joined clause list ("Not enough day to fit this route. 60%
 * storms from 13:00, gusty in the afternoon.") — and review's objection was structural
 * rather than about the words: a reader deciding whether to drive two hours is scanning for
 * facts and times, and a comma list makes them parse a sentence to find them.
 *
 * ORDERED BY WHAT ACTUALLY DRIVES THE GRADE, never by a hand-fixed sequence of kinds.
 * `ConditionGrade.factors` is sorted worst-first by penalty (the contract is stated in
 * types.ts and both grading paths sort before returning), so the brief reads it in the order
 * it arrives. That is what makes the order MEAN something: the line at the top is the line
 * carrying the most weight in the grade above it, whichever kind of thing it happens to be.
 *
 * THE BEST WINDOW LEADS, when there is one. It is a fact the app already computes and it
 * used to sit two blocks down, inside WHEN TO GO, under a title. Review specifically valued
 * a best-window recommendation, so it gets the position it earns; and when there is no
 * window that fits the route, the brief says so plainly in the same slot rather than leaving
 * a reader to notice an absence.
 *
 * ONE FACT, ONE PLACE. This codebase has de-duplicated the verdict four times already (the
 * level word, the repeated hour, the no-window clause, the card's pill against its own
 * conditions row), and a structured brief makes a fifth very easy: it is far cheaper to
 * restate a fact on a second line than in a second sentence. Four duplications had to be
 * resolved to build it, and each one was resolved by DELETING the older copy rather than by
 * leaving both and hoping:
 *
 *   1. `grade.headline` is not printed. It is `buildHeadline`'s join of the top one or two
 *      factor clauses, and the brief lists those clauses individually one line below. The
 *      pill in this sheet is `levelOnly`, so nothing else prints it either.
 *   2. The old "What's driving this" block at the bottom of the sheet is gone. The brief IS
 *      that list, promoted above the fold with the hour attached, and running both would
 *      have printed every factor twice on one sheet.
 *   3. "go before 15:00" is gone. It was derived from the top time-bound factor's own hour,
 *      which that factor's line already prints, and it is weaker timing advice than the
 *      window line directly above it. The window line is the one authority on timing.
 *   4. WHEN TO GO's own headline (`pw-say`, and its "no window long enough" fallback) is
 *      gone with it, for the same reason: the window moved, it did not get copied. The
 *      strip keeps its green underline and the legend that explains that mark.
 *
 * And one suppression kept from before rather than reinvented: where `mixedMeaning`'s third
 * shape ("not enough day to fit this route") already says there is no window, the window
 * line is suppressed. That is exactly the `openerSaysIt` rule the paragraph version carried,
 * and it is why the gloss and the first line can never both be about the same missing
 * window.
 */
interface BriefLine {
  glyph: string;
  /** The accessible name for the glyph. The line's text is read after it. */
  kind: string;
  text: string;
  /**
   * The number the clause was concluded from, in the quiet right-hand column. Optional and
   * genuinely often absent: see `factorMeasure` for the per-kind rule, and note that an
   * absent measure is a claim about the data, not a gap to be filled with something coarser.
   */
  measure?: string;
}

/**
 * How many factor lines the brief prints. Four, which is what the block it replaces showed,
 * so the restructure moves content and never quietly drops any: a brief that silently held
 * back the fifth reason would be a worse paragraph, not a better list.
 */
const BRIEF_FACTORS = 4;

/** The level's plain-language gloss. The level WORD is the pill's job and appears nowhere
 *  here; SCOPE_PLAN §10's rule is that the word never shows without this beside it, and §11
 *  cut the repetition of the word itself. Unchanged by the restructure. */
function verdictGloss(grade: ConditionGrade): string {
  const meaning =
    grade.confidence === 'outlook'
      ? OUTLOOK_MEANING[grade.level]
      : grade.level === 'mixed'
        ? mixedMeaning(grade)
        : grade.level === 'prime'
          ? primeMeaning(grade)
          : ROUTE_MEANING[grade.level];
  return `${upperFirst(meaning)}.`;
}

function briefLines(ctx: Ctx, trail: ScopeTrail, grade: ConditionGrade): BriefLine[] {
  const lines: BriefLine[] = [];
  // Both are null past the horizon and both are unused there: the outlook branch below
  // returns before any measure is asked for. See THE MEASURE BEHIND EACH CLAUSE.
  const weather = grade.confidence === 'outlook' ? null : ctx.weather(trail);
  const peaks = weather ? dayPeaks(ctx, weather) : null;

  if (grade.confidence === 'outlook') {
    // PAST THE HORIZON THE BRIEF DEGRADES TO THE OUTLOOK VOCABULARY, and it does not have
    // to be taught to: `outlookGrade` refuses an hourly claim, a window and every terrain
    // term BY CONSTRUCTION, so following what the grade actually carries is the whole of
    // it. No window line at all — not even the "no window" form, which would be a claim
    // about hours that a day-scale outlook cannot make — and at most the two regional
    // clauses that grade keeps.
    //
    // A coarse day with nothing driving it carries one fallback clause ("settled across the
    // area") that is a synonym of its own gloss, so printing it would open the brief with
    // one fact twice. The test is on the data, not on the string.
    const driven = grade.factors.some((f) => f.penalty >= 1);
    if (!driven) return lines;
  } else {
    // The window, or its honest absence. Suppressed only where the gloss above it already
    // says there is none (mixedMeaning's third shape).
    const openerSaysIt = grade.level === 'mixed' && mixedMeaning(grade) === NO_WINDOW_MEANING;
    if (grade.bestWindow) {
      // THE ONE MEASURE ON THIS BLOCK THE READER COULD DO THEMSELVES, and it is kept
      // knowingly. The window's span is its two printed clock times subtracted, so by the
      // one-fact-one-place rule it should not be here at all. It is, for two reasons.
      // Subtracting two clock times is exactly the parse-work the brief exists to remove,
      // and the span is the answer to the only question a reader asks of a window ("is that
      // long enough for my walk?"). And it is not always the route's estimated time from the
      // measures row above, which is the obvious substitute: `gradeTrail` sizes the window to
      // `min(durationH, availableH)`, so on a day too short for the route the span comes back
      // SMALLER, and the difference between the two figures is the only visible sign of it.
      // Sub-hour spans get nothing: `bestWindowText` collapses those to "Best from 08:00",
      // and "0h" beside it would read as a broken field rather than as a short window.
      const spanH = grade.bestWindow.endHour - grade.bestWindow.startHour;
      lines.push({
        glyph: 'clock',
        kind: 'Best window',
        // `bestWindowText` is the same sentence the card uses, so the list and this sheet
        // can never recommend two different windows for one route.
        text: bestWindowText(ctx, grade.bestWindow),
        measure: spanH >= 1 ? formatDuration(spanH * 60) : undefined,
      });
    } else if (!openerSaysIt) {
      // NO MEASURE, on purpose. The number behind "no window long enough" is the route's own
      // estimated time, and that is printed a few rows up in the measures row where it
      // belongs; the other half of the arithmetic, how much day is left, is the daylight
      // factor's own line further down this same brief (`factorMeasure`, which gives it
      // sunset). Restating either here would be this block's fifth de-duplication reopened
      // on the very line the rule was written for.
      lines.push({ glyph: 'clock', kind: 'Best window', text: 'No window long enough for this route' });
    }
  }

  for (const f of grade.factors.slice(0, BRIEF_FACTORS)) {
    // THE TIME THE CLAUSE ALREADY CARRIES IS LEFT IN THE CLAUSE, and is still deliberately
    // not pulled out into a column of its own. `grade.ts` writes the ONSET hour into the copy
    // it generates ("60% storms from 13:00", "no shelter above treeline after 13:00"), so
    // hoisting it would mean either rewriting that copy or stripping the hour back out of it
    // with a regex, and both put one fact in two places. The measure column beside it is a
    // different hour and a different kind of thing — the peak, the share, the rainfall the
    // clause was concluded FROM — and where it would collide with the clause it stands down:
    // see `factorMeasure`.
    lines.push({
      glyph: factorGlyph(f),
      kind: FACTOR_LABEL[f.kind],
      text: upperFirst(f.text),
      measure: factorMeasure(ctx, trail, f, weather, peaks),
    });
  }
  return lines;
}

function briefRow(line: BriefLine): HTMLElement {
  return h(
    'div',
    // The glyph is `aria-hidden` (icon() sets it), so the row carries the kind as its own
    // name and reads out as "Storms: 60% storms from 13:00, peaks at 16:00" rather than as a
    // loose clause. The measure joins that one utterance rather than being a second focus
    // stop: it is evidence for the clause, and read on its own ("peaks at 16:00") it names
    // nothing.
    {
      class: 'pvb-line',
      role: 'listitem',
      'aria-label': line.measure ? `${line.kind}: ${line.text}, ${line.measure}` : `${line.kind}: ${line.text}`,
    },
    icon(line.glyph, 15, 'pvb-glyph'),
    // ONE SENTENCE, NOT TWO COLUMNS. The measure used to be its own right-aligned column,
    // which worked only while every measure was short: the CSS sized the claim from what was
    // left over, so "storm chance peaks 4% at 15:00" took the row and left the clause about
    // six characters, wrapping "Stays clear through the afternoon" one word per line. Naming
    // the quantity is not negotiable, so the column is what gives.
    //
    // Flattening also settles a smaller inconsistency: the row's `aria-label` has always
    // joined the two into one utterance ("Storms: stays clear through the afternoon, storm
    // chance peaks 4% at 15:00"), because the measure is evidence for the clause rather than
    // a second thing to read. The eye now gets the same sentence the ear already got, and
    // the evidence stays subordinate through ink alone instead of through position.
    h(
      'span',
      { class: 'pvb-text' },
      line.text,
      // Absent, not empty: a line with no honest measure behind it renders no node at all.
      line.measure ? h('span', { class: 'pvb-measure' }, `, ${line.measure}`) : null,
    ),
  );
}

/**
 * `lines` is passed in rather than computed here, and that is the seam that lets
 * `peekConditions` know what this block is about to print. Both are rendered from one
 * `peekSheet` call and the conditions row has to stand down on any field the brief now
 * measures; computing the brief twice to find that out would be two chances for the two
 * copies to disagree about what is on screen.
 */
function verdictBlock(ctx: Ctx, trail: ScopeTrail, lines: BriefLine[]): HTMLElement {
  const grade = peekGrade(ctx, trail);
  const day = ctx.state.day;
  const when = day === 0 ? 'Today' : weekdayLabel(ctx.provider.now().dayIndex + day);

  if (!grade) {
    return h(
      'div',
      { class: 'peek-verdict is-pending' },
      h('div', { class: 'pv-head' }, conditionPill(null), h('span', { class: 'pv-when' }, when)),
      h('p', { class: 'pv-say' }, 'Checking conditions on this route.'),
    );
  }

  return h(
    'div',
    // The level class stays on the block even though nothing tints the panel any more: it is
    // what the day row and any later treatment hang off, and it costs nothing. What is gone
    // is the coloured left edge, see the CSS note.
    { class: `peek-verdict lv-${grade.level}${grade.confidence === 'outlook' ? ' is-outlook' : ''}` },
    h(
      'div',
      { class: 'pv-head' },
      conditionPill(grade, { levelOnly: true, compact: true }),
      h('span', { class: 'pv-when' }, when),
    ),
    // The gloss stays a sentence and stays OUTSIDE the list. It is what the level word
    // means, not a fact with a time, and a reader scanning the brief's leading glyphs
    // should not have to step over a line that has no measurement on it.
    h('p', { class: 'pv-say' }, verdictGloss(grade)),
    // A real list to a screen reader. Six loose divs read as one run-on paragraph, which is
    // the shape this block just stopped being. Omitted ENTIRELY rather than left empty on
    // the one case that produces no lines at all — a coarse outlook day with nothing driving
    // it, where the gloss is the whole of what can honestly be said — because an empty list
    // is still a list to assistive tech and still a gap in the layout.
    lines.length > 0
      ? h('div', { class: 'pv-brief', role: 'list' }, ...lines.map(briefRow))
      : null,
  );
}

// ============================================================================
// THE WEEK, FOR THIS TRAIL
// ============================================================================
//
// Seven days, each carrying THIS ROUTE's own grade as a dot. The day bar in the app header
// answers "what am I looking at", region-wide; this row answers the question a reader who
// has already picked a trail actually has, which is "when this week can I do THIS one?".
//
// ONE DATE DIMENSION. Tapping a chip sets `state.day`, exactly as the header's day bar does,
// so the verdict above, the hourly strip below and the ranked list behind the sheet all move
// together. There is no second, peek-local notion of a selected day: two date controls that
// can disagree is the fastest way to make a forecast look broken.
//
// THE HORIZON IS VISIBLE HERE TOO, and it has to be. Past +36 h the dot is a REGIONAL
// outlook, not a claim about this route at any hour, so those chips render muted: same three
// levels (a settled Friday and a stormy Friday must not look alike) at visibly lower weight.
// That is the same treatment the map legend, the pill and the profile fill already use.
//
// GRADES FOR THE WHOLE WEEK ARE THIS BLOCK'S OWN JOB. The app fills the cache for the
// selected day and the one after it, across every trail, which is what the list needs. Seven
// days for ONE trail is a different shape of request and is filled here, off the weather
// that is already cached for that trail, so opening a peek costs no extra provider call.

/** In flight, so a render during the fill cannot start a second one. */
let weekFilling = false;

/**
 * Make sure this trail has a grade for every day the row draws, then re-render.
 *
 * Guarded twice against the obvious loop: nothing starts while a fill is in flight, and a
 * fill only starts when a day is genuinely missing, so the re-render that follows finds a
 * full cache and stops.
 */
function ensureWeek(ctx: Ctx, trail: ScopeTrail): void {
  if (weekFilling) return;
  const traversal = traversalFor(trail);
  const missing: number[] = [];
  for (let d = 0; d < SCRUB_DAYS; d++) {
    if (gradeOf(ctx.state.scenario, ctx.state.region, trail, d, traversal) === null) missing.push(d);
  }
  if (missing.length === 0) return;

  weekFilling = true;
  const { scenario, region } = ctx.state;
  // Explicit traversal, not the omitted-argument default: this fill is for THIS peek's
  // own selection, which may not be the trail's default. The list's own fill (app.ts's
  // `fillGrades`) is the one call site that must keep omitting it.
  void ensureGrades(scenario, region, [trail], missing, traversal).then(() => {
    weekFilling = false;
    ctx.setUi({});
  });
}

function weekRow(ctx: Ctx, trail: ScopeTrail): HTMLElement {
  ensureWeek(ctx, trail);

  const provider = ctx.provider;
  const { dayIndex } = provider.now();
  const outlookFrom = firstOutlookDay(provider);
  const horizon = Math.round(provider.horizonHours);

  const row = dragScroll(h('div', { class: 'pweek' }));
  for (let d = 0; d < SCRUB_DAYS; d++) {
    const grade = peekGrade(ctx, trail, d);
    const on = d === ctx.state.day;
    // Either test is enough on its own; both are read because a provider that returns a
    // short series can hand back an outlook grade for a day inside its own horizon.
    const outlook = d >= outlookFrom || grade?.confidence === 'outlook';
    const name = d === 0 ? 'Today' : weekdayLabel(dayIndex + d).slice(0, 3);
    const level = grade ? grade.level : 'pending';

    const btn = h(
      'button',
      {
        type: 'button',
        class: `pweek-day${on ? ' on' : ''}${outlook ? ' is-outlook' : ''}`,
        'aria-label': `${weekdayLabel(dayIndex + d)}: ${grade ? LEVEL_LABEL[grade.level] : 'still grading'}${outlook ? `, regional outlook past the +${horizon} h forecast` : ''}`,
      },
      h('span', { class: 'pwd-name' }, name),
      h('i', { class: `pwd-dot lv-${level}` }),
    );
    btn.setAttribute('aria-pressed', String(on));
    btn.addEventListener('click', () => ctx.set({ day: d }));
    row.appendChild(btn);
  }

  return h(
    'div',
    { class: 'pweek-wrap' },
    h('div', { class: 'strip-title' }, 'This week', h('span', { class: 'strip-sub' }, 'on this trail')),
    row,
    // The muted dots need one line of key, exactly once. Without it a faded dot reads as a
    // rendering fault rather than as the honest limit it is. The horizon's own number is not
    // repeated here: the day bar prints it, the strip states it on the day it bites, and a
    // third copy inside one sheet is chrome.
    outlookFrom < SCRUB_DAYS
      ? h('div', { class: 'pweek-note' }, 'Faded days are a regional outlook, not hour by hour.')
      : null,
  );
}

// ============================================================================
// THE TIME WINDOW
// ============================================================================
//
// Same strip as before, retitled around the question it is actually answering. The title
// used to be "Storm probability along the route", which put the provider's rawest number
// in the headline position and left the reader to work out the consequence. The window is
// the consequence. Storms keep the cell shading and the tooltips, and they keep their line
// in the factor list below, so nothing was hidden; they just stopped being the frame.

function timeWindow(ctx: Ctx, trail: ScopeTrail): HTMLElement {
  const grade = peekGrade(ctx, trail);
  const weather = ctx.weather(trail);
  const day = ctx.state.day;
  const horizon = Math.round(ctx.provider.horizonHours);

  if (!weather || !grade) {
    return h('div', { class: 'strip-wrap' }, h('div', { class: 'strip-note' }, 'Checking the hours…'));
  }

  if (grade.confidence === 'outlook') {
    return h(
      'div',
      { class: 'strip-wrap is-outlook' },
      h('div', { class: 'strip-title' }, 'Timing'),
      h(
        'div',
        { class: 'strip-none' },
        icon('outlook', 16),
        h(
          'span',
          {},
          `${weekdayLabel(ctx.provider.now().dayIndex + day)} is beyond the ${horizon} hour forecast. Hour by hour detail and a grade for this route arrive closer to the day.`,
        ),
      ),
    );
  }

  const { hourOfDay } = ctx.provider.now();
  const cells: HTMLElement[] = [];
  const ticks: HTMLElement[] = [];
  const best = grade.bestWindow;

  // ---- the tooltip ---------------------------------------------------------
  //
  // A real element rather than the `title` attribute it replaces, for three reasons that
  // all showed up in review: the native tooltip takes a second to appear, it cannot be
  // reached by a finger at all, and it renders outside the phone frame, which on a page
  // whose whole argument is a phone screen looks like a bug in the deck.
  //
  // It is absolutely positioned inside the figure, so showing it moves nothing, and it is
  // clamped to the figure's own width so it can never spill past the bezel.
  const tip = h('div', { class: 'st-tip', hidden: true, role: 'status' });
  const figure = h('div', { class: 'strip-figure' });
  let openAt = -1;

  const hideTip = (): void => {
    tip.setAttribute('hidden', '');
    openAt = -1;
  };

  const showTip = (at: number, cell: HTMLElement, head: string, why: string | null): void => {
    const parts: HTMLElement[] = [h('span', { class: 'tt-head' }, head)];
    if (why) parts.push(h('span', { class: 'tt-why' }, why));
    tip.replaceChildren(...parts);
    tip.removeAttribute('hidden');
    openAt = at;
    // Measured after it is visible, or the width is zero and every tooltip lands left.
    const half = tip.offsetWidth / 2;
    const centre = cell.offsetLeft + cell.offsetWidth / 2;
    const room = figure.clientWidth;
    tip.style.left = `${Math.round(Math.max(half, Math.min(room - half, centre)))}px`;
  };

  for (let hod = STRIP_FROM; hod <= STRIP_TO; hod++) {
    const hoursFromNow = 24 * day + hod - hourOfDay;
    const sample = hoursFromNow >= 0 ? routeHour(weather.series, hoursFromNow) : null;

    const inBest = best !== null && hoursFromNow >= best.startHour - 0.01 && hoursFromNow < best.endHour;
    const clock = `${String(hod).padStart(2, '0')}:00`;
    const head = sample
      ? `${clock} · ${Math.round(sample.thunder * 100)}% storms · ${formatTemp(sample.tempC, ctx.units)}`
      : `${clock} · already past`;
    // The best-window mark is the other unexplained thing on the cell, so where it applies
    // it joins the reason rather than getting a legend of its own.
    const why = sample
      ? `${cellReason(sample.thunder)}${inBest ? '. In the window this route fits' : ''}`
      : null;

    const cell = h('div', {
      class: `${sample ? stripCellClass(sample.thunder) : 'st-cell is-past'}${inBest ? ' in-best' : ''}`,
      // Not a `title`: this is what a screen reader gets, and the visible tooltip carries
      // the same text for everyone else. The role is what makes the label reachable at all;
      // a bare div with an aria-label is ignored by several screen readers, and a cell IS a
      // graphical mark with a text alternative.
      role: 'img',
      'aria-label': why ? `${head}. ${why}` : head,
    });

    const at = hod;
    // Hover for a pointer, tap to toggle for a finger. `pointerType` is what separates
    // them; a touch also synthesises an enter event, so the enter path has to refuse it or
    // the tap that follows immediately closes what the enter just opened.
    cell.addEventListener('pointerenter', (ev) => {
      if ((ev as PointerEvent).pointerType === 'touch') return;
      showTip(at, cell, head, why);
    });
    cell.addEventListener('pointerleave', (ev) => {
      if ((ev as PointerEvent).pointerType === 'touch') return;
      hideTip();
    });
    cell.addEventListener('click', () => {
      if (openAt === at) hideTip();
      else showTip(at, cell, head, why);
    });

    cells.push(cell);
    ticks.push(h('div', { class: 'st-tick' }, hod % 3 === 0 ? clock.slice(0, 2) : ''));
  }

  figure.append(tip, h('div', { class: 'strip' }, ...cells), h('div', { class: 'strip-ticks' }, ...ticks));

  const peak = (() => {
    let worst = 0;
    let at = -1;
    for (let hod = STRIP_FROM; hod <= STRIP_TO; hod++) {
      const s = routeHour(weather.series, 24 * day + hod - hourOfDay);
      if (s && s.thunder > worst) {
        worst = s.thunder;
        at = hod;
      }
    }
    return { worst, at };
  })();

  return h(
    'div',
    { class: 'strip-wrap' },
    // The section label keeps the sheet's rhythm. THE WINDOW ITSELF IS NO LONGER STATED
    // HERE: it was this block's headline, in body type, and it is now the first line of the
    // brief at the top of the sheet (see `briefLines`, de-duplication 4). It MOVED rather
    // than being copied, so the strip below is now the supporting picture for a
    // recommendation the reader has already read, which is the order the sheet claims to
    // be in anyway. The green underline on the cells and the legend item that explains it
    // both stay: that is a key for a mark, not a second statement of the window.
    h(
      'div',
      { class: 'strip-title' },
      'When to go',
      h('span', { class: 'strip-sub' }, 'hour by hour along the route'),
    ),
    figure,
    h(
      'div',
      { class: 'strip-legend' },
      // The green underline on the cells is an unexplained mark without its key.
      best ? h('span', { class: 'sl-item' }, h('i', { class: 'sl-swatch is-best' }), 'best window') : null,
      // Storms keep their number here rather than in the headline: visible, checkable, and
      // no longer the frame the whole strip is read through.
      peak.at >= 0 && peak.worst >= 0.12
        ? h('span', { class: 'sl-item' }, `Storms peak ${Math.round(peak.worst * 100)}% at ${String(peak.at).padStart(2, '0')}:00`)
        : h('span', { class: 'sl-item' }, 'No storms in the forecast'),
    ),
  );
}

// ============================================================================
// UGC
// ============================================================================
//
// The gap the benchmark found, answered. Open data has no ratings, no photos and no
// reviews, so it cannot support an honest popularity sort; UGC is how a product earns
// that signal, and this is where the flow is actually demonstrated rather than described.
//
// THE HONESTY RULE IS ENFORCED HERE, not just documented in ugc.ts:
//   every seeded artefact renders with a SAMPLE tag,
//   everything the reader adds renders with a YOURS tag,
//   and the seeded rating average never moves when the reader rates the trail.
//
// THE EMPTY STATE IS THE MAIN STATE. Almost no trail is rated (ugc.ts sets out the
// distribution and why), so the sheet a reader opens is usually the one with nothing on
// it. That case leads with an invitation rather than a report of absence: the trail has no
// rating, so the first thing on the block is the way to give it one. Treating it as the
// exception would mean building the screen around the case that almost never happens.
//
// The photo control is a real <input type="file"> producing a real object URL, because a
// mocked upload demonstrates nothing about whether the flow works. The add tile sits
// first in the photo strip, so an empty strip is an affordance rather than a grey box.

function photoTile(photo: UgcPhoto): HTMLElement {
  const mine = photo.origin === 'mine';
  const tile = h('div', { class: `ph-tile${mine ? ' is-mine' : ''}` });

  if (mine && photo.src) {
    const img = h('img', { class: 'ph-img', src: photo.src, alt: photo.caption }) as HTMLImageElement;
    tile.appendChild(img);
  } else {
    // A seeded photo has no image, and inventing one would be inventing evidence about a
    // real place. It renders as an empty slot that says what it is.
    tile.appendChild(h('div', { class: 'ph-empty' }, icon('camera', 20)));
  }
  tile.appendChild(h('span', { class: `ph-tag${mine ? ' is-mine' : ''}` }, mine ? 'yours' : 'sample'));
  return tile;
}

function commentRow(c: UgcComment): HTMLElement {
  const mine = c.origin === 'mine';
  return h(
    'div',
    { class: `cmt${mine ? ' is-mine' : ''}` },
    h(
      'div',
      { class: 'cmt-head' },
      h('span', { class: 'cmt-who' }, c.authorName),
      c.rating > 0 ? starGlyphs(c.rating, 11) : null,
      h('span', { class: 'cmt-when' }, c.when),
      h('span', { class: `cmt-tag${mine ? ' is-mine' : ''}` }, mine ? 'yours' : 'sample'),
    ),
    h('p', { class: 'cmt-text' }, c.text),
  );
}

function ugcBlock(ctx: Ctx, trail: ScopeTrail): HTMLElement {
  const ugc = getUgc(trail.id);
  const rerender = (): void => ctx.setUi({});
  const rated = ugc.ratingAvg !== null && ugc.ratingCount > 0;

  // ---- photos: the input first, because the add tile leads the strip -------
  const fileInput = h('input', {
    class: 'ugc-file',
    type: 'file',
    accept: 'image/*',
    id: `ugc-photo-${trail.id.replace(/[^a-z0-9]+/gi, '-')}`,
  }) as HTMLInputElement;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) addPhoto(trail.id, file);
    fileInput.value = '';
    rerender();
  });

  // A real control in the first tile position. An empty strip that said "No photos yet"
  // was a statement where an action belongs, and on a page where most trails have no
  // photos at all that statement was most of what the strip ever did.
  const addTile = h(
    'label',
    { class: 'ph-tile ph-add', for: fileInput.id },
    icon('camera', 20, 'pa-glyph'),
    h('span', { class: 'pa-label' }, 'Add photo'),
  );

  const strip = h('div', { class: 'ph-strip' }, addTile, ...ugc.photos.slice(0, 8).map(photoTile));

  // ---- the reader's own rating --------------------------------------------
  const picker = starPicker(ugc.myRating, (stars) => {
    // Tapping the same star again clears it, which is the behaviour every rating control
    // in every app has and the one people reach for when they mis-tap.
    setMyRating(trail.id, ugc.myRating === stars ? null : stars);
    rerender();
  });

  // ---- the headline: a number when there is one, an invitation when there is not ----
  //
  // The unrated version is the one almost every trail shows. It does not report an absence
  // and stop; it says why the absence is there (open data has no opinions in it) and hands
  // over the control that fixes it. Once the reader rates it, the panel acknowledges that
  // their rating is the only one and marks it as theirs: it is still not a crowd, and it
  // is still never folded into a seeded count.
  const summary = rated
    ? h(
        'div',
        { class: 'ugc-sum' },
        h('span', { class: 'us-avg' }, (ugc.ratingAvg ?? 0).toFixed(1)),
        h(
          'span',
          { class: 'us-right' },
          starGlyphs(ugc.ratingAvg ?? 0, 15),
          h(
            'span',
            { class: 'us-count' },
            `${ugc.ratingCount} sample rating${ugc.ratingCount === 1 ? '' : 's'}`,
          ),
        ),
      )
    : h(
        'div',
        { class: 'ugc-first' },
        h(
          'div',
          { class: 'uf-copy' },
          h(
            'div',
            { class: 'uf-title' },
            ugc.myRating === null ? 'Be the first to rate this trail' : 'Yours is the only rating here',
          ),
          h(
            'div',
            { class: 'uf-body' },
            // Product voice, not method voice. The earlier copy explained where the gap
            // comes from ("open data carries the line on the map and nothing about walking
            // it"), which is an argument the prose column makes and the product should not.
            ugc.myRating === null
              ? 'Nobody has rated this trail yet. Ratings, photos and reports come from the people who walk it.'
              : 'Yours is the only rating on this trail so far. It stays marked as yours until other people add theirs.',
          ),
        ),
        h(
          'div',
          { class: 'uf-act' },
          picker,
          ugc.myRating !== null ? h('span', { class: 'uf-tag' }, 'yours') : null,
        ),
      );

  // ---- the composer --------------------------------------------------------
  const box = h('textarea', {
    class: 'ugc-text',
    rows: '2',
    placeholder: rated ? 'Add a comment' : 'Say what it was like',
    maxlength: '280',
  }) as HTMLTextAreaElement;
  box.value = ugcDraft(trail.id);
  box.addEventListener('input', () => setUgcDraft(trail.id, box.value));

  const post = h('button', { type: 'button', class: 'ugc-post' }, 'Post');
  post.addEventListener('click', () => {
    if (!box.value.trim()) return;
    addComment(trail.id, box.value, ugc.myRating);
    clearUgcDraft(trail.id);
    rerender();
  });

  return h(
    'div',
    { class: 'ugc' },
    // No sub-line. It used to carry the provenance of the seeded content ("seeded sample
    // content, not measured"), which is method copy in the product's own voice. The per
    // item `sample` / `yours` tags below still mark every artefact, and the prose column
    // beside the phone still states that this content is simulated.
    h('div', { class: 'strip-title' }, 'Ratings and photos'),
    summary,
    strip,
    fileInput,
    // The rated case still needs somewhere to leave a rating of its own. The unrated case
    // already has the picker in the panel above, so repeating it here would put two live
    // star controls for the same value on one sheet.
    rated
      ? h('div', { class: 'ugc-mine' }, h('span', { class: 'um-label' }, 'Your rating'), picker)
      : null,
    h('div', { class: 'ugc-compose' }, box, post),
    ...ugc.comments.slice(0, 6).map(commentRow),
  );
}

// ============================================================================
// THE PEEK'S OWN MAP
// ============================================================================
//
// Reuses `pmap.ts` wholesale: same `PhoneMap` class, same DEM terrain source, same twin-
// source hillshade, same fallback if the DEM turns out unreachable, same condition colour
// ramp (`trailFeature`/`levelColor`). Nothing here retunes the camera, the terrain or the
// colours; the only new thing is a SECOND instance, framed on one trail instead of a
// region's worth, living inside this sheet rather than behind it.
//
// LIFECYCLE. `peekSheet()` runs on every render while the peek is open — a day tap, a
// traversal switch, a grade fill, a UGC edit — and a MapLibre instance is not something to
// tear down and rebuild on a keystroke (that is exactly the class of bug the results map's
// own singleton, `app.ts`'s `pmap`, already exists to avoid). So this is the same pattern:
// ONE canvas element and ONE `PhoneMap` instance survive across renders in module state,
// keyed by trail id, and are moved into whichever tree this render builds rather than
// recreated. `teardownPeekMap()` is the other half — `app.ts`'s `buildSheets()` calls it
// whenever the peek is not the sheet actually on screen this render (closed via the X or
// the scrim, superseded by the filter or sort sheet, or the whole phone torn down) — because
// this module has no way to know its own sheet closed: a closed peek simply stops being
// asked to render, and nothing here would otherwise notice.
let peekMapEl: HTMLElement | null = null;
let peekMapInst: PhoneMap | null = null;
let peekMapTrailId: string | null = null;

/** Kept small and fixed: enough to see the tilt, not so much it competes with the
 *  profile it sits beside for the reader's attention. */
const PEEK_MAP_PAD = 20;

function peekMapBlock(ctx: Ctx, trail: ScopeTrail): HTMLElement {
  if (!peekMapEl) peekMapEl = h('div', { class: 'peek-map-canvas' });

  const isNewTrail = peekMapTrailId !== trail.id || !peekMapInst;
  if (isNewTrail) {
    peekMapInst?.destroy();
    peekMapInst = new PhoneMap(peekMapEl, {
      // The REGION's bbox, not the trail's, even though the trail is all this map ever
      // shows. Constructing straight onto a single trail's tiny bbox starts the camera at
      // a tight zoom on the very first frame, before the DEM has ever been requested at
      // any coarser level, and on a pitched, terrain-exaggerated view that leaves the
      // terrain mesh with nothing to render: verified empirically (a blank canvas that
      // Playwright confirmed is genuinely empty pixels, not a slow-tile timing issue) and
      // fixed empirically (stepping the camera down through a lower zoom first always
      // recovers it). Constructing at the region's own scale, exactly as the results map
      // already does, seeds the DEM pyramid at a sane zoom before `fitBBoxWhenSettled`
      // below (pmap.ts) races a real `idle` and zooms in tight on the one trail, which is
      // the same two-step camera path the results map already takes (region on mount, a
      // single trail's `fitBBox` only once it is selected) and never hits this.
      bbox: ctx.region.bbox,
      // The one trail on this map IS the selection; there is nothing else here to pick,
      // so a tap has nothing useful to do.
      onPick: () => {},
    });
    peekMapTrailId = trail.id;
  }
  // Narrows `peekMapInst` to non-null for the rest of this call, including inside the
  // closure below: it was either just constructed above or already was (that is what
  // `isNewTrail` being false means). The guard is for the type checker, not the runtime.
  const inst = peekMapInst;
  if (!inst) return h('div', { class: 'peek-map-wrap' });

  const grade = peekGrade(ctx, trail);
  inst.whenReady(() => {
    // Coloured by THIS peek's own selection, the same `trailFeature`/`levelColor` the
    // results map paints every card's line with, so the map behind the list and the map
    // inside this sheet can never disagree about what colour the same trail is.
    inst.setTrails([trailFeature(trail, grade)]);
    // THE OTHER HALF OF THE TREELINE WIDGET. The profile chart further down this sheet has
    // drawn a labelled dashed rule at the region's treeline since it was built; this is the
    // same fact on the same sheet's map, and Concept A (`trail/mapconcept.ts`) has drawn it
    // on a map since §13 of TRAIL_PLAN. It is the SAME implementation, not a second one:
    // `treelineExposedFeature` and the overlay layer live in pmap.ts, the map class this
    // sheet and Concept A both mount, and were moved there rather than copied when this call
    // site was added. The dash means treeline on all four surfaces that draw it.
    //
    // `trail`, never `profileTrail`. `displayProfileTrail` mirrors or doubles the profile to
    // match the traversal control, which is right for a height-over-distance chart and wrong
    // here: the map draws the stored geometry once, and the stretch of hillside above
    // treeline does not move because a walker turns around on it.
    //
    // NO KEY CHIP, and that is a decision rather than an omission. Concept A prints one
    // because its frame has no elevation profile at all, so the map is the only place its
    // dash appears, and because it already has a key row for its four condition bands to hang
    // the chip on. Neither holds here: this sheet's profile carries the same dash WITH its
    // elevation spelled out ("TREELINE 3,400 M"), so a chip would be a second key for one
    // mark on one sheet — the same one-fact-one-place rule the brief above is built on — and
    // this map is a 150 px band with no legend furniture to add it to without inventing some.
    // The honest cost, recorded rather than papered over: since §15 moved the map to lead the
    // sheet, the dash is now seen BEFORE the rule that names it, so a reader meets the mark a
    // few blocks before its key. That is a scroll away on a sheet the reader is already
    // scrolling, and it is cheaper than a chip that says a third time what the profile and the
    // clause in the brief ("above treeline") both already say.
    inst.setExposedOverlay(treelineExposedFeature(trail, ctx.region.treelineM));
    if (isNewTrail) {
      // NOT fit straight away: see `fitBBoxWhenSettled` (pmap.ts), which this shares with
      // `trail/mapconcept.ts`'s single-trail map, the second call site with the exact same
      // requirement. The full empirical case for it (a pitched, terrain-exaggerated camera
      // jumping straight to a tight bbox renders a genuinely blank canvas, on this trail
      // and on ones with far less relief) now lives there rather than duplicated here.
      inst.fitBBoxWhenSettled(trail.bbox, PEEK_MAP_PAD);
    }
    // The canvas has no reliable size until this element is actually attached, which
    // happens a moment after this function returns (`peekSheet()`'s tree is handed to
    // `app.ts`'s `buildSheets()`, which attaches it before yielding to the browser). Same
    // fix as the results map's own blank-map bug (SCOPE_PLAN §11): resize AFTER attach.
    requestAnimationFrame(() => inst.resize());
  });

  return h('div', { class: 'peek-map-wrap' }, peekMapEl);
}

/** Closes the peek's own map. See the header note above: called by `app.ts` whenever the
 *  peek is not the sheet on screen, so a MapLibre instance never outlives its sheet. */
export function teardownPeekMap(): void {
  peekMapInst?.destroy();
  peekMapInst = null;
  peekMapTrailId = null;
  peekMapEl = null;
}

export function peekSheet(ctx: Ctx, trail: ScopeTrail): HTMLElement {
  const units = ctx.units;
  const traversal = traversalFor(trail);
  const grade = peekGrade(ctx, trail);
  // Built ONCE for the whole sheet, because two blocks read it: the verdict renders it, and
  // the conditions row above it has to know which fields it is about to be told twice. Empty
  // while the grade is still pending, which is the same state `verdictBlock` renders its
  // "Checking conditions" form for and which `peekConditions` treats as "the brief claims
  // nothing, so keep every field".
  const brief = grade ? briefLines(ctx, trail, grade) : [];

  const close = h('button', { type: 'button', class: 'sh-close', 'aria-label': 'Close' }, icon('close', 16));
  close.addEventListener('click', () => ctx.set({ selected: null, screen: 'results', view: 'map' }));

  const details = h('button', { type: 'button', class: 'peek-details' }, h('span', {}, 'Details'), icon('chevron', 14, 'pd-caret'));
  // A deliberate stub, kept short. The earlier text explained the build phasing, which is
  // planning language and belongs in the prose column rather than in the product.
  const stub = h(
    'div',
    { class: 'peek-stub', hidden: true },
    'Not in this build. The full trail page, the on-route weather timeline, saved trails and navigation come later.',
  );
  details.addEventListener('click', () => {
    const wasHidden = stub.hasAttribute('hidden');
    if (wasHidden) stub.removeAttribute('hidden');
    else stub.setAttribute('hidden', '');
    details.classList.toggle('is-open', wasHidden);
  });

  // The label carries the qualifier here, not the value: `.msr-top` is a nowrap row sized
  // for a short number plus an icon, but `.msr-label` is a caption underneath with room to
  // spare, and unlike the card there is no separate route-type glyph in this row fighting
  // it for space (the peek states the type in words in `.peek-sub` above). The qualifier
  // itself now follows `traversalRow`'s selection (`peekDuration`, above) rather than the
  // card's fixed rule (`needsOneWayLabel` in model.ts, which the card still uses
  // unconditionally: it has no control to read a selection off). With `Incl. return`
  // chosen the figure is the whole outing and carries no "one way" qualifier, exactly as
  // a loop's already does.
  const duration = peekDuration(trail, traversal);
  const measures = h(
    'div',
    { class: 'msr-row' },
    measure('ruler', formatLength(trail.lengthM, units), 'Length'),
    measure('up', formatElevation(trail.gainM, units), 'Gain'),
    hasDescent(trail) ? measure('down', formatElevation(trail.descentM, units), 'Descent') : null,
    measure('clock', formatDuration(duration.minutes), duration.label),
  );

  // The profile chart mirrors/doubles with the selection (`displayProfileTrail`); the axis
  // labels below it read off the SAME object, so "0 / half / full" can never quote the
  // trail's stored one-way length under a chart that is currently drawing the round trip.
  const profileTrail = displayProfileTrail(trail, traversal);

  return h(
    'div',
    { class: 'sh sh-peek' },
    h('div', { class: 'sh-grab' }),
    h(
      'div',
      { class: 'peek-head' },
      h(
        'div',
        { class: 'peek-heading' },
        h('h2', { class: 'peek-name' }, trail.name),
        // Difficulty and route type came off the card to make room; they live here, where
        // there is space to label difficulty `computed` every time it appears rather than
        // repeating the badge down a scrolling list.
        h(
          'div',
          { class: 'peek-sub' },
          difficultyDot(trail.difficulty),
          // ' · ', not '·': a bare dot glyph between two spans concatenates onto its
          // neighbours with no space when the row is read as `textContent` (a screen
          // reader, a copy-paste), even though the flex `gap` makes it look spaced on
          // screen. The visible gap is unchanged; this only affects the text run.
          h('span', { class: 'cm-dot' }, ' · '),
          // The reload glyph (Change 1's icon, so the card and the peek can never draw two
          // different "loop" shapes) sits BEFORE the word rather than replacing it, unlike
          // the card's `routeTypeGlyph`. On the card the glyph substitutes for text because
          // the row has no room for both; here there is room and the word is already doing
          // the job the glyph would otherwise duplicate, so this is glyph-plus-label, not
          // glyph-instead-of-label. `icon()` sets `aria-hidden` itself: the word carries the
          // accessible name, and a second one on the glyph would read as "Loop loop".
          // Glyph and word are wrapped in their own flex span with a tighter 4px gap than
          // `.peek-sub`'s own 6px between groups, so the pair reads as one unit rather than
          // as three evenly-spaced items.
          trail.routeType === 'loop'
            ? h('span', { class: 'ps-route' }, icon('loop', 12, 'ps-loop-glyph'), h('span', { class: 'ps-type' }, 'Loop'))
            : h('span', { class: 'ps-type' }, 'Point to point'),
          // Surface only when there is one. The old fallback read "surface untagged", which
          // names the data model rather than the trail; a product that does not know the
          // surface simply does not mention it.
          trail.surface ? h('span', { class: 'cm-dot' }, ' · ') : null,
          trail.surface ? h('span', {}, trail.surface.replace(/_/g, ' ')) : null,
        ),
      ),
      close,
    ),
    // VERDICT FIRST, WITH ONE DELIBERATE EXCEPTION AT THE TOP. From the measures row down,
    // the order is unchanged: what the route is (now including how you mean to walk it,
    // which is still part of "what the route is": it changes the number in the row above,
    // not the judgement below), then what the conditions mean, then when to go, then what
    // it will feel like, then why the grade came out where it did. The profile sits below
    // the window rather than above it because it answers a later question: once the reader
    // has decided the day works, the climb is what they check next. What is new is the map
    // ABOVE all of that, between the header and the measures row — see the comment at its
    // call site immediately below for why a visual anchor now leads the sheet.
    h('div', { class: 'sh-body' },
      // THE MAP LEADS THE SHEET, BY DESIGN. It used to sit lower down, back to back with
      // the profile (see that block's own comment for what survives of that reasoning),
      // on the argument that anything above the verdict would "undo the verdict-first
      // order this sheet is built around" by making the reader scroll past a map before
      // reaching the go/no-go judgement. That argument was sound, and Björn overruled it
      // anyway: opening on a name and a close button gives the reader nothing to look at,
      // and he wants a visual anchor first, specifically "title, then the map, then the
      // stats for it". So this is a deliberate exception carved out of the verdict-first
      // rule at the very top of the sheet, not an abandonment of it: everything from the
      // measures row down still reads in the order the comment above this block describes.
      peekMapBlock(ctx, trail),
      measures,
      // Measures are what the route IS; this is what the conditions ARE. Two rows of
      // measured facts in that order, which is the same order the card uses (meta row, then
      // conditions row), so opening a card feels like the same object gaining detail rather
      // than a second screen with its own vocabulary.
      peekConditions(ctx, trail, brief),
      traversalRow(ctx, trail),
      verdictBlock(ctx, trail, brief),
      // The week sits directly under the verdict and above the hours, which is the order
      // the decision is actually made in: is today the day, and if not, which day is.
      weekRow(ctx, trail),
      timeWindow(ctx, trail),
      h(
        'div',
        { class: 'peek-profile' },
        profileSparkline(profileTrail, {
          w: 320,
          h: 92,
          level: grade ? grade.level : null,
          outlook: grade?.confidence === 'outlook',
          labels: true,
          labelHigh: formatElevation(trail.maxElevM, units),
          labelLow: formatElevation(trail.minElevM, units),
          treeline: peekTreeline(ctx),
        }),
        h(
          'div',
          { class: 'pp-axis' },
          h('span', {}, '0'),
          h('span', {}, formatLength(profileTrail.lengthM / 2, units)),
          h('span', {}, formatLength(profileTrail.lengthM, units)),
        ),
        // No parts note. `profileSparkline` still draws a break at every seam, which is the
        // honest rendering; counting the pieces and explaining the drawing was the sheet
        // narrating its own method to someone trying to pick a walk.
      ),
      // TWO VIEWS OF THE SAME GEOMETRY, DELIBERATELY BOTH KEPT, NO LONGER BACK TO BACK.
      // This profile answers "what will this feel like" as a height-over-distance
      // silhouette; `peekMapBlock`, now at the TOP of the sheet rather than down here (see
      // its call site's own comment), answers "where is it, on the real terrain" as a
      // place, tilted so the shoulder an amber route climbs over is visible rather than
      // asserted (SCOPE_PLAN §5's argument for the results map, replayed here at one-trail
      // scale). The two used to sit right next to each other for exactly that reason, one
      // geometry read two ways in a row, and moving the map up to be the sheet's visual
      // anchor breaks that adjacency as a side effect of a decision made for an unrelated
      // reason. Neither view substitutes for the other regardless of where it sits: the
      // profile has no orientation or basemap, the map has no clean read of steepness along
      // the way, so both stay. If a designer ends up finding one visual too many once this
      // is in front of them, that is a call for Björn to make, not a default taken here.
      // WHAT'S DRIVING THIS USED TO SIT HERE, four factor rows under a title, and it is
      // gone rather than moved: the brief at the top of the sheet is that list, ordered by
      // the same penalties, carrying the same clauses with their hours, above the fold
      // instead of below the map and the profile. Keeping both would have printed every
      // factor twice on one sheet, which is exactly the duplication the restructure was
      // asked to resolve. See `briefLines` for the full de-duplication note.
      ugcBlock(ctx, trail),
      details,
      stub,
    ),
  );
}
