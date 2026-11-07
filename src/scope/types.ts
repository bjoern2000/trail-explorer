// Trail Scope (product prototype) — frozen shared contracts.
//
// SCOPE_PLAN.md is the authority for behaviour; this file is the authority for shape.
// Everything under src/scope/ and scope/derive.mjs codes against it. Frozen once the
// build starts: widening a type here means updating SCOPE_PLAN.md in the same change.
//
// UNITS: everything is SI at rest (metres, °C, mm, km/h, minutes). The UI converts at
// the last moment via model.ts formatters, so the imperial/metric toggle never touches
// stored data or the grader.

// ============================================================================
// REGIONS
// ============================================================================

export type RegionId = 'rmnp' | 'adk' | 'ozarks';

export interface RegionDef {
  id: RegionId;
  /** Display name, as a user would search for it. */
  name: string;
  /** Where this is, in words a reader can place on a map. */
  where: string;
  /** [w, s, e, n] in EPSG:4326 — identical to the benchmark/merge bboxes. */
  bbox: [number, number, number, number];
  /** The map location the prototype treats as the user's current position. */
  assumedLocation: [number, number];
  /** How that location is labelled in the UI ("Estes Park, Colorado"). */
  assumedLocationLabel: string;
  /**
   * Local treeline in metres. Drives the exposure term in grading, so it is a real
   * input, not decoration. Sourced per region and cited in the page prose.
   */
  treelineM: number;
  /** Land manager, for prose only — deliberately NOT a filter (SCOPE_PLAN §2). */
  manager: string;
}

// ============================================================================
// DERIVED TRAIL DATA  (produced by scope/derive.mjs, committed as JSON)
// ============================================================================

export type RouteType = 'loop' | 'point-to-point';
export type Difficulty = 'easy' | 'moderate' | 'hard';
export type Activity = 'hike' | 'run' | 'bike';

/**
 * One discoverable trail: a merged name-cluster of OSM ways plus everything derived
 * from its geometry. This is the unit a card, a list row and a map line all represent.
 */
export interface ScopeTrail {
  /** Region-scoped slug, stable across derive runs: `<region>/<normalized-name>`. */
  id: string;
  name: string;
  region: RegionId;

  // ---- geometry -------------------------------------------------------------
  geometry: GeoJSON.LineString | GeoJSON.MultiLineString;
  /** Number of disconnected parts after merging. >1 is normal; see MERGE_PLAN §6. */
  parts: number;
  /** Trailhead: first coordinate of the longest part. */
  start: [number, number];
  bbox: [number, number, number, number];
  centroid: [number, number];

  // ---- measures (SI) --------------------------------------------------------
  lengthM: number;
  /**
   * Positive ascent walking the trail in its stored direction.
   *
   * IMPORTANT: geometry is oriented low-end-first before measuring, because OSM way
   * direction is arbitrary and a naive walk mis-bins flagship trails badly (North Inlet
   * descends monotonically as stored, so it measured 3 m of gain over 18 km and binned
   * "easy"). The assumption is that a hiker starts at the low end and climbs, which is
   * right for mountain trails and wrong for canyon descents. Stated on the page.
   */
  gainM: number;
  /** Positive descent in the same orientation. The peek sheet shows both, as AllTrails does. */
  descentM: number;
  minElevM: number;
  maxElevM: number;
  /** Steepest sustained grade over the profile, percent. Feeds difficulty and heat. */
  maxGradePct: number;
  /**
   * Downsampled elevation series in metres, for the card sparkline. Fixed length
   * (PROFILE_POINTS) so every card renders at the same cost.
   */
  profile: number[];
  /**
   * Indices into `profile` that begin a new disconnected part. A multi-part trail has a
   * real discontinuity at each seam, and drawing straight through it invents a cliff
   * that is not there. The sparkline breaks the line at these indices instead.
   */
  seamIndices: number[];

  // ---- derived --------------------------------------------------------------
  routeType: RouteType;
  difficulty: Difficulty;
  /** NPS/Shenandoah rating: sqrt(gain_ft × 2 × length_mi). Shown as "computed". */
  difficultyScore: number;
  /** Naismith-style estimate in minutes. */
  estMinutes: number;

  // ---- context --------------------------------------------------------------
  /** Dominant OSM `surface` tag across member ways, or null when untagged. */
  surface: string | null;
  /**
   * True when this looks like a subdivision street rather than a trail: `highway=track`
   * with a road-style name suffix and no trail-ish tagging.
   *
   * These are NOT dropped from the derived data, because silently filtering would hide
   * the finding. In Lake of the Ozarks 49 percent of named path/footway/track features
   * are resort-subdivision streets (Lavender Lane, Hogan Circle), against 1 percent in
   * the Adirondacks and 0 in RMNP. The UI excludes them from the default list and
   * discloses the count. Consequence for a national build: the highway filter alone is
   * not enough, a classifier is needed, and the failure is concentrated in resort
   * terrain rather than tracking remoteness.
   */
  likelyRoad: boolean;
  /** From OSM access tags; defaults to ['hike','run'] when untagged (and says so). */
  activities: Activity[];
  /**
   * Weak stand-in for the popularity signal open data does not have: named ways,
   * trailhead proximity, route-relation membership, length. 0..1. The page is explicit
   * that this is a proxy, not popularity (SCOPE_PLAN §6).
   */
  prominence: number;
  osmWayIds: number[];

  // ---- sun exposure: two questions, two fields, never merged -----------------
  //
  // `terrainFacts.shadedShare` is `1 - exposedShare` — "below treeline means trees" — and
  // the code that computes it has always called itself a proxy. These fields replace the
  // guess with two separate measurements, because there are two separate questions and one
  // number cannot answer both: a north-facing meadow is shaded with no canopy, and a
  // south-facing forest is canopied with very little sun relief.
  //
  // Produced by scope/canopy.mjs. Absent from snapshots derived before it existed, so
  // src/scope/data.ts reconciles them on load exactly as it does for `descentM`.

  /**
   * Per-sample canopy flag, 1 where the sample sits inside an OSM `landuse=forest` or
   * `natural=wood` polygon. Length PROFILE_POINTS, index-aligned with `profile`: sample i
   * of this array, sample i of `profile` and `routeSamplePoints(trail, PROFILE_POINTS)[i]`
   * are the same place on the ground, so a journey can say "into the trees here" and mean
   * the metre the elevation chart means.
   */
  canopy: number[];
  /**
   * Share of samples under canopy, 0..1. The mean of `canopy`, and checked to be.
   *
   * READ THIS AGAINST `RegionData.canopy.mappedShare`, ALWAYS. It measures OSM's mapping
   * effort as much as it measures vegetation. Lake of the Ozarks comes back at 2 percent
   * with 95 percent of trails carrying no trees at all, on ground that is demonstrably
   * wooded — Turkey Pen Hollow Trail, Woodland Trail and the Upland Flatwoods Section all
   * read zero — because only 9 percent of that bbox has a forest polygon drawn over it at
   * all. A zero here means "no polygon", and only sometimes "no trees".
   */
  canopyShare: number;
  /**
   * Per-sample terrain aspect: the compass bearing of steepest DESCENT in degrees
   * clockwise from north, or -1 where the ground is flatter than the DEM can resolve a
   * direction for. Length PROFILE_POINTS, same alignment as `canopy`.
   *
   * SELF-SHADING ONLY. Aspect against sun azimuth says whether the slope a walker stands
   * on faces away from the sun. It says nothing about CAST SHADOWS from neighbouring
   * terrain: a valley floor in the shadow of a 4,000 m ridge reads as fully sunlit here,
   * because its own ground is flat and pointed at the sky. Copy built on this field must
   * say "self-shading". See src/scope/weather/shading.ts.
   */
  aspectDeg: number[];
  /** Per-sample terrain slope in degrees, from the same Horn 3x3 window as `aspectDeg`. */
  slopeDeg: number[];
  /**
   * Circular mean of `aspectDeg` over the samples that have one, or -1. A vector mean, not
   * an arithmetic one: averaging 350 and 10 arithmetically gives 180, which would report a
   * north-facing trail as south-facing.
   */
  meanAspectDeg: number;
  /** Mean of `slopeDeg`. The terrain the trail crosses, not the trail's own gradient. */
  meanSlopeDeg: number;
}

/** Fixed sparkline resolution. Derive and UI must agree. */
export const PROFILE_POINTS = 48;

/** One region's committed derived payload. */
export interface RegionData {
  region: RegionId;
  /** Verbatim Overpass QL that produced it, shown on the page. */
  query: string;
  bbox: [number, number, number, number];
  fetchedAt: string;
  /** Named ways returned before merging — the "what came back" number. */
  wayCount: number;
  /** Distinct name-clusters after merging — the "trails" number. */
  trailCount: number;
  /** Elevation source, for the attribution line. */
  elevationSource: string;
  /**
   * Provenance for the canopy fields, and the one number that qualifies them.
   * Absent on snapshots predating scope/canopy.mjs; src/scope/data.ts normalises.
   */
  canopy: {
    fetchedAt: string;
    /** ODbL attribution for the polygons, distinct from `elevationSource`. */
    source: string;
    /** Verbatim Overpass QL for the wooded polygons. */
    query: string;
    polygonCount: number;
    /**
     * Share of the region bbox that OSM has drawn a wooded polygon over, 0..1, measured on
     * a uniform `mappedGrid` x `mappedGrid` lattice of probes.
     *
     * The honesty number for the whole feature. RMNP 53 percent and the Adirondacks 56
     * percent are regions where a per-trail zero is informative; Lake of the Ozarks at 9
     * percent is a region where it is not. Any copy quoting `canopyShare` has to be able
     * to quote this beside it.
     */
    mappedShare: number;
    mappedGrid: number;
  } | null;
  /** How `aspectDeg` was computed, for the attribution line. Null on old snapshots. */
  aspectSource: string | null;
  trails: ScopeTrail[];
}

// ============================================================================
// WEATHER  (the Super Resolution seam — see src/scope/weather/provider.ts)
// ============================================================================

/** One point, one hour. SI throughout. */
export interface WeatherSample {
  /** Hours from the provider's `now`. 0 = the current hour. */
  hour: number;
  tempC: number;
  /** Precipitation in that hour, mm. */
  precipMm: number;
  /** 0..1. */
  precipProb: number;
  /** 0..1. Convection, which is what makes exposure dangerous. */
  thunderProb: number;
  windKph: number;
  gustKph: number;
  /** 0..1. Drives the shade/heat term. */
  cloudPct: number;
}

/** A point on a route, with the elevation the forecast should be evaluated at. */
export interface RoutePoint {
  lngLat: [number, number];
  elevM: number;
  /** Distance along the route in metres, so grading can talk about *where*. */
  alongM: number;
}

export interface WeatherQuery {
  points: RoutePoint[];
  /** Hours from now to cover, inclusive of 0. */
  hours: number;
}

export interface WeatherResult {
  /** One series per requested point, same order. */
  series: WeatherSample[][];
  /** Total precipitation over the prior 72 h per point, mm. Drives wetness. */
  antecedentPrecipMm: number[];
  /** Local sunrise/sunset in hours-from-now, for the daylight term. */
  daylight: { sunriseHour: number; sunsetHour: number }[];
}

/**
 * The one seam between the prototype and real forecast data.
 *
 * `SimulatedProvider` implements this from scenarios; a `SuperResProvider` will
 * implement it from TWC Super Resolution. Nothing downstream of this interface knows
 * which it is talking to, and the UI reads `horizonHours` rather than hard-coding 36.
 */
export interface WeatherProvider {
  id: string;
  /** Shown in the fidelity chip: "simulated" vs "Super Resolution". */
  label: string;
  /** How far ahead route-specific hourly data exists. Super Resolution: 36. */
  horizonHours: number;
  /** Nominal grid resolution in metres, for the honesty line on the page. */
  resolutionM: number;
  /** Provider-relative wall clock, so the whole page shares one "now". */
  now(): { dayIndex: number; hourOfDay: number };
  fetch(query: WeatherQuery): Promise<WeatherResult>;
}

// ============================================================================
// CONDITIONS GRADE
// ============================================================================

export type GradeLevel = 'prime' | 'mixed' | 'poor';

/**
 * Route-specific inside the provider's horizon; a coarse outlook past it. The UI shows
 * these two states differently on purpose (SCOPE_PLAN §4).
 */
export type GradeConfidence = 'route-specific' | 'outlook';

export type FactorKind = 'wetness' | 'storm' | 'exposure' | 'heat' | 'wind' | 'daylight';

export interface ConditionFactor {
  kind: FactorKind;
  /** How much this pushed the grade down. 0 = no penalty. */
  penalty: number;
  /** One clause, lower case, no trailing period: "wet underfoot from Tuesday rain". */
  text: string;
  /** Hour-from-now this factor starts to bite, when it is time-bound. */
  fromHour?: number;
}

export interface ConditionGrade {
  level: GradeLevel;
  confidence: GradeConfidence;
  /** Card pill text. Short: "clear until 15:00". */
  headline: string;
  /** Ordered worst first; the headline is built from the top one or two. */
  factors: ConditionFactor[];
  /** Best contiguous window today, hours from now, or null when there is none. */
  bestWindow: { startHour: number; endHour: number } | null;
  /** Ranking key for the Best-today sort. Internal; never shown as a number. */
  score: number;
}

// ============================================================================
// SCENARIOS  (simulated weather only — replaced wholesale by Super Resolution)
// ============================================================================

export type ScenarioId = 'bluebird' | 'storms' | 'post-rain' | 'heat';

export interface ScenarioDef {
  id: ScenarioId;
  label: string;
  /** One line for the doc chrome: what the reader should watch happen. */
  blurb: string;
}

// ============================================================================
// USER-GENERATED CONTENT
// ============================================================================
//
// The benchmark established that open data has no ratings, no photos and no reviews,
// and §6's finding is that this leaves no honest popularity sort. UGC is the answer to
// that: it is how a product EARNS the crowd signal open data cannot supply. Prototyping
// it here is prototyping the cold-start plan, not decorating the card.
//
// HONESTY RULE: seeded UGC is fabricated sample content, generated deterministically
// from the trail id so it is stable across reloads. It must be visibly labelled as
// sample data wherever it appears, exactly as simulated weather is. Anything the reader
// contributes in-session is marked as theirs and is never mixed into the seeded counts.

export interface UgcPhoto {
  id: string;
  caption: string;
  authorName: string;
  /** Relative age for display: "3 days ago". */
  when: string;
  /** Seeded sample content, or something the reader added this session. */
  origin: 'sample' | 'mine';
  /** Object URL for a reader upload. Seeded photos have none and render as a placeholder. */
  src?: string;
}

export interface UgcComment {
  id: string;
  authorName: string;
  when: string;
  text: string;
  /** 1..5 stars this reviewer gave. */
  rating: number;
  origin: 'sample' | 'mine';
}

export interface TrailUgc {
  /** Mean rating, 1..5. Null when nobody has rated it. */
  ratingAvg: number | null;
  ratingCount: number;
  photos: UgcPhoto[];
  comments: UgcComment[];
  /** The reader's own rating this session, if they left one. */
  myRating: number | null;
}

// ============================================================================
// UI STATE
// ============================================================================

export type ScreenId = 'search' | 'results' | 'map' | 'peek';
export type ViewMode = 'list' | 'map';

// The two conditions sorts are named for what they rank on, not for a day: which day they
// rank for is the day bar's business, and the list header restates it. `best-conditions`
// is the default (grade, then prominence, then distance); `conditions-only` ranks on the
// grade and nothing else.
export type SortId =
  | 'best-conditions'
  | 'closest'
  | 'conditions-only'
  | 'top-rated'
  | 'shortest'
  | 'longest'
  | 'least-gain'
  | 'most-gain'
  | 'easiest'
  | 'hardest';

export interface SortDef {
  id: SortId;
  label: string;
}

/** A numeric filter range. null on either end means unbounded. */
export interface Range {
  min: number | null;
  max: number | null;
}

// Day-free, like the sorts: every condition filter is evaluated against the day the reader
// picked in the day bar. There is no per-chip day.
export type ConditionFilterId =
  | 'good-conditions'
  | 'dry'
  | 'storm-free'
  | 'below-treeline'
  | 'shaded';

export interface Filters {
  conditions: ConditionFilterId[];
  difficulty: Difficulty[];
  activities: Activity[];
  routeTypes: RouteType[];
  surfaces: string[];
  /** SI: metres, metres, metres, minutes. */
  lengthM: Range;
  gainM: Range;
  maxElevM: Range;
  estMinutes: Range;
}

export interface PhoneState {
  region: RegionId;
  scenario: ScenarioId;
  screen: ScreenId;
  view: ViewMode;
  /** Free-form search text. Empty means "everything in region". */
  query: string;
  /** Set when a place result scoped the results ("Rocky Mountain National Park"). */
  placeLabel: string | null;
  filters: Filters;
  sort: SortId;
  /** Day offset the scrubber selects: 0 = today. Drives grading and the horizon state. */
  day: number;
  /** Trail id shown in the peek sheet. */
  selected: string | null;
  units: 'imperial' | 'metric';
}

/** A place a search can resolve to. Backed by src/data/places.ts. */
export type PlaceKind = 'park' | 'forest' | 'state' | 'town' | 'peak' | 'region';

export interface PlaceHit {
  kind: PlaceKind;
  name: string;
  /** "National Park · Colorado, United States" */
  subtitle: string;
  bbox: [number, number, number, number];
  /** The seeded region this place resolves into, when it maps onto one. */
  region: RegionId | null;
}
