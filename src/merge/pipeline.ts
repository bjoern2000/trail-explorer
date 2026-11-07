// Segment-merge page — runs the shipped merge pipeline and captures each stage.
//
// Nothing here reimplements the algorithm. It calls the same functions the map app's
// search uses (src/data/merge.ts) and records the intermediate results so the page can
// draw them: which ways the name filter kept, which spatial cluster won, which input
// segment ended up in which chain, and what the final feature looks like.
//
// The only page-local logic is the name grouping, which mirrors what search.ts and
// sidebar.ts do inline (group hits by normalizeTrailName, then merge one group).

import {
  normalizeTrailName,
  clusterSegmentsAll,
  chainSegmentsDetailed,
  mergeSegmentsToFeature,
  featureLengthMeters,
  featureParts,
  type ClusterInfo,
  type ChainDetail,
} from '../data/merge';
import type { FixtureWay } from './model';

export type StageId = 'raw' | 'named' | 'clustered' | 'chained' | 'merged';

export const STAGE_IDS: StageId[] = ['raw', 'named', 'clustered', 'chained', 'merged'];

export interface NameGroup {
  /** Display name as OSM carries it (first way's spelling). */
  name: string;
  norm: string;
  features: GeoJSON.Feature[];
  lengthM: number;
  /** True for the group the merge targets. */
  target: boolean;
}

export interface PipelineResult {
  /** Stage 1 — every way the API returned, as GeoJSON. */
  raw: GeoJSON.Feature[];
  /** Stage 2 — raw ways bucketed by normalized name, target group first. */
  groups: NameGroup[];
  kept: GeoJSON.Feature[];
  dropped: GeoJSON.Feature[];
  /** Stage 3 — spatial clusters of the kept ways. */
  clusters: ClusterInfo[];
  chosenCluster: number;
  clusterFeatures: GeoJSON.Feature[];
  /** Stage 4 — chains, plus one LineString Feature per chain for drawing. */
  chains: ChainDetail[];
  chainFeatures: GeoJSON.Feature[];
  /** Stage 5 — the single feature the app hands to the map. */
  merged: GeoJSON.Feature | null;
}

/** Same conversion as src/data/overpass.ts, on fixture or live `way` elements. */
export function waysToFeatures(elements: FixtureWay[]): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  for (const el of elements) {
    if (!Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    out.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [p.lon, p.lat]) },
      properties: {
        ...(el.tags ?? {}),
        '@id': `way/${el.id}`,
        __fid: `osm:way/${el.id}`,
        __source: 'osm',
      },
    });
  }
  return out;
}

function nameOf(f: GeoJSON.Feature): string {
  const n = (f.properties as Record<string, unknown> | null)?.name;
  return typeof n === 'string' ? n : '';
}

function lineFeature(coords: number[][], props: Record<string, unknown>): GeoJSON.Feature {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props };
}

/**
 * Run every stage over one fetched response. `trailName` selects the group to merge;
 * `anchor` is the map location a real search would carry (a clicked result), which is
 * what picks the cluster — omitted here, so clustering falls back to "keep the longest".
 */
export function runPipeline(
  elements: FixtureWay[],
  trailName: string,
  anchor?: [number, number],
): PipelineResult {
  const raw = waysToFeatures(elements);
  const target = normalizeTrailName(trailName);

  // ---- stage 2: group by normalized name -------------------------------------
  const buckets = new Map<string, GeoJSON.Feature[]>();
  const display = new Map<string, string>();
  for (const f of raw) {
    const norm = normalizeTrailName(nameOf(f));
    const arr = buckets.get(norm);
    if (arr) arr.push(f);
    else {
      buckets.set(norm, [f]);
      display.set(norm, nameOf(f) || '(unnamed)');
    }
  }
  const groups: NameGroup[] = [...buckets.entries()]
    .map(([norm, features]) => ({
      norm,
      name: display.get(norm) ?? norm,
      features,
      lengthM: features.reduce((s, f) => s + featureLengthMeters(f), 0),
      target: norm === target,
    }))
    .sort((a, b) => (a.target ? -1 : b.target ? 1 : b.features.length - a.features.length));

  const kept = buckets.get(target) ?? [];
  const keptSet = new Set(kept);
  const dropped = raw.filter((f) => !keptSet.has(f));

  // ---- stage 3: spatial clustering -------------------------------------------
  const { clusters, chosen } = clusterSegmentsAll(kept, anchor);
  const clusterFeatures = chosen >= 0 ? clusters[chosen].features : [];

  // ---- stage 4: topological chaining -----------------------------------------
  const parts = clusterFeatures.flatMap((f) => featureParts(f)).filter((p) => p.length >= 2);
  const chains = chainSegmentsDetailed(parts);
  const chainFeatures = chains.map((c, i) =>
    lineFeature(c.coords, {
      __chain: i,
      __segments: c.members.length,
      __flipped: c.flipped.filter(Boolean).length,
      __vertices: c.coords.length,
      __lengthM: featureLengthMeters(lineFeature(c.coords, {})),
    }),
  );

  // ---- stage 5: the merged feature -------------------------------------------
  const merged = mergeSegmentsToFeature(clusterFeatures, 'osm', trailName);

  return {
    raw,
    groups,
    kept,
    dropped,
    clusters,
    chosenCluster: chosen,
    clusterFeatures,
    chains,
    chainFeatures,
    merged,
  };
}

/** Total length of a feature list, in meters. */
export function lengthOf(features: GeoJSON.Feature[]): number {
  return features.reduce((s, f) => s + featureLengthMeters(f), 0);
}

/** The GeoJSON a given stage produces — what the drawer shows and copies. */
export function stageGeoJSON(r: PipelineResult, stage: StageId): GeoJSON.FeatureCollection | GeoJSON.Feature {
  switch (stage) {
    case 'raw':
      return { type: 'FeatureCollection', features: r.raw };
    case 'named':
      return { type: 'FeatureCollection', features: r.kept };
    case 'clustered':
      return { type: 'FeatureCollection', features: r.clusterFeatures };
    case 'chained':
      return { type: 'FeatureCollection', features: r.chainFeatures };
    case 'merged':
      return r.merged ?? { type: 'FeatureCollection', features: [] };
  }
}
