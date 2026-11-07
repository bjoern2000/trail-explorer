// Trail Scope — the conditions grade.
//
// This is the file the page is about. It takes simulated weather and REAL terrain and
// produces three levels plus a reason. No 0-to-100 score is ever shown: `score` exists
// only as a ranking key for the Best-today sort and must never be rendered.
//
// The split is the whole argument. The weather side arrives through a `WeatherProvider`
// and is fake today. The terrain side is computed here, from our own derived data, and is
// real: max elevation against the region's treeline, profile shape, steepest sustained
// grade, OSM surface tag, length and estimated time. Replace the provider with Super
// Resolution and every terrain judgement below is unchanged.
//
// Six factors, each contributing a penalty and one lower-case clause:
//
//   storm     convective load over the window the route actually occupies
//   exposure  the terrain amplifier: how much of the route has no shelter, times the
//             hazard there is to be unsheltered in. This is where above-treeline-during-
//             convection becomes the dangerous case rather than a scenic one.
//   wetness   antecedent water, dried down over elapsed hours, times how badly this
//             particular route holds it: surface tag as drainage proxy, steepness and
//             flat share as the shape term.
//   heat      temperature AT ROUTE ELEVATION over threshold, times sun load (shade share
//             and cloud), times effort (gain and duration). Under a normal lapse rate this
//             makes a long low unshaded route worse than a short high one, which is the
//             inverse of what storm and exposure do, and is why the list reranks between
//             the two scenarios instead of just recolouring.
//   wind      gusts, amplified on the exposed share.
//   daylight  route duration against the daylight actually left.
//
// Weighting is in `W` below, with the reasoning next to it.
//
// TWO DELIBERATE CONSTRAINTS ON COPY.
//   1. Factor text carries no units. `gradeTrail` has no access to the unit toggle and
//      should not: distances and temperatures are stated qualitatively, so the metric and
//      imperial readers see the same sentence. Percentages (no decimals, house rule) and
//      clock times are the only numbers allowed out.
//   2. Reassuring clauses carry a small non-zero penalty (0.3 to 1.5) rather than zero.
//      A storm that arrives after you finish is a mild negative, not a neutral fact, and
//      giving it a floor is what lets "clear until 15:00" reach the headline of
//      a prime card while never changing the level.
//
// Past the provider's horizon the grade degrades on purpose: `confidence: 'outlook'`, no
// hourly claim, no terrain factor, no best window, a visibly vaguer headline. The horizon
// is read off the provider; 36 is never hard-coded here.
//
// DEGRADING IS NOT DISAPPEARING. The outlook still returns a real level, because a grade
// nothing can satisfy is indistinguishable from no grade at all: the condition filters
// silently emptied the list, which reads as a broken app rather than as an honest limit.
// The honest framing, and the one the copy has to carry, is two sentences that are both
// useful and only one of which is route-specific:
//     inside the horizon  we can tell you about THIS ROUTE at THIS HOUR
//     past it             we can only tell you about THIS AREA on THIS DAY
// So past the horizon the grade is a coarse regional call, levels and all, with no terrain
// term, no hour, no window, and a score quantised per level so it cannot masquerade as a
// ranking. See `outlookGrade`.

import { clockLabel, routeSamplePoints, weekdayLabel } from './provider';
// DELIBERATE CROSS-LAYER IMPORT. `src/scope` reaching into `src/trail` is the wrong
// direction for this codebase's layering (trail/ is downstream of scope/'s derived data
// and its own journey.ts already imports scope/weather/provider.ts, never the reverse
// until now). `pace.ts` is the exception that makes it safe: it imports nothing from
// `scope/` (or anywhere else), so this stays acyclic. The alternative, a second copy of
// Tobler's function here, is exactly the kind of duplicated constant MERGE_PLAN and
// SCOPE_PLAN §13 already flag as a drift risk, so the import is taken and the layering
// debt is tracked in SCOPE_PLAN rather than fixed by copying. Read-only: nothing here
// changes pace.ts's behaviour or its exports.
import { DEFAULT_PACE, paceDef, paceKph } from '../../trail/pace';
import type {
  ConditionFactor,
  ConditionFilterId,
  ConditionGrade,
  FactorKind,
  GradeConfidence,
  GradeLevel,
  RegionDef,
  RouteType,
  ScopeTrail,
  WeatherProvider,
  WeatherResult,
} from '../types';

// ============================================================================
// TRAVERSAL — how the walk is done, and the one thing it changes here
// ============================================================================
//
// `durationH` below is the only terrain fact that depends on how the trail is walked, so
// traversal is the one new input this file takes. Everything else about the route (its
// exposure, its drainage, its steepness) is the same walk either way.

/**
 * A SEPARATE TYPE from `src/trail/journey.ts`'s `Traversal`, deliberately: that module's
 * copy is trail mode's and uses trail mode's words ("Out and back", "Anticlockwise");
 * this one is the discovery page's and uses the discovery page's control's words ("One
 * way", "Incl. return", "Counterclockwise" — `phone/peek.ts`). Reconciling the two is
 * tracked as debt, not fixed here.
 *
 * `'one-way'` and `'incl-return'` are the two a point-to-point trail supports; `'cw'` and
 * `'ccw'` are the two a loop supports. A loop's `durationH` never differs between them (a
 * loop's own circuit is the whole walk either direction; SCOPE_PLAN §8 notes no loop in
 * the seeded data is large enough for the direction to move a real number), so `cw`/`ccw`
 * exist here only so the peek's map and profile have something to key their mirroring on.
 */
export type GradeTraversal = 'one-way' | 'incl-return' | 'cw' | 'ccw';

/**
 * The basis every caller that does not ask for something else grades at — and the basis
 * the RESULTS LIST always grades at. This is load-bearing: a per-trail choice lives in one
 * peek (`phone/peek.ts`'s own state) and must never reach here as a default, or a reader's
 * choice on one trail would silently re-rank every other trail behind it.
 */
export function defaultGradeTraversal(routeType: RouteType): GradeTraversal {
  return routeType === 'loop' ? 'cw' : 'incl-return';
}

/**
 * Whole-outing duration, hours, out AND back, using Tobler's per-segment model
 * (`src/trail/pace.ts`) at its steady pace rather than doubling the one-way Naismith
 * figure the card shows (`trail.estMinutes`). Doubling overstates the outing: Naismith
 * charges 10 minutes per 100 m of ASCENT and the return leg has none (it retraces the
 * descent), so Flattop Mountain Trail's one-way 2h37m would double to 5h14m against a
 * properly modelled figure well under that. Tobler is asymmetric about zero (walking
 * speed peaks on a slight downgrade, not on the flat — see pace.ts's own header), so the
 * outbound and return legs are genuinely different sums, not one leg's time counted twice.
 */
export function roundTripHours(trail: ScopeTrail): number {
  const prof = trail.profile;
  const n = prof && prof.length > 1 ? prof.length : 0;
  // No profile to walk segment by segment (should not happen on real derived data, but a
  // synthetic or malformed trail must not throw): fall back to the old doubling rather
  // than divide by zero.
  if (n < 2) return (trail.estMinutes * 2) / 60;
  const legM = trail.lengthM / (n - 1);
  const factor = paceDef(DEFAULT_PACE).factor;
  let hours = 0;
  for (let i = 1; i < n; i++) {
    hours += legM / 1000 / paceKph((prof[i] - prof[i - 1]) / legM, factor);
    // The return leg walks the same profile backwards: same leg length, opposite sign of
    // slope, and Tobler's asymmetry means this is not just the outbound sum repeated.
    hours += legM / 1000 / paceKph((prof[i - 1] - prof[i]) / legM, factor);
  }
  return hours;
}

// ============================================================================
// TUNING
// ============================================================================

/**
 * Factor weights, as maximum penalty points each can contribute at full strength.
 *
 *   daylight (40) is the highest because finishing a route in the dark is the one failure
 *     mode that is certain rather than probabilistic.
 *   wetness (32) and storm/exposure (30 each) are next. Storm and exposure are split
 *     rather than merged so the copy can name the hazard and the terrain separately, and
 *     so a below-treeline route in the same cell as a ridge route genuinely grades better.
 *     Together they can reach 60, which is what makes an above-treeline afternoon poor.
 *   heat (30) matches them: a heat event is a real failure mode, not a comfort note.
 *   wind (18) is lowest of the weather terms because it rarely stops a summer walk on its
 *     own, and it is amplified through exposure where it does.
 */
const W = {
  storm: 30,
  exposure: 30,
  wetness: 32,
  heat: 30,
  wind: 18,
  daylight: 40,
} as const;

/** Level thresholds on total penalty. Tuned against scope/grade-check.mjs. */
const PRIME_MAX = 16;
const MIXED_MAX = 42;

/**
 * Temperature at which the heat term starts to bite, °C. 23 rather than something lower
 * because the median derived trail is a sub-kilometre fragment, and a twenty minute walk
 * at 25 °C is genuinely fine. Setting this where discomfort actually starts keeps the heat
 * scenario from painting a whole region amber on a warm afternoon.
 */
const HEAT_ONSET_C = 23;
/** Gust speed at which the wind term starts to bite, km/h. */
const GUST_ONSET_KPH = 35;
/** Thunder probability that counts as "storms are a thing now". */
const STORM_ONSET_PROB = 0.3;
/**
 * Usability a window must average to be offered as a best window. Deliberately not high:
 * "no usable window at all today" is a strong claim and should stay rare, so it is reserved
 * for routes the day genuinely does not fit.
 */
const WINDOW_USABLE = 0.52;
/**
 * Hour of day the grade assumes someone actually sets off, when the day is not today.
 * The grade describes going out on that day; `bestWindow` is the separate advice about
 * when. Grading the plan window at the optimum instead would flatter every route (there
 * is always a cool, calm hour at dawn) and flatten the list, which is the one thing the
 * page cannot afford.
 */
const TYPICAL_START_HOUR = 9;

/**
 * How much a hazard that sits OUTSIDE the plan window still counts.
 *
 * The pill answers "how is this trail today", not "how is it in the next two hours". Most
 * merged OSM name-clusters are short (the median derived trail is under a kilometre), so a
 * window-only grade would let almost every route dodge the afternoon and the list would
 * barely move between scenarios. A route that is unusable for the second half of the day
 * is not the same as one that is fine all day, even when leaving early avoids it, and
 * `bestWindow` is what carries the leave-early advice. So the day's own peak counts, at
 * this fraction of the weight the same hazard would carry inside the window.
 */
const DAY_WIDE_WEIGHT = 0.5;
/**
 * Half life of surface water on a route that drains freely, hours. Exported (additively;
 * nothing else in this file changes) so trail/journey.ts can evaluate the SAME decay law
 * per waypoint and per hour instead of once per route and window: see that file's ground-
 * wetness comment for why re-deriving a second constant here would be exactly the kind of
 * threshold drift this codebase's other duplicated constants (LEVEL, in journey.ts's own
 * header) are already flagged as a risk for.
 */
export const DRY_HALFLIFE_BASE_H = 18;
/**
 * How much longer a route that holds water takes to dry, hours per unit of `holdsWater`.
 * Half life is `DRY_HALFLIFE_BASE_H + DRY_HALFLIFE_GAIN_H * holdsWater`.
 */
export const DRY_HALFLIFE_GAIN_H = 26;
/**
 * Carried water, in mm, at which the wetness term saturates: the penalty is
 * `W.wetness * clamp(wetMm * holdsWater / WET_SATURATION_MM, 0, WET_CEILING)`.
 *
 * These two were inline literals in `gradeTrail` and were being transcribed by hand in two
 * other places (the parameter export this file now carries, and trail/journey.ts's ground
 * word). Three copies of one number is how a documented model starts disagreeing with the
 * model, which is the exact failure the parameter export exists to prevent, so they are
 * named here and read everywhere instead.
 */
export const WET_SATURATION_MM = 38;
/** Ceiling on the normalised wetness term, so a soaked route cannot outweigh everything. */
export const WET_CEILING = 1.15;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const pct = (v: number) => `${Math.round(v * 100)}%`;

// ============================================================================
// TERRAIN — real, computed from the derived trail
// ============================================================================

export interface TerrainFacts {
  /** Share of the profile above the region's treeline, 0..1. */
  exposedShare: number;
  /**
   * Share below it. The shade proxy: below treeline means trees.
   *
   * STILL THE PROXY, ON PURPOSE, even though `canopyShare` below is now real. Nothing in
   * this file reads canopy. Swapping the two would move the heat term, which reranks the
   * list, which changes the argument the page makes to an exec, and SCOPE_PLAN §14 records
   * what it costs to do that by accident. The measured consequence of the swap is in
   * `node scope/canopy-check.mjs`; the decision is not this file's to take.
   */
  shadedShare: number;
  /**
   * REAL canopy from OSM wooded polygons, 0..1, or NaN on a snapshot derived before
   * scope/canopy.mjs. Exposed here so a caller can compare it with `shadedShare`; read by
   * nothing in this file.
   *
   * It is not a drop-in replacement, and the reason is a finding rather than a caveat: it
   * measures OSM's mapping effort as much as vegetation. In Lake of the Ozarks it reads 2
   * percent on demonstrably wooded ground, because only 9 percent of that bbox has a forest
   * polygon drawn over it. `RegionData.canopy.mappedShare` is the number that says which
   * you are looking at, and any use of this field has to carry it.
   */
  canopyShare: number;
  /**
   * Mean slope of the GROUND the trail crosses, degrees, from the DEM — not the trail's own
   * gradient, which is `maxGradePct`. Half of the terrain-shading input; the other half is
   * `ScopeTrail.aspectDeg`, and both are consumed only by
   * src/scope/weather/shading.ts, which is not wired in. NaN on an old snapshot.
   */
  meanSlopeDeg: number;
  aboveTreeline: boolean;
  /** Share of profile steps flatter than 3 percent. Flat ground holds water. */
  flatShare: number;
  /** How badly this route holds surface water, roughly 0.15 (paved, steep) to 1.3. */
  holdsWater: number;
  durationH: number;
  lengthKm: number;
}

/**
 * OSM `surface` as a drainage proxy. Untagged is the majority of the network, so it gets
 * a hedged 0.8 rather than either extreme, and the page says so.
 */
function surfaceHold(surface: string | null): number {
  if (!surface) return 0.8;
  const s = surface.toLowerCase();
  if (/asphalt|concrete|paved|paving|metal/.test(s)) return 0.2;
  if (/rock|stone|bare_rock|scree|pebble/.test(s)) return 0.4;
  if (/gravel|compacted|fine_gravel|woodchips/.test(s)) return 0.5;
  if (/sand/.test(s)) return 0.55;
  if (/wood|boardwalk/.test(s)) return 0.7;
  if (/grass|dirt|earth|soil|unpaved|ground|natural/.test(s)) return 1.0;
  if (/mud|clay|bog/.test(s)) return 1.3;
  return 0.85;
}

export function terrainFacts(
  trail: ScopeTrail,
  region: RegionDef,
  /**
   * Defaults to this trail's own default basis, never a fixed constant: a caller that
   * does not care about traversal (grade-check.mjs's terrain table, journey.ts's
   * `holdsWater` read, the list's own grading) gets the same number it always got, because
   * `defaultGradeTraversal('point-to-point')` is `'incl-return'`, the new list basis.
   */
  traversal: GradeTraversal = defaultGradeTraversal(trail.routeType),
): TerrainFacts {
  const profile = trail.profile && trail.profile.length > 1 ? trail.profile : [trail.minElevM, trail.maxElevM];

  let above = 0;
  for (const e of profile) if (e > region.treelineM) above++;
  const exposedShare = above / profile.length;

  // Flat share from the profile's own steps. The step length is the route length over the
  // number of steps, so this is a real gradient, not a shape guess.
  const stepM = Math.max(1, trail.lengthM / (profile.length - 1));
  let flat = 0;
  for (let i = 1; i < profile.length; i++) {
    if (Math.abs((profile[i] - profile[i - 1]) / stepM) * 100 < 3) flat++;
  }
  const flatShare = flat / (profile.length - 1);

  // Steep drains, flat ponds. maxGradePct is the steepest sustained grade, so it caps how
  // much of the route can be holding water at all.
  const steepRelief = clamp(1.2 - trail.maxGradePct / 40, 0.45, 1.2);
  const shapeHold = 0.55 + 0.55 * flatShare;
  const holdsWater = clamp(surfaceHold(trail.surface) * steepRelief * shapeHold, 0.08, 1.4);

  // A loop's stored figure already IS the whole circuit either direction (SCOPE_PLAN §8),
  // so only a point-to-point trail's `incl-return` selection changes anything here.
  const durationH =
    trail.routeType !== 'loop' && traversal === 'incl-return'
      ? Math.max(0.4, roundTripHours(trail))
      : Math.max(0.4, trail.estMinutes / 60);

  return {
    exposedShare,
    shadedShare: 1 - exposedShare,
    // Carried through, never combined. A synthetic trail (scope/grade-check.mjs builds
    // eight) has neither field at all, so both are guarded rather than read: an absent
    // measurement is NaN here, never a plausible-looking zero.
    canopyShare: Number.isFinite(trail.canopyShare) ? trail.canopyShare : Number.NaN,
    meanSlopeDeg: Number.isFinite(trail.meanSlopeDeg) ? trail.meanSlopeDeg : Number.NaN,
    aboveTreeline: trail.maxElevM > region.treelineM,
    flatShare,
    holdsWater,
    durationH,
    lengthKm: trail.lengthM / 1000,
  };
}

// ============================================================================
// HOURLY ROUTE AGGREGATE
// ============================================================================

interface RouteHour {
  hour: number;
  /** Worst thunder probability anywhere on the route this hour. */
  thunderMax: number;
  /** Thunder weighted by whether the point holding it has shelter. */
  hazard: number;
  precipMm: number;
  tempMaxC: number;
  gustMaxKph: number;
  cloudMean: number;
  usability: number;
}

/**
 * Per-point exposure from the sampled elevations, recomputed here. grade.ts and
 * `fetchRouteWeather` both sample through `routeSamplePoints`, so the orders agree; if a
 * caller supplied a different point set the lengths will not match and we fall back to
 * the profile-wide exposed share.
 */
function pointExposure(trail: ScopeTrail, region: RegionDef, seriesCount: number, fallback: number): number[] {
  const pts = routeSamplePoints(trail);
  if (pts.length !== seriesCount) return new Array<number>(seriesCount).fill(fallback);
  return pts.map((p) => (p.elevM > region.treelineM ? 1 : 0));
}

function routeHours(
  weather: WeatherResult,
  exposure: number[],
  fromHour: number,
  toHour: number,
): RouteHour[] {
  const out: RouteHour[] = [];
  const first = weather.series[0] ?? [];
  for (const probe of first) {
    if (probe.hour < fromHour - 0.5 || probe.hour > toHour + 0.5) continue;
    let thunderMax = 0;
    let hazard = 0;
    let precipMm = 0;
    let tempMaxC = -100;
    let gustMaxKph = 0;
    let cloudSum = 0;
    let n = 0;
    for (let p = 0; p < weather.series.length; p++) {
      const s = weather.series[p].find((x) => x.hour === probe.hour);
      if (!s) continue;
      thunderMax = Math.max(thunderMax, s.thunderProb);
      // No shelter above treeline; below it you can drop into trees. 0.35 is the residual
      // risk of being caught in the open on a below-treeline route.
      hazard = Math.max(hazard, s.thunderProb * (0.35 + 0.65 * (exposure[p] ?? 0)));
      precipMm = Math.max(precipMm, s.precipMm);
      tempMaxC = Math.max(tempMaxC, s.tempC);
      gustMaxKph = Math.max(gustMaxKph, s.gustKph);
      cloudSum += s.cloudPct;
      n++;
    }
    if (n === 0) continue;
    const cloudMean = cloudSum / n;
    const heatFrac = clamp((tempMaxC - HEAT_ONSET_C) / 12, 0, 1);
    const windFrac = clamp((gustMaxKph - GUST_ONSET_KPH) / 45, 0, 1);
    const precipFrac = clamp(precipMm / 3, 0, 1);
    out.push({
      hour: probe.hour,
      thunderMax,
      hazard,
      precipMm,
      tempMaxC,
      gustMaxKph,
      cloudMean,
      usability: clamp(1 - (hazard * 0.95 + windFrac * 0.4 + heatFrac * 0.4 + precipFrac * 0.5), 0, 1),
    });
  }
  return out;
}

// ============================================================================
// THE GRADE
// ============================================================================

export function gradeTrail(
  trail: ScopeTrail,
  region: RegionDef,
  weather: WeatherResult,
  dayOffset: number,
  provider: WeatherProvider,
  /** See `terrainFacts`: same default, so an existing caller that never asks about
   *  traversal (grade-check.mjs among them) keeps grading at the list's own basis. */
  traversal: GradeTraversal = defaultGradeTraversal(trail.routeType),
): ConditionGrade {
  const clock = provider.now();
  const terrain = terrainFacts(trail, region, traversal);

  // Daylight for the requested day. The contract is day 0's sunrise/sunset in
  // hours-from-now, so a whole day is one 24 h shift.
  const sun = weather.daylight.length
    ? {
        sunrise: mean(weather.daylight.map((d) => d.sunriseHour)),
        sunset: mean(weather.daylight.map((d) => d.sunsetHour)),
      }
    : { sunrise: 6 - clock.hourOfDay, sunset: 20 - clock.hourOfDay };
  const dayStart = sun.sunrise + 24 * dayOffset;
  const dayEnd = sun.sunset + 24 * dayOffset;

  // Confidence: is the start of that day's hiking window inside the provider's horizon?
  // Read from the provider, never hard-coded.
  const inHorizon = Math.max(0, dayStart) <= provider.horizonHours;
  if (!inHorizon) return outlookGrade(weather, dayStart, dayEnd, provider);

  // A route-specific grade needs hourly data covering the day. A provider is allowed to
  // return a short series; if it does not reach this day, say so instead of guessing.
  const exposure = pointExposure(trail, region, weather.series.length, terrain.exposedShare > 0.5 ? 1 : 0);
  // Today you cannot start in the past, so the window opens now. Any other day it opens at
  // a plausible setting-off time, never before first light and never inside the last hour.
  const earliest = dayStart + 0.5;
  const typical = dayOffset * 24 + TYPICAL_START_HOUR - clock.hourOfDay;
  const windowStart =
    dayOffset === 0 ? Math.max(0, earliest) : Math.max(earliest, Math.min(typical, dayEnd - 1));
  // Never claim hourly detail past the horizon, even for a day that starts inside it.
  const windowEnd = Math.min(dayEnd, provider.horizonHours);
  const hours = routeHours(weather, exposure, windowStart - 1, windowEnd + 1);
  if (hours.length === 0) return noDataGrade(provider);

  const availableH = Math.max(0, windowEnd - windowStart);
  const needed = Math.min(terrain.durationH, Math.max(1, availableH));

  // ---- best window ---------------------------------------------------------
  let best: { startHour: number; endHour: number; mean: number } | null = null;
  for (const h of hours) {
    const s = Math.max(windowStart, h.hour);
    if (s + needed > windowEnd + 0.01) continue;
    const span = hours.filter((x) => x.hour >= s - 0.01 && x.hour < s + needed + 0.01);
    if (span.length === 0) continue;
    const m = mean(span.map((x) => x.usability));
    if (!best || m > best.mean + 0.001) {
      best = { startHour: Math.round(s), endHour: Math.round(s + needed), mean: m };
    }
  }
  const bestWindow = best && best.mean >= WINDOW_USABLE ? { startHour: best.startHour, endHour: best.endHour } : null;

  // ---- the window the route actually occupies ------------------------------
  // Anchored at the plausible start, not at `bestWindow`. See TYPICAL_START_HOUR.
  const planStart = windowStart;
  const planEnd = planStart + needed;
  const inWindow = hours.filter((x) => x.hour >= planStart - 0.51 && x.hour <= planEnd + 0.51);
  const win = inWindow.length ? inWindow : hours;

  // The whole of that day's daylight, for the day-wide floor. See DAY_WIDE_WEIGHT.
  const dayHours = hours.filter((x) => x.hour >= dayStart - 0.51 && x.hour <= windowEnd + 0.51);
  const dayLit = dayHours.length ? dayHours : hours;

  const stormPeak = Math.max(...win.map((x) => x.thunderMax));
  const stormMean = mean(win.map((x) => x.thunderMax));
  const hazardPeak = Math.max(...win.map((x) => x.hazard));
  const hazardMean = mean(win.map((x) => x.hazard));
  const gustPeak = Math.max(...win.map((x) => x.gustMaxKph));
  const cloudMean = mean(win.map((x) => x.cloudMean));
  const precipInWindow = win.reduce((s, x) => s + x.precipMm, 0);

  // Storm load leans on the peak but is dragged down by a window that mostly misses the
  // convection: a short morning route on a stormy day is genuinely better than a long one.
  // The day's own peak then floors it, so an afternoon nobody can use still shows up.
  const stormWindow = clamp(0.4 * stormMean + 0.6 * stormPeak, 0, 1);
  const hazardWindow = clamp(0.4 * hazardMean + 0.6 * hazardPeak, 0, 1);
  const stormLoad = Math.max(stormWindow, DAY_WIDE_WEIGHT * Math.max(...dayLit.map((x) => x.thunderMax)));
  const hazardLoad = Math.max(hazardWindow, DAY_WIDE_WEIGHT * Math.max(...dayLit.map((x) => x.hazard)));

  // Heat and wind get the same treatment, on their already-normalised 0..1 fractions.
  const tempPeak = Math.max(...win.map((x) => x.tempMaxC));
  const dayTempPeak = Math.max(...dayLit.map((x) => x.tempMaxC));
  const heatFrac = Math.max(
    clamp((tempPeak - HEAT_ONSET_C) / 12, 0, 1.3),
    0.75 * clamp((dayTempPeak - HEAT_ONSET_C) / 12, 0, 1.3),
  );
  const gustFrac = Math.max(
    clamp((gustPeak - GUST_ONSET_KPH) / 45, 0, 1),
    DAY_WIDE_WEIGHT * clamp((Math.max(...dayLit.map((x) => x.gustMaxKph)) - GUST_ONSET_KPH) / 45, 0, 1),
  );

  // First hour of the day the storms show up at all, for the copy.
  const stormFrom = hours.find((x) => x.thunderMax >= STORM_ONSET_PROB)?.hour;

  const factors: ConditionFactor[] = [];

  // ---- wetness -------------------------------------------------------------
  // Antecedent water dried down over the hours elapsed before the route starts, at a half
  // life that depends on how well the route drains, plus anything that fell in between.
  const antecedent = weather.antecedentPrecipMm.length ? mean(weather.antecedentPrecipMm) : 0;
  const elapsed = Math.max(0, planStart);
  const halfLife = DRY_HALFLIFE_BASE_H + DRY_HALFLIFE_GAIN_H * terrain.holdsWater;
  const carried = antecedent * Math.pow(0.5, elapsed / halfLife);
  const before = weather.series[0].filter((s) => s.hour >= 0 && s.hour < planStart);
  const fellBefore = before.reduce((s, x) => s + x.precipMm, 0);
  const wetMm = carried + fellBefore + precipInWindow * 0.6;
  const wetPenalty = W.wetness * clamp((wetMm * terrain.holdsWater) / WET_SATURATION_MM, 0, WET_CEILING);

  // Which day the water came from. The antecedent total predates hour 0, so it belongs to
  // the day before now; anything in the series fell on a day we can name exactly.
  let rainDayIndex = clock.dayIndex - 1;
  if (fellBefore > carried && before.length > 0) {
    const wettest = before.reduce((a, b) => (b.precipMm > a.precipMm ? b : a));
    rainDayIndex = clock.dayIndex + Math.floor((clock.hourOfDay + wettest.hour) / 24);
  }
  const rainDay = weekdayLabel(rainDayIndex);
  if (wetPenalty >= 18) {
    factors.push({ kind: 'wetness', penalty: wetPenalty, text: `wet underfoot from ${rainDay} rain` });
  } else if (wetPenalty >= 7) {
    factors.push({
      kind: 'wetness',
      penalty: wetPenalty,
      text: terrain.flatShare > 0.5 ? `damp in the flats from ${rainDay} rain` : `damp in places from ${rainDay} rain`,
    });
  } else if (wetPenalty >= 2.5) {
    factors.push({ kind: 'wetness', penalty: wetPenalty, text: 'a few damp sections' });
  } else {
    factors.push({ kind: 'wetness', penalty: 0.4, text: 'dry underfoot' });
  }

  // ---- storm ---------------------------------------------------------------
  // Order matters. Storms that arrive after the route is done get the reassuring clause
  // even though the day-wide floor still gives them a penalty: the reader is being told
  // when the weather turns, not that it never does. This is the "Good, clear until
  // 15:00" card, and the floor is why that clause can reach a headline at all. The
  // phrasing leads with the window, not the threat: "storms hold off until 15:00" next
  // to a green pill read as a contradiction in review, and "clear until 15:00" is the
  // same fact stated from the green side.
  const stormPenalty = W.storm * stormLoad;
  if (stormFrom !== undefined && stormFrom > planEnd - 0.5) {
    factors.push({
      kind: 'storm',
      penalty: Math.max(1.5, stormPenalty),
      text: `clear until ${clockLabel(provider, stormFrom)}`,
      fromHour: stormFrom,
    });
  } else if (stormPeak >= STORM_ONSET_PROB && stormPenalty >= 4) {
    factors.push({
      kind: 'storm',
      penalty: stormPenalty,
      text: stormFrom !== undefined ? `${pct(stormPeak)} storms from ${clockLabel(provider, stormFrom)}` : `${pct(stormPeak)} storm chance`,
      ...(stormFrom !== undefined ? { fromHour: stormFrom } : {}),
    });
  } else if (stormPenalty >= 4.5) {
    factors.push({ kind: 'storm', penalty: stormPenalty, text: 'a chance of showers' });
  } else {
    // "Settled" is British meteorological usage for undisturbed weather, and it does not
    // carry to a US audience on a CONUS-only product. Björn read it and could not tell what
    // it claimed. "Stays clear" says the same thing plainly, and the verb matters: the
    // sibling clause at higher penalty is "clear until 15:00", which says the day TURNS, so
    // this one has to say it does not. Same distinction the two clauses always drew, in
    // words a reader does not have to be English to parse.
    factors.push({ kind: 'storm', penalty: 0.3, text: 'stays clear through the afternoon' });
  }

  // ---- exposure: the terrain amplifier -------------------------------------
  const sunFrac = Math.min(1, heatFrac) * (1 - cloudMean);
  const windFrac = gustFrac;
  const exposureLoad = clamp(hazardLoad * 0.9 + windFrac * 0.5 + sunFrac * 0.35, 0, 1);
  const exposurePenalty = W.exposure * terrain.exposedShare * exposureLoad;
  // Requires a hazard worth being exposed to: "no shelter above treeline" is misleading copy
  // on a calm clearing day, however exposed the route is.
  if (exposurePenalty >= 5 && exposureLoad >= 0.15) {
    const mostly = terrain.exposedShare > 0.6;
    let text: string;
    if (hazardLoad * 0.9 >= Math.max(windFrac * 0.5, sunFrac * 0.35)) {
      text = mostly ? 'no shelter above treeline' : 'an exposed section above treeline';
    } else if (windFrac * 0.5 >= sunFrac * 0.35) {
      text = 'nowhere to hide from the wind up high';
    } else {
      text = mostly ? 'open and unshaded above treeline' : 'unshaded above treeline';
    }
    factors.push({
      kind: 'exposure',
      penalty: exposurePenalty,
      text: stormFrom !== undefined && hazardLoad > 0.15 ? `${text} after ${clockLabel(provider, stormFrom)}` : text,
      ...(stormFrom !== undefined && hazardLoad > 0.15 ? { fromHour: stormFrom } : {}),
    });
  }

  // ---- heat ----------------------------------------------------------------
  const excess = heatFrac;
  // Narrower shade spread than the exposure term uses, on purpose: in the heat scenario the
  // temperature at route elevation has to be able to out-vote exposure, or heat and storms
  // end up ranking the list identically and the scenario switcher stops proving anything.
  const sunLoad = (0.6 + 0.4 * terrain.exposedShare) * (1 - 0.7 * cloudMean);
  // Effort: climbing is what overheats you, so gain is weighted ahead of time on feet.
  const effort = clamp(1 + trail.gainM / 700 + Math.max(0, terrain.durationH - 2) / 6, 0.6, 2.2);
  const heatPenalty = W.heat * excess * sunLoad * effort;
  if (heatPenalty >= 16) {
    let text: string;
    if (terrain.exposedShare > 0.5) {
      text = terrain.durationH >= 3 ? 'hot and unshaded on a long climb' : 'hot in full sun with no shade';
    } else {
      text = terrain.durationH >= 3 ? 'hot work for a route this long' : 'hot for the climbing involved';
    }
    factors.push({ kind: 'heat', penalty: heatPenalty, text });
  } else if (heatPenalty >= 7) {
    factors.push({
      kind: 'heat',
      penalty: heatPenalty,
      text: terrain.exposedShare > 0.4 ? 'warm work in full sun' : 'warm going in the heat',
    });
  }

  // ---- wind ----------------------------------------------------------------
  const windPenalty = W.wind * windFrac * (0.5 + 0.5 * terrain.exposedShare);
  if (windPenalty >= 8) {
    factors.push({ kind: 'wind', penalty: windPenalty, text: 'strong gusts on the open sections' });
  } else if (windPenalty >= 5) {
    factors.push({ kind: 'wind', penalty: windPenalty, text: 'gusty in the afternoon' });
  }

  // ---- daylight ------------------------------------------------------------
  const shortfall = terrain.durationH - availableH;
  if (shortfall > 0) {
    const dp = Math.min(W.daylight, W.daylight * (0.45 + shortfall / 4));
    factors.push({
      kind: 'daylight',
      penalty: dp,
      text: dayOffset === 0 ? 'too long for the daylight left today' : 'longer than the day is',
      fromHour: Math.round(dayEnd),
    });
  } else if (shortfall > -1.5) {
    factors.push({
      kind: 'daylight',
      penalty: 9,
      text: dayOffset === 0 ? 'tight on daylight if you start now' : 'no spare daylight',
      fromHour: Math.round(dayEnd),
    });
  }

  factors.sort((a, b) => b.penalty - a.penalty);
  const total = factors.reduce((s, f) => s + f.penalty, 0);
  const level: GradeLevel = total <= PRIME_MAX ? 'prime' : total <= MIXED_MAX ? 'mixed' : 'poor';

  return {
    level,
    confidence: 'route-specific',
    headline: buildHeadline(factors),
    factors,
    bestWindow,
    score: clamp(100 - total, 0, 100),
  };
}

/** Top one or two clauses. The second only joins if it is carrying real weight. */
function buildHeadline(factors: ConditionFactor[]): string {
  const useful = factors.filter((f) => f.penalty >= 0.3);
  if (useful.length === 0) return 'nothing standing in the way';
  const top = useful[0];
  // Never pair two clauses that turn on the same hour: "no shelter above treeline after
  // 13:00, clear until 13:00" is one fact told twice, and it reads as a
  // contradiction. Keep the heavier clause and move to the next distinct one.
  const second = useful.slice(1).find((f) => f.fromHour === undefined || f.fromHour !== top.fromHour);
  if (!second) return top.text;
  // Nothing binding at all: run both reassurances, because one on its own reads thin.
  if (top.penalty < 1.5) return `${top.text}, ${second.text}`;
  if (second.penalty >= Math.max(1.4, top.penalty * 0.22)) return `${top.text}, ${second.text}`;
  return top.text;
}

// ============================================================================
// OUTLOOK — past the provider's horizon
// ============================================================================

/**
 * Coarse weights, as maximum penalty points each regional term can contribute.
 *
 * Lower than `W` across the board, and deliberately so: a call made without the hour, the
 * shelter, the drainage or the aspect should be slower to condemn a day than one made with
 * them. Storm leads because convection is what actually stops a mountain day; wind is the
 * smallest because a coarse wind number is the least trustworthy of the four.
 */
const OUTLOOK_W = {
  storm: 30,
  wetness: 22,
  heat: 24,
  wind: 12,
} as const;

/** Level thresholds on the coarse total. Tuned in scope/grade-check.mjs. */
const OUTLOOK_PRIME_MAX = 10;
const OUTLOOK_MIXED_MAX = 38;

/** Regional rain over one day that counts as a thoroughly wet day, mm. */
const OUTLOOK_WET_MM = 40;
/** Thunder probability below which a coarse outlook says nothing about storms at all. */
const OUTLOOK_STORM_ONSET = 0.15;
/** Penalty a coarse term has to reach before it is worth printing as a clause. */
const OUTLOOK_PRINT = 4;

/**
 * Penalty a coarse term has to reach before a condition filter will EXCLUDE a route on it.
 *
 * Higher than the route-specific thresholds, and that direction is deliberate. Inside the
 * horizon the terms that discriminate between two routes in the same weather (drainage,
 * shelter, when the window is) are all present, so excluding one route and keeping the
 * other is a claim we can stand behind. Past the horizon those terms are gone, so the same
 * threshold does not filter a list, it empties a region on one number. Less certainty
 * should widen the net, not narrow it: exclude only where the regional signal is strong
 * enough that the outlook's own copy is naming it, and leave everything else in for the
 * reader to check again once the day comes inside the horizon.
 *
 * The wetness clause is written off this same constant, so `Dry underfoot` excludes exactly
 * the routes whose card reads "a wet day across the area" and nothing else.
 */
const OUTLOOK_EXCLUDE = 12;

/** The regional day, averaged across the route's sample points. No terrain in it. */
interface RegionalDay {
  thunderPeak: number;
  precipTotalMm: number;
  tempMaxC: number;
  gustPeakKph: number;
}

/**
 * Reduce the hourly field over one day to four regional numbers.
 *
 * Each hour is averaged ACROSS the sample points first, then aggregated over the day. The
 * average is the point: taking the worst point would reintroduce exactly the ridge-versus-
 * valley judgement the outlook is not entitled to make, and taking the trailhead alone
 * would be the SnowCast model. What is left after averaging is the air mass over the
 * elevation band the route sits in, which is a statement about the area, not about the
 * route's shelter, surface, steepness or timing.
 */
function regionalDay(weather: WeatherResult, dayStart: number, dayEnd: number): RegionalDay | null {
  const first = weather.series[0] ?? [];
  let thunderPeak = 0;
  let precipTotalMm = 0;
  let tempMaxC = -100;
  let gustPeakKph = 0;
  let hours = 0;

  for (const probe of first) {
    if (probe.hour < dayStart - 0.5 || probe.hour > dayEnd + 0.5) continue;
    let thunder = 0;
    let precip = 0;
    let temp = 0;
    let gust = 0;
    let n = 0;
    for (const series of weather.series) {
      const s = series.find((x) => x.hour === probe.hour);
      if (!s) continue;
      thunder += s.thunderProb;
      precip += s.precipMm;
      temp += s.tempC;
      gust += s.gustKph;
      n++;
    }
    if (n === 0) continue;
    thunderPeak = Math.max(thunderPeak, thunder / n);
    precipTotalMm += precip / n;
    tempMaxC = Math.max(tempMaxC, temp / n);
    gustPeakKph = Math.max(gustPeakKph, gust / n);
    hours++;
  }

  return hours === 0 ? null : { thunderPeak, precipTotalMm, tempMaxC, gustPeakKph };
}

/**
 * Deliberately coarse, and deliberately blunt about it, but never empty.
 *
 * What it claims: a level for the AREA on that DAY, from four wide regional terms, with at
 * most two clauses of plain copy naming which of them bound.
 *
 * What it refuses to claim, all of it enforced here rather than by convention:
 *   - any hour. No clock times in the copy, no `fromHour` on any factor, no best window.
 *   - any terrain. No exposure, no drainage, no surface, no steepness, no duration. The
 *     four terms are read straight off the regional field.
 *   - any ranking. `score` is quantised to one constant per level, so the Best-today sort
 *     cannot pretend to separate two routes that the forecast cannot separate, and falls
 *     through to its secondary keys instead. That behaviour is itself the finding.
 *
 * `poor` is reachable, unlike in the first cut of this function. A coarse forecast really
 * can say a day is a write-off for a whole area, and refusing to say it had a worse cost
 * than the false precision it avoided: every trail came back mixed with no window, which no
 * condition filter could satisfy, and the filtered list silently emptied. Degrading has to
 * mean less certainty, not less content. The bar for `poor` is high enough that it takes
 * two full terms, or one term at its maximum plus most of another, to reach it.
 */
function outlookGrade(
  weather: WeatherResult,
  dayStart: number,
  dayEnd: number,
  provider: WeatherProvider,
): ConditionGrade {
  const day = regionalDay(weather, dayStart, dayEnd);
  if (!day) return noDataGrade(provider);

  const stormLoad = clamp((day.thunderPeak - OUTLOOK_STORM_ONSET) / 0.6, 0, 1);
  const wetLoad = clamp(day.precipTotalMm / OUTLOOK_WET_MM, 0, 1);
  const heatLoad = clamp((day.tempMaxC - HEAT_ONSET_C) / 12, 0, 1);
  const windLoad = clamp((day.gustPeakKph - GUST_ONSET_KPH) / 45, 0, 1);

  const stormPenalty = OUTLOOK_W.storm * stormLoad;
  const wetPenalty = OUTLOOK_W.wetness * wetLoad;
  const heatPenalty = OUTLOOK_W.heat * heatLoad;
  const windPenalty = OUTLOOK_W.wind * windLoad;

  // The total counts every term, printed or not, so a level is never an artefact of which
  // clauses happened to clear the copy threshold.
  const total = stormPenalty + wetPenalty + heatPenalty + windPenalty;
  const level: GradeLevel =
    total <= OUTLOOK_PRIME_MAX ? 'prime' : total <= OUTLOOK_MIXED_MAX ? 'mixed' : 'poor';

  // Copy: regional in every clause, so nothing here can be read as a fact about the route.
  // No hour, no units, percentages would be false precision on a coarse call.
  const factors: ConditionFactor[] = [];
  if (stormPenalty >= OUTLOOK_PRINT) {
    factors.push({
      kind: 'storm',
      penalty: stormPenalty,
      text: stormLoad >= 0.5 ? 'storms likely across the area' : 'storms possible across the area',
    });
  }
  if (wetPenalty >= OUTLOOK_PRINT) {
    factors.push({
      kind: 'wetness',
      penalty: wetPenalty,
      text: wetPenalty >= OUTLOOK_EXCLUDE ? 'a wet day across the area' : 'rain around the area',
    });
  }
  if (heatPenalty >= OUTLOOK_PRINT) {
    factors.push({
      kind: 'heat',
      penalty: heatPenalty,
      text: heatLoad >= 0.6 ? 'hot across the area' : 'warm across the area',
    });
  }
  if (windPenalty >= OUTLOOK_PRINT) {
    factors.push({ kind: 'wind', penalty: windPenalty, text: 'windy across the area' });
  }
  factors.sort((a, b) => b.penalty - a.penalty);
  // Two clauses is the ceiling. A coarse call that lists four reasons is pretending to a
  // detail it does not have.
  const kept = factors.slice(0, 2);
  if (kept.length === 0) {
    kept.push({ kind: 'storm', penalty: 0.3, text: 'no storms across the area' });
  }

  return {
    level,
    confidence: 'outlook',
    // One clause, no hour, no route detail. The card and the peek sheet carry the horizon
    // sentence itself, so repeating it here would spend the pill on chrome.
    headline: kept[0].text,
    factors: kept,
    bestWindow: null,
    score: OUTLOOK_SCORE[level],
  };
}

/**
 * One score per level and nothing in between. Two routes a coarse outlook cannot separate
 * must tie, so the Best-today sort visibly falls through instead of inventing an order.
 */
const OUTLOOK_SCORE: Record<GradeLevel, number> = { prime: 68, mixed: 46, poor: 24 };

/**
 * A provider that returned nothing for the requested day. Says so; guesses nothing.
 *
 * Still deliberately `mixed` rather than `poor`: no data is not bad weather. Every
 * condition predicate treats it the same way it treats any other outlook grade, so a
 * provider with a short series degrades the copy without emptying the list either.
 */
function noDataGrade(provider: WeatherProvider): ConditionGrade {
  return {
    level: 'mixed',
    confidence: 'outlook',
    headline: `no forecast past ${Math.round(provider.horizonHours)} h`,
    factors: [],
    bestWindow: null,
    score: 45,
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// ============================================================================
// CONDITION FILTERS — the predicates the chip row needs
// ============================================================================

/** Everything a condition filter can ask about, gathered once by the caller. */
export interface ConditionContext {
  trail: ScopeTrail;
  region: RegionDef;
  /**
   * Grade for the day the reader picked in the day bar, and the only grade any filter
   * reads. There used to be a second one here for a `good-tomorrow` chip; the day bar owns
   * the date dimension now, so a chip that carried its own day was a second, contradictory
   * answer to the same question.
   */
  today: ConditionGrade;
}

/** Penalty a given factor contributed, 0 when it did not fire. */
export function factorPenalty(grade: ConditionGrade, kind: FactorKind): number {
  let worst = 0;
  for (const f of grade.factors) if (f.kind === kind) worst = Math.max(worst, f.penalty);
  return worst;
}

/**
 * Prime, or mixed with a window long enough to actually do the route in.
 *
 * Past the horizon the window test cannot be run: there are no hours to find a window in,
 * so `bestWindow` is null for everything by construction. Applying the window test anyway
 * is what emptied the filtered list, so the coarse test is the level itself. A mixed
 * regional outlook is a day still worth planning for and a poor one is not, which is the
 * most a call about an area on a day is entitled to say.
 */
export function isGood(grade: ConditionGrade): boolean {
  if (grade.level === 'poor') return false;
  if (grade.level === 'prime') return true;
  if (grade.confidence === 'outlook') return true;
  return grade.bestWindow !== null;
}

/** A route is shaded when the great majority of it sits below the regional treeline. */
export function shadedEnough(trail: ScopeTrail, region: RegionDef): boolean {
  return terrainFacts(trail, region).shadedShare >= 0.75;
}

/**
 * `help` describes the route-specific test. `coarseHelp` describes what the same chip means
 * once the selected day is past the provider's horizon, and is null for the two chips that
 * are pure terrain facts and therefore mean exactly the same thing on every day.
 *
 * It is copy, not UI: `conditionFilterDegraded` tells a caller when to show it.
 */
export const CONDITION_FILTERS: {
  id: ConditionFilterId;
  label: string;
  help: string;
  coarseHelp: string | null;
}[] = [
  {
    id: 'good-conditions',
    label: 'Good conditions',
    help: 'graded Good on the day you picked, or with a window long enough for the route',
    coarseHelp: 'past the horizon: the regional outlook for the day you picked is not poor',
  },
  {
    id: 'dry',
    label: 'Dry underfoot',
    help: 'no meaningful wetness penalty from antecedent rain',
    coarseHelp: 'past the horizon: the regional outlook is not a wet one, with no drainage term',
  },
  {
    id: 'storm-free',
    label: 'Storm-free window',
    help: 'a usable window with the convection outside it',
    coarseHelp: 'past the horizon: no storms in the regional outlook, and no window claim at all',
  },
  {
    id: 'below-treeline',
    label: 'Below treeline',
    help: 'the whole route stays under the regional treeline',
    coarseHelp: null,
  },
  {
    id: 'shaded',
    label: 'Shaded',
    help: 'at least three quarters of the route is under tree cover',
    coarseHelp: null,
  },
];

/**
 * True when this chip is answering a coarser question than its label promises, because the
 * grade it reads is an outlook rather than a route-specific one. `CONDITION_FILTERS[].
 * coarseHelp` is the sentence to show when it is.
 *
 * `confidence` is the confidence of the grade THAT CHIP READS, which is now always the
 * selected day's: no chip carries a day of its own any more.
 *
 * Two chips are never degraded. `below-treeline` and `shaded` are terrain facts, computed
 * from the trail's own profile against the regional treeline, and they do not involve the
 * forecast at all: they mean the same thing on day 0 and on day 4. That distinction is
 * worth keeping visible, because it is the same distinction the whole page is about.
 */
export function conditionFilterDegraded(
  id: ConditionFilterId,
  confidence: GradeConfidence,
): boolean {
  if (confidence === 'route-specific') return false;
  switch (id) {
    case 'below-treeline':
    case 'shaded':
      return false;
    case 'good-conditions':
    case 'dry':
    case 'storm-free':
      return true;
  }
}

/**
 * Every predicate has to return a usable answer on every day the scrubber offers. A chip
 * that can only ever be false past the horizon does not communicate a limit, it empties the
 * list and reads as a bug, so each test below degrades to the coarsest honest form of the
 * same question rather than failing shut.
 */
export function matchesConditionFilter(id: ConditionFilterId, ctx: ConditionContext): boolean {
  switch (id) {
    case 'good-conditions':
      return isGood(ctx.today);
    case 'dry':
      // Inside the horizon this is antecedent water dried down over THIS ROUTE's drainage:
      // surface, steepness and flat share all move it, so two routes in one rainstorm get
      // different answers. Past it there is no drainage term to move anything, so the same
      // threshold would exclude a whole region on one regional number. It excludes only
      // what the outlook itself calls a wet day, which is the exclusion rule stated in
      // OUTLOOK_EXCLUDE: without the terms that discriminate, err towards including.
      if (ctx.today.confidence === 'outlook') return factorPenalty(ctx.today, 'wetness') < OUTLOOK_EXCLUDE;
      return factorPenalty(ctx.today, 'wetness') < 7;
    case 'storm-free':
      // The only inherently hourly chip: it asks for a window with the convection outside
      // it, and past the horizon there are no hours and no windows to put anything outside
      // of. The coarse form drops the window half of the question and keeps the storm half,
      // so it still separates a settled regional day from a convective one. Degraded, and
      // it says so.
      if (ctx.today.confidence === 'outlook') return factorPenalty(ctx.today, 'storm') < OUTLOOK_EXCLUDE;
      return ctx.today.bestWindow !== null && factorPenalty(ctx.today, 'storm') < 12;
    case 'below-treeline':
      // Terrain, not weather. Identical on every day, horizon or not.
      return ctx.trail.maxElevM <= ctx.region.treelineM;
    case 'shaded':
      return shadedEnough(ctx.trail, ctx.region);
  }
}

export function matchesConditionFilters(ids: ConditionFilterId[], ctx: ConditionContext): boolean {
  for (const id of ids) if (!matchesConditionFilter(id, ctx)) return false;
  return true;
}

// ============================================================================
// THE MODEL AS DATA — so the document cannot describe a grade this file does not give
// ============================================================================
//
// PURELY ADDITIVE. Nothing above this line changed to make this block exist: it reads the
// same `W`, cuts, onsets and outlook constants the grader reads, by reference, and adds no
// behaviour of its own. `scope/grade-check.mjs` is the proof (claims (a) (b) (c) unchanged).
//
// WHY IT EXISTS. `scope.html`'s Methodology section used to say only that "the weighting is
// my judgement", which tells a reader nothing about how the judgement is made, and the
// audience for that page includes TWC's science lead. Documenting the model in prose would
// have meant typing every weight a second time in `src/scope/doc.ts`, and a documented
// weight that has silently drifted from the real one is worse than no documentation: it
// invites a science reviewer to argue with a number this file no longer uses. So the page
// renders FROM HERE. Retune anything in TUNING or in OUTLOOK and the page follows on the
// next build, with no copy to remember to edit.
//
// Deliberately a plain data object and not a formatter: units, rounding, wording and
// ordering are the document's business (`doc.ts` owns the units toggle and the house
// no-decimals-on-percentages rule), and this file has no business knowing about either.

/** One rule of `surfaceHold`, in the form the document tabulates it. */
export interface SurfaceHoldRule {
  /** The OSM `surface` values the rule covers, as the document should list them. */
  surfaces: string;
  /**
   * A value that provably falls into this rule, kept so `hold` below is READ out of
   * `surfaceHold` rather than transcribed from it. `null` is the untagged case, which is
   * the majority of the network and therefore the row that matters most.
   */
  probe: string | null;
  hold: number;
}

/**
 * `surfaceHold` is a regex cascade, so it cannot enumerate itself: the surface lists below
 * are written by hand against the patterns in that function. The NUMBERS are not. Each row
 * carries a probe string that the cascade classifies at module load, so retuning a hold
 * moves the table, and retuning a PATTERN so that a probe falls into a different bucket
 * moves the table too, visibly, rather than leaving a stale figure on the page.
 *
 * Sorted by hold rather than by declaration order, ascending, because the ordering is the
 * argument: the hedged untagged value lands mid-table between the surfaces that drain and
 * the surfaces that hold, which is exactly what the page has to say about it.
 */
const SURFACE_HOLD_RULES: SurfaceHoldRule[] = [
  { surfaces: 'asphalt, concrete, paved, paving_stones, metal', probe: 'asphalt' },
  { surfaces: 'rock, bare_rock, stone, scree, pebblestone', probe: 'rock' },
  { surfaces: 'gravel, fine_gravel, compacted, woodchips', probe: 'gravel' },
  { surfaces: 'sand', probe: 'sand' },
  { surfaces: 'wood, boardwalk', probe: 'boardwalk' },
  { surfaces: 'no surface tag', probe: null },
  { surfaces: 'any other tagged value', probe: 'brick' },
  { surfaces: 'ground, dirt, earth, soil, grass, unpaved', probe: 'dirt' },
  { surfaces: 'mud, clay, bog', probe: 'mud' },
]
  .map((r) => ({ ...r, hold: surfaceHold(r.probe) }))
  .sort((a, b) => a.hold - b.hold);

/**
 * Every tuning parameter the conditions grade turns on, in one frozen object.
 *
 * NOTHING HERE IS TRANSCRIBED. Every value is the same binding the grader reads, so the
 * document this feeds cannot drift from the model it documents, which is the whole reason
 * the object exists. Two of them briefly were mirrors: the drying-rate gain and the wetness
 * saturation point were inline literals in `gradeTrail`, hand-copied here and hand-copied
 * again in `src/trail/journey.ts`'s ground word, which is three copies of one number and
 * exactly the failure this export is meant to prevent. They are now
 * `DRY_HALFLIFE_GAIN_H`, `WET_SATURATION_MM` and `WET_CEILING`, declared with the other
 * tuning constants and read in all three places.
 *
 * Keep it that way: if a new parameter cannot be referenced without editing the grader,
 * edit the grader. A documented weight that silently disagrees with the real one is worse
 * than an undocumented model.
 */
export const GRADE_MODEL = Object.freeze({
  /** Route-specific weights, inside the provider's horizon. Maximum penalty points each. */
  weights: W,
  /** Cuts on the summed penalty: at or below `primeMax` is Good, then Mixed, then Poor. */
  levelCuts: { primeMax: PRIME_MAX, mixedMax: MIXED_MAX },
  /** Where each weather term starts to bite at all. */
  onsets: { heatC: HEAT_ONSET_C, gustKph: GUST_ONSET_KPH, stormProb: STORM_ONSET_PROB },
  /** Mean usability a window must reach before it is offered as a best window, 0..1. */
  windowUsable: WINDOW_USABLE,
  /** Fraction of its weight a hazard OUTSIDE the plan window still contributes. */
  dayWideWeight: DAY_WIDE_WEIGHT,
  /** Hour the grade assumes someone sets off, on any day that is not today. */
  typicalStartHour: TYPICAL_START_HOUR,
  /** The ground and soil sub-model. See `terrainFacts` and the wetness block. */
  ground: {
    dryHalfLifeBaseH: DRY_HALFLIFE_BASE_H,
    dryHalfLifeGainH: DRY_HALFLIFE_GAIN_H,
    saturationMm: WET_SATURATION_MM,
    surfaceHold: SURFACE_HOLD_RULES,
  },
  /** The separate, coarser set that runs past the horizon. No terrain term in it. */
  outlook: {
    weights: OUTLOOK_W,
    levelCuts: { primeMax: OUTLOOK_PRIME_MAX, mixedMax: OUTLOOK_MIXED_MAX },
    wetDayMm: OUTLOOK_WET_MM,
    stormOnset: OUTLOOK_STORM_ONSET,
    excludeAt: OUTLOOK_EXCLUDE,
    scoreByLevel: OUTLOOK_SCORE,
  },
});
