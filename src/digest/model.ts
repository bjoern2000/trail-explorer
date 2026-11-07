// Regional conditions digest — the synthesis. No DOM in this file.
//
// WHAT THIS IS FOR. The discovery prototype already grades every trail in a region on
// every day the scrubber offers: 87 routes at Rocky Mountain NP, 180 in the Adirondacks,
// 38 in the Ozarks, times seven days. It uses that to order ONE list for ONE day and then
// throws the rest away. The pattern across all of it is the thing nobody has looked at,
// and it is what a reader who asks "what are the best trails and when should I go" is
// actually asking for:
//
//     Rocky Mountain NP, Wednesday: 69 of 87 routes grade Good. Below treeline 69 of 73
//     do; above treeline none of 10 do. Storms are stated from 14:00.
//
// Every clause of that is read off the grades. Nothing on this page is authored, and no
// number in it is typed: `summary.ts` turns this file's output into sentences and
// `digest.ts` renders them.
//
// THREE RULES, all of them inherited rather than invented here.
//
//   1. NOTHING RE-DERIVES THE GRADE. The grades come from `phone/grading.ts`'s cache,
//      which is the same cache the results list reads, so a digest cell and the card it
//      summarises can never disagree. The picks come from `phone/query.ts`'s own
//      comparator for the same reason: a second ranking implemented here would be a
//      second opinion, and the whole value of a digest is that it agrees with the list.
//   2. THE HORIZON IS STRUCTURAL, NOT COSMETIC. Past `provider.horizonHours` a grade is a
//      call about the AREA on a DAY: no terrain term, no hour, no window, and a score
//      quantised per level so it cannot rank (grade.ts's `outlookGrade`). So the later
//      columns of the matrix carry genuinely less than the first two, `consensus` is null
//      out there by construction rather than by choice, and `picks` falls back. The
//      horizon is read off the provider; 36 is never written down.
//   3. NO RISK LANGUAGE ANYWHERE (TRAIL_PLAN §1). This file computes when a day turns and
//      how many routes carry a window. It never recommends, warns, or names a hazard.
//
// WHY BANDS AT ALL. A digest that says "62 of 87 are fine" is a statistic; a digest that
// says "the valley holds and the high routes do not" is a finding, and the difference is
// entirely the grouping axis. The axis has to be the one the product argues matters, which
// is elevation against the regional treeline: that IS the grader's exposure input, so the
// matrix is showing the shape of the term rather than an arbitrary cut through the data.
// See `bandScheme` for what happens where there is no treeline.

import { displaySet } from '../scope/data';
import { REGIONS, hasTreeline } from '../scope/model';
import { terrainFacts } from '../scope/weather/grade';
import { clockLabel, dateLabel, weekdayLabel } from '../scope/weather/provider';
import {
  SCRUB_DAYS,
  ensureGrades,
  firstOutlookDay,
  gradeOf,
  providerFor,
} from '../scope/phone/grading';
import { distanceAwayM, sortTrails } from '../scope/phone/query';
// The area reading, from the discovery app's own area strip rather than from a second
// regional model built here. `areaStrip` prints a valley-reference readout at
// `REGION_REF_ELEV_M`; the Week screen wants exactly that reading, one per day, so it can
// draw a sky. Reusing the module means the digest and the results list ask the provider the
// same question about the same point, and `pointReading` reduces it the same way.
import { areaWeatherOf, ensureAreaWeather } from '../scope/phone/area';
import { pointReading, type ConditionsReading } from '../scope/phone/conditions';
import { REGION_REF_ELEV_M } from '../scope/weather/simulated';
import type {
  ConditionGrade,
  GradeLevel,
  RegionId,
  ScenarioId,
  ScopeTrail,
  WeatherProvider,
} from '../scope/types';

// ============================================================================
// BANDS
// ============================================================================

export type BandAxis = 'treeline' | 'drainage';

export interface BandDef {
  id: string;
  /** Row label in the matrix. Short: the row header column is narrow at 1024 px. */
  label: string;
  /** What the band is, in one clause, for the matrix caption. No units in it. */
  rule: string;
}

export interface BandScheme {
  axis: BandAxis;
  defs: BandDef[];
  /** Which band a trail falls in. Total, so every trail lands in exactly one row. */
  assign(trail: ScopeTrail): string;
}

/**
 * Share of a route's profile above the regional treeline at which it stops being a route
 * that touches the alpine and becomes a route that IS in it.
 *
 * A quarter, and the value is a judgement rather than a measurement, so it is named here
 * instead of buried in a comparison. The grader's exposure term is continuous in
 * `exposedShare` (grade.ts), so any cut is a presentation choice; this one is set where the
 * seeded regions actually separate. At RMNP it splits the 14 routes with any exposure into
 * 10 that are mostly above the line and 4 that only clip it, and at the Adirondacks 37 into
 * 17 and 20. A lower cut would collapse the middle row into the top one and lose the fact
 * that clipping the treeline and living above it grade differently.
 */
export const EXPOSED_BAND_CUT = 0.25;

/**
 * Cuts on `terrainFacts().holdsWater`, the drainage axis used where there is no treeline.
 *
 * Chosen against the same table the page prints on the Trail Explorer page: 0.5 is where
 * the surfaces that shed water (rock, gravel, compacted) stop and the hedged untagged value
 * begins, and 0.9 is where the surfaces that hold it (ground, dirt, grass, mud) begin once
 * the steepness and flatness terms have been applied. So the two cuts are the surface
 * model's own boundaries seen through the route's shape, not thirds of a distribution.
 */
export const DRAINAGE_BAND_CUTS = { drainsBelow: 0.5, holdsAbove: 0.9 };

const TREELINE_BANDS: BandDef[] = [
  { id: 'above', label: 'Above treeline', rule: 'a quarter or more of the profile sits above the regional treeline' },
  { id: 'crossing', label: 'Crossing treeline', rule: 'some of the profile is above it, but less than a quarter' },
  { id: 'below', label: 'Below treeline', rule: 'none of it is' },
];

const DRAINAGE_BANDS: BandDef[] = [
  { id: 'drains', label: 'Drains freely', rule: 'rock, gravel or compacted surface, or steep enough to shed' },
  { id: 'mid', label: 'Middling', rule: 'the hedged value an untagged route falls to, or close to it' },
  { id: 'holds', label: 'Holds water', rule: 'soft ground, and flat or gentle enough to pond' },
];

/**
 * The grouping axis for a region, and the one place the Ozarks case is handled.
 *
 * Lake of the Ozarks has no treeline (`NO_TREELINE_M`), the region tops out around 350 m,
 * and the exposure term is inert there by construction. Banding it by elevation anyway
 * would produce three rows that differ by a hundred metres of hillside and mean nothing,
 * which is worse than not banding it: it would draw a shape the data does not have.
 *
 * So where there is no treeline the axis moves to the OTHER terrain input the grade turns
 * on, drainage, and the page says it moved and why. That is not a downgrade of the
 * argument, it is the argument: terrain-aware weather has whatever terrain there is to be
 * aware of, and in the Ozarks that is ground rather than elevation. It is also the axis
 * that maps onto the science team's warm-season trail wetness deliverable, which is the
 * half of the science response that already has a working prototype.
 */
export function bandScheme(region: RegionId): BandScheme {
  const def = REGIONS[region];
  if (hasTreeline(def)) {
    return {
      axis: 'treeline',
      defs: TREELINE_BANDS,
      assign(trail) {
        const share = terrainFacts(trail, def).exposedShare;
        if (share >= EXPOSED_BAND_CUT) return 'above';
        return share > 0 ? 'crossing' : 'below';
      },
    };
  }
  return {
    axis: 'drainage',
    defs: DRAINAGE_BANDS,
    assign(trail) {
      const hold = terrainFacts(trail, def).holdsWater;
      if (hold <= DRAINAGE_BAND_CUTS.drainsBelow) return 'drains';
      return hold > DRAINAGE_BAND_CUTS.holdsAbove ? 'holds' : 'mid';
    },
  };
}

// ============================================================================
// SHAPES
// ============================================================================

/** How many routes have a usable window covering a given hour-from-now. */
export interface CoverageHour {
  hour: number;
  count: number;
}

/** The contiguous run of hours the most routes agree on. Null when none has a window. */
export interface Consensus {
  startHour: number;
  endHour: number;
  count: number;
}

/** One band's grades on one day: a matrix cell, and one strip in the windows section. */
export interface BandCell {
  bandId: string;
  total: number;
  /**
   * Levels, and the ONLY definition of "good" this page uses.
   *
   * The grader also exports `isGood()`, the `Good conditions` chip's predicate, which is
   * prime OR mixed-with-a-usable-window. It is a perfectly good answer to "how many are
   * usable" and it is deliberately not used here: a digest that printed 69 graded Good
   * beside 71 counted as good would be asking a reader to hold two definitions of one word
   * on a page whose whole job is to be read at a glance. `counts.prime` is what the pill
   * says, so it is what the sentences say.
   */
  counts: Record<GradeLevel, number>;
  withWindow: number;
  noWindow: number;
  coverage: CoverageHour[];
  consensus: Consensus | null;
}

export interface Pick {
  trail: ScopeTrail;
  grade: ConditionGrade;
  awayM: number;
}

export interface DigestDay {
  /** Offset from today. 0 is today. */
  day: number;
  weekday: string;
  date: string;
  /** "Today" / "Tomorrow" where one applies, otherwise null. Named by the day bar too. */
  relative: string | null;
  /** True once the day starts past the provider's horizon: no hour, no window, no terrain. */
  outlook: boolean;

  total: number;
  counts: Record<GradeLevel, number>;
  cells: BandCell[];

  /**
   * The hour the day's convection is stated from, as the middle hour across the routes
   * that name one, and how many routes that is. Null on a day where none does.
   */
  turnHour: number | null;
  turnCount: number;

  /** Hour span the window strips are drawn across, shared by every band so they align. */
  hourFrom: number;
  hourTo: number;
  noWindow: number;
  consensus: Consensus | null;

  /** The app's own Best-conditions order, truncated. Falls back past the horizon. */
  picks: Pick[];
  /** True when the picks are the fallback order rather than a conditions ranking. */
  picksFellBack: boolean;

  /**
   * The region's own conditions on this day, at the valley reference elevation.
   *
   * ONE POINT AT A PLACE, which is the SnowCast model, and it is here for one job: the Week
   * screen needs a sky per day, and a sky is a measurement rather than a grade. Deriving one
   * from the level counts instead would draw a picture of the verdict and call it weather.
   *
   * Null until the provider call lands, and null-safe forever after: nothing on the page is
   * allowed to be sized by it.
   */
  areaReading: ConditionsReading | null;
}

export interface RegionDigest {
  region: RegionId;
  regionName: string;
  scenario: ScenarioId;
  provider: WeatherProvider;
  bands: BandScheme;
  /** Trails in the display set: what the results list shows, exclusions already applied. */
  total: number;
  perBand: Record<string, number>;
  days: DigestDay[];
  /** First day offset the provider cannot make a route-specific claim about. */
  firstOutlook: number;
  horizonH: number;
  assumedLocationLabel: string;
  treelineM: number;
  /** Elevation `areaReading` is for. A field on the screen, never a caption. */
  refElevM: number;
}

/**
 * Named trails shown per day.
 *
 * THREE, DOWN FROM SIX. Six filled the card grid at every width without paging, which was
 * the only argument for it, and cost two full rows of cards and about 55 rendered words on a
 * page held to 400. Three is one row at 1080 px and still answers what the section asks,
 * which is which names come out at the top of the region's own conditions order; the fourth
 * through sixth names were the same answer at lower confidence, since the score gaps between
 * adjacent picks past the top few are inside the grade's own quantisation.
 */
export const PICK_COUNT = 3;

// ============================================================================
// BUILD
// ============================================================================

const EMPTY_COUNTS = (): Record<GradeLevel, number> => ({ prime: 0, mixed: 0, poor: 0 });

/**
 * Coverage over `[from, to)` in whole hours: how many of these windows cover each hour.
 *
 * Whole hours because that is the resolution the grade has (`bestWindow` is rounded to the
 * hour in grade.ts) and drawing half hours would claim a precision the window does not
 * carry. A window covers hour h when it starts at or before h and ends at or after h + 1,
 * so an hour is only counted when the whole of it is inside the window.
 */
function coverageOf(
  windows: { startHour: number; endHour: number }[],
  from: number,
  to: number,
): CoverageHour[] {
  const out: CoverageHour[] = [];
  for (let h = Math.floor(from); h < Math.ceil(to); h++) {
    let count = 0;
    for (const w of windows) if (w.startHour <= h && w.endHour >= h + 1) count++;
    out.push({ hour: h, count });
  }
  return out;
}

/**
 * The longest contiguous run of hours at the coverage peak.
 *
 * Deliberately the PEAK and not a threshold: "where the windows agree" is a question about
 * the maximum agreement available, and a threshold would need a number nobody could defend
 * (why 60 percent of routes and not 55?). Ties on length are broken by taking the earliest
 * run, because a reader planning a day reads the first one as the answer.
 */
function consensusOf(coverage: CoverageHour[]): Consensus | null {
  let peak = 0;
  for (const c of coverage) peak = Math.max(peak, c.count);
  if (peak === 0) return null;

  let best: Consensus | null = null;
  let runStart: number | null = null;
  for (let i = 0; i <= coverage.length; i++) {
    const at = i < coverage.length && coverage[i].count === peak;
    if (at && runStart === null) runStart = coverage[i].hour;
    if (!at && runStart !== null) {
      const end = coverage[i - 1].hour + 1;
      if (!best || end - runStart > best.endHour - best.startHour) {
        best = { startHour: runStart, endHour: end, count: peak };
      }
      runStart = null;
    }
  }
  return best;
}

/**
 * ONE hour per route: the hour that route's own day turns, for the routes that name one.
 *
 * STORM AND EXPOSURE ONLY. Those are the two factors whose `fromHour` is the convective
 * turn, and both sides of it count: "clear until 15:00" on a Good card and "70% storms from
 * 15:00" on a Poor one are the same fact about the same afternoon, told from the two ends.
 * The daylight factor also carries a `fromHour`, but that one is sunset, which is a fact
 * about the calendar rather than about the day turning, so it is left out.
 *
 * ONE PER ROUTE IS THE WHOLE POINT OF THIS FUNCTION. Collecting every matching factor
 * instead returned 99 hours from 87 routes at RMNP under storms, because a route can carry
 * both a storm clause and an exposure clause turning on the same hour, and the summary
 * then reported more routes naming an hour than the region has. The earliest of a route's
 * hours is taken, since that is when its day starts changing.
 */
function turnHoursOf(grades: ConditionGrade[]): number[] {
  const hours: number[] = [];
  for (const g of grades) {
    let earliest: number | null = null;
    for (const f of g.factors) {
      if (f.fromHour === undefined) continue;
      if (f.kind !== 'storm' && f.kind !== 'exposure') continue;
      if (earliest === null || f.fromHour < earliest) earliest = f.fromHour;
    }
    if (earliest !== null) hours.push(earliest);
  }
  return hours.sort((a, b) => a - b);
}

/**
 * Everything the page draws, for one region under one scenario.
 *
 * Async because the provider contract is async (a real Super Resolution call is a network
 * call), and `ensureGrades` fills the shared cache before anything is read out of it. One
 * call covers every day, because the provider returns one long hourly series per trail and
 * grading a seventh day off it costs nothing measurable: the whole Adirondack region, 180
 * routes across seven days, fetches in about 30 ms and grades in about 20.
 */
export async function buildDigest(region: RegionId, scenario: ScenarioId): Promise<RegionDigest> {
  const def = REGIONS[region];
  const trails = displaySet(region).trails;
  const provider = providerFor(scenario, region);
  const bands = bandScheme(region);
  const days = [...Array(SCRUB_DAYS).keys()];

  await ensureGrades(scenario, region, trails, days);
  // One fetch per scenario and region covers every day, cached in area.ts exactly as the
  // grades are in grading.ts, so switching days costs the provider nothing.
  await ensureAreaWeather(provider, scenario, region, def.assumedLocation);
  const areaWeather = areaWeatherOf(scenario, region);

  const bandOf = new Map<string, string>();
  const perBand: Record<string, number> = {};
  for (const d of bands.defs) perBand[d.id] = 0;
  for (const t of trails) {
    const id = bands.assign(t);
    bandOf.set(t.id, id);
    perBand[id]++;
  }

  const firstOutlook = firstOutlookDay(provider);
  const built: DigestDay[] = [];

  for (const day of days) {
    // A trail with no cached grade cannot happen after `ensureGrades` resolves, but the
    // cache read is nullable by contract, so the row is dropped rather than defaulted: a
    // fabricated level would be indistinguishable from a real one in every count below.
    const rows = trails
      .map((trail) => ({ trail, grade: gradeOf(scenario, region, trail, day) }))
      .filter((r): r is { trail: ScopeTrail; grade: ConditionGrade } => r.grade !== null);

    const counts = EMPTY_COUNTS();
    for (const r of rows) counts[r.grade.level]++;

    // The strips share one axis across bands so the three of them can be read against each
    // other. Past the horizon no route has a window at all, so the span collapses and the
    // section says so instead of drawing an empty axis.
    const windows = rows.map((r) => r.grade.bestWindow).filter((w) => w !== null);
    const hourFrom = windows.length ? Math.min(...windows.map((w) => w.startHour)) : 0;
    const hourTo = windows.length ? Math.max(...windows.map((w) => w.endHour)) : 0;

    const cells: BandCell[] = bands.defs.map((bandDef) => {
      const mine = rows.filter((r) => bandOf.get(r.trail.id) === bandDef.id);
      const cellCounts = EMPTY_COUNTS();
      const cellWindows: { startHour: number; endHour: number }[] = [];
      for (const r of mine) {
        cellCounts[r.grade.level]++;
        if (r.grade.bestWindow) cellWindows.push(r.grade.bestWindow);
      }
      const coverage = coverageOf(cellWindows, hourFrom, hourTo);
      return {
        bandId: bandDef.id,
        total: mine.length,
        counts: cellCounts,
        withWindow: cellWindows.length,
        noWindow: mine.length - cellWindows.length,
        coverage,
        consensus: consensusOf(coverage),
      };
    });

    const turns = turnHoursOf(rows.map((r) => r.grade));
    const outlook = day >= firstOutlook;

    // The picks are the results list's own order, run over the same rows. Past the horizon
    // the conditions comparator ties on a level-quantised score, so ordering by it would
    // invent a ranking; the app falls back to Closest there and the digest does the same,
    // and says so, rather than printing six arbitrary names.
    const sortable = rows.map((r) => ({
      trail: r.trail,
      grade: r.grade,
      awayM: distanceAwayM(r.trail, def),
    }));
    const picks = sortTrails(sortable, outlook ? 'closest' : 'best-conditions')
      .slice(0, PICK_COUNT)
      .map((r) => ({ trail: r.trail, grade: r.grade as ConditionGrade, awayM: r.awayM }));

    built.push({
      day,
      weekday: weekdayLabel(provider.now().dayIndex + day),
      date: dateLabel(provider.now().dayIndex + day),
      relative: day === 0 ? 'Today' : day === 1 ? 'Tomorrow' : null,
      outlook,
      total: rows.length,
      counts,
      cells,
      turnHour: turns.length ? turns[Math.floor(turns.length / 2)] : null,
      turnCount: turns.length,
      hourFrom,
      hourTo,
      noWindow: rows.length - windows.length,
      consensus: consensusOf(coverageOf(windows, hourFrom, hourTo)),
      picks,
      picksFellBack: outlook,
      areaReading: areaWeather
        ? pointReading(areaWeather, provider, day, REGION_REF_ELEV_M[region])
        : null,
    });
  }

  return {
    region,
    regionName: def.name,
    scenario,
    provider,
    bands,
    total: trails.length,
    perBand,
    days: built,
    firstOutlook,
    horizonH: provider.horizonHours,
    assumedLocationLabel: def.assumedLocationLabel,
    treelineM: def.treelineM,
    refElevM: REGION_REF_ELEV_M[region],
  };
}

// ============================================================================
// SMALL SHARED READERS
// ============================================================================

/** "08:00" for an hour-from-now on the digest's provider clock. */
export function hourLabel(digest: RegionDigest, hoursFromNow: number): string {
  return clockLabel(digest.provider, hoursFromNow);
}

export function bandDef(digest: RegionDigest, bandId: string): BandDef {
  return digest.bands.defs.find((d) => d.id === bandId) ?? digest.bands.defs[0];
}

/**
 * A band's mean level on 0 to 1, Poor 0, Mixed a half, Good 1. A RANKING KEY ONLY: it is
 * never rendered, for the same reason `ConditionGrade.score` is never rendered.
 *
 * It exists because the obvious key, the share graded Good, silently fails on the days
 * where the answer matters most. Under afternoon storms four days out at RMNP nothing in
 * the region grades Good, so every band's Good share is zero and the bands read as
 * identical; they are not remotely identical, because below treeline is 72 Mixed against 1
 * Poor while above treeline is 1 Mixed against 9. A mean over all three levels separates
 * them and a share of one level cannot.
 */
export function bandScore(cell: BandCell): number {
  if (cell.total === 0) return 0;
  return (cell.counts.prime * 2 + cell.counts.mixed) / (cell.total * 2);
}

/**
 * The band that grades highest and the band that grades lowest, or null when every
 * populated band grades the same.
 *
 * Ties break towards the LARGER band, which matters at the ends of the axis: RMNP has 10
 * routes above treeline and 4 crossing it, and when both come out at the bottom the
 * sentence should name the ten rather than the four.
 */
export function bandExtremes(day: DigestDay): { best: BandCell; worst: BandCell } | null {
  const populated = day.cells.filter((c) => c.total > 0);
  if (populated.length < 2) return null;
  const sorted = [...populated].sort((a, b) => bandScore(b) - bandScore(a) || b.total - a.total);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  return bandScore(best) === bandScore(worst) ? null : { best, worst };
}
