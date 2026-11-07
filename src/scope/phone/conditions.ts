// Trail Scope phone — the conditions readout, and the field contract two surfaces share.
//
// ONE CONTRACT, TWO POINTS. This module renders the same five fields in the same order with
// the same formatting in two places that must be directly comparable:
//
//   the area strip, above the list, at the region's valley reference elevation. One point at
//     a place, which IS the SnowCast model (SCOPE_PLAN §1): conditions where the town is.
//   the card row, on every result, at the highest point the route's own forecast samples
//     reach. One point again, but the route's point, at its real elevation.
//
// The contrast between those two readouts is the page's entire argument, and it only lands
// if the reader can compare them WITHOUT being told to. So the fields, their order, their
// wording and their formatters live here and nowhere else. A second, differently-worded
// readout on either surface would turn a visible disagreement into two unrelated numbers,
// which is exactly the failure the frame rule (SCOPE_PLAN §10) stops us fixing with
// explanatory copy inside the phone.
//
// THE ELEVATION IS A FIELD, not a caption. It is the one field that makes the comparison
// self-explanatory: "14 °C at 2,600 m" beside "3 °C at 4,346 m" needs no sentence to say
// that a valley reference cannot answer for a summit. Dropping it to save characters would
// leave two temperatures that simply look wrong next to each other.
//
// THREE FRAMES, because "current" exists for exactly one day:
//
//   now      day 0. The provider's own clock hour, so these are current conditions.
//   daytime  a later day inside the horizon. That day's daylight extremes, because there is
//            no "now" on a day that has not happened and printing one hour of it would read
//            as one.
//   outlook  past `provider.horizonHours`. Day-scale numbers only, no storm probability, and
//            on the card no row at all (see `routeReading`).
//
// WHAT IS DELIBERATELY NOT HERE. No level, no grade word, no tint, no verdict. The pill two
// rows up on the card owns the judgement; this row owns the measurements. No risk wording
// either: a storm probability is a number about the weather, and the day it becomes a
// warning is the day the reader stops trusting the other four fields.

import { h } from '../../ui/dom';
import { PRECIP_FLOOR_MM, icon, weatherGlyph } from './ui';
import { formatElevation, formatPercent, formatPrecip, formatSpeed, formatTemp } from '../model';
import { profileElevAt } from '../weather/provider';
import { firstOutlookDay } from './grading';
import type { Units } from '../../types';
import type { ScopeTrail, WeatherProvider, WeatherResult, WeatherSample } from '../types';

/** Which of the three statements a readout is making. See the header. */
export type ReadoutFrame = 'now' | 'daytime' | 'outlook';

/**
 * One point, one timeframe, five fields. Everything here comes off a `WeatherProvider`
 * series; nothing is typed in.
 */
export interface ConditionsReading {
  frame: ReadoutFrame;
  /** Elevation the numbers are for, metres. A field, not a caption. See the header. */
  elevM: number;
  /** The hour's temperature on `now`, the window's high otherwise. */
  tempC: number;
  windKph: number;
  gustKph: number;
  /**
   * Null on `outlook`, and that is the horizon degrading rather than a missing value: past
   * +36 h the grader itself computes a regional thunder peak and refuses to print a number
   * for it (grade.ts, `outlookGrade`), because a probability implies a resolution a coarse
   * call does not have. This readout follows the same rule so the two cannot disagree.
   */
  thunderProb: number | null;
  /** Printed rainfall: the hour's fall on `now`, the window's total otherwise. */
  precipMm: number;
  /**
   * Glyph inputs, never printed: the wettest single hour in the window and the window's
   * thunder peak.
   *
   * Two reasons they are separate fields rather than the printed ones. The glyph precedence
   * tests `precipMm > 0` on an HOURLY sample (see `weatherGlyph`), and a window total would
   * clear that test on any day with one wet hour in it, so a mostly-clear day would draw a
   * rain cloud. And on `outlook` the printed thunder probability is withheld while the glyph
   * still has to be able to draw a storm: refusing a NUMBER out there is the honest limit,
   * refusing the silhouette as well would make a stormy Friday and a settled one identical,
   * which is the same mistake the pill was fixed for (ui.ts, `conditionPill`).
   */
  peakPrecipMm: number;
  peakThunderProb: number;
  /**
   * Hour of `peakThunderProb`, provider-relative, and only on the `now` frame.
   *
   * The other frames already describe a whole window, so an hour inside one adds nothing.
   * `now` is the frame that needs it: a morning reading has to be able to say WHEN the
   * afternoon it is warning about arrives, or the peak is a number with no handle on it.
   */
  peakThunderHour?: number;
  cloudPct: number;
}

/**
 * Which frame a day selects. Day 0 is always inside the horizon (the horizon is at least a
 * few hours and the day has already started), so `now` needs no horizon test of its own.
 * Everything else reads `firstOutlookDay`, which reads `provider.horizonHours`: a provider
 * with a longer horizon moves this on its own and nothing here changes.
 */
export function frameFor(provider: WeatherProvider, day: number): ReadoutFrame {
  if (day === 0) return 'now';
  return day >= firstOutlookDay(provider) ? 'outlook' : 'daytime';
}

/**
 * That day's daylight window in hours-from-now.
 *
 * The provider contract returns day 0's sunrise and sunset in hours-from-now, so a later day
 * is one 24 h shift per day offset — the same arithmetic `gradeTrail` does, deliberately, so
 * the row and the grade above it are talking about the same span of hours.
 *
 * `daytime` clamps the far end to the horizon for the same reason `gradeTrail` does: a day
 * can begin inside +36 h and end outside it, and the hours past the wall are not ours to
 * reduce. `outlook` does not clamp, because by then the whole claim is day-scale anyway and
 * clamping would silently summarise a fraction of the day.
 */
function daytimeWindow(
  daylight: { sunriseHour: number; sunsetHour: number } | null,
  provider: WeatherProvider,
  day: number,
  frame: ReadoutFrame,
): { from: number; to: number } {
  const { hourOfDay } = provider.now();
  const sun = daylight ?? { sunriseHour: 6 - hourOfDay, sunsetHour: 20 - hourOfDay };
  const from = sun.sunriseHour + 24 * day;
  const to = sun.sunsetHour + 24 * day;
  return { from, to: frame === 'daytime' ? Math.min(to, provider.horizonHours) : to };
}

/**
 * Reduce one point's hourly series to one reading.
 *
 * The reduction direction per field is the same one `grade.ts`'s `routeHours` uses when it
 * collapses the route: extremes for anything that can bind (temperature high, peak gust,
 * peak thunder), a total for rainfall, a mean for cloud. A mean temperature over a whole day
 * would be a number nobody plans against.
 */
/**
 * How far ahead the `now` frame looks for a peak. A calendar day would need the provider's
 * wall clock, which `now()` deliberately does not expose (it returns relative integers), so
 * this is "the rest of a plausible day out" instead: long enough to reach an afternoon
 * convection peak from a morning reading, short enough that it cannot borrow tomorrow's
 * weather and present it as today's.
 */
const HOURS_LEFT_TODAY = 12;

function readingFrom(
  series: WeatherSample[],
  daylight: { sunriseHour: number; sunsetHour: number } | null,
  provider: WeatherProvider,
  day: number,
  elevM: number,
): ConditionsReading | null {
  if (series.length === 0) return null;
  const frame = frameFor(provider, day);

  if (frame === 'now') {
    // Hour 0 of a request is the provider's now, by contract. Nearest-to-zero rather than
    // an index, so a provider that starts its series elsewhere still answers correctly.
    const at = series.reduce((a, b) => (Math.abs(b.hour) < Math.abs(a.hour) ? b : a));

    // WHERE THE DAY IS GOING, not just where it is. `now` on an afternoon-convection day is
    // an 08:00 hour that reads 0% storms, which is true and useless: the reader is deciding
    // whether to set off into a day whose whole character arrives at 15:00. So the peak
    // fields scan the rest of TODAY rather than echoing the current hour, and the strip
    // prints the peak alongside the current value when the two differ enough to matter.
    // Only forward hours count. A peak that already passed is not something to plan around,
    // and printing this morning's shower as a peak would misdescribe the afternoon.
    const rest = series.filter((sm) => sm.hour >= at.hour && sm.hour <= at.hour + HOURS_LEFT_TODAY);
    let peakThunderProb = at.thunderProb;
    let peakPrecipMm = at.precipMm;
    let peakThunderHour = at.hour;
    for (const sm of rest) {
      if (sm.thunderProb > peakThunderProb) {
        peakThunderProb = sm.thunderProb;
        peakThunderHour = sm.hour;
      }
      if (sm.precipMm > peakPrecipMm) peakPrecipMm = sm.precipMm;
    }

    return {
      frame,
      elevM,
      tempC: at.tempC,
      windKph: at.windKph,
      gustKph: at.gustKph,
      thunderProb: at.thunderProb,
      precipMm: at.precipMm,
      peakPrecipMm,
      peakThunderProb,
      peakThunderHour,
      cloudPct: at.cloudPct,
    };
  }

  const { from, to } = daytimeWindow(daylight, provider, day, frame);
  const win = series.filter((s) => s.hour >= from - 0.5 && s.hour <= to + 0.5);
  // A short series (a real provider is allowed to return one) leaves the day unanswerable.
  // Say nothing rather than reduce over whatever hours happened to arrive.
  if (win.length === 0) return null;

  let tempC = -Infinity;
  let windKph = 0;
  let gustKph = 0;
  let thunderProb = 0;
  let precipMm = 0;
  let peakPrecipMm = 0;
  let cloudSum = 0;
  for (const s of win) {
    if (s.tempC > tempC) tempC = s.tempC;
    if (s.windKph > windKph) windKph = s.windKph;
    if (s.gustKph > gustKph) gustKph = s.gustKph;
    if (s.thunderProb > thunderProb) thunderProb = s.thunderProb;
    if (s.precipMm > peakPrecipMm) peakPrecipMm = s.precipMm;
    precipMm += s.precipMm;
    cloudSum += s.cloudPct;
  }

  return {
    frame,
    elevM,
    tempC,
    windKph,
    gustKph,
    thunderProb: frame === 'outlook' ? null : thunderProb,
    precipMm,
    peakPrecipMm,
    peakThunderProb: thunderProb,
    cloudPct: cloudSum / win.length,
  };
}

/**
 * A reading for one requested point, whatever it is a point of. The area strip hands in its
 * single reference point; nothing else about the two surfaces differs at this level.
 */
export function pointReading(
  weather: WeatherResult,
  provider: WeatherProvider,
  day: number,
  elevM: number,
  index = 0,
): ConditionsReading | null {
  const series = weather.series[index];
  if (!series) return null;
  return readingFrom(series, weather.daylight[index] ?? null, provider, day, elevM);
}

/**
 * The card's reading: the HIGHEST of the route's own forecast sample points.
 *
 * Why the high point rather than a mean or the trailhead. A mean over five points is a place
 * that does not exist and it averages away precisely the terrain signal the page argues for.
 * The trailhead is the SnowCast model, which the strip above the list is already showing. The
 * high point is the part of the route the valley reference cannot answer for, it is a real
 * place on the ground, and it is printed with its own elevation so it can never be read as a
 * claim about the whole route.
 *
 * It is deliberately NOT the same reduction the grade uses. `routeHours` takes the WARMEST
 * point for temperature, because heat is the hazard it is weighing; a readout that printed
 * the warmest of five points would print the valley again and the card would agree with the
 * strip for the wrong reason. The grade is a judgement over the whole route; this is a
 * measurement at a stated place, and the two answer different questions.
 *
 * Elevations come from `profileElevAt` at the same fractions `routeSamplePoints` uses, so
 * this is the sampled point's own elevation and not a second guess at it: reading the profile
 * costs an array lookup where re-deriving the points would walk the geometry, and this runs
 * on every card of a 180-row list on every render.
 */
export function routeReading(
  trail: ScopeTrail,
  weather: WeatherResult,
  provider: WeatherProvider,
  day: number,
): ConditionsReading | null {
  const n = weather.series.length;
  if (n === 0) return null;

  let index = 0;
  let elevM = -Infinity;
  for (let k = 0; k < n; k++) {
    const elev = profileElevAt(trail, n === 1 ? 0 : k / (n - 1));
    if (elev > elevM) {
      elevM = elev;
      index = k;
    }
  }
  return pointReading(weather, provider, day, elevM, index);
}

/**
 * Least relief, in metres, worth printing as two readings instead of one.
 *
 * Below it the route's two ends are the same place as far as a forecast is concerned, and a
 * second row would invent a contrast that is not in the data. 150 m is roughly a degree of
 * lapse-rate temperature difference, which is the point at which the two rows would start to
 * disagree about anything a reader could act on.
 */
export const SPREAD_MIN_RELIEF_M = 150;

/**
 * Both ends of a route's own range: its lowest sampled point and its highest.
 *
 * The card shows ONE reading, at the high point, because a card has room for one and the high
 * point is the part a valley forecast cannot answer for (`routeReading` above says why). The
 * detail sheet has room for two, and the pair is worth more than either alone for two
 * reasons.
 *
 * First, the SPREAD between them is within-route variation, which is the one thing no
 * point-based forecast can produce and the thing this whole prototype argues for. Two readings
 * at two stated elevations make that concrete where a single number cannot.
 *
 * Second, it earns the row its place beside the sheet's factor list. The factors interpret the
 * route as a whole ("60% storms from 13:00"); these measure two named places. Different
 * questions, so printing both is not the stutter it would be if the row simply restated a
 * factor. That distinction is the whole reason this returns a pair rather than reusing
 * `routeReading`.
 *
 * `high` is null on a route with little relief, so the caller shows one row rather than two
 * identical ones. Sample indices and elevations come from `profileElevAt` at the same
 * fractions `routeSamplePoints` uses, exactly as `routeReading` does, so the two functions
 * cannot disagree about where a point is.
 */
export function routeSpread(
  trail: ScopeTrail,
  weather: WeatherResult,
  provider: WeatherProvider,
  day: number,
): { low: ConditionsReading | null; high: ConditionsReading | null } {
  const n = weather.series.length;
  if (n === 0) return { low: null, high: null };

  let loIdx = 0;
  let hiIdx = 0;
  let loElev = Infinity;
  let hiElev = -Infinity;
  for (let k = 0; k < n; k++) {
    const elev = profileElevAt(trail, n === 1 ? 0 : k / (n - 1));
    if (elev < loElev) {
      loElev = elev;
      loIdx = k;
    }
    if (elev > hiElev) {
      hiElev = elev;
      hiIdx = k;
    }
  }

  const low = pointReading(weather, provider, day, loElev, loIdx);
  if (hiElev - loElev < SPREAD_MIN_RELIEF_M) return { low, high: null };
  return { low, high: pointReading(weather, provider, day, hiElev, hiIdx) };
}

// ============================================================================
// THE ROW
// ============================================================================

/**
 * Field wording, and why the visible row is terser than the spoken one.
 *
 * The card's content box is ~342 px and this row has to hold five fields on ONE line at the
 * label type scale, which is about 50 characters. Qualifying every field on a `daytime` or
 * `outlook` row ("high 21 °C at 2,600 m, gusts to 39 km/h, storms to 46%") does not fit, and
 * the two ways out of that are both worse than this one: wrapping to a second line on the
 * card the review already called overloaded, or letting the strip carry the fuller wording
 * and the card the terser one, which breaks the field contract exactly where the reader is
 * comparing.
 *
 * So `high` leads the row and sets the register for all of it, and the aria sentence — which
 * has no character budget — says "up to" on every field it applies to. The visible row is
 * never wrong, it is compressed; the spoken row is complete.
 */
function tempField(r: ConditionsReading, units: Units): string {
  const t = formatTemp(r.tempC, units);
  return r.frame === 'now' ? t : `high ${t}`;
}

/**
 * Wind or gust, one of the two, never both.
 *
 * The gust is the number that decides whether an exposed section is unpleasant, so it wins
 * whenever it is meaningfully above the sustained wind. Below that the two numbers are the
 * same fact and the sustained wind is the plainer one.
 */
function windField(r: ConditionsReading, units: Units, spoken = false): string {
  const gusty = r.gustKph >= r.windKph * 1.25;
  const label = gusty ? 'gusts' : 'wind';
  const value = formatSpeed(gusty ? r.gustKph : r.windKph, units);
  // "up to" only in the spoken form, and only where the number is a window peak. See
  // `tempField` for why the visible row carries one qualifier instead of three.
  return spoken && r.frame !== 'now' ? `${label} up to ${value}` : `${label} ${value}`;
}

export interface ConditionsRowOpts {
  /**
   * Drop the storm field. The card sets this when its own pill already prints a storm
   * percentage; see the call site in list.ts for why the pill wins that number.
   */
  omitStorm?: boolean;
  /** Spoken lead-in. The row reads to a screen reader as one sentence, not five numbers. */
  lead: string;
  class?: string;
}

/**
 * The row: a glyph and up to four fields, in contract order.
 *
 * `role="img"` plus `aria-label` is what makes this one utterance instead of five orphan
 * numbers read in sequence. It is not an image, and that is a deliberate misuse of the role
 * for the one thing it does that nothing else does: it collapses a composite of small text
 * nodes into a single labelled thing. The alternative (a visually hidden sentence plus
 * `aria-hidden` on every visible span) reads the same and costs a second copy of the copy.
 */
export function conditionsRow(
  reading: ConditionsReading | null,
  units: Units,
  opts: ConditionsRowOpts,
): HTMLElement {
  const cls = `cond-row${opts.class ? ` ${opts.class}` : ''}`;

  if (!reading) {
    // One frame at most, while the provider call for this scenario and region lands. Worded
    // as the pill's own pending state is: what the app is doing, not what went wrong.
    const el = h('div', { class: `${cls} is-pending` }, h('span', { class: 'cr-field' }, 'Reading conditions'));
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `${opts.lead}: reading conditions`);
    return el;
  }

  const r = reading;
  const spoken: string[] = [];
  const fields: string[] = [];

  fields.push(`${tempField(r, units)} at ${formatElevation(r.elevM, units)}`);
  spoken.push(
    `${r.frame === 'now' ? '' : 'up to '}${formatTemp(r.tempC, units)} at ${formatElevation(r.elevM, units)}`,
  );

  fields.push(windField(r, units));
  spoken.push(windField(r, units, true));

  if (r.thunderProb !== null && !opts.omitStorm) {
    fields.push(`storms ${formatPercent(r.thunderProb)}`);
    spoken.push(`storm probability ${r.frame === 'now' ? '' : 'up to '}${formatPercent(r.thunderProb)}`);
  }

  // Rain, and only when there is some. `PRECIP_FLOOR_MM` is imported from ui.ts rather than
  // declared here, because the GLYPH rendered at the head of this row has to apply the same
  // floor. When it did not, a trace too small to print still drew a rain cloud, which is how
  // the bluebird control scenario ended up showing rain beside "storms 0%". A dry day prints
  // no rain field at all, which is what a dry day looks like.
  if (r.precipMm >= PRECIP_FLOOR_MM) {
    fields.push(formatPrecip(r.precipMm, units));
    spoken.push(`${formatPrecip(r.precipMm, units)} of rain ${r.frame === 'now' ? 'this hour' : 'across the day'}`);
  }

  const el = h('div', { class: cls });
  el.appendChild(icon(weatherGlyph(r.peakThunderProb, r.peakPrecipMm, r.cloudPct), 14, 'cr-glyph'));
  fields.forEach((text, i) => {
    if (i > 0) el.appendChild(h('span', { class: 'cr-dot' }, '·'));
    el.appendChild(h('span', { class: 'cr-field' }, text));
  });
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${opts.lead}: ${spoken.join(', ')}`);
  return el;
}
