// Trail mode — Concept A, the journey on a pitched 3D map.
//
// Reuses `PhoneMap` (src/scope/phone/pmap.ts) WHOLESALE rather than building a second map
// stack: same terrain source, same camera constants (PITCH/MAX_PITCH/EXAGGERATION), same
// DEM-unreachable fallback, same keyless tiles. pmap.ts is touched only additively, for two
// shared pieces this module and the peek map (and, for one of them, the results map too)
// need without moving anything for callers that never ask for it: `fitBBoxWhenSettled`
// (existing) and `setLineWeight`/`fitBBox`'s new `extraBottom` (added alongside this
// change). Nothing about pmap.ts's existing behaviour for either of the OTHER two callers
// changes — see the doc comments at those two additions in pmap.ts itself.
//
// This module only adds the two things pmap.ts's own use case (a results list, many
// trails, one colour per trail keyed to a condition grade) does not need: markers along a
// SINGLE trail carrying the journey's own vocabulary of places and times, and a route line
// heavy enough to read as the dominant mark on the screen rather than one line among many.
//
// MARKERS ARE MINIMAL AND TYPED, NOT CARDS. The previous build put one full AIR+GROUND
// card directly on the map, anchored to a point, and Björn's screenshot showed exactly the
// failure that invites: the card sat on top of the route it was describing. The fix is not
// a smarter anchor, it is to stop putting prose on the map at all. Every point gets one
// small badge (time, weather glyph, temperature) and a tap for more; the two AIR+GROUND
// numbers live in the DOCK strip at the bottom of the frame instead (`trail/markerui.ts`'s
// `renderDock`, shared with Concept B's chart — see that module's header for why a strip,
// not a popover, and why the two concepts cluster markers differently despite sharing
// everything downstream of a group).
//
// A DOT ON THE POINT, ONE CARD OFF THE LINE (TRAIL_PLAN §13). This is the third attempt at
// one problem, and it is worth stating what the first two got wrong, because the shape of
// this file is the answer to it:
//
//   §11 pushed the marker's time LABEL clear of the route with an eight-direction,
//   four-radius clearance search. Line overlap went to zero and the marker stopped marking
//   anything, because the search kept moving it until it no longer sat where it named.
//   §12 reverted that and anchored the whole badge back on its point. The marker marked its
//   place again, and three badges — 78 x 51 px each, because a merged group prints two clock
//   times — covered a measured 69% of the rendered route line's own pixels.
//
// Both failed for one reason: the anchor and the card were the same object. So they are two
// objects now. A 34 px dot holds the point (`markerui.ts`'s `markerDot`); the SELECTED
// marker, and only it, also gets a card offset off the line with a short leader
// (`markerCard`, placed by `placeOpenCard` below). Two thirds of the furniture disappears
// with the two unopened cards, and what is left is a dot whose whole area is smaller than
// the old badge's.
//
// THE OFFSET DIRECTION IS READ OFF THE LINE, NOT PICKED FROM A COMPASS. §11's search walked
// eight fixed screen directions, several of which run ALONG a diagonal trail and so cannot
// get clear of it at any radius, which is part of why it needed such large radii to succeed
// and why it ended up so far from its own point. This one projects the trail's real,
// full-resolution geometry to screen, takes the local tangent at the anchor, and offsets
// perpendicular to it — so the card leaves the trail by the shortest route available, and the
// leader stays short. Which of the two perpendicular sides it takes is decided by counting
// line pixels on each, so a switchback on the far side cannot be walked into.
//
// No MapLibre symbol/text layer is used anywhere here, on purpose: pmap.ts's style has no
// `glyphs` source (it is a raster basemap plus a DEM, nothing that ships font ranges), so a
// `text-field` layer would silently draw no text. HTML markers sidestep that entirely and
// render in the page's own fonts, which is also what makes them Playwright-inspectable as
// real DOM elements — and, now that they are real `<button>`s, keyboard-focusable ones —
// rather than canvas pixels.

import maplibregl from 'maplibre-gl';
import { h } from '../ui/dom';
import { haversineMeters } from '../data/merge';
import {
  PhoneMap,
  crossesTreeline as routeCrossesTreeline,
  geometryParts,
  treelineExposedFeature,
} from '../scope/phone/pmap';
import { routeSamplePoints } from '../scope/weather/provider';
import type { RoutePoint, WeatherProvider } from '../scope/types';
import type { Units } from '../types';
import type { Journey, MarkerKind } from './journey';
import { isOutlook, isPassed, type OnRoute } from './onroute';
import {
  buildMarkerGroups,
  createMarkerController,
  markerCard,
  markerDot,
  MERGE_RADIUS_M,
  positionMarker,
  type MarkerGroup,
} from './markerui';

/** Same four storm-band colours as route.css's `--lv-0..3` (themselves a duplicate of
 *  phone/phone.css's `.st-cell.lv-*`, for the reason stated there: the source module's
 *  copy is private, and unifying is future work if trail mode graduates). A third copy
 *  here because MapLibre paint expressions and marker CSS need real hex, not a custom
 *  property resolved through the page's stylesheet. */
const LV_COLOR: [string, string, string, string] = ['#c7d4c9', '#e7b563', '#d9932f', '#a8402b'];

/** The line's colour when no part of the walk that is still ahead sits inside the cached run's
 *  hourly reach. Deliberately OUTSIDE the four-band ramp rather than a fifth step on it: the
 *  bands measure storm probability, and "we cannot say" is not a low value of that, it is the
 *  absence of the measurement. A neutral slate reads as unpainted next to any of the four. */
const LV_OUTLOOK_COLOR = '#b9bdb7';

type NumExpr = maplibregl.DataDrivenPropertyValueSpecification<number>;

/**
 * The journey's own line, drawn heavier than the results map's many-trails-at-once
 * default and with a wider white halo, because on a 366 px frame over hillshaded terrain
 * a single route has to read as the dominant mark on the screen (Björn's original
 * complaint, "I don't see the route") over BOTH a pale slope and a dark, shadowed one. The
 * halo is doing the real work here: a wider white casing is what keeps the tinted core
 * legible against terrain of either brightness, not the core's own colour. Set via
 * `PhoneMap.setLineWeight`, which is scoped to this one instance — see that method's own
 * comment in pmap.ts for why the results map and the peek map are untouched by it.
 */
const ROUTE_HALO_WIDTH: NumExpr = ['interpolate', ['linear'], ['zoom'], 9, 6, 15, 12] as unknown as NumExpr;
const ROUTE_CORE_WIDTH: NumExpr = ['interpolate', ['linear'], ['zoom'], 9, 3.2, 15, 6.5] as unknown as NumExpr;

/**
 * Bottom clearance asked of `fitBBoxWhenSettled` so the tight trail frame never seats the
 * route underneath the docked strip. `.cx-dock`'s own height in route.css is
 * content-driven (title line plus two reading rows, no fixed height), and comes out
 * around 65 px for a typical reading; this is deliberately larger, not an exact match, so
 * a slightly longer group title (a merged treeline crossing reading "Above treeline /
 * Below treeline") still has margin to grow into without the map having under-cleared it.
 */
export const DOCK_HEIGHT_PX = 78;

/** Dense, exact lookup: `routeSamplePoints` at the profile's own sample count returns
 *  points at fracs `k/(profLen-1)`, the SAME fracs `buildJourney` assigns to waypoints, so
 *  indexing by `round(frac*(profLen-1))` is an exact hit, not an interpolation. */
function trailGeometryPoints(j: Journey): RoutePoint[] {
  const n = Math.max(2, j.trail.profile?.length ?? 5);
  return routeSamplePoints(j.trail, n);
}

/** Marker groups, positioned. Concept A clusters by GEOGRAPHIC proximity — see
 *  markerui.ts's header note on why this differs from Concept B's travel-distance rule —
 *  which is what collapses an out-and-back's shared depart/finish trailhead into one pin. */
function clusterMarkers(j: Journey, points: RoutePoint[]): { group: MarkerGroup; lngLat: [number, number] }[] {
  const withPos = j.markers.map((m) => {
    const wp = j.waypoints.reduce((a, b) =>
      Math.abs(b.travelM - m.travelM) < Math.abs(a.travelM - m.travelM) ? b : a,
    );
    const idx = Math.min(points.length - 1, Math.max(0, Math.round(wp.frac * (points.length - 1))));
    return { marker: m, lngLat: points[idx].lngLat };
  });
  withPos.sort((a, b) => a.marker.travelM - b.marker.travelM);
  return buildMarkerGroups(withPos, (a, b) => haversineMeters(a.lngLat, b.lngLat), MERGE_RADIUS_M).map(
    ({ group, anchor }) => ({ group, lngLat: anchor.lngLat }),
  );
}

// ============================================================================
// SCREEN GEOMETRY — where an open card is allowed to sit
// ============================================================================
//
// Everything in this block exists to answer one question: given a dot at a projected point,
// which way is "off the line" and how far. It works on the trail's REAL geometry projected to
// screen, not on the 48-sample profile the markers are anchored to, because the profile is a
// resampling for reading elevation and says nothing about the switchbacks between two of its
// samples — and a switchback is exactly what a card offset perpendicular to a coarse tangent
// would land on.

interface Pt {
  x: number;
  y: number;
}

/** A rectangle in the map container's own pixel space, which is what `map.project` returns
 *  coordinates in. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * TREELINE, ROUTE-RELATIVE — the spans, the slicing and the dashed overlay all MOVED, and
 * this note is what is left of them here.
 *
 * They now live in `scope/phone/pmap.ts` (see its TREELINE, ROUTE-RELATIVE block, which
 * carries the full reasoning: why this is not a DEM contour, why it is traversal-independent,
 * and how it degrades to nothing in the Ozarks). The move happened when the discovery peek's
 * own map needed the same mark: `src/trail` imports from `src/scope` and never the reverse,
 * and pmap.ts is already the map class both surfaces mount, so it is the only home that does
 * not duplicate the logic or invert the dependency. `geometryParts` went with them, and this
 * module now imports it back for the screen projection its card placement needs.
 *
 * NOTHING ABOUT WHAT THIS FRAME DRAWS CHANGED. The overlay is added with the same ink, the
 * same dash array and the same width expression it always had — `ROUTE_EXPOSED_WIDTH` below
 * is the literal that used to sit inline — because this map's core line is heavier than
 * pmap.ts's default (`setLineWeight`, above) and the dash has to stay narrower than whatever
 * it sits on.
 */
export function crossesTreeline(j: Journey): boolean {
  return routeCrossesTreeline(j.trail, j.region.treelineM);
}

/** Concept A's own dash width, unchanged: about half of `ROUTE_CORE_WIDTH`, which is the
 *  ratio pmap.ts's default now mirrors against its own lighter core. */
const ROUTE_EXPOSED_WIDTH: NumExpr = ['interpolate', ['linear'], ['zoom'], 9, 1.6, 15, 3.2] as unknown as NumExpr;

/** Ceiling on projected vertices per layout pass. Flattop is well under it, but this runs on
 *  camera moves and the geometry is whatever OSM shipped, so the cost is bounded by a stride
 *  rather than by hope. A stride only ever drops detail BETWEEN kept vertices; both endpoints
 *  of every part are always kept, so a part can never vanish. */
const LINE_SAMPLE_BUDGET = 600;

/**
 * The trail as screen-space polylines at the camera's current state. `map.project` accounts
 * for terrain elevation when a DEM is loaded, so these are where the line is actually PAINTED
 * on a pitched, exaggerated terrain map — not where a flat-map projection would put it. That
 * distinction is the same one TRAIL_PLAN §11 records for `fitBounds`, and it is why this is
 * recomputed as tiles arrive rather than once at mount.
 */
function projectTrailToScreen(map: maplibregl.Map, parts: number[][][]): Pt[][] {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const stride = Math.max(1, Math.ceil(total / LINE_SAMPLE_BUDGET));
  return parts.map((coords) => {
    const out: Pt[] = [];
    for (let i = 0; i < coords.length; i += stride) {
      const p = map.project(coords[i] as [number, number]);
      out.push({ x: p.x, y: p.y });
    }
    const last = map.project(coords[coords.length - 1] as [number, number]);
    out.push({ x: last.x, y: last.y });
    return out;
  });
}

/** Vertices either side of the nearest one that the tangent is measured across. One vertex
 *  each way is too local on dense geometry — two consecutive OSM nodes can be a metre apart,
 *  which at this zoom is sub-pixel and yields a direction that is pure rounding noise. Three
 *  each way averages over a few metres of trail, which is the scale the card's own size makes
 *  relevant anyway. */
const TANGENT_WINDOW = 3;

/**
 * The direction the trail runs, on screen, at `at`. Returns a unit vector, or a horizontal
 * fallback when the geometry is degenerate (a single-vertex part, or a window that projects to
 * one pixel) — horizontal, so the perpendicular is vertical and the card goes straight up or
 * down, which is the least-wrong guess on a frame that is much taller than it is wide.
 */
function localScreenTangent(screen: Pt[][], at: Pt): Pt {
  let bestPart = 0;
  let bestIdx = 0;
  let bestD2 = Infinity;
  for (let p = 0; p < screen.length; p++) {
    for (let i = 0; i < screen[p].length; i++) {
      const d2 = (screen[p][i].x - at.x) ** 2 + (screen[p][i].y - at.y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestPart = p;
        bestIdx = i;
      }
    }
  }
  const part = screen[bestPart] ?? [];
  const a = part[Math.max(0, bestIdx - TANGENT_WINDOW)];
  const b = part[Math.min(part.length - 1, bestIdx + TANGENT_WINDOW)];
  if (!a || !b) return { x: 1, y: 0 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** How far outside a candidate card's own edges a line vertex still counts as a collision.
 *  The line is drawn up to 6.5 px wide with a 12 px halo (ROUTE_CORE_WIDTH /
 *  ROUTE_HALO_WIDTH), and a vertex is its CENTRELINE, so clearing the box by half the halo is
 *  what actually clears the drawn mark rather than its centre. */
const CARD_CLEARANCE_PX = 7;

function rectAround(c: Pt, w: number, h: number): Rect {
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** Line vertices falling inside `rect`, grown by `CARD_CLEARANCE_PX`. The count, not a
 *  boolean, so a candidate that cannot avoid the line entirely can still be ranked against
 *  one that grazes it. */
function lineVerticesIn(screen: Pt[][], rect: Rect): number {
  const x0 = rect.x - CARD_CLEARANCE_PX;
  const x1 = rect.x + rect.w + CARD_CLEARANCE_PX;
  const y0 = rect.y - CARD_CLEARANCE_PX;
  const y1 = rect.y + rect.h + CARD_CLEARANCE_PX;
  let n = 0;
  for (const part of screen) {
    for (const p of part) {
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) n++;
    }
  }
  return n;
}

function overlapArea(a: Rect, b: Rect): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

/** Pixels of `r` that fall outside `host`, summed per side. A card half off the frame is not
 *  covering the route, so this is a separate cost from a line collision rather than the same
 *  one — but it still has to be a cost, because a card clipped by the frame edge is a card
 *  the reader cannot read. */
function outsideBy(r: Rect, host: Rect): number {
  return (
    Math.max(0, host.x - r.x) +
    Math.max(0, host.y - r.y) +
    Math.max(0, r.x + r.w - (host.x + host.w)) +
    Math.max(0, r.y + r.h - (host.y + host.h))
  );
}

/** The gaps, in px, between the dot's own edge and the card's nearest edge that the search
 *  tries, in order of preference. Short, and few, on purpose: a long leader is worse than a
 *  small overlap, because past a certain length the eye stops trusting which dot the card
 *  belongs to and the card stops being an annotation of that point. 11 px is enough to read as
 *  a gap; 25 px is about as far as a leader can go on a 350 px frame before it reads as a
 *  connector between two independent things. */
const LEADER_GAPS_PX = [11, 18, 25];

/**
 * Places one open card and its leader, relative to the dot the card belongs to.
 *
 * The search is deliberately tiny — two directions (the two sides of the trail) times three
 * gaps — and it is a search over DISTANCE ALONG ONE AXIS, not over a compass. §11's failure
 * came from searching eight directions at four radii: 32 candidates, most of them not
 * perpendicular to anything, and the scoring had no term that cared how far the label had
 * travelled from its own point. Here the axis is fixed by the trail's local tangent, the
 * shortest gap that works wins, and the dot never moves at all, so there is no "too far" to
 * over-correct into.
 *
 * `d` is measured to the card's CENTRE, via the rectangle's support function along the
 * normal (`|nx| w/2 + |ny| h/2`): that is the distance from centre to the edge in exactly the
 * direction of travel, so the requested gap is the gap the reader sees whether the card leaves
 * the line sideways, vertically or on a diagonal.
 */
function placeOpenCard(
  map: maplibregl.Map,
  screen: Pt[][],
  host: Rect,
  dockRect: Rect,
  lngLat: [number, number],
  dot: HTMLElement,
  card: HTMLElement,
  lead: HTMLElement,
): void {
  const at = map.project(lngLat);
  const t = localScreenTangent(screen, { x: at.x, y: at.y });
  const sides: Pt[] = [
    { x: -t.y, y: t.x },
    { x: t.y, y: -t.x },
  ];
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  // The dot's own half-width is the leader's hidden root: the leader is drawn from the anchor
  // point outward, so its first `r0` px sit under the disc and only the rest reads as a gap.
  const r0 = dot.offsetWidth / 2;

  let best: { score: number; n: Pt; d: number; gap: number } | null = null;
  for (const gap of LEADER_GAPS_PX) {
    for (const n of sides) {
      const d = r0 + gap + (Math.abs(n.x) * w) / 2 + (Math.abs(n.y) * h) / 2;
      const rect = rectAround({ x: at.x + n.x * d, y: at.y + n.y * d }, w, h);
      // Three costs, in strict priority order by weight: a line collision is the bug being
      // fixed and dominates everything; leaving the frame or sliding under the dock strip
      // makes the card unreadable and is next; and among candidates that are equal on both,
      // the shortest leader wins. `gap` as the final term is what keeps the leader short
      // rather than merely legal.
      const score =
        lineVerticesIn(screen, rect) * 1000 +
        (outsideBy(rect, host) + (overlapArea(rect, dockRect) / (w * h)) * 40) * 10 +
        gap;
      if (!best || score < best.score) best = { score, n, d, gap };
    }
  }
  if (!best) return;

  card.style.transform = `translate(-50%, -50%) translate(${(best.n.x * best.d).toFixed(1)}px, ${(best.n.y * best.d).toFixed(1)}px)`;
  lead.style.width = `${(r0 + best.gap).toFixed(1)}px`;
  lead.style.transform = `rotate(${Math.atan2(best.n.y, best.n.x).toFixed(4)}rad)`;
}

/** The map's own trail line: one feature, coloured by the worst storm band the journey
 *  actually met. Built as a raw feature rather than through pmap.ts's `trailFeature` (which
 *  takes a whole-trail `ConditionGrade`, the discovery list's one-colour-per-trail model)
 *  because a single journey's worst band is a different, and simpler, fact than a route's
 *  overall grade, and inventing a fake `ConditionGrade` just to reach a colour would be the
 *  second map implementation this module exists to avoid. */
function trailLineFeature(o: OnRoute): GeoJSON.Feature {
  const j = o.journey;
  // THE WORST BAND STILL IN FRONT OF THE READER, AND STILL CLAIMABLE. `j.levelCounts` is the
  // whole walk, which is the right answer while planning and the wrong one at 12:30: a band met
  // at 11:30 is a fact about the reader's morning, not about their afternoon, and colouring the
  // line by it would have the map answering a question the walker has already walked past.
  // Waypoints past the cached run's reach drop out for the other reason — the run has no right
  // to name a band that far ahead — and if that empties the set the line goes neutral rather
  // than falling back to a band nothing supports.
  let worst = -1;
  for (const w of j.waypoints) {
    if (isPassed(o, w.hour) || isOutlook(o, w.hour)) continue;
    worst = Math.max(worst, w.level);
  }
  return {
    type: 'Feature',
    geometry: j.trail.geometry,
    properties: {
      __id: j.trail.id,
      __name: j.trail.name,
      __color: worst >= 0 ? LV_COLOR[worst] : LV_OUTLOOK_COLOR,
    },
  };
}

export interface ConceptAHandle {
  destroy(): void;
}

/**
 * Mounts Concept A's map into `container`, which must already be in the live DOM with a
 * real, non-zero size (see route.ts: it is appended before this is called). `dock` is the
 * docked detail strip's own element, a sibling of `container` inside the same
 * `.cx-mapwrap` (route.ts builds both); this module owns filling it, never creating it, so
 * route.ts stays the one place that decides page layout.
 *
 * `selectedKind` is the marker the reader last tapped, carried in route.ts's own state
 * across a traversal rebuild (this whole map is torn down and remounted on one, so nothing
 * here can remember it on its own); `null` means "nothing tapped yet". `onSelect` reports
 * back whichever marker actually ends up selected — the requested one, or the default it
 * fell back to — so route.ts's state can never drift from what is genuinely on screen.
 */
export function mountConceptAMap(
  container: HTMLElement,
  dock: HTMLElement,
  o: OnRoute,
  provider: WeatherProvider,
  units: Units,
  selectedKind: MarkerKind | null,
  onSelect: (kind: MarkerKind) => void,
): ConceptAHandle {
  const j = o.journey;
  // Constructed on the REGION's bbox, not the trail's, even though the trail is all this
  // map ever shows: the same fix `scope/phone/peek.ts`'s own single-trail map already
  // needed, and now the second call site rather than a rediscovery of it. Seeding the
  // camera directly at a tight single-trail bbox, pitched and terrain-exaggerated, on the
  // very first frame renders a genuinely blank canvas (verified empirically, see
  // `fitBBoxWhenSettled`'s own doc comment in pmap.ts). Region scale here just seeds the
  // DEM pyramid at a sane zoom; the tight fit below is what actually frames the trail.
  const pmap = new PhoneMap(container, { bbox: j.region.bbox, onPick: () => undefined });
  const markers: maplibregl.Marker[] = [];
  // Detaching the two camera listeners is not optional housekeeping: route.ts tears this whole
  // map down and mounts a fresh one on every traversal change, and a listener left bound to a
  // destroyed map's markers is a leak that grows one copy per toggle.
  let cleanup: () => void = () => undefined;

  pmap.whenReady(() => {
    pmap.setTrails([trailLineFeature(o)]);
    pmap.setLineWeight(ROUTE_CORE_WIDTH, ROUTE_HALO_WIDTH);
    // The dash overlay, from pmap.ts's shared implementation rather than this module's own
    // copy of it (see the TREELINE, ROUTE-RELATIVE note above). Still added AFTER the trail
    // layers exist, so the dashes sit on top of the core rather than under it, and still a
    // no-op where the route never leaves the trees or the region has no treeline at all.
    // `j.trail`, not a traversal-adjusted copy: the exposed stretch is a fact about the
    // hillside, not about the walk.
    pmap.setExposedOverlay(treelineExposedFeature(j.trail, j.region.treelineM), ROUTE_EXPOSED_WIDTH);
    // Tighter than app.ts's own 60 px single-trail default: that view has no permanent
    // markers competing for room, this one does, and the extra zoom it buys is screen-space
    // separation between markers that are hundreds of metres apart on the ground but only
    // tens of pixels apart in a whole-trail overview at pitch. Raced against a timeout
    // rather than fit immediately (`fitBBoxWhenSettled`, pmap.ts): a real `idle` first, so
    // the tight frame lands on a camera that has actually painted at the region scale, a
    // timeout so a DEM outage can never hang the fit, and `DOCK_HEIGHT_PX` of extra bottom
    // clearance so the dock strip never seats itself over the route.
    pmap.fitBBoxWhenSettled(j.trail.bbox, 42, 2500, DOCK_HEIGHT_PX);

    const points = trailGeometryPoints(j);
    const positioned = clusterMarkers(j, points);
    const groups = positioned.map((p) => p.group);
    const controller = createMarkerController(dock, groups, selectedKind, o, provider, units, onSelect);
    const parts = geometryParts(j.trail.geometry);

    /** One mounted marker: the dot that holds the point, plus the card and leader that only
     *  the selected one shows. Cards are built for every group and hidden, rather than created
     *  on selection, so opening one is a class toggle and a transform — nothing measures or
     *  lays out at the moment of a tap, which is when a reader would see it. */
    interface Slot {
      lngLat: [number, number];
      wrap: HTMLElement;
      dot: HTMLElement;
      card: HTMLElement;
      lead: HTMLElement;
    }
    let openSlot: Slot | undefined;

    for (const { group, lngLat } of positioned) {
      const dot = markerDot(group, o, provider, units, group.id === controller.current());
      const card = markerCard(group, o, provider, units);
      const lead = h('span.cx-mlead', { 'aria-hidden': 'true' });
      // The marker element handed to MapLibre is a WRAPPER, not the button, and the card and
      // leader inside it are absolutely positioned — so the wrapper's own rendered box is
      // exactly the dot's box, and `anchor: 'center'` still centres the DOT on `lngLat`
      // however far the card is offset. That is the whole mechanical trick behind separating
      // the anchor from the card: the card is not in the layout that decides the anchor.
      const wrap = h('div.cx-mk', {}, dot, lead, card);
      const mk = new maplibregl.Marker({ element: wrap, anchor: 'center' }).setLngLat(lngLat).addTo(pmap.map);
      markers.push(mk);
      const slot: Slot = { lngLat, wrap, dot, card, lead };
      controller.register(group, dot, (on) => {
        wrap.classList.toggle('is-open', on);
        // The open marker is raised above its neighbours: MapLibre mounts markers as siblings
        // in DOM order, so without this a later dot would paint over an earlier dot's card.
        wrap.style.zIndex = on ? '3' : '1';
        if (on) {
          openSlot = slot;
          layout();
        }
      });
    }

    // WHERE THE READER IS STANDING, mounted last so it paints over any dot it happens to
    // coincide with: on an out-and-back the walker's position at 12:30 sits a minute short of
    // the treeline crossing, and the one mark on this frame that is about the reader rather
    // than about the trail has to win that overlap.
    //
    // NOTHING ELSE ON THE MAP MARKS THE WALKED PORTION, and that is a finding rather than an
    // omission (TRAIL_PLAN §14). On an out-and-back the ground behind the walker is also the
    // ground in front of them: the return leg retraces the same geometry, so a muted "already
    // walked" casing on this line would be muting trail the reader has still to cover. The
    // profile chart CAN say it, because its x axis is travel distance and the outbound and
    // return legs occupy different halves of it, and that is where §1's hatched walked portion
    // is drawn. The map says it with a position and with muted markers behind that position,
    // which is the most the geometry honestly supports.
    if (o.started) {
      const me = positionMarker(o, provider, units);
      const idx = Math.min(points.length - 1, Math.max(0, Math.round(o.atFrac * (points.length - 1))));
      markers.push(new maplibregl.Marker({ element: me, anchor: 'center' }).setLngLat(points[idx].lngLat).addTo(pmap.map));
    }

    /**
     * Re-places the open card. Called on selection, and again whenever the camera or the
     * terrain under it has changed, because both move where the line is PAINTED and therefore
     * which side of it has room. The dot needs none of this — MapLibre keeps a real
     * `maplibregl.Marker` on its own lngLat through every pan, zoom, rotate and DEM update,
     * which is exactly why the dot, and not the card, is what holds the point.
     */
    function layout(): void {
      if (!openSlot) return;
      const screen = projectTrailToScreen(pmap.map, parts);
      const hostBox = container.getBoundingClientRect();
      const dockBox = dock.getBoundingClientRect();
      placeOpenCard(
        pmap.map,
        screen,
        { x: 0, y: 0, w: hostBox.width, h: hostBox.height },
        { x: dockBox.x - hostBox.x, y: dockBox.y - hostBox.y, w: dockBox.width, h: dockBox.height },
        openSlot.lngLat,
        openSlot.dot,
        openSlot.card,
        openSlot.lead,
      );
    }

    controller.finish();

    // WHEN TO RE-LAY-OUT, and why it is not simply "every render". `render` fires continuously
    // while terrain tiles arrive, and a full pass projects the whole geometry, so it is gated
    // on the camera actually having moved. But a camera signature cannot see a DEM tile
    // landing, and `map.project` answers differently once it can read a real elevation under
    // the point — so `idle` runs a pass unconditionally. `idle` is rare and is the event that
    // fires after the terrain settles, which is precisely the case the signature misses.
    let cameraKey = '';
    const onRender = (): void => {
      const c = pmap.map.getCenter();
      const key = `${c.lng},${c.lat},${pmap.map.getZoom()},${pmap.map.getBearing()},${pmap.map.getPitch()}`;
      if (key === cameraKey) return;
      cameraKey = key;
      layout();
    };
    pmap.map.on('render', onRender);
    pmap.map.on('idle', layout);
    cleanup = () => {
      pmap.map.off('render', onRender);
      pmap.map.off('idle', layout);
    };
  });

  // The container has real CSS dimensions from the moment it is appended (route.ts
  // appends the whole frame before calling this), but MapLibre's own first paint can still
  // land a frame before layout settles on some browsers; one resize on the next frame is
  // the same defensive call src/scope/phone/app.ts makes after unhiding its map layer.
  requestAnimationFrame(() => pmap.resize());

  return {
    destroy: () => {
      cleanup();
      for (const mk of markers) mk.remove();
      pmap.destroy();
    },
  };
}
