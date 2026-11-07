// Trail Scope phone — the grade cache.
//
// Grading is the expensive thing on this page. Every card, every map line, the Best-today
// sort and three of the six condition filters all want a `ConditionGrade`, and the list
// regrades on every scenario, region, day and unit change. Ungated, a region change would
// walk 229 routes × 5 sample points × ~110 hours of simulated weather on every keystroke
// in the search field.
//
// So nothing here is clever, it is just memoised in two layers:
//
//   weather  keyed by scenario | region | trail. One fetch per trail covers every day the
//            scrubber offers, because `fetchRouteWeather` takes a max day offset and the
//            provider returns one long hourly series.
//   grade    keyed by scenario | region | trail | day, derived from the cached weather.
//
// Units are deliberately NOT in either key: everything is SI at rest and the formatters
// convert at render time, so flipping the toggle re-renders and regrades nothing.
//
// The provider is asynchronous by contract (a real Super Resolution call is a network
// call), so filling the cache is a promise. Reading it is synchronous and returns null on
// a miss, which lets render() draw immediately with a pending state instead of blocking
// the first paint on a fetch that has not landed.

import { fetchRouteWeather } from '../weather/provider';
import { defaultGradeTraversal, gradeTrail } from '../weather/grade';
import { simulatedProvider } from '../weather/simulated';
import { REGIONS } from '../model';
import type { GradeTraversal } from '../weather/grade';
import type {
  ConditionGrade,
  RegionId,
  ScenarioId,
  ScopeTrail,
  WeatherProvider,
  WeatherResult,
} from '../types';

/**
 * Days the scrubber offers, including today. SEVEN, because a week is the unit people plan
 * a day out in: "when this week can I do this?" is the question the peek's day row answers,
 * and a five day row cannot answer it without the reader doing arithmetic.
 *
 * It was five, which was enough to demonstrate the horizon (with a +36 h horizon and an
 * 08:00 clock, days 0 and 1 are route-specific and everything past them is outlook) but not
 * enough to be a week. Widening it does not weaken that demonstration, it strengthens it:
 * five of the seven days are now visibly past the wall.
 *
 * Everything downstream sizes itself off this constant. The day bar loops over it, the
 * request length is derived from it (MAX_DAY below, through `hoursForDay`), and the peek's
 * per-trail day row reads it, so a longer or shorter week is one number.
 */
export const SCRUB_DAYS = 7;

/**
 * One extra day is fetched past the last scrubbed one, so grading day 6 has a full day of
 * lookahead (best windows and "clear until" claims can reach past midnight).
 *
 * This is also what sizes the provider's hourly series: `fetchRouteWeather` turns it into
 * `hoursForDay(MAX_DAY)`, which is `24 * MAX_DAY - hourOfDay + 25` hours, so widening the
 * scrubber widens the series by construction and no provider needs to know. At SCRUB_DAYS
 * = 7 and an 08:00 clock that is 185 hours, which covers day 7 (the lookahead) in full.
 */
const MAX_DAY = SCRUB_DAYS;

// ============================================================================
// FORECAST AGE — the offline half of the horizon
// ============================================================================
//
// THE MECHANISM, BECAUSE IT IS ONE MECHANISM AND NOT TWO. A cached forecast has a fetch
// time and a reach: Super Resolution is +36 h from the run it came out of, not +36 h from
// whenever you happen to look at it. So a forecast fetched six hours ago has thirty hours
// of route-specific claim left, one fetched twenty hours ago has sixteen, and eventually
// the hourly claim expires in the reader's pocket while they are still on the trail. The
// data-age indicator in the frame and the +36 h wall on the day bar are therefore the same
// fact read from its two ends, and this module is where that fact lives.
//
// WHY IT MATTERS HERE AT ALL: most US trails have no cell service, so a real product spends
// most of its useful life exactly here, reading a forecast it cannot refresh. This
// prototype is already offline-first by construction — the trail data is frozen and
// committed, the grade runs client-side off one cached series per trail, and nothing on
// screen needs a network after the first fill — so the offline state is not something to
// fake, it is something to EXPOSE.
//
// HOW IT IS MODELLED, and the one thing to get right. The provider's clock is frozen (day
// 0, 08:00; see `simulated.ts` for why determinism matters more than a live clock here), so
// "offline for N hours" is modelled as THE FETCH HAVING HAPPENED N HOURS BEFORE NOW, never
// as now having moved forward. That choice is what keeps everything else honest: `now()` is
// untouched, so every day boundary, every weekday label and every hours-from-now offset in
// the cached series stays exactly where it was, and the ONLY thing that changes is how far
// ahead of now the cached run still reaches — `horizonHours - ageHours`. Advancing the
// clock instead would have shifted the whole page's notion of today.
//
// WHY MODULE STATE RATHER THAN A PARAMETER. It is a property of the device, not of a call:
// there is one radio and one cache. Threading it through `gradeOf`, `ensureGrades`,
// `providerFor` and their eight call sites would create exactly the half-threaded-argument
// bug this file's cache keys exist to prevent, where one caller passes it and another
// silently reads a stale grade. `providerFor` reads it on every call and `gKey` includes it,
// so a change of connection state cannot serve a grade computed at a different horizon.

let forecastAgeH = 0;

/** Hours since the last successful fetch. 0 is live: the app is online and the forecast is
 *  the current run. Anything higher is a cached run being read offline. */
export function forecastAge(): number {
  return forecastAgeH;
}

/** Set by `app.ts` from the chrome control. Clamped at 0 because a forecast cannot be
 *  fetched in the future, and unclamped above because a horizon that has run out entirely
 *  is a real state, not an error one. */
export function setForecastAge(hours: number): void {
  forecastAgeH = Math.max(0, hours);
}

/**
 * The same provider with its horizon shortened by however old the cached run is.
 *
 * Memoised per scenario, region and age so the object identity is stable across renders:
 * `providerFor` is called several times per frame and a fresh wrapper each time would be
 * both wasteful and a trap for anything that ever compares providers.
 *
 * Everything downstream follows for free, which is the point of `types.ts` making the UI
 * read `horizonHours` rather than hard-code 36: `grade.ts`'s `inHorizon` test, the day
 * bar's wall and its label, `firstOutlookDay`, `frameFor`, the list header's fallback-sort
 * note and the filter sheet's degradation note all move together, and none of them needed
 * telling that offline exists.
 */
const agedCache = new Map<string, WeatherProvider>();

export function providerFor(scenario: ScenarioId, region: RegionId): WeatherProvider {
  const base = simulatedProvider(scenario, region);
  if (forecastAgeH <= 0) return base;
  const key = `${scenario}|${region}|${forecastAgeH}`;
  const hit = agedCache.get(key);
  if (hit) return hit;
  const aged: WeatherProvider = {
    id: base.id,
    label: base.label,
    resolutionM: base.resolutionM,
    horizonHours: Math.max(0, base.horizonHours - forecastAgeH),
    now: () => base.now(),
    // Delegated unchanged. The cached SERIES is the same field either way — a run issued
    // earlier still describes the same weather at the same absolute hours — so nothing here
    // may pretend the numbers themselves are different. What a stale run loses is its
    // right to be quoted hour by hour that far ahead, and that is `horizonHours`' job alone.
    fetch: (query) => base.fetch(query),
  };
  agedCache.set(key, aged);
  return aged;
}

/** The horizon a fresh fetch would have, for the frame to show what being offline costs.
 *  Read off the un-aged provider rather than from a constant, for the same reason nothing
 *  else here hard-codes 36. */
export function freshProviderFor(scenario: ScenarioId, region: RegionId): WeatherProvider {
  return simulatedProvider(scenario, region);
}

/**
 * First day offset the provider cannot make a route-specific claim about.
 *
 * Read off `provider.horizonHours`, never hard-coded: a provider with a longer horizon
 * moves the wall on its own. The 6 is a nominal sunrise, which is when the day the reader
 * is planning actually begins; `grade.ts` makes the same test against the real sunrise, so
 * the scrubber label and the card confidence agree.
 */
export function firstOutlookDay(provider: WeatherProvider): number {
  const { hourOfDay } = provider.now();
  for (let d = 0; d < SCRUB_DAYS; d++) {
    if (Math.max(0, 24 * d + 6 - hourOfDay) > provider.horizonHours) return d;
  }
  return SCRUB_DAYS;
}

const weatherCache = new Map<string, WeatherResult>();
const gradeCache = new Map<string, ConditionGrade>();

const wKey = (s: ScenarioId, r: RegionId, id: string): string => `${s}|${r}|${id}`;
// Traversal joins the key, not just the grade call: a peek grading one trail at `one-way`
// must never collide with (or overwrite) the same trail's list-basis entry at
// `incl-return`. Weather itself has no traversal key — `fetchRouteWeather` returns the
// same hourly field regardless of how the walk is graded, so only the derived grade needs
// the extra dimension.
//
// FORECAST AGE joins the key for the same reason traversal does: an aged provider grades
// the same trail on the same day differently (its horizon is shorter, so a day that was
// route-specific becomes a regional outlook), and a cache that could not tell the two apart
// would hand back a route-specific grade to a reader who has just gone offline. Weather is
// still keyed without it — see `wKey`: the series is identical, only its right to be quoted
// hour by hour has changed.
const gKey = (s: ScenarioId, r: RegionId, id: string, day: number, traversal: GradeTraversal): string =>
  `${s}|${r}|${id}|${day}|${traversal}|${forecastAge()}`;

/** Cached weather for a trail, or null when it has not been fetched yet. */
export function weatherOf(
  scenario: ScenarioId,
  region: RegionId,
  trail: ScopeTrail,
): WeatherResult | null {
  return weatherCache.get(wKey(scenario, region, trail.id)) ?? null;
}

/**
 * Cached grade, or null on a miss. Synchronous by design; see the header.
 *
 * `traversal` defaults to the trail's own list basis (`defaultGradeTraversal`), which is
 * what every caller but the peek wants: the results list, the map, the sort and the
 * filters all read this with no traversal argument, and it is load-bearing that they keep
 * doing so, because a per-trail choice must never leak into the shared ranking. Only
 * `phone/peek.ts`, when the reader has picked something other than the default for the
 * one trail on screen, passes a traversal explicitly.
 */
export function gradeOf(
  scenario: ScenarioId,
  region: RegionId,
  trail: ScopeTrail,
  day: number,
  traversal: GradeTraversal = defaultGradeTraversal(trail.routeType),
): ConditionGrade | null {
  return gradeCache.get(gKey(scenario, region, trail.id, day, traversal)) ?? null;
}

/**
 * Fill the cache for these trails on these days. Resolves once every grade is present, so
 * a caller can await it and then render synchronously with no holes.
 *
 * One `traversal` for the whole call, defaulted per trail when omitted (see `gradeOf`).
 * The list's own fill (`app.ts`'s `fillGrades`) always omits it, so a mixed batch of loops
 * and point-to-point trails each grades at ITS OWN default; the peek always passes one
 * explicit traversal, because it only ever fills for the single trail on screen.
 */
export async function ensureGrades(
  scenario: ScenarioId,
  region: RegionId,
  trails: ScopeTrail[],
  days: number[],
  traversal?: GradeTraversal,
): Promise<void> {
  const provider = providerFor(scenario, region);
  const def = REGIONS[region];

  const pending: Promise<void>[] = [];
  for (const trail of trails) {
    const t = traversal ?? defaultGradeTraversal(trail.routeType);
    const wk = wKey(scenario, region, trail.id);
    const missingDays = days.filter((d) => !gradeCache.has(gKey(scenario, region, trail.id, d, t)));
    if (missingDays.length === 0) continue;

    const cached = weatherCache.get(wk);
    if (cached) {
      for (const d of missingDays) {
        gradeCache.set(gKey(scenario, region, trail.id, d, t), gradeTrail(trail, def, cached, d, provider, t));
      }
      continue;
    }

    pending.push(
      fetchRouteWeather(provider, trail, MAX_DAY).then((res) => {
        weatherCache.set(wk, res);
        for (const d of missingDays) {
          gradeCache.set(gKey(scenario, region, trail.id, d, t), gradeTrail(trail, def, res, d, provider, t));
        }
      }),
    );
  }

  if (pending.length) await Promise.all(pending);
}
