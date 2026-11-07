// Trail Scope phone — shared visual primitives.
//
// The card is the most important object in this build (SCOPE_PLAN §1), and two of its
// parts live here because the peek sheet and the map legend need the same ones:
//
//   profileSparkline()  the elevation profile as the hero graphic, BROKEN AT SEAMS. A
//                       multi-part trail has a real discontinuity; drawing a line through
//                       it invents a cliff that is not on the ground.
//   conditionPill()     the tinted pill with a glyph and a time. Deliberately a different
//                       SHAPE in a different POSITION from the difficulty dot, because
//                       AllTrails' learned green/amber/red dot means difficulty and two
//                       traffic lights on one card would mean two different things
//                       (SCOPE_PLAN §5).
//
// Icons are inline SVG rather than a font or emoji: no external host, and they inherit
// currentColor so a chip's active state recolours its glyph for free.

import { h } from '../../ui/dom';
import type { ConditionGrade, Difficulty, GradeLevel, RouteType, ScopeTrail } from '../types';
import { DIFFICULTY_LABEL, ROUTE_TYPE_LABEL } from '../model';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ============================================================================
// ICONS
// ============================================================================

/**
 * 24×24 stroked paths, all on the same grid so they optically match at any size.
 *
 * MOSTLY LUCIDE (lucide.dev), inlined rather than pulled in as a runtime dependency: this
 * repo ships no CDN and no icon library, fonts are self-hosted via `@fontsource` and every
 * icon here is hand-rolled inline SVG, so inlining Lucide's path data keeps that posture
 * rather than opening a new one. Lucide is ISC licensed (permissive, attribution kept by
 * this comment: path data © the Lucide Contributors, https://lucide.dev, ISC). Lucide's
 * own grid is 24×24, stroke-based, 2 px, which already matches every entry below, so
 * nothing about `icon()` itself needed retuning.
 *
 * Not every entry is Lucide. `park`, `forest`, `town`, `state`, `trail` and `p2p` are
 * bespoke place/route-type silhouettes with no clean Lucide equivalent (Lucide has no
 * "state boundary" or "point-to-point route" glyph), and approximating one would be worse
 * than the hand-drawn shape it replaced, so those stay as they were. `outlook` is the same
 * call: the dashed-generic-forecast reading is bespoke to this app.
 */
const ICONS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>', // lucide: search
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>', // lucide: arrow-left
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', // lucide: x
  chevron: '<path d="m6 9 6 6 6-6"/>', // lucide: chevron-down
  // lucide: sliders-horizontal
  filters:
    '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
  sort: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>', // lucide: arrow-up-down
  locate: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>', // lucide: navigation
  // Places, typed so search results read at a glance (AllTrails screenshot 2). Bespoke:
  // see the header comment.
  park: '<path d="M12 3c3.2 2.6 5 6.3 5 10.2V21H7v-7.8C7 9.3 8.8 5.6 12 3z"/><path d="M12 21V9"/>',
  forest: '<path d="M12 3l4.5 7h-2.7L17 15H7l3.2-5H7.5z"/><path d="M12 15v6"/>',
  town: '<path d="M3 21V10l6-4 6 4v11"/><path d="M15 21V13h6v8"/><path d="M7 21v-4h4v4"/>',
  peak: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>', // lucide: mountain
  state: '<path d="M4.5 5.5h9l2 3h5v10h-16z"/>',
  trail: '<path d="M12 3v18"/><path d="M5.5 6h9.5l-2 2.5 2 2.5H5.5z"/>',
  // Measures.
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>', // lucide: arrow-up
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>', // lucide: arrow-down
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', // lucide: clock
  // The familiar reload/refresh form (Björn's call: the previous "loop" glyph, two hooked
  // ends around an open channel, did not read as a loop at card size, 13 px). Lucide's
  // rotate-cw: an open ring plus one arrowhead, so the direction of travel is unambiguous
  // even with the colour and the curve alone doing most of the work at small sizes.
  // Re-verified at 13 px in the card meta row (screenshot, not assumed): still legible.
  loop: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>', // lucide: rotate-cw
  p2p: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8 16.5l8-9"/>',
  ruler: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>', // lucide: ruler
  // Conditions glyphs. Different silhouettes so the level reads without colour.
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>', // lucide: sun
  suncloud: '<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>', // lucide: cloud-sun
  bolt: '<path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/>', // lucide: cloud-lightning
  // Added so the marker badge can tell a merely-overcast hour from a wet one: with only
  // sun / cloud-sun / cloud-lightning available, a raining hour rendered the same glyph as
  // a cloudy one, which is a fidelity gap on a page whose whole subject is conditions.
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>', // lucide: cloud
  rain: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>', // lucide: cloud-rain
  outlook: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3"/><path d="M8 15h2M14 15h2" stroke-dasharray="2 2"/>',
  // New weather/terrain glyphs, added for the marker vocabulary shared by Concepts A/B and
  // the TEMP/GUST/STORM columns on Concept C's table (route.ts, trail/markerui.ts).
  thermometer: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>', // lucide: thermometer
  wind: '<path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/>', // lucide: wind
  droplets: '<path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"/><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"/>', // lucide: droplets
  sunset: '<path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>', // lucide: sunset
  flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>', // lucide: flag
  mappin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>', // lucide: map-pin
  // A u-turn, for the journey's turnaround marker: a place and a direction, not a warning.
  turn: '<path d="M20 20v-7a4 4 0 0 0-4-4H4"/><path d="M9 14 4 9l5-5"/>', // lucide: corner-up-left
  // Tab bar.
  explore: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>', // lucide: search (same glyph as `search`)
  foryou: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>', // lucide: layout-grid
  navigate: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>', // lucide: navigation (same glyph as `locate`)
  saved: '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/>', // lucide: heart
  activity: '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>', // lucide: trending-up
  map: '<path d="M9 4.5L3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8z"/><path d="M9 4.5v12.7M15 6.8v12.7"/>',
  list: '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>', // lucide: list
  check: '<path d="M20 6 9 17l-5-5"/>', // lucide: check
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>', // lucide: star
  camera: '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/><circle cx="12" cy="13" r="3"/>', // lucide: camera
  comment: '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>', // lucide: message-square
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>', // lucide: info
  // The offline mark. Björn asked specifically for a cell or wifi glyph, and this is
  // Lucide's `wifi-off`: the same four arcs as `wifi` with the slash through them, so the
  // offline state and a hypothetical online one would read as one glyph in two states
  // rather than as two unrelated pictures. Chosen over the signal-bars family because a
  // bar chart at 12px reads as a level (how much signal) where the honest claim here is
  // binary (there is none), and because most US trails have no cell service at all, which
  // is the case the state exists for. Same 24x24 grid and 2px stroke as every entry above.
  offline:
    '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>', // lucide: wifi-off
};

export function icon(name: keyof typeof ICONS | string, size = 16, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  svg.innerHTML = ICONS[name] ?? ICONS.info;
  return svg;
}

// ============================================================================
// THE WEATHER GLYPH
// ============================================================================

/**
 * Storm-probability bands: the cuts the whole app already draws conditions with.
 *
 * These are `src/trail/journey.ts`'s `levelForThunder` cuts and `phone/peek.ts`'s
 * `stripCellClass` cuts, which are the same three numbers written down in three places
 * (SCOPE_PLAN §13 records that duplication and says to unify it when trail mode graduates).
 * This copy exists so a NEW surface does not add a fourth: everything on this page that has
 * to pick a silhouette or a band for a thunder probability now asks here.
 */
export type StormBand = 0 | 1 | 2 | 3;

export function stormBand(thunderProb: number): StormBand {
  if (thunderProb >= 0.55) return 3;
  if (thunderProb >= 0.3) return 2;
  if (thunderProb >= 0.12) return 1;
  return 0;
}

/**
 * Which glyph a set of measured values draws, in one precedence, shared.
 *
 * This is `src/trail/markerui.ts`'s `weatherIcon` precedence, and it is here rather than
 * there because the dependency between those two files already runs trail -> scope
 * (markerui.ts imports `icon` from this file), never the other way, so this is the shared
 * home and importing across the pages would be the wrong direction (SCOPE_PLAN §14 records
 * the peek's `src/trail/pace.ts` import as exactly that mistake). `markerui.ts`'s copy is
 * still the live one for trail mode and should be collapsed into this call the next time
 * that page is opened: its signature takes a pre-computed band because a marker stands for a
 * GROUP of samples and carries the worst band any of them met, which is `stormBand` applied
 * one level up rather than a different rule.
 *
 * PRECEDENCE, THUNDER FIRST:
 *
 *   band 3 (>= 55%)  -> bolt.     Once a storm is likelier than not, that is the whole story
 *                                 and how much sky is visible stops being relevant.
 *   band 2 (>= 30%)  -> suncloud. Real, rising convection but not a committed storm: reads as
 *                                 building cloud rather than as lightning that has not
 *                                 happened.
 *   bands 0 and 1    -> the sky decides, below. A calm and a slight hour both mean "no real
 *                                 storm signal", so thunder has nothing left to say.
 *
 * Below the storm bands, wet outranks merely grey, then cloud cover picks between overcast,
 * broken and clear. `precipMm` must be an HOURLY figure: a daily total would read as rain on
 * any day with one wet hour in it (see `ConditionsReading.peakPrecipMm`).
 */
/**
 * Rain below this is noise, not weather, and neither the glyph nor the printed field may
 * treat it as weather.
 *
 * It lives here, beside `weatherGlyph`, because the two have to agree, and they did not. The
 * printed precipitation field applied a floor while the glyph tested `precipMm > 0`, so the
 * bluebird CONTROL scenario, whose convection block deliberately carries a trace
 * `peakRainMmPerH: 0.1`, drew a rain cloud next to "storms 0%" and "dry underfoot" while
 * printing no rain figure at all. Three elements describing one hour, one of them disagreeing.
 *
 * Two thresholds for one fact is the recurring defect in this codebase: the verdict's level
 * word, the peek's repeated hour, weather-on-route's no-window clause, the card's pill against
 * its own conditions row. One constant, read by everything that speaks about rain, is the fix.
 *
 * Half a millimetre because `formatPrecip` rounds metric to whole millimetres, so anything
 * below it would print "0 mm", which reads as a broken field rather than as a dry day.
 */
export const PRECIP_FLOOR_MM = 0.5;

export function weatherGlyph(
  thunderProb: number,
  precipMm: number,
  cloudPct: number,
  /**
   * Pre-computed storm band, for a caller whose glyph stands for a GROUP of samples rather
   * than a single hour: a weather-on-route marker carries the worst band any of its merged
   * samples met, which is `stormBand` applied one level up rather than a different rule.
   * Omitted, the band is derived from `thunderProb` exactly as before.
   */
  bandOverride?: number,
): string {
  const band = bandOverride ?? stormBand(thunderProb);
  // Lightning first and only lightning: once a storm is likelier than not, that is the whole
  // story and nothing else about the sky competes with it.
  if (band >= 3) return 'bolt';
  // RAIN BEFORE THE MIDDLE STORM BAND, which is a correction. This used to read
  // `if (band >= 2) return 'suncloud'` here, ahead of any precipitation test, and it masked
  // rain completely: measured on Flattop under afternoon storms, the journey's WETTEST hours
  // (3.0 to 4.7 mm, band 2) drew "part cloud" while its driest wet hour (0.5 mm, band 0) drew
  // rain. A reader saw "43% storms" beside a part-cloud glyph and "5% storms" beside a rain
  // glyph, which is the precedence backwards.
  //
  // The band-2 gloss was defensible in isolation, as building convection that has not
  // committed to lightning yet, but it can only mean that on a DRY hour. If it is raining, it
  // is raining, and that is the more useful and more honest thing for the glyph to say.
  if (precipMm >= PRECIP_FLOOR_MM) return 'rain';
  if (band >= 2) return 'suncloud';
  if (cloudPct >= 0.75) return 'cloud';
  if (cloudPct >= 0.4) return 'suncloud';
  return 'sun';
}

// ============================================================================
// DRAG TO SCROLL
// ============================================================================

/**
 * Horizontal rows in this app (the filter chips, the jump-to shortcuts, the day bar) scroll
 * natively under a finger and, on a desktop, under a trackpad's two-finger swipe. Under a
 * MOUSE they do neither: there is no horizontal wheel axis, no scrollbar (every one of these
 * rows hides it), and so a reader on a laptop trackpad-less or a stakeholder clicking through
 * a demo simply cannot see the chips past the fold. The row looks like it ends where the
 * phone bezel ends.
 *
 * This turns a press-and-move into `scrollLeft`, which is the interaction everyone already
 * expects from a map. Three details carry it, and two of them are not obvious:
 *
 *   POINTER CAPTURE ONLY ONCE THE DRAG IS REAL. A drag that leaves the row (very likely:
 *   the row is 40 px tall) has to keep scrolling, which is what capture is for. But
 *   capturing on `pointerdown` breaks every plain click in the row: Chrome retargets the
 *   compatibility mouse events to the capture element too, so `mouseup` and therefore
 *   `click` fire on the ROW rather than on the chip, and the chip's own handler never
 *   runs. Verified, not theorised. So the press listens on `window` until the pointer has
 *   travelled past the slop threshold, and only then captures.
 *
 *   CLICK SUPPRESSION past that same threshold. Every child of these rows is a control, so
 *   without it a drag that starts on "Dry" toggles Dry on release. The suppressor is a
 *   CAPTURE-phase listener on the row, which is what puts it ahead of the chip's own click
 *   handler; a bubble-phase one runs too late to stop anything.
 *
 *   A CLEAN SLATE ON EVERY PRESS, so a drag that ends without producing a click (released
 *   outside the row) cannot leave the suppressor armed and swallow the next real tap.
 *
 * Touch is left entirely alone (`pointerType === 'touch'` returns immediately) so native
 * momentum scrolling is untouched, and `touch-action: pan-x` in the CSS keeps it that way.
 */
const DRAG_SLOP_PX = 5;

export function dragScroll<T extends HTMLElement>(row: T): T {
  row.classList.add('drag-scroll');

  let activeId: number | null = null;
  let startX = 0;
  let startLeft = 0;
  let dragged = false;
  let swallowClick = false;

  const onMove = (ev: PointerEvent): void => {
    if (activeId !== ev.pointerId) return;
    const dx = ev.clientX - startX;
    if (!dragged) {
      if (Math.abs(dx) < DRAG_SLOP_PX) return;
      dragged = true;
      row.setPointerCapture(ev.pointerId);
      row.classList.add('is-dragging');
    }
    row.scrollLeft = startLeft - dx;
    // Stops the browser turning the press into a text or element drag mid-scroll.
    ev.preventDefault();
  };

  const onEnd = (ev: PointerEvent): void => {
    if (activeId !== ev.pointerId) return;
    if (row.hasPointerCapture(ev.pointerId)) row.releasePointerCapture(ev.pointerId);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onEnd);
    window.removeEventListener('pointercancel', onEnd);
    activeId = null;
    swallowClick = dragged;
    dragged = false;
    row.classList.remove('is-dragging');
  };

  row.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'touch' || ev.button !== 0) return;
    activeId = ev.pointerId;
    startX = ev.clientX;
    startLeft = row.scrollLeft;
    dragged = false;
    swallowClick = false;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  });

  row.addEventListener(
    'click',
    (ev) => {
      if (!swallowClick) return;
      swallowClick = false;
      ev.preventDefault();
      ev.stopPropagation();
    },
    { capture: true },
  );

  return row;
}

// ============================================================================
// THE ELEVATION PROFILE
// ============================================================================

/**
 * Fill and stroke per grade level.
 *
 * The profile is the card's hero: it is what replaces AllTrails' photograph, so it has to
 * carry real visual weight rather than sit there as a grey sparkline. The fill is a
 * vertical gradient from a saturated band at the ridge line down to near-transparent at
 * the baseline, tinted by the condition level so a scrolled list reads green / amber / red
 * at a glance before a single word is read. The stroke takes the same hue, darkened, so
 * the terrain line stays the sharpest thing in the frame.
 *
 * The tint is the SAME judgement the pill states in words. It is not a second, differently
 * computed opinion, and it never appears on an outlook day, where there is no
 * route-specific grade to tint with.
 */
interface ProfilePaint {
  /** Gradient stops, top of the fill to the baseline. */
  from: string;
  mid: string;
  to: string;
  stroke: string;
}

const PROFILE_PAINT: Record<GradeLevel | 'pending', ProfilePaint> = {
  prime: {
    from: 'rgba(26, 122, 69, 0.62)',
    mid: 'rgba(26, 122, 69, 0.26)',
    to: 'rgba(26, 122, 69, 0.05)',
    stroke: '#14603a',
  },
  mixed: {
    from: 'rgba(224, 146, 22, 0.66)',
    mid: 'rgba(255, 180, 84, 0.30)',
    to: 'rgba(255, 180, 84, 0.06)',
    stroke: '#9a6100',
  },
  poor: {
    from: 'rgba(178, 58, 46, 0.58)',
    mid: 'rgba(178, 58, 46, 0.24)',
    to: 'rgba(178, 58, 46, 0.05)',
    stroke: '#8f2c22',
  },
  pending: {
    from: 'rgba(31, 42, 36, 0.30)',
    mid: 'rgba(31, 42, 36, 0.13)',
    to: 'rgba(31, 42, 36, 0.03)',
    stroke: '#4a564e',
  },
};

/** Gradient ids have to be unique per document, and several profiles share a screen. */
let gradientSeq = 0;

/** Scale the alpha of an `rgba(r, g, b, a)` string. Leaves anything else alone. */
function fadeRgba(color: string, factor: number): string {
  return color.replace(
    /rgba\(([^)]+)\)/,
    (_all, body: string) => {
      const parts = body.split(',').map((s) => s.trim());
      if (parts.length !== 4) return `rgba(${body})`;
      const a = Number(parts[3]) * factor;
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a.toFixed(3)})`;
    },
  );
}

/**
 * The outlook treatment: the level's own hue at roughly a third of the weight.
 *
 * Past the horizon the grade IS a real level, so a settled Monday and a stormy Monday must
 * not render as the same grey hillside; but an outlook is not a route-specific claim, so it
 * must not render at the same strength either. Same hue, visibly quieter, which is exactly
 * what the pill does with its border and text.
 */
function outlookPaint(base: ProfilePaint): ProfilePaint {
  return {
    from: fadeRgba(base.from, 0.34),
    mid: fadeRgba(base.mid, 0.34),
    to: fadeRgba(base.to, 0.34),
    stroke: '#4a564e',
  };
}

export interface ProfileOpts {
  w: number;
  h: number;
  /** Fill tint. `null` renders the neutral pending wash. */
  level: GradeLevel | null;
  /** Outlook days get the level's hue at reduced weight: real level, lower confidence. */
  outlook?: boolean;
  /** Elevation ceiling/floor labels down the right edge. Peek sheet only. */
  labels?: boolean;
  labelHigh?: string;
  labelLow?: string;
  /**
   * The regional treeline, as a dashed rule with a label. PEEK SHEET ONLY, and omitted
   * everywhere else on purpose.
   *
   * NOT ON THE CARD. The card's sparkline is 320 px wide in a scrolling list and a rule
   * ruled across every one of them would be noise: eighty-seven copies of one regional
   * constant, on a graphic whose whole job is to be a per-trail fingerprint scanned at
   * speed. The peek is the one place a reader is looking at a single profile long enough
   * for the height of the trees to mean anything.
   *
   * PASSED PRE-FORMATTED, not as a bare number, for two reasons. The caller owns units
   * (everything is SI at rest and the formatters convert at render time, so this function
   * has no business knowing which toggle is set), and it also owns the decision of whether
   * a treeline exists at all: the Ozarks' `treelineM` is the NO_TREELINE_M sentinel, which
   * `model.ts` says in as many words must never reach the UI as a number. A caller with no
   * treeline to draw simply omits this, and nothing here has to know what a sentinel is.
   *
   * NEVER DEGRADED ON AN OUTLOOK DAY, unlike the fill. Treeline is a terrain fact computed
   * from our own derived data, not a forecast claim, which is exactly the argument
   * `filters.ts` already makes for keeping the Below treeline and Shaded chips at full
   * strength past the horizon.
   */
  treeline?: { elevM: number; label: string };
}

/**
 * The card's hero graphic.
 *
 * `seamIndices` are honoured: each disconnected part is its own path, so a trail merged
 * from segments 2 km apart shows a gap rather than a vertical drop it does not have.
 * MERGE_PLAN §6 records that `__parts` over-reports for a different reason (a greedy walk
 * emitting stubs at junctions), so a seam is drawn as a break in the line and never
 * annotated as a distance.
 */
export function profileSparkline(trail: ScopeTrail, opts: ProfileOpts): SVGSVGElement {
  const { w, h } = opts;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'pf-svg');
  svg.setAttribute('aria-hidden', 'true');

  const prof = trail.profile && trail.profile.length > 1 ? trail.profile : [trail.minElevM, trail.maxElevM];
  const n = prof.length;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of prof) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // A flat trail must not render as a full-height band of noise: give it a floor of 20 m
  // of vertical range so a genuinely flat lakeside path looks flat.
  const span = Math.max(20, hi - lo);
  const mid = (hi + lo) / 2;
  const top = mid + span / 2;
  const padT = 5;
  const padB = 3;
  const x = (i: number): number => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number): number => padT + ((top - v) / span) * (h - padT - padB);

  // Run boundaries: index 0 plus every in-range seam, deduplicated and ordered.
  const starts = [0, ...trail.seamIndices.filter((i) => i > 0 && i < n)].sort((a, b) => a - b);
  const uniq = starts.filter((v, i) => i === 0 || v !== starts[i - 1]);

  const base = PROFILE_PAINT[opts.level ?? 'pending'];
  const paint = opts.outlook ? (opts.level ? outlookPaint(base) : PROFILE_PAINT.pending) : base;

  // One gradient per profile, in objectBoundingBox units so it stretches with the shape.
  const gradId = `pf-g${++gradientSeq}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');
  for (const [offset, color] of [['0%', paint.from], ['55%', paint.mid], ['100%', paint.to]] as const) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    grad.appendChild(stop);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);
  const fill = `url(#${gradId})`;

  for (let r = 0; r < uniq.length; r++) {
    const from = uniq[r];
    const to = (r + 1 < uniq.length ? uniq[r + 1] : n) - 1;
    if (to < from) continue;

    if (to === from) {
      // A one-sample part: a dot, so a fragment is visible rather than invisible.
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(x(from)));
      dot.setAttribute('cy', String(y(prof[from])));
      dot.setAttribute('r', '2.2');
      dot.setAttribute('class', 'pf-dot');
      dot.setAttribute('fill', paint.stroke);
      svg.appendChild(dot);
      continue;
    }

    let d = '';
    for (let i = from; i <= to; i++) d += `${i === from ? 'M' : 'L'}${x(i).toFixed(2)} ${y(prof[i]).toFixed(2)}`;

    const area = document.createElementNS(SVG_NS, 'path');
    area.setAttribute('d', `${d}L${x(to).toFixed(2)} ${h}L${x(from).toFixed(2)} ${h}Z`);
    area.setAttribute('fill', fill);
    area.setAttribute('stroke', 'none');
    svg.appendChild(area);

    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', d);
    line.setAttribute('class', 'pf-line');
    line.setAttribute('stroke', paint.stroke);
    svg.appendChild(line);
  }

  // ---- treeline ------------------------------------------------------------
  //
  // THE SAME TREATMENT `src/trail/route.ts`'s Concept B chart already draws, deliberately
  // rather than a second one: a dashed muted rule plus a mono label reading
  // "TREELINE <height>". Two surfaces in one app that both mark treeline and mark it
  // differently would be two vocabularies for one fact, which is the drift MERGE_PLAN and
  // TRAIL_PLAN both record paying for elsewhere. A rule and not a band, for the reason
  // that file states: it is a terrain fact, a single height, not a range.
  //
  // The guard is `hi > elevM`, matching Concept B's own `j.maxElevM > treelineM`: a route
  // that never reaches treeline gets no rule, because a rule off the top of the plot is a
  // mark with nothing to say. A route entirely ABOVE it lands below the plot floor and is
  // clipped by the viewBox, which is the same behaviour Concept B has and the same honest
  // answer (nothing on this walk is below treeline).
  if (opts.treeline && hi > opts.treeline.elevM) {
    const ty = y(opts.treeline.elevM);
    const rule = document.createElementNS(SVG_NS, 'line');
    rule.setAttribute('x1', '0');
    rule.setAttribute('y1', String(ty));
    rule.setAttribute('x2', String(w));
    rule.setAttribute('y2', String(ty));
    rule.setAttribute('class', 'pf-tl-rule');
    svg.appendChild(rule);

    const tl = document.createElementNS(SVG_NS, 'text');
    tl.setAttribute('x', '3');
    // Above the rule normally, flipped below it when the rule sits so high that the label
    // would be clipped by the top of the viewBox. Concept B never needs this because its
    // chart is `overflow: visible` inside a phone block with room above it; this one is a
    // hard-edged panel with a border, so a label that leaves the box simply disappears.
    tl.setAttribute('y', String(ty - 4 < 10 ? ty + 11 : ty - 4));
    tl.setAttribute('text-anchor', 'start');
    tl.setAttribute('class', 'pf-tl');
    tl.textContent = opts.treeline.label;
    svg.appendChild(tl);
  }

  if (opts.labels && (opts.labelHigh || opts.labelLow)) {
    const label = (text: string, yy: number, anchor: 'start' | 'end'): void => {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', anchor === 'end' ? String(w - 2) : '2');
      t.setAttribute('y', String(yy));
      t.setAttribute('text-anchor', anchor);
      t.setAttribute('class', 'pf-label');
      t.textContent = text;
      svg.appendChild(t);
    };
    if (opts.labelHigh) label(opts.labelHigh, 10, 'end');
    if (opts.labelLow) label(opts.labelLow, h - 4, 'end');
  }

  return svg;
}

/** True when the trail has a real discontinuity the sparkline is drawing as a break. */
export function hasSeams(trail: ScopeTrail): boolean {
  const n = trail.profile?.length ?? 0;
  return trail.seamIndices.some((i) => i > 0 && i < n);
}

// ============================================================================
// THE CONDITIONS PILL
// ============================================================================

const LEVEL_LABEL: Record<GradeLevel, string> = { prime: 'Good', mixed: 'Mixed', poor: 'Poor' };
const LEVEL_GLYPH: Record<GradeLevel, string> = { prime: 'sun', mixed: 'suncloud', poor: 'bolt' };

/**
 * Tinted, glyphed, and carrying a time when there is one. Sits on its own full-width row
 * directly under the profile; the difficulty dot sits in the peek sheet. Different shape,
 * different place (SCOPE_PLAN §5).
 *
 * OUTLOOK DAYS CARRY A LEVEL, AND IT IS SHOWN. Past the +36 h horizon the grader no longer
 * refuses; it returns a real prime / mixed / poor derived from the regional air mass rather
 * than from the route. Rendering every outlook day as an undifferentiated grey "Outlook"
 * would throw that away and make a settled Monday look exactly like a stormy one, so the
 * pill reads "Outlook · Mixed" and takes the level's border and text colour.
 *
 * The two states still have to be told apart at a glance, so the level does NOT get its
 * filled background on an outlook day. Route-specific grades are solid; outlook grades keep
 * the dashed border on the neutral inset. Same judgement, visibly lower confidence.
 */
export function conditionPill(
  grade: ConditionGrade | null,
  opts: { compact?: boolean; levelOnly?: boolean } = {},
): HTMLElement {
  if (!grade) {
    const el = h('div', { class: 'cond-pill is-pending' }, h('span', { class: 'cp-level' }, 'Grading'));
    return el;
  }

  const outlook = grade.confidence === 'outlook';
  const cls = outlook ? `cond-pill is-outlook lv-${grade.level}` : `cond-pill is-${grade.level}`;
  // The calendar glyph is what says "this is a day-scale claim". The level word says what
  // the claim is; the two are not alternatives.
  const glyph = outlook ? 'outlook' : LEVEL_GLYPH[grade.level];
  const level = outlook ? `Outlook · ${LEVEL_LABEL[grade.level]}` : LEVEL_LABEL[grade.level];

  return h(
    'div',
    { class: cls + (opts.compact ? ' is-compact' : '') },
    icon(glyph, opts.compact ? 13 : 15, 'cp-glyph'),
    h('span', { class: 'cp-level' }, level),
    // A search result list shows five rows of the same region on the same day, so five
    // copies of one headline is five copies of one sentence. The level still reads; the
    // reason belongs on the card and in the peek, where it is said once.
    opts.levelOnly ? null : h('span', { class: 'cp-text' }, grade.headline),
  );
}

// ============================================================================
// DIFFICULTY, MEASURES
// ============================================================================

/**
 * The learned dot, kept as a dot on purpose, and labelled `computed` every time it is
 * shown so nobody reads it as a crowd rating. NPS/Shenandoah: sqrt(gain_ft × 2 × length_mi).
 */
export function difficultyDot(difficulty: Difficulty, opts: { label?: boolean } = {}): HTMLElement {
  return h(
    'span',
    { class: 'diff' },
    h('i', { class: `diff-dot d-${difficulty}` }),
    h('span', {}, DIFFICULTY_LABEL[difficulty]),
    opts.label === false ? null : h('span', { class: 'diff-computed' }, 'computed'),
  );
}

/**
 * The card's route-type glyph. LOOP ONLY, never point-to-point, and never out-and-back.
 *
 * Two states exist because two states are all the data can honestly claim (SCOPE_PLAN §2):
 * a single OSM geometry has two ends and no record of whether a walker returns, so
 * out-and-back is not a type this app has, and there is no third glyph to draw for it.
 *
 * That still leaves a choice between marking both loop and point-to-point or marking loops
 * alone, and the tie-breaker is the RMNP display set: 4 of its 87 trails, 5 percent, are
 * loops. Marking point-to-point too would put a second glyph on the other 95 percent of
 * cards, on a row that is already at four items on a 390 px card, for a fact this build
 * already treats as the default everywhere else (the duration is Naismith on a one-way
 * line, and out-and-back was cut precisely because that IS the assumed baseline). The risk
 * taken on by marking only the exception is ambiguity: an unmarked card could in principle
 * read as "type not known" rather than "point-to-point". It does not, here, because
 * routeType is never a third, unknown value; the peek sheet also states the type in words
 * for a reader who wants it confirmed rather than inferred from an absence. Noise on 95
 * percent of rows was judged the worse failure of the two.
 */
export function routeTypeGlyph(routeType: RouteType): HTMLElement | null {
  if (routeType !== 'loop') return null;
  const label = ROUTE_TYPE_LABEL.loop;
  // `role="img"` plus a real label so the glyph is not the only carrier of the meaning: a
  // screen reader announces "Loop" and a mouse hover shows the same word as a tooltip.
  return h('span', { class: 'cm-route', role: 'img', title: label, 'aria-label': label }, icon('loop', 13));
}

// ============================================================================
// STARS
// ============================================================================
//
// The signal open data does not carry, and the reason the prototype has UGC at all. Every
// star drawn here comes from seeded content rather than from real reviews.
//
// The card used to print a small `sample` tag beside the mean to say so. It came off in the
// in-UI meta-copy pass: the rule now is that everything inside the phone frame reads as a
// real product, and provenance is stated in the prose column beside it (which is also where
// a reader who is not looking at the card can still see it). THE CLAIM MUST STILL BE MADE
// SOMEWHERE ON THE PAGE — if the prose column ever stops saying that ratings are simulated,
// put this label back rather than leaving an unlabelled star rating on a data-honesty page.

/** A five-star glyph row. `value` may be fractional; the last star part-fills. */
export function starGlyphs(value: number, size = 13): HTMLElement {
  const row = h('span', { class: 'stars', 'aria-hidden': 'true' });
  for (let i = 1; i <= 5; i++) {
    // 0 = empty, 1 = full; anything between draws a partial via a clip width.
    const fill = Math.max(0, Math.min(1, value - (i - 1)));
    const star = h('span', { class: 'star' });
    star.style.width = `${size}px`;
    star.style.height = `${size}px`;
    // The glyph is drawn by ::before at 1.18em, so the tile's own font-size is what sizes
    // it. Setting the box without setting this would clip every star to a corner.
    star.style.fontSize = `${size}px`;
    const back = h('span', { class: 'star-back' });
    const front = h('span', { class: 'star-front' });
    front.style.width = `${Math.round(fill * 100)}%`;
    star.append(back, front);
    row.appendChild(star);
  }
  return row;
}

/**
 * The card's rating line: stars, the mean, the sample size, and the sample label.
 *
 * AN UNRATED TRAIL GETS NO ROW AT ALL, and this is the single most consequential visual
 * decision in the UGC pass. Almost nothing is rated on day one, so whatever this function
 * returns for the empty case is what most of the list looks like.
 *
 * The alternatives were an empty five-star row, which is a lie shaped like a rating and
 * reads as a zero-star review; and a quiet "No ratings yet" on every card, which was
 * tried and rejected because eighty repetitions of a negative down one scroll is a wall
 * of apology, and a screen that keeps announcing what it does not have looks broken
 * rather than honest.
 *
 * Returning nothing leaves the unrated card as hero, pill, name, measures: complete,
 * deliberate, and carrying everything this product actually knows. The rated few then
 * stand out because they alone carry stars, which IS the finding. The absence is not
 * hidden: it is stated once in the list header when Top rated is active, and once on the
 * peek. Said once in the right place beats said eighty times in the wrong one.
 */
export function ratingLine(ratingAvg: number | null, ratingCount: number): HTMLElement | null {
  if (ratingAvg === null || ratingCount === 0) return null;
  return h(
    'div',
    { class: 'rating' },
    starGlyphs(ratingAvg, 14),
    h('span', { class: 'r-avg' }, ratingAvg.toFixed(1)),
    h('span', { class: 'r-count' }, `(${ratingCount.toLocaleString('en-US')})`),
  );
}

/** Five tappable stars. `value` is the reader's own rating, or null. */
export function starPicker(value: number | null, onPick: (stars: number) => void): HTMLElement {
  const row = h('div', { class: 'star-pick', role: 'group', 'aria-label': 'Your rating' });
  for (let i = 1; i <= 5; i++) {
    const on = value !== null && i <= value;
    const btn = h('button', { type: 'button', class: `sp-star${on ? ' on' : ''}`, 'aria-label': `${i} star${i === 1 ? '' : 's'}` });
    btn.setAttribute('aria-pressed', String(on));
    btn.addEventListener('click', () => onPick(i));
    row.appendChild(btn);
  }
  return row;
}

/** One measure in the peek sheet's measures row: glyph, value, label. */
export function measure(glyphName: string, value: string, label: string): HTMLElement {
  return h(
    'div',
    { class: 'msr' },
    h('div', { class: 'msr-top' }, icon(glyphName, 14), h('span', {}, value)),
    h('div', { class: 'msr-label' }, label),
  );
}

// ============================================================================
// SHEETS
// ============================================================================

export interface SheetOpts {
  title: string;
  /** Rendered right of the title, usually a clear-all control. */
  action?: HTMLElement | null;
  onClose: () => void;
  /** Sticky footer, usually the live result count. */
  footer?: HTMLElement | null;
  class?: string;
}

/** A bottom sheet with a grab handle, a titled header and a scrolling body. */
export function sheet(opts: SheetOpts, ...body: (Node | null)[]): HTMLElement {
  const close = h('button', { type: 'button', class: 'sh-close', 'aria-label': 'Close' }, icon('close', 16));
  close.addEventListener('click', opts.onClose);

  return h(
    'div',
    { class: `sh ${opts.class ?? ''}` },
    h('div', { class: 'sh-grab' }),
    h(
      'div',
      { class: 'sh-head' },
      h('div', { class: 'sh-title' }, opts.title),
      opts.action ?? null,
      close,
    ),
    h('div', { class: 'sh-body' }, ...body.filter((n): n is Node => n != null)),
    opts.footer ?? null,
  );
}

/**
 * A tappable option row: label, optional help line, selected tick.
 *
 * `tag` is a short mono marker beside the label. It exists for one job: marking a condition
 * filter that is answering a coarser question than its label promises on the selected day.
 */
export function optionRow(
  label: string,
  selected: boolean,
  onPick: () => void,
  help?: string,
  glyph?: string,
  tag?: string,
): HTMLElement {
  const row = h(
    'button',
    { type: 'button', class: `opt-row${selected ? ' on' : ''}` },
    glyph ? icon(glyph, 16, 'opt-glyph') : null,
    h(
      'span',
      { class: 'opt-body' },
      h(
        'span',
        { class: 'opt-line' },
        h('span', { class: 'opt-label' }, label),
        tag ? h('span', { class: 'opt-tag' }, tag) : null,
      ),
      help ? h('span', { class: 'opt-help' }, help) : null,
    ),
    selected ? icon('check', 15, 'opt-check') : null,
  );
  row.setAttribute('aria-pressed', String(selected));
  row.addEventListener('click', onPick);
  return row;
}

/** A filter chip. `value` renders as the chip's second line of meaning. */
export function chip(
  label: string,
  on: boolean,
  onTap: () => void,
  opts: { value?: string; badge?: number; caret?: boolean; glyph?: string } = {},
): HTMLElement {
  const el = h(
    'button',
    { type: 'button', class: `f-chip${on ? ' on' : ''}` },
    opts.glyph ? icon(opts.glyph, 13, 'fc-glyph') : null,
    h('span', { class: 'fc-label' }, label),
    opts.value ? h('span', { class: 'fc-value' }, opts.value) : null,
    typeof opts.badge === 'number' && opts.badge > 0 ? h('span', { class: 'fc-badge' }, String(opts.badge)) : null,
    opts.caret ? icon('chevron', 12, 'fc-caret') : null,
  );
  el.setAttribute('aria-pressed', String(on));
  el.addEventListener('click', onTap);
  return el;
}
