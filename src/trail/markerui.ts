// Trail mode — the marker vocabulary and detail dock shared by Concepts A and B.
//
// Both concepts draw the SAME seven-kind marker set (`journey.ts`'s `MarkerKind`) with the
// same icon per kind, the same real-button accessibility contract, and the same
// "tap swaps the dock" interaction, because a reader comparing the map against the profile
// chart is comparing two views of ONE journey and must not have to learn two vocabularies
// for what is the same fact. That is `journey.ts`'s own argument for building one `Journey`
// object instead of two, extended one layer up to the UI that reads it.
//
// WHY THE DOCK, NOT A POPOVER OVER THE POINT. Björn's original phrasing was a
// "tooltip-like UI"; this is a deliberate departure, for two reasons worth recording where
// the decision lives rather than only in prose that might get cut later:
//
//   1. On a 350-ish px wide frame, a floating card anchored to a point cannot be
//      guaranteed not to cover the route it is describing — that IS the bug this whole
//      change exists to fix, and a popover just moves the collision around rather than
//      removing it.
//   2. If nothing shows a reading until something is tapped, a reader who scrolls past
//      without touching the phone sees only icons, and the air/ground pair (temperature,
//      gust, storm probability; ground wetness) is this page's single strongest argument:
//      air is Deliverable 1 (terrain-aware weather, Super Resolution), ground is the
//      summer half of Deliverable 2. It has to be legible without interaction.
//
// So the dock is a fixed strip, pre-populated on load and swapped on tap, never emptied.
//
// THE ANCHOR AND THE CARD ARE NOW TWO OBJECTS, WHICH IS THE WHOLE FIX (TRAIL_PLAN §13).
// Two earlier attempts each solved half of this and each broke the other half, and the
// reason both failed is recorded here because it is the thing that explains this file's
// shape:
//
//   Attempt 1 pushed the marker's LABEL clear of the route line with a clearance search.
//   Line overlap went to zero and the marker stopped marking anything, because it kept
//   moving until it no longer sat at the place it named.
//   Attempt 2 anchored the content back on the line. The marker marked its place again and
//   three stacked cards blanketed the trail: measured, 69% of the rendered route line's own
//   pixels were covered by marker furniture.
//
// Neither could win, because the anchor and the card were ONE object: a card has to sit
// wherever the point is, and a point cannot be anywhere but on the line. Splitting them
// dissolves the trade rather than picking a side. A small dot stays exactly on the point and
// keeps the spatial claim; the card offsets off the line with a short leader; and only the
// SELECTED marker has a card at all, so the other two contribute a dot each and nothing more.
// Nothing is lost by that, because the dock below the map already carries the selected
// marker's full reading and was always the answer to "what does this marker say".
//
// The dot is not a bare dot: it is a level-coloured disc carrying the hour's weather glyph,
// which is EXACTLY the element Concept B's chart row already drew. That keeps reason 2 above
// intact — a reader who never touches the phone still sees every marker's sky, plus the
// selected one's full reading in the dock — and it collapses the two frames' markers into
// literally the same element rather than two densities of one vocabulary. `markerButton`'s
// old `detail` parameter is gone with it: there is no longer anything for it to switch on.
//
// CLUSTERING DIFFERS BETWEEN THE TWO CONCEPTS ON PURPOSE. Concept A groups markers by
// GEOGRAPHIC proximity (`mapconcept.ts`'s own `haversineMeters`): an out-and-back's
// depart and finish markers sit at the identical trailhead point and collapse to one pin,
// because two pins on top of each other on a map is nothing but visual noise. Concept B
// groups by TRAVEL DISTANCE (`clusterMarkersByTravel`, below): on a distance/time chart
// depart sits at x=0 and finish sits at the far edge, which are genuinely different
// moments of the walk and have to stay two separate points on that axis, even though they
// are the same physical place. Same input markers, different notion of "near", because the
// two frames are different spaces. Everything downstream of "here is a group of markers" —
// the icon, the aria-label, the dock's contents, the selection/default rule — is this one
// module, shared exactly.

import { h } from '../ui/dom';
import { icon, weatherGlyph } from '../scope/phone/ui';
import { formatSpeed, formatTemp } from '../scope/model';
import type { WeatherProvider, WeatherSample } from '../scope/types';
import type { Units } from '../types';
import {
  GROUND_WORD_TEXT,
  groundWord,
  journeyClock,
  journeyDuration,
  type Journey,
  type Level,
  type Marker,
  type MarkerKind,
  type Waypoint,
} from './journey';
import { isOutlook, isPassed, type OnRoute } from './onroute';
import { formatLength } from '../scope/model';

/** Two markers closer together than this are one place on the map or one point on the
 *  chart. Set from the measured gap between Flattop's two treeline-crossing samples
 *  (~70 m, adjacent indices in a 48-sample profile spaced ~130 m apart): comfortably
 *  merges neighbours in the downsampled profile without merging genuinely separate trail
 *  features apart by several hundred metres or more. Shared by both concepts' clustering
 *  (see the header note on why the DISTANCE METRIC still differs between them).
 *
 *  RECOMPUTED A SECOND TIME (TRAIL_PLAN §13), measured rather than reasoned. History, since
 *  this constant has now moved twice for the same pair of markers: 150 m originally, tuned
 *  against an 18 px icon-only pin; 650 m for §12's stacked card, which could not fit two of
 *  itself into the ~31 px this trail's fitted zoom gives Flattop's high point and turnaround
 *  (real, distinct places, 560 m apart on the ground). The anchor is a dot again now, so the
 *  question was reopened: with the badge gone, does that pair separate?
 *
 *  Measured answer, in the browser at the real fitted camera: yes, and the pair is two markers
 *  again. That pair projects 31.1 px apart (measured, `getBoundingClientRect` centres, not the
 *  ~31 px §12 estimated), and the dot's whole box is 30 px — a 26 px disc plus 2 px of padding
 *  each side, route.css's own account of why those are the numbers. 30 fits inside 31.1, so the
 *  two dots do not overlap, do not share hit area, and read as the two distinct places they
 *  are: the summit, and the point 8 minutes later where the walk turns for home. That is a
 *  marker recovered, which is the whole reason this constant was worth re-deriving rather than
 *  leaving at a value tuned for a badge that no longer exists.
 *
 *  SO THE RADIUS GOES BACK DOWN, to 300 m, and it is derived from the pair it must still MERGE
 *  rather than from the pair it must not: Flattop's two treeline crossings, ~70 m apart (two
 *  adjacent samples in a 48-sample profile spaced ~130 m). 300 m is a wide margin over 70 m and
 *  a wide margin under 560 m, which matters because the honest reading of this measurement is
 *  that the boundary is CLOSE: at this camera the screen scale is ~18 m/px, so a 30 px box
 *  collides at ~540 m of ground separation, and the pair sits at 560 m. Four percent of margin.
 *  Landing the constant at 300 rather than at, say, 500 does not widen that margin — nothing
 *  can, the margin is a fact about this trail at this zoom — but it does keep the constant
 *  anchored to a gap with room around it instead of to one without.
 *
 *  What this means for anyone reading it later: the 560 m pair separating is true of THIS trail
 *  at THIS fitted camera. A trail whose fit lands a little tighter would put the same two
 *  markers under 30 px and they would touch, and no metre-valued constant can see that coming.
 *  The map cannot borrow Concept B's fix for the same problem (`chartMergeRadiusM`, a pixel
 *  budget converted into metres per journey) because the chart's x-scale is fixed while the
 *  map's zoom belongs to the reader. If this ever needs to be robust rather than measured, the
 *  answer is a screen-space regroup on camera change, not a better constant.
 *
 *  Concept B's own radius is untouched, as before. */
export const MERGE_RADIUS_M = 300;

/**
 * The weather glyph's drawn size, per frame that draws one. Three numbers rather than one
 * because the three frames give it three different amounts of room, but ONE place so the
 * conditions vocabulary cannot end up at four sizes across a page that argues it is one
 * vocabulary.
 *
 * Scaled ~1.5x on Björn's call ("the weather icons need to be 1.5x bigger, in all
 * concepts"), from 15/13 px on the two markers, 14 px in the dock and 10 px on the table's
 * column headers. Rounded to whole pixels: a fractional SVG size is drawn onto a half-pixel
 * grid and a 20 px stroke-1.7 glyph is the level of detail where that starts to read as
 * blur rather than as weight.
 *
 *   `marker` (20, from 15 and 13)  Both concepts' dots, now literally the same element, so
 *                                  the two sizes collapse into one. This is the number that
 *                                  sets the disc's own 28 px diameter, which in turn sets
 *                                  `MERGE_RADIUS_M` — see that constant.
 *   `dock`   (21, from 14)         The docked strip's thermometer / wind / bolt / droplets.
 *                                  Fits inside `.cx-dock-row`'s existing 1.7 line-height at
 *                                  13 px, so the strip's own height does not move.
 *   `table`  (15, from 10)         Concept C, both the column headers and the per-row sky
 *                                  glyph. One number for the two, deliberately: they sit in
 *                                  the same grid and a header at one size over rows at
 *                                  another would read as two scales in one table.
 *
 * ONLY the weather family scales. Marker-kind glyphs, page chrome and `icon()`'s own default
 * are untouched, and `src/scope/**`'s copies of this vocabulary (the discovery app's area
 * strip, cards and peek) are deliberately left at their current size: that tree is read-only
 * from here, and the two pages are not read side by side.
 */
export const GLYPH_PX = { marker: 20, dock: 21, table: 15 } as const;

/**
 * The dot's full on-screen box, in px: a 26 px disc plus 2 px of padding each side, exactly as
 * route.css draws it.
 *
 * A number duplicated from CSS into TypeScript, which is a drift risk and is here anyway,
 * because two pieces of LAYOUT arithmetic outside the stylesheet have to agree with the drawn
 * size or they silently allow markers to touch: `mapconcept.ts`'s `MERGE_RADIUS_M` decision, and
 * `route.ts`'s chart-row spacing (`CHART_MERGE_GAP_PX`, `layoutMarkerX`). Both of those were
 * previously written as their own literals derived by hand from the old 18 px disc, and both went
 * stale the moment the disc grew — `layoutMarkerX`'s 30 px minimum gap, chosen when the box was
 * 24 px wide and documented as carrying 2 px of headroom over the tap target, would have become
 * a gap of exactly one box width with no headroom at all. One constant, read by everything that
 * has to know, is the cheapest way to stop that happening a third time. route.css remains the
 * authority on what is DRAWN; this is what the code that positions it must be told.
 */
export const DOT_BOX_PX = 30;

/**
 * The sky's own word, one per glyph `weatherGlyph` can return.
 *
 * Exists for Concept C's per-row glyph, which is the one place in the app where the glyph
 * carries something the numbers beside it do not: a row prints temperature, gust and storm
 * probability, and none of those three distinguishes a wet hour from a merely cloudy one
 * (`weatherGlyph` decides that from `precipMm` and `cloudPct`). So the row's glyph gets a
 * real accessible name rather than `aria-hidden`, and it is one word rather than a phrase
 * because eighteen rows are reading it.
 *
 * Not risk language, and deliberately not a second scale (constraint kept): these name what
 * the sky is doing, in the same register `LEVEL_LABEL` names the storm band. "Storms" is the
 * word the page already prints for the same fact ("Storm peak", "% storm"), not a warning
 * added at the glyph.
 */
export const SKY_WORD: Record<string, string> = {
  sun: 'Clear',
  suncloud: 'Part cloud',
  cloud: 'Cloud',
  rain: 'Rain',
  bolt: 'Storms',
};

/** A group of markers close enough together to share one button and one dock reading. */
export interface MarkerGroup {
  /** Stable across a rebuild: the group's earliest (lowest-`travelM`) marker's kind. Each
   *  `MarkerKind` appears at most once in a journey's marker list (`journey.ts`'s
   *  `buildMarkers`), so this is a safe identity for "the same group" across a traversal
   *  toggle even though the actual `Marker` objects are freshly built every time. */
  id: MarkerKind;
  markers: Marker[];
  level: Level;
}

function buildGroup(markers: Marker[]): MarkerGroup {
  let level: Level = 0;
  for (const m of markers) level = Math.max(level, m.level) as Level;
  return { id: markers[0].kind, markers, level };
}

/**
 * Buckets `items` by proximity to an ANCHOR — the first member of each group — rather
 * than by proximity to whichever existing member is nearest. Anchor-based because both
 * call sites process a small, already-sorted run of points: a chain rule (join if close
 * to the group's LAST member) could walk a long gentle run into one giant group one
 * `radius` at a time, which an anchor rule cannot do.
 */
export function groupByProximity<T>(items: T[], distance: (anchor: T, item: T) => number, radius: number): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const near = groups.find((g) => distance(g[0], item) < radius);
    if (near) near.push(item);
    else groups.push([item]);
  }
  return groups;
}

/** Concept B's clustering: proximity along the walk itself. See the header note for why
 *  this is not the same rule as Concept A's geographic one. */
export function clusterMarkersByTravel(markers: Marker[], radiusM = MERGE_RADIUS_M): MarkerGroup[] {
  const sorted = [...markers].sort((a, b) => a.travelM - b.travelM);
  return groupByProximity(sorted, (a, b) => Math.abs(a.travelM - b.travelM), radiusM).map(buildGroup);
}

/** Wraps `groupByProximity` for callers (Concept A) whose members are richer than a bare
 *  `Marker` — `mapconcept.ts` pairs each one with a map point — while still producing a
 *  plain `MarkerGroup` at the end, so the rest of this module never has to know about
 *  lngLat at all. */
export function buildMarkerGroups<T extends { marker: Marker }>(
  withPos: T[],
  distance: (a: T, b: T) => number,
  radiusM: number,
): { group: MarkerGroup; anchor: T }[] {
  return groupByProximity(withPos, distance, radiusM).map((g) => ({
    group: buildGroup(g.map((x) => x.marker)),
    anchor: g[0],
  }));
}

/**
 * The sensible default reading: the journey's HIGH POINT, when the marker set has one.
 * That is the one place the air/ground pair (this page's whole argument) is most worth
 * reading side by side — the summit is where the forecast's terrain-aware half and the
 * ground's wetness half are both doing the most work at once. Falls back to whichever
 * group is not just the shared trailhead (depart and finish can be one group on an
 * out-and-back map), then to the first group there is, so the dock is never handed an
 * empty list.
 *
 * ON A WALK ALREADY UNDER WAY, THE DEFAULT HAS TO BE AHEAD OF THE WALKER. A dock opening on
 * a place the reader passed forty minutes ago answers a question nobody standing there is
 * asking, and it would be the second time this file had to learn that a default has to be
 * re-derived rather than assumed (`resolveSelection`, below, is the first). So a started
 * journey filters to what is still in front before applying exactly the same preference
 * order — the high point when it is still to come, otherwise the next real place. The
 * ordering itself is deliberately not re-argued for the walking case: the summit is the most
 * useful reading whether you are planning the day or partway up it.
 */
export function pickDefaultGroup(groups: MarkerGroup[], o?: OnRoute): MarkerGroup {
  const ahead =
    o && o.started ? groups.filter((g) => Math.max(...g.markers.map((m) => m.hour)) >= o.nowHour) : groups;
  const pool = ahead.length > 0 ? ahead : groups;
  const withHigh = pool.find((g) => g.markers.some((m) => m.kind === 'high'));
  if (withHigh) return withHigh;
  const notEndpoint = pool.find((g) => g.markers.some((m) => m.kind !== 'depart' && m.kind !== 'finish'));
  return notEndpoint ?? pool[0];
}

/**
 * The selection rule that survives a traversal toggle. `wanted` is the group `id`
 * (a `MarkerKind`) the reader last tapped, carried across the rebuild in `route.ts`'s own
 * state; `null` means "nothing tapped yet, use the default". If the group that id names
 * does not exist in the NEW marker set — a one-way journey has no `turn` marker — this
 * falls back to `pickDefaultGroup` rather than returning nothing, which is the bug class
 * TRAIL_PLAN.md §10 already records: state going stale against a re-render. There is no
 * other way for a caller to end up with a stale reading, because this is the only path
 * `route.ts` uses to go from "a traversal changed" to "here is what the dock shows now".
 */
export function resolveSelection(groups: MarkerGroup[], wanted: MarkerKind | null, o?: OnRoute): MarkerGroup {
  if (wanted != null) {
    const found = groups.find((g) => g.markers.some((m) => m.kind === wanted));
    if (found) return found;
  }
  return pickDefaultGroup(groups, o);
}

/** Every distinct marker label in a group, joined — a merged treeline crossing on the way
 *  up and the way down reads "Above treeline / Below treeline", never a repeated word. */
export function groupTitle(group: MarkerGroup): string {
  return [...new Set(group.markers.map((m) => m.label))].join(' / ');
}

/** Every distinct arrival time in a group, ascending. Deliberately short: this is the ONLY
 *  text drawn on the marker itself (`markerCard`'s top row), so a merged group's two times
 *  still has to read at a glance rather than as a sentence. It is also the reason the card is
 *  as wide as it is — a merged group prints two clock times, which is what made the badge this
 *  replaces 78 px wide rather than the 38 px a single time would have needed. */
export function groupTimes(group: MarkerGroup, provider: WeatherProvider): string {
  const mins = [...new Set(group.markers.map((m) => Math.round(m.hour * 60)))].sort((a, b) => a - b);
  return mins.map((m) => journeyClock(provider, m / 60)).join(' · ');
}

/**
 * The condition band's own word, shared by the map legend chips (`route.ts`'s
 * `.cx-mapkey-row`) and by every marker's aria-label, so the word a screen reader hears and
 * the chip a sighted reader sees can never drift into two names for one band.
 *
 * "Risk" USED TO BE BAND 2, and it was wrong twice over. It is risk language on a page whose
 * governing rule is that there is none (`TRAIL_PLAN.md` §1): a marker states a place, a time
 * and a measure, and the moment the legend says "Risk" the whole set reads as a hazard scale
 * rather than a storm-probability one. It also broke the scale as vocabulary, since
 * Calm / Slight / Risk / High is a state, then a degree, then a noun, then a degree, which is
 * three different kinds of word pretending to be four steps of one thing.
 *
 * These four are one kind of word: how likely a storm is, rising. That is exactly what the
 * bands measure (`levelForThunder`'s 0.12 / 0.30 / 0.55 cuts on thunder probability) and it
 * matches the number printed beside them everywhere else on the page ("48% storm").
 */
export const LEVEL_LABEL: Record<Level, string> = { 0: 'Calm', 1: 'Slight', 2: 'Moderate', 3: 'High' };

/**
 * The word that stands in for a storm band when there is no band to state.
 *
 * Past a cached run's hourly reach the four `LEVEL_LABEL` words are not available, because
 * every one of them is a claim about a specific hour at a specific point and that is exactly
 * what the run has run out of the right to say. "Outlook" is not a fifth band and must never
 * read as one: it is the same word the discovery day bar already prints under every day past
 * the wall, carried onto a marker so a reader who has met the constraint there meets one
 * vocabulary rather than two.
 */
export const OUTLOOK_LABEL = 'Outlook';

/**
 * Which of three states a marker group is in, relative to the walker and to the cached run.
 *
 * The two tests are deliberately asymmetric, and both are the conservative reading:
 *
 *   PASSED needs the group's LATEST marker to be behind the walker. A merged group can hold
 *     two moments of the walk at one place — an out-and-back's map merges depart and finish at
 *     the trailhead — and calling that group "behind you" at 12:30 because you left at 11:00
 *     would mute the very marker that answers when you get back.
 *   OUTLOOK needs the group's EARLIEST marker to be past the run's reach, for the mirror
 *     reason: a group that straddles the wall still has something inside it the run may be
 *     quoted for, and degrading the whole group would give up a claim that is still good.
 *
 * Planning has nothing behind it, which `isPassed` already encodes, so this returns `live` or
 * `outlook` there and the walking branch costs the planning render nothing.
 */
export type MarkerPhase = 'passed' | 'live' | 'outlook';

export function groupPhase(group: MarkerGroup, o: OnRoute): MarkerPhase {
  const hours = group.markers.map((m) => m.hour);
  if (isPassed(o, Math.max(...hours))) return 'passed';
  if (isOutlook(o, Math.min(...hours))) return 'outlook';
  return 'live';
}

/**
 * Everything a group's dot, its open card and the dock read, at the COARSEST FORM ITS PHASE
 * ALLOWS, resolved once so the three cannot disagree.
 *
 * This is the same argument `journey.ts` makes for building one `Journey` and rendering it
 * three ways, applied to the one place a marker's numbers could now legitimately differ from
 * the waypoint under it. A marker past the cached run's reach may not be given that
 * waypoint's own hour: the hour is precisely what a stale run cannot supply. So it is given
 * the stretch's figures instead (`OnRoute.outlook`), which are identical for every marker
 * past the wall — and that repetition is the honest picture of how coarse the claim has
 * become, not a bug to hide by varying them.
 *
 * `SCOPE_PLAN.md` §4's rule holds: degrading means less certainty, not less content. Nothing
 * here empties, nothing shows a dash, and the ground line degrades with the air line because
 * it is computed from the same forecast.
 */
export interface GroupReading {
  phase: MarkerPhase;
  tempC: number;
  gustKph: number;
  thunderProb: number;
  groundWetMm: number;
  /** The weather glyph, or the calendar `outlook` glyph where no hour may be named. */
  glyph: string;
  /** The class the dot, the chart row and the map key all colour from. */
  levelClass: string;
  /** What a screen reader hears in place of the band. */
  levelWord: string;
}

export function groupReading(group: MarkerGroup, o: OnRoute): GroupReading {
  const wp = nearestWaypoint(o.journey, group.markers[0].travelM);
  const phase = groupPhase(group, o);
  if (phase === 'outlook' && o.outlook) {
    return {
      phase,
      ...o.outlook,
      glyph: 'outlook',
      levelClass: 'is-outlook',
      levelWord: OUTLOOK_LABEL,
    };
  }
  return {
    phase,
    tempC: wp.sample.tempC,
    gustKph: wp.sample.gustKph,
    thunderProb: wp.sample.thunderProb,
    groundWetMm: wp.groundWetMm,
    glyph: weatherIcon(group.level, wp.sample),
    levelClass: `lv-${group.level}`,
    levelWord: LEVEL_LABEL[group.level],
  };
}

/** What is what, when, how warm, and under what conditions: no more and no less than the
 *  aria-label requirement asks for. The `GroupReading` and `units` are handed in rather than
 *  resolved here so this stays a pure formatter over values the caller already looked up once
 *  (`markerDot`, below) — the same reading the visible temperature and the dock's own strip
 *  come from, so a screen reader and a sighted reader are never told two different numbers for
 *  the same marker, and a marker past the cached run's reach reads out "Outlook" to both
 *  rather than a band to one of them. */
export function groupAriaLabel(
  group: MarkerGroup,
  provider: WeatherProvider,
  reading: GroupReading,
  units: Units,
): string {
  return `${groupTitle(group)}, ${groupTimes(group, provider)}, ${formatTemp(reading.tempC, units)}, ${reading.levelWord}`;
}

/** The journey waypoint nearest a given travelled distance — shared lookup so the dock's
 *  reading and a group's own marker travelM can never disagree about which sample answers
 *  for a place. */
export function nearestWaypoint(j: Journey, travelM: number): Waypoint {
  return j.waypoints.reduce((a, b) => (Math.abs(b.travelM - travelM) < Math.abs(a.travelM - travelM) ? b : a));
}

/**
 * The marker's own weather glyph, chosen from the SAME `WeatherSample` the dock reads and
 * the SAME four condition bands that already colour the badge (`group.level`, i.e.
 * `journey.ts`'s `levelForThunder` cuts: thunderProb 0.12 / 0.30 / 0.55) — a second,
 * differently-tuned cut for the glyph is exactly the kind of drift TRAIL_PLAN keeps finding
 * elsewhere in this app, so the storm half of this decision reuses those cuts rather than
 * inventing its own.
 *
 * PRECEDENCE, THUNDER FIRST. `group.level` is already the max band any marker in the group
 * actually met, so it is read once here rather than re-derived from a single sample:
 *
 *   level 3 (thunderProb >= 0.55, "High")  -> bolt.     Once a storm is more likely than
 *                                                        not, that is the hour's whole
 *                                                        story; how much sky is visible
 *                                                        stops being the relevant fact.
 *   level 2 (thunderProb >= 0.30, "Moderate")  -> suncloud. Real, rising convective risk, but
 *                                                        not a committed storm — reads as
 *                                                        building cloud, not lightning that
 *                                                        has not happened.
 *   level 0/1 ("Calm"/"Slight")            -> cloudPct / precipMm decide it, below.
 *
 * BELOW LEVEL 2, thunderProb has nothing left to say (a calm and a slight hour both read as
 * "no real storm signal"), so the glyph falls back to what the sky is actually doing at that
 * hour: `cloudPct >= 0.5` (at or past half cover) OR `precipMm > 0` (anything registered,
 * even under a light or uncertain forecast) reads as `suncloud`; otherwise `sun`.
 *
 * THE GAP, RECORDED RATHER THAN WORKED AROUND. `src/scope/phone/ui.ts`'s shared `ICONS` map
 * has no plain overcast `cloud` and no `cloud-rain` glyph (only `sun`, `suncloud` and `bolt`
 * in this family; that file is read-only from here, per the redesign brief), so a Risk-band
 * hour and a merely-cloudy Calm-band hour share one glyph, and a wet-but-not-stormy hour is
 * not visually distinguishable from a merely-cloudy one. Both are the nearest available
 * glyph to the missing one, not a mistaken choice of a present one.
 */
/**
 * Delegates to the discovery app's `weatherGlyph`, which is the single home for this
 * precedence.
 *
 * This used to be a second copy of the rules, and the copy carried a real bug: it tested
 * `precipMm > 0`, so a trace of rain too small for any readout to print still drew a rain
 * cloud. The bluebird control scenario carries exactly such a trace, so the marker on a
 * cloudless day showed rain. `weatherGlyph` now owns the precipitation floor and applies it,
 * and ui.ts's own comment had already flagged this duplicate as the thing to collapse next
 * time this page was opened, so it is collapsed rather than fixed twice.
 *
 * `level` is passed as the band override because a marker stands for a GROUP of merged
 * samples and carries the worst band any of them met (`journey.ts`'s `levelForThunder`,
 * applied one level up), which is the same rule at a different granularity rather than a
 * different rule.
 */
function weatherIcon(level: Level, sample: WeatherSample): string {
  return weatherGlyph(sample.thunderProb, sample.precipMm, sample.cloudPct, level);
}

/**
 * THE DOT: one real, focusable button, sitting exactly on its own point.
 *
 * A place and a measure, never a warning. The glyph is the hour's WEATHER, not the marker's
 * kind, because kind is carried in full by `aria-label` (below) and by the group's position
 * ON the trail — where the reader taps already answers "which place" without a second glyph
 * competing for room to say it again.
 *
 * THIS IS THE ANCHOR, AND NOTHING ELSE (TRAIL_PLAN §13; the file header has the two failed
 * attempts that led here). Its whole job is to hold the spatial claim: it is what says "this
 * spot", it is small enough that holding that claim costs the route almost nothing, and its
 * rendered box does not change with selection — only a ring does — so it cannot drag its own
 * anchor around, which is the bug §11 spent a pass on. The time and the temperature moved OFF
 * it, to a card that offsets away from the line (`markerCard`) and to the dock, because those
 * are the two pieces that made the old badge big enough to blanket the trail.
 *
 * THE SAME ELEMENT IN BOTH CONCEPTS, with no size or content switch left between them. It
 * used to take a `detail` flag: Concept A drew a three-row card, Concept B a bare glyph. With
 * Concept A's extra rows moved to a card the flag had nothing left to select, so the map's dot
 * and the chart row's glyph are now one element at one size, which is the strongest form of
 * the one-vocabulary claim this module's header makes.
 *
 * 28 PX DISC FOR A 20 PX GLYPH (`GLYPH_PX.marker`), sized in route.css. That is the smallest
 * disc that leaves the glyph a legible margin inside its white casing, and it is what sets
 * the 34 px tap target and, through it, `MERGE_RADIUS_M`.
 */
export function markerDot(
  group: MarkerGroup,
  o: OnRoute,
  provider: WeatherProvider,
  units: Units,
  selected: boolean,
): HTMLButtonElement {
  // ONE READING, THREE ELEMENTS. Everything phase-dependent — the glyph, the colour class and
  // the word a screen reader hears — comes from `groupReading` rather than being decided here,
  // so a marker the cached run cannot answer for hourly cannot end up wearing a storm band on
  // the map while the dock beside it says Outlook.
  const r = groupReading(group, o);
  return h(
    'button.cx-mbtn',
    {
      type: 'button',
      class: `cx-mbtn ${r.levelClass}${r.phase === 'passed' ? ' is-passed' : ''}${selected ? ' is-selected' : ''}`,
      'aria-label': groupAriaLabel(group, provider, r, units),
      'aria-pressed': String(selected),
    },
    h('span.cx-mbtn-ic', {}, icon(r.glyph, GLYPH_PX.marker)),
  ) as HTMLButtonElement;
}

/**
 * THE CARD: the open marker's time and temperature, for the ONE marker that is selected.
 *
 * Two rows, in the order Björn asked for on the old badge (time above, temperature below)
 * minus the weather glyph, which moved to the dot and is the one piece of that stack every
 * marker still carries whether or not it is open. Nothing else goes on it: the air/ground
 * pair belongs to the dock, and a card that grew back toward a full reading would be walking
 * back into the bug this exists to fix.
 *
 * `aria-hidden`, because the dot's own `aria-label` already reads out this group's times and
 * temperature (`groupAriaLabel`). Without it a screen reader would hear the same two values
 * twice from one marker, once as the button's name and once as its content.
 *
 * WHERE it goes is not this module's business. Position is a screen-geometry question — which
 * side of the line has room, how the trail runs locally — and it is answered in
 * `mapconcept.ts`, which is the only file here that can project a lngLat. This one only
 * builds the box and lets the map place it.
 */
export function markerCard(
  group: MarkerGroup,
  o: OnRoute,
  provider: WeatherProvider,
  units: Units,
): HTMLElement {
  const r = groupReading(group, o);
  return h(
    'div.cx-mcard',
    { 'aria-hidden': 'true', class: r.phase === 'outlook' ? 'cx-mcard is-outlook' : 'cx-mcard' },
    h('span.cx-mcard-time', {}, groupTimes(group, provider)),
    h('span.cx-mcard-temp', {}, formatTemp(r.tempC, units)),
  );
}

/**
 * WHERE THE WALKER IS. One element, mounted by the map on its own lngLat and by the chart at
 * its own x, so the two frames cannot put "now" in two different places on the same walk.
 *
 * NOT A BUTTON, and not part of the marker set. Every `.cx-mbtn` on this page is a place the
 * journey names and a reading the dock can answer for; this is neither. It is where the reader
 * is standing, it has nothing to say beyond that, and making it selectable would put a
 * fourteenth entry in a tab order whose whole content is "somewhere you could tap for a
 * forecast". It carries a real accessible name instead, because a screen reader has no other
 * way to learn that the walk has a position at all.
 *
 * IT CARRIES NO GLYPH, and that is a correction. The first version used `navigate`, Lucide's
 * arrow, which is the mark the discovery app's own tab bar uses for the on-route half of the
 * product — and on the map it pointed north-east while the walker was heading west, because a
 * fixed glyph on a pitched, rotatable map has no idea which way anyone is going. An arrow that
 * states a heading it does not know is the same class of overclaim this page spends its
 * Limits section avoiding, so it is a plain location puck: a dark disc with a light core,
 * inverted against every marker's light disc with dark ink, which separates the two at a
 * glance and at any zoom without a second colour scale and without claiming a direction.
 */
export function positionMarker(o: OnRoute, provider: WeatherProvider, units: Units): HTMLElement {
  return h(
    'div.cx-me',
    {
      role: 'img',
      'aria-label': `You are here, ${journeyClock(provider, o.nowHour)}, ${formatLength(o.atTravelM, units)} in, ${journeyDuration(o.remainingMinutes)} left`,
    },
    h('span.cx-me-ic', {}, h('span.cx-me-core', {})),
  );
}

/**
 * Fills `dock` with one group's reading. The ONE piece of UI Concepts A and B share
 * outright rather than each building their own copy of, because a reader flipping between
 * the map and the chart to compare the same marker must read the exact same numbers in
 * the exact same shape, or the comparison itself becomes suspect.
 *
 * Icons on the air line are the SAME `thermometer` / `wind` / `bolt` glyphs Concept C's
 * table header uses for TEMP / GUST / STORM, so all three frames read as one vocabulary
 * rather than three, at `GLYPH_PX.dock` — see that constant for the ~1.5x scale-up and why
 * this strip's own height does not move under it.
 *
 * THE DOCK IS NOW LOAD-BEARING IN A WAY IT WAS NOT. It used to be the fuller reading behind a
 * tap, with a badge on the map already printing time and temperature for every marker. With
 * the badge split into a dot plus one open card (TRAIL_PLAN §13), this strip is the ONLY place
 * an unselected marker's numbers can be read at all — which is the trade that made the split
 * affordable, since it was already pre-populated on load and already carried more than the
 * badge ever did.
 */
export function renderDock(dock: HTMLElement, group: MarkerGroup, o: OnRoute, provider: WeatherProvider, units: Units): void {
  const r = groupReading(group, o);
  const word = GROUND_WORD_TEXT[groundWord(r.groundWetMm, o.journey.holdsWater)];
  // THE STRIP KEEPS ITS SHAPE PAST THE WALL, and that is a size decision as much as an
  // editorial one. TRAIL_PLAN §13 leaves `DOCK_HEIGHT_PX` at 78 against a strip that measures
  // 98.2 px, on purpose, because it is the bottom clearance the map's camera fit reads and
  // correcting it would move the camera and invalidate every measurement in that section. So
  // the degraded reading takes no extra row: the same three figures at the coarser
  // granularity `groupReading` resolved, and the one word that says which granularity, in the
  // title line that already has room for it.
  const title = `${groupTitle(group)} · ${groupTimes(group, provider)}${r.phase === 'outlook' ? ' · OUTLOOK' : ''}`;
  dock.replaceChildren(
    h('div.cx-dock-t', { class: r.phase === 'outlook' ? 'is-outlook' : '' }, title),
    h(
      'div.cx-dock-row',
      {},
      h('span.cx-dock-fig', {}, icon('thermometer', GLYPH_PX.dock), formatTemp(r.tempC, units)),
      h('span.cx-dock-fig', {}, icon('wind', GLYPH_PX.dock), `${formatSpeed(r.gustKph, units)} gust`),
      h('span.cx-dock-fig', {}, icon('bolt', GLYPH_PX.dock), `${Math.round(r.thunderProb * 100)}% storm`),
    ),
    h('div.cx-dock-row', {}, h('span.cx-dock-fig', {}, icon('droplets', GLYPH_PX.dock), word)),
  );
}

/**
 * The selection state machine both concepts run, factored to one place so "tap a marker,
 * the dock updates, the marker reads selected" cannot drift into two slightly different
 * implementations. Callers own MOUNTING each button (a `maplibregl.Marker` for the map, a
 * plain absolutely-positioned append for the chart) because that part genuinely differs;
 * everything after "here is a group and its button" is this.
 *
 * NO DECLUTTER PASS (TRAIL_PLAN §12, still true at §13). An older version hid a marker's time
 * text at runtime whenever it overlapped the dock, a neighbour's icon, or another label — a
 * tool that only worked because the text was optional bonus content on top of an icon that was
 * never hidden. A dot has no sub-part that can be hidden without losing the fact it exists to
 * state, so marker-to-marker overlap is prevented earlier, by grouping: `MERGE_RADIUS_M` on
 * the map, a minimum on-screen gap (`route.ts`'s `layoutMarkerX`) on the chart. What moves at
 * runtime now is one thing only, and it is not a marker: the OPEN CARD's offset direction,
 * which `mapconcept.ts` recomputes as the camera moves. That is a different kind of fix-up —
 * it repositions furniture that is deliberately off the line, rather than deciding whether a
 * marker may keep saying what it says.
 *
 * `onToggle` is how a caller hangs its own per-selection work off this one state machine
 * rather than watching the class list: the map uses it to show its open card and lay the card
 * out against the line, which needs a projection and so cannot live here. Concept B passes
 * nothing, because a glyph in a chart's top margin has nothing to reposition.
 *
 * `onSelect` fires once immediately, with whatever `resolveSelection` actually picked (the
 * requested marker, or the default it fell back to) — not only on a later tap — so the
 * caller's persisted state is corrected the moment a stale selection is discovered, rather
 * than only the NEXT time someone taps something.
 */
export interface MarkerController {
  /** The presently selected group's id. */
  current: () => MarkerKind;
  /** Registers one already-created button for `group`; call once per group, before
   *  `finish()`. Mounting the returned button into whatever DOM/map it belongs in is the
   *  caller's job, and so is anything else that has to follow selection: `onToggle` fires with
   *  this group's new state on every selection change, including the one `finish()` settles. */
  register: (group: MarkerGroup, el: HTMLButtonElement, onToggle?: (on: boolean) => void) => void;
  /** Renders the initial dock. Call once, after every `register`. */
  finish: () => void;
}

export function createMarkerController(
  dock: HTMLElement,
  groups: MarkerGroup[],
  initialKind: MarkerKind | null,
  o: OnRoute,
  provider: WeatherProvider,
  units: Units,
  onSelect: (kind: MarkerKind) => void,
): MarkerController {
  const entries: { group: MarkerGroup; el: HTMLButtonElement; onToggle?: (on: boolean) => void }[] = [];
  let current: MarkerKind = resolveSelection(groups, initialKind, o).id;

  const select = (kind: MarkerKind): void => {
    const g = groups.find((gr) => gr.id === kind);
    if (!g) return;
    current = g.id;
    for (const entry of entries) {
      const on = entry.group.id === g.id;
      entry.el.classList.toggle('is-selected', on);
      entry.el.setAttribute('aria-pressed', String(on));
      entry.onToggle?.(on);
    }
    renderDock(dock, g, o, provider, units);
    onSelect(g.id);
  };

  return {
    current: () => current,
    register: (group, el, onToggle) => {
      entries.push({ group, el, onToggle });
      // `stopPropagation` so a tap on a marker sitting on top of the MapLibre canvas
      // never also reaches the map's own click handler (a no-op today, `onPick: () =>
      // undefined` in mapconcept.ts, but a future one should not have to remember this
      // marker exists).
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        select(group.id);
      });
    },
    finish: () => {
      const g = groups.find((gr) => gr.id === current) ?? groups[0];
      // Routed through `select` rather than repeating its body, so `onToggle` fires for the
      // INITIAL selection too. It has to: on the map that is what opens the default marker's
      // card and lays it out, and a card that only appeared after the reader's first tap would
      // leave the default reading with no marker of its own to sit beside.
      select(g.id);
    },
  };
}
