// Trail Scope — the committed derived trail data, and the two display rules.
//
// scope/derive.mjs writes one JSON per region and the page imports all three statically:
// deterministic, instant, offline-safe, and it cannot flake in front of an exec
// (SCOPE_PLAN.md §4). Nothing here fetches.
//
// DEFENSIVE READING. Three fields (`descentM`, `seamIndices`, `likelyRoad`) were added to
// the derived payload by the pipeline workstream and are absent from older snapshots, and
// six more (`canopy`, `canopyShare`, `aspectDeg`, `slopeDeg`, `meanAspectDeg`,
// `meanSlopeDeg`) arrived with scope/canopy.mjs. `types.ts` declares them as required, so
// this file is the one place that reconciles the two: every trail is normalised on load and
// the UI reads the normalised value. Missing descent becomes NaN rather than 0, because 0 m
// of descent is a real measurement and an absent one is not: the peek sheet omits the
// readout instead of printing a number nobody measured.
//
// `canopyShare` follows the same rule for the same reason, and it matters more here. 0 is a
// real and common measurement — RMNP has 23 trails genuinely above the drawn tree line, and
// Lake of the Ozarks reads 0 on 95 percent of its trails because nobody has drawn the
// forest — so an absent snapshot must not be able to impersonate either. Missing canopy is
// NaN and an empty flag array, and `hasCanopy` is the question a caller has to ask first.
//
// THE TWO DISPLAY RULES, and why they disclose rather than hide:
//
//   1. `likelyRoad` trails are out of the default list. In Lake of the Ozarks a large
//      share of named path/footway/track features are resort-subdivision streets tagged
//      `highway=track` (Lavender Lane, Hogan Circle). Showing them would make the
//      prototype look broken; dropping them silently would hide the finding that the
//      highway tag filter alone does not identify trails.
//   2. Trails under DISPLAY_FLOOR_M are out of the default list. The merge emits
//      whatever the network names, and some named fragments are three metres long.
//
// Both counts are surfaced to the UI, which prints them as a quiet line under the result
// count with a control to include them anyway. Silent filtering is not acceptable here:
// the exclusions ARE the finding.

import type {
  Activity,
  Difficulty,
  RegionData,
  RegionId,
  RouteType,
  ScopeTrail,
} from './types';
import { REGIONS } from './model';

import rmnpJson from '../../scope/derived/rmnp.json';
import adkJson from '../../scope/derived/adk.json';
import ozarksJson from '../../scope/derived/ozarks.json';

// ============================================================================
// LOADING
// ============================================================================

/** Shortest trail that appears in the default list, metres. */
export const DISPLAY_FLOOR_M = 200;

/** The fields newer derive runs add. Optional at rest, required after normalise. */
type AddedFields =
  | 'descentM'
  | 'seamIndices'
  | 'likelyRoad'
  | 'canopy'
  | 'canopyShare'
  | 'aspectDeg'
  | 'slopeDeg'
  | 'meanAspectDeg'
  | 'meanSlopeDeg';
type AddedRegionFields = 'canopy' | 'aspectSource';
type RawTrail = Omit<ScopeTrail, AddedFields> & Partial<Pick<ScopeTrail, AddedFields>>;
interface RawRegionData extends Omit<RegionData, 'trails' | AddedRegionFields>, Partial<Pick<RegionData, AddedRegionFields>> {
  trails: RawTrail[];
}

const numbers = (v: unknown): number[] | null => (Array.isArray(v) ? (v as number[]) : null);

function normalizeTrail(t: RawTrail): ScopeTrail {
  // Canopy and aspect travel together or not at all: they come from one pipeline stage over
  // one set of sample points, so a snapshot carrying one and not the other would mean the
  // stage half-ran. Keying every one of them off the presence of `canopy` makes that state
  // unrepresentable rather than merely unlikely.
  const canopy = numbers(t.canopy);
  return {
    ...t,
    descentM: typeof t.descentM === 'number' ? t.descentM : Number.NaN,
    seamIndices: Array.isArray(t.seamIndices) ? t.seamIndices : [],
    likelyRoad: t.likelyRoad === true,
    canopy: canopy ?? [],
    canopyShare: canopy !== null && typeof t.canopyShare === 'number' ? t.canopyShare : Number.NaN,
    aspectDeg: (canopy !== null ? numbers(t.aspectDeg) : null) ?? [],
    slopeDeg: (canopy !== null ? numbers(t.slopeDeg) : null) ?? [],
    meanAspectDeg: canopy !== null && typeof t.meanAspectDeg === 'number' ? t.meanAspectDeg : Number.NaN,
    meanSlopeDeg: canopy !== null && typeof t.meanSlopeDeg === 'number' ? t.meanSlopeDeg : Number.NaN,
  };
}

function normalizeRegion(raw: RawRegionData): RegionData {
  return {
    ...raw,
    canopy: raw.canopy ?? null,
    aspectSource: typeof raw.aspectSource === 'string' ? raw.aspectSource : null,
    trails: raw.trails.map(normalizeTrail),
  };
}

/**
 * True when this snapshot actually carries a measured descent. The peek sheet asks
 * before it prints, so a stale derived file loses one readout and nothing else.
 */
export function hasDescent(trail: ScopeTrail): boolean {
  return Number.isFinite(trail.descentM);
}

/**
 * True when this snapshot carries measured canopy and aspect. Ask before reading either:
 * `canopyShare` is NaN and the flag arrays are empty on a snapshot derived before
 * scope/canopy.mjs existed, and NaN is deliberate so an absence cannot be mistaken for the
 * very common real answer of zero.
 */
export function hasCanopy(trail: ScopeTrail): boolean {
  return trail.canopy.length > 0 && Number.isFinite(trail.canopyShare);
}

/**
 * Canopy flag at a fraction along the route, read at the same index `profileElevAt` reads
 * its elevation at, so the two can never disagree about where a point is. Returns null
 * when the snapshot carries no canopy, rather than a plausible-looking 0.
 */
export function canopyAt(trail: ScopeTrail, frac: number): number | null {
  if (!hasCanopy(trail)) return null;
  const f = Math.min(1, Math.max(0, frac));
  return trail.canopy[Math.round(f * (trail.canopy.length - 1))];
}

/**
 * Share of the region bbox OSM has drawn a wooded polygon over, or null on an old snapshot.
 *
 * The number that says how much to trust every `canopyShare` in the region. It is exposed
 * as its own function because the honest reading of a per-trail canopy figure is always a
 * pair: 0 percent canopy in a region that is 53 percent mapped is a measurement, and 0
 * percent in a region that is 9 percent mapped is an absence of one.
 */
export function canopyMappedShare(region: RegionId): number | null {
  return regionData(region).canopy?.mappedShare ?? null;
}

const RAW: Record<RegionId, RawRegionData> = {
  rmnp: rmnpJson as unknown as RawRegionData,
  adk: adkJson as unknown as RawRegionData,
  ozarks: ozarksJson as unknown as RawRegionData,
};

const LOADED: Partial<Record<RegionId, RegionData>> = {};

/** The whole derived payload for a region, normalised. Parsed once per region. */
export function regionData(region: RegionId): RegionData {
  const hit = LOADED[region];
  if (hit) return hit;
  const made = normalizeRegion(RAW[region]);
  LOADED[region] = made;
  return made;
}

/** Every derived trail in the region, including the ones the default list excludes. */
export function allTrails(region: RegionId): ScopeTrail[] {
  return regionData(region).trails;
}

// ============================================================================
// THE DISPLAY SET
// ============================================================================

export interface DisplaySet {
  /** What the list shows by default. */
  trails: ScopeTrail[];
  /** Excluded as subdivision streets rather than trails. */
  roadCount: number;
  /** Excluded as shorter than the display floor. */
  shortCount: number;
  /** roadCount + shortCount, deduplicated (a trail can be both). */
  excludedCount: number;
  floorM: number;
}

const DISPLAY_CACHE: Partial<Record<RegionId, DisplaySet>> = {};

export function displaySet(region: RegionId): DisplaySet {
  const hit = DISPLAY_CACHE[region];
  if (hit) return hit;

  const trails: ScopeTrail[] = [];
  let roadCount = 0;
  let shortCount = 0;
  let excludedCount = 0;

  for (const t of allTrails(region)) {
    const isRoad = t.likelyRoad;
    const isShort = t.lengthM < DISPLAY_FLOOR_M;
    if (isRoad) roadCount++;
    if (isShort) shortCount++;
    if (isRoad || isShort) excludedCount++;
    else trails.push(t);
  }

  const made: DisplaySet = { trails, roadCount, shortCount, excludedCount, floorM: DISPLAY_FLOOR_M };
  DISPLAY_CACHE[region] = made;
  return made;
}

/** Distinct OSM surface values present in a region, for the Surface filter group. */
export function regionSurfaces(region: RegionId): string[] {
  const seen = new Set<string>();
  for (const t of allTrails(region)) if (t.surface) seen.add(t.surface);
  return [...seen].sort();
}

// ============================================================================
// AGGREGATES FOR THE PROSE
// ============================================================================

/**
 * Every number the document interpolates via `dyn()`. Computed from the derived data at
 * render time so no total on the page is hand-typed (SCOPE_PLAN §8).
 */
export interface RegionStats {
  region: RegionId;
  regionName: string;
  where: string;
  manager: string;
  assumedLocationLabel: string;
  treelineM: number;

  /** Named OSM ways returned before merging. */
  wayCount: number;
  /** Distinct name-clusters after merging: every derived trail, exclusions included. */
  trailCount: number;
  /** What the default list actually shows. */
  shownCount: number;

  difficulty: Record<Difficulty, number>;
  routeType: Record<RouteType, number>;
  /** Share of trails carrying an OSM surface tag, 0..1. */
  surfacedShare: number;
  surfacedCount: number;
  /** Share flagged as subdivision streets rather than trails, 0..1. */
  likelyRoadShare: number;
  likelyRoadCount: number;
  /** Trails whose high point sits above the region's treeline. */
  aboveTreelineCount: number;
  /** Trails shorter than the display floor. */
  belowFloorCount: number;
  floorM: number;

  activities: Record<Activity, number>;
  multiPartCount: number;
  fetchedAt: string;
  elevationSource: string;
  query: string;
}

const STATS_CACHE: Partial<Record<RegionId, RegionStats>> = {};

export function regionStats(region: RegionId): RegionStats {
  const hit = STATS_CACHE[region];
  if (hit) return hit;

  const def = REGIONS[region];
  const data = regionData(region);
  const trails = data.trails;
  const shown = displaySet(region);

  const difficulty: Record<Difficulty, number> = { easy: 0, moderate: 0, hard: 0 };
  const routeType: Record<RouteType, number> = { loop: 0, 'point-to-point': 0 };
  const activities: Record<Activity, number> = { hike: 0, run: 0, bike: 0 };
  let surfacedCount = 0;
  let likelyRoadCount = 0;
  let aboveTreelineCount = 0;
  let belowFloorCount = 0;
  let multiPartCount = 0;

  for (const t of trails) {
    difficulty[t.difficulty]++;
    routeType[t.routeType]++;
    for (const a of t.activities) activities[a]++;
    if (t.surface) surfacedCount++;
    if (t.likelyRoad) likelyRoadCount++;
    if (t.maxElevM > def.treelineM) aboveTreelineCount++;
    if (t.lengthM < DISPLAY_FLOOR_M) belowFloorCount++;
    if (t.parts > 1) multiPartCount++;
  }

  const n = Math.max(1, trails.length);
  const made: RegionStats = {
    region,
    regionName: def.name,
    where: def.where,
    manager: def.manager,
    assumedLocationLabel: def.assumedLocationLabel,
    treelineM: def.treelineM,
    wayCount: data.wayCount,
    trailCount: trails.length,
    shownCount: shown.trails.length,
    difficulty,
    routeType,
    surfacedShare: surfacedCount / n,
    surfacedCount,
    likelyRoadShare: likelyRoadCount / n,
    likelyRoadCount,
    aboveTreelineCount,
    belowFloorCount,
    floorM: DISPLAY_FLOOR_M,
    activities,
    multiPartCount,
    fetchedAt: data.fetchedAt,
    elevationSource: data.elevationSource,
    query: data.query,
  };
  STATS_CACHE[region] = made;
  return made;
}
