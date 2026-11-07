// Segment-merge page — headless run of the real pipeline over the frozen fixtures.
//
//   node merge/verify.mjs [id ...]
//
// Imports src/data/merge.ts directly (Node type-stripping; merge.ts deliberately has
// no browser imports) and prints what each stage does to each example. Two uses:
// confirming the page's numbers come from the shipped algorithm, and re-checking the
// fixtures after any change to the merge logic.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeTrailName,
  clusterSegmentsAll,
  chainSegmentsDetailed,
  mergeSegmentsToFeature,
  featureLengthMeters,
  featureParts,
  CHAIN_TOLERANCE_M,
  CLUSTER_GAP_M,
} from '../src/data/merge.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures');

const km = (m) => `${(m / 1000).toFixed(2)} km`;

/** Same conversion as src/data/overpass.ts: way elements → GeoJSON LineStrings. */
function toFeatures(elements) {
  return elements.map((el) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [p.lon, p.lat]) },
    properties: { ...el.tags, '@id': `way/${el.id}`, __fid: `osm:way/${el.id}`, __source: 'osm' },
  }));
}

function run(id) {
  const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, `${id}.json`), 'utf8'));
  const raw = toFeatures(fx.elements);
  const target = normalizeTrailName(fx.trailName);

  // Stage 2 — name grouping.
  const groups = new Map();
  for (const f of raw) {
    const key = normalizeTrailName(String(f.properties.name ?? ''));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const kept = groups.get(target) ?? [];

  // Stage 3 — spatial clustering.
  const { clusters, chosen } = clusterSegmentsAll(kept);
  const cluster = chosen >= 0 ? clusters[chosen] : { features: [], lengthM: 0 };

  // Stage 4 — chaining.
  const parts = cluster.features.flatMap((f) => featureParts(f)).filter((p) => p.length >= 2);
  const chains = chainSegmentsDetailed(parts);

  // Stage 5 — merged feature.
  const merged = mergeSegmentsToFeature(cluster.features, 'osm', fx.trailName);

  console.log(`\n=== ${id} — "${fx.term}" → "${fx.trailName}" (${fx.bboxKey}, ${fx.fetchedAt}) ===`);
  console.log(`  raw ways returned : ${raw.length} (${groups.size} distinct names)`);
  for (const [name, feats] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const mark = name === target ? '→' : ' ';
    console.log(`      ${mark} ${String(feats.length).padStart(2)} × ${name}`);
  }
  console.log(`  after name filter : ${kept.length} ways, ${km(kept.reduce((s, f) => s + featureLengthMeters(f), 0))}`);
  console.log(`  clusters (${CLUSTER_GAP_M} m)  : ${clusters.length} → kept ${cluster.features.length} ways, ${km(cluster.lengthM)}`);
  clusters.forEach((c, i) =>
    console.log(
      `      ${i === chosen ? '→' : ' '} cluster ${i + 1}: ${String(c.features.length).padStart(2)} ways, ${km(c.lengthM).padStart(9)}, centre ${((c.bbox[0] + c.bbox[2]) / 2).toFixed(3)},${((c.bbox[1] + c.bbox[3]) / 2).toFixed(3)}`,
    ),
  );
  console.log(`  chains (${CHAIN_TOLERANCE_M} m)    : ${parts.length} parts in → ${chains.length} chain(s) out`);
  chains.forEach((c, i) =>
    console.log(
      `      chain ${i + 1}: ${String(c.members.length).padStart(2)} segments, ${c.flipped.filter(Boolean).length} flipped, ${c.coords.length} vertices, ${km(featureLengthMeters({ type: 'Feature', geometry: { type: 'LineString', coordinates: c.coords }, properties: {} }))}`,
    ),
  );
  if (merged) {
    console.log(
      `  merged            : ${merged.geometry.type}, ${merged.properties.__parts} part(s), ${km(featureLengthMeters(merged))}, __segments=${merged.properties.__segments}`,
    );
  } else {
    console.log('  merged            : null (nothing to merge)');
  }
}

const ids =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
for (const id of ids) run(id);
