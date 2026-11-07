// Trail mode — monotone cubic interpolation for Concept B's elevation profile.
//
// The profile is 48 samples over the whole walk (`scope/derive.mjs`'s own resolution,
// committed data; see route.ts's Concept B note for why this file does not try to fix
// that by re-sampling), drawn until now as a straight polyline between samples, so every
// real undulation the samples do not happen to land on read as a flat facet rather than a
// curve — part of what made the chart look like a tent rather than terrain.
//
// A plain cubic spline (natural, or Catmull-Rom through the same points) would round
// those facets off, but both can OVERSHOOT: between two samples they can swing past
// either one and draw a local bump or dip that is not in the data. That is exactly the
// failure mode this page cannot afford — the seam handling in journey.ts and the horizon
// rule in provider.ts both exist to stop the page from asserting a fact the data does not
// support, and an invented false summit between two real samples would be the same
// mistake wearing a nicer curve. MONOTONE CUBIC (Fritsch-Carlson, the same construction
// D3's `curveMonotoneX` implements) is chosen specifically because it cannot do that: the
// tangent at each sample is clamped so the curve is monotonic across every single segment,
// which means the curve can never leave the closed interval between its two endpoint
// values. Smoother than a straight line, provably no more inventive than one.
//
// This module is pure maths, no DOM: `route.ts` calls `monotonePath` to draw, and
// `trail/profile-check.mjs` calls the same `monotoneSegments` this builds on to prove the
// no-overshoot property by sampling the curve numerically rather than trusting the
// derivation. One implementation, read two ways, same discipline `journey.ts`'s header
// comment argues for the Journey model itself.

export interface XY {
  x: number;
  y: number;
}

/** One cubic Bézier segment, control points included, in the SAME units as the input
 *  points (chart pixels here; `profile-check.mjs` never converts). */
export interface CubicSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
}

/**
 * Fritsch-Carlson tangents for `pts`, sorted by `x` ascending.
 *
 * Two points sharing an `x` (a seam's frozen `travelM`, see journey.ts's header comment)
 * would divide by zero in a plain secant; here the shared-x secant is defined as 0, which
 * safely forces both its tangents to 0 too (a degenerate, zero-width segment draws as a
 * flat point, never as a spike).
 */
function monotoneTangents(pts: XY[]): number[] {
  const n = pts.length;
  const secants: number[] = new Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    secants[i] = dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx;
  }

  const m: number[] = new Array(n);
  m[0] = secants[0] ?? 0;
  m[n - 1] = secants[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const a = secants[i - 1];
    const b = secants[i];
    // Opposite-signed (or zero) neighbouring secants means this sample is a local
    // extremum: the only tangent that cannot overshoot THERE is a flat one.
    m[i] = a === 0 || b === 0 || a > 0 !== b > 0 ? 0 : (a + b) / 2;
  }

  // The Fritsch-Carlson limiter proper: for every segment, clamp its pair of tangents so
  // neither one alone can push the curve past the segment's own two endpoints. This is
  // the step that turns "usually looks monotone" into "provably cannot overshoot".
  for (let i = 0; i < n - 1; i++) {
    const d = secants[i];
    if (d === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d;
    const b = m[i + 1] / d;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d;
      m[i + 1] = tau * b * d;
    }
  }
  return m;
}

/**
 * `pts` as a run of cubic Bézier segments. The Hermite-to-Bézier conversion here is
 * EXACT, not an approximation: a cubic Hermite segment with endpoint tangents m0/m1 is
 * identically the Bézier with control points at 1/3 and 2/3 along those tangents, so
 * nothing is lost between "the monotone maths" and "the drawn curve".
 */
export function monotoneSegments(pts: XY[]): CubicSeg[] {
  if (pts.length < 2) return [];
  const m = monotoneTangents(pts);
  const segs: CubicSeg[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p3 = pts[i + 1];
    const dx = (p3.x - p0.x) / 3;
    segs.push({
      x0: p0.x,
      y0: p0.y,
      x1: p0.x + dx,
      y1: p0.y + m[i] * dx,
      x2: p3.x - dx,
      y2: p3.y - m[i + 1] * dx,
      x3: p3.x,
      y3: p3.y,
    });
  }
  return segs;
}

/** One segment's `d` command, minus the leading `M` (callers that need an area fill under
 *  the ridge draw their own `M`/closing `L`s and splice this in; see route.ts). */
export function segmentsToCommands(segs: CubicSeg[]): string {
  return segs
    .map(
      (s) =>
        `C${s.x1.toFixed(2)} ${s.y1.toFixed(2)} ${s.x2.toFixed(2)} ${s.y2.toFixed(2)} ${s.x3.toFixed(2)} ${s.y3.toFixed(2)}`,
    )
    .join('');
}

/** The full `d` attribute, `M` included, for `pts` drawn as one monotone cubic run. */
export function monotonePath(pts: XY[]): string {
  if (pts.length < 2) {
    // A one-point "run" (a seam fragment; see the header comment) has nothing to
    // interpolate. Callers draw it as a dot, same convention as ui.ts's profileSparkline.
    return pts.length === 1 ? `M${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}` : '';
  }
  return `M${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}${segmentsToCommands(monotoneSegments(pts))}`;
}

/** Cubic Bézier, evaluated at `t` in [0,1]. Only `profile-check.mjs` calls this: the SVG
 *  renderer never evaluates its own curve, the browser does that. */
export function bezierAt(s: CubicSeg, t: number): XY {
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * s.x0 + w1 * s.x1 + w2 * s.x2 + w3 * s.x3,
    y: w0 * s.y0 + w1 * s.y1 + w2 * s.y2 + w3 * s.y3,
  };
}
