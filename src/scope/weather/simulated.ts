// Trail Scope — the simulated WeatherProvider.
//
// This is the throwaway half of the weather stack, and it is meant to look like it. It
// answers exactly the questions a `WeatherProvider` is asked, from a scenario definition
// plus the real elevation of each requested point, and it does nothing else. Everything
// interesting on the page (the terrain maths, the grade, the reranking, the horizon
// behaviour) lives outside this file and survives its deletion.
//
// Three properties matter:
//   - deterministic. No Math.random anywhere. Seeded hash of quantized position and hour,
//     so switching scenario and switching back cannot reshuffle the list.
//   - a fixed clock. `now()` is a constant, not the reader's wall clock, so the whole page
//     shares one "now", a screenshot taken at 03:00 shows the same story as one taken at
//     noon, and the day scrubber's horizon behaviour is reproducible in a deck.
//   - an honest horizon. 36 hours, because that is what Super Resolution gives, even
//     though a simulation could trivially produce a fortnight. Faking a longer horizon
//     would delete the single most useful finding the page carries for TWC.
//
// Sunrise and sunset are real solar geometry from the point's latitude and a fixed
// simulated date, not scenario numbers, because that part we can simply compute.

import { antecedentAt, sampleAt, SCENARIOS } from './scenarios';
import { hashUnit } from './provider';
import type { Scenario } from './scenarios';
import type {
  RegionId,
  ScenarioId,
  WeatherProvider,
  WeatherQuery,
  WeatherResult,
  WeatherSample,
} from '../types';

/**
 * Elevation each seeded region's scenario numbers are quoted at, metres. Roughly the
 * region's own populated valley floor: Estes Park, Keene Valley, the lake shore.
 *
 * This exists because a scenario describes a regional AIR MASS (SCOPE_PLAN §4), and one
 * absolute reference cannot serve three regions spanning 250 m to 3,850 m at a real lapse
 * rate: a 6.5 °C/km lapse over that range is 23 °C of spread, so either the mountains come
 * out arctic or the lowlands come out lethal. Anchoring per region keeps every scenario
 * plausible in every region, and the per-point variation stays exactly what it was: real
 * elevation measured against the reference. It is legitimate for a provider to know where
 * it is being asked about; a real gridded field knows that by construction.
 */
export const REGION_REF_ELEV_M: Record<RegionId, number> = {
  rmnp: 2600,
  adk: 700,
  ozarks: 260,
};

/**
 * The fixed provider clock: day 0, 08:00.
 *
 * A summer Saturday morning. Chosen because it is the moment the product is actually for
 * (a whole day still ahead, the decision not yet made), because 08:00 sits before the
 * convective window so the storms scenario has somewhere to go, and because from here
 * both today and tomorrow fall inside +36 h while the day after does not, which is
 * exactly the boundary the day scrubber needs to demonstrate. The weekday anchor lives in
 * provider.ts (`weekdayLabel`).
 */
export const SIM_NOW = { dayIndex: 0, hourOfDay: 8 } as const;

/**
 * Simulated date, as a day of year: 11 July. Mid-summer, inside the window the RMNP and
 * Adirondack benchmark snapshots were taken in, and long enough after the solstice that
 * the daylight numbers are not the annual maximum.
 */
export const SIM_DAY_OF_YEAR = 192;

/** Local solar noon, hours. A stand-in for a real timezone plus longitude correction. */
const SOLAR_NOON_HOUR = 13;

/**
 * Nominal grid resolution, metres. A STAND-IN: the simulation has no grid at all, it
 * evaluates continuously at whatever point it is handed, so this number exists only for
 * the honesty line on the page. 1000 m is the downscaled target Super Resolution is aimed
 * at; raw HRRR is 3000 m. When the real provider lands, this must report what the field
 * actually is, not what we would like it to be.
 */
const SIM_RESOLUTION_M = 1000;

/** Sunrise and sunset as hour of day, from latitude and day of year. */
export function sunTimesHourOfDay(latDeg: number, dayOfYear: number): {
  sunrise: number;
  sunset: number;
} {
  const rad = Math.PI / 180;
  const decl = 23.44 * Math.sin(2 * Math.PI * ((284 + dayOfYear) / 365));
  const cosOmega = -Math.tan(latDeg * rad) * Math.tan(decl * rad);
  // Polar day and polar night, so the maths does not produce NaN north of the circle.
  if (cosOmega <= -1) return { sunrise: 0, sunset: 24 };
  if (cosOmega >= 1) return { sunrise: SOLAR_NOON_HOUR, sunset: SOLAR_NOON_HOUR };
  const omega = Math.acos(cosOmega) / rad;
  const halfDay = omega / 15;
  return { sunrise: SOLAR_NOON_HOUR - halfDay, sunset: SOLAR_NOON_HOUR + halfDay };
}

export class SimulatedProvider implements WeatherProvider {
  readonly id: string;
  readonly label: string;
  /** Super Resolution's real horizon, deliberately not the simulation's capability. */
  readonly horizonHours = 36;
  readonly resolutionM = SIM_RESOLUTION_M;
  readonly scenario: Scenario;
  /** Elevation this instance's regional numbers are quoted at. */
  readonly refElevM: number;

  constructor(scenario: ScenarioId | Scenario = 'storms', region?: RegionId) {
    this.scenario = typeof scenario === 'string' ? SCENARIOS[scenario] : scenario;
    this.refElevM = region ? REGION_REF_ELEV_M[region] : this.scenario.params.refElevM;
    this.id = region ? `simulated:${this.scenario.id}:${region}` : `simulated:${this.scenario.id}`;
    this.label = `simulated · ${this.scenario.label.toLowerCase()}`;
  }

  now(): { dayIndex: number; hourOfDay: number } {
    return { dayIndex: SIM_NOW.dayIndex, hourOfDay: SIM_NOW.hourOfDay };
  }

  async fetch(query: WeatherQuery): Promise<WeatherResult> {
    const p = this.scenario.params;
    // THE SERIES LENGTH IS THE CALLER'S, and deliberately has no ceiling of its own. The
    // scenario field is analytic (see SCENARIO_FIELD_DAYS), so it answers for any hour, and
    // `hoursForDay` derives the request from the furthest day the scrubber offers. Widening
    // the scrubber from five days to seven therefore lengthens this series on its own, and
    // it lengthens it by APPENDING: hour h is a function of the absolute hour alone, so
    // every hour that existed before a widening evaluates to exactly what it did before.
    // Nothing here may become stateful or random, or that property is lost.
    const hours = Math.max(1, Math.ceil(query.hours));

    const series: WeatherSample[][] = [];
    const antecedentPrecipMm: number[] = [];
    const daylight: { sunriseHour: number; sunsetHour: number }[] = [];

    for (const point of query.points) {
      const own: WeatherSample[] = [];
      for (let h = 0; h < hours; h++) {
        // Absolute scenario hour, so hour 0 of a request is the provider's now.
        const abs = SIM_NOW.dayIndex * 24 + SIM_NOW.hourOfDay + h;
        const s = sampleAt(p, abs, point.elevM, point.lngLat, this.refElevM);
        // `hour` is hours-from-now, per the contract, not the scenario's own clock.
        own.push({ ...s, hour: h });
      }
      series.push(own);
      antecedentPrecipMm.push(antecedentAt(p, point.elevM, point.lngLat, this.refElevM));

      // Day 0's sunrise/sunset in hours-from-now: negative when already past, which is
      // the case here because now is 08:00 and sunrise is not.
      const sun = sunTimesHourOfDay(point.lngLat[1], SIM_DAY_OF_YEAR);
      daylight.push({
        sunriseHour: sun.sunrise - SIM_NOW.hourOfDay,
        sunsetHour: sun.sunset - SIM_NOW.hourOfDay,
      });
    }

    return { series, antecedentPrecipMm, daylight };
  }
}

/**
 * One provider per scenario and region, memoised so the page shares instances and one clock.
 * Pass the region: without it the scenario falls back to its generic reference elevation,
 * which is only right for a mid-altitude mountain region.
 */
const cache = new Map<string, SimulatedProvider>();

export function simulatedProvider(scenario: ScenarioId, region?: RegionId): SimulatedProvider {
  const key = `${scenario}|${region ?? '-'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const made = new SimulatedProvider(scenario, region);
  cache.set(key, made);
  return made;
}

/**
 * Re-exported so a caller that wants to seed something else off the same determinism
 * (a stable ordering tiebreak, say) uses the provider's hash and not its own.
 */
export { hashUnit };
