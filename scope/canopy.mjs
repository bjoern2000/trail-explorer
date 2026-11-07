// Trail Scope — canopy and terrain aspect derivation (standalone Node, no deps).
//
// This file answers the two questions `terrainFacts.shadedShare` was standing in for, and
// it deliberately keeps them apart rather than folding them into one "shade" number:
//
//   CANOPY          are there trees over the trail?      OSM landuse polygons.
//   TERRAIN SHADING is the sun behind the ridge?          the DEM plus sun geometry.
//
// A north-facing meadow is shaded with no canopy. A south-facing forest is canopied with
// very little sun relief. One number cannot carry both, and the proxy it replaces
// (`shadedShare = 1 - exposedShare`, "below treeline means trees") carries neither: it is
// a statement about elevation that has been asked to stand for vegetation.
//
// Only the offline half lives here. Aspect is a fact about the ground and never changes,
// so it is precomputed and committed. Whether the sun is above the horizon and on this
// side of the slope depends on the day and the hour, so it belongs at runtime and lives in
// src/scope/weather/shading.ts.
//
// THE LIMIT, STATED ONCE HERE AND AGAIN EVERYWHERE THE NUMBER IS EXPOSED. Aspect against
// sun azimuth gives SELF-SHADING only: whether the slope a walker is standing on faces
// away from the sun. It does not give CAST SHADOWS from neighbouring terrain. A valley
// floor lying in the shadow of a 4,000 m ridge reads as fully sunlit by this method,
// because its own ground is flat and pointed at the sky. Cast shadows need the DEM
// ray-cast along the sun vector; what that would cost is costed out in the header of
// src/scope/weather/shading.ts rather than attempted here. Any copy built on `aspectDeg`
// has to say "self-shading", not "shade".
//
// Four modes, mirroring scope/derive.mjs:
//
//   node scope/canopy.mjs probe <region|all>
//       Count-only Overpass reconnaissance over the wooded-polygon query. Free, and the
//       repo's own rule (CLAUDE.md): a capped Overpass fetch truncates SILENTLY, so the
//       count comes first. Also counts scrub and heath, which are NOT canopy, so the
//       exclusion is visible as a number rather than as an assertion.
//
//   node scope/canopy.mjs freeze <region|all> [--refetch]
//       Fetch the polygons and write scope/canopy/<region>.json. Committed, ODbL,
//       attributed, exactly like scope/derived/ and merge/fixtures/ and unlike the
//       gitignored benchmark/raw/.
//
//   node scope/canopy.mjs <region|all>
//       Read scope/derived/<region>.json, add the canopy and aspect fields to every trail,
//       write it back. Additive: no existing field is recomputed or touched.
//
//   node scope/canopy.mjs verify
//       Distributions from the committed files. No fetch.
//
// Two rules inherited from scope/derive.mjs and kept:
//   1. Nothing is reimplemented. Sample positions come from the SHIPPED
//      `routeSamplePoints`, so a canopy flag and a weather sample can never disagree about
//      where a point on the trail is. Elevation comes from scope/terrarium.mjs, which
//      reproduces src/data/elevation.ts numerically.
//   2. The region bbox is read from the derived payload itself, never re-declared here, so
//      the canopy query cannot cover a different patch of ground than the trails came from.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

import { loadTile, TILE_SIZE, TILE_Z } from './terrarium.mjs';

// Same resolve hook as scope/grade-check.mjs: it supplies only the file extension that
// TypeScript source omits, and changes no behaviour. The import has to be dynamic and
// below the hook, because a static import would be hoisted above it.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) {
      const candidate = new URL(`${spec}.ts`, ctx.parentURL);
      if (existsSync(fileURLToPath(candidate))) return next(`${spec}.ts`, ctx);
    }
    return next(spec, ctx);
  },
});

const { routeSamplePoints } = await import('../src/scope/weather/provider.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const DERIVED_DIR = join(HERE, 'derived');
/** Frozen wooded polygons, committed. See the header on why this is not gitignored. */
const CANOPY_DIR = join(HERE, 'canopy');
/** Raw Overpass responses keyed by query text, gitignored via .cache/, as derive.mjs does. */
const RAW_DIR = join(HERE, '..', '.cache', 'scope-canopy');

const ENDPOINTS = ['https://overpass-api.de/api/interpreter'];

/** Same cap as src/data/overpass.ts and scope/derive.mjs. Above this Overpass truncates. */
const OVERPASS_MAX_ELEMENTS = 6000;

/** src/scope/types.ts PROFILE_POINTS, duplicated exactly as scope/derive.mjs duplicates it,
 *  and asserted against the derived profiles below so a drift fails loudly. */
const PROFILE_POINTS = 48;

/**
 * What counts as canopy: closed `landuse=forest` and `natural=wood`, as ways and as
 * multipolygon relations.
 *
 * `natural=scrub` and `natural=heath` are deliberately OUT. Both are vegetation and
 * neither is a tree: krummholz above treeline and Ozark cedar glade are exactly the ground
 * where "below treeline means trees" was already wrong, and swapping one over-claim for
 * another would not be an improvement. The probe counts them anyway so the size of the
 * exclusion is a number on the console rather than a claim in a comment.
 *
 * `landcover=trees` exists in OSM and is rare in the US; it is not queried, and that is a
 * known small under-count rather than a decision.
 */
const CANOPY_FILTERS = [
  ['way', '["landuse"="forest"]'],
  ['way', '["natural"="wood"]'],
  ['relation', '["landuse"="forest"]'],
  ['relation', '["natural"="wood"]'],
];

/** Counted by the probe, never fetched. See CANOPY_FILTERS. */
const NON_CANOPY_FILTERS = [
  ['way', '["natural"="scrub"]'],
  ['way', '["natural"="heath"]'],
];

/**
 * Below this slope the DEM's aspect is noise, not ground truth, and is stored as -1.
 *
 * The reasoning, because the threshold is doing real work: terrarium z13 pixels are about
 * 14 m across at these latitudes and the source DEM under them is coarser still, so the
 * Horn window spans roughly 28 m. One to two metres of vertical DEM noise across that span
 * is ordinary, and two metres over 28 m is already 4 degrees. Two degrees is therefore a
 * floor, not a safe one: it keeps the obviously-flat out of the aspect histogram without
 * pretending the rest is clean. The share of samples below it is reported per region so
 * the reader can see how much of a region has no meaningful aspect at all.
 */
const ASPECT_FLAT_DEG = 2;

/** WGS84 equatorial circumference, the constant behind web-mercator ground resolution. */
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const WORLD_PX = 2 ** TILE_Z * TILE_SIZE;

const DEG = Math.PI / 180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, dp) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

// ---- Overpass -----------------------------------------------------------------

/**
 * The wooded-polygon query. `mode`: 'geom' is the real one (recorded verbatim into the
 * frozen file), 'count' is the free probe. The probe carries no element cap on purpose, so
 * it reports the TRUE count and therefore true headroom rather than a clipped 6,000.
 */
function buildQuery(bbox, filters = CANOPY_FILTERS, mode = 'geom') {
  const [w, s, e, n] = bbox;
  const body = filters.map(([type, tag]) => `  ${type}${tag}(${s},${w},${n},${e});`).join('\n');
  const out = mode === 'geom' ? `out geom qt ${OVERPASS_MAX_ELEMENTS};` : 'out count;';
  return `[out:json][timeout:180];\n(\n${body}\n);\n${out}`;
}

/** Same backoff shape as scope/derive.mjs: a burst gets the endpoint to drop connections
 *  outright and that cooldown is minutes, not seconds. */
async function overpass(query, rounds = 6) {
  let lastErr;
  for (let round_ = 0; round_ < rounds; round_++) {
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
        const text = await resp.text();
        // Overpass reports overload as an HTML error page with a 200 often enough that the
        // status alone is not the test; a body that opens with a tag never parses as JSON.
        if (!resp.ok || text.trimStart().startsWith('<')) {
          throw new Error(`${resp.status} ${text.slice(0, 90).replace(/\s+/g, ' ')}`);
        }
        return JSON.parse(text);
      } catch (err) {
        lastErr = err;
      }
    }
    if (round_ < rounds - 1) {
      const wait = 15000 * 2 ** round_;
      console.log(`  overpass retry ${round_ + 1}/${rounds - 1} in ${wait / 1000}s (${lastErr?.message})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function overpassCached(query, label, refetch = false) {
  mkdirSync(RAW_DIR, { recursive: true });
  const key = createHash('sha1').update(query).digest('hex').slice(0, 12);
  const file = join(RAW_DIR, `${label}-${key}.json`);
  if (!refetch && existsSync(file)) {
    console.log(`  overpass            : cached`);
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  const json = await overpass(query);
  writeFileSync(file, JSON.stringify(json));
  console.log(`  overpass            : fetched and cached`);
  return json;
}

// ---- polygon assembly ---------------------------------------------------------

/** Endpoint identity for ring chaining. Overpass echoes the node's own 7 dp coordinates,
 *  so two ways that share a node share this key exactly; no tolerance is needed or wanted. */
const nodeKey = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

const closed = (ring) => ring.length > 3 && nodeKey(ring[0]) === nodeKey(ring[ring.length - 1]);

/**
 * Chain a multipolygon relation's member ways into closed rings.
 *
 * OSM stores a multipolygon's boundary as a bag of ways in no particular order and no
 * particular direction, so this is a walk: take any unused way, then repeatedly find one
 * whose start or end matches the current end and append it, flipping when needed.
 *
 * A ring that will not close is kept and counted rather than dropped. It is usually a
 * relation whose boundary leaves the query bbox, and forcing it shut with a straight
 * segment across the gap is the right call for a containment test over a region we only
 * asked about: the alternative is a hole in the canopy where the data is merely clipped.
 * The count is reported, so if it is ever large the assumption is visible.
 */
function assembleRings(ways) {
  const pool = ways.map((w) => w.slice());
  const rings = [];
  let unclosed = 0;
  while (pool.length > 0) {
    let ring = pool.pop();
    if (!closed(ring)) {
      let grew = true;
      while (grew && !closed(ring)) {
        grew = false;
        const end = nodeKey(ring[ring.length - 1]);
        for (let i = 0; i < pool.length; i++) {
          const cand = pool[i];
          if (nodeKey(cand[0]) === end) {
            ring = ring.concat(cand.slice(1));
          } else if (nodeKey(cand[cand.length - 1]) === end) {
            ring = ring.concat(cand.slice(0, -1).reverse());
          } else {
            continue;
          }
          pool.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    if (ring.length < 4) continue;
    if (!closed(ring)) {
      ring.push(ring[0]);
      unclosed++;
    }
    rings.push(ring);
  }
  return { rings, unclosed };
}

function ringBbox(ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const c of ring) {
    if (c[0] < w) w = c[0];
    if (c[0] > e) e = c[0];
    if (c[1] < s) s = c[1];
    if (c[1] > n) n = c[1];
  }
  return [w, s, e, n];
}

function unionBbox(boxes) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const b of boxes) {
    if (b[0] < w) w = b[0];
    if (b[1] < s) s = b[1];
    if (b[2] > e) e = b[2];
    if (b[3] > n) n = b[3];
  }
  return [w, s, e, n];
}

/**
 * Overpass elements → canopy polygons with outer and inner rings.
 *
 * A closed way is one outer ring and no holes. A relation is assembled per role: `outer`
 * (and the empty role, which older data uses for outer) becomes outer rings, `inner`
 * becomes holes, so a clearing inside a forest is genuinely not canopy.
 */
function toPolygons(elements) {
  const polygons = [];
  const stats = { ways: 0, relations: 0, unclosed: 0, holes: 0, leafType: new Map(), skipped: 0 };
  for (const el of elements) {
    const tags = el.tags ?? {};
    const tag = tags.landuse === 'forest' ? 'landuse=forest' : tags.natural === 'wood' ? 'natural=wood' : null;
    if (tag === null) continue;
    const leaf = typeof tags.leaf_type === 'string' ? tags.leaf_type : 'untagged';

    if (el.type === 'way') {
      const ring = (el.geometry ?? []).filter((p) => p).map((p) => [p.lon, p.lat]);
      if (ring.length < 4) {
        stats.skipped++;
        continue;
      }
      if (!closed(ring)) ring.push(ring[0]);
      polygons.push({ id: `way/${el.id}`, tag, leaf, outer: [ring], inner: [] });
      stats.ways++;
    } else if (el.type === 'relation') {
      const outerWays = [];
      const innerWays = [];
      for (const m of el.members ?? []) {
        if (m.type !== 'way' || !Array.isArray(m.geometry)) continue;
        const line = m.geometry.filter((p) => p).map((p) => [p.lon, p.lat]);
        if (line.length < 2) continue;
        (m.role === 'inner' ? innerWays : outerWays).push(line);
      }
      const o = assembleRings(outerWays);
      const i = assembleRings(innerWays);
      stats.unclosed += o.unclosed + i.unclosed;
      stats.holes += i.rings.length;
      if (o.rings.length === 0) {
        stats.skipped++;
        continue;
      }
      polygons.push({ id: `relation/${el.id}`, tag, leaf, outer: o.rings, inner: i.rings });
      stats.relations++;
    }
    stats.leafType.set(leaf, (stats.leafType.get(leaf) ?? 0) + 1);
  }
  for (const p of polygons) {
    p.bbox = unionBbox(p.outer.map(ringBbox));
  }
  return { polygons, stats };
}

// ---- point in polygon ---------------------------------------------------------

/**
 * Ray casting in lon/lat degrees, unprojected on purpose. The test is topological — how
 * many edges a ray crosses — and topology survives the projection, so projecting first
 * would cost time and change no answer at these bbox sizes.
 */
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside any outer ring and inside no hole. */
function pointInPolygon(lon, lat, poly) {
  if (lon < poly.bbox[0] || lon > poly.bbox[2] || lat < poly.bbox[1] || lat > poly.bbox[3]) return false;
  let hit = false;
  for (const ring of poly.outer) {
    if (pointInRing(lon, lat, ring)) {
      hit = true;
      break;
    }
  }
  if (!hit) return false;
  for (const ring of poly.inner) if (pointInRing(lon, lat, ring)) return false;
  return true;
}

/** The polygon covering this point, or null. Returned rather than a boolean so the leaf
 *  type travels with the hit and the region report can say what kind of trees these are. */
function coveringPolygon(lon, lat, polygons) {
  for (const poly of polygons) if (pointInPolygon(lon, lat, poly)) return poly;
  return null;
}

/** Side of the uniform grid `mappedWoodedShare` lays over a region bbox. 120 x 120 is
 *  14,400 probes over roughly 20 km of ground, so each cell is a couple of hundred metres:
 *  fine enough to resolve a mapped forest block, coarse enough to run instantly. */
const MAPPED_GRID = 120;

/**
 * Share of the region bbox that OSM has drawn a wooded polygon over.
 *
 * THIS IS THE HONESTY NUMBER FOR THE WHOLE CANOPY FEATURE, and it exists because the first
 * run of this pipeline produced a result that looked like a measurement and was not. Lake
 * of the Ozarks came back at 2 percent canopy with 95 percent of its trails carrying no
 * trees at all, and the zero-canopy list included Turkey Pen Hollow Trail, Woodland Trail
 * and the Upland Flatwoods Section: trails whose own names say what is growing over them.
 * The ground there is wooded. What is missing is the polygon.
 *
 * So `canopyShare` measures OSM's mapping effort as much as it measures vegetation, and a
 * region-level share of the bbox is the cheapest available check on which of the two you
 * are reading. A region where half the bbox is drawn as forest is one where a zero means
 * something; a region where 9 percent is drawn is one where a zero means nobody has been
 * there with an editor yet. The number is stored next to the data it qualifies rather than
 * left in a console log, because any copy quoting `canopyShare` has to be able to quote
 * this beside it.
 *
 * A uniform lon/lat grid, deliberately not an area integral: polygons returned by a bbox
 * query extend past the bbox, so summing ring areas over-counts (RMNP sums to 490 percent
 * of its own bbox). Probing points inside the bbox cannot.
 */
function mappedWoodedShare(bbox, polygons) {
  const [w, s, e, n] = bbox;
  let inside = 0;
  for (let i = 0; i < MAPPED_GRID; i++) {
    for (let j = 0; j < MAPPED_GRID; j++) {
      const lon = w + ((e - w) * (i + 0.5)) / MAPPED_GRID;
      const lat = s + ((n - s) * (j + 0.5)) / MAPPED_GRID;
      if (polygons.some((p) => pointInPolygon(lon, lat, p))) inside++;
    }
  }
  return inside / (MAPPED_GRID * MAPPED_GRID);
}

// ---- aspect and slope from the DEM --------------------------------------------

/** Fractional global pixel coordinates at TILE_Z, the same projection lonLatToTilePixel uses. */
function lonLatToGlobalPixel(lon, lat) {
  const gx = ((lon + 180) / 360) * WORLD_PX;
  const gy = ((1 - Math.asinh(Math.tan(lat * DEG)) / Math.PI) / 2) * WORLD_PX;
  return { gx, gy };
}

/** Centre of integer global pixel (gx, gy) as [lon, lat]. Feeding this back through
 *  lonLatToTilePixel lands on exactly that pixel, which is what makes the 3x3 window
 *  below a real neighbourhood rather than three samples of the same cell. */
function globalPixelCentreToLonLat(gx, gy) {
  const lon = ((gx + 0.5) / WORLD_PX) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (gy + 0.5)) / WORLD_PX))) / DEG;
  return [lon, lat];
}

/** Ground metres per pixel at this latitude. Web mercator is conformal, so x and y are
 *  equal, which is what lets the Horn window below use one cell size. */
function metresPerPixel(lat) {
  return (EARTH_CIRCUMFERENCE_M * Math.cos(lat * DEG)) / WORLD_PX;
}

/**
 * Elevations for a batch of integer global pixels, grouped by tile so each tile is touched
 * once. Deliberately a separate path from terrarium.mjs's `sampleElevations`, which takes
 * lon/lat: the 3x3 windows overlap heavily between neighbouring samples, so keying on the
 * pixel and deduplicating is what keeps this to one lookup per distinct cell.
 */
async function samplePixels(pixels) {
  const byTile = new Map();
  for (const p of pixels) {
    const tx = Math.floor(p.gx / TILE_SIZE);
    const ty = Math.floor(p.gy / TILE_SIZE);
    const key = `${tx}/${ty}`;
    if (!byTile.has(key)) byTile.set(key, { tx, ty });
  }
  const grids = new Map();
  await Promise.all(
    [...byTile.entries()].map(async ([key, { tx, ty }]) => {
      grids.set(key, await loadTile(tx, ty));
    }),
  );
  return pixels.map((p) => {
    const tx = Math.floor(p.gx / TILE_SIZE);
    const ty = Math.floor(p.gy / TILE_SIZE);
    const grid = grids.get(`${tx}/${ty}`);
    return grid[(p.gy - ty * TILE_SIZE) * TILE_SIZE + (p.gx - tx * TILE_SIZE)];
  });
}

/**
 * Slope and aspect at a list of [lon, lat] points, by Horn's 3x3 finite difference on the
 * terrarium grid.
 *
 * Aspect is the compass bearing of steepest DESCENT, degrees clockwise from north, which is
 * the convention every GIS uses and the one the sun-incidence formula in
 * src/scope/weather/shading.ts expects. -1 means "flatter than ASPECT_FLAT_DEG", i.e. the
 * ground has no meaningful direction, not that the computation failed.
 *
 * The window crosses tile boundaries freely, because the neighbourhood is addressed in
 * GLOBAL pixel space and resolved to whatever tile holds it. Sampling the 3x3 by lon/lat
 * offsets instead would have quietly clamped at tile edges, which is a seam of wrong
 * aspects running through every region along the z13 grid.
 */
async function slopeAspectAt(coords) {
  const windows = coords.map(([lon, lat]) => {
    const { gx, gy } = lonLatToGlobalPixel(lon, lat);
    const cx = Math.floor(gx);
    const cy = Math.floor(gy);
    const cells = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        cells.push({ gx: cx + dx, gy: cy + dy });
      }
    }
    // Cell size is taken at the pixel centre, not at the caller's coordinate, so two
    // samples in the same cell get identical geometry.
    const centre = globalPixelCentreToLonLat(cx, cy);
    return { cells, cellM: metresPerPixel(centre[1]) };
  });

  const flat = windows.flatMap((w) => w.cells);
  const elev = await samplePixels(flat);

  const out = [];
  for (let i = 0; i < windows.length; i++) {
    const z = elev.slice(i * 9, i * 9 + 9); // row-major, row 0 is NORTH (smaller gy)
    const cell = windows[i].cellM;
    const dzdxEast = (z[2] + 2 * z[5] + z[8] - (z[0] + 2 * z[3] + z[6])) / (8 * cell);
    const dzdyNorth = (z[0] + 2 * z[1] + z[2] - (z[6] + 2 * z[7] + z[8])) / (8 * cell);
    const slopeDeg = Math.atan(Math.hypot(dzdxEast, dzdyNorth)) / DEG;
    // Downslope vector is the negative gradient; atan2(east, north) is a compass bearing.
    const aspectDeg =
      slopeDeg < ASPECT_FLAT_DEG ? -1 : (Math.atan2(-dzdxEast, -dzdyNorth) / DEG + 360) % 360;
    out.push({ slopeDeg, aspectDeg });
  }
  return out;
}

/** Circular mean of compass bearings. A plain arithmetic mean of 350 and 10 is 180, which
 *  would report a north-facing pair as south-facing; vector averaging cannot. Returns -1
 *  when nothing qualified or when the directions cancel out. */
function meanBearing(bearings) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const b of bearings) {
    if (b < 0) continue;
    sx += Math.sin(b * DEG);
    sy += Math.cos(b * DEG);
    n++;
  }
  if (n === 0) return -1;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return -1;
  return (Math.atan2(sx, sy) / DEG + 360) % 360;
}

// ---- derivation ---------------------------------------------------------------

/**
 * Add the canopy and aspect fields to a list of derived trails, in place.
 *
 * Sample positions are `routeSamplePoints(trail, PROFILE_POINTS)`, the SHIPPED sampler, at
 * the same fractions `profileElevAt` uses. That is the whole point of using it: index i of
 * `canopy`, index i of `aspectDeg` and index i of `profile` are the same place on the
 * ground, so a journey can say "in trees from here" and mean the same metre the elevation
 * chart means. A private re-implementation would have drifted at part boundaries, where
 * along-route distance and profile index space disagree.
 */
export async function deriveCanopyAndAspect(trails, polygons) {
  const stats = {
    samples: 0,
    canopySamples: 0,
    flatSamples: 0,
    leafType: new Map(),
    degenerate: 0,
    profileMismatch: 0,
  };

  for (const trail of trails) {
    if (Array.isArray(trail.profile) && trail.profile.length !== PROFILE_POINTS) {
      stats.profileMismatch++;
    }
    const pts = routeSamplePoints(trail, PROFILE_POINTS);
    // Degenerate geometry returns a single point rather than PROFILE_POINTS identical
    // ones (see routeSamplePoints). Pad by repeating it so the arrays stay a fixed length
    // and the UI never has to special-case, and count it so the padding is not invisible.
    const coords = [];
    for (let i = 0; i < PROFILE_POINTS; i++) coords.push(pts[Math.min(i, pts.length - 1)].lngLat);
    if (pts.length < PROFILE_POINTS) stats.degenerate++;

    const canopy = coords.map(([lon, lat]) => {
      const poly = coveringPolygon(lon, lat, polygons);
      if (poly === null) return 0;
      stats.leafType.set(poly.leaf, (stats.leafType.get(poly.leaf) ?? 0) + 1);
      return 1;
    });
    const sa = await slopeAspectAt(coords);

    const canopyHits = canopy.reduce((a, b) => a + b, 0);
    stats.samples += PROFILE_POINTS;
    stats.canopySamples += canopyHits;
    stats.flatSamples += sa.filter((s) => s.aspectDeg < 0).length;

    trail.canopy = canopy;
    trail.canopyShare = round(canopyHits / PROFILE_POINTS, 3);
    trail.aspectDeg = sa.map((s) => (s.aspectDeg < 0 ? -1 : Math.round(s.aspectDeg)));
    trail.slopeDeg = sa.map((s) => round(s.slopeDeg, 1));
    trail.meanAspectDeg = round(meanBearing(trail.aspectDeg), 1);
    trail.meanSlopeDeg = round(sa.reduce((a, s) => a + s.slopeDeg, 0) / PROFILE_POINTS, 1);
  }
  return stats;
}

/**
 * The region-level canopy provenance block for a derived payload. One function so
 * scope/derive.mjs's full run and this file's `augment` cannot disagree about what
 * qualifies the numbers, which is exactly the drift MERGE_PLAN and SCOPE_PLAN keep
 * catching elsewhere.
 */
export function canopyBlockFor(bbox, frozen) {
  return {
    fetchedAt: frozen.fetchedAt,
    source: frozen.source,
    query: frozen.query,
    polygonCount: frozen.polygonCount,
    mappedShare: round(mappedWoodedShare(bbox, frozen.polygons), 3),
    mappedGrid: MAPPED_GRID,
  };
}

// ---- pipeline -----------------------------------------------------------------

function derivedPath(region) {
  return join(DERIVED_DIR, `${region}.json`);
}

function readDerived(region) {
  const file = derivedPath(region);
  if (!existsSync(file)) {
    throw new Error(`${region}: ${file} does not exist. Run scope/derive.mjs ${region} first.`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function canopyPath(region) {
  return join(CANOPY_DIR, `${region}.json`);
}

export function readCanopy(region) {
  const file = canopyPath(region);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function probe(regions) {
  for (const region of regions) {
    const bbox = readDerived(region).bbox;
    const ask = async (filters) => {
      const j = await overpass(buildQuery(bbox, filters, 'count'));
      const t = j.elements?.[0]?.tags ?? {};
      return { ways: Number(t.ways ?? 0), relations: Number(t.relations ?? 0), total: Number(t.total ?? 0) };
    };
    const canopy = await ask(CANOPY_FILTERS);
    await sleep(5000);
    const other = await ask(NON_CANOPY_FILTERS);
    const headroom = OVERPASS_MAX_ELEMENTS - canopy.total;
    const pct = Math.round((canopy.total / OVERPASS_MAX_ELEMENTS) * 100);
    console.log(
      `\n${region} ${JSON.stringify(bbox)}\n` +
        `  forest|wood     : ${canopy.total} (${canopy.ways} ways, ${canopy.relations} relations)\n` +
        `  cap ${OVERPASS_MAX_ELEMENTS}        : ${pct}% used, ${headroom} headroom` +
        (headroom <= 500 ? '   ** NEAR CAP — do not fetch **' : '') +
        `\n  scrub|heath     : ${other.total} (counted, deliberately NOT canopy)`,
    );
    if (region !== regions[regions.length - 1]) await sleep(5000);
  }
}

async function freeze(region, refetch = false) {
  const derived = readDerived(region);
  const bbox = derived.bbox;
  const query = buildQuery(bbox, CANOPY_FILTERS, 'geom');
  console.log(`\n=== freeze ${region} ${JSON.stringify(bbox)} ===`);
  const json = await overpassCached(query, region, refetch);
  const elements = json.elements ?? [];
  if (elements.length >= OVERPASS_MAX_ELEMENTS) {
    throw new Error(
      `${region}: Overpass returned ${elements.length} elements, at or above the ` +
        `${OVERPASS_MAX_ELEMENTS} cap. The fetch is truncated. Refusing to write a partial region.`,
    );
  }
  // Sort by type then id so the frozen file is byte-stable across refetches, the same
  // reason scope/derive.mjs sorts its ways before merging.
  elements.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.id - b.id));
  const { polygons, stats } = toPolygons(elements);

  // 5 dp is about 1.1 m. Trail geometry is frozen at 6 dp because a trail is a surveyed
  // line; a landcover boundary is an interpretation of an aerial photograph and does not
  // carry a decimetre, so the extra digit would be storage spent on false precision.
  const out = polygons.map((p) => ({
    id: p.id,
    tag: p.tag,
    leaf: p.leaf,
    bbox: p.bbox.map((v) => round(v, 5)),
    outer: p.outer.map((r) => r.map((c) => [round(c[0], 5), round(c[1], 5)])),
    inner: p.inner.map((r) => r.map((c) => [round(c[0], 5), round(c[1], 5)])),
  }));
  const vertices = out.reduce(
    (a, p) => a + p.outer.reduce((x, r) => x + r.length, 0) + p.inner.reduce((x, r) => x + r.length, 0),
    0,
  );
  const payload = {
    region,
    bbox,
    query,
    fetchedAt: new Date().toISOString().slice(0, 10),
    source: 'OpenStreetMap contributors, ODbL',
    wayCount: stats.ways,
    relationCount: stats.relations,
    polygonCount: out.length,
    holeCount: stats.holes,
    unclosedRings: stats.unclosed,
    vertexCount: vertices,
    polygons: out,
  };
  mkdirSync(CANOPY_DIR, { recursive: true });
  const file = canopyPath(region);
  writeFileSync(file, JSON.stringify(payload));
  console.log(
    `  polygons            : ${out.length} (${stats.ways} ways, ${stats.relations} relations, ${stats.holes} holes)`,
  );
  console.log(`  vertices            : ${vertices}`);
  console.log(`  rings force-closed  : ${stats.unclosed} (boundary left the bbox; see assembleRings)`);
  console.log(`  skipped elements    : ${stats.skipped} (fewer than 4 points, or no outer ring)`);
  console.log(
    `  leaf_type           : ${[...stats.leafType.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}`,
  );
  console.log(`  wrote ${file} (${(Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0)} kB)`);
  return payload;
}

/** Read the derived region, add the fields, write it back. Every pre-existing key is
 *  carried through untouched: this augments, it never re-derives. */
async function augment(region) {
  const derived = readDerived(region);
  const canopy = readCanopy(region);
  if (canopy === null) {
    throw new Error(`${region}: no frozen canopy. Run: node scope/canopy.mjs freeze ${region}`);
  }
  if (JSON.stringify(canopy.bbox) !== JSON.stringify(derived.bbox)) {
    throw new Error(
      `${region}: the frozen canopy covers ${JSON.stringify(canopy.bbox)} but the trails came ` +
        `from ${JSON.stringify(derived.bbox)}. Refreeze rather than compare two patches of ground.`,
    );
  }
  console.log(`\n=== ${region} ===`);
  console.log(`  canopy polygons     : ${canopy.polygonCount} (frozen ${canopy.fetchedAt})`);
  const stats = await deriveCanopyAndAspect(derived.trails, canopy.polygons);
  derived.canopy = canopyBlockFor(derived.bbox, canopy);
  derived.aspectSource = `Horn 3x3 on ${derived.elevationSource}`;
  writeFileSync(derivedPath(region), JSON.stringify(derived));
  reportStats(stats);
  report(derived);
  console.log(`  wrote ${derivedPath(region)}`);
  return derived;
}

// ---- reporting ----------------------------------------------------------------

function reportStats(stats) {
  const pct = (n) => `${Math.round((n / Math.max(1, stats.samples)) * 100)}%`;
  console.log(`  samples             : ${stats.samples} (${PROFILE_POINTS} per trail)`);
  console.log(`  under canopy        : ${stats.canopySamples} (${pct(stats.canopySamples)})`);
  console.log(
    `  aspect flat (<${ASPECT_FLAT_DEG}deg) : ${stats.flatSamples} (${pct(stats.flatSamples)}) — no meaningful direction`,
  );
  if (stats.degenerate > 0) console.log(`  degenerate geometry : ${stats.degenerate} trails padded`);
  if (stats.profileMismatch > 0) {
    console.log(`  ** ${stats.profileMismatch} trails have a profile that is not ${PROFILE_POINTS} points **`);
  }
  const leaf = [...stats.leafType.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  leaf_type at hits   : ${leaf.map(([k, v]) => `${k} ${v}`).join(' · ') || '(none)'}`);
}

/** Compass octant a bearing falls in. Eight bins, because that is the resolution the
 *  underlying DEM supports and the resolution a reader can hold in their head. */
const OCTANTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function octant(bearing) {
  return OCTANTS[Math.round(bearing / 45) % 8];
}

function report(data) {
  const t = data.trails.filter((x) => Array.isArray(x.canopy));
  if (t.length === 0) {
    console.log('  no trails carry canopy yet');
    return;
  }
  const pct = (n) => `${Math.round((n / t.length) * 100)}%`;
  // Bands rather than quantiles: the question is whether a region splits, and a p50 hides
  // a bimodal split behind a single middling number.
  const bands = { '0%': 0, '1-25%': 0, '26-50%': 0, '51-75%': 0, '76-99%': 0, '100%': 0 };
  for (const x of t) {
    const s = x.canopyShare;
    if (s === 0) bands['0%']++;
    else if (s <= 0.25) bands['1-25%']++;
    else if (s <= 0.5) bands['26-50%']++;
    else if (s <= 0.75) bands['51-75%']++;
    else if (s < 1) bands['76-99%']++;
    else bands['100%']++;
  }
  const meanShare = t.reduce((a, x) => a + x.canopyShare, 0) / t.length;
  if (typeof data.canopy?.mappedShare === 'number') {
    console.log(
      `  bbox drawn as wood  : ${Math.round(data.canopy.mappedShare * 100)}%` +
        ` — read every canopy number below against this one (see mappedWoodedShare)`,
    );
  }
  console.log(`  canopy share mean   : ${Math.round(meanShare * 100)}%`);
  console.log(
    `  canopy share bands  : ${Object.entries(bands)
      .map(([k, v]) => `${k} ${v} (${pct(v)})`)
      .join(' · ')}`,
  );

  const hist = new Map(OCTANTS.map((o) => [o, 0]));
  let flat = 0;
  let n = 0;
  for (const x of t) {
    for (const a of x.aspectDeg ?? []) {
      n++;
      if (a < 0) flat++;
      else hist.set(octant(a), hist.get(octant(a)) + 1);
    }
  }
  const apct = (v) => `${Math.round((v / Math.max(1, n)) * 100)}%`;
  console.log(
    `  aspect octants      : ${OCTANTS.map((o) => `${o} ${apct(hist.get(o))}`).join(' · ')} · flat ${apct(flat)}`,
  );
  const slopes = t.flatMap((x) => x.slopeDeg ?? []).sort((a, b) => a - b);
  const at = (q) => slopes[Math.min(slopes.length - 1, Math.round(q * (slopes.length - 1)))];
  if (slopes.length > 0) {
    console.log(
      `  terrain slope deg   : p10 ${at(0.1)} · p50 ${at(0.5)} · p90 ${at(0.9)} · max ${at(1)}`,
    );
  }
}

function verify(regions) {
  for (const region of regions) {
    const derived = readDerived(region);
    console.log(`\n=== ${region} (trails ${derived.fetchedAt}, canopy ${derived.canopy?.fetchedAt ?? 'ABSENT'}) ===`);
    const missing = derived.trails.filter((t) => !Array.isArray(t.canopy)).length;
    if (missing > 0) console.log(`  ** ${missing} trails carry no canopy — run: node scope/canopy.mjs ${region} **`);
    const badLen = derived.trails.filter(
      (t) =>
        Array.isArray(t.canopy) &&
        (t.canopy.length !== PROFILE_POINTS ||
          t.aspectDeg.length !== PROFILE_POINTS ||
          t.slopeDeg.length !== PROFILE_POINTS),
    ).length;
    if (badLen > 0) console.log(`  ** ${badLen} trails have an array that is not ${PROFILE_POINTS} long **`);
    // The share has to be the mean of the flags, or the two fields are telling different
    // stories and any copy built on either is unfalsifiable.
    const badShare = derived.trails.filter((t) => {
      if (!Array.isArray(t.canopy)) return false;
      const mean = t.canopy.reduce((a, b) => a + b, 0) / t.canopy.length;
      return Math.abs(mean - t.canopyShare) > 0.001;
    }).length;
    if (badShare > 0) console.log(`  ** ${badShare} trails: canopyShare disagrees with the flags **`);
    if (missing === 0 && badLen === 0 && badShare === 0) console.log('  shape OK');
    report(derived);
  }
}

// ---- CLI ----------------------------------------------------------------------

const ALL_REGIONS = ['rmnp', 'adk', 'ozarks'];

function resolveRegions(arg) {
  if (!arg || arg === 'all') return ALL_REGIONS;
  if (!ALL_REGIONS.includes(arg)) {
    console.error(`unknown region '${arg}' (have: ${ALL_REGIONS.join(', ')})`);
    process.exit(1);
  }
  return [arg];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const refetch = args.includes('--refetch');
  const [mode, ...rest] = args.filter((a) => a !== '--refetch');
  if (mode === 'probe') {
    await probe(resolveRegions(rest[0]));
  } else if (mode === 'freeze') {
    for (const region of resolveRegions(rest[0])) await freeze(region, refetch);
  } else if (mode === 'verify') {
    verify(resolveRegions(rest[0]));
  } else {
    for (const region of resolveRegions(mode)) await augment(region);
  }
}

export {
  ASPECT_FLAT_DEG,
  PROFILE_POINTS,
  assembleRings,
  buildQuery,
  mappedWoodedShare,
  meanBearing,
  pointInPolygon,
  slopeAspectAt,
  toPolygons,
};
