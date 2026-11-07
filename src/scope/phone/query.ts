// Trail Scope phone — search, filtering and sorting. Pure functions, no DOM.
//
// Two rules this file exists to keep:
//
//   1. Condition filters call `matchesConditionFilter` from the grader. They never
//      re-derive weather logic here, because a filter that disagreed with the pill on the
//      same card would quietly destroy the page's whole argument.
//   2. Ranking is never silent. Every comparator is named in `SORTS` and the list header
//      prints the active one; this file only decides the order.

import { haversineMeters } from '../model';
import { compareByRating } from '../ugc';
import { matchesConditionFilter } from '../weather/grade';
import type { ConditionContext } from '../weather/grade';
import type {
  ConditionGrade,
  Filters,
  Range,
  RegionDef,
  ScopeTrail,
  SortId,
} from '../types';

// ============================================================================
// SEARCH
// ============================================================================

/** Word-prefix match, the behaviour a user expects from a trail name field. */
export function matchesQuery(trail: ScopeTrail, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const name = trail.name.toLowerCase();
  if (name.includes(q)) return true;
  const terms = q.split(/\s+/);
  return terms.every((t) => name.split(/[\s\-/]+/).some((w) => w.startsWith(t)));
}

// ============================================================================
// FILTERS
// ============================================================================

function inRange(value: number, r: Range): boolean {
  if (r.min !== null && value < r.min) return false;
  if (r.max !== null && value > r.max) return false;
  return true;
}

export interface FilterInput {
  trail: ScopeTrail;
  region: RegionDef;
  /**
   * Grade for the day the reader picked in the day bar. Null while the cache is filling.
   * It is the only day any condition filter reads: the day bar owns the date dimension,
   * so no filter carries a day of its own.
   */
  today: ConditionGrade | null;
}

/**
 * All non-condition facets. Split out because they are cheap and grade-independent, so the
 * chip row can show a live count before the grade cache has filled.
 */
export function matchesTerrainFilters(trail: ScopeTrail, f: Filters): boolean {
  if (f.difficulty.length && !f.difficulty.includes(trail.difficulty)) return false;
  if (f.routeTypes.length && !f.routeTypes.includes(trail.routeType)) return false;
  if (f.surfaces.length && !(trail.surface && f.surfaces.includes(trail.surface))) return false;
  if (f.activities.length && !f.activities.some((a) => trail.activities.includes(a))) return false;
  if (!inRange(trail.lengthM, f.lengthM)) return false;
  if (!inRange(trail.gainM, f.gainM)) return false;
  if (!inRange(trail.maxElevM, f.maxElevM)) return false;
  if (!inRange(trail.estMinutes, f.estMinutes)) return false;
  return true;
}

export function matchesFilters(input: FilterInput, f: Filters): boolean {
  if (!matchesTerrainFilters(input.trail, f)) return false;
  if (f.conditions.length === 0) return true;

  // A pending grade cannot pass a condition test. Rather than guess, the trail stays out
  // until the cache fills and the list re-renders; grading resolves in the same tick.
  if (!input.today) return false;

  const ctx: ConditionContext = {
    trail: input.trail,
    region: input.region,
    today: input.today,
  };
  return f.conditions.every((id) => matchesConditionFilter(id, ctx));
}

// ============================================================================
// SORT
// ============================================================================

export interface SortInput {
  trail: ScopeTrail;
  grade: ConditionGrade | null;
  /** Straight-line metres from the region's assumed location to the trailhead. */
  awayM: number;
}

export function distanceAwayM(trail: ScopeTrail, region: RegionDef): number {
  return haversineMeters(region.assumedLocation, trail.start);
}

/**
 * The prominence proxy, deliberately weak (SCOPE_PLAN §6). It stands in for the popularity
 * signal open data does not carry, and the page says so in as many words rather than
 * dressing it up as a ranking.
 */
function prominence(t: ScopeTrail): number {
  return t.prominence;
}

function gradeScore(g: ConditionGrade | null): number {
  return g ? g.score : -1;
}

type Cmp = (a: SortInput, b: SortInput) => number;

// Both conditions comparators rank on the grade for the day the reader picked, which is
// the grade the caller passes in. Neither is tied to today; the list header says which day
// the ranking is for.
const COMPARATORS: Record<SortId, Cmp> = {
  // Conditions first, then the prominence proxy, then distance from the assumed location.
  'best-conditions': (a, b) =>
    gradeScore(b.grade) - gradeScore(a.grade) ||
    prominence(b.trail) - prominence(a.trail) ||
    a.awayM - b.awayM,
  // The grade and nothing else, with prominence only as a tiebreak inside a level.
  'conditions-only': (a, b) => gradeScore(b.grade) - gradeScore(a.grade) || prominence(b.trail) - prominence(a.trail),
  // The one sort open data alone could not offer. It exists because the prototype adds
  // UGC, and it ranks on sample ratings: fabricated content, labelled as such everywhere
  // it surfaces.
  //
  // Almost nothing is rated, which is the honest day-one picture (src/scope/ugc.ts), so
  // this sort mostly decides what happens to the unrated majority. It puts the rated few
  // on top in rating order and leaves everything else in the prominence order the rest of
  // the list uses. The list header and the sort sheet both say so: a sort that quietly
  // buries most of the list is the silent ranking this page argues against.
  'top-rated': (a, b) =>
    compareByRating(a.trail.id, b.trail.id) || prominence(b.trail) - prominence(a.trail),
  closest: (a, b) => a.awayM - b.awayM,
  shortest: (a, b) => a.trail.lengthM - b.trail.lengthM,
  longest: (a, b) => b.trail.lengthM - a.trail.lengthM,
  'least-gain': (a, b) => a.trail.gainM - b.trail.gainM,
  'most-gain': (a, b) => b.trail.gainM - a.trail.gainM,
  easiest: (a, b) => a.trail.difficultyScore - b.trail.difficultyScore,
  hardest: (a, b) => b.trail.difficultyScore - a.trail.difficultyScore,
};

/**
 * Sort in place. The final tiebreak is the trail id, so two routes that tie on every key
 * keep a stable order between renders instead of swapping and looking like churn.
 */
export function sortTrails(rows: SortInput[], sort: SortId): SortInput[] {
  const cmp = COMPARATORS[sort];
  return rows.sort((a, b) => cmp(a, b) || (a.trail.id < b.trail.id ? -1 : a.trail.id > b.trail.id ? 1 : 0));
}
