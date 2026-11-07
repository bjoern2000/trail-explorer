// Trail mode — pace, the model that makes distance and time the same axis.
//
// The discovery page's peek already has a TIME axis (the hour strip) and the card
// already has a DISTANCE axis (the elevation profile). Trail mode's whole content is
// the claim that those are one axis, and the only thing that can join them is a pace
// model. So pace is not a preference control here, it is the load-bearing maths: get it
// wrong and every arrival time, every marker, and both concepts are decoration.
//
// TOBLER'S HIKING FUNCTION is the choice, over three alternatives:
//
//   flat km/h            Obviously wrong on this data. Flattop Mountain climbs 790 m in
//                        6.5 km; a uniform 4 km/h puts you on the summit 70 minutes
//                        before you get there, which moves you out of the convection
//                        window entirely. The error is not a rounding error, it changes
//                        the answer.
//   Naismith (1892)      1 h per 5 km plus 1 h per 600 m of ascent. Simple, still widely
//                        used, but it is a whole-route rule rather than a per-segment
//                        one: it cannot say when you cross treeline, only when you
//                        finish. Trail mode needs the intermediate times.
//   Tobler (1993)        Continuous walking speed as a function of slope, so it gives a
//                        speed for every segment of the profile and therefore an arrival
//                        time at every point. It also handles descent honestly, which
//                        matters because half of an out-and-back is downhill and the
//                        return leg is where a flat assumption is most wrong.
//
// Tobler is off-path velocity on a hiker's own terms and reads fast for trail walking
// with a pack, so a PACE FACTOR scales it. The factors are calibrated on flat ground,
// which is the one number a reader can check against their own experience: steady puts
// level trail at 4.0 km/h, which is the standard planning figure. The factor is a
// single scalar and never per-segment, so the SHAPE of the curve stays Tobler's and
// only its magnitude is ours. That keeps the honesty line short: one published function,
// one scalar, both stated on the page.
//
// The -0.05 offset in Tobler is not a typo. Walking speed peaks on a slight DOWNGRADE
// (about -5%), not on the flat, which is why the return leg of an out-and-back beats
// level ground and why `paceKph` is asymmetric around zero. It is the single most
// counter-intuitive number in the model and the reason a naive "downhill is faster by
// x%" fudge does not reproduce it.

/** Pace presets. A product control: the user's own speed, not a demo lever. */
export type PaceId = 'slow' | 'steady' | 'fast';

export interface PaceDef {
  id: PaceId;
  label: string;
  /** Scalar on Tobler. Calibrated so `label` matches `flatKph` on level ground. */
  factor: number;
  /** Speed on flat ground at this pace, km/h. Derived, not independent: see FLAT_CHECK. */
  flatKph: number;
}

export const PACES: PaceDef[] = [
  { id: 'slow', label: 'Slow', factor: 0.65, flatKph: 3.2 },
  { id: 'steady', label: 'Steady', factor: 0.8, flatKph: 4.0 },
  { id: 'fast', label: 'Fast', factor: 0.95, flatKph: 4.7 },
];

export const DEFAULT_PACE: PaceId = 'steady';

/**
 * Tobler's hiking function, km/h, for a signed slope (rise over run, so 0.1 is a 10%
 * climb and -0.1 a 10% descent). Unscaled and unmodified, so it can be checked against
 * the published form.
 */
export function toblerKph(slope: number): number {
  return 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
}

/**
 * Walking speed at a pace, floored.
 *
 * The floor is not cosmetic. Tobler decays exponentially, so a sustained 45% pitch
 * returns under 0.8 km/h and a bad geometry spike can return near zero, which would
 * push a single 140 m leg into an hour and bend the whole timeline around a data
 * artefact. 0.6 km/h is slower than anyone walks uphill and still bounds the damage.
 */
export function paceKph(slope: number, factor: number): number {
  return Math.max(0.6, toblerKph(slope) * factor);
}

export function paceDef(id: PaceId): PaceDef {
  return PACES.find((p) => p.id === id) ?? PACES[1];
}

/**
 * The calibration table printed on the page. Same function the timeline uses, sampled at
 * grades a reader recognises, so the model is auditable without reading the code.
 */
export const FLAT_CHECK: number[] = [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.3];
