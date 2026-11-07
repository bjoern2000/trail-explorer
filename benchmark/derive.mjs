// TrailScope AllTrails-vs-open-sources overlap pipeline (BENCHMARK_PLAN.md Phase 2).
//
// Standalone Node >= 18 ESM, zero npm deps (built-in fetch). Reads an AllTrails
// snapshot from benchmark/raw/<region>.json, fetches the same bbox from the six
// open sources directly (no proxy), matches each AllTrails route to each source by
// name + trailhead proximity, and writes benchmark/derived/<region>.json plus a
// console report. Run: `node benchmark/derive.mjs <region>` (default rmnp).
//
// Query patterns mirror the app's live adapters (src/data/arcgis.ts, overpass.ts);
// name normalization + haversine mirror src/data/loader.ts. This is a plain node
// script, so those TS modules are re-implemented here rather than imported.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- source registry (from src/registry.ts, endpoints verified 2026-07-08) ----
// ArcGIS sources hit upstreams directly here (the app proxies via /api/arcgis).
// idField feeds __fid construction, replicating src/data/arcgis.ts injectIds /
// src/data/overpass.ts osmToGeoJSON exactly (the web page filters live-fetched
// features by these ids, so the format is load-bearing).
const SOURCES = [
  {
    id: 'usfs',
    kind: 'arcgis',
    nameField: 'trail_name',
    idField: 'objectid',
    urls: ['https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query'],
  },
  {
    id: 'nps',
    kind: 'arcgis',
    nameField: 'TRLNAME',
    idField: 'OBJECTID',
    urls: ['https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails_Geographic/FeatureServer/0/query'],
  },
  {
    id: 'blm',
    kind: 'arcgis',
    nameField: 'ROUTE_PRMRY_NM',
    idField: 'OBJECTID',
    urls: [
      'https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer/4/query',
      'https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer/5/query',
    ],
  },
  {
    id: 'usgs',
    kind: 'arcgis',
    nameField: 'name',
    idField: 'objectid',
    urls: ['https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query'],
  },
  {
    id: 'cotrex',
    kind: 'arcgis',
    nameField: 'name',
    idField: 'FID',
    urls: ['https://services3.arcgis.com/0jWpHMuhmHsukKE3/arcgis/rest/services/CPW_Trails_08222024/FeatureServer/2/query'],
  },
  {
    id: 'dec',
    kind: 'arcgis',
    nameField: 'NAME',
    idField: 'OBJECTID',
    urls: ['https://services6.arcgis.com/DZHaqZm9cxOD4CWM/arcgis/rest/services/DEC_Trails/FeatureServer/1/query'],
  },
  {
    id: 'osm',
    kind: 'overpass',
    nameField: 'name',
    idField: '@id',
    urls: ['https://overpass-api.de/api/interpreter'],
  },
];

const SOURCE_IDS = SOURCES.map((s) => s.id);

const ARCGIS_RECORD_COUNT = 2000;
const ARCGIS_MAX_PAGES = 25; // guard: 25 * 2000 = 50k features before we call it capped
const FETCH_TIMEOUT_MS = 60_000;
const CANDIDATE_MAX_GAP_M = 5000; // tier-1 exact: OSS feature within 5 km of the trailhead
const FUZZY_MAX_GAP_M = 2000; // tier-2 fuzzy: tightened candidate radius
const USER_AGENT = 'TrailScope/0.1 (trail data source evaluation)';

// ---- registry drift tripwire ---------------------------------------------------
// SOURCES above is a hand-copy of src/registry.ts, and __fid parity with the app
// adapters is load-bearing: the benchmark page filters live-fetched features (which
// carry adapter-built __fids) against the ids we store. Silent drift would break
// segment highlighting with no error, so abort loudly when the app sources no
// longer contain what we copied. Deliberately a text check, not a shared module.
function assertRegistryParity() {
  const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
  let registry;
  let arcgisTs;
  let overpassTs;
  let serverJs;
  try {
    registry = read('src/registry.ts');
    arcgisTs = read(join('src', 'data', 'arcgis.ts'));
    overpassTs = read(join('src', 'data', 'overpass.ts'));
    serverJs = read('server.js');
  } catch (err) {
    console.error(`Drift tripwire: cannot read app sources: ${err.message}`);
    process.exit(1);
  }
  const fail = (srcId, what) => {
    console.error(
      `Drift tripwire: source "${srcId}" drifted from the app — ${what} not found verbatim.\n` +
      'Update SOURCES in benchmark/derive.mjs to match src/registry.ts before trusting featureIds.',
    );
    process.exit(1);
  };
  for (const src of SOURCES) {
    // Window = this source's block in registry.ts (from its `id: '<x>'` to the next one).
    const start = registry.indexOf(`id: '${src.id}'`);
    if (start < 0) fail(src.id, 'registry block');
    let end = registry.length;
    for (const other of SOURCES) {
      if (other.id === src.id) continue;
      const i = registry.indexOf(`id: '${other.id}'`, start + 1);
      if (i > start && i < end) end = i;
    }
    const block = registry.slice(start, end);
    if (!block.includes(`nameField: '${src.nameField}'`)) fail(src.id, `nameField '${src.nameField}'`);
    if (!block.includes(`idField: '${src.idField}'`)) fail(src.id, `idField '${src.idField}'`);
    for (const url of src.urls) {
      // ArcGIS endpoints live in registry queryUrls; Overpass upstreams live in
      // server.js UPSTREAMS (registry's osm queryUrl is the /api/overpass proxy).
      const hay = src.kind === 'overpass' ? serverJs : block;
      if (!hay.includes(url)) fail(src.id, `endpoint ${url}`);
    }
  }
  // The __fid constructions we replicate must still exist in the app adapters.
  if (!arcgisTs.includes('`${def.id}:${layerIdx}:${idVal}`') || !arcgisTs.includes('`${def.id}:${idVal}`')) {
    fail('blm', '__fid construction pattern in src/data/arcgis.ts');
  }
  if (!overpassTs.includes('`way/${el.id}`') || !overpassTs.includes('`osm:${atId}`')) {
    fail('osm', '__fid construction pattern in src/data/overpass.ts');
  }
}

// ---- geometry (mirrors loader.ts haversineMeters) ----------------------------
function haversineMeters(a, b) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Degree distance from point [lon,lat] to bbox [w,s,e,n]; 0 when inside. Cheap pre-filter. */
function pointBBoxDistDeg(pt, bb) {
  const dx = Math.max(bb[0] - pt[0], 0, pt[0] - bb[2]);
  const dy = Math.max(bb[1] - pt[1], 0, pt[1] - bb[3]);
  return Math.hypot(dx, dy);
}

// ---- name normalization (mirrors loader.ts normalizeTrailName, plus expansion) --
const ABBREV = { mt: 'mount', mtn: 'mountain', tr: 'trail' };

/** Lowercase, strip punctuation to letters/digits/spaces, collapse whitespace,
 *  then expand common abbreviations (mt/mtn/tr) so both spellings compare equal. */
function normName(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  return base
    .split(' ')
    .map((w) => ABBREV[w] || w)
    .join(' ');
}

// Single-word names/tokens that carry no discriminating signal on their own.
const GENERIC = new Set([
  'trail', 'trails', 'loop', 'loops', 'lake', 'lakes', 'falls', 'fall', 'creek',
  'river', 'mountain', 'mount', 'peak', 'peaks', 'trailhead', 'meadow', 'meadows',
  'gulch', 'pass', 'park', 'summit', 'road', 'canyon', 'ridge', 'point', 'spur',
  'cutoff', 'connector', 'the', 'via', 'and', 'to', 'valley', 'basin', 'gorge',
  'reservoir', 'pond', 'spring', 'springs',
]);

function isGeneric(norm) {
  return GENERIC.has(norm);
}

/** Route name → match tokens: full normalized name plus segments split on
 *  commas / " and " / " via " / " to " / " - ". Drop tokens < 4 chars and pure-generics. */
function routeTokens(name) {
  const parts = String(name || '').split(/,| and | via | to | - /i);
  parts.push(name); // full name as one token
  const out = new Set();
  for (const p of parts) {
    const n = normName(p);
    if (n.length < 4) continue;
    if (isGeneric(n)) continue;
    out.add(n);
  }
  return [...out];
}

// ---- fetch helpers -----------------------------------------------------------
function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/** One ArcGIS envelope query page. Returns { features, exceeded }. */
async function arcgisPage(url, bbox, offset) {
  const [w, s, e, n] = bbox;
  const params = new URLSearchParams({
    f: 'geojson',
    where: '1=1',
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    resultRecordCount: String(ARCGIS_RECORD_COUNT),
    resultOffset: String(offset),
  });
  const t = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: t.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const json = await resp.json();
    if (json.error) throw new Error(`ArcGIS error: ${json.error.message || 'unknown'}`);
    const features = Array.isArray(json.features) ? json.features : [];
    return { features, exceeded: json.exceededTransferLimit === true };
  } finally {
    t.done();
  }
}

/** Inject __fid exactly as src/data/arcgis.ts injectIds does: `${id}:${idVal}`,
 *  BLM prefixed with its sublayer index (`blm:${layerIdx}:${idVal}`). */
function injectArcgisFids(features, src, layerIdx) {
  for (const f of features) {
    const props = f.properties || (f.properties = {});
    const idVal = readProp(props, src.idField);
    props.__fid = src.id === 'blm' ? `${src.id}:${layerIdx}:${idVal}` : `${src.id}:${idVal}`;
  }
}

/** Fetch all pages of every layer URL for a source, paginating past the 2000 cap. */
async function fetchArcgisSource(src, bbox) {
  const all = [];
  let capped = false;
  for (let layerIdx = 0; layerIdx < src.urls.length; layerIdx++) {
    const url = src.urls[layerIdx];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const { features, exceeded } = await arcgisPage(url, bbox, offset);
      injectArcgisFids(features, src, layerIdx);
      all.push(...features);
      pages++;
      // Servers may enforce maxRecordCount < what we ask for (commonly 1000), so
      // advance by the ACTUAL page length; exceededTransferLimit says "more remain".
      if (features.length === 0 || !exceeded) break;
      offset += features.length;
      if (pages >= ARCGIS_MAX_PAGES) {
        capped = true;
        console.warn(`  ! ${src.id}: hit ${ARCGIS_MAX_PAGES}-page guard on ${url} — may be truncated`);
        break;
      }
    }
  }
  return { features: all, capped };
}

/** Overpass path/footway/track ways in the bbox, converted to LineString features. */
async function fetchOverpassSource(src, bbox) {
  const [w, s, e, n] = bbox;
  const query = `[out:json][timeout:60];\nway["highway"~"^(path|footway|track)$"](${s},${w},${n},${e});\nout geom qt;`;
  let lastErr = null;
  for (const url of src.urls) {
    const t = withTimeout(FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: 'data=' + encodeURIComponent(query),
        signal: t.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const json = await resp.json();
      const elements = Array.isArray(json.elements) ? json.elements : [];
      const features = [];
      for (const el of elements) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [p.lon, p.lat]) },
          // __fid exactly as src/data/overpass.ts osmToGeoJSON: `osm:way/${id}`.
          properties: { ...(el.tags || {}), __fid: `osm:way/${el.id}` },
        });
      }
      return { features, capped: false };
    } catch (err) {
      lastErr = err;
      console.warn(`  ! osm: ${url} failed (${err.message}); trying next mirror`);
    } finally {
      t.done();
    }
  }
  throw lastErr || new Error('all Overpass mirrors failed');
}

// ---- feature indexing --------------------------------------------------------
/** Case-insensitive property read (ArcGIS field casing varies across services). */
function readProp(props, field) {
  if (props[field] !== undefined && props[field] !== null) return props[field];
  const lower = field.toLowerCase();
  for (const k in props) {
    if (k.toLowerCase() === lower) return props[k];
  }
  return undefined;
}

function lineParts(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}

/** Flatten a source's features into named-feature records (verts + bbox + norm name)
 *  plus an all-features vertex index (named or not) for the network-presence proxy. */
function indexSource(src, features) {
  const named = [];
  const allFeats = [];
  let namedCount = 0;
  const uniqueNorms = new Set();
  for (const f of features) {
    const verts = [];
    let lenM = 0;
    let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
    for (const part of lineParts(f.geometry)) {
      // Part-aware geometric length: never bridge across MultiLineString parts.
      for (let i = 1; i < part.length; i++) lenM += haversineMeters(part[i - 1], part[i]);
      for (const c of part) {
        verts.push(c);
        if (c[0] < w) w = c[0];
        if (c[0] > e) e = c[0];
        if (c[1] < s) s = c[1];
        if (c[1] > nn) nn = c[1];
      }
    }
    if (verts.length === 0) continue;
    allFeats.push({ verts, bbox: [w, s, e, nn] });
    const rawName = readProp(f.properties || {}, src.nameField);
    if (rawName == null || String(rawName).trim() === '') continue;
    const norm = normName(rawName);
    if (!norm) continue;
    namedCount++;
    uniqueNorms.add(norm);
    named.push({
      name: String(rawName),
      norm,
      core: canonicalCore(rawName),
      fid: (f.properties || {}).__fid,
      lenM,
      verts,
      bbox: [w, s, e, nn],
    });
  }
  return {
    named,
    allFeats,
    stats: {
      featureCount: features.length,
      namedFeatureCount: namedCount,
      uniqueNormalizedNameCount: uniqueNorms.size,
    },
    uniqueNorms,
  };
}

// ---- fuzzy tier-2 canonicalization --------------------------------------------
// Generic type/modifier words deleted from the canonical core (post-singularization,
// so 'trails'→'trail' is already covered by the singular form).
const TYPE_WORDS = new Set(['trail', 'hike', 'path', 'route', 'loop', 'nature', 'accessible']);
const DIRECTIONAL = new Set(['north', 'south', 'east', 'west', 'upper', 'lower']);

/** Word-final plural stripping for words >= 4 chars ('meadows'→'meadow'). */
function singularize(w) {
  return w.length >= 4 && w.endsWith('s') ? w.slice(0, -1) : w;
}

/** Canonical core: normName → singularize each word → delete generic type words. */
function canonicalCore(name) {
  return normName(name)
    .split(' ')
    .map(singularize)
    .filter((w) => w && !TYPE_WORDS.has(w))
    .join(' ');
}

/** Damerau-Levenshtein (OSA) distance, early-out when |len diff| already exceeds max. */
function dlDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/**
 * Fuzzy tier-2 rule test between a route's canonical core and an OSS feature's:
 *  2a: cores equal, and core >= 2 words or >= 8 chars
 *  2b: cores equal after also deleting directional modifiers, >= 2 words remaining
 *  2c: Damerau-Levenshtein <= 1 between cores >= 8 chars (<= 2 when >= 12 chars)
 */
function fuzzyRule(routeCore, ossCore) {
  if (!routeCore || !ossCore) return null;
  if (routeCore === ossCore) {
    const words = routeCore.split(' ').length;
    if (words >= 2 || routeCore.length >= 8) return '2a';
    return null;
  }
  const r2 = routeCore.split(' ').filter((w) => !DIRECTIONAL.has(w));
  const o2 = ossCore.split(' ').filter((w) => !DIRECTIONAL.has(w));
  if (r2.length >= 2 && o2.length >= 2 && r2.join(' ') === o2.join(' ')) return '2b';
  const minLen = Math.min(routeCore.length, ossCore.length);
  if (minLen >= 8) {
    const max = minLen >= 12 ? 2 : 1;
    if (dlDistance(routeCore, ossCore, max) <= max) return '2c';
  }
  return null;
}

// ---- matching ----------------------------------------------------------------
/** Length/word guard for substring rules (a) and (d): reject short/ambiguous OSS names. */
function passesSubstringGuard(norm) {
  const words = norm.split(' ').filter(Boolean).length;
  return (norm.length >= 6 && words >= 2) || (norm.length >= 10 && words === 1);
}

/**
 * Does OSS `ossNorm` match a route (fullNorm + tokens)? Rules:
 *  (a) ossNorm is a substring of the full route name, guarded (>=6 & 2+ words, or >=10 single)
 *  (b) ossNorm equals a token
 *  (c) ossNorm contains a token of >= 8 chars
 *  (d) a token contains ossNorm, under the same guard as (a)
 */
function ossMatchesRoute(ossNorm, fullNorm, tokens) {
  if (!ossNorm || ossNorm.length < 4 || isGeneric(ossNorm)) return false;
  const guarded = passesSubstringGuard(ossNorm);
  if (guarded && fullNorm.includes(ossNorm)) return true; // (a)
  for (const t of tokens) {
    if (t === ossNorm) return true; // (b)
    if (t.length >= 8 && ossNorm.includes(t)) return true; // (c)
    if (guarded && t.includes(ossNorm)) return true; // (d)
  }
  return false;
}

/** Min vertex distance (m) from a point to ANY feature in an index, or null if empty.
 *  Latitude-only bbox distance is a valid lower bound, used to skip far features. */
function nearestFeatureMeters(pt, allFeats) {
  let best = Infinity;
  for (const feat of allFeats) {
    const dLatDeg = Math.max(feat.bbox[1] - pt[1], 0, pt[1] - feat.bbox[3]);
    if (dLatDeg * 111320 > best) continue;
    for (const v of feat.verts) {
      const d = haversineMeters(pt, v);
      if (d < best) best = d;
    }
  }
  return Number.isFinite(best) ? Math.round(best) : null;
}

const MAX_FEATURE_IDS = 12;

/** Fold sorted hits into the per-source match record (names <= 3, featureIds <= 12).
 *  matchedLenM sums the geometric length of ALL matched features (not id-capped).
 *  `collect` (Map fid -> lenM, or null) accumulates the full deduped matched
 *  feature set across routes for summary.networkMatched. */
function hitsToMatch(hits, tier, rule, collect) {
  hits.sort((a, b) => a.distM - b.distM);
  const names = [];
  const featureIds = [];
  let matchedLenM = 0;
  for (const h of hits) {
    matchedLenM += h.feat.lenM;
    // Key by fid; fall back to the feature record itself (unique) if fid is missing.
    if (collect) collect.set(h.feat.fid != null ? h.feat.fid : h.feat, h.feat.lenM);
    if (names.length < 3 && !names.includes(h.feat.name)) names.push(h.feat.name);
    if (h.feat.fid != null && featureIds.length < MAX_FEATURE_IDS && !featureIds.includes(h.feat.fid)) {
      featureIds.push(h.feat.fid);
    }
  }
  return {
    matched: true,
    tier,
    rule,
    names,
    featureIds,
    distM: Math.round(hits[0].distM),
    matchedLenM: Math.round(matchedLenM),
  };
}

/**
 * Match one route against one indexed source. Tier 1 = exact name rules (a–d),
 * 5 km candidate radius. Tier 2 = fuzzy canonical-core rules (2a–2c), only when
 * tier 1 found nothing, radius tightened to 2 km. Returns
 * { matched, tier, rule, names, featureIds, distM, matchedLenM }.
 */
function matchRouteToSource(route, index, collect) {
  const pt = [route.longitude, route.latitude];
  const exactHits = []; // { feat, distM }
  const fuzzyCands = []; // proximity candidates within the fuzzy radius, tier-1 misses
  for (const feat of index.named) {
    // cheap reject: trailhead far outside the feature bbox (deg ~ 0.06 = ~6.7 km margin)
    if (pointBBoxDistDeg(pt, feat.bbox) > 0.06) continue;
    let minD = Infinity;
    for (const v of feat.verts) {
      const d = haversineMeters(pt, v);
      if (d < minD) minD = d;
      if (minD <= 1) break;
    }
    if (minD > CANDIDATE_MAX_GAP_M) continue; // not a proximity candidate
    if (ossMatchesRoute(feat.norm, route.fullNorm, route.tokens)) {
      exactHits.push({ feat, distM: minD });
    } else if (minD <= FUZZY_MAX_GAP_M) {
      fuzzyCands.push({ feat, distM: minD });
    }
  }
  if (exactHits.length > 0) return hitsToMatch(exactHits, 'exact', null, collect);

  const fuzzyHits = [];
  for (const c of fuzzyCands) {
    const rule = fuzzyRule(route.fullCore, c.feat.core);
    if (rule) fuzzyHits.push({ ...c, rule });
  }
  if (fuzzyHits.length > 0) {
    fuzzyHits.sort((a, b) => a.distM - b.distM);
    return hitsToMatch(fuzzyHits, 'fuzzy', fuzzyHits[0].rule, collect);
  }
  return { matched: false, tier: null, rule: null, names: [], featureIds: [], distM: null, matchedLenM: null };
}

// ---- reporting helpers -------------------------------------------------------
function pct(num, den) {
  return den > 0 ? Math.round((num / den) * 100) : 0;
}

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function padL(str, len) {
  str = String(str);
  return str.length >= len ? str : ' '.repeat(len - str.length) + str;
}

// ---- main --------------------------------------------------------------------
async function main() {
  assertRegistryParity();

  const region = process.argv[2] || 'rmnp';
  const rawPath = join(__dirname, 'raw', `${region}.json`);

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(rawPath, 'utf8'));
  } catch (err) {
    console.error(`Cannot read snapshot ${rawPath}: ${err.message}`);
    process.exit(1);
  }

  const bbox = snapshot.bbox; // [w, s, e, n]
  const [bw, bs, be, bn] = bbox;
  console.log(`\nTrailScope benchmark derive — region "${region}" (${snapshot.label || ''})`);
  console.log(`bbox [w,s,e,n] = [${bbox.join(', ')}], snapshot ${snapshot.scrapedAt}`);

  // 1. Filter items to trailheads inside the snapshot bbox (scraper spills over).
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const inBbox = [];
  let dropped = 0;
  let droppedNoCoords = 0;
  for (const it of items) {
    const { latitude: la, longitude: lo } = it;
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      droppedNoCoords++;
      console.warn(`  ! dropping route without coordinates: ${it.trailId || '?'} "${it.name || '?'}"`);
      continue;
    }
    if (lo >= bw && lo <= be && la >= bs && la <= bn) inBbox.push(it);
    else dropped++;
  }
  console.log(
    `AllTrails routes: ${items.length} total, ${inBbox.length} in bbox, ` +
    `${dropped} dropped (outside bbox), ${droppedNoCoords} dropped (missing coordinates)`,
  );

  // Coverage-denominator exclusions: private property, and scenic drives that are
  // roads rather than trails (AllTrails lists e.g. Trail Ridge Road as a "route").
  function exclusionReasonOf(it) {
    if (it.isPrivateProperty === true) return 'private-property';
    const acts = Array.isArray(it.activities) ? it.activities : [];
    if (acts.includes('scenic-driving') && /\b(road|corridor|parkway|highway)\b/i.test(it.name || '')) {
      return 'road';
    }
    return null;
  }

  // AllTrails routeType codes → readable labels.
  const ROUTE_TYPES = { L: 'loop', O: 'out-and-back', P: 'point-to-point' };

  // Precompute route match material.
  const routes = inBbox.map((it) => {
    const exclusionReason = exclusionReasonOf(it);
    return {
      trailId: it.trailId,
      name: it.name,
      latitude: it.latitude,
      longitude: it.longitude,
      // Nullable: a missing length must serialize as null, not vanish as undefined.
      lengthMeters: Number.isFinite(it.lengthMeters) ? it.lengthMeters : null,
      routeType: ROUTE_TYPES[it.routeType] || null,
      difficulty: it.difficulty,
      numReviews: Number.isFinite(it.numReviews) ? it.numReviews : 0,
      excluded: exclusionReason != null,
      exclusionReason,
      fullNorm: normName(it.name),
      fullCore: canonicalCore(it.name),
      tokens: routeTokens(it.name),
    };
  });

  // 2. Fetch all six sources: ArcGIS in parallel, Overpass once.
  console.log(`\nFetching ${SOURCE_IDS.length} open sources for the bbox...`);
  const indexById = {};
  const fetchStats = {};

  const results = await Promise.allSettled(
    SOURCES.map(async (src) => {
      const t0 = Date.now();
      const raw = src.kind === 'overpass'
        ? await fetchOverpassSource(src, bbox)
        : await fetchArcgisSource(src, bbox);
      const idx = indexSource(src, raw.features);
      return { src, raw, idx, ms: Date.now() - t0 };
    }),
  );

  for (let i = 0; i < SOURCES.length; i++) {
    const src = SOURCES[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      const { raw, idx, ms } = r.value;
      indexById[src.id] = idx;
      fetchStats[src.id] = { ...idx.stats, capped: raw.capped, error: null };
      console.log(
        `  ${pad(src.id, 7)} ${padL(idx.stats.featureCount, 6)} features, ` +
        `${padL(idx.stats.namedFeatureCount, 6)} named, ` +
        `${padL(idx.stats.uniqueNormalizedNameCount, 5)} unique names` +
        `${raw.capped ? '  [CAPPED]' : ''}  (${ms} ms)`,
      );
    } else {
      // Failed source: keep the run alive; skipped in matching, nearest-distance,
      // and reverse stats, surfaced as ERR in the report + error in meta.sources.
      indexById[src.id] = {
        named: [],
        allFeats: [],
        stats: { featureCount: 0, namedFeatureCount: 0, uniqueNormalizedNameCount: 0 },
        uniqueNorms: new Set(),
        failed: true,
      };
      fetchStats[src.id] = { featureCount: 0, namedFeatureCount: 0, uniqueNormalizedNameCount: 0, capped: false, error: String(r.reason && r.reason.message ? r.reason.message : r.reason) };
      console.log(`  ${pad(src.id, 7)} FAILED: ${fetchStats[src.id].error}`);
    }
  }

  // 3. Match each route against each source. matchedFeatLen collects, per source,
  // the deduped-by-fid union of features matched by eligible routes (both tiers,
  // full pre-cap sets) for summary.networkMatched.
  const matchedFeatLen = {};
  for (const id of SOURCE_IDS) matchedFeatLen[id] = new Map();

  const outRoutes = routes.map((route) => {
    const matches = {};
    let anyMatch = false;
    // Network-presence proxy: nearest ANY feature (named or unnamed) per source + overall.
    const nearestFeatureM = {};
    let overallNearest = null;
    for (const id of SOURCE_IDS) {
      const idx = indexById[id];
      if (idx.failed) {
        matches[id] = { matched: false, tier: null, rule: null, names: [], featureIds: [], distM: null, matchedLenM: null };
        nearestFeatureM[id] = null;
        continue;
      }
      const m = matchRouteToSource(route, idx, route.excluded ? null : matchedFeatLen[id]);
      matches[id] = m;
      if (m.matched) anyMatch = true;
      const near = nearestFeatureMeters([route.longitude, route.latitude], idx.allFeats);
      nearestFeatureM[id] = near;
      if (near != null && (overallNearest == null || near < overallNearest)) overallNearest = near;
    }
    nearestFeatureM.overall = overallNearest;
    return {
      trailId: route.trailId,
      name: route.name,
      latitude: route.latitude,
      longitude: route.longitude,
      lengthMeters: route.lengthMeters,
      routeType: route.routeType,
      difficulty: route.difficulty,
      numReviews: route.numReviews,
      excluded: route.excluded,
      exclusionReason: route.exclusionReason,
      matches,
      anyMatch,
      nearestFeatureM,
    };
  });

  // 4. Summary metrics. Coverage uses the adjusted denominator (non-excluded routes);
  // review weighting and the top-25 cut also use non-excluded routes only.
  const eligible = outRoutes.filter((r) => !r.excluded);
  const excludedRoutes = outRoutes.filter((r) => r.excluded);
  const totalReviews = eligible.reduce((a, r) => a + r.numReviews, 0);
  const top25 = [...eligible].sort((a, b) => b.numReviews - a.numReviews).slice(0, 25);

  function coverageFor(pred) {
    const matched = eligible.filter(pred);
    const wReviews = matched.reduce((a, r) => a + r.numReviews, 0);
    const top25Matched = top25.filter(pred).length;
    return {
      matched: matched.length,
      coveragePct: pct(matched.length, eligible.length),
      weightedCoveragePct: pct(wReviews, totalReviews),
      top25Matched,
      top25CoveragePct: pct(top25Matched, top25.length),
    };
  }

  // Network presence at trailhead (proxy — AllTrails provides no route geometry):
  // share of routes with ANY open-data feature (all six sources pooled) within N m.
  const networkPresence = {};
  for (const thresholdM of [100, 250, 1000]) {
    const count = outRoutes.filter(
      (r) => r.nearestFeatureM.overall != null && r.nearestFeatureM.overall <= thresholdM,
    ).length;
    networkPresence[`within${thresholdM}m`] = { count, pct: pct(count, outRoutes.length) };
  }

  const summary = {
    bySource: {},
    anySource: {
      exact: coverageFor((r) => Object.values(r.matches).some((m) => m.tier === 'exact')),
      inclFuzzy: coverageFor((r) => r.anyMatch),
    },
    excluded: {
      count: excludedRoutes.length,
      byReason: excludedRoutes.reduce((acc, r) => {
        acc[r.exclusionReason] = (acc[r.exclusionReason] || 0) + 1;
        return acc;
      }, {}),
      routes: excludedRoutes.map((r) => ({ trailId: r.trailId, name: r.name, reason: r.exclusionReason })),
    },
    denominators: { raw: outRoutes.length, adjusted: eligible.length },
    networkPresence,
  };
  for (const id of SOURCE_IDS) {
    // Reverse: distinct named OSS trails and how many appear in >=1 AllTrails route name.
    const uniq = [...indexById[id].uniqueNorms];
    let reverseHits = 0;
    for (const nm of uniq) {
      if (!passesSubstringGuard(nm) || isGeneric(nm)) continue;
      if (routes.some((rt) => rt.fullNorm.includes(nm))) reverseHits++;
    }
    summary.bySource[id] = {
      exact: coverageFor((r) => r.matches[id].tier === 'exact'),
      inclFuzzy: coverageFor((r) => r.matches[id].matched),
      distinctNamedTrails: uniq.length,
      distinctNamesInAllTrails: reverseHits,
      reverseCoveragePct: pct(reverseHits, uniq.length),
    };
  }

  // Route-length-weighted coverage (demand-side): eligible routes with a finite length.
  const lwRoutes = eligible.filter((r) => Number.isFinite(r.lengthMeters));
  const denomM = lwRoutes.reduce((a, r) => a + r.lengthMeters, 0);

  function lengthCoverageFor(predExact, predIncl) {
    let exactM = 0;
    let inclFuzzyM = 0;
    for (const r of lwRoutes) {
      if (predExact(r)) exactM += r.lengthMeters;
      if (predIncl(r)) inclFuzzyM += r.lengthMeters;
    }
    return {
      exactM: Math.round(exactM),
      exactPct: pct(exactM, denomM),
      inclFuzzyM: Math.round(inclFuzzyM),
      inclFuzzyPct: pct(inclFuzzyM, denomM),
    };
  }

  summary.lengthWeighted = {
    denomM: Math.round(denomM),
    denomRoutes: lwRoutes.length,
    skippedNullLength: eligible.length - lwRoutes.length,
    perSource: {},
    anySource: lengthCoverageFor(
      (r) => Object.values(r.matches).some((m) => m.tier === 'exact'),
      (r) => r.anyMatch,
    ),
  };
  for (const id of SOURCE_IDS) {
    summary.lengthWeighted.perSource[id] = lengthCoverageFor(
      (r) => r.matches[id].tier === 'exact',
      (r) => r.matches[id].matched,
    );
  }

  // Open-network matched length (inventory-side): how much of each source's NAMED
  // network (by length) is referenced by at least one eligible route.
  summary.networkMatched = {};
  for (const id of SOURCE_IDS) {
    const idx = indexById[id];
    if (idx.failed) {
      summary.networkMatched[id] = null;
      continue;
    }
    const namedM = idx.named.reduce((a, f) => a + f.lenM, 0);
    let matchedM = 0;
    for (const lenM of matchedFeatLen[id].values()) matchedM += lenM;
    summary.networkMatched[id] = {
      namedM: Math.round(namedM),
      matchedM: Math.round(matchedM),
      pct: namedM > 0 ? Math.round((matchedM / namedM) * 100) : null,
      featureCounts: { named: idx.named.length, matchedUnique: matchedFeatLen[id].size },
    };
  }

  // Write derived JSON.
  const derived = {
    meta: {
      schemaVersion: 4,
      region,
      bbox,
      scrapedAt: snapshot.scrapedAt,
      derivedAt: new Date(Date.now()).toISOString(),
      inBboxRoutes: outRoutes.length,
      droppedRoutes: dropped,
      droppedNoCoordRoutes: droppedNoCoords,
      sources: fetchStats,
    },
    routes: outRoutes,
    summary,
  };
  const derivedDir = join(__dirname, 'derived');
  mkdirSync(derivedDir, { recursive: true });
  const outPath = join(derivedDir, `${region}.json`);
  writeFileSync(outPath, JSON.stringify(derived, null, 2));

  // 5. Console report.
  console.log(`\n=== EXCLUDED from coverage denominator (${excludedRoutes.length}) ===`);
  for (const r of excludedRoutes) {
    console.log(`  ${pad(r.exclusionReason, 18)}${r.name}`);
  }
  if (excludedRoutes.length === 0) console.log('  (none)');

  console.log(
    `\n=== COVERAGE (adjusted denominator ${eligible.length} routes, ` +
    `raw ${outRoutes.length}; ${totalReviews} reviews on eligible routes) ===`,
  );
  console.log(
    `${pad('source', 8)}${padL('feats', 7)}${padL('named', 7)}${padL('exact', 7)}` +
    `${padL('ex%', 6)}${padL('+fz', 6)}${padL('incl%', 7)}${padL('wtd%', 6)}${padL('top25', 7)}${padL('rev-cov', 9)}`,
  );
  for (const id of SOURCE_IDS) {
    const s = summary.bySource[id];
    const f = fetchStats[id];
    const flag = f.error ? ' ERR' : f.capped ? ' CAP' : '';
    console.log(
      `${pad(id, 8)}${padL(f.featureCount, 7)}${padL(f.namedFeatureCount, 7)}` +
      `${padL(s.exact.matched, 7)}${padL(s.exact.coveragePct + '%', 6)}` +
      `${padL(s.inclFuzzy.matched - s.exact.matched, 6)}${padL(s.inclFuzzy.coveragePct + '%', 7)}` +
      `${padL(s.inclFuzzy.weightedCoveragePct + '%', 6)}${padL(s.inclFuzzy.top25Matched + '/' + top25.length, 7)}` +
      `${padL(s.distinctNamesInAllTrails + '/' + s.distinctNamedTrails, 9)}${flag}`,
    );
  }
  const a = summary.anySource;
  console.log(
    `${pad('ANY', 8)}${padL('', 7)}${padL('', 7)}${padL(a.exact.matched, 7)}` +
    `${padL(a.exact.coveragePct + '%', 6)}${padL(a.inclFuzzy.matched - a.exact.matched, 6)}` +
    `${padL(a.inclFuzzy.coveragePct + '%', 7)}${padL(a.inclFuzzy.weightedCoveragePct + '%', 6)}` +
    `${padL(a.inclFuzzy.top25Matched + '/' + top25.length, 7)}`,
  );
  console.log(
    `  (raw denominator ${outRoutes.length}: any-source ` +
    `${pct(a.inclFuzzy.matched, outRoutes.length)}% incl fuzzy, ${pct(a.exact.matched, outRoutes.length)}% exact)`,
  );
  const lw = summary.lengthWeighted;
  console.log(
    `BY ROUTE LENGTH: any-source ${lw.anySource.exactPct}% exact / ` +
    `${lw.anySource.inclFuzzyPct}% incl fuzzy of ${Math.round(lw.denomM / 1000)} km ` +
    `(${lw.denomRoutes} routes${lw.skippedNullLength ? `, ${lw.skippedNullLength} skipped for null length` : ''})`,
  );

  console.log(`\n=== OPEN NETWORK MATCHED (named features, by length) ===`);
  console.log(`${pad('source', 8)}${padL('named km', 10)}${padL('matched km', 12)}${padL('pct', 6)}${padL('feats', 12)}`);
  for (const id of SOURCE_IDS) {
    const nm = summary.networkMatched[id];
    if (!nm) {
      console.log(`${pad(id, 8)}${padL('—', 10)}${padL('—', 12)}${padL('ERR', 6)}`);
      continue;
    }
    console.log(
      `${pad(id, 8)}${padL((nm.namedM / 1000).toFixed(1), 10)}${padL((nm.matchedM / 1000).toFixed(1), 12)}` +
      `${padL(nm.pct == null ? '—' : nm.pct + '%', 6)}${padL(nm.featureCounts.matchedUnique + '/' + nm.featureCounts.named, 12)}`,
    );
  }

  console.log(`\n=== NETWORK PRESENCE at trailhead (proxy — AllTrails provides no route geometry) ===`);
  for (const [key, np] of Object.entries(networkPresence)) {
    const label = key.replace('within', '').replace('m', ' m');
    console.log(`  any open-data feature within ${padL(label, 7)}: ${padL(np.count, 4)} / ${outRoutes.length} routes (${np.pct}%)`);
  }

  // Fuzzy matches gained (tier 2), for manual audit.
  const fuzzyGained = eligible.filter((r) => Object.values(r.matches).some((m) => m.tier === 'fuzzy'));
  console.log(`\n=== FUZZY (tier 2) matches, for audit (${fuzzyGained.length} routes) ===`);
  for (const r of fuzzyGained) {
    console.log(`  ${r.name}`);
    for (const id of SOURCE_IDS) {
      const m = r.matches[id];
      if (m.tier === 'fuzzy') console.log(`    [${id} ${m.rule}] ${m.names.join(' | ')}`);
    }
  }
  if (fuzzyGained.length === 0) console.log('  (none)');

  // Unmatched eligible routes, sorted by reviews desc.
  const unmatched = eligible.filter((r) => !r.anyMatch).sort((x, y) => y.numReviews - x.numReviews);
  console.log(`\n=== UNMATCHED by any source (${unmatched.length} eligible), by reviews desc ===`);
  for (const r of unmatched) {
    console.log(`  ${padL(r.numReviews, 5)} rev  ${r.name}`);
  }
  if (unmatched.length === 0) console.log('  (none)');

  // Weakest matches: 10 matched routes with the farthest nearest-match distance.
  const matchedWithDist = eligible
    .filter((r) => r.anyMatch)
    .map((r) => {
      let best = Infinity;
      let bestSrc = null;
      let bestNames = [];
      let bestTier = null;
      for (const id of SOURCE_IDS) {
        const m = r.matches[id];
        if (m.matched && m.distM != null && m.distM < best) {
          best = m.distM;
          bestSrc = id;
          bestNames = m.names;
          bestTier = m.rule ? `${m.tier} ${m.rule}` : m.tier;
        }
      }
      return { name: r.name, reviews: r.numReviews, distM: best, src: bestSrc, names: bestNames, tier: bestTier };
    })
    .sort((x, y) => y.distM - x.distM)
    .slice(0, 10);
  console.log(`\n=== 10 weakest matches (farthest nearest-match distance — audit for false positives) ===`);
  for (const r of matchedWithDist) {
    console.log(`  ${padL(r.distM, 5)} m  [${r.src} ${r.tier}] ${r.name}`);
    console.log(`         → ${r.names.join(' | ')}`);
  }

  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
