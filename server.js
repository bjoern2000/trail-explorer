// TrailScope server: serves the built static app (dist/) and proxies Overpass,
// ArcGIS and the SSDS super-resolution point API through shared in-memory caches
// with disk persistence (Railway-ready). The SSDS apiKey lives here and never
// reaches a client. Plain JS, no build step. Node >= 20 (global fetch +
// AbortController); .env loading needs >= 20.12.

import express from 'express';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- .env loading ------------------------------------------------------------
// Node >= 20.12 reads .env natively, so no dotenv dependency. Two things worth
// knowing. (1) It resolves relative to the CWD, so we pass an explicit path and
// `node server.js` works from anywhere. (2) Precedence: a real environment
// variable WINS over the file — verified on Node 24, loadEnvFile() skips any key
// already present in process.env. That is the behaviour we want on Railway,
// where the dashboard values must beat a stray .env baked into the image.
// A missing .env is the normal production case, hence the silent ENOENT.
try {
  process.loadEnvFile(join(__dirname, '.env'));
} catch (err) {
  if (!err || err.code !== 'ENOENT') {
    console.warn(`TrailScope: could not read .env (${err && err.message}); using process env only`);
  }
}

const PORT = process.env.PORT || 8081;

// ---- Overpass config ---------------------------------------------------------
// Single upstream by choice. The obvious public mirrors are either regional extracts
// (overpass.osm.ch, overpass.maprva.org return zero features outside their region) or
// operated somewhere we do not want a US client's traffic to fail over to. The loop
// below still tolerates a list, so adding a vetted mirror is a one-line change.
const UPSTREAMS = ['https://overpass-api.de/api/interpreter'];
const UPSTREAM_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const CACHE_MAX = 50;

// ---- ArcGIS config -----------------------------------------------------------
// Only these hosts may be proxied (do NOT proxy arbitrary URLs).
const ARCGIS_ALLOWLIST = new Set([
  'apps.fs.usda.gov',
  'mapservices.nps.gov',
  'gis.blm.gov',
  'carto.nationalmap.gov',
  'services3.arcgis.com',
]);
// TTL overridable via env for the stale-branch inline test (see /api/arcgis).
const ARCGIS_TTL_MS = Number(process.env.TRAILSCOPE_TTL_MS) || 60 * 60 * 1000; // 1 h
const ARCGIS_STALE_MS = 24 * 60 * 60 * 1000; // serve-stale-on-error ceiling: 24 h
const ARCGIS_CACHE_MAX = 500;
const ARCGIS_TIMEOUT_MS = 20_000;

// ---- SSDS config (TWC super-resolution tiler; see docs/references/SSDS_API_GUIDE.md)
// Point API only. The key is server-side and must never reach a client, a log
// line or a cache key. An empty key is a supported state: every SSDS route then
// answers 503 with { configured: false } so the page can say so instead of 500ing.
const SSDS_API_KEY = (process.env.SSDS_API_KEY || '').trim();
const SSDS_BASE_URL = (process.env.SSDS_BASE_URL || 'https://qaapi.weather.com/v2/tiler').replace(
  /\/+$/,
  '',
);
// Guide §7.1: the adaptive tiler stamps rt ~2 h late (publish time, not model
// init), so every timestep is labelled 2 h into the future. We address the tiler
// with its OWN times and subtract this only for the *Display fields. Set to 0 the
// day SSDS fixes it upstream.
const SSDS_RT_OFFSET_HOURS = (() => {
  const raw = (process.env.SSDS_RT_OFFSET_HOURS || '').trim(); // '' would Number() to 0
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) ? n : 2;
})();

const SSDS_TIMEOUT_MS = 20_000;
const SSDS_TTL_MS = 5 * 60 * 1000; // 300 s, per the guide's caching advice (§9.5)
const SSDS_CACHE_MAX = 300;
const SSDS_ATTEMPTS = 3; // guide §7.2: 502/503/504 under load are transient
const SSDS_DEFAULT_HOURS = 36; // the Super Resolution horizon
const SSDS_MAX_HOURS = 60;
const SSDS_MAX_STEPS = 96; // hard ceiling on points in one /multipoint request
const SSDS_MAX_HOURS_BACK = 24; // how far back a sweep may look for an already-issued run
const SSDS_MAX_PRODUCTS = 12;
const SSDS_PRODUCT = 'megapoints-conus'; // default product for bare variable names
// The six megapoints variables of guide §6, all SI.
const SSDS_DEFAULT_PRODUCTS = [
  'megapoints-conus:temperature_2m',
  'megapoints-conus:dewpoint_2m',
  'megapoints-conus:wind_speed',
  'megapoints-conus:wind_gust',
  'megapoints-conus:u_wind_10m',
  'megapoints-conus:v_wind_10m',
];
const SSDS_UA = 'TrailScope/0.1 (super-resolution API test page)';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// ---- disk persistence (Railway volume survival) ------------------------------
// One JSON file per cache under CACHE_DIR. Boot warms the in-memory Maps from
// disk; writes debounce-flush; SIGTERM flushes synchronously (Railway sends
// SIGTERM before a deploy swap). The Map stays the hot path — disk is only for
// boot-warmup + deploy survival. Persistence never crashes the server.
const CACHE_DIR =
  process.env.TRAILSCOPE_CACHE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './.cache';
const STALE_CEILING_MS = 24 * 60 * 60 * 1000; // drop anything older than this on load

let persistenceEnabled = true;
try {
  mkdirSync(CACHE_DIR, { recursive: true });
} catch (err) {
  persistenceEnabled = false;
  console.warn(
    `TrailScope: cache persistence disabled (cannot create ${CACHE_DIR}): ${err && err.message}`,
  );
}

const cacheFile = (name) => join(CACHE_DIR, `${name}.json`);

/** Load persisted [key, {ts,status,body}] pairs into `map`, dropping stale-ceiling-expired ones. */
function loadCache(map, name) {
  if (!persistenceEnabled) return;
  let raw;
  try {
    raw = readFileSync(cacheFile(name), 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`TrailScope: failed to read ${name} cache: ${err.message}`);
    }
    return;
  }
  try {
    const entries = JSON.parse(raw);
    const now = Date.now();
    let loaded = 0;
    for (const [key, entry] of entries) {
      if (entry && typeof entry.ts === 'number' && now - entry.ts <= STALE_CEILING_MS) {
        map.set(key, entry);
        loaded++;
      }
    }
    console.log(`TrailScope: warmed ${loaded} ${name} cache entries from disk`);
  } catch (err) {
    console.warn(`TrailScope: failed to parse ${name} cache: ${err && err.message}`);
  }
}

const flushTimers = Object.create(null);

/** Atomic write (tmp + rename) of a cache Map to its JSON file. */
function flushCache(map, name) {
  if (!persistenceEnabled) return;
  try {
    const data = JSON.stringify([...map.entries()]);
    const file = cacheFile(name);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    console.warn(`TrailScope: failed to flush ${name} cache: ${err && err.message}`);
  }
}

/** Coalesce writes: schedule a single flush ~5s out per cache. */
function scheduleFlush(map, name) {
  if (!persistenceEnabled || flushTimers[name]) return;
  const t = setTimeout(() => {
    flushTimers[name] = null;
    flushCache(map, name);
  }, 5000);
  if (t.unref) t.unref();
  flushTimers[name] = t;
}

// ---- Overpass in-memory cache (Map<hash, {ts, status, body}>), evict oldest ----
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // refresh recency (Map preserves insertion order)
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key, entry) {
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  scheduleFlush(cache, 'overpass');
}

async function fetchUpstream(url, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass rejects UA-less requests (overpass-api.de → 406). A descriptive
        // User-Agent is required.
        'User-Agent': 'TrailScope/0.1 (trail data source evaluation)',
      },
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal,
    });
    const body = await resp.text();
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/overpass', async (req, res) => {
  const query = (req.body && (req.body.query || req.body.data)) || '';
  if (typeof query !== 'string' || query.trim() === '') {
    return res.status(400).json({ error: 'Missing Overpass query (send { query } or data=)' });
  }

  const key = createHash('sha1').update(query).digest('hex');
  const cached = cacheGet(key);
  if (cached) {
    res.set('X-TrailScope-Cache', 'hit');
    return res.status(cached.status).type('application/json').send(cached.body);
  }

  let lastErr = null;
  for (const url of UPSTREAMS) {
    try {
      const { status, body } = await fetchUpstream(url, query);
      if (status === 200) {
        cacheSet(key, { ts: Date.now(), status, body });
        res.set('X-TrailScope-Cache', 'miss');
        res.set('X-TrailScope-Upstream', url);
        return res.status(200).type('application/json').send(body);
      }
      // non-200: remember and try the next upstream, if any
      lastErr = { status, body };
    } catch (err) {
      lastErr = { status: 502, body: String(err && err.message ? err.message : err) };
    }
  }

  // all upstreams failed
  const status = lastErr && lastErr.status && lastErr.status !== 200 ? lastErr.status : 502;
  return res
    .status(status >= 400 ? status : 502)
    .json({ error: 'Overpass upstreams unavailable', detail: lastErr ? lastErr.body : null });
});

// ---- ArcGIS in-memory cache (Map<fullUrl, {ts, status, body}>) ---------------
// Expired entries are NOT deleted on read (they back stale-on-error up to 24 h);
// LRU eviction (max 500) bounds memory. Only 200s are cached.
const arcgisCache = new Map();

function arcgisCacheSet(key, entry) {
  arcgisCache.delete(key); // refresh recency
  arcgisCache.set(key, entry);
  while (arcgisCache.size > ARCGIS_CACHE_MAX) {
    const oldest = arcgisCache.keys().next().value;
    arcgisCache.delete(oldest);
  }
  scheduleFlush(arcgisCache, 'arcgis');
}

/** A cached entry still within the 24 h stale ceiling, or null. */
function arcgisStale(key) {
  const s = arcgisCache.get(key);
  if (s && Date.now() - s.ts <= ARCGIS_STALE_MS) return s;
  return null;
}

app.get('/api/arcgis', async (req, res) => {
  const raw = req.query.u;
  if (typeof raw !== 'string' || raw === '') {
    return res.status(400).json({ error: 'Missing upstream URL (?u=<encoded full URL>)' });
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'Invalid upstream URL' });
  }
  if (target.protocol !== 'https:' || !ARCGIS_ALLOWLIST.has(target.hostname)) {
    return res.status(400).json({ error: `Upstream host not allowed: ${target.hostname}` });
  }

  // `fresh=1` is the proxy's own param; it is never part of the upstream URL (we
  // rebuild the upstream from `u` only), so nothing extra needs stripping.
  const fresh = req.query.fresh === '1';
  const key = target.toString();

  if (!fresh) {
    const hit = arcgisCache.get(key);
    if (hit && Date.now() - hit.ts <= ARCGIS_TTL_MS) {
      arcgisCache.delete(key);
      arcgisCache.set(key, hit); // refresh recency
      res.set('X-TrailScope-Cache', 'hit');
      return res.status(hit.status).type('application/json').send(hit.body);
    }
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARCGIS_TIMEOUT_MS);
  try {
    const upstream = await fetch(key, {
      headers: { 'User-Agent': 'TrailScope/0.1 (trail data source evaluation)' },
      signal: controller.signal,
    });
    const body = await upstream.text();
    const ms = Date.now() - start;

    // Flaky-endpoint resilience: a 5xx with a usable stale copy serves stale
    // rather than breaking a live demo. 2xx/4xx are forwarded as-is (fidelity).
    if (upstream.status >= 500) {
      const stale = arcgisStale(key);
      if (stale) {
        res.set('X-TrailScope-Cache', 'stale');
        return res.status(stale.status).type('application/json').send(stale.body);
      }
    }

    if (upstream.status === 200) {
      arcgisCacheSet(key, { ts: Date.now(), status: 200, body });
    }
    res.set('X-TrailScope-Cache', 'miss');
    res.set('X-TrailScope-Upstream-Ms', String(ms));
    return res.status(upstream.status).type('application/json').send(body);
  } catch (err) {
    // Network failure / timeout: serve stale if we have any within 24 h.
    const stale = arcgisStale(key);
    if (stale) {
      res.set('X-TrailScope-Cache', 'stale');
      return res.status(stale.status).type('application/json').send(stale.body);
    }
    return res
      .status(502)
      .json({ error: 'ArcGIS upstream unavailable', detail: String(err && err.message ? err.message : err) });
  } finally {
    clearTimeout(timer);
  }
});

// ---- test hook (inert unless TRAILSCOPE_TEST_HOOKS=1) ------------------------
// Seeds an entry into the ArcGIS cache so the stale-on-error branch can be
// verified without a live upstream failure. Body: { u, body, status?, ageMs? }.
// ageMs backdates ts (e.g. 2 h) so the entry is TTL-expired but within the 24 h
// stale ceiling; a follow-up request whose upstream fails then serves it stale.
if (process.env.TRAILSCOPE_TEST_HOOKS === '1') {
  app.post('/api/_test/seed-arcgis', (req, res) => {
    const { u, body, status, ageMs } = req.body || {};
    if (typeof u !== 'string' || typeof body !== 'string') {
      return res.status(400).json({ error: 'need { u, body }' });
    }
    arcgisCache.set(new URL(u).toString(), {
      ts: Date.now() - (Number(ageMs) || 0),
      status: Number(status) || 200,
      body,
    });
    res.json({ ok: true, size: arcgisCache.size });
  });
}

// ---- SSDS proxy: /status, /runs, /info, /point -------------------------------
// Scope is the point API (guide §4): /adaptive/runs and /adaptive/info for
// discovery, and the SIBLING /multipoint for values. Tiles (/data), the SSPT
// point cloud and big-endian byte-swapping are deliberately not implemented.
//
// Three invariants hold across every route below:
//   1. The apiKey is injected here and appears nowhere else — not in a response
//      body, not in a log, not in a cache key. Anything echoing a URL is redacted.
//   2. The tiler is addressed with its own (2 h late) times; the offset is applied
//      only to the *Display fields, so a client cannot shift twice by accident.
//   3. A value that is missing, null or non-finite comes back as null, never 0.
//      `Number(null)` is 0, which would turn "outside CONUS" into a real reading.

// Same {ts, status, body} entry shape as the Overpass/ArcGIS caches, so the
// existing loadCache/flushCache helpers persist it unchanged.
const ssdsCache = new Map();

function ssdsCacheGet(key) {
  const hit = ssdsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > SSDS_TTL_MS) {
    ssdsCache.delete(key);
    return null;
  }
  ssdsCache.delete(key);
  ssdsCache.set(key, hit); // refresh recency
  return hit;
}

function ssdsCacheSet(key, entry) {
  ssdsCache.set(key, entry);
  while (ssdsCache.size > SSDS_CACHE_MAX) {
    const oldest = ssdsCache.keys().next().value;
    ssdsCache.delete(oldest);
  }
  scheduleFlush(ssdsCache, 'ssds');
}

/** Strip any apiKey value out of a string before it is logged or returned. */
const ssdsRedact = (s) => String(s == null ? '' : s).replace(/(apiKey=)[^&\s"']*/gi, '$1REDACTED');
/** Upstream error text is untrusted and can be a whole Varnish HTML page: redact + truncate. */
const ssdsDetail = (s) => ssdsRedact(s).slice(0, 400);

/** Display time = tiler time minus the rt offset (guide §7.1). */
const ssdsDisplay = (ms) =>
  Number.isFinite(ms) ? ms - SSDS_RT_OFFSET_HOURS * 3600 * 1000 : null;

/** The tiler's own run-label convention, "YYYY-MM-DD HHZ" in UTC. /info carries no
 *  label, so we format one from rt rather than spending a second request on /runs. */
function ssdsLabel(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}Z`;
}

/** A number only if it really is one. Guards the null-is-zero trap (invariant 3). */
const ssdsFinite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

const ssdsSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Transient-under-load statuses (guide §7.2). Nothing else is ever retried. */
const SSDS_RETRY_STATUS = new Set([502, 503, 504]);

/** Retry-After is either delta-seconds or an HTTP-date; both are legal (RFC 9110). */
function ssdsRetryAfterMs(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/**
 * One upstream call with the key injected, an AbortController timeout, and
 * Retry-After-aware backoff on 502/503/504 and network failures (guide §7.2).
 * Returns { status, text, ms } and never throws.
 */
async function ssdsFetch(path, { params = {}, method = 'GET', json = null } = {}) {
  const url = new URL(SSDS_BASE_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('apiKey', SSDS_API_KEY);

  const headers = { 'User-Agent': SSDS_UA };
  if (json) headers['Content-Type'] = 'application/json';

  let last = null;
  let totalMs = 0;
  for (let attempt = 1; attempt <= SSDS_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SSDS_TIMEOUT_MS);
    const start = Date.now();
    let wait = null;
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: json ? JSON.stringify(json) : undefined,
        signal: controller.signal,
      });
      const text = await resp.text();
      totalMs += Date.now() - start;
      // ONLY 502/503/504 are retried. A 401/403 is an edge denial and a 4xx is a
      // bad request: both are stable answers, and retrying them just triples the
      // latency of a failure the caller has to see anyway.
      if (!SSDS_RETRY_STATUS.has(resp.status)) {
        return { status: resp.status, text, ms: totalMs };
      }
      last = { status: resp.status, text };
      wait = ssdsRetryAfterMs(resp.headers.get('retry-after'));
    } catch (err) {
      totalMs += Date.now() - start;
      last = {
        status: 504,
        text:
          err && err.name === 'AbortError'
            ? `upstream timeout after ${SSDS_TIMEOUT_MS} ms`
            : String(err && err.message ? err.message : err),
      };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < SSDS_ATTEMPTS) {
      await ssdsSleep(Math.min(wait == null ? 400 * 2 ** (attempt - 1) : wait, 5000));
    }
  }
  return {
    status: (last && last.status) || 502,
    text: (last && last.text) || 'SSDS upstream unavailable',
    ms: totalMs,
  };
}

/** GET an SSDS JSON endpoint through the 300 s cache. The key never holds the apiKey. */
async function ssdsGetJson(path, params) {
  const key = `raw:${path}:${JSON.stringify(params)}`;
  const hit = ssdsCacheGet(key);
  if (hit) {
    try {
      return { status: hit.status, json: JSON.parse(hit.body), text: hit.body, ms: 0, cached: true };
    } catch {
      ssdsCache.delete(key); // unparseable persisted entry: drop it and refetch
    }
  }
  const { status, text, ms } = await ssdsFetch(path, { params });
  if (status !== 200) return { status, text, json: null, ms, cached: false };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: 502, text: 'upstream returned non-JSON', json: null, ms, cached: false };
  }
  ssdsCacheSet(key, { ts: Date.now(), status, body: text });
  return { status, json, text, ms, cached: false };
}

/** 503 + { configured: false } rather than letting a keyless request go upstream. */
function ssdsGuard(res) {
  if (SSDS_API_KEY) return true;
  res.status(503).json({ error: 'SSDS_API_KEY not configured', configured: false });
  return false;
}

/** An HTML body from the tiler is never a tiler response: the CDN edge answered. */
const ssdsLooksHtml = (s) => /^\s*<(?:!doctype|html|h1|head)\b/i.test(String(s == null ? '' : s));

/**
 * Forward a useful status plus a redacted, truncated detail.
 *
 * An HTML body gets its own state rather than being lumped in with a tiler
 * error. Observed 2026-08-11: qaapi's Akamai edge answers 401 "Access Denied"
 * identically for a real key, a bogus key and no key at all, i.e. it denies
 * before the tiler ever validates anything. That is network-level access
 * (IP allowlist / VPN), not a bad key and not a proxy bug, and the page should
 * be able to say so. `edgeDenied` marks it; the status is forwarded as-is.
 */
function ssdsUpstreamError(res, r, message) {
  const status = r.status >= 400 && r.status <= 599 ? r.status : 502;
  const edgeDenied = ssdsLooksHtml(r.text) && (r.status === 401 || r.status === 403);
  const payload = { error: message, status: r.status, detail: ssdsDetail(r.text) };
  if (edgeDenied) {
    payload.edgeDenied = true;
    payload.hint =
      'The upstream body is HTML, not JSON: the CDN edge denied the request before the tiler saw it. ' +
      'This is network-level access (IP allowlist / VPN / corporate network), not an invalid API key.';
  } else if (ssdsLooksHtml(r.text)) {
    payload.hint = 'The upstream body is HTML, not JSON: this came from the CDN edge, not the tiler.';
  }
  return res.status(status).json(payload);
}

// GET /api/ssds/status → { configured, baseUrl, rtOffsetHours }
// Deliberately answers without a key (that is its whole point) and never echoes
// the key itself, not even its length.
app.get('/api/ssds/status', (_req, res) => {
  res.json({
    configured: Boolean(SSDS_API_KEY),
    baseUrl: SSDS_BASE_URL,
    rtOffsetHours: SSDS_RT_OFFSET_HOURS,
  });
});

// GET /api/ssds/runs → { runs: [{ rt, rtDisplay, label, labelDisplay }], latestIndex, latestRt }
// Upstream order is newest LAST (guide §3) and is preserved as-is; latestIndex /
// latestRt save every caller from re-deriving it, and are computed from the
// largest rt rather than trusting position.
app.get('/api/ssds/runs', async (_req, res) => {
  if (!ssdsGuard(res)) return;
  const r = await ssdsGetJson('/adaptive/runs', {});
  if (r.status !== 200 || !r.json) return ssdsUpstreamError(res, r, 'SSDS /runs failed');

  const list = Array.isArray(r.json) ? r.json : Array.isArray(r.json.runs) ? r.json.runs : [];
  const runs = list.map((run) => {
    const rt = ssdsFinite(Number(run && run.rt));
    return {
      rt,
      rtDisplay: ssdsDisplay(rt),
      label: run && run.label != null ? String(run.label) : null,
      labelDisplay: ssdsLabel(ssdsDisplay(rt)),
    };
  });
  let latestIndex = -1;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].rt != null && (latestIndex < 0 || runs[i].rt >= runs[latestIndex].rt)) latestIndex = i;
  }
  res.set('X-TrailScope-Cache', r.cached ? 'hit' : 'miss');
  res.json({
    runs,
    latestIndex,
    latestRt: latestIndex >= 0 ? runs[latestIndex].rt : null,
    rtOffsetHours: SSDS_RT_OFFSET_HOURS,
  });
});

// GET /api/ssds/info?rt=0 → { rt, rtDisplay, products: { "<product:variable>": {...} } }
// Upstream product fields are passed through untouched; the only additions are
// the display-shifted mirrors. The -2 h shift belongs HERE, on run-issued labels,
// which is exactly where the guide's §7.1 bug lives — and nowhere near the
// client-generated axis of /api/ssds/point (see TIME BASIS in that route).
app.get('/api/ssds/info', async (req, res) => {
  if (!ssdsGuard(res)) return;
  const rtParam = req.query.rt === undefined || req.query.rt === '' ? 0 : Number(req.query.rt);
  if (!Number.isFinite(rtParam) || rtParam < 0) {
    return res.status(400).json({ error: 'rt must be a non-negative epoch-ms number (0 = latest)' });
  }

  const r = await ssdsGetJson('/adaptive/info', { rt: rtParam });
  if (r.status !== 200 || !r.json) return ssdsUpstreamError(res, r, 'SSDS /info failed');

  const rt = ssdsFinite(Number(r.json.rt));
  const products = {};
  for (const [key, meta] of Object.entries(r.json.products || {})) {
    const timesteps = (Array.isArray(meta && meta.timesteps) ? meta.timesteps : [])
      .map((t) => ssdsFinite(Number(t)))
      .filter((t) => t !== null);
    products[key] = {
      display_name: meta && meta.display_name != null ? meta.display_name : null,
      units: meta && meta.units != null ? meta.units : null,
      range: meta && meta.range != null ? meta.range : null,
      timesteps,
      timestepsDisplay: timesteps.map(ssdsDisplay),
    };
  }
  res.set('X-TrailScope-Cache', r.cached ? 'hit' : 'miss');
  res.json({
    rt,
    rtDisplay: ssdsDisplay(rt),
    label: ssdsLabel(rt),
    labelDisplay: ssdsLabel(ssdsDisplay(rt)),
    rtOffsetHours: SSDS_RT_OFFSET_HOURS,
    products,
  });
});

// ---- point API: times, units, and optional run discovery ---------------------

// Fallbacks for when the multipoint `metadata` block is absent. Units are the SI
// natives of guide §6; the tiler's own strings win whenever it sends them.
const SSDS_UNIT_FALLBACK = {
  temperature_2m: '°C',
  dewpoint_2m: '°C',
  wind_speed: 'm/s',
  wind_gust: 'm/s',
  u_wind_10m: 'm/s',
  v_wind_10m: 'm/s',
};
const SSDS_LABEL_FALLBACK = {
  temperature_2m: 'Temperature 2 m',
  dewpoint_2m: 'Dewpoint 2 m',
  wind_speed: 'Wind speed 10 m',
  wind_gust: 'Wind gust',
  u_wind_10m: 'U wind 10 m',
  v_wind_10m: 'V wind 10 m',
};

/**
 * The tiler serves the degree sign as mis-decoded bytes: "°C" arrives as "�C"
 * (or "Â°C" when the UTF-8 went through latin-1). Repair it here rather than
 * letting a broken glyph reach the page — every client would have to fix it again.
 */
function ssdsFixUnits(s) {
  if (typeof s !== 'string') return null;
  // \uFFFD is the replacement char the upstream sends for the degree sign;
  // \u00C2\u00B0 is the same sign after a UTF-8 -> latin-1 round trip. Escapes,
  // not literals, so this survives any re-encoding of this file.
  const fixed = s.replace(/\u00c2\u00b0/g, '\u00b0').replace(/\ufffd/g, '\u00b0').trim();
  return fixed === '' ? null : fixed;
}

const SSDS_DISCOVERY_DENIED_NOTE =
  'Run metadata is unavailable: the discovery endpoints (/adaptive/info, /adaptive/runs) ' +
  'are not authorised for this key. Times are client-generated and the horizon is measured ' +
  'from the data that came back, not read from metadata.';

// Run metadata is a nice-to-have, never a dependency. One cheap attempt, memoized
// for the cache TTL so a denied endpoint is not re-hit on every point call, and
// any failure degrades to available:false instead of failing the point request.
const ssdsDiscoveryMemo = new Map();

async function ssdsRunDiscovery(rtParam) {
  const memo = ssdsDiscoveryMemo.get(rtParam);
  if (memo && Date.now() - memo.ts <= SSDS_TTL_MS) return memo.value;

  let value;
  try {
    const r = await ssdsGetJson('/adaptive/info', { rt: rtParam });
    const rt = r.status === 200 && r.json ? ssdsFinite(Number(r.json.rt)) : null;
    if (rt !== null) {
      value = {
        run: {
          rt,
          rtDisplay: ssdsDisplay(rt),
          label: ssdsLabel(rt),
          labelDisplay: ssdsLabel(ssdsDisplay(rt)),
        },
        discovery: { available: true, status: r.status, note: 'Run metadata read from /adaptive/info.' },
      };
    } else {
      const denied = r.status === 401 || r.status === 403;
      value = {
        run: null,
        discovery: {
          available: false,
          status: r.status ?? null,
          note: denied
            ? SSDS_DISCOVERY_DENIED_NOTE
            : `Run metadata unavailable (upstream status ${r.status}). Times are client-generated ` +
              'and the horizon is measured from the data that came back.',
        },
      };
    }
  } catch (err) {
    value = {
      run: null,
      discovery: {
        available: false,
        status: null,
        note:
          'Run metadata unavailable (discovery request failed). Times are client-generated and the ' +
          'horizon is measured from the data that came back.',
      },
    };
  }

  ssdsDiscoveryMemo.set(rtParam, { ts: Date.now(), value });
  while (ssdsDiscoveryMemo.size > 16) ssdsDiscoveryMemo.delete(ssdsDiscoveryMemo.keys().next().value);
  return value;
}

// POST /api/ssds/point
//   body: { lon, lat, hours?=36 (cap 60), hoursBack?=0 (cap 24), rt?=0, products?: string[] }
//
// Times are generated here, not read from /adaptive/info. Verified 2026-08-11:
// this key is authorised for the point API but not for the discovery endpoints,
// which both answer with an Akamai 401. The tiler accepts arbitrary ISO-8601
// times and simply returns null for anything it has no data for, so we sweep
// hourly from -hoursBack to +hours and report what lands.
//
// The consequence is that the horizon is MEASURED rather than declared: the
// `horizon` block is computed from which rows actually carry finite values. That
// is the more honest number of the two. A declared "+36 h" is a property of the
// run; the measured horizon is what this key really gets from this run right now,
// and it shrinks as the run ages (a +36 h run issued 5 h ago measures as +31 h).
//
// A point outside the CONUS domain is a clean 200 with coverage.withData === 0,
// not an error: the domain limit is a state the page has to show, not a failure.
app.post('/api/ssds/point', async (req, res) => {
  if (!ssdsGuard(res)) return;
  const body = req.body || {};

  const lon = Number(body.lon);
  const lat = Number(body.lat);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'lon must be a finite number in [-180, 180]' });
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return res.status(400).json({ error: 'lat must be a finite number in [-90, 90]' });
  }

  const hoursRaw =
    body.hours === undefined || body.hours === null ? SSDS_DEFAULT_HOURS : Number(body.hours);
  if (!Number.isFinite(hoursRaw) || hoursRaw <= 0) {
    return res.status(400).json({ error: 'hours must be a positive number' });
  }
  const hours = Math.min(Math.round(hoursRaw), SSDS_MAX_HOURS);

  const backRaw = body.hoursBack === undefined || body.hoursBack === null ? 0 : Number(body.hoursBack);
  if (!Number.isFinite(backRaw) || backRaw < 0) {
    return res.status(400).json({ error: 'hoursBack must be a non-negative number' });
  }
  const hoursBack = Math.min(Math.round(backRaw), SSDS_MAX_HOURS_BACK);

  const rtParam = body.rt === undefined || body.rt === null ? 0 : Number(body.rt);
  if (!Number.isFinite(rtParam) || rtParam < 0) {
    return res.status(400).json({ error: 'rt must be a non-negative epoch-ms number (0 = latest)' });
  }

  // Accept "product:variable" or a bare megapoints variable name.
  const rawProducts =
    Array.isArray(body.products) && body.products.length ? body.products : SSDS_DEFAULT_PRODUCTS;
  const products = [
    ...new Set(
      rawProducts
        .filter((p) => typeof p === 'string' && p.trim() !== '')
        .map((p) => p.trim())
        .map((p) => (p.includes(':') ? p : `${SSDS_PRODUCT}:${p}`)),
    ),
  ];
  if (!products.length) {
    return res.status(400).json({ error: 'products must be a non-empty array of strings' });
  }
  if (products.length > SSDS_MAX_PRODUCTS) {
    return res.status(400).json({ error: `at most ${SSDS_MAX_PRODUCTS} products per request` });
  }
  // The product list lands in a query string, so keep it to the observed charset.
  const bad = products.find((p) => !/^[A-Za-z0-9_.:-]+$/.test(p));
  if (bad) {
    return res.status(400).json({ error: `invalid product identifier: ${String(bad).slice(0, 60)}` });
  }

  // TIME BASIS — measured 2026-08-11 at the Longs Peak trailhead. Do NOT
  // reintroduce a display shift on this path.
  //
  // The guide's +2 h rt bug (§7.1) is a property of the LABELS that /runs and
  // /info hand out, not of the data /multipoint returns for a time you name
  // yourself. 31 hourly temperatures, reading the requested UTC labels at face
  // value (MDT = UTC-6):
  //     05:00 local  12.8 °C   <- diurnal minimum
  //     06:00 local  12.8 °C   <- minimum plateau
  //     07:00 local  14.0 °C   <- warming begins
  //     13:00 local  25.2 °C   <- daytime maximum
  // Sunrise that day is ~06:08 MDT (solar noon 13:02 from lon -105.5566,
  // declination +15.4°, half-day angle 6 h 54 m). The minimum plateau brackets
  // sunrise and the maximum sits an hour past solar noon: a correct time axis.
  // Apply the -2 h shift and the same curve puts the minimum at 03:00-04:00 with
  // warming from 05:00, over an hour BEFORE the sun is up, and the daily maximum
  // at 11:00 — physically impossible on a clear summer day.
  //
  // So times we generate ourselves are answered at face value: tDisplayMs equals
  // tMs. The shift survives only where the bug actually lives, on values derived
  // from run metadata (run.rtDisplay/labelDisplay, /info timestepsDisplay).
  //
  // The gate is the SOURCE OF THE TIME AXIS, not merely whether run metadata is
  // available. This path generates its own times even when /info is authorised,
  // so gating on run presence would silently reintroduce the shift the day the
  // key gains discovery access.
  const timeBasis = 'as-requested'; // 'run-relative' when an axis is read from /info timesteps
  const toDisplayMs =
    timeBasis === 'run-relative' ? ssdsDisplay : (ms) => (Number.isFinite(ms) ? ms : null);

  // (a) Generate the times: hourly, snapped to the top of the current hour.
  const HOUR = 3600 * 1000;
  const baseMs = Math.floor(Date.now() / HOUR) * HOUR;
  let steps = [];
  for (let h = -hoursBack; h <= hours; h++) steps.push(baseMs + h * HOUR);
  const truncated = steps.length > SSDS_MAX_STEPS;
  if (truncated) steps = steps.slice(0, SSDS_MAX_STEPS);

  // baseMs is in the key so a cached answer can never outlive the hour it describes.
  const cacheKey = `point:${JSON.stringify({ lon, lat, hours, hoursBack, rt: rtParam, products, baseMs })}`;
  const cached = ssdsCacheGet(cacheKey);
  if (cached) {
    res.set('X-TrailScope-Cache', 'hit');
    return res.status(cached.status).type('application/json').send(cached.body);
  }

  // (b) ONE POST to the sibling /multipoint — same point per timestep, times in
  // the tiler's OWN clock (no shift on the wire; the shift is display-only).
  // Discovery runs alongside it and can only ever add metadata, never block.
  const times = steps.map((t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const [mp, disc] = await Promise.all([
    ssdsFetch('/multipoint', {
      method: 'POST',
      params: { products: products.join(',') },
      json: { geometry: { type: 'MultiPoint', coordinates: steps.map(() => [lon, lat]) }, times },
    }),
    ssdsRunDiscovery(rtParam),
  ]);
  if (mp.status !== 200) return ssdsUpstreamError(res, mp, 'SSDS /multipoint failed');
  let parsed;
  try {
    parsed = JSON.parse(mp.text);
  } catch {
    return res
      .status(502)
      .json({ error: 'SSDS /multipoint returned non-JSON', status: mp.status, detail: null });
  }
  const points = Array.isArray(parsed && parsed.points) ? parsed.points : [];

  // (c) Labels and units from the response's own metadata block when present:
  //   metadata.products["<prod:var>"].components["<var>"] = { units, description }
  const metaProducts =
    parsed && parsed.metadata && parsed.metadata.products ? parsed.metadata.products : null;
  const variables = products.map((p) => {
    const key = p.includes(':') ? p.slice(p.indexOf(':') + 1) : p;
    // Verified 2026-08-11: `components` is keyed by the FULL "product:variable"
    // string, unlike points[].data[product] whose bucket is keyed by the bare
    // variable. Try both rather than assuming either.
    const components =
      metaProducts && metaProducts[p] && metaProducts[p].components ? metaProducts[p].components : null;
    const comp = components ? components[p] || components[key] || null : null;
    return {
      key,
      product: p,
      label:
        (comp && typeof comp.description === 'string' && comp.description.trim()) ||
        SSDS_LABEL_FALLBACK[key] ||
        key,
      units: (comp && ssdsFixUnits(comp.units)) || SSDS_UNIT_FALLBACK[key] || null,
    };
  });
  // Only claim a product is unavailable when metadata exists to say so.
  const unavailableProducts = metaProducts ? products.filter((p) => !metaProducts[p]) : [];

  // (d) Normalize. A point, its data bucket, or a single value can each be null
  // outside coverage; every one of those paths has to end in null, not 0.
  const rows = steps.map((t, i) => {
    const point = points[i];
    const data = point && point.data ? point.data : null;
    const values = {};
    for (const v of variables) {
      const bucket = data ? data[v.product] : null;
      const cell = bucket ? bucket[v.key] : null;
      values[v.key] = Array.isArray(cell) ? ssdsFinite(cell[0]) : ssdsFinite(cell);
    }
    // Guide §4: meteorological "from" bearing, only when both components exist.
    const u = values.u_wind_10m;
    const v = values.v_wind_10m;
    const windDirDeg =
      typeof u === 'number' && typeof v === 'number'
        ? (((270 - (Math.atan2(v, u) * 180) / Math.PI) % 360) + 360) % 360
        : null;
    return {
      tMs: t,
      tDisplayMs: toDisplayMs(t), // === tMs on the as-requested axis (see TIME BASIS)
      // Lead is measured from the request base (top of the current hour), NOT from
      // the model run: without the discovery endpoints the run time is unknowable.
      leadHours: Math.round(((t - baseMs) / HOUR) * 100) / 100,
      values,
      windDirDeg,
    };
  });

  const withData = rows.filter((r) => Object.values(r.values).some((x) => x !== null));
  const first = withData.length ? withData[0] : null;
  const last = withData.length ? withData[withData.length - 1] : null;
  const horizon = {
    firstDataMs: first ? first.tMs : null,
    lastDataMs: last ? last.tMs : null,
    firstDataDisplayMs: first ? first.tDisplayMs : null, // same axis as the rows
    lastDataDisplayMs: last ? last.tDisplayMs : null,
    firstLeadHours: first ? first.leadHours : null,
    lastLeadHours: last ? last.leadHours : null,
    hoursWithData: withData.length,
    hoursRequested: rows.length,
  };

  // The tiler echoes the coordinate it actually answered for; keep the first one
  // as a sanity check that [lon, lat] order survived the round trip.
  const echoed = points.find((p) => p && Array.isArray(p.coordinate));
  const coordinate = echoed ? echoed.coordinate : null;

  const payload = {
    run: disc.run, // null whenever the discovery endpoints are denied
    runDiscovery: disc.discovery,
    // Kept for transparency even when it is not applied: a client can see both the
    // configured offset and, via timeBasis, that this axis does not use it.
    rtOffsetHours: SSDS_RT_OFFSET_HOURS,
    timeBasis,
    requested: { lon, lat, hours, hoursBack, rt: rtParam, products, baseMs, baseDisplayMs: toDisplayMs(baseMs) },
    coordinate,
    variables,
    rows,
    horizon,
    coverage: { total: rows.length, withData: withData.length },
    unavailableProducts,
    truncated,
    upstreamMs: mp.ms,
  };
  const text = JSON.stringify(payload);
  ssdsCacheSet(cacheKey, { ts: Date.now(), status: 200, body: text });
  res.set('X-TrailScope-Cache', 'miss');
  return res.status(200).type('application/json').send(text);
});

// ---- boot warm-up + graceful flush ------------------------------------------
loadCache(cache, 'overpass');
loadCache(arcgisCache, 'arcgis');
loadCache(ssdsCache, 'ssds');

function flushAll() {
  flushCache(cache, 'overpass');
  flushCache(arcgisCache, 'arcgis');
  flushCache(ssdsCache, 'ssds');
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    flushAll();
    process.exit(0);
  });
}

// ---- static built app (serves index.html + matrix.html from dist/) ----------
app.use(express.static(join(__dirname, 'dist')));

app.listen(PORT, () => {
  console.log(`TrailScope server listening on http://localhost:${PORT}`);
});
