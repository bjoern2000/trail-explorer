// Trail Scope — region registry, UI vocabulary, and unit formatting.
//
// Pure data and pure functions. No DOM, no derived-JSON imports (those land in
// data.ts once scope/derive.mjs has run), so this file is safe to import from
// anywhere including a headless check script.
//
// Everything in ScopeTrail is SI at rest. Conversion happens here and only here, at
// the moment a number becomes a string, so the imperial/metric toggle can never
// desync the grader from the display.

import type { Units } from '../types';
import type {
  Activity,
  ConditionFilterId,
  Difficulty,
  Filters,
  RegionDef,
  RegionId,
  RouteType,
  SortDef,
  SortId,
} from './types';

// ============================================================================
// REGIONS
// ============================================================================

/**
 * Sentinel for a region with no treeline. Set above any possible route so the exposure
 * term stays inert, which is the correct result rather than a special case in the
 * grader. It is a sentinel, not a measurement, so it must never reach the UI as a
 * number: use hasTreeline() before printing it.
 */
export const NO_TREELINE_M = 9999;

// bboxes are byte-identical to benchmark/derive.mjs and merge/fixture.mjs, so a trail
// that appears on the benchmark page is the same trail here.
//
// treelineM is a real grading input, not decoration: a route whose maxElevM sits above
// it during convection is the dangerous case the product exists to warn about. Values
// are local upper limit of continuous forest, rounded to the nearest 25 m.
export const REGIONS: Record<RegionId, RegionDef> = {
  rmnp: {
    id: 'rmnp',
    name: 'Rocky Mountain National Park',
    where: 'Colorado',
    bbox: [-105.75, 40.25, -105.55, 40.42],
    assumedLocation: [-105.5217, 40.3772],
    assumedLocationLabel: 'Estes Park, Colorado',
    // Front Range treeline runs ~11,200 to 11,500 ft.
    treelineM: 3450,
    manager: 'National Park Service',
  },
  adk: {
    id: 'adk',
    name: 'Adirondack High Peaks',
    where: 'New York',
    bbox: [-74.02, 44.05, -73.78, 44.26],
    assumedLocation: [-73.9799, 44.2795],
    assumedLocationLabel: 'Lake Placid, New York',
    // Adirondack alpine zone begins far lower than the Rockies, ~4,000 to 4,300 ft.
    // This is why the same forecast grades differently in the two regions.
    treelineM: 1250,
    manager: 'New York State Forest Preserve',
  },
  ozarks: {
    id: 'ozarks',
    name: 'Lake of the Ozarks',
    where: 'Missouri',
    bbox: [-92.85, 37.95, -92.55, 38.2],
    assumedLocation: [-92.7446, 38.0086],
    assumedLocationLabel: 'Camdenton, Missouri',
    // No treeline exists here; the region tops out around 350 m. See NO_TREELINE_M.
    treelineM: NO_TREELINE_M,
    manager: 'Missouri DNR state parks',
  },
};

export const REGION_IDS: RegionId[] = ['rmnp', 'adk', 'ozarks'];

export function hasTreeline(region: RegionDef): boolean {
  return region.treelineM < NO_TREELINE_M;
}

// ============================================================================
// UI VOCABULARY
// ============================================================================

// Default first, then the alternatives. The conditions sorts reorder, but never silently:
// the list header names the active sort AND the day it ranks for, and every card carries
// the pill that explains its position (SCOPE_PLAN §6).
//
// Neither label names a day. Which day the list is ranked for is the day bar's job, and a
// sort called "Best today" while the day bar says Tomorrow is a straight contradiction.
export const SORTS: SortDef[] = [
  { id: 'best-conditions', label: 'Best conditions' },
  { id: 'conditions-only', label: 'Conditions only' },
  // The sort open data alone could not support. It exists here because the prototype
  // adds UGC, which is the only way the crowd signal ever arrives.
  { id: 'top-rated', label: 'Top rated' },
  { id: 'closest', label: 'Closest' },
  { id: 'shortest', label: 'Shortest' },
  { id: 'longest', label: 'Longest' },
  { id: 'least-gain', label: 'Least climbing' },
  { id: 'most-gain', label: 'Most climbing' },
  { id: 'easiest', label: 'Easiest' },
  { id: 'hardest', label: 'Hardest' },
];

export const DEFAULT_SORT: SortId = 'best-conditions';

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: 'Easy',
  moderate: 'Moderate',
  hard: 'Hard',
};

export const ROUTE_TYPE_LABEL: Record<RouteType, string> = {
  loop: 'Loop',
  'point-to-point': 'Point to point',
};

export const ACTIVITY_LABEL: Record<Activity, string> = {
  hike: 'Hike',
  run: 'Trail run',
  bike: 'Mountain bike',
};

// Two of the five priority activities from the Round 2 research plan (snowboarding and
// downhill skiing) are absent on purpose: the science team's feasibility response
// defers winter snow state as an open research problem, so there is nothing honest to
// grade. The UI shows them as out of scope rather than pretending.
export const OUT_OF_SCOPE_ACTIVITIES = ['Snowboard', 'Downhill ski'];

export const CONDITION_FILTER_LABEL: Record<ConditionFilterId, string> = {
  'good-conditions': 'Good conditions',
  dry: 'Dry underfoot',
  'storm-free': 'Storm-free window',
  'below-treeline': 'Below treeline',
  shaded: 'Shaded',
};

export const CONDITION_FILTER_IDS: ConditionFilterId[] = [
  'good-conditions',
  'dry',
  'storm-free',
  'below-treeline',
  'shaded',
];

/** Empty filter set. Every range unbounded, every list empty. */
export function emptyFilters(): Filters {
  return {
    conditions: [],
    difficulty: [],
    activities: [],
    routeTypes: [],
    surfaces: [],
    lengthM: { min: null, max: null },
    gainM: { min: null, max: null },
    maxElevM: { min: null, max: null },
    estMinutes: { min: null, max: null },
  };
}

/** How many filter groups are active, for the chip-row badge. */
export function activeFilterCount(f: Filters): number {
  let n = 0;
  n += f.conditions.length;
  n += f.difficulty.length;
  n += f.activities.length;
  n += f.routeTypes.length;
  n += f.surfaces.length;
  for (const r of [f.lengthM, f.gainM, f.maxElevM, f.estMinutes]) {
    if (r.min !== null || r.max !== null) n += 1;
  }
  return n;
}

// ============================================================================
// UNIT FORMATTING
// ============================================================================

const FEET_PER_METER = 3.28084;
const METERS_PER_MILE = 1609.344;
const MILES_PER_KM = 0.621371;

/** Thousands separator, no decimals. */
function group(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Trail length. Metric drops to metres under 1 km so short park loops do not all
 * read "0.4 km"; imperial stays in miles because that is how US trail signage reads.
 */
export function formatLength(m: number, units: Units): string {
  if (units === 'imperial') {
    const mi = m / METERS_PER_MILE;
    return mi < 0.1 ? `${group(m * FEET_PER_METER)} ft` : `${mi.toFixed(1)} mi`;
  }
  return m < 1000 ? `${group(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Elevation and elevation gain. Whole units: nobody needs a decimal foot. */
export function formatElevation(m: number, units: Units): string {
  return units === 'imperial' ? `${group(m * FEET_PER_METER)} ft` : `${group(m)} m`;
}

/** Duration, as AllTrails writes it: "1h 41m", "45m". */
export function formatDuration(minutes: number): string {
  const mins = Math.max(0, Math.round(minutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * True when a printed duration needs the "one way" qualifier rather than standing alone.
 *
 * `estMinutes` is Naismith computed on the trail's ONE-WAY length and gain
 * (`scope/derive.mjs`). On a loop that one-way line already is the whole circuit, so the
 * figure needs no qualifier. On a point-to-point trail it is only the walk out, and once the
 * card also names the type (`routeTypeGlyph` in `phone/ui.ts`), an unlabelled time stops
 * reading as merely ambiguous and starts reading as wrong: the reader now knows the trail
 * does not loop back, and infers a return the number never charged for.
 *
 * The fix is only ever a label, never a multiplier. Naismith adds 10 minutes per 100 m of
 * ASCENT, and a return leg has none (it retraces the descent), so doubling the one-way figure
 * overstates the outing rather than completing it: Flattop Mountain Trail's one-way 2h 37m
 * would double to 5h 14m, well past what the same rule charges for the round trip once the
 * return leg's ascent is correctly the outbound descent rather than a repeat of the climb.
 */
export function needsOneWayLabel(routeType: RouteType): boolean {
  return routeType !== 'loop';
}

export function formatTemp(c: number, units: Units): string {
  return units === 'imperial'
    ? `${Math.round(c * 1.8 + 32)}°F`
    : `${Math.round(c)}°C`;
}

export function formatSpeed(kph: number, units: Units): string {
  return units === 'imperial' ? `${Math.round(kph * MILES_PER_KM)} mph` : `${Math.round(kph)} km/h`;
}

/** Rainfall totals, for the wetness copy. */
export function formatPrecip(mm: number, units: Units): string {
  if (units === 'imperial') {
    const inches = mm / 25.4;
    return `${inches < 1 ? inches.toFixed(1) : Math.round(inches)}″`;
  }
  return `${group(mm)} mm`;
}

/** Straight-line distance from the assumed location, for the Closest sort and cards. */
export function formatDistanceAway(m: number, units: Units): string {
  return units === 'imperial'
    ? `${(m / METERS_PER_MILE).toFixed(1)} mi away`
    : `${(m / 1000).toFixed(1)} km away`;
}

/** House convention: no decimal places on percentages. */
export function formatPercent(fraction01: number): string {
  return `${Math.round(fraction01 * 100)}%`;
}

/** Clock label for a factor's onset hour, given the provider's hour-of-day origin. */
export function formatHourOfDay(hourOfDay: number): string {
  const h = ((Math.round(hourOfDay) % 24) + 24) % 24;
  return `${String(h).padStart(2, '0')}:00`;
}

// ============================================================================
// GEOMETRY HELPERS (shared by sorting, filtering, and the map)
// ============================================================================

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
