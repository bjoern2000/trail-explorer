// Trail mode — the second anchor, and the cached run it is read through.
//
// TRAIL_PLAN.md §1 took four decisions before anything was drawn, and the first was ONE
// SCREEN, TWO ANCHORS: the same artifact, anchored either to a departure the reader picks
// (planning) or to now (walking), with the walked portion behind you and what is left
// re-read against the clock. The walking anchor was cut, code included, when the page was
// restructured map-first (§10 records the deletion), so this file is that decision written
// again rather than un-commented — and it comes back joined to the state it is actually met
// in, which is the point of rebuilding it now.
//
// WHY THE TWO BELONG TOGETHER. Björn: "for offline that's mostly relevant for weather on
// route... the user is in the middle of their route and is checking the forecast but we need
// to say that the forecast is based on offline data." He is right that this belongs here and
// not on the discovery list: browsing a trail list with no signal is not a real moment, and
// checking a forecast three hours up a trail with no signal is the ONLY moment most US trails
// offer. Mid-route is exactly when your data is stale, so the walking anchor and the cached
// run are one state, not two features that happen to coexist.
//
// WHAT IS WORTH DRAWING, AND WHAT IS NOT. There is no "offline" banner here, deliberately.
// That the radio is off is not the interesting fact and it changes nothing a walker decides.
// Two things do, and both are computable:
//
//   1. WHEN THE FORECAST WAS LAST FETCHED, AND HOW OLD THAT IS. Modelled exactly the way
//      `scope/phone/grading.ts` already models it, and read from there rather than invented a
//      second time: the fetch is treated as having happened N hours BEFORE now, never as the
//      clock moving forward. Every clock label, every marker hour and every day boundary in
//      the journey therefore stays exactly where it was, and the only thing age changes is
//      how far ahead the cached run still reaches.
//   2. WHETHER THE CACHED RUN STILL COVERS THE REST OF THE WALK. This is the payload, and
//      nothing in this repo has drawn it. Super Resolution is +36 h FROM THE RUN IT CAME OUT
//      OF, not +36 h from whenever you look at it, so a run fetched 34 h ago has two hours of
//      hourly claim left. The question that matters on a trail is not "am I offline", it is
//      "does my forecast still reach my finish", and `coversFinish` is that comparison made
//      honestly against `Journey.endHour` rather than asserted.
//
// TWO CLOCKS THAT ARE ACTUALLY ONE AXIS. Everything here is in HOURS FROM THE PROVIDER'S NOW,
// the same axis `Journey` already uses, and `nowHour` is simply where the walker stands on
// it. The provider's `now()` is the ORIGIN of that axis, not a claim about what time it is on
// the screen: the page already renders a journey departing 11:00 tomorrow (`departHour` 27)
// without anything pretending the reader is there. Planning puts the walker at `nowHour` 0,
// which is what the page has always done and is why the planning state is byte-for-byte the
// screen it was before this file existed; walking puts them partway along their own journey.
// One axis, one set of comparisons, and no wrapper provider with a second `now()` that would
// have had to be kept in step with the first.
//
// WHAT THE PROVIDER IS NEVER ASKED TO DO. Serve a negative hour. `WeatherProvider.fetch`
// returns hours 0..n-1 and `src/scope/**` is read-only from here, so a walking state built by
// pushing the DEPARTURE into the past (departHour < 0) would have had every already-walked
// waypoint silently answered by hour 0's sample — the same weather at 06:30 as at now.
// Anchoring the walk inside the provider's own forward window instead means every waypoint,
// walked and unwalked, carries the forecast that genuinely belongs to its hour.

import { journeyClock, type Journey, type Waypoint } from './journey';
import type { WeatherProvider } from '../scope/types';

/**
 * How far into the walk the walking anchor stands, hours.
 *
 * A page constant with the same standing as `route.ts`'s `DEPART_CLOCK`, and picked the same
 * way: measured across candidates, then justified, rather than rounded to something that looks
 * tidy. At 1.8 h on Flattop the walker stands 4.6 km up a 6.5 km climb at 3,555 m — ABOVE the
 * Front Range treeline, having crossed it seventeen minutes ago — with the high point, the
 * turnaround, the descent back through the trees and the whole convective afternoon still in
 * front of them. That is the moment the page is about, and it is also the moment its no-risk
 * rule (TRAIL_PLAN §1) is under the most pressure, which is a reason to render it rather than
 * a reason to pick a gentler one.
 *
 * IT HAS TO CLEAR THE MARKERS. The position mark is the same 30 px box a marker dot is, and at
 * this trail's fitted camera the map runs about 18 m per pixel, so a position landing within a
 * few hundred metres of a marker covers it. Measured across candidates: 1.4 h lands 296 m from
 * the treeline crossing (~16 px, a collision), 1.5 h lands 42 m from it (on top of it), and
 * 1.8 h lands 704 m past it, which is ~39 px of clear air. This is the same class of
 * measurement `MERGE_RADIUS_M` records, taken for a mark that is not part of the marker set
 * and so is not covered by any merge radius.
 *
 * IT ALSO HAS TO SURVIVE THE TRAVERSAL CONTROL, which is what fixes the upper bound. One way
 * is a 2 h 30 m walk on this trail; any elapsed figure past that would put the walker beyond
 * their own finish the moment the page's one live control was touched, which is TRAIL_PLAN
 * §10's recorded bug class (state going stale against a re-render) reintroduced by a constant
 * rather than by code. 1.8 h leaves a real 42 m remaining on the one-way walk and 2 h 33 m on
 * the out-and-back, and lands at the SAME PLACE in both, because both share the outbound leg:
 * the position is a fact about how long you have been walking, not about how far you intend to
 * go, so the mark does not move when the walk's far end does.
 */
export const ONROUTE_ELAPSED_H = 1.8;

/**
 * Where the walker stands, and what their cached run can still be quoted for.
 *
 * Built from a `Journey` rather than folded into it, for the reason `journey.ts` is a
 * separate module from its three renderings: the journey is the walk, and this is the pair of
 * facts (a present, a cached run) that the walk is READ THROUGH. The map, the profile chart
 * and the table all take the same object, so they cannot disagree about where now is — the
 * same argument, one layer up, that stopped them disagreeing about when you reach treeline.
 */
export interface OnRoute {
  journey: Journey;
  /** True when the walk is under way. False is the planning anchor, unchanged from before. */
  started: boolean;
  /** The walker's present, in hours from the provider's now. 0 while planning. */
  nowHour: number;
  /** Hours since the cached run was fetched. 0 is live: online, current run. */
  ageHours: number;
  /** When the run was fetched, on the same axis. `nowHour - ageHours`, so negative for
   *  anything fetched before the provider's own origin. */
  fetchedHour: number;
  /**
   * The last hour this run may be quoted hour by hour: `fetchedHour + horizonHours`.
   *
   * The single number the whole cached state turns on, and the reason nothing here reads
   * `36`. A provider with a longer horizon moves it for free, exactly as `SCOPE_PLAN.md` §4
   * requires of every other surface that draws the wall.
   */
  reachHour: number;
  /** True when the run still reaches the end of the walk. The question the state exists to
   *  answer, asked of `Journey.endHour` rather than of a rounded hour count. */
  coversFinish: boolean;
  /** True when no part of the walk is inside the run's hourly reach at all. Distinct from
   *  `!coversFinish`, which is the ordinary case of the wall landing mid-walk. */
  coversNothing: boolean;
  /** The waypoint nearest the walker, for any reading that wants a real sample. */
  at: Waypoint;
  /** Metres walked, interpolated between the bracketing waypoints rather than snapped to
   *  one, so the position marker sits where the clock says and not up to a leg early. */
  atTravelM: number;
  /** Position along the trail geometry, 0..1, interpolated the same way. */
  atFrac: number;
  /** Minutes still to walk. Zero while planning is deliberately NOT the case: planning's
   *  `nowHour` is 0, so this is the whole walk, which is what the planning screen means. */
  remainingMinutes: number;
  /** Metres still to walk, on the same basis. */
  remainingM: number;
  /** Minutes at or above treeline STILL TO COME. TRAIL_PLAN §8 lists this as a correctness
   *  bug the moment the screen has a now: exposed time remaining and exposed time total are
   *  different numbers, and a started screen that prints the total is answering a question
   *  nobody asked. */
  remainingExposedMinutes: number;
  /** Highest storm probability still to come, 0..1. */
  remainingPeakThunder: number;
  /** Strongest gust still to come, km/h. */
  remainingPeakGustKph: number;
  /** Coldest and warmest still to come. */
  remainingTempRangeC: [number, number];
  /**
   * The coarsest honest reading of the stretch past the run's reach: one temperature, one
   * gust, one storm probability for the whole of it, or `null` when nothing is past the
   * reach.
   *
   * `SCOPE_PLAN.md` §4's rule, applied here rather than reinvented: degrading means LESS
   * CERTAINTY, NOT LESS CONTENT. Past the reach the page may not quote an hour, so it quotes
   * the stretch — and it quotes the SAME three figures on every waypoint in it, which is what
   * a reader sees when the table stops changing row to row. That repetition is the honest
   * picture of the claim's granularity, not a rendering fault.
   */
  outlook: { tempC: number; gustKph: number; thunderProb: number; groundWetMm: number } | null;
  /** Metres walked at which the run's hourly reach runs out, or `null` when the run covers
   *  the whole of what is left. Where the chart draws its wall. */
  outlookFromTravelM: number | null;
}

export interface OnRouteOptions {
  started: boolean;
  /** Hours into the walk. Only read when `started`. */
  elapsedH: number;
  /** Hours since the cached run was fetched. 0 is live. */
  ageHours: number;
}

/** The walked-distance/geometry position at an arbitrary hour, interpolated between the two
 *  waypoints that bracket it. Clamped at both ends so an hour before the departure reads as
 *  the trailhead and an hour past the finish reads as the finish, rather than extrapolating a
 *  walk that did not happen. */
function positionAtHour(j: Journey, hour: number): { at: Waypoint; travelM: number; frac: number } {
  const wps = j.waypoints;
  if (hour <= wps[0].hour) return { at: wps[0], travelM: wps[0].travelM, frac: wps[0].frac };
  const last = wps[wps.length - 1];
  if (hour >= last.hour) return { at: last, travelM: last.travelM, frac: last.frac };
  let k = 1;
  while (k < wps.length - 1 && wps[k].hour < hour) k++;
  const a = wps[k - 1];
  const b = wps[k];
  const span = b.hour - a.hour;
  // A seam leg has no elapsed time (journey.ts freezes travelM and hour across it), so a
  // zero span is a real possibility on a multi-part trail rather than a defensive nicety.
  const t = span > 1e-9 ? (hour - a.hour) / span : 0;
  return {
    at: Math.abs(hour - a.hour) <= Math.abs(b.hour - hour) ? a : b,
    travelM: a.travelM + (b.travelM - a.travelM) * t,
    frac: a.frac + (b.frac - a.frac) * t,
  };
}

export function buildOnRoute(j: Journey, provider: WeatherProvider, opts: OnRouteOptions): OnRoute {
  // Planning stands at the provider's own origin, which is what the page has always done and
  // is why the planning render is unchanged by this file existing.
  const nowHour = opts.started ? j.departHour + opts.elapsedH : 0;
  const ageHours = Math.max(0, opts.ageHours);
  const fetchedHour = nowHour - ageHours;
  const reachHour = fetchedHour + provider.horizonHours;

  const { at, travelM, frac } = positionAtHour(j, nowHour);

  // "Remaining" is measured from the walker, and while planning the walker is at the
  // trailhead by construction, so these come out as the whole-walk figures the frames
  // already printed. One code path, two anchors, per §1.
  const ahead = j.waypoints.filter((w) => w.hour >= nowHour);
  const rest = ahead.length > 0 ? ahead : [j.waypoints[j.waypoints.length - 1]];

  let remainingExposedMinutes = 0;
  for (let k = 1; k < rest.length; k++) {
    if (rest[k - 1].exposed || rest[k].exposed) remainingExposedMinutes += (rest[k].hour - rest[k - 1].hour) * 60;
  }

  let peakThunder = 0;
  let peakGust = 0;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const w of rest) {
    peakThunder = Math.max(peakThunder, w.sample.thunderProb);
    peakGust = Math.max(peakGust, w.sample.gustKph);
    tMin = Math.min(tMin, w.sample.tempC);
    tMax = Math.max(tMax, w.sample.tempC);
  }

  // The outlook stretch: what is left AND past the reach. Both conditions, because a walked
  // hour past nobody's horizon is not a claim the screen is making.
  const past = rest.filter((w) => w.hour > reachHour);
  const outlook =
    past.length > 0
      ? {
          // Mean temperature, peak gust, peak storm. The mean for the one figure a reader
          // treats as a level and the peak for the two they treat as a ceiling, which is the
          // same split `grade.ts` already makes when it collapses a window into a verdict.
          tempC: past.reduce((s, w) => s + w.sample.tempC, 0) / past.length,
          gustKph: Math.max(...past.map((w) => w.sample.gustKph)),
          thunderProb: Math.max(...past.map((w) => w.sample.thunderProb)),
          // Ground goes with air, because it is DERIVED from the same forecast (journey.ts's
          // per-waypoint decay over antecedent rain plus rain that has fallen), so a stretch
          // whose air may not be quoted hour by hour cannot have its underfoot state quoted
          // hour by hour either. Mean, like the temperature, since the word it feeds is a
          // band and not a ceiling.
          groundWetMm: past.reduce((s, w) => s + w.groundWetMm, 0) / past.length,
        }
      : null;

  const endHour = j.waypoints[j.waypoints.length - 1].hour;
  const coversNothing = reachHour <= Math.max(nowHour, j.departHour);

  return {
    journey: j,
    started: opts.started,
    nowHour,
    ageHours,
    fetchedHour,
    reachHour,
    coversFinish: reachHour >= endHour,
    coversNothing,
    at,
    atTravelM: travelM,
    atFrac: frac,
    remainingMinutes: Math.max(0, (endHour - nowHour) * 60),
    remainingM: Math.max(0, j.totalM - travelM),
    remainingExposedMinutes,
    remainingPeakThunder: peakThunder,
    remainingPeakGustKph: peakGust,
    remainingTempRangeC: [tMin, tMax],
    outlook,
    // NO WALL WHERE THERE IS NO BOUNDARY. When the run's reach falls before the walk even
    // starts, every step of it is outlook and a rule drawn at the trailhead would be marking
    // a crossing that does not happen inside the frame — the reader would read it as "the
    // first metre is fine". The strip's own sentence carries that case instead, and every
    // band, dot and row is already neutral, which says it more completely than a mark could.
    outlookFromTravelM: past.length > 0 && !coversNothing ? positionAtHour(j, reachHour).travelM : null,
  };
}

/** Behind the walker: an hour already spent. Always false while planning, because a planning
 *  screen has nothing behind it. */
export function isPassed(o: OnRoute, hour: number): boolean {
  return o.started && hour < o.nowHour;
}

/** Past the cached run's hourly reach, so nothing route-specific and nothing hour-specific
 *  may be claimed for it. True on a live provider too, once the walk runs past a fresh run's
 *  own horizon: this is the same wall the discovery day bar draws, met from the other end. */
export function isOutlook(o: OnRoute, hour: number): boolean {
  return hour > o.reachHour;
}

/**
 * The one sentence the cached state exists to say, and the one most at risk of becoming a
 * warning.
 *
 * TRAIL_PLAN.md §1's hard constraint is that this screen states conditions and marks factual
 * events and does not name a hazard, recommend a departure or name a turnaround — and a stale
 * forecast on a mountain is precisely the situation that tempts all three. So this states two
 * clock times and the word the rest of the app already uses for the coarser claim, and stops.
 * No imperative, no adjective, no exclamation, nothing about consequences. The reader knows
 * what it means to finish a walk on an area outlook better than this page does.
 *
 * The vocabulary is not new either: "hourly" and "outlook" are the two words the discovery
 * page's own day bar prints under every day button, and "area outlook" is `SCOPE_PLAN.md`
 * §4's own phrasing of the degraded claim ("past it I can only tell you about this area on
 * this day"). One vocabulary across both pages, so a reader who has seen the wall on the day
 * bar meets the same words when it lands inside their walk.
 *
 * Returns `null` on a live run, where there is nothing to report: a current run reaching past
 * the end of a day walk is the ordinary case and printing a line about it would turn the
 * absence of a problem into furniture.
 */
export function reachSentence(o: OnRoute, provider: WeatherProvider): string | null {
  if (o.ageHours <= 0) return null;
  const finish = journeyClock(provider, o.journey.endHour);
  const reach = journeyClock(provider, o.reachHour);
  if (o.coversNothing) {
    return o.started
      ? 'Hourly has run out. Area outlook from here.'
      : 'Hourly runs out before you leave. Outlook throughout.';
  }
  // COVERED SAYS NOTHING. A cached run that reaches past the finish costs the reader
  // exactly nothing, and the line printed three clock times to report an absence: the reach,
  // the finish, and the word "past" doing the work of a comparison the reader then had to
  // redo. Björn's call, and it is the right one — this block exists to say what being
  // offline COSTS, so when it costs nothing the honest output is silence. The chip above
  // still states the data's age, which is the fact that remains true either way.
  if (o.coversFinish) return null;
  return `Hourly to ${reach}, then area outlook to ${finish}.`;
}

/**
 * The connection states the page offers, as hours of age, derived rather than typed.
 *
 * These are DOC CHROME (see `route.ts`'s control rail for the §6 argument), which means they
 * are a prototype lever and are allowed to be chosen for what they demonstrate — the same
 * standing `scope/doc.ts`'s own Connection control has. What they are not allowed to be is
 * invented numbers, so each one is computed from this journey and this provider:
 *
 *   LIVE            0. Online, reading the current run.
 *   AT THE TRAILHEAD The walk's own elapsed time, rounded up to a whole hour so the chip
 *                    reads in the same whole hours the discovery page's does. On Flattop that
 *                    puts the fetch in the car park shortly before the 11:00 departure, which
 *                    is where a walker's last bar of signal actually is. Its reach still
 *                    clears the finish by most of a day, so this state shows the MECHANISM
 *                    (an age, a shrinking reach) with no consequence attached.
 *   THE RUN THAT     The whole-hour age whose reach lands on the last named marker before the
 *   RUNS OUT         finish. That is the case worth drawing and it is not reachable by
 *                    accident: with a +36 h horizon and a 4 h 21 m walk, the run has to be
 *                    more than 31 h old before it can fail to cover the finish at all, which
 *                    is itself the finding (see TRAIL_PLAN §14). Deriving it from a marker
 *                    rather than picking 34 keeps it honest and keeps it pointed at something
 *                    a reader can see on the screen.
 *
 * FROZEN AT BOOT BY THE CALLER, on purpose. How old a device's cached run is has nothing to
 * do with which way the reader walks the trail, so these are computed once from the default
 * traversal and never recomputed. That is also what makes the strongest demonstration on the
 * page possible: the SAME 34 h run does not reach the out-and-back's 15:21 finish and does
 * reach the one-way's 13:30 one, so the page's one live control flips the answer without
 * anything about the device changing.
 */
export function cacheAgeHours(j: Journey, provider: WeatherProvider, nowHour: number): {
  atTrailhead: number;
  runsOut: number;
} {
  const finishTravel = j.markers[j.markers.length - 1]?.travelM ?? j.totalM;
  const before = j.markers.filter((m) => m.travelM < finishTravel);
  const lastNamed = before.length > 0 ? before[before.length - 1] : j.markers[0];
  return {
    atTrailhead: Math.max(1, Math.ceil(nowHour - j.departHour)),
    runsOut: Math.max(1, Math.round(provider.horizonHours + nowHour - lastNamed.hour)),
  };
}
