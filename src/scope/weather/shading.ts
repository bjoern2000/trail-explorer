// Trail Scope — terrain self-shading: the hour-dependent half of sun exposure.
//
// scope/canopy.mjs precomputes the half that never changes. Slope and aspect are facts
// about the ground: the compass bearing a hillside faces does not depend on the day, so it
// is derived offline from the DEM and committed in `ScopeTrail.aspectDeg` / `slopeDeg`.
// This file supplies the other half, which does depend on the day and the hour: where the
// sun is, and whether the slope is turned towards it or away from it.
//
// NOTHING HERE IS WIRED INTO THE UI OR INTO THE GRADE. It is the runtime function the
// offline data is shaped for, deliberately left unconsumed. `terrainFacts.shadedShare`
// still computes exactly what it always did (`1 - exposedShare`, "below treeline means
// trees"), because changing it reranks the list and that is a decision, not a refactor.
//
// ============================================================================
// THE LIMIT. READ THIS BEFORE PUTTING A NUMBER FROM THIS FILE ON A SCREEN.
// ============================================================================
//
// This computes SELF-SHADING and only self-shading: whether the piece of ground a walker
// is standing on is tilted away from the sun. It does NOT compute cast shadows from
// neighbouring terrain.
//
// The failure case is not exotic, it is the flagship one. A valley floor lying in the
// shadow of a 4,000 m ridge at 08:00 reads as fully sunlit here, because its own ground is
// flat and pointed at the sky. In RMNP, where the whole product story is about ridges and
// the valleys between them, that is precisely the terrain the answer is wrong on. The word
// on any label built from this has to be "self-shading" or "slope aspect", never "shade"
// and never "in shadow".
//
// What the missing half would cost, stated so the trade is a decision rather than a gap.
// Cast shadows need a horizon test: from each sample point, march the DEM along the sun's
// azimuth and check whether any cell ahead subtends a greater angle than the sun's
// altitude. At terrarium z13 the cells are about 14 m, so a 20 km ray is roughly 1,400
// steps; at 48 samples per trail and 427 trails that is about 29 million cell reads per
// hour of the day, and the shadow field changes every hour, so it multiplies by the
// horizon. It is tractable offline — the tiles are already cached, and precomputing a
// horizon-angle profile per sample (36 azimuth bins, once, then interpolate to any sun
// position) collapses the per-hour cost to a lookup. That is a day of work and a bigger
// derived file, not a research problem. It is not attempted here because the honest
// version of this feature is the one that says which half it has.
//
// ============================================================================
//
// No solar constant is duplicated in this file. Local solar noon arrives as a parameter,
// and `sunPositionFromDaylight` derives it from the sunrise and sunset the provider itself
// reported, so this works unchanged against `SimulatedProvider` and against a real one
// without either knowing about the other.

import type { ScopeTrail } from '../types';

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** One-line caveat for any UI that ever exposes a number from this file. */
export const SELF_SHADE_CAVEAT =
  'slope self-shading only: this does not include shadows cast by neighbouring terrain';

export interface SunPosition {
  /** Degrees above the horizon. Negative means the sun is down. */
  altitudeDeg: number;
  /** Compass bearing of the sun, degrees clockwise from north. */
  azimuthDeg: number;
}

/**
 * Solar declination in degrees, Cooper's approximation.
 *
 * Character-for-character the same series `sunTimesHourOfDay` in simulated.ts uses for its
 * sunrise and sunset, and that is the point: two different declinations in one codebase
 * would let the sun rise at one angle and shine from another. It is repeated rather than
 * imported because simulated.ts is the throwaway half of the weather stack and says so in
 * its own header; this file has to survive its deletion.
 */
export function solarDeclinationDeg(dayOfYear: number): number {
  return 23.44 * Math.sin(2 * Math.PI * ((284 + dayOfYear) / 365));
}

/**
 * Where the sun is, for a latitude, a day and an hour.
 *
 * `solarNoonHour` is the hour the sun crosses the meridian, on the same clock as
 * `hourOfDay`. It is a parameter rather than a constant because the two callers measure
 * time differently: the page's clock is hours-from-now and a real forecast's is local
 * time, and a constant here would silently be right for exactly one of them.
 *
 * Azimuth is degrees clockwise from north, matching `ScopeTrail.aspectDeg`, and is
 * resolved through the hour angle's sign rather than through `acos` alone, because `acos`
 * returns the same value for the morning and the afternoon.
 */
export function sunPosition(
  latDeg: number,
  dayOfYear: number,
  hourOfDay: number,
  solarNoonHour: number,
): SunPosition {
  const phi = latDeg * DEG;
  const delta = solarDeclinationDeg(dayOfYear) * DEG;
  // Hour angle: 15 degrees per hour, zero at solar noon, negative before it.
  const H = (hourOfDay - solarNoonHour) * 15 * DEG;

  const sinAlt = clamp(Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(H), -1, 1);
  const altitude = Math.asin(sinAlt);

  const cosAlt = Math.cos(altitude);
  // Degenerate only at the zenith, where azimuth genuinely has no meaning; north is as
  // good an answer as any and the incidence test below does not depend on it there.
  if (Math.abs(cosAlt) < 1e-9 || Math.abs(Math.cos(phi)) < 1e-9) {
    return { altitudeDeg: altitude / DEG, azimuthDeg: 0 };
  }
  const cosAz = clamp((Math.sin(delta) - sinAlt * Math.sin(phi)) / (cosAlt * Math.cos(phi)), -1, 1);
  const az = Math.acos(cosAz) / DEG;
  return { altitudeDeg: altitude / DEG, azimuthDeg: H > 0 ? 360 - az : az };
}

/**
 * `sunPosition`, with solar noon taken as the midpoint of the sunrise and sunset the
 * provider reported for this point.
 *
 * That midpoint IS solar noon by construction for any symmetric day-length model, which
 * both the simulation and real solar geometry are, so this needs no constant of its own
 * and no import from the provider it is reading. `hourOfDay` and the two daylight hours
 * must share a clock; `WeatherResult.daylight` is in hours-from-now, so pass the grader's
 * hours-from-now.
 *
 * Polar day and polar night are the one case where the midpoint is not solar noon (the
 * model clamps to 0 and 24, whose midpoint is 12). Irrelevant at CONUS latitudes and
 * flagged rather than handled, because a real +36 h HRRR-domain provider cannot produce it.
 */
export function sunPositionFromDaylight(
  latDeg: number,
  dayOfYear: number,
  hourOfDay: number,
  daylight: { sunriseHour: number; sunsetHour: number },
): SunPosition {
  return sunPosition(latDeg, dayOfYear, hourOfDay, (daylight.sunriseHour + daylight.sunsetHour) / 2);
}

/**
 * `night`   the sun is below the horizon. Darkness, not shading, and the distinction
 *           matters: a heat term should read this as no sun load, a daylight term should
 *           read it as no daylight, and one boolean cannot serve both.
 * `flat`    the ground is flatter than the DEM resolves a direction for (`aspectDeg` is
 *           -1). Self-shading is undefined; the slope is not turned anywhere.
 * `self-shaded` the sun is up and behind the slope.
 * `sunlit`  the sun is up and on this side of the slope. NOT the same as "in the sun":
 *           see the limit at the top of this file.
 */
export type SelfShadeState = 'night' | 'flat' | 'self-shaded' | 'sunlit';

export interface SelfShade {
  state: SelfShadeState;
  /**
   * Cosine of the angle between the sun and the slope normal, -1..1. This is the standard
   * illumination term, so it is returned rather than only the boolean: 0.02 and 0.98 are
   * both "sunlit" and are not the same amount of sun on your neck.
   */
  incidenceCos: number;
}

/**
 * Whether one piece of ground is turned towards the sun.
 *
 * The standard illumination geometry:
 *   cos(i) = cos(slope)·sin(alt) + sin(slope)·cos(alt)·cos(azimuth − aspect)
 * with `aspect` the downslope bearing, so `azimuth − aspect` is zero when the sun is
 * directly downslope, which is the fully-lit case for a tilted surface.
 */
export function selfShadeAt(aspectDeg: number, slopeDeg: number, sun: SunPosition): SelfShade {
  if (sun.altitudeDeg <= 0) return { state: 'night', incidenceCos: 0 };
  if (aspectDeg < 0) {
    // Flat ground: incidence collapses to the sun's own altitude, which is the right
    // number to hand back even though the state is not a shading judgement.
    return { state: 'flat', incidenceCos: Math.sin(sun.altitudeDeg * DEG) };
  }
  const slope = slopeDeg * DEG;
  const alt = sun.altitudeDeg * DEG;
  const rel = (sun.azimuthDeg - aspectDeg) * DEG;
  const cosI = Math.cos(slope) * Math.sin(alt) + Math.sin(slope) * Math.cos(alt) * Math.cos(rel);
  return { state: cosI <= 0 ? 'self-shaded' : 'sunlit', incidenceCos: cosI };
}

/**
 * Share of a trail's samples whose own slope is turned away from the sun, 0..1, or null
 * when the snapshot carries no aspect.
 *
 * Deliberately NOT called `shadedShare`. It is not a substitute for it and it is not a
 * substitute for canopy: this is one of the three things that put a walker in the shade
 * (slope aspect), the trail's `canopy` array is the second (trees), and the third (a ridge
 * between you and the sun) is not computed anywhere in this codebase. A product claim
 * about shade needs all three; this function is one term.
 *
 * `latDeg` is taken as the trail's centroid latitude by the caller rather than per sample,
 * because the sun's position varies by far less across a 15 km trail than the ground does,
 * and a per-sample sun would imply a precision the +36 h field does not have.
 */
export function selfShadedShare(
  trail: ScopeTrail,
  latDeg: number,
  dayOfYear: number,
  hourOfDay: number,
  solarNoonHour: number,
): number | null {
  if (trail.aspectDeg.length === 0 || trail.aspectDeg.length !== trail.slopeDeg.length) return null;
  const sun = sunPosition(latDeg, dayOfYear, hourOfDay, solarNoonHour);
  if (sun.altitudeDeg <= 0) return null; // night: no sun to be shaded from
  let shaded = 0;
  for (let i = 0; i < trail.aspectDeg.length; i++) {
    if (selfShadeAt(trail.aspectDeg[i], trail.slopeDeg[i], sun).state === 'self-shaded') shaded++;
  }
  return shaded / trail.aspectDeg.length;
}
