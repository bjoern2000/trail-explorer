// Segment-merge page — fixtures, example registry, and the per-example narrative.
//
// Each example is a frozen Overpass response (merge/fixtures/<id>.json, written by
// merge/fixture.mjs) plus the copy that explains what it teaches. The fixtures are
// bundled so the page renders identically for every reader; "Run live" re-issues the
// SAME query text against the live API through /api/overpass.
//
// Every number quoted in `finding` was produced by running the shipped merge code
// over the frozen fixture (merge/verify.mjs), not estimated.

import bearLake from '../../merge/fixtures/bear-lake.json';
import rockyTop from '../../merge/fixtures/rocky-top.json';
import vanHoevenberg from '../../merge/fixtures/van-hoevenberg.json';
import natureTrail from '../../merge/fixtures/nature-trail.json';
import longsPeak from '../../merge/fixtures/longs-peak.json';

/** One Overpass `way` element with inline geometry, as stored in a fixture. */
export interface FixtureWay {
  type: 'way';
  id: number;
  tags: Record<string, string>;
  geometry: { lat: number; lon: number }[];
}

/** A frozen Overpass response plus the query that produced it. */
export interface Fixture {
  id: string;
  /** The name fragment the user searched for. */
  term: string;
  /** The trail the merge targets — one of the names present in the response. */
  trailName: string;
  bboxKey: string;
  bbox: [number, number, number, number];
  /** Verbatim Overpass QL, shown on the page and reused by "Run live". */
  query: string;
  fetchedAt: string;
  wayCount: number;
  elements: FixtureWay[];
}

export interface Example {
  fixture: Fixture;
  /** Short name, shown on the figure that uses this example. */
  label: string;
  /** Where this is, in words a reader can place on a map. */
  where: string;
}

// The JSON modules type `bbox` as number[] and each way's tags as its own literal
// shape; the hand-written Fixture contract above is the authority, so cast through
// unknown rather than widening the contract to match the inference.
const FIXTURES = {
  bearLake: bearLake as unknown as Fixture,
  rockyTop: rockyTop as unknown as Fixture,
  vanHoevenberg: vanHoevenberg as unknown as Fixture,
  natureTrail: natureTrail as unknown as Fixture,
  longsPeak: longsPeak as unknown as Fixture,
};

/** Order is not meaningful: the document picks examples by id, per step. */
export const EXAMPLES: Example[] = [
  { fixture: FIXTURES.bearLake, label: 'Bear Lake', where: 'Rocky Mountain National Park, Colorado' },
  { fixture: FIXTURES.rockyTop, label: 'Rocky Top', where: 'Ha Ha Tonka State Park, Missouri' },
  { fixture: FIXTURES.vanHoevenberg, label: 'Van Hoevenberg', where: 'Adirondack High Peaks, New York' },
  { fixture: FIXTURES.natureTrail, label: 'Nature Trail', where: 'All of Colorado' },
  { fixture: FIXTURES.longsPeak, label: 'Longs Peak', where: 'Rocky Mountain National Park, Colorado' },
];

export function readUnits(): 'imperial' | 'metric' {
  try {
    return localStorage.getItem('trailscope-units') === 'imperial' ? 'imperial' : 'metric';
  } catch {
    return 'metric';
  }
}
