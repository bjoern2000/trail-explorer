// Trail Scope — the weather seam.
//
// Everything downstream of this file (grade.ts, the sort, the phone UI) talks to a
// `WeatherProvider` and never to a scenario. That is the entire point of the split:
// `SimulatedProvider` fakes the meteorology today, a `SuperResProvider` supplies the
// real thing later, and swapping them changes the weather and nothing else. The grader
// asks for hourly samples at named points on the route at their real elevations, then
// combines them with terrain facts it computes itself from our own derived data.
//
// This file holds three things and no logic of its own beyond helpers:
//   1. a re-export of the frozen contract in ../types, so importers have one door
//   2. the TODO(superres) block: exactly what a real implementation must supply
//   3. the shared helpers a provider call needs, chiefly route sampling
//
// Route sampling is not decoration. Five points spaced along the route at their real
// elevations is what makes the grade route-specific. One point at the trailhead would
// be the SnowCast model (conditions at a place) and would lose the argument the page is
// making (conditions along a route): a ridge point has to come out colder, windier and
// stormier than a valley point in the same scenario, and it only can if we ask about it.
//
// Two contract clarifications that `types.ts` leaves open, fixed here so the simulated
// and the real provider cannot disagree:
//   - `WeatherResult.daylight` is *the requested day 0's* sunrise/sunset expressed in
//     hours-from-now, so a sunrise already past reads negative. The grader shifts by
//     24 h per day offset rather than asking again.
//   - a provider MAY return samples past `horizonHours` (from a coarser model). The
//     grader never makes an hourly claim past the horizon regardless: it drops to
//     `confidence: 'outlook'`. Returning a short series is equally valid; the grader
//     handles a series that does not reach the requested day.

import { haversineMeters } from '../../data/merge';
import type {
  RoutePoint,
  ScopeTrail,
  WeatherProvider,
  WeatherQuery,
  WeatherResult,
  WeatherSample,
} from '../types';

export type { RoutePoint, WeatherProvider, WeatherQuery, WeatherResult, WeatherSample };

// ============================================================================
// TODO(superres) — what a real implementation must supply
// ============================================================================
//
// A `SuperResProvider implements WeatherProvider` is the only file that should need
// writing when TWC Super Resolution access lands. Nothing else in src/scope/ may learn
// that it exists. Concretely:
//
// 1. FIELD MAPPING. Every field of `WeatherSample` is SI and per point, per hour.
//    Map them to Super Resolution variables, and where a variable does not exist say so
//    in code rather than inventing one:
//      tempC       ← 2 m temperature, downscaled to the point's terrain height. This is
//                    the deliverable-1 variable: the whole reason for Super Resolution
//                    over raw HRRR is that the 2 m field is corrected to real terrain,
//                    so a ridge sample must not be a valley sample with a lapse applied.
//      precipMm    ← total precipitation accumulated in that hour, mm.
//      precipProb  ← probability of measurable precipitation in that hour, 0..1. If the
//                    system emits deterministic precipitation only, derive this from the
//                    ensemble/neighbourhood spread and note it, or leave it equal to a
//                    thresholded indicator and document the loss of nuance.
//      thunderProb ← convective/lightning probability, 0..1. This is the single most
//                    load-bearing field on the page: the storms scenario, the exposure
//                    factor and the "above treeline after 12:00" headline all hang off
//                    it. If Super Resolution has no lightning field, a CAPE-plus-
//                    precipitation proxy is acceptable but must be labelled as a proxy
//                    in the page copy, not silently substituted.
//      windKph     ← 10 m sustained wind. gustKph ← 10 m gust. Terrain-aware channelling
//                    and ridge acceleration are the second half of deliverable 1; if the
//                    downscaled wind is not ready, return the coarse HRRR wind and drop
//                    `resolutionM` to the honest 3000 so the page stops claiming it.
//      cloudPct    ← total cloud cover 0..1, used only for the shade/heat term.
//    `antecedentPrecipMm` is the prior 72 h total per point and is the warm-season trail
//    wetness input. The science response has a working prototype for exactly this, so
//    prefer the real product over a rain-gauge sum once it exists.
//    `daylight` is sunrise/sunset per point in hours-from-now (see the note above);
//    latitude and date are enough, it does not need the forecast system at all.
//
// 2. HORIZON: +36 h. Set `horizonHours = 36`. Hourly, four runs a day. Do NOT pad the
//    series to a week from a global model and let it pass as route-specific: the grader
//    decides confidence purely from `horizonHours`, so an inflated horizon silently
//    turns a coarse outlook into a route-specific claim. If a coarser long-range model
//    is blended in past +36 h, return it as extra samples and leave the horizon at 36;
//    the grader will degrade the copy on its own.
//
// 3. CADENCE: four runs a day means `now()` should snap to the most recent completed
//    run, not to the wall clock, and hour 0 is that run's valid hour. Cache per run and
//    key on the run timestamp, or the same trail will grade differently between two
//    requests seconds apart and the list will visibly reshuffle for no reason.
//
// 4. DOMAIN: HRRR, so CONUS only. Add a domain test to the provider and reject points
//    outside it rather than returning extrapolated numbers. Two of the three seeded
//    regions are inside HRRR and all three are CONUS, but the search resolves the whole
//    of `src/data/places.ts` (50 states, 329 NPS units), so out-of-domain requests are
//    reachable by a reader in Alaska, Hawaii or Puerto Rico on day one.
//
// 5. WHAT THE UI DOES WHEN A REQUEST FALLS OUTSIDE. Two different failures, two states:
//      Outside the horizon  → not an error. `gradeTrail` already returns
//        `confidence: 'outlook'`: no hourly claim, no terrain factors, a vaguer
//        headline, `bestWindow: null`. The day scrubber reads `provider.horizonHours`
//        and marks those days as outlook. Nothing to add.
//      Outside the domain   → an error, and it must read as one. Reject the fetch with
//        a typed error carrying the offending points; the results list shows the trails
//        with their terrain measures and an explicit "no forecast coverage here" state
//        on the condition pill, and the conditions filters and the Best-today sort
//        disable themselves. Never show a grey pill that looks like a grade.
//    A partial failure (some points in domain) must be treated as out of domain for the
//    whole route. A route graded from its trailhead only is precisely the thing this
//    page exists to argue against.
//
// 6. WEEKDAY COPY. `now()` deliberately returns provider-relative integers and no date,
//    so `dayDate()` below anchors day 0 to the reader's real today and everything else
//    (weekday names, the dates on the day bar) derives from it. A real provider knows the
//    actual run time: re-point `dayDate` at it (or widen the contract to carry a date), or
//    the copy will drift by a day whenever a run straddles local midnight.

// ============================================================================
// ROUTE SAMPLING
// ============================================================================

/** Points requested per route. Five is the argument; one would be SnowCast. */
export const ROUTE_SAMPLE_POINTS = 5;

/** Line parts, kept separate so no sample lands in the gap between two parts. */
function partsOf(geometry: GeoJSON.LineString | GeoJSON.MultiLineString): number[][][] {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  return geometry.coordinates;
}

/**
 * Elevation at a fraction along the route, read from the trail's own downsampled
 * profile so the grader and the card sparkline can never disagree. Falls back to a
 * straight min-to-max ramp only when a trail carries no profile at all.
 */
export function profileElevAt(trail: ScopeTrail, frac: number): number {
  const p = trail.profile;
  const f = Math.min(1, Math.max(0, frac));
  if (!p || p.length === 0) return trail.minElevM + (trail.maxElevM - trail.minElevM) * f;
  if (p.length === 1) return p[0];
  const x = f * (p.length - 1);
  const i = Math.min(p.length - 2, Math.floor(x));
  return p[i] + (p[i + 1] - p[i]) * (x - i);
}

/**
 * Five points spaced by real along-route distance, at their real elevations.
 * Index 0 is the trailhead and index 4 the far end, so `alongM` is meaningful and the
 * grader can talk about where on the route a factor bites.
 */
export function routeSamplePoints(trail: ScopeTrail, count = ROUTE_SAMPLE_POINTS): RoutePoint[] {
  const parts = partsOf(trail.geometry).filter((c) => c.length >= 2);
  const n = Math.max(2, count);

  if (parts.length === 0) {
    // Degenerate geometry: one point at the recorded trailhead, honestly flagged by
    // having a single entry rather than five identical ones.
    return [{ lngLat: trail.start, elevM: profileElevAt(trail, 0), alongM: 0 }];
  }

  // Per-part cumulative distance. Distance runs within parts only; the offset between
  // parts is the sum of prior real part lengths, never a bridge across the gap.
  const cums = parts.map((coords) => {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineMeters(coords[i - 1], coords[i]));
    return cum;
  });
  const lens = cums.map((c) => c[c.length - 1]);
  const total = lens.reduce((a, b) => a + b, 0);

  const out: RoutePoint[] = [];
  for (let k = 0; k < n; k++) {
    const frac = k / (n - 1);
    const target = total * frac;

    // Which part, and how far into it.
    let pi = 0;
    let offset = 0;
    while (pi < parts.length - 1 && offset + lens[pi] < target) {
      offset += lens[pi];
      pi++;
    }
    const within = target - offset;
    const coords = parts[pi];
    const cum = cums[pi];
    let seg = 0;
    while (seg < cum.length - 2 && cum[seg + 1] < within) seg++;
    const a = coords[seg];
    const b = coords[seg + 1];
    const span = cum[seg + 1] - cum[seg];
    const t = span > 0 ? (within - cum[seg]) / span : 0;

    out.push({
      lngLat: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      elevM: profileElevAt(trail, frac),
      alongM: target,
    });
  }
  return out;
}

// ============================================================================
// REQUEST SHAPING
// ============================================================================

/**
 * Hours a grader needs to cover `dayOffset`, including the whole of that day plus a
 * one hour tail. Asked in one call so the UI fetches once per trail per scenario and
 * grades every day off the same result.
 *
 * The `+ 25` is what guarantees coverage rather than approximating it: the last hour the
 * grader can ask about on `dayOffset` is that day's sunset, which is at most hour 24 of the
 * day, and the day begins `dayOffset * 24 - hourOfDay` hours from now. So the request always
 * reaches at least one hour past the last graded hour, for any clock and any latitude, and
 * nothing can run off the end of the series. The scenario field itself is analytic and
 * defined for any hour (see SCENARIO_FIELD_DAYS in scenarios.ts), so the only real limit is
 * this request length, and the caller sets it from the furthest day the scrubber offers.
 */
export function hoursForDay(dayOffset: number, provider: WeatherProvider): number {
  const { hourOfDay } = provider.now();
  return Math.ceil(dayOffset * 24 - hourOfDay + 25);
}

export function weatherQueryForDay(
  trail: ScopeTrail,
  dayOffset: number,
  provider: WeatherProvider,
): WeatherQuery {
  return { points: routeSamplePoints(trail), hours: Math.max(25, hoursForDay(dayOffset, provider)) };
}

/** Convenience: sample the route and fetch enough hours to grade out to `maxDayOffset`. */
export function fetchRouteWeather(
  provider: WeatherProvider,
  trail: ScopeTrail,
  maxDayOffset: number,
): Promise<WeatherResult> {
  return provider.fetch(weatherQueryForDay(trail, maxDayOffset, provider));
}

// ============================================================================
// CLOCK LABELS
// ============================================================================

/** "15:00" for an hours-from-now offset, on the provider's clock. Hour resolution. */
export function clockLabel(provider: WeatherProvider, hoursFromNow: number): string {
  const { hourOfDay } = provider.now();
  const abs = Math.round(hourOfDay + hoursFromNow);
  const h = ((abs % 24) + 24) % 24;
  return `${String(h).padStart(2, '0')}:00`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The calendar date a provider day index falls on.
 *
 * Day 0 used to be a hard-coded Saturday, on the reasoning that a summer Saturday morning
 * is when someone plans a day out. It reads as arbitrary the moment a reader sees the day
 * bar next to their own calendar: "Today / Tomorrow / Monday" on an actual Thursday is a
 * puzzle rather than a forecast. Day 0 is now the reader's real today, so the weekday name
 * and the printed date always agree, and both agree with the device clock.
 *
 * The simulated provider's `now().dayIndex` is 0 and its `hourOfDay` is a fixed morning
 * hour, so the SIMULATED WEATHER is still deterministic: only the labels move with the
 * calendar. A real provider knows its own run time (TODO(superres) item 3), and this is the
 * one place to re-point when it does.
 */
export function dayDate(dayIndex: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // midday, so a DST shift cannot roll the date over
  d.setDate(d.getDate() + Math.round(dayIndex));
  return d;
}

/** "Saturday" for a provider day index, anchored to the reader's real today. */
export function weekdayLabel(dayIndex: number): string {
  return WEEKDAYS[dayDate(dayIndex).getDay()];
}

/** "Aug 4" for a provider day index. The date half of a day bar button. */
export function dateLabel(dayIndex: number): string {
  return dayDate(dayIndex).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ============================================================================
// SHARED DETERMINISM
// ============================================================================

/**
 * Seeded 32 bit hash to 0..1. Every provider must be deterministic: the same scenario
 * plus the same trail must always give the same grade, or the reader switches scenarios,
 * switches back, and watches the list change for no reason. Never Math.random().
 */
export function hashUnit(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    // Quantize so tiny float wobble in a coordinate cannot flip the hash.
    let v = Math.round(p * 1000) | 0;
    for (let i = 0; i < 4; i++) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      v >>>= 8;
    }
  }
  return ((h >>> 0) % 100000) / 100000;
}
