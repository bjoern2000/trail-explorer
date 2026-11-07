// Benchmark page — shared data model, outcome logic, and region registry.
//
// The derived benchmark JSON (benchmark/derived/<region>.json, meta.schemaVersion 2)
// is imported statically and bundled. It carries only route names, trailhead points,
// and per-source name-match aggregates — no AllTrails descriptions, photos, or review
// text. Adding a second region later is one more JSON import + one REGIONS entry.

import type { SourceId } from '../types';
import rmnpData from '../../benchmark/derived/rmnp.json';
import adkData from '../../benchmark/derived/adk.json';
import ozarksData from '../../benchmark/derived/ozarks.json';

// ---- derived-JSON contract (hand-written so tsc doesn't infer the 300 KB literal) ----

export type MatchTier = 'exact' | 'fuzzy' | null;

export type RouteType = 'loop' | 'out-and-back' | 'point-to-point';

export interface SourceMatch {
  matched: boolean;
  tier: MatchTier;
  rule: string | null;
  names: string[];
  featureIds: string[];
  distM: number | null;
  /** Summed geometric length (m) of ALL matched features; null when unmatched. */
  matchedLenM: number | null;
}

export interface Route {
  trailId: string;
  name: string;
  latitude: number;
  longitude: number;
  lengthMeters: number | null; // null when the snapshot lacks a length
  routeType: RouteType | null;
  difficulty: string | null;
  numReviews: number;
  excluded: boolean;
  exclusionReason: string | null;
  matches: Record<SourceId, SourceMatch>;
  anyMatch: boolean;
  nearestFeatureM: Record<string, number | null>;
  // Present only if a future scrape includes them; the current snapshot has neither.
  trailUrl?: string;
  avgRating?: number | null;
}

export interface CoverageBlock {
  matched: number;
  coveragePct: number;
  weightedCoveragePct: number;
  top25Matched: number;
  top25CoveragePct: number;
}

export interface SourceSummary {
  exact: CoverageBlock;
  inclFuzzy: CoverageBlock;
  distinctNamedTrails: number;
  distinctNamesInAllTrails: number;
  reverseCoveragePct: number;
}

/** Route-length-weighted coverage (demand-side: km of AllTrails routes covered). */
export interface LengthWeightedEntry {
  exactM: number;
  exactPct: number;
  inclFuzzyM: number;
  inclFuzzyPct: number;
}

export interface LengthWeighted {
  denomM: number; // summed length of eligible routes (m)
  denomRoutes: number;
  skippedNullLength: number;
  perSource: Record<SourceId, LengthWeightedEntry>;
  anySource: LengthWeightedEntry;
}

/**
 * Inventory-side: share of a source's named network referenced by ≥1 route,
 * deduplicated by feature. pct is null when the source has no named network in
 * the region (or the derive-time fetch failed → the whole entry is null).
 */
export interface NetworkMatchedEntry {
  namedM: number;
  matchedM: number;
  pct: number | null;
  featureCounts: { named: number; matchedUnique: number };
}

export interface RegionData {
  meta: {
    schemaVersion: number;
    region: string;
    bbox: [number, number, number, number]; // [w, s, e, n]
    scrapedAt: string;
    derivedAt: string;
    inBboxRoutes: number;
    droppedRoutes: number;
    sources: Record<SourceId, {
      featureCount: number;
      namedFeatureCount: number;
      uniqueNormalizedNameCount: number;
      capped: boolean;
      error: string | null;
    }>;
  };
  routes: Route[];
  summary: {
    bySource: Record<SourceId, SourceSummary>;
    anySource: { exact: CoverageBlock; inclFuzzy: CoverageBlock };
    excluded: {
      count: number;
      byReason: Record<string, number>;
      routes: { trailId: string; name: string; reason: string }[];
    };
    denominators: { raw: number; adjusted: number };
    networkPresence: Record<string, { count: number; pct: number }>;
    lengthWeighted: LengthWeighted;
    networkMatched: Record<SourceId, NetworkMatchedEntry | null>;
  };
}

// ---- region registry --------------------------------------------------------

export interface RegionEntry {
  id: string;
  label: string;
  data: RegionData;
}

// One entry per snapshotted region. Second region = one import above + one row here.
export const REGIONS: RegionEntry[] = [
  { id: 'rmnp', label: 'Rocky Mtn NP', data: rmnpData as unknown as RegionData },
  { id: 'adk', label: 'Adirondack High Peaks', data: adkData as unknown as RegionData },
  { id: 'ozarks', label: 'Lake of the Ozarks', data: ozarksData as unknown as RegionData },
];

// ---- outcome model ----------------------------------------------------------

export type Outcome = 'exact' | 'fuzzy' | 'unmatched' | 'excluded';

// The four outcome colors (spec). Mirrored as CSS variables in benchmark.html for
// map-independent chrome; kept here for the MapLibre paint expressions.
export const OUTCOME_COLOR: Record<Outcome, string> = {
  exact: '#1f8f55',
  fuzzy: '#ffb454',
  unmatched: '#d93a52',
  excluded: '#5d7a68',
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  exact: 'Exact match',
  fuzzy: 'Fuzzy match',
  unmatched: 'Unmatched',
  excluded: 'Excluded',
};

/** Canonical exclusion-reason display labels (detail card, table badge). */
export const REASON_LABEL: Record<string, string> = {
  road: 'road',
  'private-property': 'private property',
};

/** Short forms for the sidebar counts line, derived from REASON_LABEL explicitly. */
export const REASON_SHORT: Record<string, string> = {
  ...REASON_LABEL,
  'private-property': 'private',
};

/** Display labels for AllTrails route types (shown next to the length). */
export const ROUTE_TYPE_LABEL: Record<RouteType, string> = {
  loop: 'loop',
  'out-and-back': 'out & back',
  'point-to-point': 'point to point',
};

/** "6.4 km · out & back" — length plus route type, omitting whichever is missing. */
export function lengthWithType(lengthText: string, routeType: RouteType | null): string {
  return routeType ? `${lengthText} · ${ROUTE_TYPE_LABEL[routeType]}` : lengthText;
}

// Length-agreement audit band: matched length within [0.5x, 2x] of the expected
// corridor raises no marker; outside it we flag a possible weak match / partial
// coverage. Deliberately wide — segments vs routes never align exactly.
const MISMATCH_LOW = 0.5;
const MISMATCH_HIGH = 2.0;

/**
 * Audit hint: does a source's matched-segment length disagree badly with the route?
 * Expected one-way corridor = lengthMeters/2 for out-and-back (AllTrails counts the
 * round trip), lengthMeters for loop and point-to-point. Skipped (false) when the
 * route length or matched length is unavailable.
 */
export function lengthMismatch(route: Route, m: SourceMatch): boolean {
  if (!m.matched || m.matchedLenM == null || route.lengthMeters == null) return false;
  const expected = route.routeType === 'out-and-back' ? route.lengthMeters / 2 : route.lengthMeters;
  if (expected <= 0) return false;
  const ratio = m.matchedLenM / expected;
  return ratio < MISMATCH_LOW || ratio > MISMATCH_HIGH;
}

/** A route's outcome: excluded > any-exact > any-fuzzy > unmatched. */
export function outcomeOf(route: Route): Outcome {
  if (route.excluded) return 'excluded';
  const tiers = Object.values(route.matches).map((m) => m.tier);
  if (tiers.includes('exact')) return 'exact';
  if (tiers.includes('fuzzy')) return 'fuzzy';
  return 'unmatched';
}

/** Units chosen in the map app; shared via localStorage, defaults to metric. */
export function readUnits(): 'imperial' | 'metric' {
  try {
    return localStorage.getItem('trailscope-units') === 'imperial' ? 'imperial' : 'metric';
  } catch {
    return 'metric';
  }
}
