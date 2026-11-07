// Segment-merge page — Overpass snapshot tool (standalone Node, no deps).
//
// Two modes, mirroring benchmark/derive.mjs conventions:
//
//   node merge/fixture.mjs probe <bboxKey> "<term>" [...more terms]
//       Count-only reconnaissance. Prints how many ways come back per term and the
//       distinct names among them, so examples are chosen from real data rather
//       than guessed. Cheap: same query, `out tags` instead of `out geom`.
//
//   node merge/fixture.mjs freeze <id> <bboxKey> "<term>" "<Exact Trail Name>"
//       Writes merge/fixtures/<id>.json: the query text, the bbox, the fetch date,
//       and the raw Overpass `way` elements with inline geometry. The page imports
//       these statically so it always renders identically for a reader, and the
//       live toggle re-runs the SAME query text through /api/overpass.
//
// The highway filter matches src/data/overpass.ts exactly (path|footway|track) so
// the page shows what the app itself would receive, not a prettier variant.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures');

// Single endpoint by choice; see the note in server.js. Retries below cover the
// overload 504s that are the actual failure mode.
const ENDPOINTS = ['https://overpass-api.de/api/interpreter'];

/** Named bboxes [w, s, e, n]. The three benchmark regions plus state-scale boxes. */
export const BBOXES = {
  rmnp: [-105.75, 40.25, -105.55, 40.42],
  adk: [-74.02, 44.05, -73.78, 44.26],
  ozarks: [-92.85, 37.95, -92.55, 38.2],
  colorado: [-109.06, 36.99, -102.04, 41.0],
  newyork: [-79.77, 40.49, -71.85, 45.02],
};

/** The query the app sends: named path/footway/track ways whose name contains `term`. */
export function buildQuery(bbox, term, mode = 'geom') {
  const [w, s, e, n] = bbox;
  const esc = term.replace(/["\\]/g, '\\$&');
  const out = mode === 'geom' ? 'out geom;' : 'out tags;';
  return `[out:json][timeout:90];
way["highway"~"^(path|footway|track)$"]["name"~"${esc}",i](${s},${w},${n},${e});
${out}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST to each mirror in turn, with backoff across rounds. Overpass 504s under load. */
async function overpass(query, rounds = 4) {
  let lastErr;
  for (let round = 0; round < rounds; round++) {
    for (const url of ENDPOINTS) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'TrailScope/0.1 (trail data source evaluation)',
          },
          body: new URLSearchParams({ data: query }),
        });
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        return await resp.json();
      } catch (err) {
        lastErr = err;
      }
    }
    if (round < rounds - 1) await sleep(5000 * (round + 1));
  }
  throw lastErr;
}

function nameCounts(elements) {
  const counts = new Map();
  for (const el of elements) {
    const name = el.tags?.name ?? '(unnamed)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function probe(bboxKey, terms) {
  const bbox = BBOXES[bboxKey];
  if (!bbox) throw new Error(`unknown bbox '${bboxKey}' (have: ${Object.keys(BBOXES).join(', ')})`);
  for (const term of terms) {
    let json;
    try {
      json = await overpass(buildQuery(bbox, term, 'tags'));
    } catch (err) {
      console.log(`\n${bboxKey} · "${term}" → FAILED: ${err.message}`);
      continue;
    }
    const els = (json.elements ?? []).filter((el) => el.type === 'way');
    const names = nameCounts(els);
    console.log(`\n${bboxKey} · "${term}" → ${els.length} ways, ${names.length} distinct names`);
    for (const [name, count] of names.slice(0, 12)) {
      console.log(`   ${String(count).padStart(3)} × ${name}`);
    }
    if (names.length > 12) console.log(`   … ${names.length - 12} more names`);
  }
}

async function freeze(id, bboxKey, term, trailName) {
  const bbox = BBOXES[bboxKey];
  if (!bbox) throw new Error(`unknown bbox '${bboxKey}'`);
  const query = buildQuery(bbox, term, 'geom');
  const json = await overpass(query);
  const ways = (json.elements ?? []).filter(
    (el) => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2,
  );
  const fixture = {
    id,
    term,
    trailName,
    bboxKey,
    bbox,
    query,
    fetchedAt: new Date().toISOString().slice(0, 10),
    wayCount: ways.length,
    elements: ways.map((el) => ({ type: 'way', id: el.id, tags: el.tags ?? {}, geometry: el.geometry })),
  };
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = join(FIXTURE_DIR, `${id}.json`);
  writeFileSync(file, JSON.stringify(fixture));
  const names = nameCounts(ways);
  console.log(`wrote ${file} — ${ways.length} ways, ${names.length} distinct names`);
  for (const [name, count] of names.slice(0, 10)) console.log(`   ${String(count).padStart(3)} × ${name}`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'probe') {
  await probe(rest[0], rest.slice(1));
} else if (mode === 'freeze') {
  await freeze(rest[0], rest[1], rest[2], rest[3]);
} else if (mode) {
  console.error(`unknown mode '${mode}' (use: probe | freeze)`);
  process.exit(1);
}
