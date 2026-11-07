// Region briefing — where the real data and the invented day meet.
//
// One module, one job: attach real trails to invented areas. `sample.ts` holds fiction and
// knows nothing about the derived data; `src/scope/data.ts` holds the derived data and
// knows nothing about the sample. This file is the only place the two are allowed to touch,
// so "which half of a sentence is real" is answerable by looking at which import a value
// came through.
//
// Everything here computes. The area a trail belongs to is computed from its real trailhead
// coordinate against a hand-placed centre; the per-area counts are counts of real trails.
// What is invented is where the centres are, which is to say the partition itself. Both
// halves of that are stated on the figure.

import { displaySet } from '../scope/data';
import { REGIONS, haversineMeters } from '../scope/model';
import type { RegionId, ScopeTrail } from '../scope/types';
import { SAMPLE_AREAS, SAMPLE_REGION, type SampleArea, type SampleLevel, planLevel } from './sample';

// ============================================================================
// AREA MEMBERSHIP
// ============================================================================

/**
 * The area a trail sits in: the nearest hand-placed centre to its trailhead.
 *
 * A NEAREST-CENTRE PARTITION RATHER THAN DRAWN BOUNDARIES, because a drawn boundary would
 * be a second invention needing a second justification, and because the honest description
 * of the five areas is "five points and a rule" rather than "five shapes somebody surveyed".
 * The rule is stated on the page in one line and a reader can reproduce it.
 *
 * Measured from the TRAILHEAD, not the centroid, because a briefing is read before a walk,
 * so the area that matters is the one the walk starts in. It does mis-file the handful of
 * long routes that cross between areas, and Fern Lake Trail is one of them: it starts on the
 * east moraines and ends under the Divide. Named on the page rather than papered over,
 * because a per-segment briefing is exactly what the real system would do and this mockup
 * cannot.
 */
export function areaOf(trail: ScopeTrail): SampleArea {
  let best = SAMPLE_AREAS[0];
  let bestM = Number.POSITIVE_INFINITY;
  for (const area of SAMPLE_AREAS) {
    const d = haversineMeters(trail.start, area.centre);
    if (d < bestM) {
      bestM = d;
      best = area;
    }
  }
  return best;
}

export interface AreaRollup {
  area: SampleArea;
  /** Real trails from the display set whose trailhead falls to this area. */
  trails: ScopeTrail[];
  /** What the plan tints this area: its invented level at `PLAN_HOUR`. */
  level: SampleLevel;
}

let ROLLUP: AreaRollup[] | null = null;

/**
 * Every area with its real trails, in the order `sample.ts` lists them (west to east).
 *
 * Computed once. The display set is the same one the results list shows, so a count here is
 * a count of trails a reader could actually have met on the discovery page, not of every
 * name-cluster the merge emitted.
 */
export function areaRollups(): AreaRollup[] {
  if (ROLLUP) return ROLLUP;

  const buckets = new Map<string, ScopeTrail[]>(SAMPLE_AREAS.map((a) => [a.id, []]));
  for (const trail of displaySet(SAMPLE_REGION).trails) {
    buckets.get(areaOf(trail).id)?.push(trail);
  }

  ROLLUP = SAMPLE_AREAS.map((area) => ({
    area,
    // Most prominent first, so an area's line of example names leads with the ones a reader
    // recognises. Prominence is the weak proxy SCOPE_PLAN §6 describes, used here only to
    // order three names in a caption, which is about all it can carry.
    trails: (buckets.get(area.id) ?? []).slice().sort((a, b) => b.prominence - a.prominence),
    level: planLevel(area),
  }));
  return ROLLUP;
}

/** Total real trails behind the briefing: the display set for the sample region. */
export function briefedTrailCount(): number {
  return displaySet(SAMPLE_REGION).trails.length;
}

// ============================================================================
// TRAIL LOOKUP
// ============================================================================

const BY_ID = new Map<string, ScopeTrail>();

/**
 * A derived trail by ID, or null.
 *
 * Returns null rather than throwing so one stale ID in `sample.ts` costs one card instead of
 * the page. A briefing missing a pick is legible; a blank document is not, and this page is
 * the one most likely to be opened cold in front of an audience.
 */
export function trailById(id: string): ScopeTrail | null {
  if (BY_ID.size === 0) {
    for (const t of displaySet(SAMPLE_REGION).trails) BY_ID.set(t.id, t);
  }
  return BY_ID.get(id) ?? null;
}

// ============================================================================
// REGION FACTS THE PAGE QUOTES
// ============================================================================

/** The sample region's own definition, for the treeline and the place names. */
export function sampleRegionDef(): (typeof REGIONS)[RegionId] {
  return REGIONS[SAMPLE_REGION];
}
