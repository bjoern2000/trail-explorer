// Workstream B — Overpass adapter + OSM→GeoJSON conversion.
//
// Fetches OSM path/footway/track ways in the viewport via the /api/overpass
// proxy (server.js forwards to overpass-api.de with mirror fallback) and
// converts the inline-geometry `way` elements to GeoJSON LineStrings.

import type { TrailSourceDef } from '../types';
import type { BBox, AdapterResult } from './loader';

const OVERPASS_MAX_ELEMENTS = 6000;

/** Minimal shape of an Overpass 'way' element with inline geometry. */
export interface OverpassWay {
  type: 'way';
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

/** Build the PLAN §5 viewport query for a [w,s,e,n] bbox. */
export function buildOverpassQuery(bbox: BBox): string {
  const [w, s, e, n] = bbox;
  return `[out:json][timeout:30];
way["highway"~"^(path|footway|track)$"](${s},${w},${n},${e});
out geom qt ${OVERPASS_MAX_ELEMENTS};`;
}

/** Convert Overpass 'way' elements to GeoJSON LineString features. */
export function osmToGeoJSON(elements: OverpassWay[]): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const coordinates = el.geometry.map((p) => [p.lon, p.lat]);
    const atId = `way/${el.id}`;
    const properties: Record<string, unknown> = {
      ...(el.tags ?? {}),
      '@id': atId,
      __fid: `osm:${atId}`,
      __source: 'osm',
    };
    out.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties,
    });
  }
  return out;
}

/**
 * Fetch OSM paths in the bbox via the proxy (def.queryUrls[0] = /api/overpass).
 * Cap = element count >= 6000.
 */
export async function fetchOverpassViewport(
  def: TrailSourceDef,
  bbox: BBox,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const query = buildOverpassQuery(bbox);
  const url = def.queryUrls[0];
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status} ${resp.statusText}`);
  const json = (await resp.json()) as { elements?: unknown[] };
  const elements = Array.isArray(json.elements) ? json.elements : [];
  const ways = elements.filter(
    (el): el is OverpassWay =>
      !!el && (el as OverpassWay).type === 'way' && !!(el as OverpassWay).geometry,
  );
  const features = osmToGeoJSON(ways);
  const capped = elements.length >= OVERPASS_MAX_ELEMENTS;
  return { features, capped };
}

// ---- Phase 0 stub-name alias ----
export const fetchOverpass = fetchOverpassViewport;
