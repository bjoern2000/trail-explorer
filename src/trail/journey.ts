// Trail mode — the journey model.
//
// One computation, two renderings. Both concepts on `weather-on-route.html` are views of the
// SAME `Journey` object, which is the point of building it separately: if the spatial
// chart and the table disagree about when you reach treeline, one of them is lying, and
// sharing the model makes that impossible rather than merely unlikely.
//
// A Journey is the trail's elevation profile re-indexed by TIME instead of by distance.
// Everything else on the page falls out of that one move.
//
// THREE THINGS THIS MODEL DOES NOT INVENT
//
//   1. Elevation comes from `trail.profile`, the same 48 samples the card sparkline and
//      the grader already use (`profileElevAt`). No re-sampling, so the chart here and
//      the sparkline there cannot disagree about the same trail.
//   2. Weather comes from the `WeatherProvider`, at points on the route at their real
//      elevations, exactly as `gradeTrail` asks for it. Trail mode asks for more points
//      than the grader's five, because it has a distance axis to fill, but it asks the
//      same way and would take Super Resolution with no change here.
//   3. Conditions LEVELS reuse the storm thresholds the peek's hour strip already
//      switches on (see `stripCellClass` in phone/peek.ts: 0.12 / 0.30 / 0.55). They are
//      duplicated rather than imported because peek's copy is module-private; if trail
//      mode graduates from a concepts page, unify them, because two copies of a
//      threshold is exactly how a tint starts disagreeing with its own explanation.
//
// TWO REAL DATA HAZARDS, both hit on the first trail tried
//
//   SEAMS. A merged trail can be several disconnected parts (MERGE_PLAN.md §6), and the
//   profile runs straight across the gap. East Longs Peak Trail, the obvious hero pick,
//   is `parts: 2` with `seamIndices: [47]`, and its profile drops 648 m between the last
//   two samples: not a descent, a different piece of trail 600 m lower. Timed naively
//   that final leg reads as a fast downhill and the chart shows a cliff. `seamIndices`
//   is carried in the derived data precisely so this is detectable, so seam legs are
//   excluded from the walk: no distance, no time, no marker. The journey is the walkable
//   parts only, and `seamCount` reports what was dropped rather than hiding it.
//
//   DEPARTURE INSIDE THE HORIZON. Super Resolution is +36 h, and a journey is not an
//   instant: it occupies hours. A dawn start the day after tomorrow is already past the
//   horizon before the first step, so trail mode is route-specific for a much shorter
//   window than the discovery list is. `withinHorizon` is computed from the journey's
//   END, not its start, because a route-specific morning that turns into an outlook
//   afternoon is still not a route-specific day.

import { NO_TREELINE_M } from '../scope/model';
import { profileElevAt, routeSamplePoints } from '../scope/weather/provider';
import {
  DRY_HALFLIFE_BASE_H,
  DRY_HALFLIFE_GAIN_H,
  WET_CEILING,
  WET_SATURATION_MM,
  terrainFacts,
} from '../scope/weather/grade';
import type {
  RegionDef,
  RouteType,
  ScopeTrail,
  WeatherProvider,
  WeatherSample,
} from '../scope/types';
import { paceDef, paceKph, type PaceId } from './pace';

/**
 * How the trail is WALKED, distinct from `RouteType` (a fact about the geometry). This is
 * the answer to TRAIL_PLAN §8's open question: "does trail mode assume round trip, or
 * ask?" It asks, because SCOPE_PLAN §2 already cut out-and-back as a derivable ROUTE
 * TYPE ("not derivable from a single OSM geometry; AllTrails knows it because users
 * record it") for the same reason it cannot be derived as a walking CHOICE either: only
 * the user knows whether they parked a second car, or are turning around.
 *
 * A single field rather than two independent ones (say `roundTrip: boolean` plus
 * `reversed: boolean`) so an invalid combination has no representation to be invalid IN:
 * "one-way on a loop" and "clockwise on a point-to-point trail" simply are not values of
 * this type for that trail. `normalizeTraversal` still clamps anything that reaches
 * `buildJourney` from outside this module (a stale selection surviving a trail swap, an
 * options object built by hand) to one the trail's own geometry can support, so the
 * invariant holds even when a caller forgets to re-derive the control's own options
 * first.
 *
 * CLOCKWISE IS A LABEL FOR THE STORED DIRECTION, NOT A COMPASS CHECK. `routeType` tells
 * us a loop's geometry closes; it does not tell us which of its two stored directions is
 * clockwise on a map, and this module never asks a shoelace formula to find out. `'cw'`
 * means walked in the profile's own stored order (SCOPE_PLAN §8: every trail is oriented
 * low-end-first before measuring), `'ccw'` reverses it, so the reversed direction starts
 * at the HIGH end rather than the low one. That is an honest simplification rather than a
 * shortcut that happens to be safe: see TRAIL_PLAN.md §10 for why no loop in the seeded
 * data is large enough for the distinction to move a real number either way (the page
 * itself dropped this finding in its 2026-08-10 word-budget cut; the check still lives
 * in route.ts's git history and TRAIL_PLAN.md is the surviving source of record).
 */
export type Traversal = 'out-and-back' | 'one-way' | 'cw' | 'ccw';

/** The two `Traversal` values a `RouteType` actually supports, default first. Loop
 *  trails cannot be walked one way (there is no far end to arrive at once instead of
 *  twice) or turned around (there is nothing to turn around from); point-to-point trails
 *  have no direction of travel around a circuit to be clockwise about. */
export function traversalOptions(routeType: RouteType): Traversal[] {
  return routeType === 'loop' ? ['cw', 'ccw'] : ['out-and-back', 'one-way'];
}

/** The honest default named in route.ts's control: SCOPE_PLAN §8 measures 92 to 97
 *  percent of these trails walked out and back (loops are 3 to 8 percent), so
 *  out-and-back and clockwise lead their options rather than being picked arbitrarily. */
export function defaultTraversal(routeType: RouteType): Traversal {
  return traversalOptions(routeType)[0];
}

/** Clamps a `Traversal` to one `routeType` can support, rather than letting an
 *  impossible combination reach `buildJourney`'s walk-construction code, where it would
 *  either silently do the wrong thing or need a second guard down there to catch it. */
export function normalizeTraversal(routeType: RouteType, traversal: Traversal): Traversal {
  const options = traversalOptions(routeType);
  return options.includes(traversal) ? traversal : options[0];
}

/** Control label text, in the register the rest of the phone's pills use: a place, a
 *  direction, nothing that reads as advice. */
export const TRAVERSAL_LABEL: Record<Traversal, string> = {
  'out-and-back': 'Out and back',
  'one-way': 'One way',
  cw: 'Clockwise',
  ccw: 'Anticlockwise',
};

/**
 * Forecast points requested along the route.
 *
 * The grader uses five, which is enough to make a single verdict route-specific. A
 * distance axis needs more or the tint quantises into five visible blocks and reads as
 * a chart of the sampling rather than a chart of the weather. Twelve at Flattop is a
 * point every ~540 m, below the 3 km Super Resolution grid, so the limit on resolution
 * is the forecast and not our sampling. Stated on the page rather than implied.
 */
export const JOURNEY_SAMPLE_POINTS = 12;

/** Storm-probability bands. Mirrors phone/peek.ts `stripCellClass`. See header note 3. */
export type Level = 0 | 1 | 2 | 3;

export function levelForThunder(thunderProb: number): Level {
  if (thunderProb >= 0.55) return 3;
  if (thunderProb >= 0.3) return 2;
  if (thunderProb >= 0.12) return 1;
  return 0;
}

/** Underfoot state in the same plain-language register grade.ts's wetness factor text
 *  already uses ("wet underfoot", "damp...", "a few damp sections", "dry underfoot"). */
export type GroundWord = 'dry' | 'few-damp' | 'damp' | 'wet';

/**
 * Cut points in wetMm*holdsWater space, ascending, paired with the word that begins at
 * that x: penalty >= 18/7/2.5 on `W.wetness(32) * clamp((wetMm*holdsWater)/38, 0, 1.15)`.
 * `W.wetness`, the 38 divisor and the 1.15 ceiling are grade.ts-private, so rather than
 * export them (a second constant to keep in sync is the exact drift this array exists to
 * avoid), the same three cut points are carried over algebraically into wetMm*holdsWater
 * space: 18/32*38=21.375, 7/32*38=8.3125, 2.5/32*38=2.96875. Every number here is one of
 * grade.ts's own; none is chosen fresh. Factored out of `groundWord` so a headroom
 * calculation (`groundBandHeadroom`, below) reads the same three cuts rather than a second
 * typed copy of them, which is exactly how a band boundary starts disagreeing with itself.
 */
const GROUND_CUTS: [number, GroundWord][] = [
  [2.96875, 'few-damp'],
  [8.3125, 'damp'],
  [21.375, 'wet'],
];

export function groundWord(wetMm: number, holdsWater: number): GroundWord {
  const x = Math.min(WET_CEILING * WET_SATURATION_MM, wetMm * holdsWater);
  let word: GroundWord = 'dry';
  for (const [cut, w] of GROUND_CUTS) if (x >= cut) word = w;
  return word;
}

/**
 * How far a point's water sits from the next band in either direction, as a fraction of
 * the water already there. `up` is how much MORE water would push it into the next band
 * up; `down` is how much LESS would drop it into the next band down. Either is `null` at
 * the respective end of the scale (already 'wet' has no further "up"; already 'dry' has
 * no further "down").
 *
 * Exists so a claim like "this journey sits mid-band" is read off `groundWord`'s own cut
 * points rather than a fresh, possibly stale, guess at how wide a band is: see
 * TRAIL_PLAN.md §7, where the finding is that a real swing in `groundWetMm` does not
 * cross a band boundary on this trail (route.ts's Limits section states the structural
 * half of that finding in one line; the full swing arithmetic is TRAIL_PLAN's to carry).
 */
export function groundBandHeadroom(
  wetMm: number,
  holdsWater: number,
): { up: number | null; down: number | null } {
  const x = wetMm * holdsWater;
  const cuts = GROUND_CUTS.map(([cut]) => cut);
  const nextUp = cuts.find((cut) => cut > x);
  const nextDown = [...cuts].reverse().find((cut) => cut <= x);
  return {
    up: nextUp != null ? nextUp / x - 1 : null,
    down: nextDown != null ? 1 - nextDown / x : null,
  };
}

/** `GroundWord` in the register grade.ts's own wetness clauses use ("wet underfoot from
 *  Tuesday rain", "damp in the flats..."), minus the day attribution: a map label at 366 px
 *  has no room for it, and the day it rained is a route-level fact anyway, not a per-point
 *  one. One shared copy so route.ts's prose and mapconcept.ts's marker card cannot
 *  print two different words for the same GroundWord. */
export const GROUND_WORD_TEXT: Record<GroundWord, string> = {
  dry: 'dry underfoot',
  'few-damp': 'a few damp sections',
  damp: 'damp underfoot',
  wet: 'wet underfoot',
};

export interface Waypoint {
  /** Metres walked since departure, over the whole journey including the return leg. */
  travelM: number;
  /** Position along the trail geometry, 0..1. Two waypoints share a frac on an out-and-back. */
  frac: number;
  elevM: number;
  /** Signed grade of the leg ARRIVING here, percent. 0 at departure. */
  gradePct: number;
  /** Walking speed on that leg, km/h. */
  kph: number;
  /** Arrival, in hours from the provider's now. Fractional. */
  hour: number;
  /** Forecast at this point at the hour you arrive. */
  sample: WeatherSample;
  level: Level;
  /** True on the way out, false on the return leg. */
  outbound: boolean;
  /** At or above the region's treeline. Always false where no treeline exists. */
  exposed: boolean;
  /** False when the leg ARRIVING here crossed a seam. Its travelM/hour are frozen at the
   *  last walked point (see the seam handling in buildJourney), so its position is real
   *  geometry on the far side of a gap the walker never crossed, not a place or a time
   *  the walker was ever at. True for every normal leg, and always true at k=0 (depart
   *  has no arriving leg). Exists so extremum/transition marker search (high point, turn
   *  around, treeline crossing) can skip it: see the header comment's "no marker" clause. */
  reached: boolean;
  /** Water on the ground at this point, at the hour you reach it, mm. Same decay law
   *  grade.ts's wetness factor uses, evaluated per point and per hour: see buildJourney's
   *  ground-wetness comment. Feed it and the journey's `holdsWater` to `groundWord` for
   *  the plain-language label; the raw mm is not meant to be printed directly. */
  groundWetMm: number;
}

export type MarkerKind =
  | 'depart'
  | 'treeline-up'
  | 'high'
  | 'turn'
  | 'treeline-down'
  | 'finish'
  | 'sunset';

export interface Marker {
  kind: MarkerKind;
  /** Short label for the chart flag. No risk language: a place and a time, nothing more. */
  label: string;
  /** Second line, a measure. Empty where there is nothing factual to add. */
  sub: string;
  travelM: number;
  hour: number;
  level: Level;
}

export interface Journey {
  trail: ScopeTrail;
  region: RegionDef;
  pace: PaceId;
  /** Departure in hours from the provider's now. */
  departHour: number;
  /** Arrival back, in hours from the provider's now. */
  endHour: number;
  /** Total walking time, minutes. */
  totalMinutes: number;
  /** Journey distance: twice the trail for `'out-and-back'`, once for `'one-way'` or
   *  either loop direction. */
  totalM: number;
  /** How the trail was walked. Always normalized against `trail.routeType` (see
   *  `normalizeTraversal`) before the journey was built, so this is never a value the
   *  geometry could not actually support. */
  traversal: Traversal;
  /** True only for the `'out-and-back'` traversal: convenience for the one piece of logic
   *  (the turnaround marker, the retrace itself) that cares specifically about a round
   *  trip rather than about direction. False for `'one-way'` and for both loop
   *  directions, which walk the profile once and never retrace it. */
  outAndBack: boolean;
  waypoints: Waypoint[];
  markers: Marker[];
  /** Minutes spent at or above treeline. 0 where no treeline exists. */
  exposedMinutes: number;
  minElevM: number;
  maxElevM: number;
  /** Coldest and warmest sample actually met, at the hour met. */
  tempRangeC: [number, number];
  /** Strongest gust met, km/h. */
  peakGustKph: number;
  /** Highest storm probability met, 0..1. */
  peakThunder: number;
  /** Waypoints at each storm-probability level (0/1/2/3), in order. Sums to waypoints.length.
   *  Exists so a claim like "this departure crosses every band" is read off the journey
   *  rather than typed: see TRAIL_PLAN.md's departure-sensitivity finding (§5/§10; the
   *  page itself states the +36 h horizon consequence but no longer walks through this
   *  particular table). */
  levelCounts: [number, number, number, number];
  /** Prior-72 h precipitation, max over the sampled points, mm. */
  antecedentMm: number;
  /** Sunrise and sunset for the region, in hours from now. */
  sunriseHour: number;
  sunsetHour: number;
  /** False once any part of the journey falls past the provider's horizon. */
  withinHorizon: boolean;
  horizonHours: number;
  /** Geometry gaps skipped. Non-zero means the trail is not one continuous walk. */
  seamCount: number;
  /** How badly this ROUTE holds surface water (surface tag, steepness, profile shape via
   *  `terrainFacts`), 0.08 to 1.4. One number for the whole trail: open data carries one
   *  `surface` value, not one per segment, so THIS multiplier never varies with position.
   *  Ground-wetness concept (route.ts's Concept A) uses it against each waypoint's own
   *  `groundWetMm`, which does vary with position: different waypoints sit over different
   *  simulated rain cells, so the water amount moves with both the hour and where you are,
   *  even though the drainage multiplier it is scaled by does not. */
  holdsWater: number;
}

export interface JourneyOptions {
  /** Departure, in hours from the provider's now. */
  departHour: number;
  pace: PaceId;
  /** How to walk the trail. Optional: omitted means `defaultTraversal(trail.routeType)`.
   *  Whatever is passed is normalized against the trail's own `routeType` inside
   *  `buildJourney`, so a stale or mismatched value degrades to the default rather than
   *  producing a walk the geometry cannot support. */
  traversal?: Traversal;
}

/** Hour label on a 24 h clock for an hours-from-now offset, at minute resolution. */
export function journeyClock(provider: WeatherProvider, hoursFromNow: number): string {
  const { hourOfDay } = provider.now();
  const total = hourOfDay + hoursFromNow;
  const mins = Math.round(((total % 24) + 24) % 24 * 60);
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * "4 h 12 m" for a minute count. Matches model.formatDuration's shape at longer spans.
 *
 * THE SUB-HOUR FORM IS "42 min", NOT "42 m", and the reason is a real misread rather than a
 * style preference. Above an hour the "h" disambiguates and "4 h 12 m" cannot be anything but
 * a duration. On its own, "42 m" sits in an app whose every other bare unit is metres — trail
 * length, elevation, treeline, the ground's own `wetMm` — and it appeared for the first time
 * only when the walking anchor started printing what is LEFT rather than the whole walk. On
 * the one-way traversal that produced "Treeline ahead 42 m" directly under "Above treeline
 * 3450 m", which reads as a distance and is off by two orders of magnitude. No rendered output
 * that existed before this changed: nothing on the page ever printed a sub-hour duration,
 * because the shortest thing it measured was a 2 h 30 m walk.
 */
export function journeyDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${String(m % 60).padStart(2, '0')} m` : `${m} min`;
}

export async function buildJourney(
  trail: ScopeTrail,
  region: RegionDef,
  provider: WeatherProvider,
  opts: JourneyOptions,
): Promise<Journey> {
  const factor = paceDef(opts.pace).factor;
  const treeline = region.treelineM;
  const hasTreeline = treeline < NO_TREELINE_M;

  // ---- the walk, as fracs along the geometry -------------------------------
  const profLen = Math.max(2, trail.profile?.length ?? 2);
  const legM = trail.lengthM / (profLen - 1);
  const traversal = normalizeTraversal(trail.routeType, opts.traversal ?? defaultTraversal(trail.routeType));
  const outAndBack = traversal === 'out-and-back';
  const reversed = traversal === 'ccw';
  const seams = new Set(trail.seamIndices ?? []);

  // Index into the profile, and whether we are on the way out. `forwardIdx` is the
  // profile walked once, in the direction `traversal` asks for; `out-and-back` is that
  // same forward pass with the retrace appended on top. Building it this way means a
  // plain single pass (one-way; either loop direction) and a there-and-back walk
  // (out-and-back) are one construction with an optional extra leg, not two branches that
  // could drift apart on the seam handling or the timing pass below.
  const forwardIdx = reversed
    ? Array.from({ length: profLen }, (_, k) => profLen - 1 - k)
    : Array.from({ length: profLen }, (_, k) => k);
  /** Index into the profile, and whether we are on the outbound pass (the only pass, for
   *  everything but out-and-back's retrace). */
  const walk: { i: number; outbound: boolean }[] = forwardIdx.map((i) => ({ i, outbound: true }));
  if (outAndBack) for (let k = forwardIdx.length - 2; k >= 0; k--) walk.push({ i: forwardIdx[k], outbound: false });

  // ---- timing pass: no weather yet, because hours needed depends on duration
  const timed: {
    i: number;
    outbound: boolean;
    travelM: number;
    elevM: number;
    gradePct: number;
    kph: number;
    hour: number;
    reached: boolean;
  }[] = [];
  let travelM = 0;
  let hour = opts.departHour;
  let seamCount = 0;

  for (let k = 0; k < walk.length; k++) {
    const step = walk[k];
    const elevM = trail.profile?.[step.i] ?? profileElevAt(trail, step.i / (profLen - 1));

    let gradePct = 0;
    let kph = 0;
    let reached = true;
    if (k > 0) {
      const prev = walk[k - 1];
      const prevElev = trail.profile?.[prev.i] ?? profileElevAt(trail, prev.i / (profLen - 1));
      // A seam index i means outPart[i] !== outPart[i-1] (derive.mjs's downsampleProfile:
      // `for (i=1..points) if (outPart[i] !== outPart[i-1]) seamIndices.push(i)`), so the
      // gap sits between i-1 and i and the index recorded is the HIGHER of the two, the
      // one that BEGINS the new part. Walking crosses that gap whenever the two profile
      // indices on this leg are adjacent and their higher one is a recorded seam, in
      // either walk direction (the return leg walks indices downward, so `step` can be
      // the lower one). Getting this backwards (checking the lower index) still compiles
      // and still looks plausible, which is exactly how it shipped wrong: Flattop, this
      // page's hero trail, has no seams (`seamIndices: []`), so the page's own render
      // never exercises this branch. East Longs Peak Trail (`parts: 2, seamIndices: [47]`)
      // does, and only running trail/journey-check.mjs against it catches the bug.
      const hi = Math.max(prev.i, step.i);
      const crossesSeam = Math.abs(step.i - prev.i) === 1 && seams.has(hi);
      if (crossesSeam) {
        seamCount++;
        // The walker never crosses the gap, so this step's position is real geometry on
        // the far, unwalked side of it: frozen at the last walked travelM/hour, and
        // carrying whatever elevation that far side happens to have (East Longs Peak
        // Trail's is 648 m LOWER, not higher, than the point actually reached). `reached`
        // records that this entry is not a place the walker was, so marker search can
        // honour the header comment's "no marker" clause rather than picking it as a
        // high point, a turnaround, or a treeline crossing that never happened.
        reached = false;
      } else {
        const slope = (elevM - prevElev) / legM;
        kph = paceKph(slope, factor);
        gradePct = slope * 100;
        travelM += legM;
        hour += legM / 1000 / kph;
      }
    }
    timed.push({ i: step.i, outbound: step.outbound, travelM, elevM, gradePct, kph, hour, reached });
  }

  const endHour = timed[timed.length - 1].hour;

  // ---- weather, once, for the whole journey --------------------------------
  const points = routeSamplePoints(trail, JOURNEY_SAMPLE_POINTS);
  const hours = Math.max(25, Math.ceil(endHour) + 2);
  const weather = await provider.fetch({ points, hours });

  /** Nearest forecast-point index for a position along the route, shared by the weather
   *  sample lookup and the ground-wetness lookup below so the two cannot disagree about
   *  which point a waypoint is closest to. */
  const pointIndexAt = (frac: number): number =>
    Math.min(weather.series.length - 1, Math.max(0, Math.round(frac * (weather.series.length - 1))));

  const sampleAt = (pi: number, atHour: number): WeatherSample => {
    const series = weather.series[pi];
    // Hourly data, so an arrival at 11:40 is answered by the 12:00 sample. Rounding
    // rather than interpolating keeps the number a forecast value and not our average of
    // two of them.
    const want = Math.round(atHour);
    return (
      series.find((s) => s.hour === want) ??
      series[Math.min(series.length - 1, Math.max(0, want))] ??
      series[series.length - 1]
    );
  };

  // ---- ground wetness, per point and per hour ------------------------------
  //
  // Reuses grade.ts's own decay law (`gradeTrail`'s wetness block) rather than inventing a
  // second one: `carried = antecedent * 0.5^(elapsed/halfLife)` plus rain that has actually
  // fallen. grade.ts evaluates that once, for the single window a route occupies; here it
  // is evaluated once per waypoint, at that waypoint's own arrival hour, which is what
  // turns a route-level penalty into a point-on-a-map figure.
  //
  // `holdsWater` (surface tag, steepness, profile shape via `terrainFacts`, already
  // exported) is ROUTE-LEVEL: open data carries one `surface` value for a whole trail, so
  // it cannot vary along it. That is a real, stated limitation (see route.ts's Limits
  // section and SCOPE_PLAN), not something to fake around here: computed once, applied to
  // every point unchanged. What DOES vary point to point is antecedent rain (drier and
  // wetter cells exist in the simulated field) and the hour of arrival (the decay term).
  const holdsWater = terrainFacts(trail, region).holdsWater;
  const halfLife = DRY_HALFLIFE_BASE_H + DRY_HALFLIFE_GAIN_H * holdsWater;

  /** Water on the ground at one point, at the hour you reach it. Same three terms as
   *  grade.ts's `wetMm`, collapsed from a multi-hour window to a single arrival hour: rain
   *  from before today's antecedent total, decayed; rain that has already fallen since
   *  hour 0 at full weight; and rain falling in the very hour of arrival at 0.6, the same
   *  discount grade.ts applies to precipitation still arriving as you're in it. */
  const groundWetMmAt = (pi: number, atHour: number): number => {
    const antecedent = weather.antecedentPrecipMm[pi] ?? 0;
    const elapsed = Math.max(0, atHour);
    const carried = antecedent * Math.pow(0.5, elapsed / halfLife);
    const arrival = Math.round(atHour);
    let fellBefore = 0;
    let atArrivalMm = 0;
    for (const s of weather.series[pi] ?? []) {
      if (s.hour < arrival) fellBefore += s.precipMm;
      else if (s.hour === arrival) atArrivalMm = s.precipMm;
    }
    return carried + fellBefore + atArrivalMm * 0.6;
  };

  const waypoints: Waypoint[] = timed.map((t) => {
    const frac = t.i / (profLen - 1);
    const pi = pointIndexAt(frac);
    const sample = sampleAt(pi, t.hour);
    return {
      travelM: t.travelM,
      frac,
      elevM: t.elevM,
      gradePct: t.gradePct,
      kph: t.kph,
      hour: t.hour,
      sample,
      level: levelForThunder(sample.thunderProb),
      outbound: t.outbound,
      exposed: hasTreeline && t.elevM >= treeline,
      reached: t.reached,
      groundWetMm: groundWetMmAt(pi, t.hour),
    };
  });

  // ---- aggregates ---------------------------------------------------------
  let exposedMinutes = 0;
  for (let k = 1; k < waypoints.length; k++) {
    const a = waypoints[k - 1];
    const b = waypoints[k];
    if (a.exposed || b.exposed) exposedMinutes += (b.hour - a.hour) * 60;
  }

  let tMin = Infinity;
  let tMax = -Infinity;
  let peakGustKph = 0;
  let peakThunder = 0;
  const levelCounts: [number, number, number, number] = [0, 0, 0, 0];
  for (const w of waypoints) {
    tMin = Math.min(tMin, w.sample.tempC);
    tMax = Math.max(tMax, w.sample.tempC);
    peakGustKph = Math.max(peakGustKph, w.sample.gustKph);
    peakThunder = Math.max(peakThunder, w.sample.thunderProb);
    levelCounts[w.level]++;
  }

  const elevs = waypoints.map((w) => w.elevM);
  const daylight = weather.daylight[0] ?? { sunriseHour: 6, sunsetHour: 20 };

  const journey: Journey = {
    trail,
    region,
    pace: opts.pace,
    departHour: opts.departHour,
    endHour,
    totalMinutes: (endHour - opts.departHour) * 60,
    totalM: travelM,
    traversal,
    outAndBack,
    waypoints,
    markers: [],
    exposedMinutes,
    minElevM: Math.min(...elevs),
    maxElevM: Math.max(...elevs),
    tempRangeC: [tMin, tMax],
    peakGustKph,
    peakThunder,
    levelCounts,
    antecedentMm: Math.max(0, ...weather.antecedentPrecipMm),
    sunriseHour: daylight.sunriseHour,
    sunsetHour: daylight.sunsetHour,
    withinHorizon: endHour <= provider.horizonHours,
    horizonHours: provider.horizonHours,
    seamCount,
    holdsWater,
  };
  journey.markers = buildMarkers(journey, provider, hasTreeline ? treeline : null);
  return journey;
}

/**
 * The flags on the chart, and the banded rows in the table.
 *
 * Every marker is a fact with a time attached and nothing else: a crossing, a high
 * point, a turnaround, last light. No marker interprets, recommends, or warns, which was
 * the explicit design constraint. "Above treeline 11:12" is a statement about geometry
 * and a clock; "leave by 09:00" would be a judgement, and the judgement is the reader's.
 */
function buildMarkers(j: Journey, provider: WeatherProvider, treeline: number | null): Marker[] {
  const out: Marker[] = [];
  const wps = j.waypoints;
  const add = (kind: MarkerKind, label: string, sub: string, w: Waypoint): void => {
    out.push({ kind, label, sub, travelM: w.travelM, hour: w.hour, level: w.level });
  };

  add('depart', 'Depart', journeyClock(provider, wps[0].hour), wps[0]);

  // Every search below skips waypoints with `reached: false`: the header comment's "no
  // marker" clause for a seam. Without this, the point on the FAR side of a gap (real
  // geometry the walker never crossed to, frozen at the last walked travelM/hour) can win
  // "high point" or "turn around" on frac or elevation alone, and East Longs Peak Trail's
  // does: its post-seam point is 648 m LOWER, so it never wins on elevation, but it always
  // wins on frac (it IS the geometric end of the trail), which used to print a "Turn
  // around" and a "Below treeline" at the same instant as the real high point, for a
  // place the walker never stood.
  if (treeline != null) {
    for (let k = 1; k < wps.length; k++) {
      if (wps[k].reached && wps[k].outbound && !wps[k - 1].exposed && wps[k].exposed) {
        add('treeline-up', 'Above treeline', `${Math.round(treeline)} m`, wps[k]);
        break;
      }
    }
  }

  let hi = 0;
  for (let k = 1; k < wps.length; k++) if (wps[k].reached && wps[k].elevM > wps[hi].elevM) hi = k;
  add('high', 'High point', `${Math.round(wps[hi].elevM)} m`, wps[hi]);

  if (j.outAndBack) {
    // The far end of the trail, which is the far end of the walk. Not always the high
    // point: Ute Trail tops out before it ends.
    let turn = 0;
    for (let k = 1; k < wps.length; k++) if (wps[k].reached && wps[k].frac > wps[turn].frac) turn = k;
    if (turn !== hi) add('turn', 'Turn around', `${(wps[turn].travelM / 1000).toFixed(1)} km`, wps[turn]);
  }

  if (treeline != null) {
    for (let k = hi + 1; k < wps.length; k++) {
      if (wps[k].reached && wps[k - 1].exposed && !wps[k].exposed) {
        add('treeline-down', 'Below treeline', `${Math.round(treeline)} m`, wps[k]);
        break;
      }
    }
  }

  // One-way finishes at the far end of the trail, not back where it started, so the
  // label names the arrival rather than a return that never happened. Out-and-back and
  // both loop directions genuinely do end where they began, so they keep the return word.
  const last = wps[wps.length - 1];
  const finishLabel = j.traversal === 'one-way' ? 'Finish' : 'Back at trailhead';
  add('finish', finishLabel, journeyClock(provider, last.hour), last);

  // Last light, only when it actually falls inside the walk. A sunset marker on a
  // journey that ends at 14:00 would be chart furniture.
  if (j.sunsetHour > j.departHour && j.sunsetHour < last.hour) {
    let near = 0;
    for (let k = 1; k < wps.length; k++) {
      if (Math.abs(wps[k].hour - j.sunsetHour) < Math.abs(wps[near].hour - j.sunsetHour)) near = k;
    }
    out.push({
      kind: 'sunset',
      label: 'Last light',
      sub: journeyClock(provider, j.sunsetHour),
      travelM: wps[near].travelM,
      hour: j.sunsetHour,
      level: wps[near].level,
    });
  }

  return out.sort((a, b) => a.travelM - b.travelM);
}

/**
 * Waypoints thinned to `count` rows for the tabular concept, markers always kept.
 *
 * A table of all 95 waypoints is a data dump, not a design. Thinning by even travel
 * distance keeps the rows readable as a rhythm ("every 700 m") while the marker rows
 * carry the events, so the table's row set is defensible rather than arbitrary.
 */
export function tableRows(j: Journey, count: number): Waypoint[] {
  const wps = j.waypoints;
  const picked = new Set<number>([0, wps.length - 1]);
  for (let k = 0; k < count; k++) {
    const target = (j.totalM * k) / (count - 1);
    let best = 0;
    for (let idx = 1; idx < wps.length; idx++) {
      if (Math.abs(wps[idx].travelM - target) < Math.abs(wps[best].travelM - target)) best = idx;
    }
    picked.add(best);
  }
  for (const m of j.markers) {
    let best = 0;
    for (let idx = 1; idx < wps.length; idx++) {
      if (Math.abs(wps[idx].travelM - m.travelM) < Math.abs(wps[best].travelM - m.travelM)) best = idx;
    }
    picked.add(best);
  }
  return [...picked].sort((a, b) => a - b).map((idx) => wps[idx]);
}
