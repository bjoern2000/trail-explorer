// Trail Scope — the four simulated scenarios.
//
// A scenario describes REGIONAL weather over the whole day scrubber at one reference
// elevation (see SCENARIO_FIELD_DAYS), plus a lapse rate, an orographic term and a diurnal
// convection profile. It describes no trail
// and knows no trail id. Per-point variation comes out of real elevation, so a ridge
// point genuinely runs colder, windier and stormier than a valley point in the same
// scenario, and within-region spread is driven by terrain rather than hand authoring.
// That is the property that makes the scenario switcher an honest control: it swaps the
// meteorology and the terrain maths underneath is untouched.
//
// All four run through one evaluator (`regionalHour` then `sampleAt`) and differ only in
// numbers. If a scenario needed its own code path it would be a different product, not a
// different day.
//
// They are chosen to dramatise four different failure modes, because the page hangs on
// the list visibly reranking:
//   bluebird   nothing binds, so the ranking falls through to effort and distance
//   storms     convection times the day and elevation decides who gets caught
//   post-rain  antecedent water, and drainage decides: surface and steepness, not height
//   heat       temperature times sun load times how long you are out in it
// storms and post-rain deliberately produce close to opposite orderings.
//
// Determinism: the only noise is a seeded hash of quantized position and hour. Same
// scenario plus same trail always gives the same grade.

import { hashUnit } from './provider';
import type { ScenarioDef, ScenarioId, WeatherSample } from '../types';

/**
 * Default reference elevation the scenario numbers are quoted at, metres: a generic
 * mountain mid-slope. A provider may override it per region, and should, because one
 * absolute reference cannot serve a 250 m region and a 3,850 m one at the same lapse rate:
 * the scenario is a description of a regional air mass, not of a continent. See
 * REGION_REF_ELEV_M in simulated.ts.
 */
const REF_ELEV_M = 2000;

/**
 * How many days of regional field a scenario is authored to describe, counting day 0.
 *
 * The evaluator is analytic rather than tabulated, so it will answer for any hour and no
 * request can run off the end of an array. What it cannot do honestly is extrapolate a
 * per-day trend forever: `tempTrendCPerDay` and friends are a two or three day drift, not a
 * climate. So the trend index is clamped here, and everything past this point repeats the
 * last authored day rather than drifting into a scenario nobody wrote.
 *
 * This must cover the whole day scrubber. With SCRUB_DAYS = 7 the reader can select day 6,
 * whose grading looks ahead into day 7 off the same fetch, so the field has to be
 * meaningful out to day 7 and the request reaches into day 8. Seven days of authored trend
 * plus the clamp covers that, and a longer scrubber only ever flattens the trend rather
 * than breaking.
 *
 * Raising this from 6 to 7 alongside the wider scrubber is a pure extension: `trendDay` is
 * `min(dayIndex, SCENARIO_FIELD_DAYS)`, so every day up to and including 6 evaluates exactly
 * as it did before, and only the lookahead day past the last visible one stops being a copy
 * of its neighbour.
 */
export const SCENARIO_FIELD_DAYS = 7;

export interface ScenarioParams {
  /** Elevation the regional numbers below describe. */
  refElevM: number;

  // ---- temperature ---------------------------------------------------------
  /** Diurnal min and max at refElevM, day 0. */
  tempMinC: number;
  tempMaxC: number;
  /** Drift per day, so day 1 is not a copy of day 0. */
  tempTrendCPerDay: number;
  /** Dry lapse, °C per 1000 m of ascent. */
  lapseCPerKm: number;
  /**
   * Cap on the warming applied BELOW the reference. With a region-relative reference almost
   * nothing sits far below it, so this is a guard rather than a load-bearing number: the
   * simulation is a demonstration field, not a sounding, and should not extrapolate a dry
   * lapse a kilometre downhill.
   */
  warmingCapC: number;

  // ---- cloud ---------------------------------------------------------------
  cloudNight: number;
  cloudAfternoon: number;
  cloudTrendPerDay: number;

  // ---- convection ----------------------------------------------------------
  convection: {
    /** Hour of day the cells start, peak and die. */
    startHour: number;
    peakHour: number;
    endHour: number;
    /** Peak thunderstorm probability at refElevM. */
    peakProbAtRef: number;
    /** Added probability per 1000 m above refElevM. The mountain term. */
    probPerKmAbove: number;
    /** Convective rain rate at the peak, mm per hour at refElevM. */
    peakRainMmPerH: number;
    /** Day over day change in convective potential. */
    trendPerDay: number;
  };

  // ---- wind ----------------------------------------------------------------
  windBaseKph: number;
  windPerKm: number;
  windAfternoonBoost: number;
  gustFactor: number;

  // ---- antecedent water ----------------------------------------------------
  /** Prior 72 h precipitation at refElevM, mm. Drives the wetness term. */
  antecedentMmAtRef: number;
  antecedentPerKm: number;

  /** Amplitude of the seeded per-point noise, as a fraction. Keeps points from being clones. */
  jitter: number;
}

export interface Scenario extends ScenarioDef {
  params: ScenarioParams;
}

/** Regional state for one hour, at the reference elevation. */
export interface RegionalHour {
  absHour: number;
  hourOfDay: number;
  dayIndex: number;
  tempC: number;
  cloud: number;
  /** 0..1 triangular convection envelope. Elevation is applied on top, in sampleAt. */
  convShape: number;
  windKph: number;
}

// ============================================================================
// THE FOUR
// ============================================================================

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  bluebird: {
    id: 'bluebird',
    label: 'Bluebird',
    blurb:
      'The control: nothing binds anywhere, so almost everything reads prime and the ranking falls through to effort and distance.',
    params: {
      refElevM: REF_ELEV_M,
      tempMinC: 6,
      tempMaxC: 22,
      tempTrendCPerDay: 0.4,
      lapseCPerKm: 6.5,
      warmingCapC: 6,
      cloudNight: 0.04,
      cloudAfternoon: 0.16,
      cloudTrendPerDay: 0.02,
      convection: {
        startHour: 12,
        peakHour: 15.5,
        endHour: 19,
        peakProbAtRef: 0.03,
        probPerKmAbove: 0.05,
        peakRainMmPerH: 0.1,
        trendPerDay: 0.02,
      },
      windBaseKph: 9,
      windPerKm: 5,
      windAfternoonBoost: 4,
      gustFactor: 1.45,
      antecedentMmAtRef: 0,
      antecedentPerKm: 0,
      jitter: 0.05,
    },
  },

  storms: {
    id: 'storms',
    label: 'Afternoon storms',
    blurb:
      'Classic Rockies convection from late morning: watch the above-treeline routes fall to the bottom while the valley loops stay usable.',
    params: {
      refElevM: REF_ELEV_M,
      tempMinC: 10,
      tempMaxC: 22,
      tempTrendCPerDay: -0.3,
      lapseCPerKm: 6.5,
      warmingCapC: 6,
      cloudNight: 0.18,
      cloudAfternoon: 0.82,
      cloudTrendPerDay: -0.04,
      convection: {
        startHour: 10.5,
        peakHour: 15,
        endHour: 20,
        // 35 percent at the valley floor rising to about 90 at 3,850 m: the elevation term
        // is what makes this scenario a terrain story rather than a forecast headline.
        peakProbAtRef: 0.35,
        probPerKmAbove: 0.45,
        peakRainMmPerH: 4.5,
        trendPerDay: -0.06,
      },
      windBaseKph: 15,
      windPerKm: 10,
      windAfternoonBoost: 11,
      gustFactor: 1.85,
      antecedentMmAtRef: 3,
      antecedentPerKm: 2,
      jitter: 0.1,
    },
  },

  'post-rain': {
    id: 'post-rain',
    label: 'After heavy rain',
    blurb:
      'Two days of rain, now clearing: the grades split on drainage, so the flat unsurfaced trails drop below the steep rocky ones.',
    params: {
      refElevM: REF_ELEV_M,
      tempMinC: 9,
      tempMaxC: 20,
      tempTrendCPerDay: 0.9,
      lapseCPerKm: 6,
      warmingCapC: 6,
      cloudNight: 0.72,
      cloudAfternoon: 0.34,
      cloudTrendPerDay: -0.18,
      convection: {
        startHour: 13,
        peakHour: 16,
        endHour: 19,
        peakProbAtRef: 0.05,
        probPerKmAbove: 0.07,
        peakRainMmPerH: 0.3,
        trendPerDay: -0.01,
      },
      windBaseKph: 9,
      windPerKm: 6,
      windAfternoonBoost: 3,
      gustFactor: 1.5,
      antecedentMmAtRef: 34,
      antecedentPerKm: 5,
      jitter: 0.06,
    },
  },

  heat: {
    id: 'heat',
    label: 'Heat',
    blurb:
      'A heat dome with no cloud: temperature does the ranking, so long low routes suffer and climbing genuinely helps, the opposite of the storms answer.',
    params: {
      refElevM: REF_ELEV_M,
      // A hot night as well as a hot day: in a real heat event the overnight minimum is
      // what stops an early start from solving the problem on its own.
      tempMinC: 21,
      tempMaxC: 33,
      tempTrendCPerDay: 0.8,
      // A normal well-mixed lapse, which means altitude genuinely buys relief. That is the
      // real advice on a hot day and it is the exact inverse of the storms answer, which is
      // why these two scenarios rerank the list against each other instead of agreeing.
      // Height is still no free pass: the effort and sun-load terms in grade.ts punish the
      // long high-gain routes that get you up there.
      lapseCPerKm: 6.5,
      warmingCapC: 6,
      cloudNight: 0.03,
      cloudAfternoon: 0.1,
      cloudTrendPerDay: 0.01,
      convection: {
        startHour: 14,
        peakHour: 17,
        endHour: 20,
        peakProbAtRef: 0.06,
        probPerKmAbove: 0.09,
        peakRainMmPerH: 0.2,
        trendPerDay: 0.03,
      },
      windBaseKph: 6,
      windPerKm: 4,
      windAfternoonBoost: 2,
      gustFactor: 1.35,
      antecedentMmAtRef: 0,
      antecedentPerKm: 0,
      jitter: 0.05,
    },
  },
};

export const SCENARIO_LIST: Scenario[] = [
  SCENARIOS.bluebird,
  SCENARIOS.storms,
  SCENARIOS['post-rain'],
  SCENARIOS.heat,
];

/** Scenario definitions for the doc chrome, without the meteorology params. */
export function scenarioDefs(): ScenarioDef[] {
  return SCENARIO_LIST.map((s) => ({ id: s.id, label: s.label, blurb: s.blurb }));
}

// ============================================================================
// EVALUATION
// ============================================================================

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Diurnal 0..1, minimum at 03:00 and maximum at 15:00. */
function diurnal(hourOfDay: number): number {
  const phase = (((hourOfDay - 3) % 24) + 24) % 24;
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * phase) / 24);
}

/** Triangular convection envelope, 0..1 across the afternoon. */
function convectionShape(hourOfDay: number, c: ScenarioParams['convection']): number {
  if (hourOfDay <= c.startHour || hourOfDay >= c.endHour) return 0;
  if (hourOfDay <= c.peakHour) return (hourOfDay - c.startHour) / (c.peakHour - c.startHour);
  return (c.endHour - hourOfDay) / (c.endHour - c.peakHour);
}

/** Regional state at the reference elevation for an absolute hour from day 0, hour 0. */
export function regionalHour(p: ScenarioParams, absHour: number): RegionalHour {
  const dayIndex = Math.floor(absHour / 24);
  const hourOfDay = absHour - dayIndex * 24;
  const d = diurnal(hourOfDay);

  // Trends stop drifting at the end of the authored field. See SCENARIO_FIELD_DAYS.
  const trendDay = Math.min(dayIndex, SCENARIO_FIELD_DAYS);

  const min = p.tempMinC + p.tempTrendCPerDay * trendDay;
  const max = p.tempMaxC + p.tempTrendCPerDay * trendDay;

  return {
    absHour,
    hourOfDay,
    dayIndex,
    tempC: min + (max - min) * d,
    cloud: clamp(
      p.cloudNight + (p.cloudAfternoon - p.cloudNight) * d + p.cloudTrendPerDay * trendDay,
      0,
      1,
    ),
    convShape:
      convectionShape(hourOfDay, p.convection) *
      clamp(1 + p.convection.trendPerDay * trendDay, 0, 1.4),
    windKph: p.windBaseKph + p.windAfternoonBoost * d,
  };
}

/**
 * One point, one hour: apply real elevation to the regional field, then a seeded jitter.
 * This is where a ridge stops being a valley. Temperature falls with the lapse rate,
 * convection gains the mountain term, precipitation gains an orographic term, wind grows
 * with height, and antecedent water is slightly higher up high.
 */
export function sampleAt(
  p: ScenarioParams,
  absHour: number,
  elevM: number,
  lngLat: [number, number],
  refElevM: number = p.refElevM,
): WeatherSample {
  const base = regionalHour(p, absHour);
  const dz = (elevM - refElevM) / 1000;
  const above = Math.max(0, dz);

  // Seeded, position and hour dependent, in [-1, 1].
  const n = (hashUnit(lngLat[0], lngLat[1], absHour) - 0.5) * 2;
  const jit = 1 + n * p.jitter;

  // Temperature: lapse up, capped warming down.
  const lapseDelta = -p.lapseCPerKm * dz;
  const tempC = base.tempC + (dz < 0 ? Math.min(lapseDelta, p.warmingCapC) : lapseDelta) + n * 0.6;

  const thunderProb = clamp(
    base.convShape * (p.convection.peakProbAtRef + p.convection.probPerKmAbove * above) * jit,
    0,
    0.95,
  );

  const precipMm = clamp(
    base.convShape * p.convection.peakRainMmPerH * (1 + 0.35 * above) * jit,
    0,
    30,
  );

  const windKph = clamp((base.windKph + p.windPerKm * dz) * jit, 3, 130);

  return {
    hour: absHour,
    tempC,
    precipMm,
    // Precipitation probability tracks the convective envelope, floored a little above
    // the thunder probability because rain without lightning is the common case.
    precipProb: clamp(Math.max(thunderProb * 1.35, base.convShape * 0.2), 0, 0.97),
    thunderProb,
    windKph,
    gustKph: clamp(windKph * p.gustFactor * (1 + 0.18 * base.convShape), 4, 190),
    cloudPct: clamp(base.cloud + 0.04 * above + n * 0.03, 0, 1),
  };
}

/** Prior 72 h precipitation at a point, mm. */
export function antecedentAt(
  p: ScenarioParams,
  elevM: number,
  lngLat: [number, number],
  refElevM: number = p.refElevM,
): number {
  const above = Math.max(0, (elevM - refElevM) / 1000);
  const n = (hashUnit(lngLat[0], lngLat[1], 999) - 0.5) * 2;
  return Math.max(0, (p.antecedentMmAtRef + p.antecedentPerKm * above) * (1 + n * p.jitter));
}
