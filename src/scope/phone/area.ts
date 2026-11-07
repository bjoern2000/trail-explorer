// Trail Scope phone — the area conditions strip.
//
// WHAT IT IS FOR, AND WHY IT DOES NOT UNDERCUT THE PAGE. A regional readout at one reference
// elevation IS the SnowCast model: conditions at a place, point-based. This page argues that
// route-specific beats point-based (SCOPE_PLAN §1), so putting exactly that readout directly
// above a list of route-specific ones is not a concession, it is the demonstration. The
// numbers disagree with the cards below them, visibly, with no explanatory copy — which is
// the only way to make the argument inside the phone frame at all (SCOPE_PLAN §10 keeps
// method commentary out of it).
//
// Everything that keeps it unmistakably ABOUT THE AREA rather than about a route:
//
//   it names the place, from the region's `assumedLocationLabel`;
//   it states the elevation its numbers are for, because an ambient temperature with no
//     elevation is simply wrong for a 3,700 m summit, and naming the valley reference is what
//     sets up the contrast with every card;
//   it carries no condition pill, no level word and no level colour, so nothing on it can be
//     read as a verdict, and it cannot be mistaken for a card.
//
// THE POINT IT ASKS ABOUT is the region's assumed location at `REGION_REF_ELEV_M` — the
// populated valley floor the label names (Estes Park, Lake Placid, the lake shore). That
// elevation comes from the simulated provider's own region table rather than from the
// `WeatherProvider` interface, which has no notion of a reference elevation because a real
// gridded provider answers about points it is handed. What we print is therefore the
// elevation we ASKED about, which is honest under any provider; when a real one lands, this
// is the one call site that decides what "the area" means, and it should keep meaning "where
// the reader is", not "where the trails are".
//
// One fetch per scenario and region covers every day the scrubber offers, cached exactly as
// the grade cache is (see grading.ts), so a day change, a units flip or a keystroke in the
// search field re-renders without asking the provider anything.

import { h } from '../../ui/dom';
import { conditionsRow, frameFor, pointReading, type ConditionsReading } from './conditions';
import { SCRUB_DAYS } from './grading';
import { formatPercent } from '../model';
import { REGION_REF_ELEV_M } from '../weather/simulated';
import { clockLabel, hoursForDay } from '../weather/provider';
import { dayName } from './list';
import type { Ctx } from './ctx';
import type { RegionId, ScenarioId, WeatherProvider, WeatherResult } from '../types';

const cache = new Map<string, WeatherResult>();
const key = (scenario: ScenarioId, region: RegionId): string => `${scenario}|${region}`;

/** Cached area weather, or null before the provider call lands. Synchronous by design. */
export function areaWeatherOf(scenario: ScenarioId, region: RegionId): WeatherResult | null {
  return cache.get(key(scenario, region)) ?? null;
}

/**
 * Fill the cache for one scenario and region. Resolves once, and re-resolves from the cache
 * afterwards, so a caller may await it on every render without a second request.
 *
 * The series length is `hoursForDay(SCRUB_DAYS, …)`, the same derivation the route fetch uses
 * (grading.ts's `MAX_DAY`), so the strip can answer for every day the day bar offers and
 * widening the scrubber widens this by construction.
 */
export async function ensureAreaWeather(
  provider: WeatherProvider,
  scenario: ScenarioId,
  region: RegionId,
  assumedLocation: [number, number],
): Promise<void> {
  const k = key(scenario, region);
  if (cache.has(k)) return;
  const elevM = REGION_REF_ELEV_M[region];
  const res = await provider.fetch({
    points: [{ lngLat: assumedLocation, elevM, alongM: 0 }],
    hours: hoursForDay(SCRUB_DAYS, provider),
  });
  cache.set(k, res);
}

/**
 * The strip, two lines: what and where, then the numbers.
 *
 * It sits directly under the day bar and above the count and sort row, and the placement is
 * the argument as much as the content is. The day bar owns the date dimension (SCOPE_PLAN
 * §11), so the strip never repeats the day; it answers "what is the day like here" for
 * whichever day the bar has selected, and then the list under it answers "and what does that
 * mean for each of these routes".
 *
 * THE LABEL LINE'S THIRD SEGMENT is the only thing that changes across the horizon, and it
 * uses the vocabulary already on the page rather than a new one: the day bar labels days
 * HOURLY or OUTLOOK, and the map legend's note reads "Faded: regional outlook, not hour by
 * hour". Past the horizon this line says NOT HOUR BY HOUR and the row drops its storm
 * probability, which is the same refusal `grade.ts` makes out there.
 */
export function areaStrip(ctx: Ctx): HTMLElement {
  const { provider, region } = ctx;
  const day = ctx.state.day;
  const frame = frameFor(provider, day);
  const weather = areaWeatherOf(ctx.state.scenario, region.id);
  const reading = weather ? pointReading(weather, provider, day, REGION_REF_ELEV_M[region.id]) : null;

  // The place is the region's assumed location and stays that way even when the reader has
  // chosen a place in search. PhoneState carries a place LABEL and no coordinates (types.ts,
  // and that contract is frozen), so a chosen place is a scope for the results rather than a
  // point we can ask the provider about. Printing its name over numbers sampled somewhere
  // else would be the one dishonest thing this strip could do: a readout has to name the
  // point it is for.
  const place = region.assumedLocationLabel;
  const qualifier = frame === 'now' ? 'now' : frame === 'daytime' ? 'daytime' : 'not hour by hour';

  const lead =
    frame === 'now'
      ? `Area conditions now near ${place}`
      : `Area conditions for ${dayName(ctx, day)} near ${place}, ${
          frame === 'daytime' ? 'daytime' : 'regional outlook, not hour by hour'
        }`;

  return h(
    'div',
    { class: 'area-strip' },
    h(
      'div',
      { class: 'as-label' },
      h('span', { class: 'as-scope' }, 'Area'),
      h('span', { class: 'as-dot' }, '·'),
      h('span', { class: 'as-place' }, place),
      h('span', { class: 'as-dot' }, '·'),
      h('span', { class: `as-frame${frame === 'outlook' ? ' is-outlook' : ''}` }, qualifier),
    ),
    conditionsRow(reading, ctx.units, { lead }),
    trajectoryNote(ctx, reading),
  );
}

/**
 * Where today is going, printed only when it disagrees with where today is.
 *
 * The strip's `now` frame reads the current hour, and on an afternoon-convection day that
 * hour is 08:00 and says 0% storms. True, and the most misleading thing the strip could
 * say: the reader is deciding whether to set off into a day whose character arrives at
 * 15:00. So when the rest of the day peaks materially above the current hour, the peak and
 * its hour go on the line underneath.
 *
 * Returns an empty node rather than null on the other frames, because `daytime` and
 * `outlook` already describe a whole window: their printed numbers ARE the peak, and
 * repeating it as a trajectory would state one fact twice, which is the stutter this
 * codebase has de-duplicated three times now (the verdict's level word, the peek's repeated
 * hour, the weather-on-route no-window clause).
 *
 * The threshold is a display decision, not a model one: below it the two numbers round to
 * the same story and the second clause is noise.
 */
const TRAJECTORY_MIN_DELTA = 0.15;

function trajectoryNote(ctx: Ctx, reading: ConditionsReading | null): HTMLElement {
  const empty = h('span', { class: 'as-traj', hidden: true });
  if (!reading || reading.frame !== 'now') return empty;
  const now = reading.thunderProb;
  const peak = reading.peakThunderProb;
  if (now === null || reading.peakThunderHour === undefined) return empty;
  if (peak - now < TRAJECTORY_MIN_DELTA) return empty;
  return h(
    'div',
    { class: 'as-traj' },
    `Rising to ${formatPercent(peak)} storms by ${clockLabel(ctx.provider, reading.peakThunderHour)}`,
  );
}
