// Workstream D — terrarium tile sampler → elevation profile.
// Resamples a selected trail LineString to 120 points by haversine cumulative
// distance, samples z13 terrarium tiles (RGB → meters), returns distance/elevation
// series plus computed gain, min, max. Decode math verified numerically against
// Longs Peak summit (−105.6151, 40.2549 ≈ 4346 m): decoded 4346.4 m (Δ 0.4 m).

const TILE_Z = 13;
const SAMPLES = 120;
const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

/** Computed elevation profile for a selected trail Line/MultiLineString. */
export interface ElevationProfile {
  distancesMi: number[]; // cumulative REAL distance per sample (miles); no gap across parts
  elevationsFt: number[]; // elevation per sample (feet)
  gainFt: number; // total positive smoothed gain (feet); never accumulated across a part seam
  minFt: number;
  maxFt: number;
  seamIndices: number[]; // sample indices that begin a new (disconnected) part; [] when single-part
}

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;

// Persistent decoded-tile cache across selections (tiles are widely reused).
const tileCache = new Map<string, ImageData>();
const tileInFlight = new Map<string, Promise<ImageData>>();

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Line parts of a LineString / MultiLineString, each kept SEPARATE (never flattened
 *  into one list — flattening would bridge a disconnected part boundary into phantom
 *  distance/elevation). */
function extractParts(feature: GeoJSON.Feature): [number, number][][] {
  const g = feature.geometry;
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates.map((c) => [c[0], c[1]])];
  if (g.type === 'MultiLineString') return g.coordinates.map((seg) => seg.map((c) => [c[0], c[1]]));
  return [];
}

function lonLatToTilePixel(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const xf = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yf = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  const px = Math.min(255, Math.max(0, Math.floor((xf - x) * 256)));
  const py = Math.min(255, Math.max(0, Math.floor((yf - y) * 256)));
  return { x, y, px, py };
}

function loadTile(x: number, y: number, signal?: AbortSignal): Promise<ImageData> {
  const key = `${TILE_Z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = tileInFlight.get(key);
  if (pending) return pending;

  const p = new Promise<ImageData>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return reject(new Error('no 2d context'));
        ctx.drawImage(img, 0, 0, 256, 256);
        const data = ctx.getImageData(0, 0, 256, 256);
        tileCache.set(key, data);
        resolve(data);
      } catch (err) {
        reject(err as Error);
      }
    };
    img.onerror = () => reject(new Error(`tile load failed ${key}`));
    img.src = `${TERRARIUM_URL}/${TILE_Z}/${x}/${y}.png`;
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          img.src = '';
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    }
  }).finally(() => tileInFlight.delete(key));

  tileInFlight.set(key, p);
  return p;
}

function sampleElevationMeters(data: ImageData, px: number, py: number): number {
  const idx = (py * 256 + px) * 4;
  const R = data.data[idx];
  const G = data.data[idx + 1];
  const B = data.data[idx + 2];
  return R * 256 + G + B / 256 - 32768;
}

/**
 * Resample the line to 120 points and sample z13 terrarium tiles for elevation.
 * Rejects with an AbortError if `signal` fires so callers can discard stale runs.
 */
export async function buildElevationProfile(
  line: GeoJSON.Feature,
  signal?: AbortSignal,
): Promise<ElevationProfile> {
  const parts = extractParts(line).filter((p) => p.length >= 1);
  if (parts.length === 0) {
    return { distancesMi: [], elevationsFt: [], gainFt: 0, minFt: 0, maxFt: 0, seamIndices: [] };
  }

  // Per-part cumulative distance + length. Distances are measured WITHIN each part only;
  // the x-axis offset between parts is the sum of prior real part lengths (no bridge).
  const partCum = parts.map((p) => {
    const cum = [0];
    for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + haversineMeters(p[i - 1], p[i]));
    return cum;
  });
  const partLen = partCum.map((cum) => cum[cum.length - 1]);
  const totalLen = partLen.reduce((a, b) => a + b, 0);

  // Resample each part independently (samples allocated proportional to its real length).
  // A sample's global distance = real distance so far, so no gap is counted at a seam.
  const sampled: { lon: number; lat: number; distM: number; part: number }[] = [];
  const seamIndices: number[] = [];
  let offset = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi];
    const cum = partCum[pi];
    const len = partLen[pi];
    if (pi > 0) seamIndices.push(sampled.length); // first sample of this part starts a seam
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

  // Fetch each needed tile once, then read pixels.
  const elevationsM: number[] = [];
  for (const s of sampled) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const { x, y, px, py } = lonLatToTilePixel(s.lon, s.lat, TILE_Z);
    const tile = await loadTile(x, y, signal);
    elevationsM.push(sampleElevationMeters(tile, px, py));
  }

  const distancesMi = sampled.map((s) => s.distM / METERS_PER_MILE);
  const elevationsFt = elevationsM.map((m) => m * FEET_PER_METER);

  // Smooth + accumulate positive gain per part only (never across a seam, which would
  // manufacture a fake climb where the profile jumps between disconnected parts).
  let gainFt = 0;
  let runStart = 0;
  for (let i = 1; i <= sampled.length; i++) {
    if (i === sampled.length || sampled[i].part !== sampled[runStart].part) {
      const smooth = smoothSeries(elevationsFt.slice(runStart, i), 5);
      for (let j = 1; j < smooth.length; j++) {
        const d = smooth[j] - smooth[j - 1];
        if (d > 0) gainFt += d;
      }
      runStart = i;
    }
  }

  return {
    distancesMi,
    elevationsFt,
    gainFt,
    minFt: elevationsFt.length ? Math.min(...elevationsFt) : 0,
    maxFt: elevationsFt.length ? Math.max(...elevationsFt) : 0,
    seamIndices,
  };
}

function smoothSeries(values: number[], window: number): number[] {
  if (values.length <= 2) return values.slice();
  const half = Math.floor(window / 2);
  const out: number[] = [];
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
