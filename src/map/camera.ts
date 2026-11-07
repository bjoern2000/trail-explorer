// Workstream A — flyToTrail choreography (fitBounds → tilt, terrain on).
//
// Two-stage move (PLAN §6): fit the feature flat with 80px padding, then on moveend
// ease to a 60° tilt aligned to the trail's overall start→end azimuth over 1.8s.
// Terrain is enabled through the store if it was off so the controls stay in sync.

import maplibregl from 'maplibre-gl';
import { getMap } from './map';
import { store } from '../main';

/** Great-circle initial bearing from `a` to `b`, degrees clockwise from north. */
function bearingBetween(a: number[], b: number[]): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const toDeg = (r: number): number => (r * 180) / Math.PI;
  const phi1 = toRad(a[1]);
  const phi2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Collect the ordered line parts (each an array of positions) from the geometry. */
function lineParts(geom: GeoJSON.Geometry): number[][][] {
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}

/** Fit the feature, then ease to pitch 60 aligned to the trail azimuth; enable terrain. */
export function flyToTrail(feature: GeoJSON.Feature): void {
  const map = getMap();
  const parts = lineParts(feature.geometry);
  const allCoords = parts.flat();
  if (allCoords.length < 2) return;

  // Bounds over every vertex.
  const bounds = new maplibregl.LngLatBounds(
    [allCoords[0][0], allCoords[0][1]],
    [allCoords[0][0], allCoords[0][1]]
  );
  for (const c of allCoords) bounds.extend([c[0], c[1]]);

  // Overall azimuth: first vertex of the first part → last vertex of the last part.
  const start = parts[0][0];
  const lastPart = parts[parts.length - 1];
  const end = lastPart[lastPart.length - 1];
  const bearing = bearingBetween(start, end);

  // Enable terrain through the store if it was off (keeps the 3D toggle in sync).
  if (!store.get().terrain3d) {
    store.set({ terrain3d: true });
  }

  map.once('moveend', () => {
    map.easeTo({ pitch: 60, bearing, duration: 1800 });
  });

  map.fitBounds(bounds, {
    padding: 80,
    pitch: 0,
    bearing: 0,
    maxZoom: 15,
    duration: 900,
  });
}
