// Workstream C — measured comparison metrics for the source matrix page.
//
// Fetches a fixed set of small "benchmark" regions from every source through the
// SAME adapters the map app uses (fetchArcgisViewport / fetchOverpassViewport, the
// latter via the /api/overpass proxy), then computes apples-to-apples metrics with
// one identical routine for all six sources. Pooled across regions. Cached to
// localStorage (schema-versioned, 24h TTL) so revisits are instant.

import { SOURCES, SOURCE_IDS } from '../registry';
import type { SourceId, TrailSourceDef, Units } from '../types';
import { fetchArcgisViewport } from '../data/arcgis';
import { fetchOverpassViewport } from '../data/overpass';
import { normalizeTrailName, featureLengthMeters, type BBox } from '../data/loader';

// ---- benchmark regions ------------------------------------------------------
// Fixed bboxes, each small enough that no source hits its record cap (verified
// live 2026-07-08: max ArcGIS count ~852, max OSM ~2.4k ways; caps are 2,000 /
// 6,000). Chosen so that, pooled, every source is represented where it is the
// land manager: NPS (RMNP/Santa Monica/Smokies), USFS (Tahoe/White Mtns),
// BLM (Prescott AZ), COTREX (Colorado), USGS + OSM everywhere.

export interface Region {
  id: string;
  label: string;
  bbox: BBox; // [w, s, e, n]
}

export const REGIONS: Region[] = [
  { id: 'rmnp', label: 'Rocky Mtn NP', bbox: [-105.75, 40.25, -105.55, 40.42] },
  { id: 'prescott', label: 'Prescott AZ', bbox: [-112.38, 33.92, -112.12, 34.18] },
  { id: 'tahoe', label: 'Lake Tahoe W', bbox: [-120.25, 38.9, -120.02, 39.18] },
  { id: 'santamonica', label: 'Santa Monica Mtns', bbox: [-118.85, 34.06, -118.65, 34.16] },
  { id: 'whitemtns', label: 'White Mtns NH', bbox: [-71.35, 44.15, -71.18, 44.3] },
  { id: 'smokies', label: 'Great Smoky Mtns', bbox: [-83.58, 35.55, -83.4, 35.7] },
];

// ---- property helpers -------------------------------------------------------

type Props = Record<string, unknown>;

/** Case-insensitive property lookup (ArcGIS field casing varies by service). */
function getProp(props: Props, field: string): unknown {
  if (props[field] !== undefined) return props[field];
  const lower = field.toLowerCase();
  for (const k in props) if (k.toLowerCase() === lower) return props[k];
  return undefined;
}

/** A value counts as "populated": present, non-empty, and not a literal 'null'. */
function isPopulated(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).trim();
  return s !== '' && s.toLowerCase() !== 'null';
}

/** Injected bookkeeping keys we never count as data attributes. */
function isDataKey(k: string): boolean {
  return !k.startsWith('__');
}

// ---- product-relevant coverage field mapping (per source) -------------------
// Surface / bike-info / difficulty presence, using each source's own schema.
// Exposed for the UI tooltips so the mapping is visible, not hidden in code.

export const COVERAGE_FIELDS: Record<
  'surface' | 'bike' | 'difficulty',
  Record<SourceId, string>
> = {
  surface: {
    usfs: 'trail_surface',
    nps: 'TRLSURFACE',
    blm: 'OBSRVE_SRFCE_TYPE',
    usgs: 'trailsurface',
    cotrex: 'surface',
    dec: 'n/a',
    osm: 'surface',
  },
  bike: {
    usfs: 'any bicycle_* field',
    nps: "TRLUSE contains 'bicycle'/'bike'",
    blm: "PLAN_ALLOW_MODE_TRNSPRT contains 'bicycle'",
    usgs: 'bicycle',
    cotrex: 'bike',
    dec: 'BIKE',
    osm: 'bicycle',
  },
  difficulty: {
    usfs: 'trail_class',
    nps: 'TRLCLASS',
    blm: 'n/a',
    usgs: 'n/a',
    cotrex: 'n/a',
    dec: 'n/a',
    osm: 'sac_scale / mtb:scale',
  },
};

function surfaceCovered(id: SourceId, props: Props): boolean {
  return isPopulated(getProp(props, COVERAGE_FIELDS.surface[id]));
}

function bikeCovered(id: SourceId, props: Props): boolean {
  switch (id) {
    case 'usfs': {
      for (const k in props) {
        if (/^bicycle_/i.test(k) && isPopulated(props[k])) return true;
      }
      return false;
    }
    case 'nps': {
      const v = String(getProp(props, 'TRLUSE') ?? '').toLowerCase();
      return v.includes('bicycle') || v.includes('bike');
    }
    case 'blm': {
      const v = String(getProp(props, 'PLAN_ALLOW_MODE_TRNSPRT') ?? '').toLowerCase();
      return v.includes('bicycle');
    }
    case 'usgs':
      return isPopulated(getProp(props, 'bicycle'));
    case 'cotrex':
      return isPopulated(getProp(props, 'bike'));
    case 'dec':
      return isPopulated(getProp(props, 'BIKE'));
    case 'osm':
      return isPopulated(getProp(props, 'bicycle'));
  }
}

/** Difficulty coverage; null = the source has no difficulty field at all (n/a). */
function difficultyCovered(id: SourceId, props: Props): boolean | null {
  switch (id) {
    case 'usfs':
      return isPopulated(getProp(props, 'trail_class'));
    case 'nps':
      return isPopulated(getProp(props, 'TRLCLASS'));
    case 'osm':
      return isPopulated(getProp(props, 'sac_scale')) || isPopulated(getProp(props, 'mtb:scale'));
    default:
      return null; // usgs, blm, cotrex, dec
  }
}

// ---- stats helpers ----------------------------------------------------------

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

// ---- result shape -----------------------------------------------------------

export interface SourceMetrics {
  sourceId: SourceId;
  segments: number;
  totalLengthM: number; // summed geometry length — fragmentation-independent volume
  namedLengthM: number; // length on segments that carry a name (product-usable volume)
  namedPct: number;
  distinctTrails: number;
  segsPerTrailMedian: number;
  segsPerTrailMean: number;
  attrsPerSegMedian: number;
  attrsPerSegMean: number;
  schemaFields: number | null; // union of schema keys (ArcGIS); null for OSM (open tagging)
  trailLenMedianM: number;
  surfacePct: number;
  bikePct: number;
  difficultyPct: number | null; // null = n/a for this source
  capped: boolean;
  regionsOk: number;
  regionsErrored: string[]; // region labels that failed for this source
}

export interface MetricsResult {
  schemaVersion: number;
  computedAt: number; // epoch ms
  regionLabels: string[];
  sources: Record<SourceId, SourceMetrics>;
}

export interface MeasureProgress {
  done: number;
  total: number;
}

// ---- per (source × region) fetch cell ---------------------------------------

interface Cell {
  sourceId: SourceId;
  regionLabel: string;
  features: GeoJSON.Feature[] | null; // null = fetch failed
  capped: boolean;
}

async function fetchCell(def: TrailSourceDef, region: Region, signal: AbortSignal): Promise<Cell> {
  try {
    const adapter = def.kind === 'overpass' ? fetchOverpassViewport : fetchArcgisViewport;
    const res = await adapter(def, region.bbox, signal);
    return { sourceId: def.id, regionLabel: region.label, features: res.features, capped: res.capped };
  } catch {
    return { sourceId: def.id, regionLabel: region.label, features: null, capped: false };
  }
}

/** Run tasks with at most `limit` in flight; report progress as each settles. */
async function runPool(
  cells: { def: TrailSourceDef; region: Region }[],
  limit: number,
  signal: AbortSignal,
  onDone: (cell: Cell) => void,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= cells.length) return;
      const cell = await fetchCell(cells[i].def, cells[i].region, signal);
      onDone(cell);
    }
  };
  const n = Math.min(limit, cells.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
}

// ---- metric computation from a source's cells -------------------------------

function computeSource(sourceId: SourceId, cells: Cell[]): SourceMetrics {
  const def = SOURCES[sourceId];
  const nameField = def.nameField;

  let segments = 0;
  let totalLengthM = 0;
  let namedLengthM = 0;
  let named = 0;
  let distinctTrails = 0;
  let capped = false;
  let regionsOk = 0;
  const regionsErrored: string[] = [];

  const segsPerTrail: number[] = [];
  const attrsPerSeg: number[] = [];
  const trailLengthsM: number[] = [];
  const schemaKeys = new Set<string>();

  let surfaceHits = 0;
  let bikeHits = 0;
  let diffHits = 0;
  let diffApplicable = false;

  for (const cell of cells) {
    if (cell.features == null) {
      regionsErrored.push(cell.regionLabel);
      continue;
    }
    regionsOk++;
    if (cell.capped) capped = true;

    // Per-region trail grouping (dedupe within region, pool across regions).
    const byTrail = new Map<string, GeoJSON.Feature[]>();

    for (const f of cell.features) {
      const props = (f.properties ?? {}) as Props;
      segments++;
      const lenM = featureLengthMeters(f);
      totalLengthM += lenM;

      // attributes per segment + schema union
      let populated = 0;
      for (const k in props) {
        if (!isDataKey(k)) continue;
        schemaKeys.add(k);
        if (isPopulated(props[k])) populated++;
      }
      attrsPerSeg.push(populated);

      // coverage
      if (surfaceCovered(sourceId, props)) surfaceHits++;
      if (bikeCovered(sourceId, props)) bikeHits++;
      const d = difficultyCovered(sourceId, props);
      if (d !== null) {
        diffApplicable = true;
        if (d) diffHits++;
      }

      // named grouping
      const nameVal = getProp(props, nameField);
      if (isPopulated(nameVal)) {
        named++;
        namedLengthM += lenM;
        const key = normalizeTrailName(String(nameVal));
        const arr = byTrail.get(key);
        if (arr) arr.push(f);
        else byTrail.set(key, [f]);
      }
    }

    distinctTrails += byTrail.size;
    for (const segs of byTrail.values()) {
      segsPerTrail.push(segs.length);
      let m = 0;
      for (const f of segs) m += featureLengthMeters(f);
      trailLengthsM.push(m);
    }
  }

  return {
    sourceId,
    segments,
    totalLengthM,
    namedLengthM,
    namedPct: segments ? (named / segments) * 100 : 0,
    distinctTrails,
    segsPerTrailMedian: median(segsPerTrail),
    segsPerTrailMean: mean(segsPerTrail),
    attrsPerSegMedian: median(attrsPerSeg),
    attrsPerSegMean: mean(attrsPerSeg),
    schemaFields: def.kind === 'arcgis' ? schemaKeys.size : null,
    trailLenMedianM: median(trailLengthsM),
    surfacePct: segments ? (surfaceHits / segments) * 100 : 0,
    bikePct: segments ? (bikeHits / segments) * 100 : 0,
    difficultyPct: diffApplicable && segments ? (diffHits / segments) * 100 : null,
    capped,
    regionsOk,
    regionsErrored,
  };
}

// ---- top-level measurement --------------------------------------------------

/**
 * Fetch every region from every source (≤4 concurrent, per-cell error tolerant)
 * and compute the pooled metrics. `onProgress` fires after each of the
 * REGIONS.length × SOURCE_IDS.length fetches settles.
 */
export async function measureMetrics(
  onProgress?: (p: MeasureProgress) => void,
  externalSignal?: AbortSignal,
): Promise<MetricsResult> {
  const controller = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const tasks: { def: TrailSourceDef; region: Region }[] = [];
  for (const region of REGIONS) {
    for (const id of SOURCE_IDS) tasks.push({ def: SOURCES[id], region });
  }

  const total = tasks.length;
  let done = 0;
  const bySource = new Map<SourceId, Cell[]>();
  for (const id of SOURCE_IDS) bySource.set(id, []);

  await runPool(tasks, 4, controller.signal, (cell) => {
    bySource.get(cell.sourceId)!.push(cell);
    done++;
    onProgress?.({ done, total });
  });

  const sources = {} as Record<SourceId, SourceMetrics>;
  for (const id of SOURCE_IDS) sources[id] = computeSource(id, bySource.get(id)!);

  return {
    schemaVersion: SCHEMA_VERSION,
    computedAt: Date.now(),
    regionLabels: REGIONS.map((r) => r.label),
    sources,
  };
}

// ---- localStorage cache (schema-versioned, 24h TTL) -------------------------

export const SCHEMA_VERSION = 2;
const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = `trailscope-metrics-v${SCHEMA_VERSION}`;

export function loadCachedMetrics(): MetricsResult | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MetricsResult;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    if (Date.now() - parsed.computedAt > TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedMetrics(result: MetricsResult): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(result));
  } catch {
    /* quota / unavailable — non-fatal, we just recompute next time */
  }
}

export function clearCachedMetrics(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** User's chosen units, shared with the map app (defaults to metric). */
export function readUnits(): Units {
  try {
    return localStorage.getItem('trailscope-units') === 'imperial' ? 'imperial' : 'metric';
  } catch {
    return 'metric';
  }
}
