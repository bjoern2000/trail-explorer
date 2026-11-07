// Weather-on-route — the on-route screen, leading with the map.
//
// Promoted 2026-08-10 from a three-way concept jam (a page kept out of the main nav under
// its own URL) into a named section of the main nav. That changes what this file argues: it used
// to present three concepts side by side so the trade between them was visible instead of
// argued about. The map won that argument (TRAIL_PLAN §8's read: "A as the screen, C as
// its map tab" was the plan-level call, in that jam's own lettering, but the map is what a
// product leadership audience needs to touch first), so this page now leads with the map
// as Concept A, THE screen. Concepts B and C — the elevation profile and the table, A and
// B in the jam's lettering — are demoted to a short "kept as alternatives" pair near the
// end: still real, still wired to the same live traversal control, just no longer the
// thing the reader is asked to compare against. Renumbered 2026-08-10, by page order, so
// the source and the screen can never name a concept two different ways.
//
// WHY THE RENDER IS STILL DATA-TRUE RATHER THAN DRAWN
//
// A hand-drawn mockup of a weather chart always looks good, because the person drawing
// it chooses the numbers. That is exactly the failure mode SCOPE_PLAN §8 kept finding:
// the naive loop share looked fine until the topology was checked, the flagship gains
// looked fine until the way direction was checked. So every concept renders from a real
// `Journey` over real derived geometry and real (simulated) forecast, and every number in
// the prose is interpolated from that same object at render time. No exceptions: compressing
// the copy for this promotion cut sentences, never numbers.
//
// ONE LIVE CONTROL, EVERYWHERE IT APPEARS. TRAIL_PLAN §10 answers the question this page
// used to leave open — does trail mode assume a round trip, or ask? — with a traversal
// pill wired for real inside the phone frame. It appears in all three concepts (the
// primary map and both demoted alternatives), and picking a traversal rebuilds the
// `Journey` (journey.ts's `buildJourney`) and re-renders every one of them from the new
// one, because a toggle that only moved the drawing in the frame the reader happened to be
// looking at would not demonstrate the answer it exists to give.
//
// COPY BUDGET. The promoted page carries a hard word budget on rendered prose (see the
// section bodies below): claims stay, the reasoning that justified each design decision
// does not. TRAIL_PLAN.md is where that reasoning still lives; this file states results.
//
// TWO ANCHORS, AND THE STATE THE SECOND ONE IS MET IN (2026-08-26). TRAIL_PLAN §1's first
// decision was one screen with two anchors — the same artifact read either against a departure
// you pick or against now — and §10 records that the second anchor was deleted, code included,
// when this page was restructured map-first. It is back, and it is back joined to the cached
// forecast, because those are one situation rather than two features: most US trails have no
// signal, so being three quarters of the way up one is exactly when the run in your pocket
// stopped being current. `src/trail/onroute.ts` holds the model for both; this file draws it.
// The page's default load is untouched by it (planning, online), which is deliberate — the
// second anchor is a state to switch into, not a change to the screen a reader meets first.
//
// MARKERS AND THE DOCK ARE ONE IMPLEMENTATION, READ TWICE. Concepts A and B both draw the
// journey's marker set and both hand a tapped marker's reading to a docked detail strip;
// `trail/markerui.ts` is where that vocabulary lives, so a reader comparing the map
// against the chart is comparing two views of one journey rather than learning two
// different UIs. See that module's header for why a dock rather than a popover, and why
// the two concepts cluster nearby markers by different distance metrics.

import '../tokens.css';
import './route.css';

import { mountNav } from '../ui/nav';
import { h } from '../ui/dom';
import { deviceFrame } from '../ui/phone-frame';
import { icon, weatherGlyph } from '../scope/phone/ui';
import { displaySet } from '../scope/data';
import { NO_TREELINE_M, REGIONS, formatElevation, formatLength, formatSpeed, formatTemp } from '../scope/model';
import { simulatedProvider } from '../scope/weather/simulated';
import type { RegionId, RouteType, ScopeTrail, WeatherProvider } from '../scope/types';
import type { Units } from '../types';
import { paceDef, type PaceId } from './pace';
import {
  buildJourney,
  defaultTraversal,
  journeyClock,
  journeyDuration,
  tableRows,
  traversalOptions,
  TRAVERSAL_LABEL,
  type Journey,
  type Marker,
  type MarkerKind,
  type Traversal,
} from './journey';
import {
  buildOnRoute,
  cacheAgeHours,
  isOutlook,
  isPassed,
  ONROUTE_ELAPSED_H,
  reachSentence,
  type OnRoute,
} from './onroute';
import { crossesTreeline, mountConceptAMap, type ConceptAHandle } from './mapconcept';
import { monotonePath, monotoneSegments, segmentsToCommands } from './monotone';
import {
  clusterMarkersByTravel,
  createMarkerController,
  DOT_BOX_PX,
  GLYPH_PX,
  LEVEL_LABEL,
  markerDot,
  OUTLOOK_LABEL,
  SKY_WORD,
  type MarkerController,
  type MarkerGroup,
} from './markerui';

// ============================================================================
// THE ONE JOURNEY
// ============================================================================
//
// HERO TRAIL. Named, not rule-picked, and the reason is in the data: the rule "highest
// relief that crosses treeline" returns East Longs Peak Trail, which is `parts: 2` with a
// 648 m seam and would spend the page explaining a geometry artefact instead of a
// concept. Flattop Mountain Trail is the same story without the artefact: single part,
// 6.5 km, 790 m of gain, tops out 308 m above the Front Range treeline. The fallback rule
// is kept for the other two regions so the page cannot fail to render.
const HERO: Partial<Record<RegionId, string>> = {
  rmnp: 'Flattop Mountain Trail',
};

// SCENARIO. Afternoon storms, because a mapping concept has nothing to show against a
// scenario where every hour is identical: bluebird would produce a flat green chart that
// argues for nothing. Named on the page as a scenario, not as a forecast.
const REGION: RegionId = 'rmnp';
const UNITS: Units = 'metric';

// DEPARTURE. 11:00 tomorrow, not the 09:00 a first pass used. Checked with
// trail/journey-check.mjs across four departures on this trail (afternoon-storm
// scenario, steady pace): the storm peak and the condition-band mix the walk actually
// meets are dominated by WHEN you leave, more than by anything the forecast itself is
// doing on a 6.5 km trail.
//
//   depart   finish   storm peak   waypoints at level 0/1/2/3
//   09:00    13:21    35%          47 / 36 / 12 / 0
//   10:00    14:21    50%          28 / 19 / 48 / 0
//   11:00    15:21    68%          10 / 18 / 40 / 27
//   12:00    16:21    88%          0  / 11 / 45 / 39
//
// 09:00 and 10:00 never touch the top band at all, which makes them a bad demo for a
// screen whose whole job is to show four bands. 11:00 is the earliest of the four that
// exercises every band. This is a fact about a short trail, not a staged number, and it
// is why the horizon bullet below reads out real hours rather than a rounder-looking time.
const DEPART_CLOCK = 11;
const DEPART_DAY = 1;
const PACE: PaceId = 'steady';

/**
 * The day the WALKING anchor's journey departs, against `DEPART_DAY`'s planning one.
 *
 * Today, necessarily: you cannot be partway along tomorrow's walk. That is the one thing that
 * genuinely differs between the two anchors' journeys — same trail, same 11:00 departure, same
 * pace, same traversal, one day apart — and it is why flipping the anchor rebuilds the
 * `Journey` rather than only re-reading it. The scenario is analytic over absolute hours
 * (`scope/weather/scenarios.ts`), so the convective afternoon lands in the same place on both
 * days and the storm peak moves by a couple of points rather than by a band. Every number the
 * page prints is interpolated from whichever journey is on screen, so nothing has to be told.
 */
const WALK_DAY = 0;

/** Hours from the simulated provider's now for a day + clock hour. */
function departHours(provider: WeatherProvider, day: number, clockHour: number): number {
  const { hourOfDay } = provider.now();
  return day * 24 + clockHour - hourOfDay;
}

function pickTrail(region: RegionId): ScopeTrail {
  const trails = displaySet(region).trails;
  const named = HERO[region];
  if (named) {
    const hit = trails.find((t) => t.name === named);
    if (hit) return hit;
  }
  // Fallback: the biggest single-part relief that crosses treeline, else the biggest
  // relief at all. Single-part first, so a seam never becomes the hero by accident.
  const treeline = REGIONS[region].treelineM;
  const relief = (t: ScopeTrail): number => t.maxElevM - t.minElevM;
  const crosses = trails.filter(
    (t) => t.parts === 1 && t.minElevM < treeline && t.maxElevM > treeline && t.lengthM >= 3000,
  );
  const pool = crosses.length > 0 ? crosses : trails.filter((t) => t.parts === 1);
  return [...(pool.length > 0 ? pool : trails)].sort((a, b) => relief(b) - relief(a))[0];
}

// ============================================================================
// SMALL SHARED PIECES
// ============================================================================

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Two distance qualifiers that HAVE to follow the traversal control, and did not.
 *
 * Found by clicking the control in a browser rather than by reading the code, which is
 * the whole reason it was worth wiring: with the toggle on One way the chart axis still
 * read "6.5 km round trip" and the header still read "6.5 km each way", both of which
 * describe a walk the reader had just told the page they were not doing. A static page
 * cannot have this class of bug, so adding the first live control created the first
 * opportunity for copy to go stale against state.
 *
 * They are two helpers rather than one because they qualify two different quantities.
 * `lengthQualifier` describes the TRAIL (`trail.lengthM`, the line, traversed once);
 * `walkQualifier` describes the WALK (`journey.totalM`, which is twice the line on an
 * out-and-back). Collapsing them would put "round trip" next to a one-way number.
 */
function lengthQualifier(t: Traversal): string {
  // The line itself, so on an out-and-back it is what you cover in each direction, and on
  // a loop it is the whole circuit with no "each way" to speak of.
  return t === 'out-and-back' ? 'each way' : t === 'one-way' ? 'one way' : 'loop';
}

function walkQualifier(t: Traversal): string {
  // The distance actually walked. A loop is a round trip in the ordinary sense (you end
  // where you started) but saying so invites the reader to halve it, so it stays "loop".
  return t === 'out-and-back' ? 'round trip' : t === 'one-way' ? 'one way' : 'loop';
}

/**
 * An iPhone-proportioned frame with this page's label above it.
 *
 * The device chrome itself is `src/ui/phone-frame.ts`, shared with the digest's Week and Day
 * screens; only the labelled `.cx-frame` wrapper is this page's. THE STATUS BAR READS THE
 * APP'S OWN CLOCK, not the stock 9:41 every iOS mockup uses: it was 9:41 while the screen
 * below it said the walker departed at 11:00 and it is now 12:48, which is three clocks
 * disagreeing inside one phone. A mock time is harmless on a screen with no time in it; this
 * screen is entirely about time. `deviceFrame` therefore requires the clock rather than
 * defaulting it.
 */
function frame(label: string, clock: string, ...screen: HTMLElement[]): HTMLElement {
  return h('div.cx-frame', {}, h('div.cx-frame-label', {}, label), deviceFrame(clock, ...screen));
}

/** A circled callout number, keyed to the annotation list beside the frame. */
function cx(n: number): HTMLElement {
  return h('span.cx-mark', { title: `Annotation ${n}` }, String(n));
}

/** The annotation list beside a frame. */
function annotations(items: [string, string][]): HTMLElement {
  return h(
    'ol.cx-notes',
    {},
    ...items.map(([title, body]) =>
      h('li', {}, h('strong', {}, title), document.createTextNode(' '), body),
    ),
  );
}

/** Inert product chrome: a bar of controls drawn as they would look, doing nothing except
 *  the one pill built by `traversalControl`, which is real. */
function inertBar(...kids: HTMLElement[]): HTMLElement {
  return h('div.ph-bar', {}, ...kids);
}

function pill(text: string, cls = ''): HTMLElement {
  return h(`div.ph-pill${cls ? '.' + cls : ''}`, {}, text);
}

/**
 * The page's one live control. Conditional on the trail's own `routeType`
 * (`traversalOptions`), because loop is a property of the geometry, not a user choice: a
 * point-to-point trail is never offered a direction to circle, and a loop is never
 * offered a turnaround it does not have. There are always exactly two options for a given
 * `routeType`, so this is one pill that cycles between them in the exact slot the inert
 * "Out and back ▾" pill used to occupy, rather than a second pill beside it: a real choice
 * with only two answers needs a toggle, not a menu.
 */
function traversalControl(
  routeType: RouteType,
  current: Traversal,
  onChange: (next: Traversal) => void,
): HTMLElement {
  const options = traversalOptions(routeType);
  const next = options[(options.indexOf(current) + 1) % options.length];
  return h(
    'button.ph-pill.is-on.cx-pill-live',
    { type: 'button', title: `Switch to ${TRAVERSAL_LABEL[next]}`, onclick: () => onChange(next) },
    `${TRAVERSAL_LABEL[current]} ▾`,
  );
}

/**
 * The page's second live control: which of TRAIL_PLAN §1's two anchors the screen is reading
 * against. Planning is anchored to a departure the reader picks; Walking is anchored to now.
 *
 * IT IS IN THE PHONE, AND §6 SAYS SO IN AS MANY WORDS: "Start / pause — in the phone — the
 * only control that changes what the screen IS rather than what it says." Nothing about it is
 * a prototype lever. Whether you have set off is a fact about the reader, in exactly the way
 * departure, pace and traversal already are, and it is the one of the four that changes the
 * question the screen is answering rather than the answer.
 *
 * IT IS IN THE HEADER RATHER THAN THE CONTROL BAR, and that is a measurement, not a taste.
 * The bar's three pills come to 290 px of a 320 px content row with 12 px of gaps already
 * spent, so a fourth pill of any legible width overflows a row whose CSS is `overflow:
 * hidden` — it would not wrap, it would silently vanish, which is the worst of the three
 * outcomes. Shortening `Depart 11:00` to make room was the other option and it was rejected
 * for a stronger reason than space: the not-started screen has to stay exactly the screen it
 * was, and the departure pill is the control TRAIL_PLAN §6 calls the most persuasive thing on
 * this page. So the anchor toggle takes the top-right of the header, which is where an iOS
 * screen puts the action that changes the mode, and the title beside it is clamped to one line
 * so the head's height cannot move underneath it.
 *
 * BOTH STATES ARE ON SCREEN, and that is a change from the cycling pill this started as.
 *
 * A pill that shows only its current state ("Planning") never announces that another state
 * exists. Björn asked for a started state that already existed and that he could not find,
 * which is the whole argument: the traversal pill gets away with cycling because "Out and
 * back" implies its own opposite, and "Planning" implies nothing. The discovery peek already
 * solved this for the same class of control with a visible two-up segmented control
 * (`Incl. return | One way`, phone/peek.ts), so this matches it rather than inventing a third
 * behaviour. The mode toggle is the one control on this page whose alternative a reader has
 * no way to guess, so it is the one that has to show it.
 */
function anchorControl(started: boolean, onChange: (next: boolean) => void): HTMLElement {
  const seg = (label: string, on: boolean, next: boolean): HTMLElement =>
    h(
      `button.cx-anchor-opt${on ? '.is-on' : ''}`,
      {
        type: 'button',
        'aria-pressed': String(on),
        onclick: () => {
          if (!on) onChange(next);
        },
      },
      label,
    );
  return h(
    'div.cx-anchor-seg',
    { role: 'group', 'aria-label': 'Journey state' },
    seg('Planning', !started, false),
    seg('Walking', started, true),
  );
}

/** The phone header, shared by all three frames so the anchor toggle cannot end up in three
 *  slightly different places. `.ph-title` is clamped rather than wrapped (route.css): the
 *  hero trail's name measures well inside the room the pill leaves it, and a title that could
 *  wrap would move every block below it the moment a longer name was picked. */
function phoneHead(title: string, sub: string, started: boolean, onAnchorChange: (next: boolean) => void): HTMLElement {
  return h(
    'div.ph-head',
    {},
    h('div.ph-head-top', {}, h('div.ph-title', {}, title), anchorControl(started, onAnchorChange)),
    h('div.ph-sub', {}, sub),
  );
}

// ============================================================================
// THE ON-ROUTE STRIP — where now is, what the run is, and what that costs
// ============================================================================
//
// Three lines, one fact each, and none of them present unless it has something to say. It is
// the whole of what the walking anchor and the cached run add to a frame, and it is
// deliberately not a banner: "you are offline" is not a finding, it is a status LED, and it
// changes nothing anybody decides. What changes a decision is where you are, how old the run
// is, and whether that run still reaches your finish.
//
//   .cx-now-at     the walk    12:48 · 4.6 km in · 2 h 33 m left
//   .cx-now-run    the run     Offline · 02:48, 34 h old        (or: Updated 12:48)
//   .cx-now-reach  the cost    Hourly to 14:48, then area outlook to 15:21.
//
// Reading order is the order a walker asks them in. The block renders at all only when there
// is a now or a cache age, so the page's default load — planning, online — is the screen it
// was before this existed, byte for byte, which is also how the not-started state is
// verified.

/**
 * WHEN THIS RUN WAS FETCHED, in the same pattern `scope/phone/app.ts`'s `dataAgeChip`
 * established and at the same weight: always on screen, no interaction to reveal it, and
 * quiet enough that it never reads as a fault. Being offline is the NORMAL condition on a US
 * trail, so nothing here is red, nothing is a warning mark, and the online and offline forms
 * are the same chip in the same place — one of them simply carries a glyph and a duration.
 *
 * The glyph is `offline` from the discovery app's own `ICONS`, imported rather than added
 * to: Björn asked for a cell or wifi mark and that entry is Lucide's `wifi-off`, already
 * argued for in ui.ts (a bar chart reads as a level, and the honest claim here is binary).
 * A second glyph for the same fact on a second page is exactly the drift this repo keeps
 * finding.
 *
 * TWO FACTS OFFLINE, AND THEY ARE NOT ONE FACT. The clock is when the signal was last there,
 * which is what a walker compares against their own memory of the car park; the duration is
 * what the reach in the line below is derived from. Online there is only the clock, because a
 * live run has no age worth printing.
 */
function dataAgeChip(o: OnRoute, provider: WeatherProvider): HTMLElement {
  if (o.ageHours <= 0) {
    return h('div.cx-now-run', {}, `Updated ${journeyClock(provider, o.nowHour)}`);
  }
  return h(
    'div.cx-now-run.is-offline',
    { title: `Last fetched at ${journeyClock(provider, o.fetchedHour)}, ${o.ageHours} hours ago.` },
    icon('offline', 12, 'cx-now-glyph'),
    // "Offline · 06:00, 2 h old" left the reader to work out what 06:00 WAS: the current
    // time, the fetch time, or the start of something. A bare clock beside the word Offline
    // is the one place on this page where a number arrives without saying what it measures.
    // Naming the subject costs two words and removes the ambiguity entirely.
    h('span', {}, `Offline · data from ${journeyClock(provider, o.fetchedHour)} (${o.ageHours} h old)`),
  );
}

function onRouteStrip(o: OnRoute, provider: WeatherProvider): HTMLElement | null {
  if (!o.started && o.ageHours <= 0) return null;
  const sentence = reachSentence(o, provider);
  return h(
    'div.ph-block.ph-block-tight.cx-now',
    {},
    o.started
      ? h(
          'div.cx-now-at',
          {},
          `${journeyClock(provider, o.nowHour)} · ${formatLength(o.atTravelM, UNITS)} in · ${journeyDuration(o.remainingMinutes)} left`,
        )
      : null,
    dataAgeChip(o, provider),
    sentence ? h('div.cx-now-reach', {}, sentence) : null,
  );
}

// ============================================================================
// CONCEPT B — THE ROUTE AS THE CANVAS (kept as an alternative; see the page footer note)
// ============================================================================
//
// The elevation profile becomes the chart, x is distance walked, and the fill is tinted
// by the conditions at the hour you REACH each point, x axis labelled in clock time. Full
// argument for and against is in TRAIL_PLAN §5 and §8; the page states only the trade.

const CH_W = 340;
// Plot height cut from 378 to 272 px (CH_H from 464 to 358): Björn's call, "use a more
// natural looking elev profile" — a 790 m climb over 6.5 km drawn at the old height
// exaggerates the vertical by about 16x (`chartExaggeration`, below; TRAIL_PLAN §7's
// finding), which is inside the convention profile charts commonly use but reads as a
// tent rather than terrain. 272 px lands Flattop around 11-12x, still tall enough that a
// climb has visible shape (honesty runs out well before 3-4x on a screen this narrow) but
// a real reduction from the old chart. Not cut further: the height this frees also has to
// fill the room the removed marker flags and the deleted "Along the way" strip
// (redundant with the tinted profile and the dock; see `conceptB`) left behind, and
// giving all of that back to the chart alone would have undone most of the reduction, so
// the rest is absorbed by giving the dock and the facts row real padding instead of
// leaving it as dead space before the tab bar.
const CH_TOP = 26;
const CH_BOT = 298;
const CH_H = 358;

function chartElevRange(j: Journey): [number, number] {
  return [j.minElevM - 40, j.maxElevM + 60];
}

/**
 * Two Concept B flags nearer than this on screen are one place, however far apart they are
 * on the ground. It IS the dot's drawn box (`DOT_BOX_PX`, markerui.ts): two boxes closer than
 * one box width overlap outright, on ANY trail, because the collision is a property of the
 * drawing and not of the journey. Read from that constant rather than hand-derived from the
 * disc's diameter and halo, which is what it used to be (22 px, from an 18 px disc) and which
 * went stale silently when the disc grew to 26 px for the 1.5x glyph.
 *
 * TRAIL_PLAN.md's Defect 1: Flattop's high point and turnaround are 8 minutes and 560 m
 * apart on the ground, which is comfortably clear of `MERGE_RADIUS_M` (150 m, tuned for the
 * MAP's real-world proximity) — so they never merge, yet 560 m of a 13 km walk is under 15
 * px on this chart's own CH_W, which is well inside two icons' combined footprint. A fixed
 * metre radius is the wrong unit for a PIXEL collision: it happened to read as "far enough"
 * here only because Flattop's scale made 150 m look small. Converting the SAME pixel budget
 * into travel-distance metres, freshly for each journey's own `totalM`, is what makes the
 * fix general rather than a threshold re-tuned to this one trail's numbers — a short walk
 * compresses less distance into CH_W than a long one, so the metre radius has to move with
 * it. `chartMergeRadiusM`'s output is `clusterMarkersByTravel`'s `radiusM`, not
 * `MERGE_RADIUS_M`: the map's own clustering (`mapconcept.ts`, real-world proximity, a
 * different medium at a different, reader-controlled zoom) is untouched.
 */
const CHART_MERGE_GAP_PX = DOT_BOX_PX;

function chartMergeRadiusM(j: Journey): number {
  return (CHART_MERGE_GAP_PX / CH_W) * j.totalM;
}

/**
 * `.cx-bflags`'s own real CSS width, in px: `.phone`'s 366, minus its 8 px padding on each
 * side (`.phone-in`), minus `.ph-block`'s 15 px padding on each side — the same chain
 * route.css's own `.phone`/`.ph-block` rules define. Deliberately NOT `CH_W`: the chart SVG
 * scales its own 340-unit viewBox to fill whatever CSS width it is given, but `.cx-bflags`'s
 * children are positioned by plain CSS `left: X%` of THIS box, which is a different number
 * (320, not 340) — see `layoutMarkerX`'s own header comment for the bug that conflating the
 * two caused.
 */
const CHART_ROW_PX = 366 - 2 * 8 - 2 * 15;

/**
 * Screen-left percent for each group's icon, in the SAME order `groups` is already sorted
 * (ascending `travelM`, `clusterMarkersByTravel`'s own contract), with a minimum on-screen
 * gap enforced between neighbours even after the edge clamp below.
 *
 * FOUND WHILE VERIFYING FIX 1's "no two marker boxes intersect" claim, on the One way
 * traversal: `chartMergeRadiusM` correctly keeps Flattop's high point and its one-way
 * finish as two separate groups (552 m apart against a 420 m radius at that traversal's
 * shorter `totalM`), and each one's own `Math.min(97, Math.max(3, frac * 100))` clamp is
 * individually correct too — neither spills past the frame edge on its own. But BOTH sit in
 * the last 10% of the walk, so the SAME clamp pulls them toward the same 97% ceiling from
 * two different starting fracs, and the gap between them shrinks from a real 8.5% of the
 * row's width down to 5.5% post-clamp: under the 28 px tap target's own width, so two
 * markers the merge radius had correctly kept apart landed with overlapping boxes anyway,
 * entirely as a side effect of the edge clamp compressing two independent positions toward
 * the same corner. (A first pass at this fix used `CH_W`, the chart's own 340-unit viewBox,
 * as the denominator for the 28 px minimum gap — the wrong number, `CHART_ROW_PX`'s own
 * header comment has why — and left the two markers 1.8 px short of clear; `CHART_ROW_PX`
 * is the real fix, this function's minimum-gap logic was already right.) A per-marker
 * clamp cannot see this, because it never looks at its neighbour; the fix is a forward
 * minimum-gap pass ACROSS the already-sorted list. A backward pass afterwards only fires if
 * the forward one pushed the last marker past the 97% ceiling — it has not, on any journey
 * checked, but a walk with enough tightly-spaced markers could reach it, and pulling the
 * whole run left by the overflow keeps every gap the forward pass just established rather
 * than reintroducing the very compression this exists to remove.
 */
function layoutMarkerX(groups: MarkerGroup[], totalM: number): number[] {
  // The box width plus 2 px, not the box width exactly: a gap of exactly one box leaves two of
  // them touching edge to edge with no slack, and percent-to-pixel rounding at render time
  // (`.toFixed(1)` below, plus the browser's own subpixel layout) was on its own enough to read
  // as a fraction of a pixel of overlap. 2 px of headroom is cheap on a 320 px row and removes
  // the rounding case rather than chasing it precisely. Both terms now come from `DOT_BOX_PX`:
  // the old code wrote 30 as a literal that happened to be box-plus-6, and when the dot grew to
  // 30 px for the 1.5x glyph that same literal became box-plus-nothing.
  const minGapPct = ((DOT_BOX_PX + 2) / CHART_ROW_PX) * 100;
  // The edge clamps are half a box in from each end, computed rather than the 3 and 97 they used
  // to be: those were chosen for a 24 px box, where half a box is 3.75% of the row and 3% was
  // near enough. At 30 px, half a box is 4.7%, so a marker clamped to 3% hung 5 px past the
  // row's own content box — inside `.ph-block`'s padding, so nothing clipped, but no longer what
  // the clamp claims to guarantee.
  const edgePct = (DOT_BOX_PX / 2 / CHART_ROW_PX) * 100;
  const hiPct = 100 - edgePct;
  const pct = groups.map((g) => Math.min(hiPct, Math.max(edgePct, (g.markers[0].travelM / totalM) * 100)));
  for (let i = 1; i < pct.length; i++) {
    if (pct[i] - pct[i - 1] < minGapPct) pct[i] = pct[i - 1] + minGapPct;
  }
  const overflow = pct[pct.length - 1] - hiPct;
  if (overflow > 0) for (let i = 0; i < pct.length; i++) pct[i] -= overflow;
  return pct;
}

/** How many times taller than true-to-scale the chart draws relief: (plot px per
 *  vertical metre) / (plot px per horizontal metre). Computed from the SAME constants and
 *  the SAME journey extents the chart itself uses — never a second, hand-checked number —
 *  so the two cannot drift apart, and printed under Concept B rather than assumed. */
function chartExaggeration(j: Journey): number {
  const [loElev, hiElev] = chartElevRange(j);
  const span = hiElev - loElev;
  return ((CH_BOT - CH_TOP) * j.totalM) / (CH_W * span);
}

function conceptBChart(o: OnRoute, provider: WeatherProvider): HTMLElement {
  const j = o.journey;
  const wps = j.waypoints;
  const [loElev, hiElev] = chartElevRange(j);
  const x = (travelM: number): number => (travelM / j.totalM) * CH_W;
  const y = (elevM: number): number =>
    CH_BOT - ((elevM - loElev) / (hiElev - loElev)) * (CH_BOT - CH_TOP);

  // THE RIDGE, monotone cubic rather than a straight polyline. `trail/monotone.ts` has the
  // full argument; the one line that matters here is that a monotone curve cannot invent
  // a bump or dip between two samples that neither sample has, so this is strictly a
  // smoother READING of the same 48 points, never a claim the data does not support. The
  // profile's real resolution (48 samples over the whole walk, `scope/derive.mjs`'s own
  // number) is the actual limit on detail here, not this drawing step: re-deriving at a
  // higher sample rate is a separate, network-dependent decision, tracked outside this
  // file, and NOT something to work around by inventing intermediate points.
  const pts = wps.map((w) => ({ x: x(w.travelM), y: y(w.elevM) }));
  const ridgeD = monotonePath(pts);
  const ridgeCmds = segmentsToCommands(monotoneSegments(pts));
  const area = `M0,${CH_BOT} L${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}${ridgeCmds} L${CH_W},${CH_BOT} Z`;

  const svg = (tag: string, attrs: Record<string, string | number>): SVGElement => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };

  const root = svg('svg', { viewBox: `0 0 ${CH_W} ${CH_H}`, class: 'cx-chart' });

  const defs = svg('defs', {});
  const clip = svg('clipPath', { id: 'cxclip-a' });
  clip.appendChild(svg('path', { d: area }));
  defs.appendChild(clip);
  // THE HATCH FOR THE WALKED PORTION (TRAIL_PLAN §1: "the walked portion hatches"). A texture
  // rather than a fill, and drawn OVER the condition bands rather than instead of them,
  // because what is behind the walker is not a different forecast, it is the same forecast
  // with nothing left to decide. Keeping the band visible under the hatch is what lets a
  // reader see that the bands they walked through were the mild ones and the ones ahead are
  // not, which is the entire argument for departing early on this trail and is exactly the
  // argument the page is not allowed to make in words.
  const hatch = svg('pattern', {
    id: 'cxhatch-a',
    width: 5,
    height: 5,
    patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(45)',
  });
  hatch.appendChild(svg('rect', { x: 0, y: 0, width: 5, height: 5, fill: '#fffdf7', 'fill-opacity': 0.42 }));
  hatch.appendChild(svg('line', { x1: 0, y1: 0, x2: 0, y2: 5, stroke: 'var(--ink)', 'stroke-width': 0.9, 'stroke-opacity': 0.3 }));
  defs.appendChild(hatch);
  root.appendChild(defs);

  // Per-leg condition bands, clipped to the profile silhouette. One rect per waypoint
  // pair, so the tint changes where the forecast changes and nowhere else.
  const g = svg('g', { 'clip-path': 'url(#cxclip-a)' });
  for (let k = 1; k < wps.length; k++) {
    const x0 = x(wps[k - 1].travelM);
    const x1 = x(wps[k].travelM);
    if (x1 - x0 < 0.01) continue;
    g.appendChild(
      svg('rect', {
        x: x0,
        y: CH_TOP - 8,
        width: x1 - x0 + 0.6,
        height: CH_BOT - CH_TOP + 8,
        // Past the cached run's hourly reach the band is not available, because a band IS an
        // hour's claim at a point and that is precisely what a stale run has run out of the
        // right to make. `--lv-out` is outside the four-band ramp on purpose, not a fifth
        // step on it: "we cannot say" is not a low storm probability.
        fill: isOutlook(o, wps[k].hour) ? 'var(--lv-out)' : `var(--lv-${wps[k].level})`,
      }),
    );
  }
  // The walked stretch, hatched over whatever the bands under it are. Clipped to the SAME
  // silhouette path, so it stops at the ridge line exactly as the bands do.
  if (o.started && o.atTravelM > 0) {
    g.appendChild(
      svg('rect', {
        x: 0,
        y: CH_TOP - 8,
        width: x(o.atTravelM),
        height: CH_BOT - CH_TOP + 8,
        fill: 'url(#cxhatch-a)',
      }),
    );
  }
  root.appendChild(g);
  root.appendChild(svg('path', { d: ridgeD, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.4 }));

  // Treeline, where one exists. A terrain fact, so it is drawn as a rule and not as a band.
  if (j.region.treelineM < NO_TREELINE_M && j.maxElevM > j.region.treelineM) {
    const ty = y(j.region.treelineM);
    root.appendChild(
      svg('line', {
        x1: 0,
        y1: ty,
        x2: CH_W,
        y2: ty,
        stroke: 'var(--muted)',
        'stroke-width': 1,
        'stroke-dasharray': '3 3',
      }),
    );
    const tl = svg('text', { x: 2, y: ty - 4, class: 'cx-tl' });
    tl.textContent = `TREELINE ${Math.round(j.region.treelineM)} M`;
    root.appendChild(tl);
  }

  // No marker hairlines or dots on the curve itself any more: the markers live in an HTML
  // row ABOVE the plot (see `conceptB`, below), specifically so no marker's bounding box
  // ever has to touch the line it is describing — the same complaint the map's redesign
  // exists to fix, read onto the chart.

  /** A full-height rule with a small label, for the two vertical marks the walking anchor and
   *  the cached run add. The label flips to the left of its rule in the last quarter of the
   *  chart so it cannot run off the frame — the same edge problem `layoutMarkerX` solves for
   *  the marker row, at a scale small enough that a clamp is the whole fix. */
  const rule = (atM: number, label: string, cls: string, dashed: boolean): SVGElement => {
    const rx = x(atM);
    const grp = svg('g', {});
    grp.appendChild(
      svg('line', {
        x1: rx,
        y1: CH_TOP - 8,
        x2: rx,
        y2: CH_BOT,
        class: cls,
        ...(dashed ? { 'stroke-dasharray': '4 3' } : {}),
      }),
    );
    const flip = rx > CH_W * 0.75;
    const t = svg('text', {
      x: rx + (flip ? -4 : 4),
      // INSIDE the plot's own top margin, not above it. `CH_TOP - 1` is where the marker row
      // sits (`.cx-bflags` is inset in that same margin), and at the walking anchor the
      // OUTLOOK wall lands within a few pixels of the finish marker's dot, so a label there
      // is drawn straight across a 30 px disc. Ten units below CH_TOP is still well clear of
      // the curve — `chartElevRange` always leaves 60 m of headroom over the journey's
      // maximum, which puts the peak ~40 px down on this trail and cannot rise above ~32 px
      // on any relief.
      y: CH_TOP + 10,
      class: `cx-rulelab ${cls}`,
      'text-anchor': flip ? 'end' : 'start',
    });
    t.textContent = label;
    grp.appendChild(t);
    return grp;
  };

  // THE WALL, WHERE THE CACHED RUN'S HOURLY REACH RUNS OUT. This is the mark the whole cached
  // state exists to draw and nothing in this repo had drawn it: the discovery page puts the
  // same wall on a day bar, between two days, where it reads as a fact about the week. Here
  // it lands INSIDE a single walk, between two hours of one afternoon, which is what makes
  // "does my forecast still cover my finish" a question with a visible answer. Drawn before
  // the now rule so that where the two coincide the reader's own position wins.
  if (o.outlookFromTravelM != null) {
    root.appendChild(rule(o.outlookFromTravelM, 'OUTLOOK', 'cx-wall', true));
  }
  // WHERE THE READER IS. The chart CAN say this where the map cannot: its x axis is travel
  // distance, so an out-and-back's outbound and return legs occupy different halves of it and
  // "behind you" is unambiguous. On the map the same ground is both behind and ahead.
  if (o.started) {
    root.appendChild(rule(o.atTravelM, 'NOW', 'cx-nowrule', false));
  }

  // THE TIME AXIS. Clock labels at the hour, positioned by where you are at that hour,
  // which is what makes the axis a time axis and not a distance axis with times on it.
  const axis = svg('g', {});
  axis.appendChild(
    svg('line', { x1: 0, y1: CH_BOT, x2: CH_W, y2: CH_BOT, stroke: 'var(--line)', 'stroke-width': 1 }),
  );
  const firstHour = Math.ceil(j.departHour);
  for (let hr = firstHour; hr <= j.endHour; hr++) {
    const seg = wps.find((w) => w.hour >= hr);
    if (!seg) continue;
    const hx = x(seg.travelM);
    axis.appendChild(
      svg('line', { x1: hx, y1: CH_BOT, x2: hx, y2: CH_BOT + 4, stroke: 'var(--line)', 'stroke-width': 1 }),
    );
    const t = svg('text', { x: hx, y: CH_BOT + 15, class: 'cx-axis', 'text-anchor': 'middle' });
    t.textContent = journeyClock(provider, hr);
    axis.appendChild(t);
  }
  const dist = svg('text', { x: CH_W, y: CH_BOT + 30, class: 'cx-axis cx-axis-dim', 'text-anchor': 'end' });
  dist.textContent = `${formatLength(j.totalM, UNITS)} ${walkQualifier(j.traversal)}`;
  axis.appendChild(dist);
  const startLbl = svg('text', { x: 0, y: CH_BOT + 30, class: 'cx-axis cx-axis-dim' });
  startLbl.textContent = `depart ${journeyClock(provider, j.departHour)}`;
  axis.appendChild(startLbl);
  root.appendChild(axis);

  return root as unknown as HTMLElement;
}

/**
 * The departure pill, present only while planning.
 *
 * Departure is a DECISION in the planning anchor and a matter of RECORD once the walk is
 * under way. At 12:48, four kilometres in, "Depart 11:00" is not a control any more: it is
 * something that already happened, and offering it as a dropdown invites a reader to change
 * the input the rest of the screen has already been computed from. Bjorn asked for it to be
 * hidden while walking.
 *
 * Nothing replaces it. The bar carries two pills instead of three, which this frame can
 * afford precisely when walking, because that is the state where the on-route strip below
 * needs the room (see THE FACTS ROW). The departure time is not lost either: the strip
 * states the walk's own clock, distance covered and time remaining, which is what a walker
 * wants from it once they are moving.
 *
 * Returned as an array and spread at all three call sites (Concepts A, B and C) so the bars
 * cannot drift into different rules about which pills a state shows.
 */
function departPill(j: Journey, o: OnRoute, provider: WeatherProvider): HTMLElement[] {
  if (o.started) return [];
  return [pill(`Depart ${journeyClock(provider, j.departHour)} \u25be`, 'is-on')];
}

/**
 * Concept B. Markers and the dock are IDENTICAL machinery to Concept A's map
 * (`trail/markerui.ts`'s `createMarkerController`), so a reader flipping between the two
 * reads the same icons and the same numbers in the same shape; only the CLUSTERING metric
 * differs (travel distance here, geography there — see markerui.ts's header), and how much
 * of the badge is drawn (this row keeps the glyph-only design; see the marker redesign's
 * report for why the richer Concept A badge does not belong on this slim a row). No
 * re-render of this whole frame happens on a tap: like the map, the controller mutates the
 * marker buttons and the dock in place, and only reports the resolved selection outward via
 * `onSelect` so a later traversal rebuild starts from the right state.
 */
function conceptB(
  o: OnRoute,
  provider: WeatherProvider,
  onTraversalChange: (next: Traversal) => void,
  onAnchorChange: (next: boolean) => void,
  selectedKind: MarkerKind | null,
  onSelect: (kind: MarkerKind) => void,
): HTMLElement {
  const j = o.journey;
  const head = phoneHead(
    j.trail.name,
    `${formatLength(j.trail.lengthM, UNITS)} ${lengthQualifier(j.traversal)} · ${formatElevation(j.trail.gainM, UNITS)} gain · ${j.trail.difficulty} (computed)`,
    o.started,
    onAnchorChange,
  );

  const controls = inertBar(
    ...departPill(j, o, provider),
    pill(`${paceDef(j.pace).label} ▾`),
    traversalControl(j.trail.routeType, j.traversal, onTraversalChange),
  );

  const strip = onRouteStrip(o, provider);

  /**
   * THE FACTS ROW, AND THE ONE PLACE THE STRIP HAD TO BE PAID FOR.
   *
   * Measured before it was changed: this frame's blocks come to 699 px of the 732 px budget
   * (TRAIL_PLAN §2), so it carries 33 px of slack and the strip is 64. Concepts A and C
   * absorb a new block without noticing — the map is `flex: 1 1 auto` and the table derives
   * its own row count from whatever chrome is above it — and this one cannot. So when the
   * strip renders, the row goes from four figures in two rows to two in one, which is a 43 px
   * saving against a 64 px cost and leaves the frame comfortably inside its budget.
   *
   * WHICH TWO SURVIVE IS NOT ARBITRARY. Temp and gust are the two the DOCK already prints for
   * whichever marker is open, one strip below; treeline time and storm peak are the two that
   * are only ever stated as whole-walk aggregates. Dropping the pair that is already on
   * screen costs the frame nothing a reader cannot read two centimetres away.
   *
   * AND THE SURVIVORS CHANGE MEANING, WHICH IS THE POINT. TRAIL_PLAN §8 lists this as a
   * correctness bug the moment the screen has a now: exposed time REMAINING and exposed time
   * TOTAL are different numbers, and a walking screen printing the total answers a question
   * nobody standing on the trail is asking. The keys say "ahead" so the change is stated
   * rather than silent — a value that quietly means something else is worse than either
   * value.
   */
  const facts = strip
    ? h(
        'div.ph-facts',
        {},
        // The keys say "ahead" only when there IS a behind. Planning stands at the trailhead,
        // where the remaining figures and the whole-walk figures are the same number, and a
        // key promising a distinction the value does not make is the same defect as a value
        // that quietly changed meaning, pointing the other way.
        ...(o.started
          ? [
              ['Treeline ahead', journeyDuration(o.remainingExposedMinutes)],
              ['Storm peak ahead', pct(o.remainingPeakThunder)],
            ]
          : [
              ['Above treeline', journeyDuration(j.exposedMinutes)],
              ['Storm peak', pct(j.peakThunder)],
            ]
        ).map(([k, v]) => h('div.ph-fact', {}, h('span.k', {}, k), h('span.v', {}, v))),
      )
    : h(
        'div.ph-facts',
        {},
        ...[
          ['Above treeline', journeyDuration(j.exposedMinutes)],
          ['Temp', `${formatTemp(j.tempRangeC[0], UNITS)} to ${formatTemp(j.tempRangeC[1], UNITS)}`],
          ['Peak gust', formatSpeed(j.peakGustKph, UNITS)],
          ['Storm peak', pct(j.peakThunder)],
        ].map(([k, v]) => h('div.ph-fact', {}, h('span.k', {}, k), h('span.v', {}, v))),
      );

  // Markers, clustered by TRAVEL DISTANCE (not geography — see markerui.ts), positioned in
  // a slim row inset within the chart's own top margin (CH_TOP, above where the curve can
  // ever reach: the y-scale never maps an elevation above CH_TOP), so no marker's tap
  // target has to sit on the line it is describing. Left-clamped away from the exact 0%
  // and 100% edges so the icon's own half-width translate cannot spill past the frame.
  // The radius is the PIXEL budget converted into this journey's own travel metres
  // (`chartMergeRadiusM`), not a fixed metre figure: on an out-and-back the high point and
  // the turnaround are minutes apart, so on a chart whose x axis is the whole walk they
  // land within a few pixels of each other and collide whatever the trail. A metre
  // threshold only looked adequate because Flattop's scale flattered it.
  const groups = clusterMarkersByTravel(j.markers, chartMergeRadiusM(j));
  const dock = h('div.cx-dock', {});
  const controller: MarkerController = createMarkerController(dock, groups, selectedKind, o, provider, UNITS, onSelect);
  const flagsRow = h('div.cx-bflags', {});
  const xPct = layoutMarkerX(groups, j.totalM);
  groups.forEach((g, i) => {
    // The SAME element the map now draws (`markerui.ts`'s `markerDot`), with no density switch
    // left between the two frames: this row was always glyph-only, and the map's marker became
    // glyph-only too when its time and temperature moved onto an offset card (TRAIL_PLAN §13).
    // The one change this row inherits is size — a 20 px glyph (`GLYPH_PX.marker`) rather than
    // 13 — which is what pulled `.cx-bflags`'s own height up in route.css; see the note there
    // for why the row grows UPWARD into the block's padding rather than down into the plot.
    const btn = markerDot(g, o, provider, UNITS, g.id === controller.current());
    btn.style.left = `${xPct[i].toFixed(1)}%`;
    flagsRow.appendChild(btn);
    controller.register(g, btn);
  });
  controller.finish();

  return h(
    'div.ph-app',
    {},
    head,
    controls,
    strip,
    h('div.ph-block', {}, h('div.cx-chart-wrap', {}, conceptBChart(o, provider), flagsRow)),
    h('div.ph-block.ph-block-tight', {}, dock),
    h('div.ph-block.ph-block-tight', {}, facts),
    h(
      'div.ph-tabs',
      {},
      ...['Explore', 'For You', 'Navigate', 'Saved', 'Activity'].map((t, i) =>
        h('div.ph-tab', { class: i === 2 ? 'is-on' : '' }, t),
      ),
    ),
  );
}

// ============================================================================
// CONCEPT C — THE JOURNEY AS A TABLE (kept as an alternative; see the page footer note)
// ============================================================================

const C_SCREEN_PX = 732; // phone-in (792 - 2x8 padding) minus status (26) minus home (18)
const C_CHROME_PX = 59 + 44 + 26 + 30 + 29; // head + controls bar + thead + tfoot + tab bar
const C_ROW_PX = 30; // .ph-trow
const C_BAND_PX = 22; // .ph-trow.is-marker
const C_MARGIN_PX = 4; // stated slack against sub-pixel font rounding, not against error
/** The on-route strip's own measured height, in the same hand-measured register as the four
 *  constants above it, and read only when the strip is actually rendered. Measured at its
 *  TALLEST — three lines, which is the walking-and-offline case — rather than at whatever the
 *  current state happens to be, because over-reserving costs one data row and under-reserving
 *  clips a row against `.ph-tbody`'s `overflow: hidden` without saying so. The two-line states
 *  come out at 50 and 53 px. */
const C_STRIP_PX = 67;

/**
 * The `tableRows` target count that fills the table without overflowing `.ph-tbody`'s
 * `overflow: hidden`, searched against THIS journey's own marker count every render
 * rather than tuned once: TRAIL_PLAN §2 found a fixed count clips silently the moment the
 * trail, region, scenario or pace changes the marker band count.
 *
 * `extraChromePx` and `extraBands` are the on-route strip and the two synthetic bands it
 * brings (NOW, OUTLOOK FROM), passed in rather than derived here for the reason the count is
 * searched rather than tuned in the first place: this frame's whole argument is its density,
 * and a row budget that could not see a block that had just been inserted above it would clip
 * silently, which is the precise failure §2 records. The table simply gives up rows for them,
 * which is why Concept C needed no layout argument of its own where Concept B needed one.
 */
function fitRowCount(j: Journey, extraChromePx: number, extraBands: number): number {
  const bandRows = j.markers.filter((m) => m.kind !== 'depart' && m.kind !== 'finish').length + extraBands;
  const budgetPx = C_SCREEN_PX - C_CHROME_PX - extraChromePx - C_MARGIN_PX - bandRows * C_BAND_PX;
  const maxDataRows = Math.floor(budgetPx / C_ROW_PX);

  let best = 2;
  for (let count = 2; count <= j.waypoints.length; count++) {
    const rows = tableRows(j, count).length;
    if (rows > maxDataRows) break;
    best = count;
    if (rows >= j.waypoints.length) break;
  }
  return best;
}

/**
 * One data row's SKY cell: the hour's weather glyph, on Björn's call that the tabular readout
 * needs weather icons per row and not only on its column headers.
 *
 * THE SAME PRECEDENCE THE MARKERS AND THE DOCK USE, reached through the same `weatherGlyph`
 * rather than a second mapping — one conditions vocabulary across all three concepts is the
 * whole point of `markerui.ts` existing, and a table that decided sun-versus-cloud on its own
 * cuts would be the fourth place in this repo where the same three thresholds got written down
 * differently (SCOPE_PLAN §13 tracks the existing three).
 *
 * `w.level` is passed as the band override even though this row is a SINGLE sample, where
 * `weatherGlyph` would derive the same band from `thunderProb` on its own. Deliberate: the
 * row's background tint is `lv-${w.level}`, so reading the band from the identical field means
 * the glyph and the colour behind it cannot disagree about what band this hour is in.
 *
 * IT COSTS NO ROWS. `.ph-trow`'s height is a fixed 30 px (route.css), so a 15 px glyph inside
 * it changes no measurement `fitRowCount` makes, and the data row count is identical before and
 * after — which is the constraint the table's whole argument depends on, since its density IS
 * the argument.
 *
 * IT GETS A REAL ACCESSIBLE NAME, not `aria-hidden`. The test is whether the glyph says
 * anything the row's own numbers do not, and here it does: the row prints temperature, gust
 * and storm probability, and none of those separates a wet hour from a merely cloudy one, which
 * `weatherGlyph` decides from `precipMm` and `cloudPct`. So it carries one word (`SKY_WORD`),
 * short because eighteen rows are reading it out; the header glyphs, whose columns are already
 * named in text beside them, stay `aria-hidden` as `icon()` makes them.
 */
function skyCell(w: Journey['waypoints'][number], outlook: boolean): HTMLElement {
  // Past the cached run's reach the sky is not a per-hour claim any more, so the cell carries
  // the calendar `outlook` glyph and the word the rest of the app already uses for that
  // coarser claim, rather than a sun or a bolt it has no right to name. Same substitution
  // `markerui.ts`'s `groupReading` makes for the dot and the dock: one rule, three frames.
  const glyph = outlook ? 'outlook' : weatherGlyph(w.sample.thunderProb, w.sample.precipMm, w.sample.cloudPct, w.level);
  const word = outlook ? OUTLOOK_LABEL : SKY_WORD[glyph];
  return h('span.c-sky', { role: 'img', 'aria-label': word }, icon(glyph, GLYPH_PX.table));
}

function conceptC(
  o: OnRoute,
  provider: WeatherProvider,
  onTraversalChange: (next: Traversal) => void,
  onAnchorChange: (next: boolean) => void,
): HTMLElement {
  const j = o.journey;
  const strip = onRouteStrip(o, provider);
  // Two synthetic bands at most, and only the ones that have somewhere to land: NOW exists
  // only on a started walk, OUTLOOK FROM only when the run's reach falls inside it.
  const extraBands = (o.started ? 1 : 0) + (o.outlookFromTravelM != null ? 1 : 0);
  const rows = tableRows(j, fitRowCount(j, strip ? C_STRIP_PX : 0, extraBands));

  // A marker band belongs on exactly ONE row: the row `tableRows` already picked as that
  // marker's nearest waypoint, matched once per marker rather than per row, so a marker
  // close to two adjacent rows cannot print its band twice.
  const bandAt = new Map<number, Marker>();
  for (const m of j.markers) {
    if (m.kind === 'depart' || m.kind === 'finish') continue;
    let best = 0;
    for (let idx = 1; idx < rows.length; idx++) {
      if (Math.abs(rows[idx].travelM - m.travelM) < Math.abs(rows[best].travelM - m.travelM)) best = idx;
    }
    bandAt.set(best, m);
  }

  // The two synthetic bands claim a row the same way a marker does — the nearest row at or
  // after the moment, so the band sits above the first row it describes rather than beside a
  // row that is still on the other side of it.
  const firstRowAtOrAfter = (hour: number): number => {
    const idx = rows.findIndex((w) => w.hour >= hour);
    return idx < 0 ? rows.length - 1 : idx;
  };
  const nowRow = o.started ? firstRowAtOrAfter(o.nowHour) : -1;
  const outlookRow = o.outlookFromTravelM != null ? firstRowAtOrAfter(o.reachHour) : -1;

  const body = h('div.ph-tbody', {});
  rows.forEach((w, i) => {
    const mk = bandAt.get(i);
    // Ordered so a reader scanning down meets them in the order they happen: the marker's own
    // place, then the walker standing at it, then the point past which the run stops being
    // hourly. Three bands on one row is possible and reads correctly; it is not special-cased,
    // because suppressing one would drop a fact to save 22 px.
    if (mk) {
      body.appendChild(
        h('div.ph-trow.is-marker', {}, h('span.ph-tband', {}, `${mk.label}${mk.sub ? ` · ${mk.sub}` : ''}`)),
      );
    }
    if (i === nowRow) {
      body.appendChild(
        h(
          'div.ph-trow.is-marker.is-now',
          {},
          h('span.ph-tband', {}, `Now · ${journeyClock(provider, o.nowHour)} · ${formatLength(o.atTravelM, UNITS)} in`),
        ),
      );
    }
    if (i === outlookRow) {
      body.appendChild(
        h(
          'div.ph-trow.is-marker.is-outlook',
          {},
          h('span.ph-tband', {}, `Area outlook from ${journeyClock(provider, o.reachHour)}`),
        ),
      );
    }
    const passed = isPassed(o, w.hour);
    const outlook = isOutlook(o, w.hour) && o.outlook != null;
    // Past the wall every row prints the SAME three figures, because the claim past the wall
    // is one figure for the stretch and not one per hour. A reader watching the numbers stop
    // changing row to row is reading the granularity of the claim directly off the table,
    // which is the most a tabular concept can do with a degraded forecast and is better than
    // either faking hourly variation or leaving the cells empty (SCOPE_PLAN §4: degrading
    // means less certainty, not less content).
    const tempC = outlook ? o.outlook!.tempC : w.sample.tempC;
    const gustKph = outlook ? o.outlook!.gustKph : w.sample.gustKph;
    const thunderProb = outlook ? o.outlook!.thunderProb : w.sample.thunderProb;
    body.appendChild(
      h(
        'div.ph-trow',
        { class: `${outlook ? 'is-outlook' : `lv-${w.level}`}${passed ? ' is-passed' : ''}` },
        h('span.c-time', {}, journeyClock(provider, w.hour)),
        h('span.c-km', {}, (w.travelM / 1000).toFixed(1)),
        h('span.c-el', {}, Math.round(w.elevM).toLocaleString('en-US')),
        h('span.c-t', {}, `${Math.round(tempC)}°`),
        h('span.c-w', {}, String(Math.round(gustKph))),
        h('span.c-s', {}, pct(thunderProb)),
        skyCell(w, outlook),
      ),
    );
  });

  return h(
    'div.ph-app',
    {},
    phoneHead(
      j.trail.name,
      `${journeyClock(provider, j.departHour)} → ${journeyClock(provider, j.endHour)} · ${journeyDuration(j.totalMinutes)} · ${formatLength(j.totalM, UNITS)}`,
      o.started,
      onAnchorChange,
    ),
    inertBar(
      ...departPill(j, o, provider),
      pill(`${paceDef(j.pace).label} ▾`),
      traversalControl(j.trail.routeType, j.traversal, onTraversalChange),
    ),
    strip,
    h(
      'div.ph-block.ph-block-flush',
      {},
      h(
        'div.ph-thead',
        {},
        h('span.c-time', {}, 'TIME'),
        h('span.c-km', {}, 'KM'),
        h('span.c-el', {}, 'ELEV'),
        // The measure glyphs, at `GLYPH_PX.table`. These name their COLUMNS (what is measured
        // here) and are a different job from the per-row SKY glyph below (what the hour is
        // like), so they stay rather than being dropped as redundant once every row carries a
        // glyph of its own — one labels, the other reads.
        h('span.c-t', {}, icon('thermometer', GLYPH_PX.table), 'TEMP'),
        h('span.c-w', {}, icon('wind', GLYPH_PX.table), 'GUST'),
        h('span.c-s', {}, icon('bolt', GLYPH_PX.table), 'STORM'),
        h('span.c-sky', {}, 'SKY'),
      ),
      body,
    ),
    h(
      'div.ph-tfoot',
      {},
      // Same correctness point Concept B's facts row makes, in the two figures this frame has
      // room for: once there is a now, the honest aggregate is what is still ahead.
      h(
        'span',
        {},
        o.started
          ? `Treeline ahead ${journeyDuration(o.remainingExposedMinutes)}`
          : `Above treeline ${journeyDuration(j.exposedMinutes)}`,
      ),
      h('span', {}, o.started ? `Peak ahead ${pct(o.remainingPeakThunder)}` : `Peak ${pct(j.peakThunder)}`),
    ),
    h(
      'div.ph-tabs',
      {},
      ...['Explore', 'For You', 'Navigate', 'Saved', 'Activity'].map((t, i) =>
        h('div.ph-tab', { class: i === 2 ? 'is-on' : '' }, t),
      ),
    ),
  );
}

// ============================================================================
// CONCEPT A — THE ROUTE ON A PITCHED 3D MAP. This is now THE screen; see the page header.
// ============================================================================
//
// Reuses `PhoneMap` (src/scope/phone/pmap.ts) wholesale: same terrain, same camera, same
// DEM-unreachable fallback. Detail lives in mapconcept.ts; this shell is the chrome
// around it.
//
// CONTROL BAR. Depart and Pace pills now sit here alongside the live traversal pill,
// which they did not on the concept-jam page: there, map real estate was the scarcer
// resource among three competing frames and the pills were judged not to earn their
// place. Promoted to the primary screen, this frame IS the product, and departure time
// is the single most persuasive control on it (TRAIL_PLAN §6), so it has to be visible
// here rather than only on the two frames a reader may never scroll to.
function conceptAShell(
  o: OnRoute,
  provider: WeatherProvider,
  onTraversalChange: (next: Traversal) => void,
  onAnchorChange: (next: boolean) => void,
): { app: HTMLElement; mapHost: HTMLElement; dock: HTMLElement } {
  const j = o.journey;
  const mapHost = h('div.cx-maphost', {});
  // The docked detail strip lives in the SAME `.cx-mapwrap` as the map host, a sibling
  // positioned over its bottom edge by CSS (route.css). route.ts owns creating it;
  // `mountConceptAMap` (mapconcept.ts) only ever fills its contents, so this file stays
  // the one place page layout is decided.
  const dock = h('div.cx-dock', {});
  const app = h(
    'div.ph-app',
    {},
    phoneHead(
      j.trail.name,
      `${formatLength(j.trail.lengthM, UNITS)} ${lengthQualifier(j.traversal)} · ${formatElevation(j.trail.gainM, UNITS)} gain · ${j.trail.difficulty} (computed)`,
      o.started,
      onAnchorChange,
    ),
    inertBar(
      ...departPill(j, o, provider),
      pill(`${paceDef(j.pace).label} ▾`),
      traversalControl(j.trail.routeType, j.traversal, onTraversalChange),
    ),
    // The strip sits directly under the controls in all three frames, above whatever each one
    // draws the journey with, because it states the frame's own premise: which anchor this is
    // and what run it is read through. The map absorbs its height on its own (`flex: 1 1
    // auto`), which is why the primary screen needed no layout argument for it.
    onRouteStrip(o, provider),
    h('div.cx-mapwrap', {}, mapHost, dock, cx(1)),
    h(
      'div.ph-block.ph-block-tight.cx-mapkey',
      {},
      h(
        'div.cx-mapkey-row',
        {},
        // `LEVEL_LABEL` (markerui.ts): the same four words a marker's own aria-label now
        // reads out for its "conditions" field, so the chip legend and the marker can never
        // drift into two different names for one band.
        ...([0, 1, 2, 3] as const).map((lv) => h('span.cx-mapkey-chip', { class: `lv-${lv}` }, LEVEL_LABEL[lv])),
        // The key for the map's dashed overlay, and ONLY where that overlay is actually
        // drawn. `crossesTreeline` is the same test `exposedFeature` makes before emitting
        // anything (mapconcept.ts), called rather than re-derived, so the frame can never
        // print a key for a mark that is not on screen or leave a dash on screen with
        // nothing to explain it. In the Ozarks both are absent together.
        crossesTreeline(j)
          ? h(
              'span.cx-mapkey-tl',
              {},
              h('i.cx-mapkey-dash', {}),
              'Above treeline',
            )
          : null,
      ),
      cx(2),
    ),
    h(
      'div.ph-tabs',
      {},
      ...['Explore', 'For You', 'Navigate', 'Saved', 'Activity'].map((t, i) =>
        h('div.ph-tab', { class: i === 2 ? 'is-on' : '' }, t),
      ),
    ),
  );
  return { app, mapHost, dock };
}

// ============================================================================
// PAGE
// ============================================================================

function sec(id: string, over: string, title: string, ...kids: (HTMLElement | string)[]): HTMLElement {
  return h(
    'section.cx-sec',
    { id },
    h('div.cx-over', {}, over),
    h('h2', {}, title),
    ...kids.map((k) => (typeof k === 'string' ? h('p', {}, k) : k)),
  );
}

/** A tight, one-line-per-item list. Same `.cx-list` styling as before; the difference from
 *  a `<p>` is a bold two- or three-word lead so a scanning reader can find the claim. */
function tightList(items: [string, string][]): HTMLElement {
  return h(
    'ul.cx-list',
    {},
    ...items.map(([lead, body]) => h('li', {}, h('strong', {}, `${lead} `), body)),
  );
}

// ============================================================================
// REBUILDABLE SECTIONS
// ============================================================================
//
// The primary map section and both demoted alternatives are the only parts of the page
// that change when the traversal control fires (see the top-of-file header note). Each is
// built whole by its own function, prose and all, rather than patching just the phone
// frame inside an unchanged wrapper, so a number in the surrounding text can never quote
// the journey the reader is no longer looking at.

function buildConceptA(
  o: OnRoute,
  provider: WeatherProvider,
  onTraversalChange: (next: Traversal) => void,
  onAnchorChange: (next: boolean) => void,
): { section: HTMLElement; mapHost: HTMLElement; dock: HTMLElement } {
  const j = o.journey;
  const cShell = conceptAShell(o, provider, onTraversalChange, onAnchorChange);

  const section = sec(
    'concept-a',
    'Concept A',
    'Route on a pitched 3D map',
    tightList([
      [
        'Air and ground.',
        'Air is the Super Resolution forecast; ground is the trail-wetness prototype. Winter snow is deferred.',
      ],
      [
        // Measured FROM THE WALKER rather than from the provider's origin, which is the same
        // number it always was while planning (the reader is at the origin then) and the only
        // honest one once the walk is under way. The word budget is unchanged: this is a
        // clause moving, not a clause being added.
        'Horizon.',
        `Super Resolution reaches ${Math.round(j.horizonHours)} h ahead; this walk ends ${Math.round(j.endHour - o.nowHour)} h out, a today-and-tomorrow screen.`,
      ],
    ]),
    h(
      'div.cx-pair',
      {},
      frame('Concept A · 3D map', journeyClock(provider, o.nowHour), cShell.app),
      annotations([
        // Rewritten four times now for the marker layer, each time because the marker's own
        // behaviour changed and copy describing the old behaviour is worse than no copy: for
        // the expanded card the map used to place on the route, for §12's reversal of the
        // label-clearance fix, for §13's split of the anchor from the card, and now for the
        // walking anchor, which gives a dot two more states to be in. Still two lines and
        // still inside the page's word budget — a swap, not an addition.
        ['Dots sit on the route.', 'The open one steps off the line, on a leader.'],
        ['Behind you they mute.', 'Past the cached run they read Outlook.'],
      ]),
    ),
  );
  return { section, mapHost: cShell.mapHost, dock: cShell.dock };
}

function buildConceptB(
  o: OnRoute,
  provider: WeatherProvider,
  onTraversalChange: (next: Traversal) => void,
  onAnchorChange: (next: boolean) => void,
  selectedKind: MarkerKind | null,
  onSelect: (kind: MarkerKind) => void,
): HTMLElement {
  const el = conceptB(o, provider, onTraversalChange, onAnchorChange, selectedKind, onSelect);
  return sec(
    'concept-b',
    'Concept B',
    'Conditions along the elevation profile',
    `Also kept: the same markers and strip, over the profile (exaggerated ${Math.round(chartExaggeration(o.journey))}x to stay legible).`,
    frame('Concept B · planning', journeyClock(provider, o.nowHour), el),
  );
}

function buildConceptC(
  o: OnRoute,
  provider: WeatherProvider,
  onTraversalChange: (next: Traversal) => void,
  onAnchorChange: (next: boolean) => void,
): HTMLElement {
  return sec(
    'concept-c',
    'Concept C',
    'Tabular readout',
    'Also kept: the same journey as rows of numbers, weather-iconed but unmarked.',
    frame(
      'Concept C · tabular',
      journeyClock(provider, o.nowHour),
      conceptC(o, provider, onTraversalChange, onAnchorChange),
    ),
  );
}

async function boot(): Promise<void> {
  mountNav('trail');
  const root = document.getElementById('cx-root');
  if (!root) return;

  const region = REGIONS[REGION];
  const trail = pickTrail(REGION);
  const provider = simulatedProvider('storms', REGION);

  // THE THREE PIECES OF PAGE STATE. Everything else here is drawn once and never touched
  // again (see the top-of-file note on why these controls alone are wired for real).
  //
  //   traversal  the user's, in the phone. Starts at the honest default for this trail's own
  //              `routeType`, per TRAIL_PLAN §6/§8 and SCOPE_PLAN §8's 92 to 97 percent figure.
  //   started    the user's, in the phone: which of §1's two anchors the screen reads against.
  //              False, so the page a reader meets first is the page it has always been.
  //   ageHours   NOT the user's, and that is the whole §6 argument for where it lives. See the
  //              control rail below.
  let traversal: Traversal = defaultTraversal(trail.routeType);
  let started = false;
  let ageHours = 0;

  const journeyFor = (walking: boolean, trav: Traversal): Promise<Journey> =>
    buildJourney(trail, region, provider, {
      departHour: departHours(provider, walking ? WALK_DAY : DEPART_DAY, DEPART_CLOCK),
      pace: PACE,
      traversal: trav,
    });

  let j = await journeyFor(started, traversal);
  let o = buildOnRoute(j, provider, { started, elapsedH: ONROUTE_ELAPSED_H, ageHours });

  // The two offline ages the control rail offers, computed ONCE, from the walking anchor's own
  // journey at the default traversal, and never recomputed. How old a device's cached run is
  // has nothing to do with which way the reader walks the trail, and freezing it is what makes
  // the sharpest demonstration on the page possible: the SAME 34 h run fails to reach the
  // out-and-back's 15:21 finish and does reach the one-way's 13:30 one, so the page's own live
  // control flips the answer with nothing about the device having changed. See
  // `cacheAgeHours` for how each is derived.
  const walkingBase = await journeyFor(true, traversal);
  const AGES = cacheAgeHours(
    walkingBase,
    provider,
    walkingBase.departHour + ONROUTE_ELAPSED_H,
  );

  /** The one chip in the page's own meta row that goes stale against state, and the only
   *  reason it is held as a reference rather than built inline: the planning anchor departs
   *  tomorrow and the walking one departs today, and TRAIL_PLAN §10 records the category
   *  ("any string that describes the shape of the walk rather than a measured value is a
   *  candidate") from the first time a live control created this class of bug. Updated by
   *  `syncChrome` below rather than rebuilt, so the segmented control beside it keeps its
   *  focus. */
  const departChip = h('span', {}, '');
  const setDepartChip = (): void => {
    departChip.textContent = `Depart ${journeyClock(provider, j.departHour)} ${started ? 'today' : 'tomorrow'}, ${paceDef(j.pace).label.toLowerCase()} pace`;
  };

  /**
   * CONNECTION, as hours since the cached run was fetched, and it is DOC CHROME. The §6 rule
   * is that the phone holds the user's own decisions and the page holds the prototype's
   * levers, and this is the clearest case of the second the page has: a walker does not
   * DECIDE to be offline and cannot decide how old their cache is. It is a fact about a
   * device and a valley, in exactly the way the scenario is a fact about a day, and it sits
   * where the scenario would. What goes in the phone is the INDICATOR (`dataAgeChip`), which
   * is what a product would show; what goes out here is the switch, which no product has.
   *
   * `scope/doc.ts` reached the same conclusion for the discovery page and put its own
   * Connection control in the chrome rail, so this is one rule applied twice rather than a
   * second answer to the same question.
   */
  function connectionRail(): HTMLElement {
    const options = [
      { hours: 0, label: 'Online' },
      { hours: AGES.atTrailhead, label: `Offline ${AGES.atTrailhead} h` },
      { hours: AGES.runsOut, label: `Offline ${AGES.runsOut} h` },
    ];
    const buttons = options.map((opt) => {
      const btn = h(
        'button',
        { type: 'button', class: opt.hours === ageHours ? 'is-on' : '' },
        opt.label,
      ) as HTMLButtonElement;
      btn.setAttribute('aria-pressed', String(opt.hours === ageHours));
      btn.addEventListener('click', () => {
        if (opt.hours === ageHours) return;
        ageHours = opt.hours;
        buttons.forEach((b, i) => {
          b.classList.toggle('is-on', options[i].hours === ageHours);
          b.setAttribute('aria-pressed', String(options[i].hours === ageHours));
        });
        void applyState();
      });
      return btn;
    });
    return h(
      'div.cx-chrome',
      {},
      h('span.cx-chrome-label', {}, 'Connection'),
      h('div.cx-seg', {}, ...buttons),
    );
  }

  root.appendChild(
    h(
      'header.cx-head',
      {},
      h('div.cx-over', {}, 'TrailScope · Trail mode'),
      h('h1', {}, 'Weather along the route'),
      h(
        'p.cx-lede',
        {},
        'The trail on a pitched terrain map: tap a marker for the air and the ground at that point.',
      ),
      h(
        'div.cx-meta',
        {},
        h('span', {}, `${trail.name}, ${region.name}`),
        h('span', {}, 'Scenario: afternoon storms'),
        departChip,
        h('span', {}, 'Weather simulated · terrain real'),
      ),
      connectionRail(),
    ),
  );

  // ---- the primary screen: Concept A, rebuilt on every traversal change -------------
  let mapHandle: ConceptAHandle | undefined;
  let busy = false;

  // The tapped marker in each concept, carried across a traversal rebuild (both concepts
  // are torn down and rebuilt whole on one, so neither can remember it on its own). `null`
  // means "nothing tapped yet, use the default". Two separate variables, deliberately: a
  // reader can select different markers in the map and in the chart, and a traversal that
  // removes one concept's selection (a one-way journey losing its `turn` marker) must not
  // reach into the other concept's state — `resolveSelection` (markerui.ts) is what falls
  // each one back to the default independently, on the SAME rule, without the two ever
  // needing to agree with each other. Both start at `null`: the sensible first reading is
  // the default (the high point), not a hand-picked marker.
  let mapSelected: MarkerKind | null = null;
  let chartSelected: MarkerKind | null = null;

  /** Appends a section on the first render; on every render after, replaces whatever is
   *  already at that id in place, so first-render document order never has to be
   *  re-derived. */
  function mountOrReplace(id: string, el: HTMLElement): void {
    const existing = document.getElementById(id);
    if (existing) existing.replaceWith(el);
    else root!.appendChild(el);
  }

  function renderPrimary(): void {
    // The old map is torn down before the new one is mounted: `PhoneMap` owns live
    // MapLibre resources (a GL context, tile requests in flight), and leaving the old
    // instance running while a second one spins up on a fresh trail would leak.
    mapHandle?.destroy();
    const { section, mapHost, dock } = buildConceptA(o, provider, applyTraversal, applyAnchor);
    mountOrReplace('concept-a', section);
    // mountConceptAMap needs its container already live in the DOM with real pixel
    // dimensions; `mountOrReplace` just guaranteed that by attaching `section` above.
    // `onSelect` writes back whichever marker the map actually resolved to (the tapped
    // one, or the default it fell back to), so the NEXT traversal rebuild starts from
    // what is genuinely on screen rather than a stale request.
    mapHandle = mountConceptAMap(mapHost, dock, o, provider, UNITS, mapSelected, (kind) => {
      mapSelected = kind;
    });
  }

  function renderConceptB(): void {
    const section = buildConceptB(o, provider, applyTraversal, applyAnchor, chartSelected, (kind) => {
      chartSelected = kind;
    });
    mountOrReplace('concept-b', section);
  }

  function renderAlternatives(): void {
    renderConceptB();
    mountOrReplace('concept-c', buildConceptC(o, provider, applyTraversal, applyAnchor));
  }

  /**
   * ONE REBUILD PATH FOR ALL THREE CONTROLS, which is the answer to TRAIL_PLAN §10's recorded
   * bug class rather than a tidiness preference.
   *
   * §10's finding was that a page with state can have copy that goes stale against it, and
   * that it is found by clicking rather than by reading. Three independent controls now feed
   * the same render — traversal (in the phone), the anchor (in the phone), the cache age (in
   * the chrome) — and any of them can change any of the others' output: the anchor moves the
   * journey to a different day, the cache age moves the wall, and the traversal moves the
   * finish the wall is compared against. So none of them patches anything. Each writes its
   * own variable and then every one of them runs the SAME rebuild: one `Journey`, one
   * `OnRoute`, all three frames from scratch. There is no path by which a frame can be drawn
   * from one state and its surrounding prose from another.
   *
   * `busy` guards against a second click landing while `buildJourney`'s weather fetch for the
   * first is still in flight.
   */
  async function applyState(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      j = await journeyFor(started, traversal);
      o = buildOnRoute(j, provider, { started, elapsedH: ONROUTE_ELAPSED_H, ageHours });
      setDepartChip();
      renderPrimary();
      renderAlternatives();
    } finally {
      busy = false;
    }
  }

  async function applyTraversal(next: Traversal): Promise<void> {
    if (next === traversal) return;
    traversal = next;
    await applyState();
  }

  async function applyAnchor(next: boolean): Promise<void> {
    if (next === started) return;
    started = next;
    await applyState();
  }

  setDepartChip();
  renderPrimary();

  // ---- limits: static, condensed to one line each ------------------------------------
  root.appendChild(
    sec(
      'limits',
      'Limits',
      'What the data does not support',
      tightList([
        ['Ground is trail-wide.', `One surface tag per trail (holdsWater ${j.holdsWater.toFixed(2)}), not per segment.`],
        ['Markers are thin.', 'No junction or water-crossing markers in the data.'],
        ['Flat ground shows little.', 'The map reads almost blank over low-relief regions.'],
      ]),
    ),
  );

  // ---- alternatives: Concepts B and C, demoted but still live ------------------------
  renderAlternatives();

  root.appendChild(
    h(
      'footer.cx-foot',
      {},
      // `provider.label` is the fidelity word the chip shows ("simulated"), not a system
      // name, so "simulated at ${label}" rendered as "simulated at simulated · afternoon
      // storms". The label carries its own verb; the sentence must not supply a second one.
      `Trail geometry © OpenStreetMap contributors (ODbL); elevation from Terrarium tiles; weather is ${provider.label}.`,
    ),
  );
}

void boot();
