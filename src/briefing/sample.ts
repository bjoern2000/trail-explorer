// Region briefing — the invented half, and nothing else.
//
// THIS FILE IS THE ONLY PLACE ON THE PAGE WHERE FICTION LIVES. Everything the briefing
// prints is either read out of the committed derived trail data (real: names, lengths,
// gains, high points, surfaces, coordinates, geometry, treeline) or declared here
// (invented: every weather value, every window, every area boundary, every reason). The
// split is enforced structurally rather than promised in prose: a pick below carries a
// trail ID and no measurements, so `briefing.ts` cannot print a length that came from this
// file even by accident, because there is none here to print.
//
// It follows `src/scope/ugc.ts`, which faced the same problem one page earlier: seeded
// review content is fabricated, so every artefact carries `origin: 'sample'` and every
// surface that renders one has to label it. Same rule here, one level up. The whole page
// is the artefact, so the whole page carries the label.
//
// WHY THE BRIEFING IS INVENTED AT ALL, when every other page in TrailScope computes what
// it prints. `src/trail/route.ts` states the house rule and the reason for it: a hand-drawn
// mockup of a weather chart always looks good, because the person drawing it picks the
// numbers. The briefing breaks that rule once, deliberately, because the simulated weather
// cannot answer the question the page asks.
//
// `sampleAt` in `src/scope/weather/scenarios.ts` takes a position, an hour and an
// elevation, and position enters the result ONLY as deterministic jitter:
// `hashUnit(lng, lat, absHour)` scaled by a small per-scenario `jitter` term, plus latitude
// for the sunrise curve. Temperature, thunder probability, precipitation and wind are
// functions of elevation and hour alone. The simulated field therefore has no horizontal
// structure at all, and a briefing computed from it would be elevation wearing the costume
// of geography: it would look like a spatial forecast and be nothing of the sort.
//
// Real Super Resolution at 3 km does have horizontal structure. A cell building over one
// drainage and not the next is the thing it exists to resolve, and the science team's
// feasibility response puts it inside the +36 h hourly horizon this app already models. So
// the concept is sound and only our fake weather cannot show it. Björn's call was to draw
// the target rather than compute a fake of it, and to mark it so hard that no crop of the
// page can be mistaken for output.
//
// INTERNAL CONSISTENCY IS THIS FILE'S JOB. Because nothing here is derived, nothing here
// is checked by anything. The hour grids below are the single source of truth for every
// timing claim on the page: the overview paragraph, the area tints on the plan, the hour
// strips and the per-pick windows all read from them, so a pick cannot claim a clear
// afternoon in an area whose grid says otherwise. `verifyConsistency()` at the bottom
// re-checks the few claims the prose states in words rather than reading from the grid.

import type { RegionId } from '../scope/types';

// ============================================================================
// LEVELS AND HOURS
// ============================================================================

/**
 * The same three-level vocabulary the discovery app grades with (`GradeLevel`), renamed
 * rather than imported.
 *
 * Importing `GradeLevel` would let a reader of this file believe these values came out of
 * `grade.ts`. They did not. Nothing here has been graded; these are hand-typed. A separate
 * type makes that unmistakable at every call site, and costs one mapping in `briefing.ts`
 * where the two vocabularies meet at the shared colours.
 */
export type SampleLevel = 'good' | 'mixed' | 'poor';

/** First and last hour the briefing covers, inclusive. Local clock, 24 h. */
export const HOUR_FROM = 5;
export const HOUR_TO = 19;

/**
 * The hour the plan figure tints its areas by.
 *
 * ONE NAMED HOUR RATHER THAN AN AVERAGE ACROSS THE AFTERNOON. An average has to pick
 * between the mean and the worst, and both flatten the figure: the mean turns a storm into
 * a shrug, and the worst paints four of the five areas the same colour because almost
 * everything east of the crest reaches poor at some point. 14:00 keeps all three levels on
 * the map at once, which is what the figure is for, and `verifyConsistency()` asserts that
 * it still does.
 */
export const PLAN_HOUR = 14;

const HOUR_COUNT = HOUR_TO - HOUR_FROM + 1;

const LEVEL_CODE: Record<string, SampleLevel> = { G: 'good', M: 'mixed', P: 'poor' };

/**
 * Parse an hour grid written as one character per hour, `G` good, `M` mixed, `P` poor.
 *
 * Written as a string rather than an array so a whole area's day is one line a reader can
 * scan against its neighbours, which is how these were authored and is the only way the
 * "storms track east" claim below could be checked by eye. Throws on a wrong length,
 * because a grid one hour short would silently shift every later hour by one.
 */
function grid(codes: string): SampleLevel[] {
  const trimmed = codes.replace(/\s/g, '');
  if (trimmed.length !== HOUR_COUNT) {
    throw new Error(`sample hour grid must be ${HOUR_COUNT} hours, got ${trimmed.length}`);
  }
  return [...trimmed].map((c) => {
    const level = LEVEL_CODE[c];
    if (!level) throw new Error(`unknown sample level code "${c}"`);
    return level;
  });
}

// ============================================================================
// AREAS
// ============================================================================

export interface SampleArea {
  id: string;
  /** Real sub-area of the region, named as a local would name it. */
  name: string;
  /** Where it sits, in one clause. Real geography. */
  where: string;
  /**
   * Hand-placed centre, [lng, lat]. INVENTED as a boundary: the plan assigns each real
   * trail to its nearest centre, so these five points are the whole definition of the
   * areas and no boundary was surveyed. The names and the rough positions are real; the
   * partition is not.
   */
  centre: [number, number];
  /** One level per hour from HOUR_FROM to HOUR_TO. Invented. */
  hours: SampleLevel[];
}

/**
 * Five areas of Rocky Mountain National Park, laid out around the Continental Divide.
 *
 * The Divide is the whole point of the example. It is the terrain feature a 3 km field can
 * resolve and a point forecast cannot, and the sample day is built so the answer changes
 * across it: the west stays clear six hours longer than the ground just east of the crest.
 * That is the claim the computed digest structurally cannot make, so it is the claim the
 * mockup exists to draw.
 *
 * Order is west to east, then south to north, so the array reads as a traverse.
 */
export const SAMPLE_AREAS: SampleArea[] = [
  {
    id: 'kawuneeche',
    name: 'Kawuneeche and North Inlet',
    where: 'west of the Divide, above Grand Lake',
    centre: [-105.755, 40.3],
    //     05 06 07 08 09 10 11 12 13 14 15 16 17 18 19
    hours: grid('G  G  G  G  G  G  G  G  G  G  G  G  M  M  G'),
  },
  {
    id: 'bear',
    name: 'Bear Lake and Glacier Gorge',
    where: 'under the crest of the Divide',
    centre: [-105.645, 40.305],
    hours: grid('G  G  G  G  G  G  M  M  P  P  P  P  M  M  G'),
  },
  {
    id: 'longs',
    name: 'Longs Peak and Wild Basin',
    where: 'the high south-east corner',
    centre: [-105.565, 40.275],
    hours: grid('G  G  G  G  G  G  G  M  M  P  P  P  P  M  G'),
  },
  {
    id: 'moraine',
    name: 'Moraine Park and Fern Lake',
    where: 'the east moraines, below the peaks',
    centre: [-105.618, 40.35],
    hours: grid('G  G  G  G  G  G  G  G  G  M  P  P  M  G  G'),
  },
  {
    id: 'mummy',
    name: 'Horseshoe Park and Mummy Range',
    where: 'the north-east flank',
    centre: [-105.61, 40.4],
    hours: grid('G  G  G  G  G  G  G  G  G  M  M  P  M  G  G'),
  },
];

/**
 * Every area id, for the narrative lines that make a park-wide claim.
 *
 * Derived rather than typed so a sixth area cannot be added without the dawn line's
 * assertion widening to cover it, which is the one assertion on the page that is only true
 * because it is true of ALL of them.
 */
export const ALL_AREA_IDS: string[] = SAMPLE_AREAS.map((a) => a.id);

/** The level an area is at in a given hour. Out-of-range hours clamp to the day's ends. */
export function levelAt(area: SampleArea, hour: number): SampleLevel {
  const i = Math.min(HOUR_COUNT - 1, Math.max(0, Math.round(hour) - HOUR_FROM));
  return area.hours[i];
}

/** The level the plan tints an area: its level at `PLAN_HOUR`, and nothing else. */
export function planLevel(area: SampleArea): SampleLevel {
  return levelAt(area, PLAN_HOUR);
}

/** First hour of the day at which an area stops being good, or null if it never does. */
export function turnsAt(area: SampleArea): number | null {
  for (let i = 0; i < HOUR_COUNT; i++) {
    if (area.hours[i] !== 'good') return HOUR_FROM + i;
  }
  return null;
}

// ============================================================================
// THE CONTINENTAL DIVIDE, SKETCHED
// ============================================================================

/**
 * A hand-traced line through the Divide's approximate course across the region, [lng, lat].
 *
 * SKETCHED, and the figure says so on its face. It is drawn from named crossings a reader
 * can check (roughly Isolation Peak in the south, Flattop Mountain in the middle, Milner
 * Pass in the north) at about the accuracy of a finger on a park map, which is all the
 * figure needs it for: it is there so the overview's "east of the Divide" has something to
 * point at, not so anyone can navigate by it.
 */
export const DIVIDE_SKETCH: [number, number][] = [
  [-105.652, 40.254],
  [-105.664, 40.286],
  [-105.666, 40.309],
  [-105.681, 40.339],
  [-105.71, 40.366],
  [-105.744, 40.396],
  [-105.792, 40.42],
];

// ============================================================================
// THE REGIONAL NUMBERS
// ============================================================================

/**
 * The values the overview strip prints, held in SI and formatted by the shared
 * `src/scope/model.ts` formatters at render time.
 *
 * Invented values still travel the real path. Writing "22°C" into the prose would have put
 * a unit in a string, and the imperial toggle would then have moved the trail measures and
 * left the temperature behind, which is the exact desync `model.ts`'s header warns about.
 * The narrative carries no numbers but clock times for the same reason.
 */
export const SAMPLE_REGIONAL = {
  valleyHighC: 22,
  tundraHighC: 9,
  windMinKph: 25,
  windMaxKph: 40,
  /**
   * Hour the first cells organise over the Divide. Matches the `bear` grid.
   *
   * NOT PRINTED IN THE FIGURE STRIP ANY MORE. It used to be a fourth figure beside the two
   * temperatures and the wind, which put the same 13:00 on the page twice: once as a
   * labelled figure and once in the narrative line that says what happens at it. The
   * constant stays, and stays load-bearing, because the narrative's crest line asserts
   * against it and `verifyConsistency` checks that assertion against the `bear` grid, so
   * the hour still has exactly one definition and is still verified.
   */
  stormOnsetHour: 13,
};

// ============================================================================
// THE OVERVIEW
// ============================================================================

/**
 * What one narrative line asserts about the hour grids, so the copy can be checked against
 * the data it was written from instead of against a hand-kept list of claims.
 *
 * Two shapes, because the narrative only ever makes two kinds of statement. `at` is a level
 * at an hour ("showers at 13:00"). `holdsUntil` is the shape almost every line takes and
 * the one a reader cares about: good in the hour before, not good in the hour named, which
 * is what "clear until 17:00" means and is a strictly stronger claim than either half.
 */
export type OverviewAssert =
  | { kind: 'at'; areas: string[]; hour: number; level: SampleLevel }
  | { kind: 'holdsUntil'; areas: string[]; hour: number };

/**
 * One line of the regional narrative: a glyph, a short claim, and a quiet measure.
 *
 * THE SHAPE IS `BriefLine` FROM `src/scope/phone/peek.ts`, deliberately and not
 * coincidentally. That file already solved this exact problem one page earlier: it had a
 * paragraph of conditions prose, review asked for something scannable, and the answer was
 * an icon, a claim, and the number the claim was concluded from in a quiet right-hand
 * column. This page had the same paragraph problem at region scale, so it gets the same
 * object rather than a second house style for structured conditions copy. The type is
 * restated rather than imported for the reason everything else here is: `peek.ts` computes
 * its lines from a grade, these are typed by hand, and one import would blur which.
 *
 * THE CLAIM NAMES ITS PLACE FIRST. The whole reason this is a list is that "where is it
 * good, where is it bad" should be answerable by running an eye down the left edge, and an
 * edge that reads "Park wide / Over the Divide / At the crest / West of the Divide / East
 * moraines" answers it. A line that opened with its weather instead would need reading.
 */
export interface OverviewLine {
  /** Icon name for `icon()`. Weather silhouettes only: no warning iconography, per below. */
  glyph: string;
  /** The accessible name for the glyph. The claim is read after it. */
  kind: string;
  /** The claim. Place first. */
  text: string;
  /** The clock, in the quiet column. Optional, though every line currently has one. */
  measure?: string;
  /** What the line says about the grids. Checked by `verifyConsistency()`. */
  asserts: OverviewAssert[];
}

/**
 * The regional narrative, written the way a generated briefing would read: flat, ordered by
 * time, and spatial in every line.
 *
 * IT WAS ONE FOUR-SENTENCE PARAGRAPH until Björn asked for structure. The content is the
 * same day and the same clock times; what changed is that the four sentences were four
 * different questions ("what is it doing", "where is it moving", "where is it still good")
 * welded into one run of prose, and a reader comparing two areas had to parse the whole
 * thing to answer either. As lines they are comparable at a glance and the geography is a
 * column.
 *
 * NO RISK LANGUAGE, per TRAIL_PLAN §1, which took the decision for the on-route screen and
 * stated its cost. It applies harder here. The sharpest possible version of this block
 * tells a reader where not to be at 14:00, and that is personal safety advice generated
 * from invented weather by a prototype, in a programme where verification ownership sits
 * with the science team. The narrative states what the day does and stops. The glyphs are
 * held to the same line: `cloud` and `bolt` are the app's own weather silhouettes, the ones
 * the conditions pill uses, and nothing here is a warning triangle.
 *
 * EVERY CLOCK TIME IS CHECKED, and by construction rather than by a parallel list.
 * `verifyConsistency()` scans each line's own text and measure for clock times and requires
 * each one to be the hour of one of that line's asserts, then evaluates the asserts against
 * the grids. Editing a time in the copy without editing the assert beside it is a boot
 * failure, which is the case the old prose-versus-claims arrangement could only catch if
 * somebody remembered to update the claim.
 */
export const SAMPLE_OVERVIEW: OverviewLine[] = [
  {
    glyph: 'sun',
    kind: 'Dawn',
    text: 'Park wide, clear and cold at dawn',
    measure: '05:00',
    asserts: [{ kind: 'at', areas: ALL_AREA_IDS, hour: HOUR_FROM, level: 'good' }],
  },
  {
    glyph: 'cloud',
    kind: 'Over the Divide',
    text: 'Over the Divide, cloud builds',
    measure: 'from 11:00',
    asserts: [{ kind: 'holdsUntil', areas: ['bear'], hour: 11 }],
  },
  {
    glyph: 'bolt',
    kind: 'The crest',
    // The one line that names an area rather than a compass direction, because "tracking
    // east" is only meaningful if a reader can see WHICH ground it reaches. Longs Peak is
    // area 3, downwind of the crest the line opens on, and the relation between their two
    // onset hours is asserted below. Bear Lake used to be named here too and is the crest:
    // the line was stating its own subject a second time.
    //
    // "and thunder" survives a pass that cut almost everything else on the page, because it
    // is the phenomenon the day turns on and dropping it would leave the crest line saying
    // less than the glyph beside it does.
    text: 'At the crest, showers and thunder tracking east over Longs Peak',
    measure: 'from 13:00',
    asserts: [{ kind: 'at', areas: ['bear'], hour: SAMPLE_REGIONAL.stormOnsetHour, level: 'poor' }],
  },
  {
    glyph: 'sun',
    kind: 'West of the Divide',
    text: 'West of the Divide, the Kawuneeche and North Inlet stay clear',
    measure: 'to 17:00',
    asserts: [{ kind: 'holdsUntil', areas: ['kawuneeche'], hour: 17 }],
  },
  {
    glyph: 'suncloud',
    kind: 'East moraines',
    text: 'East moraines hold sun, then clear again',
    measure: 'to 14:00, from 18:00',
    asserts: [
      { kind: 'holdsUntil', areas: ['moraine', 'mummy'], hour: 14 },
      { kind: 'at', areas: ['moraine', 'mummy'], hour: 18, level: 'good' },
    ],
  },
];

// ============================================================================
// RECOMMENDATIONS, GROUPED BY INTENT
// ============================================================================

export interface SamplePick {
  /**
   * A real derived trail, by `<region>/<slug>` ID. Deliberately the only identifying field:
   * name, length, gain, high point, surface, route type and walking time are all read from
   * the derived data at render time, so this file cannot state a measurement about a real
   * trail and cannot be wrong about one.
   */
  trailId: string;
  /** Invented. The sample day's clear stretch for this trail's area, in words. */
  window: string;
  /**
   * Invented. Why this trail answers this intent. May refer to the trail's real measures in
   * words ("the longest in the sample list that never leaves the trees") but never restates
   * a number: `briefing.ts` prints those from the data beside it.
   */
  reason: string;
}

export interface SampleIntent {
  id: string;
  /** What the reader is choosing between, in their words, not the model's. */
  label: string;
  /**
   * What the group holds, in a phrase rather than a sentence.
   *
   * IT USED TO BE A FULL LINE EACH and every one of them ended by explaining the grouping
   * again ("so the area matters less than the hour does", "judged against the park treeline
   * the grader already uses"). The label plus two cards under it already say what the group
   * is; the tail was the page arguing with itself. What survives is only the part a reader
   * cannot infer from the label, which is the threshold.
   */
  blurb: string;
  picks: SamplePick[];
}

/**
 * Four intents, two trails each.
 *
 * WHY BY INTENT AND NOT BY RANK. Björn's call, and it fixes a defect the computed digest
 * exposed rather than a matter of taste. Ranking a region purely by conditions puts the
 * entire RMNP top six under 500 m on a storm day, because a short route occupies less of
 * the convective window than a long one and therefore grades better. That is the model
 * working exactly as designed and useless as a recommendation: nobody drove to Estes Park
 * to be told to do six ten-minute loops. Grouping by what the person came to do puts the
 * conditions back where they belong, as the thing that decides WHICH big day rather than
 * whether to have one.
 *
 * THAT ARGUMENT USED TO BE ON THE PAGE, in a boxed note under this section's lede, at about
 * a hundred words. It is the reasoning behind a design decision, which is what this comment
 * is for and not what a reader of the briefing needs: they need to know the groups are
 * intents and that the conditions decide within a group rather than across all of them. One
 * line says that. The note is gone and the argument lives here.
 *
 * A fifth intent, dry underfoot, is deliberately absent: on this sample day nothing has
 * rained yet, so the group would return the whole list, and an intent whose answer is
 * "everything" is not a recommendation. That is also no longer said on the page. A section
 * explaining a group it does not show is the same self-narration.
 *
 * Each pick's window must agree with its area's hour grid. `verifyConsistency()` cannot
 * check prose, so the windows are phrased in the grid's own clock times and were read off
 * it rather than composed.
 *
 * THE REASONS ARE ONE CLAUSE EACH, down from two or three sentences. Every one of them used
 * to restate the group it sits in, or the measurements printed two rows above it in the same
 * card, or both. What is left is the part that is specific to the trail: why this one and
 * not the other seventeen that would also have fitted the group.
 */
export const SAMPLE_INTENTS: SampleIntent[] = [
  {
    id: 'big-day',
    label: 'A big day',
    blurb: 'Long, with real climbing.',
    picks: [
      {
        trailId: 'rmnp/deer-mountain-trail',
        window: 'Clear to 14:00, then from 18:00',
        reason: 'The longest route that still tops out under treeline.',
      },
      {
        trailId: 'rmnp/fern-lake-trail',
        // The window names the trailhead, because the reason immediately says why it has to.
        window: 'Clear to 14:00 at the trailhead',
        // The one caveat kept at full length anywhere in this array, because it changes how
        // the window beside it should be read rather than describing the trail.
        reason:
          'Starts on the east moraines and ends under the Divide, which turns three hours ' +
          'earlier.',
      },
    ],
  },
  {
    id: 'short-walk',
    label: 'A short walk',
    blurb: 'Under half an hour.',
    picks: [
      {
        trailId: 'rmnp/sprague-lake-trail',
        window: 'Clear to 14:00, then from 18:00',
        reason: 'Flat, gravelled, a loop: either end of the day holds it.',
      },
      {
        trailId: 'rmnp/bear-lake-trail',
        window: 'Clear to 11:00, then at 19:00',
        reason: 'In the area that turns first, short enough for either end of it.',
      },
    ],
  },
  {
    id: 'below-treeline',
    label: 'Below treeline',
    blurb: 'Nothing on open tundra.',
    picks: [
      {
        trailId: 'rmnp/cub-lake-trail',
        window: 'Clear to 14:00, then from 18:00',
        reason: 'Tops out well under treeline, never leaves the valley.',
      },
      {
        trailId: 'rmnp/black-canyon-trail',
        window: 'Clear to 14:00, then from 18:00',
        reason: 'The same ceiling across Horseshoe Park, for twice the climbing.',
      },
    ],
  },
  {
    id: 'late-start',
    label: 'A late start',
    blurb: 'Leaving after 11:00.',
    picks: [
      {
        trailId: 'rmnp/lake-nanita-trail',
        window: 'Clear to 17:00',
        reason: 'West of the Divide, six hours longer than Bear Lake.',
      },
      {
        trailId: 'rmnp/haynach-lakes-trail',
        window: 'Clear to 17:00',
        reason: 'The same six hours, for a shorter and steeper walk.',
      },
    ],
  },
];

// ============================================================================
// SELF-CHECK
// ============================================================================

/** Every clock time in a string, as hours. `"to 14:00, from 18:00"` gives `[14, 18]`. */
function clockHoursIn(text: string): number[] {
  return [...text.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map((m) => Number(m[1]));
}

/**
 * The consistency the page promises, asserted rather than trusted.
 *
 * Someone will check the narrative against the strips, so this checks first. It throws on a
 * mismatch, which turns a copy edit that breaks the day into a blank page in development
 * rather than a wrong claim in a deck. Cheap: five areas, fifteen hours.
 *
 * IT GOT STRICTER WHEN THE PARAGRAPH BECAME LINES. The old version held a hand-written list
 * of claims, each a comment quoting a fragment of the paragraph beside a boolean. That
 * catches a retuned grid, which is what it was for, but it cannot catch the opposite and
 * likelier edit: changing a clock time in the copy and leaving the claim, since the claim
 * never read the copy. Now the copy is data, so the check reads it. For every line it
 * scans the rendered text and measure for clock times and requires each one to be an hour
 * the line itself asserts, then evaluates those asserts against the grids. A time in the
 * copy with no assertion behind it fails, and so does an assertion the grids do not support.
 *
 * What it still cannot check is the pick reasons, which are prose about prose. Those were
 * read off the grids by hand and remain the weakest link on the page; the three relational
 * claims below are the parts of them that could be mechanised.
 */
export function verifyConsistency(): void {
  const byId = new Map(SAMPLE_AREAS.map((a) => [a.id, a]));
  const area = (id: string): SampleArea => {
    const hit = byId.get(id);
    if (!hit) throw new Error(`sample area "${id}" is missing`);
    return hit;
  };

  const claims: [string, boolean][] = [];

  // ---- the narrative, line by line, against its own asserts ----
  for (const line of SAMPLE_OVERVIEW) {
    const asserted = new Set(line.asserts.map((a) => a.hour));
    for (const hour of clockHoursIn(`${line.text} ${line.measure ?? ''}`)) {
      claims.push([`"${line.kind}" states ${hour}:00 and asserts it`, asserted.has(hour)]);
    }
    for (const a of line.asserts) {
      for (const id of a.areas) {
        claims.push(
          a.kind === 'at'
            ? [`"${line.kind}": ${id} is ${a.level} at ${a.hour}:00`, levelAt(area(id), a.hour) === a.level]
            : [
                `"${line.kind}": ${id} holds good until ${a.hour}:00`,
                levelAt(area(id), a.hour - 1) === 'good' && levelAt(area(id), a.hour) !== 'good',
              ],
        );
      }
    }
    // A line with copy but nothing to check is the failure mode this whole arrangement
    // exists to prevent: it would read as verified and be an unsourced assertion.
    claims.push([`"${line.kind}" asserts something`, line.asserts.length > 0]);
  }

  // ---- the relations, which no single line can state ----
  claims.push(
    // "tracking east over Bear Lake and Longs Peak": Longs turns later than the crest, or
    // the line's own direction word is wrong even though both its hours check out.
    ['storms reach Longs after Bear', (turnsAt(area('longs')) ?? 0) > (turnsAt(area('bear')) ?? 0)],
    // "three hours longer than the ground under the crest", on the big-day cards.
    ['moraines run three hours past the crest', (turnsAt(area('moraine')) ?? 0) - (turnsAt(area('bear')) ?? 0) === 3],
    ['mummy runs three hours past the crest', (turnsAt(area('mummy')) ?? 0) - (turnsAt(area('bear')) ?? 0) === 3],
    // "six hours longer than it does at Bear Lake", on both late-start cards.
    ['west runs six hours past the crest', (turnsAt(area('kawuneeche')) ?? 0) - (turnsAt(area('bear')) ?? 0) === 6],
    // The plan figure's whole reason for tinting at one named hour: all three levels are on
    // the map at 14:00. Retuning any grid until they are not turns the plan into a
    // two-colour picture without anything else complaining.
    ['plan hour carries all three levels', new Set(SAMPLE_AREAS.map(planLevel)).size === 3],
  );

  const broken = claims.filter(([, ok]) => !ok).map(([what]) => what);
  if (broken.length > 0) {
    throw new Error(`region briefing sample is inconsistent: ${broken.join('; ')}`);
  }
}

/** The region the briefing is written for. One region on purpose: it is one sample day. */
export const SAMPLE_REGION: RegionId = 'rmnp';

/**
 * How the day is labelled. No date, deliberately.
 *
 * A dated briefing invites the question "is this the forecast for the 18th", and the answer
 * has to be no on every page of this app. A season is enough context for the sample to be
 * plausible and carries no claim about any particular day.
 */
export const SAMPLE_DAY_LABEL = 'Sample day, mid-July';
