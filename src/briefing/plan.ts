// Region briefing — the plan figure.
//
// WHY A SCHEMATIC AND NOT A MAP. This app already draws MapLibre on four pages, so the map
// was the default and was rejected for three reasons, in order of weight:
//
//   1. A slippy map invites interrogation. A reader who can pan and zoom a tinted field
//      will pan and zoom it, and behind the tint here there is nothing to find: five
//      hand-placed points and a nearest-centre rule. A map would offer a resolution the
//      content does not have, which on the one page in this repo that prints invented
//      weather is the exact failure to avoid.
//   2. At document width a basemap spends its contrast on hillshade, roads and place
//      labels, and the figure has one thing to say: this side of the crest, not that side.
//      A flat plan gives the whole contrast budget to that.
//   3. It cannot flake. SCOPE_PLAN §4 froze the derived data so the prototype could not
//      fail in front of an exec; a figure with no tile request keeps that property, and the
//      briefing is the page most likely to be opened cold.
//
// WHAT IS DRAWN IS REAL. Every line is the actual merged geometry of an actual trail in the
// committed RMNP snapshot, projected and stroked. The reader is looking at the real trail
// network of the real park. Only the colour is invented, and the legend says which is which.
//
// The Divide is the one hand-drawn line, and it is dashed and labelled "sketched" for that
// reason: it is there so "east of the Divide" has something to point at.

import { h } from '../ui/dom';
import { displaySet } from '../scope/data';
import type { ScopeTrail } from '../scope/types';
import { DIVIDE_SKETCH, SAMPLE_REGION, type SampleLevel } from './sample';
import { areaOf, areaRollups } from './model';

// ============================================================================
// PROJECTION
// ============================================================================

/** Plan width in viewBox units. Height follows from the region's own aspect ratio. */
const PLAN_W = 1000;
/** Margin in viewBox units, so a trailhead on the bbox edge is not clipped by the frame. */
const PAD = 18;

interface Projection {
  width: number;
  height: number;
  /** [lng, lat] to viewBox units. */
  to: (lngLat: [number, number]) => [number, number];
  /** [lng, lat] to a 0..1 fraction of the box, for HTML pins layered over the SVG. */
  toFraction: (lngLat: [number, number]) => [number, number];
}

/** Every coordinate the figure will draw, so nothing lands outside the frame. */
function planCoords(trails: ScopeTrail[]): [number, number][] {
  const out: [number, number][] = [...DIVIDE_SKETCH];
  for (const trail of trails) {
    for (const part of partsOf(trail)) for (const c of part) out.push([c[0], c[1]]);
  }
  return out;
}

/**
 * Equirectangular, scaled by cos(latitude) so the park is not stretched sideways.
 *
 * A projection this crude is correct here: the region is 23 km across, and any conformal
 * projection would differ from this by less than a stroke width. Pulling one in would add a
 * dependency to make a schematic marginally more accurate, which is not a trade worth
 * taking on a figure whose colours are invented.
 */
function projection(coords: [number, number][]): Projection {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  const k = Math.cos(((s + n) / 2) * (Math.PI / 180));
  const spanX = (e - w) * k;
  const spanY = n - s;
  const inner = PLAN_W - PAD * 2;
  const scale = inner / spanX;
  const height = spanY * scale + PAD * 2;

  const to = (lngLat: [number, number]): [number, number] => [
    PAD + (lngLat[0] - w) * k * scale,
    // y grows downward in SVG and north is up, so latitude inverts.
    PAD + (n - lngLat[1]) * scale,
  ];

  return {
    width: PLAN_W,
    height,
    to,
    toFraction: (lngLat) => {
      const [x, y] = to(lngLat);
      return [x / PLAN_W, y / height];
    },
  };
}

/** LineString and MultiLineString read the same way. */
function partsOf(trail: ScopeTrail): GeoJSON.Position[][] {
  const g = trail.geometry;
  return g.type === 'LineString' ? [g.coordinates] : g.coordinates;
}

// ============================================================================
// DRAWING
// ============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** One part of one trail as an SVG path, rounded to 0.1 units to keep the markup small. */
function pathFor(part: GeoJSON.Position[], p: Projection): string {
  let d = '';
  for (let i = 0; i < part.length; i++) {
    const [x, y] = p.to([part[i][0], part[i][1]]);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

export interface PlanFigure {
  /** The figure body: the SVG plus the HTML pin overlay. */
  node: HTMLElement;
  /** How many real trails the plan drew, for the caption. */
  drawn: number;
}

/**
 * The plan: every trail in the display set, stroked in its area's sample colour, over a
 * sketched Divide, with a numbered pin per area keyed to the list beneath it.
 *
 * PINS ARE HTML, NOT SVG. A pin inside the viewBox would scale with the figure, so the
 * numbers would be 12 px at desktop width and 4 px at 375, which is where this page has to
 * work. Absolutely positioned HTML at a percentage offset stays one size at every width and
 * keeps the numerals in the page's own type rather than in an SVG font stack.
 *
 * NON-SCALING STROKES, for the same reason in the other direction: a 1.3 unit stroke would
 * render at 0.5 px on a phone and disappear. `vector-effect` pins the line weight to CSS
 * pixels, so the network reads as a network at both widths.
 */
export function planFigure(): PlanFigure {
  const trails = displaySet(SAMPLE_REGION).trails;
  const proj = projection(planCoords(trails));

  const svg = svgEl('svg', {
    viewBox: `0 0 ${Math.round(proj.width)} ${Math.round(proj.height)}`,
    class: 'bf-plan-svg',
    role: 'img',
    'aria-label':
      'Plan of the Rocky Mountain National Park trail network, with each trail coloured by ' +
      'the sample conditions invented for its area.',
  });

  // The sketched Divide goes down first so trails cross over it rather than under it: the
  // trails are the real object and should not be interrupted by the drawn one.
  svg.appendChild(
    svgEl('path', {
      d: pathFor(DIVIDE_SKETCH, proj),
      class: 'bf-divide',
      fill: 'none',
    }),
  );

  let drawn = 0;
  for (const trail of trails) {
    const level = levelOfTrail(trail);
    for (const part of partsOf(trail)) {
      if (part.length < 2) continue;
      svg.appendChild(
        svgEl('path', {
          d: pathFor(part, proj),
          class: `bf-line lv-${level}`,
          fill: 'none',
        }),
      );
    }
    drawn++;
  }

  const pins = h('div', { class: 'bf-pins' });
  areaRollups().forEach((rollup, i) => {
    const [fx, fy] = proj.toFraction(rollup.area.centre);
    const pin = h(
      'span',
      {
        class: `bf-pin lv-${rollup.level}`,
        title: `${i + 1}. ${rollup.area.name}`,
      },
      String(i + 1),
    );
    pin.style.left = `${(fx * 100).toFixed(2)}%`;
    pin.style.top = `${(fy * 100).toFixed(2)}%`;
    pins.appendChild(pin);
  });

  return { node: h('div', { class: 'bf-plan' }, svg, pins), drawn };
}

/** An area's invented level, looked up through the rollup so both figures agree. */
function levelOfTrail(trail: ScopeTrail): SampleLevel {
  const id = areaOf(trail).id;
  return areaRollups().find((r) => r.area.id === id)?.level ?? 'good';
}
