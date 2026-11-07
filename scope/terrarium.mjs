// Trail Scope — terrarium elevation sampling in plain Node (zero deps).
//
// The browser gets elevation for free: src/data/elevation.ts loads a terrarium PNG into
// an <img>, draws it to a canvas and reads pixels back. Node has no canvas, so this file
// decodes the PNG by hand with node:zlib and nothing else, then reproduces the SAME
// numbers so the derived JSON and the live map app can never disagree about one trail.
//
// What "the same numbers" means, concretely, and why each piece is here:
//   * z13 tiles, same URL template, same lon/lat → tile/pixel math (floor, clamp 0..255).
//   * elevation = R * 256 + G + B / 256 - 32768, exactly as elevation.ts does it.
//   * 120 samples allocated per part by real haversine length, so a disconnected trail's
//     x-axis never bridges a gap, and positive gain is accumulated over a 5-wide smoothed
//     series PER PART, never across a seam (a seam would manufacture a phantom climb).
// The one deliberate difference: everything here is metres. elevation.ts converts to feet
// and miles for its own UI; src/scope/types.ts stores SI and converts at the last moment.
//
// Verification anchor (elevation.ts header, and SCOPE_PLAN §4): Longs Peak summit
// (-105.6151, 40.2549) is 4346 m on the map and must decode within ~1 m. Run:
//   node scope/derive.mjs verify
//
// Tiles are cached twice: in memory for the run, and as decoded Float32 elevation grids
// under .cache/terrarium/ (already covered by the .cache/ line in .gitignore) so a rerun
// costs no network at all. Fetches are capped at 6 in flight and retried with backoff,
// because elevation-tiles-prod is a free public bucket and we are a guest on it.

import { inflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '.cache', 'terrarium');

export const TILE_Z = 13;
export const TILE_SIZE = 256;
/** Samples per trail before downsampling to PROFILE_POINTS. Matches elevation.ts. */
export const SAMPLES = 120;
/** Smoothing window for the gain accumulation. Matches elevation.ts. */
export const SMOOTH_WINDOW = 5;

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const ELEVATION_SOURCE = 'Terrarium z13 (AWS elevation-tiles-prod, Mapzen/Nextzen)';

const MAX_IN_FLIGHT = 6;
const FETCH_ROUNDS = 4;

// ---- PNG decode ---------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Minimal PNG reader: chunk walk → concatenated IDAT → inflate → per-scanline unfilter.
 * Handles what terrarium actually ships (8-bit RGB, colour type 2) plus 8-bit RGBA
 * (colour type 6) so a re-encoded tile still works. Anything else — paletted, 16-bit,
 * interlaced, greyscale — throws rather than silently producing wrong elevations.
 * Returns { width, height, channels, pixels } with `pixels` unfiltered row-major bytes.
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG (bad signature)');
  }
  let offset = 8;
  let ihdr = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      ihdr = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        bitDepth: buffer[dataStart + 8],
        colourType: buffer[dataStart + 9],
        compression: buffer[dataStart + 10],
        filter: buffer[dataStart + 11],
        interlace: buffer[dataStart + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4; // + CRC
  }
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  if (idat.length === 0) throw new Error('PNG has no IDAT data');
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${ihdr.bitDepth} (need 8)`);
  if (ihdr.interlace !== 0) throw new Error('unsupported interlaced PNG (Adam7)');
  if (ihdr.compression !== 0) throw new Error(`unsupported PNG compression ${ihdr.compression}`);
  if (ihdr.filter !== 0) throw new Error(`unsupported PNG filter method ${ihdr.filter}`);
  const channels = ihdr.colourType === 2 ? 3 : ihdr.colourType === 6 ? 4 : 0;
  if (channels === 0) {
    throw new Error(`unsupported PNG colour type ${ihdr.colourType} (need 2 = RGB or 6 = RGBA)`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const bpp = channels; // 8-bit, so bytes-per-pixel == channels
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) {
    throw new Error(`PNG inflated to ${raw.length} bytes, expected ${height * (stride + 1)}`);
  }

  // Unfilter in place into a fresh buffer, one scanline at a time. Filters reference the
  // byte bpp to the left (a), the same byte on the row above (b) and above-left (c).
  const pixels = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? pixels[dst + i - bpp] : 0;
      const b = y > 0 ? pixels[up + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[up + i - bpp] : 0;
      let value;
      switch (filterType) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: value = x + paeth(a, b, c); break;
        default: throw new Error(`unsupported PNG scanline filter ${filterType} on row ${y}`);
      }
      pixels[dst + i] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// ---- tile → elevation grid ----------------------------------------------------

/** Terrarium decode, identical to sampleElevationMeters() in src/data/elevation.ts. */
function pixelsToElevations({ width, height, channels, pixels }) {
  const grid = new Float32Array(width * height);
  for (let i = 0, p = 0; i < grid.length; i++, p += channels) {
    grid[i] = pixels[p] * 256 + pixels[p + 1] + pixels[p + 2] / 256 - 32768;
  }
  return grid;
}

/** Same projection as src/data/elevation.ts: floor to tile, floor+clamp to pixel. */
export function lonLatToTilePixel(lon, lat, z = TILE_Z) {
  const n = 2 ** z;
  const xf = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yf = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  const px = Math.min(255, Math.max(0, Math.floor((xf - x) * TILE_SIZE)));
  const py = Math.min(255, Math.max(0, Math.floor((yf - y) * TILE_SIZE)));
  return { x, y, px, py };
}

const memCache = new Map();
const inFlight = new Map();
let active = 0;
const waiting = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Crude semaphore: never more than MAX_IN_FLIGHT tile downloads at once. */
async function withSlot(fn) {
  if (active >= MAX_IN_FLIGHT) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

async function download(x, y, z) {
  let lastErr;
  for (let round = 0; round < FETCH_ROUNDS; round++) {
    try {
      const resp = await fetch(`${TERRARIUM_URL}/${z}/${x}/${y}.png`, {
        headers: { 'User-Agent': 'TrailScope/0.1 (trail data source evaluation)' },
      });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      return Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (round < FETCH_ROUNDS - 1) await sleep(500 * 2 ** round);
    }
  }
  throw new Error(`terrarium tile ${z}/${x}/${y} failed: ${lastErr?.message}`);
}

/**
 * Decoded elevation grid for one tile (Float32, row-major, 256 × 256).
 * Memory cache → disk cache → network. The disk form is the decoded grid, not the PNG,
 * so a rerun skips both the download and the inflate.
 */
export async function loadTile(x, y, z = TILE_Z) {
  const key = `${z}/${x}/${y}`;
  const hit = memCache.get(key);
  if (hit) return hit;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const file = join(CACHE_DIR, `${z}_${x}_${y}.f32`);
  const expected = TILE_SIZE * TILE_SIZE * 4;
  if (existsSync(file)) {
    const buf = readFileSync(file);
    if (buf.length === expected) {
      const grid = new Float32Array(buf.buffer, buf.byteOffset, TILE_SIZE * TILE_SIZE);
      memCache.set(key, grid);
      return grid;
    }
  }

  const p = withSlot(async () => {
    const png = await download(x, y, z);
    const decoded = decodePng(png);
    if (decoded.width !== TILE_SIZE || decoded.height !== TILE_SIZE) {
      throw new Error(`tile ${key} is ${decoded.width}×${decoded.height}, expected 256×256`);
    }
    const grid = pixelsToElevations(decoded);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength));
    memCache.set(key, grid);
    return grid;
  }).finally(() => inFlight.delete(key));

  inFlight.set(key, p);
  return p;
}

/** Elevation in metres at one [lon, lat]. */
export async function sampleElevation(lon, lat) {
  const { x, y, px, py } = lonLatToTilePixel(lon, lat);
  const grid = await loadTile(x, y);
  return grid[py * TILE_SIZE + px];
}

/**
 * Elevations in metres for an array of [lon, lat] coordinates, in the same order.
 * Groups by tile first so each tile is touched once, which is what keeps a whole region
 * (thousands of trails, ~25 distinct z13 tiles) to a couple of dozen downloads.
 */
export async function sampleElevations(coords) {
  const byTile = new Map();
  const located = coords.map(([lon, lat]) => {
    const t = lonLatToTilePixel(lon, lat);
    const key = `${t.x}/${t.y}`;
    if (!byTile.has(key)) byTile.set(key, { x: t.x, y: t.y });
    return { key, px: t.px, py: t.py };
  });
  const grids = new Map();
  // Sequential over tiles; loadTile's own semaphore handles the concurrency we allow.
  const keys = [...byTile.keys()];
  const loads = keys.map(async (key) => {
    const { x, y } = byTile.get(key);
    grids.set(key, await loadTile(x, y));
  });
  await Promise.all(loads);
  return located.map((l) => grids.get(l.key)[l.py * TILE_SIZE + l.px]);
}

// ---- profile ------------------------------------------------------------------

export function haversineMeters(a, b) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Centred moving average, same shape as smoothSeries() in src/data/elevation.ts. */
export function smoothSeries(values, window = SMOOTH_WINDOW) {
  if (values.length <= 2) return values.slice();
  const half = Math.floor(window / 2);
  const out = [];
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < values.length) {
        sum += values[j];
        n++;
      }
    }
    out.push(sum / n);
  }
  return out;
}

/**
 * Sample a trail's elevation profile. `parts` is a list of coordinate rings kept SEPARATE
 * (never flattened), exactly as src/data/elevation.ts insists, so nothing bridges a
 * disconnected part.
 *
 * Returns metres and metres: { distM, elevM, smoothM, partIndex, seamIndices, gainM,
 * descentM, minElevM, maxElevM, lengthM }. Sample allocation, interpolation and gain
 * accumulation are line-for-line the same logic as buildElevationProfile(), only in SI.
 *
 * `descentM` is the mirror of gainM: positive metres of drop, accumulated over the same
 * smoothed series and equally never across a seam. elevation.ts has no equivalent because
 * its chart shows descent implicitly; a card has to print it as a number.
 *
 * Both are relative to the order `parts` arrives in. Callers that care which end is the
 * low one must orient the geometry BEFORE calling (see scope/derive.mjs).
 */
export async function buildProfile(parts) {
  const usable = parts.filter((p) => Array.isArray(p) && p.length >= 1);
  if (usable.length === 0) {
    return { distM: [], elevM: [], smoothM: [], partIndex: [], seamIndices: [], gainM: 0, descentM: 0, minElevM: 0, maxElevM: 0, lengthM: 0 };
  }

  const partCum = usable.map((p) => {
    const cum = [0];
    for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + haversineMeters(p[i - 1], p[i]));
    return cum;
  });
  const partLen = partCum.map((cum) => cum[cum.length - 1]);
  const totalLen = partLen.reduce((a, b) => a + b, 0);

  const sampled = [];
  const seamIndices = [];
  let offset = 0;
  for (let pi = 0; pi < usable.length; pi++) {
    const p = usable[pi];
    const cum = partCum[pi];
    const len = partLen[pi];
    if (pi > 0) seamIndices.push(sampled.length);
    if (len === 0 || p.length < 2) {
      sampled.push({ lon: p[0][0], lat: p[0][1], distM: offset, part: pi });
      continue;
    }
    const nSamp = totalLen > 0 ? Math.max(2, Math.round(SAMPLES * (len / totalLen))) : 2;
    let seg = 0;
    for (let k = 0; k < nSamp; k++) {
      const target = (len * k) / (nSamp - 1);
      while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
      const segStart = cum[seg];
      const segEnd = cum[seg + 1];
      const t = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
      const a = p[seg];
      const b = p[seg + 1];
      sampled.push({
        lon: a[0] + (b[0] - a[0]) * t,
        lat: a[1] + (b[1] - a[1]) * t,
        distM: offset + target,
        part: pi,
      });
    }
    offset += len;
  }

  const elevM = await sampleElevations(sampled.map((s) => [s.lon, s.lat]));

  // Smooth and accumulate positive gain WITHIN each part only. Crossing a seam here would
  // read the jump between two disconnected parts as a climb the walker never makes.
  const smoothM = new Array(elevM.length);
  let gainM = 0;
  let descentM = 0;
  let runStart = 0;
  for (let i = 1; i <= sampled.length; i++) {
    if (i === sampled.length || sampled[i].part !== sampled[runStart].part) {
      const smooth = smoothSeries(elevM.slice(runStart, i));
      for (let j = 0; j < smooth.length; j++) smoothM[runStart + j] = smooth[j];
      for (let j = 1; j < smooth.length; j++) {
        const d = smooth[j] - smooth[j - 1];
        if (d > 0) gainM += d;
        else descentM -= d;
      }
      runStart = i;
    }
  }

  return {
    distM: sampled.map((s) => s.distM),
    elevM,
    smoothM,
    partIndex: sampled.map((s) => s.part),
    seamIndices,
    gainM,
    descentM,
    minElevM: elevM.length ? Math.min(...elevM) : 0,
    maxElevM: elevM.length ? Math.max(...elevM) : 0,
    lengthM: totalLen,
  };
}

// ---- verification -------------------------------------------------------------

/** The Longs Peak summit anchor from src/data/elevation.ts. Metres. */
export const ANCHOR = { name: 'Longs Peak summit', lon: -105.6151, lat: 40.2549, knownM: 4346 };

/** Decode the anchor pixel and report the delta. Called by `derive.mjs verify`. */
export async function verifyAnchor() {
  const decodedM = await sampleElevation(ANCHOR.lon, ANCHOR.lat);
  return { ...ANCHOR, decodedM, deltaM: decodedM - ANCHOR.knownM };
}
