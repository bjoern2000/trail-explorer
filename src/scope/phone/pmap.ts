// Trail Scope phone — the results map (screen 4).
//
// Its own MapLibre instance. It deliberately does NOT touch the singleton in
// src/map/map.ts: that map is the source-evaluation app's, it carries a store, three
// basemaps and a control panel, and none of that belongs inside a 390 px phone screen.
// The TERRAIN SETUP here is copied from that module rather than reinvented (same terrarium
// DEM, same twin-source rule, same hillshade colours, same attribution string) so the two
// maps in the app read as one product. It is the technique that is shared; the objects are
// separate and stay separate.
//
// THE ONE IMAGE THE PAGE IS FOR. The map section colours trails by SOURCE, which dataset
// covers what. This one colours the same geometry by CONDITION, where to go today. A ridge
// route going amber past noon while the valley loop stays green is route-specific weather
// in a single frame, and it is the strongest single argument on the page (SCOPE_PLAN §5).
//
// Which is exactly why the map is TILTED. Flat, "the ridge is amber and the valley is
// green" is a claim about two lines on a sheet of paper. At pitch, over shaded terrain,
// the reader sees the shoulder the amber route climbs over. The tilt is the argument,
// not decoration, and everything below is tuned around one constraint: the condition
// tint has to survive it. Hillshade sits UNDER the trails, the fog is pushed out to the
// horizon (`fog-ground-blend` near 1) and the exaggeration is modest, because a map where
// green, amber and red have gone muddy is worse than a flat one.
//
// Keyless raster basemap (USGS Topo), same as benchmark/bmap.ts and merge/mmap.ts, so the
// whole app stays free of API keys and cannot fail in front of an exec because a token
// expired. The DEM is keyless too, for the same reason. Scroll zoom is off: the page is a
// long scrolling document and a map that swallowed the wheel would trap the reader.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { haversineMeters } from '../../data/merge';
import type { ConditionGrade, ScopeTrail } from '../types';

/**
 * Sentinel for "nothing is selected" inside a MapLibre `case` expression. This was a
 * raw NUL character in the source, which made the file read as binary to grep, file(1)
 * and every other text tool. Any string no feature id can equal does the job.
 */
const NO_SELECTION = '__none__';

const TOPO_SOURCE = 'ph-usgs-topo';
const TOPO_LAYER = 'ph-usgs-topo-layer';
const TRAIL_SOURCE = 'ph-trails';
const TRAIL_HALO = 'ph-trails-halo';
const TRAIL_CORE = 'ph-trails-core';
const HEAD_SOURCE = 'ph-heads';
const HEAD_LAYER = 'ph-heads-circle';

// Two raster-dem sources off the same tiles: MapLibre will not let one instance drive both
// setTerrain and a hillshade layer. That is a library constraint, not a style choice, and
// src/map/map.ts carries the same pair for the same reason.
const DEM_TERRAIN_SOURCE = 'ph-dem-terrain';
const DEM_HILLSHADE_SOURCE = 'ph-dem-hillshade';
const HILLSHADE_LAYER = 'ph-hillshade';

const TERRARIUM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
const TERRARIUM_ATTRIB = 'Terrain: AWS Terrarium / Mapzen';

/**
 * Camera and terrain constants, all three tuned against the storms scenario, where a
 * region carries green, amber AND red at once and any loss of separation shows up first.
 *
 * PITCH 52 is the shallowest angle at which a ridge still reads as a ridge in a 390 px
 * frame. Past ~60 the far half of a region collapses into a band a few pixels tall and the
 * trails in it stop being pickable; below ~45 it just looks like a flat map someone
 * knocked over.
 *
 * EXAGGERATION 1.4 is the map explorer's default, and it is deliberately the same number:
 * the two maps are the same terrain and should not disagree about how tall it is. It also
 * happens to be the right call for the Ozarks, where the honest answer is "this place is
 * flat" and inflating the relief to manufacture drama would be a lie about the region.
 *
 * MAX_PITCH is below MapLibre's 85 on purpose. Nothing in this UI wants a horizon-level
 * view, and a two-finger gesture that could reach one is a way to get lost.
 *
 * PITCH is exported (additively; nothing else here changes) so trail/mapconcept.ts's
 * Concept A, which reuses this module's map wholesale, can state the real camera angle in
 * its own prose instead of typing a second copy of the number.
 */
export const PITCH = 52;
const MAX_PITCH = 62;
const EXAGGERATION = 1.4;

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Condition tint. Not the source palette and not the difficulty dot's palette: this ramp
 * only ever appears on the map and in the map legend, where condition is the only thing
 * being encoded, so there is nothing for it to collide with.
 */
export const LEVEL_COLOR: Record<string, string> = {
  prime: '#1a7a45',
  mixed: '#d07e00',
  poor: '#b23a2e',
  outlook: '#6b7268',
  pending: '#bdb7a4',
};

/**
 * Outlook days carry a real prime/mixed/poor level, just a coarse regional one, so the
 * map must not flatten them all to one grey. It did, and this map is the page's single
 * strongest image: a settled Monday and a stormy Monday rendered identically, which
 * contradicted the card's own pill.
 *
 * Same hue, muted and desaturated toward the paper, so the level still reads across a
 * whole park while the map stays visibly less certain than a route-specific day. The
 * card and the hero already use exactly this rule.
 */
const OUTLOOK_COLOR: Record<string, string> = {
  prime: '#6f9a80',
  mixed: '#c2a373',
  poor: '#b58a83',
};

export function levelKey(grade: ConditionGrade | null): string {
  if (!grade) return 'pending';
  return grade.confidence === 'outlook' ? 'outlook' : grade.level;
}

/** The drawn colour: full strength inside the horizon, muted on an outlook day. */
export function levelColor(grade: ConditionGrade | null): string {
  if (!grade) return LEVEL_COLOR.pending;
  if (grade.confidence === 'outlook') return OUTLOOK_COLOR[grade.level] ?? LEVEL_COLOR.outlook;
  return LEVEL_COLOR[grade.level] ?? LEVEL_COLOR.pending;
}

/** One drawn trail. `__level` drives the paint; `__id` is what a tap resolves to. */
export function trailFeature(trail: ScopeTrail, grade: ConditionGrade | null): GeoJSON.Feature {
  return {
    type: 'Feature',
    geometry: trail.geometry,
    properties: {
      __id: trail.id,
      __name: trail.name,
      __color: levelColor(grade),
      __level: levelKey(grade),
    },
  };
}

type NumExpr = maplibregl.DataDrivenPropertyValueSpecification<number>;

// ============================================================================
// TREELINE, ROUTE-RELATIVE
// ============================================================================
//
// SHARED BY BOTH SINGLE-TRAIL MAPS. This was written for `trail/mapconcept.ts`'s Concept A
// and lived there; the peek's own map (`phone/peek.ts`) now draws the same mark, and this
// codebase has paid for duplicated logic often enough to say so in its own comments. The
// dependency direction settles where it goes: `src/trail` imports from `src/scope` and never
// the reverse, so the shared home is this module, which is already the map both surfaces
// mount. `mapconcept.ts` keeps one thin wrapper (`crossesTreeline(j)`) because `route.ts`
// imports that name and takes a `Journey`; everything under it is here now, once.
//
// WHAT THIS DELIBERATELY IS NOT: a treeline contour drawn across the landscape. That is the
// obvious reading of "put treeline on the 3D map" and it is not available to us. A contour
// needs the treeline isoline extracted from the DEM across the whole visible basin, and the
// DEM these maps have is a raster terrain source consumed by MapLibre for the terrain mesh,
// not a height field this module can read, sample or march squares over. Drawing a plausible
// one anyway would be the page asserting something it cannot compute, on the one screen
// whose entire argument is that it computes what it shows.
//
// WHAT IT IS INSTEAD, and the more useful question anyway: which part of YOUR WALK is above
// treeline. `grade.ts`'s `terrainFacts.exposedShare` already reduces this to one number, and
// the peek's brief now prints it; what no surface has shown is WHERE. So the route line is
// drawn in two pieces — the sheltered span as the map's normal line, the exposed span with a
// dashed overlay in muted ink. The dash is the shared mark: dashed means treeline on the
// profile chart, on Concept B's chart, and on both of these maps.
//
// TRAVERSAL-INDEPENDENT, on purpose, and it is worth saying why given that both callers have
// a traversal control. A map draws the trail's GEOMETRY once, and a walker who turns around
// covers the same ground twice: the stretch of line that sits above treeline is a fact about
// the hillside, not about the walk. So this reads the stored profile against the region's
// treeline directly, and callers pass the trail itself rather than a mirrored or doubled copy
// of it (`peek.ts`'s `displayProfileTrail` output is for the profile CHART and must not
// arrive here). The MINUTES up there do follow the traversal, and they are the dock's to
// state on the one frame that has a dock.
//
// DEGRADES BY RETURNING NOTHING. The Ozarks' `treelineM` is `NO_TREELINE_M`, a sentinel set
// above any possible route, so no sample is ever above it, no span is emitted, no overlay
// layer is added and no key is drawn by either caller. A region with no treeline shows no
// treeline, rather than a rule at sea level. Nothing here has to know what a sentinel is: the
// comparison does the work.

/** A sub-span of the route in FRACTION of total drawn length, 0..1. Fractions rather than
 *  metres because `routeSamplePoints` places the profile's samples at `k/(n-1)` of the
 *  summed part lengths, and re-deriving that total here from the same parts keeps the two
 *  from ever disagreeing about how long the trail is. */
interface Span {
  from: number;
  to: number;
}

/**
 * The trail's coordinate rings. Exported because `trail/mapconcept.ts` needs the same three
 * lines to project the route to screen for its card placement, and a second copy there was
 * one of the things this extraction removed. Not imported from
 * `scope/weather/provider.ts`'s `partsOf`, which does the same job: that copy is
 * module-private and that file is a different owner's.
 *
 * Kept as a list of rings rather than flattened into one array because a MultiLineString's
 * parts are genuinely disjoint (MERGE_PLAN's Longs Peak case: a real 2 km gap), and neither
 * a slice nor a tangent may be taken across that seam.
 */
export function geometryParts(g: GeoJSON.LineString | GeoJSON.MultiLineString): number[][][] {
  return g.type === 'LineString' ? [g.coordinates] : g.coordinates;
}

/**
 * The profile's above-treeline runs, with the crossings linearly interpolated between the
 * two samples that straddle them — the same interpolation `trail/journey.ts` uses to place
 * its `treeline-up` / `treeline-down` markers, so the dashed span starts and ends exactly
 * where those markers sit rather than at the nearest whole sample.
 */
function exposedSpans(profile: number[] | null, treelineM: number): Span[] {
  const prof = profile && profile.length > 1 ? profile : null;
  if (!prof) return [];
  const n = prof.length;
  const at = (i: number): number => i / (n - 1);
  const spans: Span[] = [];
  let open: number | null = prof[0] > treelineM ? 0 : null;

  for (let i = 1; i < n; i++) {
    const wasAbove = prof[i - 1] > treelineM;
    const isAbove = prof[i] > treelineM;
    if (wasAbove === isAbove) continue;
    // Where between sample i-1 and i the crossing falls. The denominator cannot be zero:
    // one endpoint is strictly above the treeline and the other is not.
    const t = (treelineM - prof[i - 1]) / (prof[i] - prof[i - 1]);
    const cross = at(i - 1) + t * (at(i) - at(i - 1));
    if (isAbove) open = cross;
    else if (open !== null) {
      spans.push({ from: open, to: cross });
      open = null;
    }
  }
  if (open !== null) spans.push({ from: open, to: 1 });
  return spans;
}

/**
 * Cut the REAL geometry to a fraction range, at full resolution.
 *
 * Full resolution and not the 48-sample profile polyline, which is the tempting shortcut:
 * 48 points over 6.5 km is a sample every 135 m, and a decimated line laid over a drawn one
 * cuts every switchback corner, so the dashes would visibly leave the route exactly where a
 * route is most interesting. The distance model is `routeSamplePoints`': cumulative distance
 * runs WITHIN a part and the offset between parts is the sum of prior real part lengths, so
 * a span covering a MERGE_PLAN-style 2 km gap comes back as two pieces and never bridges it.
 */
function sliceParts(parts: number[][][], cums: number[][], total: number, span: Span): number[][][] {
  const d0 = span.from * total;
  const d1 = span.to * total;
  const out: number[][][] = [];
  let offset = 0;

  for (let p = 0; p < parts.length; p++) {
    const coords = parts[p];
    const cum = cums[p];
    const len = cum[cum.length - 1];
    const lo = Math.max(d0, offset);
    const hi = Math.min(d1, offset + len);
    offset += len;
    if (hi - lo < 0.5) continue;

    // Interpolated endpoints, whole vertices in between, so the piece starts and ends on
    // the crossing rather than on the nearest node.
    const pointAt = (withinM: number): number[] => {
      let seg = 0;
      while (seg < cum.length - 2 && cum[seg + 1] < withinM) seg++;
      const a = coords[seg];
      const b = coords[seg + 1];
      const width = cum[seg + 1] - cum[seg];
      const t = width > 0 ? (withinM - cum[seg]) / width : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };

    const fromWithin = lo - (offset - len);
    const toWithin = hi - (offset - len);
    const piece: number[][] = [pointAt(fromWithin)];
    for (let i = 0; i < coords.length; i++) {
      if (cum[i] > fromWithin && cum[i] < toWithin) piece.push(coords[i]);
    }
    piece.push(pointAt(toWithin));
    if (piece.length >= 2) out.push(piece);
  }
  return out;
}

/**
 * The exposed overlay as one MultiLineString feature, or `null` when there is nothing above
 * treeline on this route (no treeline in the region, or a walk that never leaves the trees).
 *
 * `treelineM` is a parameter rather than read off a region here, because the two callers hold
 * their region in two different shapes (`Journey.region`, `Ctx.region`) and one number is the
 * whole of what this needs.
 */
export function treelineExposedFeature(trail: ScopeTrail, treelineM: number): GeoJSON.Feature | null {
  const spans = exposedSpans(trail.profile, treelineM);
  if (spans.length === 0) return null;

  const parts = geometryParts(trail.geometry).filter((c) => c.length >= 2);
  if (parts.length === 0) return null;
  const cums = parts.map((coords) => {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineMeters(coords[i - 1], coords[i]));
    return cum;
  });
  const total = cums.reduce((sum, c) => sum + c[c.length - 1], 0);
  if (total <= 0) return null;

  const pieces = spans.flatMap((s) => sliceParts(parts, cums, total, s));
  if (pieces.length === 0) return null;
  return {
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: pieces },
    properties: {},
  };
}

/** True where a frame should print a treeline key for this route. The same test
 *  `treelineExposedFeature` makes before emitting anything, so a caller can never print a key
 *  for a mark that is not on screen — an unexplained dash is worse than no dash, and a key
 *  for a dash that is not there is worse than both. */
export function crossesTreeline(trail: ScopeTrail, treelineM: number): boolean {
  return exposedSpans(trail.profile, treelineM).length > 0;
}

/** The dashed overlay's own source and layer. Added on demand by `setExposedOverlay` rather
 *  than in `setupLayers`, so the results map — which colours a whole trail by one grade and
 *  has no notion of a sub-span — never carries a layer it would never draw into. */
const EXPOSED_SOURCE = 'ph-exposed';
const EXPOSED_LAYER = 'ph-exposed-line';

/** The muted ink Concept A has drawn this in since it was written, carried across verbatim so
 *  that frame does not move. It is one shade off the `--muted` token the two SVG treeline
 *  rules use (`#5c6a60`, tokens.css); reconciling them is cosmetic and is not worth changing
 *  a rendered frame for on its own. A literal because MapLibre paint takes real colour
 *  values, not custom properties resolved through a stylesheet. */
const EXPOSED_INK = '#4a564e';

/**
 * Default dash width, sized against this class's own `CORE_WIDTH` at the same ratio Concept A
 * chose against its heavier one (roughly half). Narrower than the core it sits on either way,
 * so the condition tint still reads between the dashes: this marks a stretch of the route, it
 * does not replace what that stretch is saying about conditions. A caller that has overridden
 * its line weight (`setLineWeight`) passes its own.
 */
const EXPOSED_WIDTH = ['interpolate', ['linear'], ['zoom'], 9, 0.9, 15, 2.2] as unknown as NumExpr;

const HALO_WIDTH = ['interpolate', ['linear'], ['zoom'], 9, 3.5, 15, 8] as unknown as NumExpr;
const CORE_WIDTH = ['interpolate', ['linear'], ['zoom'], 9, 1.8, 15, 4.5] as unknown as NumExpr;

/**
 * Width for the core line, thickened for the selected trail.
 *
 * MapLibre allows `zoom` ONLY as the direct input of a top-level `step` or `interpolate`,
 * so the obvious shape, a `case` choosing between a constant and CORE_WIDTH, is invalid
 * and threw on every selection. The fix is to invert the nesting: `interpolate` stays on
 * the outside with `zoom` as its input, and each stop output is the data-driven `case`.
 */
function coreWidthFor(id: string | null): NumExpr {
  if (id == null) return CORE_WIDTH;
  const pick = (sel: number, rest: number): unknown => [
    'case',
    ['==', ['get', '__id'], id],
    sel,
    rest,
  ];
  return ['interpolate', ['linear'], ['zoom'], 9, pick(4.5, 1.8), 15, pick(9, 4.5)] as unknown as NumExpr;
}

export interface PhoneMapOpts {
  bbox: [number, number, number, number];
  onPick: (trailId: string | null) => void;
}

/** One DEM source spec. Called twice; see the twin-source note above. */
function rasterDemSource(): maplibregl.RasterDEMSourceSpecification {
  return {
    type: 'raster-dem',
    tiles: TERRARIUM_TILES,
    encoding: 'terrarium',
    tileSize: 256,
    // Same ceiling as the map explorer. The phone never frames tighter than a single
    // trail, so nothing here needs a deeper DEM than that map already loads, and a higher
    // maxzoom would multiply tile requests inside a section of a scrolling page.
    maxzoom: 15,
    attribution: TERRARIUM_ATTRIB,
  };
}

export class PhoneMap {
  readonly map: maplibregl.Map;
  private loaded = false;
  private readyCbs: (() => void)[] = [];
  private pendingFeatures: GeoJSON.Feature[] | null = null;
  private selected: string | null = null;
  /** Live pitch. Drops to 0 permanently if the DEM turns out to be unreachable. */
  private pitch = PITCH;
  private demErrors = 0;

  constructor(container: HTMLElement, opts: PhoneMapOpts) {
    const [w, s, e, n] = opts.bbox;
    this.map = new maplibregl.Map({
      container,
      // Wheel zoom is on by request (feedback round 2). The tradeoff is real: a wheel
      // over the map zooms instead of scrolling the page, but the map only occupies the
      // phone frame and a reader pointing at a map expects map behaviour there.
      scrollZoom: true,
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: true,
      pitch: PITCH,
      maxPitch: MAX_PITCH,
      style: {
        version: 8,
        sources: {
          [TOPO_SOURCE]: {
            type: 'raster',
            tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 16,
            attribution: 'USGS The National Map · © OpenStreetMap contributors (ODbL)',
          },
          [DEM_TERRAIN_SOURCE]: rasterDemSource(),
          [DEM_HILLSHADE_SOURCE]: rasterDemSource(),
        },
        layers: [
          { id: TOPO_LAYER, type: 'raster', source: TOPO_SOURCE, paint: { 'raster-opacity': 0.82 } },
          {
            id: HILLSHADE_LAYER,
            type: 'hillshade',
            source: DEM_HILLSHADE_SOURCE,
            paint: {
              // The explorer's colours. Its exaggeration is 0.35 against a full-desktop
              // map; this frame is a fifth of that size and shows a whole region, so the
              // relief needs a little more weight to survive the scale, and the shadow is
              // pulled off pure ink so a valley trail stays green rather than going black.
              'hillshade-exaggeration': 0.45,
              'hillshade-shadow-color': '#26382f',
              'hillshade-accent-color': '#26382f',
              'hillshade-highlight-color': '#f6f2e7',
            },
          },
        ],
        sky: {
          // Explorer palette, two deliberate departures. `fog-ground-blend` 0.92 (it uses
          // 0.4) keeps the haze at the horizon instead of over the ground: at 0.4 the far
          // third of a region washes toward grey and amber becomes indistinguishable from
          // red. `atmosphere-blend` is down for the same reason. What the sky is for here
          // is a horizon that tells the reader the map is tilted, and nothing else.
          'sky-color': '#9dc3f0',
          'horizon-color': '#dfeaf0',
          'fog-color': '#e2e9e4',
          'sky-horizon-blend': 0.6,
          'horizon-fog-blend': 0.5,
          'fog-ground-blend': 0.92,
          'atmosphere-blend': 0.4,
        },
      },
      bounds: [
        [w, s],
        [e, n],
      ],
      fitBoundsOptions: { padding: 24, pitch: PITCH },
      attributionControl: false,
    });

    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    (window as unknown as Record<string, unknown>).__pmap = this.map; // TEMP DEBUG

    // Terrain must never be the reason the page shows a blank rectangle. The DEM is a
    // third-party bucket on the open internet: if it goes away, this map still has trails
    // to draw and still has an argument to make, so it drops back to a flat topo map.
    this.map.on('error', (ev) => {
      const sourceId = (ev as unknown as { sourceId?: string }).sourceId;
      if (sourceId !== DEM_TERRAIN_SOURCE && sourceId !== DEM_HILLSHADE_SOURCE) return;
      // One 404 is a tile past the DEM's coverage, not an outage. A run of them is.
      if (++this.demErrors === 4) this.dropTerrain();
    });

    this.map.on('load', () => {
      this.applyTerrain();
      this.setupLayers();
      this.wire(opts.onPick);
      this.loaded = true;
      if (this.pendingFeatures) {
        this.setTrails(this.pendingFeatures);
        this.pendingFeatures = null;
      }
      for (const cb of this.readyCbs) cb();
      this.readyCbs = [];
    });
  }

  private applyTerrain(): void {
    try {
      this.map.setTerrain({ source: DEM_TERRAIN_SOURCE, exaggeration: EXAGGERATION });
    } catch {
      this.dropTerrain();
    }
  }

  /** Terrain is unavailable: flatten the camera and hide the relief, keep the trails. */
  private dropTerrain(): void {
    if (this.pitch === 0) return;
    this.pitch = 0;
    try {
      this.map.setTerrain(null);
      if (this.map.getLayer(HILLSHADE_LAYER)) {
        this.map.setLayoutProperty(HILLSHADE_LAYER, 'visibility', 'none');
      }
      this.map.easeTo({ pitch: 0, duration: 300 });
    } catch {
      /* the map is already gone (destroyed mid-flight); nothing to fall back to */
    }
  }

  whenReady(cb: () => void): void {
    if (this.loaded) cb();
    else this.readyCbs.push(cb);
  }

  private setupLayers(): void {
    const m = this.map;
    m.addSource(TRAIL_SOURCE, { type: 'geojson', data: EMPTY_FC });

    // White underlay so the condition tint survives the topo raster.
    m.addLayer({
      id: TRAIL_HALO,
      type: 'line',
      source: TRAIL_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': HALO_WIDTH,
        'line-opacity': 0.9,
      },
    });
    m.addLayer({
      id: TRAIL_CORE,
      type: 'line',
      source: TRAIL_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', '__color'], LEVEL_COLOR.pending],
        'line-width': CORE_WIDTH,
        'line-opacity': 1,
      },
    });

    // Trailhead dots: a 900 m trail is a few pixels at region zoom, and without these the
    // map of a whole national park reads as almost empty.
    m.addSource(HEAD_SOURCE, { type: 'geojson', data: EMPTY_FC });
    m.addLayer({
      id: HEAD_LAYER,
      type: 'circle',
      source: HEAD_SOURCE,
      paint: {
        'circle-radius': ['case', ['boolean', ['get', 'sel'], false], 7, 4.2],
        'circle-color': ['get', 'color'],
        'circle-stroke-width': ['case', ['boolean', ['get', 'sel'], false], 2.5, 1.4],
        'circle-stroke-color': '#ffffff',
      },
    });
  }

  private wire(onPick: (id: string | null) => void): void {
    const m = this.map;
    const layers = [TRAIL_CORE, HEAD_LAYER];
    for (const layer of layers) {
      m.on('mouseenter', layer, () => {
        m.getCanvas().style.cursor = 'pointer';
      });
      m.on('mouseleave', layer, () => {
        m.getCanvas().style.cursor = '';
      });
    }
    m.on('click', (ev) => {
      // A 4 px query box: a hairline trail on a phone is hard to hit exactly.
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [ev.point.x - 6, ev.point.y - 6],
        [ev.point.x + 6, ev.point.y + 6],
      ];
      const hits = m.queryRenderedFeatures(box, { layers });
      const id = hits[0]?.properties?.__id ?? hits[0]?.properties?.id;
      onPick(typeof id === 'string' ? id : null);
    });
  }

  setTrails(features: GeoJSON.Feature[]): void {
    if (!this.loaded) {
      this.pendingFeatures = features;
      return;
    }
    const src = this.map.getSource(TRAIL_SOURCE) as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features });

    const heads = this.map.getSource(HEAD_SOURCE) as maplibregl.GeoJSONSource | undefined;
    heads?.setData({
      type: 'FeatureCollection',
      features: features.map((f) => {
        const props = (f.properties ?? {}) as Record<string, unknown>;
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: firstCoord(f.geometry) },
          properties: {
            id: props.__id,
            color: props.__color,
            sel: props.__id === this.selected,
          },
        };
      }),
    });
  }

  /** Emphasise one trail. Paint expressions only, so selection never re-uploads data. */
  setSelected(id: string | null): void {
    this.selected = id;
    this.whenReady(() => {
      const m = this.map;
      const isSel = (a: unknown, b: unknown): NumExpr =>
        ['case', ['==', ['get', '__id'], id ?? NO_SELECTION], a, b] as unknown as NumExpr;
      m.setPaintProperty(TRAIL_CORE, 'line-width', coreWidthFor(id));
      m.setPaintProperty(TRAIL_CORE, 'line-opacity', id == null ? 1 : isSel(1, 0.45));
      m.setPaintProperty(TRAIL_HALO, 'line-opacity', id == null ? 0.9 : isSel(1, 0.35));
      const heads = m.getSource(HEAD_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (heads) {
        m.setPaintProperty(HEAD_LAYER, 'circle-radius', ['case', ['==', ['get', 'id'], id ?? NO_SELECTION], 7.5, 4.2] as unknown as NumExpr);
      }
    });
  }

  /**
   * Frame a trail, or the whole region when given its bbox.
   *
   * Fitting a box at pitch is not fitting it flat. MapLibre computes the camera as if the
   * map were flat and then tilts, which leaves the box sitting low and slightly too big:
   * ground below the screen centre is nearer the camera and gets magnified, ground above
   * it recedes. The correction is one lever, not two: extra BOTTOM padding both lifts the
   * box up the frame (the centre moves toward the top when the bottom is padded) and takes
   * the edge off the zoom, which is exactly the pair of things the tilt costs. Nothing here
   * is applied when terrain has been dropped, since then the fit really is flat.
   *
   * `extraBottom` is ADDITIVE on top of `padding`, defaulted to 0 so the results map and
   * the peek map — neither of which ever passes it — fit exactly as before. It exists for
   * `trail/mapconcept.ts`'s docked detail strip: that strip covers a fixed band at the
   * bottom of the frame, and without telling the fit about it the tight trail frame can
   * seat the route right where the dock will sit on top of it. Passing the dock's own
   * height here is what keeps the two from ever overlapping, rather than hoping the trail's
   * bbox happens to leave enough room on its own.
   */
  fitBBox(bbox: [number, number, number, number], padding = 28, extraBottom = 0): void {
    this.whenReady(() => {
      this.map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        {
          padding: this.framePadding(padding, extraBottom),
          pitch: this.pitch,
          duration: 500,
          maxZoom: 15,
        },
      );
    });
  }

  private framePadding(base: number, extraBottom = 0): maplibregl.PaddingOptions {
    if (this.pitch === 0) return { top: base, right: base, bottom: base + extraBottom, left: base };
    const height = this.map.getContainer().clientHeight || 480;
    return {
      top: base,
      right: base,
      bottom: base + extraBottom + Math.round(height * 0.0),
      left: base,
    };
  }

  /**
   * Overrides this instance's own trail line width and casing. Additive and scoped to the
   * ONE `PhoneMap` it is called on: each caller constructs its own `maplibregl.Map` with
   * its own copy of the `ph-trails-core`/`ph-trails-halo` layers (see the class-level
   * comment), so calling this from `trail/mapconcept.ts` cannot move a pixel on the
   * results map or the peek map, which never call it and keep `HALO_WIDTH`/`CORE_WIDTH`
   * exactly as constructed. It exists because Concept A draws a SINGLE journey and has to
   * hold up as the dominant mark on a 366 px frame over hillshaded terrain — a heavier ask
   * than the results map's many-trails-at-once styling — without moving that shared
   * default for the two callers that do not need it.
   */
  setLineWeight(
    coreWidth: maplibregl.DataDrivenPropertyValueSpecification<number>,
    haloWidth: maplibregl.DataDrivenPropertyValueSpecification<number>,
  ): void {
    this.whenReady(() => {
      this.map.setPaintProperty(TRAIL_CORE, 'line-width', coreWidth);
      this.map.setPaintProperty(TRAIL_HALO, 'line-width', haloWidth);
    });
  }

  /**
   * Draw, update or remove this instance's above-treeline dash overlay.
   *
   * ADDED ON TOP OF THE TRAIL LAYERS, never in `setupLayers`, which is what keeps it scoped
   * to the callers that ask for it: `addLayer` with no `beforeId` appends, so the dashes sit
   * over the coloured core rather than under it, and a caller that never calls this (the
   * results map) has no such source or layer in its style at all. Same additive, per-instance
   * discipline as `setLineWeight` above.
   *
   * IDEMPOTENT, so a caller may hand it a feature on every render without checking whether it
   * already did. An existing overlay has its data replaced; `null` removes the layer and the
   * source outright rather than leaving an empty one behind, which is what makes switching to
   * a route that never leaves the trees — or to a region with no treeline at all — clean on a
   * map instance that is reused. Both current callers happen to mount one map per trail, so
   * neither exercises the removal path today; it is here because the alternative is a stale
   * dash surviving a trail change, and that is a bug nobody would look for on a map.
   */
  setExposedOverlay(feature: GeoJSON.Feature | null, width: NumExpr = EXPOSED_WIDTH): void {
    this.whenReady(() => {
      const m = this.map;
      const src = m.getSource(EXPOSED_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (!feature) {
        if (m.getLayer(EXPOSED_LAYER)) m.removeLayer(EXPOSED_LAYER);
        if (src) m.removeSource(EXPOSED_SOURCE);
        return;
      }
      if (src) {
        src.setData(feature);
        return;
      }
      m.addSource(EXPOSED_SOURCE, { type: 'geojson', data: feature });
      m.addLayer({
        id: EXPOSED_LAYER,
        type: 'line',
        source: EXPOSED_SOURCE,
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': EXPOSED_INK,
          'line-width': width,
          // In line-widths, not pixels, so the dash keeps its proportions as the line thickens
          // with zoom. Roughly square at both ends of the zoom range.
          'line-dasharray': [1.3, 1.1],
        },
      });
    });
  }

  /**
   * Tight-frames `bbox` once the map has genuinely settled, rather than on the very next
   * tick. Two call sites need this and neither is a plain `fitBBox` caller: the results
   * map (`app.ts`) constructs on its REGION's bbox and only ever tight-frames a trail well
   * after that initial view has had time to paint, so `fitBBox`'s own `whenReady`
   * (load-gated, not idle-gated) is enough there. `trail/mapconcept.ts` and
   * `scope/phone/peek.ts`'s own map both want the tight trail frame as the FIRST thing the
   * reader sees, and jumping straight there — pitched and terrain-exaggerated — before the
   * DEM has painted anything at a coarser zoom renders a genuinely blank canvas: verified
   * empirically (Playwright, reading the canvas's own pixels, not just its reported state)
   * on trails with a lot of relief and on ones with almost none (Bear Lake Trail, 25 m of
   * gain, did it too), which is what pins this down as a camera/terrain-mesh problem and
   * not a slow-tile one. The fix has two halves, and both are the caller's job except the
   * second: the caller constructs on the REGION's bbox (seeding the DEM pyramid at a sane
   * zoom, exactly as this class's own single-mount callers already do), and this method
   * waits for one real `idle` — every tile that low-zoom camera needed actually rendered —
   * before jumping to the tight frame. `load` fires once the style is parsed, not once a
   * frame has actually painted, which is why `whenReady` alone was never enough for this.
   *
   * RACED AGAINST A TIMEOUT, not awaited unconditionally: when the DEM is unreachable
   * (`dropTerrain`'s fallback, above) the failed tile requests can keep the source busy
   * retrying, so `idle` may never fire at all. A flat map has no terrain mesh to render
   * blank in the first place, so once the fallback has had a moment to trip (its own
   * 4-error threshold), tight-framing the trail anyway is safe even without a clean idle
   * to wait for.
   *
   * Second call site, not the first: `peek.ts`'s own map had this inline before it moved
   * here. A third copy is exactly the pattern nobody would have remembered to keep in
   * sync, so it lives once, in the class both callers already reuse wholesale.
   */
  fitBBoxWhenSettled(bbox: [number, number, number, number], padding = 28, timeoutMs = 2500, extraBottom = 0): void {
    this.whenReady(() => {
      let fitted = false;
      const doFit = (): void => {
        if (fitted) return;
        fitted = true;
        this.fitBBox(bbox, padding, extraBottom);
      };
      this.map.once('idle', doFit);
      setTimeout(doFit, timeoutMs);
    });
  }

  resize(): void {
    this.map.resize();
  }

  zoomIn(): void {
    this.map.zoomIn({ duration: 220 });
  }

  zoomOut(): void {
    this.map.zoomOut({ duration: 220 });
  }

  destroy(): void {
    this.map.remove();
  }
}

function firstCoord(g: GeoJSON.Geometry): [number, number] {
  if (g.type === 'LineString') return [g.coordinates[0][0], g.coordinates[0][1]];
  if (g.type === 'MultiLineString') return [g.coordinates[0][0][0], g.coordinates[0][0][1]];
  return [0, 0];
}
