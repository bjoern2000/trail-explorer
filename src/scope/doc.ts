// Trail Scope page — the product prototype's document shell.
//
// Modelled on src/merge/merge.ts: a long-form prose document, built once at load from a
// declarative array of section descriptors. Unlike merge.html, the sticky element pinned
// beside the prose is not a rail of figures but a single continuous phone (SCOPE_PLAN.md
// §3): scrolling a prose section into view drives the phone to the state that section
// illustrates, until the reader taps inside the phone, at which point auto-advance stops
// for the session and each section instead offers an explicit "Show me" chip.
//
// The document opens on the results list, not on search: the list is the argument the
// page makes, and search is a later section about how you scope it.
//
// This file owns the document shell and the chrome controls (region, scenario, units).
// It does NOT implement the phone app: that is ./phone/app's workstream, reached only
// through the frozen mountPhone / PhoneHandle contract.

import '../tokens.css';
import './scope.css';

import { mountNav } from '../ui/nav';
import { h } from '../ui/dom';
import { mountPhone, type PhoneHandle } from './phone/app';
import { scenarioDefs } from './weather/scenarios';
// The conditions model is documented FROM the model. `GRADE_MODEL` is grade.ts's own frozen
// parameter set and `terrainFacts` is the function the grader itself calls, so every weight,
// cut, onset and multiplier the Conditions model section prints is read at render time. See
// that export's header: nothing about the grade is typed into this file.
import { GRADE_MODEL, terrainFacts } from './weather/grade';
import { ROUTE_SAMPLE_POINTS } from './weather/provider';
import { simulatedProvider } from './weather/simulated';
import { displaySet, regionStats } from './data';
import {
  REGIONS as REGION_DEFS,
  SORTS,
  formatElevation,
  formatHourOfDay,
  formatPercent,
  formatPrecip,
  formatSpeed,
  formatTemp,
  hasTreeline,
} from './model';
import type { RegionId, ScenarioDef, ScenarioId, ScreenId, ViewMode } from './types';

// ---- units: read/write the app-wide localStorage key ---------------------------
// SCOPE_PLAN.md §3 asks for the same `trailscope-units` key src/merge/model.ts reads,
// so the toggle follows the reader across all five pages. This page is also the one
// place in the app that WRITES it from a control, so both directions live here.

const UNITS_KEY = 'trailscope-units';
type Units = 'imperial' | 'metric';

function readUnits(): Units {
  try {
    return localStorage.getItem(UNITS_KEY) === 'imperial' ? 'imperial' : 'metric';
  } catch {
    return 'metric';
  }
}

function writeUnits(u: Units): void {
  try {
    localStorage.setItem(UNITS_KEY, u);
  } catch {
    // localStorage unavailable (private browsing, etc.) — the toggle still works
    // for the current load, it just won't persist across pages.
  }
}

// ---- region + scenario registries -----------------------------------------------
// Region labels only: the full RegionDef (bbox, treeline, derived trail data) is
// scope/model.ts's concern, not this page shell's.

interface RegionOption {
  id: RegionId;
  label: string;
}

const REGIONS: RegionOption[] = [
  { id: 'rmnp', label: 'Rocky Mountain NP' },
  { id: 'adk', label: 'Adirondack High Peaks' },
  { id: 'ozarks', label: 'Lake of the Ozarks' },
];

// Scenario labels and blurbs come from the weather module, so the control rail and the
// grader can never describe a scenario differently.
const SCENARIOS: ScenarioDef[] = scenarioDefs();

// ---- prose section descriptors ---------------------------------------------------
// One array is the source of truth for the document body, the contents rail, and the
// scroll-linked phone driving, exactly as src/ui/nav.ts's PAGES is for the top bar.

interface GoToState {
  screen: ScreenId;
  view?: ViewMode;
  hint?: string;
}

interface SectionSpec {
  id: string;
  kicker: string;
  title: string;
  /** The phone state this section illustrates; omitted for sections that don't drive it. */
  phoneState?: GoToState;
  body: (HTMLElement | string)[];
}

// Copy style: crisp and scannable. One short lede line per section, then bullets.
// No long paragraphs anywhere; a reader should be able to take a section in at a glance.

const p = (...children: (string | Node)[]): HTMLElement => h('p', {}, ...children);
const strong = (t: string): HTMLElement => h('strong', {}, t);
const em = (t: string): HTMLElement => h('em', {}, t);

/** The single framing line under a section head. */
const lede = (...children: (string | Node)[]): HTMLElement =>
  h('p', { class: 'sec-lede' }, ...children);

/** Bulleted body. Each item one line, two at most. */
const ul = (...items: (HTMLElement | (string | Node)[])[]): HTMLElement =>
  h('ul', {}, ...items.map((it) => (Array.isArray(it) ? h('li', {}, ...it) : it)));

/** A pull-quote for the one sentence the page argues for. */
const quote = (t: string): HTMLElement => h('blockquote', { class: 'sec-quote' }, t);

/** A finding or a caveat: boxed so it does not get skimmed past. */
const note = (label: string, ...children: (string | Node)[]): HTMLElement =>
  h('div', { class: 'sec-note' }, h('span', { class: 'note-label' }, label), ...children);

const caveat = (label: string, ...children: (string | Node)[]): HTMLElement =>
  h('div', { class: 'sec-note is-caveat' }, h('span', { class: 'note-label' }, label), ...children);

/**
 * A sub-head inside a section. Only the Conditions model section is long enough to need
 * one: every other section is a lede plus bullets, and giving those a second heading level
 * would imply a structure they do not have.
 */
const sub = (t: string): HTMLElement => h('h3', {}, t);

/**
 * A parameter table, in its own horizontally scrolling wrapper.
 *
 * The wrapper is what scrolls, never the prose column: the table carries a min-width so the
 * "what drives it" column stays readable on a phone, and at that width the wrapper has to
 * be allowed to scroll or the whole document would. `numeric` marks the columns that get
 * mono tabular figures and right alignment, as src/merge/merge.css's `.tbl` idiom does.
 */
const tbl = (
  head: string[],
  rows: (string | Node)[][],
  numeric: number[] = [],
): HTMLElement => {
  const isNum = (i: number): boolean => numeric.includes(i);
  return h(
    'div',
    { class: 'tbl-wrap' },
    h(
      'table',
      { class: 'tbl' },
      h(
        'thead',
        {},
        h('tr', {}, ...head.map((c, i) => h('th', { class: isNum(i) ? 'num' : '' }, c))),
      ),
      h(
        'tbody',
        {},
        ...rows.map((cells) =>
          h('tr', {}, ...cells.map((c, i) => h('td', { class: isNum(i) ? 'num' : '' }, c))),
        ),
      ),
    ),
  );
};

/**
 * A `holdsWater` multiplier, two decimals with one trailing zero dropped: 0.2, 0.55, 1.0,
 * 1.3. `toFixed(1)` would print 0.55 as 0.6 and lose the distinction between gravel and
 * sand, which is one of the finer steps in the table; `toFixed(2)` would print 1.00, which
 * reads as false precision on a judged multiplier.
 */
const holdLabel = (hold: number): string => hold.toFixed(2).replace(/0$/, '');

/**
 * The multiplier an untagged trail gets, pulled out of the same table the page prints
 * rather than named again in the prose. It is the row the copy has to single out, because
 * it is a hedge and not a measurement, and it must not be the one number on the page that
 * a reader could find contradicted by the table two paragraphs above it.
 */
const UNTAGGED_HOLD = holdLabel(
  GRADE_MODEL.ground.surfaceHold.find((r) => r.probe === null)?.hold ?? 0,
);

// The forecast horizon comes off a provider instance, never a literal: it is Super
// Resolution's constraint, and `SimulatedProvider` carries the real 36 rather than the
// simulation's own (unlimited) capability. Any scenario's instance answers, since the
// horizon is a property of the model behind the interface, not of the weather.
const HORIZON_H = simulatedProvider('bluebird').horizonHours;

/**
 * A number interpolated from the derived data at render time, as the merge page does.
 * Renders the fallback until hydrateNumbers() fills it, so the prose is never broken
 * if a region's derived JSON is missing.
 */
const dyn = (key: string, fallback = '…'): HTMLElement =>
  h('span', { class: 'dyn', 'data-dyn': key }, fallback);

/**
 * Fill every dyn() placeholder in the document. Called once the region's derived data
 * is loaded, and again whenever the region changes, so no total is ever hand-typed.
 */
function hydrateNumbers(values: Record<string, string>): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-dyn]')) {
    const key = el.dataset.dyn;
    if (key && key in values) el.textContent = values[key];
  }
}

/**
 * Every interpolated number in the prose, computed from the committed derived data for
 * the selected region. The merge page's rule applies here too: if the pipeline changes,
 * the document changes with it, because nothing is typed by hand.
 */
function docNumbers(region: RegionId, units: Units): Record<string, string> {
  const s = regionStats(region);
  const pct = (n: number, of: number): string =>
    of === 0 ? '0%' : `${Math.round((n / of) * 100)}%`;

  // The drainage multiplier, measured over the trails the list actually shows rather than
  // over every derived name-cluster: the subdivision streets and the sub-200 m fragments the
  // display set excludes are never graded, so quoting their drainage would describe a
  // population the model never runs on. `terrainFacts` is the grader's own function, so
  // these are the same numbers the pill is computed from.
  const holds = displaySet(region)
    .trails.map((t) => terrainFacts(t, REGION_DEFS[region]).holdsWater)
    .sort((a, b) => a - b);
  const g = GRADE_MODEL.ground;
  const holdLo = holds.length ? holds[0] : 0;
  const holdHi = holds.length ? holds[holds.length - 1] : 0;
  const holdMid = holds.length ? holds[Math.floor(holds.length / 2)] : 0;
  const halfLifeH = (hold: number): number => Math.round(g.dryHalfLifeBaseH + g.dryHalfLifeGainH * hold);

  return {
    regionName: s.regionName,
    assumedLocation: s.assumedLocationLabel,
    wayCount: String(s.wayCount),
    trailCount: String(s.trailCount),
    // The no-treeline sentinel must never print as a number, so this whole clause is
    // interpolated rather than assembled from a bare elevation.
    treelineNote: hasTreeline(REGION_DEFS[region])
      ? `${s.aboveTreelineCount} of ${s.trailCount} trails in ${s.regionName} top out above the ` +
        `local treeline of ${formatElevation(s.treelineM, units)}.`
      : `${s.regionName} has no treeline, so nothing here is exposed in that sense.`,
    diffDist: `${pct(s.difficulty.easy, s.trailCount)} easy, ${pct(
      s.difficulty.moderate,
      s.trailCount,
    )} moderate, ${pct(s.difficulty.hard, s.trailCount)} hard`,
    loopSplit: `${pct(s.routeType.loop, s.trailCount)} loops against ${pct(
      s.routeType['point-to-point'],
      s.trailCount,
    )} point to point`,
    p2pShare: pct(s.routeType['point-to-point'], s.trailCount),
    surfaceShare: pct(s.surfacedCount, s.trailCount),
    // Read from the provider, never typed: the horizon is the one number on this page a
    // real SuperResProvider is most likely to change, and the section that names it must
    // move with it. See the conditions-model section, which already reads it this way.
    horizonH: String(Math.round(HORIZON_H)),
    // The subdivision-street finding names the Ozarks explicitly, so it must always
    // quote the Ozarks figure, not whichever region the reader happens to be viewing.
    ozarksRoadShare: (() => {
      const o = regionStats('ozarks');
      return pct(o.likelyRoadCount, o.trailCount);
    })(),
    sortCount: String(SORTS.length - 1),

    // ---- the conditions model, for the Conditions model section ----
    // Units-dependent or region-dependent only. Every parameter that is neither (the six
    // weights, the two cuts, the probabilities, the outlook set) is rendered straight from
    // GRADE_MODEL where it is used, because re-keying it through here would add a second
    // place for it to go stale without adding anything.
    heatOnset: formatTemp(GRADE_MODEL.onsets.heatC, units),
    gustOnset: formatSpeed(GRADE_MODEL.onsets.gustKph, units),
    wetSaturation: formatPrecip(g.saturationMm, units),
    outlookWetDay: formatPrecip(GRADE_MODEL.outlook.wetDayMm, units),
    shownCount: String(s.shownCount),
    holdsWaterRange: `${holdLabel(holdLo)} to ${holdLabel(holdHi)}, median ${holdLabel(holdMid)}`,
    dryHalfLifeRange: `${halfLifeH(holdLo)} h to ${halfLifeH(holdHi)} h`,
  };
}

// Order is the argument. The page opens on the results list, because the list IS the
// thesis: conditions ranking and filtering, on the screen where discovery happens. Search
// comes late, as the way you scope that list, not as the way the story starts.

const SECTIONS: SectionSpec[] = [
  {
    id: 'card',
    kicker: 'Positioning',
    title: 'Conditions on the results card',
    phoneState: { screen: 'results', view: 'list' },
    body: [
      lede(
        'AllTrails ranks discovery by popularity and is weather-blind. SnowCast is ' +
          'condition-first, resorts and winter only.',
      ),
      quote(
        'Trail discovery where conditions are a first-class ranking and filter dimension, not a ' +
          'detail-page afterthought.',
      ),
      ul(
        [strong('Terrain is the hero, '), 'in place of the photo open data does not have.'],
        [
          strong('The pill replaces the stars: '),
          '"Good until 13:00" is about today, 4.6 stars is forever.',
        ],
        [
          strong('Difficulty is computed. '),
          'NPS rating from gain and length: ',
          dyn('diffDist', 'easy, moderate, hard'),
          '.',
        ],
      ),
    ],
  },
  {
    id: 'ranking',
    kicker: 'Rank and filter',
    title: 'Sort order: conditions first',
    phoneState: { screen: 'results', view: 'list', hint: 'sort' },
    body: [
      lede(
        'Best conditions is the default sort, for whichever day is picked: the header restates it. Conditions also lead the chip row, ahead of effort and character.',
      ),
      ul([
        strong('Below treeline and shaded are terrain facts, exact at any range. '),
        dyn('treelineNote', 'Exposure is measured against the local treeline.'),
      ]),
      note(
        'Finding',
        p(
          strong('There is no honest popularity sort in open data. '),
          'AllTrails ranks on reviews and completions. Conditions rank from day one; popularity has to be earned.',
        ),
      ),
    ],
  },
  {
    id: 'horizon',
    kicker: 'Super Resolution',
    title: 'The forecast horizon',
    phoneState: { screen: 'results', view: 'list', hint: 'horizon' },
    body: [
      lede('Super Resolution: +', dyn('horizonH', '36'), ' h, hourly, CONUS only. Scrub the day bar.'),
      ul(
        [strong('Inside the horizon: '), 'this route, this hour.'],
        [strong('Past it: '), 'this area, this day. Coarser, still ranked, never invented.'],
      ),
      note(
        'For the build decision',
        p(
          'Weekend planning is not served at MVP. Build the UI to say so, and treat a longer horizon as a product requirement.',
        ),
      ),
    ],
  },
  {
    id: 'conditions-map',
    kicker: 'Map view',
    title: 'Colour by condition',
    phoneState: { screen: 'results', view: 'map' },
    body: [
      lede(
        'The map section colours trails by ',
        em('source'),
        '. This one colours them by ',
        em('condition'),
        '.',
      ),
      ul(
        [
          strong('Storms: '),
          'ridges go amber, valleys stay green. The split is elevation, and after rain it moves to drainage.',
        ],
        [
          strong('Five points per route. '),
          'One trailhead point is the SnowCast model, and the danger is on the ridge.',
        ],
      ),
    ],
  },
  {
    id: 'trail',
    kicker: 'Trail detail',
    title: 'Verdict and drivers',
    phoneState: { screen: 'peek' },
    body: [
      lede('Tapping a trail leads with what today is like, in words, then what drives it.'),
      ul([
        strong('Ratings, photos and comments are the cold-start plan: '),
        'the only way to close the curation gap, and the only route to a Top rated sort.',
      ]),
      caveat('Sample data', p('Seeded ratings and comments are fabricated.')),
    ],
  },
  {
    id: 'search',
    kicker: 'Search',
    title: 'Resolving places and trail names',
    phoneState: { screen: 'search', view: 'list' },
    body: [
      lede('One field resolves to places (park, forest, state, town, peak) and to trail names.'),
      ul([
        strong('Chips would force nonsense: '),
        'a state, then a park inside it, then a forest that is not. Shortcuts do it in one tap, from ',
        dyn('assumedLocation', 'the trailhead town'),
        '.',
      ]),
    ],
  },
  {
    id: 'under-the-hood',
    kicker: 'Methodology',
    title: 'Simulated weather, real terrain',
    body: [
      lede(
        'Weather is simulated behind the interface the live API implements; the weighting is my judgement, not a forecast. Every per-trail difference is terrain.',
      ),
      ul([
        strong('Terrain is real: '),
        dyn('wayCount', 'named'),
        ' OSM ways in ',
        dyn('regionName', 'this region'),
        ' merged into ',
        dyn('trailCount', 'the'),
        ' trails, with the merge code the map section ships.',
      ]),
      note(
        'What the data turned up',
        p(
          strong('The highway filter does not find trails: '),
          'in the Ozarks ',
          dyn('ozarksRoadShare', 'a large share'),
          ' of named features are subdivision streets. A national build needs a classifier.',
        ),
        p(
          strong('Loops are rare '),
          '(',
          dyn('loopSplit', 'mostly point to point'),
          ') and surface tagging is uneven (',
          dyn('surfaceShare', 'a minority'),
          ' tagged here, and it is the untagged remainder that constrains a wetness model, ',
          'since those fall back to one hedged drainage value).',
        ),
        p(
          strong('The estimated time is quoted one way. '),
          'Open data gives a trail two ends but no record of whether a walker returns, which is ',
          'also why the app detects loop or point-to-point only: out-and-back is a fact about how ',
          'someone walks the line, not about the line itself. On the ',
          dyn('p2pShare', 'point-to-point majority'),
          ' of trails that are point to point, the card and the peek label the time rather than ',
          'doubling it, because the return leg carries no climb and doubling would overstate the ',
          'outing.',
        ),
      ),
    ],
  },
  // The one dense section on the page, deliberately, and the only one with tables. It sits
  // after Methodology because Methodology establishes which half of the grade is real, and
  // this is the detail of how the two halves combine. It drives no phone state: it is a
  // reference block about the model, not a walkthrough of a screen, and giving it the peek
  // state would have put two sections in the running for the same screen on reverse sync.
  {
    id: 'grade-model',
    kicker: 'Conditions model',
    title: 'Six weighted penalties, two thresholds',
    body: [
      lede(
        'Each term charges a penalty against the route, the penalties sum, and two cuts turn the total into Good, Mixed or Poor. The total itself is never shown.',
      ),
      p(
        'The forecast is sampled at ',
        String(ROUTE_SAMPLE_POINTS),
        ' points spaced along the route at their real elevations, which is what makes the grade route-specific rather than a trailhead reading. Everything in the ',
        em('drives'),
        ' column below that is terrain is computed from the derived data; everything that is weather comes from the provider and is simulated.',
      ),
      tbl(
        ['Term', 'Weight', 'What drives it'],
        [
          [
            'Storm',
            String(GRADE_MODEL.weights.storm),
            'Thunder probability over the window the route occupies, leaning on the peak rather than the mean, and floored by the day\'s own peak.',
          ],
          [
            'Exposure',
            String(GRADE_MODEL.weights.exposure),
            'Share of the profile above the regional treeline, times the hazard there is to be unsheltered in: convection first, then gusts, then unshaded sun.',
          ],
          [
            'Wetness',
            String(GRADE_MODEL.weights.wetness),
            'Antecedent rain, dried down over the hours before the start, times how badly this route holds water.',
          ],
          [
            'Heat',
            String(GRADE_MODEL.weights.heat),
            h(
              'span',
              {},
              'Temperature at route elevation above ',
              dyn('heatOnset', 'the onset'),
              ', times sun load from shade and cloud, times effort from gain and duration.',
            ),
          ],
          [
            'Wind',
            String(GRADE_MODEL.weights.wind),
            h('span', {}, 'Gusts above ', dyn('gustOnset', 'the onset'), ', amplified on the exposed share.'),
          ],
          [
            'Daylight',
            String(GRADE_MODEL.weights.daylight),
            'Modelled duration for the chosen traversal against the daylight the day has left.',
          ],
        ],
        [1],
      ),
      ul(
        [
          strong(
            `Good at or below ${GRADE_MODEL.levelCuts.primeMax}, Mixed at or below ${GRADE_MODEL.levelCuts.mixedMax}, Poor above it. `,
          ),
          'Daylight carries the highest weight because finishing in the dark is the one failure mode that is certain rather than probabilistic, and its shortfall term alone clears the Good cut: a route that does not fit the day cannot grade Good.',
        ],
        [
          h(
            'strong',
            {},
            `Storms are stated from ${formatPercent(GRADE_MODEL.onsets.stormProb)} thunder probability up. `,
          ),
          'A hazard that falls outside the plan window still counts, at ',
          formatPercent(GRADE_MODEL.dayWideWeight),
          ' of its weight, because the pill answers what the trail is like on the day, not in the next two hours.',
        ],
        [
          h(
            'strong',
            {},
            `A window has to average ${formatPercent(GRADE_MODEL.windowUsable)} usability to be offered at all. `,
          ),
          'Set low on purpose: "no usable window today" is a strong claim and should stay rare. On any day but today the grade assumes a ',
          formatHourOfDay(GRADE_MODEL.typicalStartHour),
          ' start rather than the best hour, because grading at the optimum would flatter every route and flatten the list.',
        ],
        [
          strong('Heat is the one term that runs the other way. '),
          'Under a normal lapse rate it makes a long low unshaded route worse than a short high one, which is the inverse of storm and exposure, and is why switching scenario reranks the list instead of recolouring it.',
        ],
      ),
      sub('Ground and soil'),
      p(
        'The wetness term is the one place where terrain does most of the work. How badly a route holds water is a single route-level multiplier built from three facts, then clamped: the OSM ',
        em('surface'),
        ' tag as a drainage proxy, the steepest sustained grade (steep ground drains, and caps how much of a route can be holding water at all), and the share of the profile that is close to flat (flat ground ponds).',
      ),
      tbl(
        ['OSM surface value', 'Holds water'],
        GRADE_MODEL.ground.surfaceHold.map((r) => [r.surfaces, holdLabel(r.hold)]),
        [1],
      ),
      p(
        dyn('surfaceShare', 'A majority'),
        ' of trails in ',
        dyn('regionName', 'this region'),
        ' carry a surface tag. The rest fall to a hedged ',
        UNTAGGED_HOLD,
        ', which is a refusal to guess rather than a measurement, and it is the row a national build would want to shrink. Across the ',
        dyn('shownCount', 'many'),
        ' trails the list shows, the multiplier runs ',
        dyn('holdsWaterRange', 'a narrow range'),
        '.',
      ),
      p(
        'Antecedent rain is the 72 hour total the provider contract requires, at each sample point. It decays with a half life of ',
        String(GRADE_MODEL.ground.dryHalfLifeBaseH),
        ' h plus ',
        String(GRADE_MODEL.ground.dryHalfLifeGainH),
        ' h per unit of the multiplier, which on this region\'s trails is ',
        dyn('dryHalfLifeRange', 'about a day'),
        '. Rain that falls before the start is added in full, most of what falls during the walk is added too, and the term saturates at ',
        dyn('wetSaturation', 'a wet day'),
        ' of effective water, so a wet enough day maxes it out whatever the surface.',
      ),
      sub(`Past ${HORIZON_H} hours`),
      p(
        'The same shape runs on a separate, smaller set of weights over four regional terms averaged across the sample points: storm ',
        String(GRADE_MODEL.outlook.weights.storm),
        ', heat ',
        String(GRADE_MODEL.outlook.weights.heat),
        ', wetness ',
        String(GRADE_MODEL.outlook.weights.wetness),
        ', wind ',
        String(GRADE_MODEL.outlook.weights.wind),
        ', cut at ',
        String(GRADE_MODEL.outlook.levelCuts.primeMax),
        ' and ',
        String(GRADE_MODEL.outlook.levelCuts.mixedMax),
        '. A wet day is ',
        dyn('outlookWetDay', 'a day of rain'),
        ' across the area and storms are stated from ',
        formatPercent(GRADE_MODEL.outlook.stormOnset),
        '.',
      ),
      p(
        'Every terrain term is gone, on purpose: exposure, drainage, steepness and duration are all judgements a coarse regional outlook is not entitled to make. Lower weights across the board follow from the same reasoning, since a call made without those terms should be slower to condemn a day. There is no hour and no window, and the score is quantised to one value per level, so the conditions sort visibly falls through instead of inventing an order.',
      ),
      caveat(
        'What the model does not do',
        p(
          strong('No snow and no winter ground state. '),
          'Summer only, which matches where the science team has a working prototype and not where it does not.',
        ),
        p(
          strong('No aspect and no shade term. '),
          'Shade is proxied by the regional treeline alone, so a north-facing forest and a south-facing one are the same route to the model.',
        ),
        p(
          strong('The drainage multiplier is route-level, '),
          'because OSM carries one surface value for a whole trail. Two genuinely different surfaces on one trail are indistinguishable, whatever the forecast does.',
        ),
        p(strong('No freeze-thaw, '), 'so shoulder-season mud is not modelled at all.'),
        p(
          strong('The weights are my judgement. '),
          'I tuned them until the four scenarios reranked the list in ways I could defend trail by trail. Nothing here is calibrated against observed conditions, and that is the least defensible part of the model.',
        ),
      ),
    ],
  },
  {
    id: 'grade-next',
    kicker: 'Proposal',
    title: 'What I would add, cheapest first',
    body: [
      lede(
        'None of this is built. Ordered by what it costs to try, which is not the same order as how much it would improve the grade.',
      ),
      sub('Cheap'),
      ul(
        [
          strong('Aspect and shade, from slope azimuth plus sun position. '),
          'The pipeline already samples the terrain tiles for every profile point and throws the azimuth away. This is the one wanted term open data can support today, and it would move both the heat term and the drying rate.',
        ],
        [
          strong('Finer wetness bands. '),
          'Measured in trail mode: ground water swings about 60 percent along a single route and never crosses a plain-language band, so the ground word reads constant while the number moves. That is a presentation choice, not a data limit.',
        ],
        [
          strong('Freeze-thaw for shoulder season. '),
          'Needs the overnight temperature history the forecast already carries, plus a threshold. Cheap to add, and I would not trust it without validation.',
        ],
      ),
      sub('Expensive'),
      ul(
        [
          strong('Per-segment surface data. '),
          'Structural: no amount of R&D turns one tag per trail into a per-segment multiplier. This is a trail-data investment, not a science one, and it is the blocker on a genuinely route-specific ground claim.',
        ],
        [
          strong('Weights validated against something other than my judgement. '),
          'Needs observed conditions or user reports at scale against graded routes. Everything above is a hypothesis about how a hiker trades six hazards off.',
        ],
        [
          strong('Winter snow and ground state. '),
          'The science team\'s feasibility response defers this as an open research problem at high level of effort, where warm-season trail wetness already has a working prototype.',
        ],
      ),
    ],
  },
  {
    id: 'phase-2',
    kicker: 'Next',
    title: 'Phase 2: the trail journey',
    body: [
      lede(
        'The on-route weather timeline: "where will I be when it breaks" as one picture. Then offline, navigation, canopy, winter.',
      ),
    ],
  },
];

// ---- chrome control state ---------------------------------------------------------

let region: RegionId = 'rmnp';
let scenario: ScenarioId = 'bluebird';
let units: Units = readUnits();

/**
 * CONNECTION, as hours since the forecast was last fetched. 0 is live.
 *
 * A state, not a screen, so it needs a way in that does not involve unplugging anything:
 * the phone is already offline-first by construction (frozen trail data, a client-side
 * grade, one cached series per trail) and this control is how a reader sees the state that
 * already exists rather than a simulated failure.
 *
 * THE TWO OFFLINE VALUES ARE MEASURED, NOT ROUND. `weather/grade.ts` sizes a day's usable
 * window as `min(dayEnd, horizon) - start` and then reports any shortfall against it as a
 * DAYLIGHT clause ("longer than the day is"), which conflates two different things the
 * moment the horizon lands mid-afternoon rather than past a day's end. Swept across every
 * trail in all three regions and all four scenarios at ages 0 to 28 h (1,220 trail/day
 * grades per age): ages 2 to 12 h put that copy on up to 1,216 of them, and ages of 26 h and
 * up start doing the same to today. Ages between 15 and 24 h are clean at both ends — today
 * is untouched, and tomorrow is a whole regional outlook rather than a squeezed sliver of a
 * day. 16 and 22 sit inside that band with room either side. The defect is in a file this
 * change does not own; the control is pinned to the honest part of the range instead, and
 * the finding is written down here because it will matter to anyone who widens it.
 */
let forecastAgeH = 0;

const CONNECTIONS: { id: string; label: string; hours: number }[] = [
  { id: 'live', label: 'Online', hours: 0 },
  { id: 'off16', label: 'Offline 16 h', hours: 16 },
  { id: 'off22', label: 'Offline 22 h', hours: 22 },
];

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let autoAdvance = !reducedMotion;

let phone: PhoneHandle;
// The element mountPhone() was given as its container ('#phone-mount'). Kept so the
// reverse-sync observer (below) has something to watch once handover happens.
let phoneMountEl: HTMLElement | null = null;

function currentPhoneOpts(): {
  region: RegionId;
  scenario: ScenarioId;
  units: Units;
  forecastAgeH: number;
} {
  return { region, scenario, units, forecastAgeH };
}

// ---- segmented control builder ----------------------------------------------------

function segmented<T extends string>(
  options: { id: T; label: string }[],
  active: T,
  onPick: (id: T) => void,
): HTMLElement {
  const seg = h('div', { class: 'seg' });
  const buttons = options.map((opt) => {
    const btn = h(
      'button',
      { type: 'button', class: opt.id === active ? 'on' : '' },
      opt.label,
    ) as HTMLButtonElement;
    btn.setAttribute('aria-pressed', String(opt.id === active));
    return btn;
  });
  buttons.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b, j) => {
        b.classList.toggle('on', j === i);
        b.setAttribute('aria-pressed', String(j === i));
      });
      onPick(options[i].id);
    });
  });
  seg.append(...buttons);
  return seg;
}

// ---- the sticky rail: phone + fidelity chip + chrome controls --------------------

function buildRail(): {
  phoneCol: HTMLElement;
  showAutoAdvanceStopped: () => void;
} {
  const phoneStatus = h(
    'div',
    { class: 'phone-status' },
    h('span', { class: 'ps-time' }, '9:41'),
    h('span', { class: 'ps-glyphs' }, h('span', {}), h('span', {}), h('span', {})),
  );
  const phoneScreen = h('div', { class: 'phone-screen', id: 'phone-mount' });
  phoneMountEl = phoneScreen;
  const phoneHome = h('div', { class: 'phone-home' });
  const phoneInner = h('div', { class: 'phone-inner' }, phoneStatus, phoneScreen, phoneHome);
  const phoneFrame = h('div', { class: 'phone-frame' }, phoneInner);

  const regionSeg = segmented(
    REGIONS.map((r) => ({ id: r.id, label: r.label })),
    region,
    (id) => {
      region = id;
      phone.update({ region });
      hydrateNumbers(docNumbers(region, units));
    },
  );

  const scenarioBlurbEl = h('div', { class: 'scenario-blurb' }, SCENARIOS[0].blurb);
  const scenarioSeg = segmented(
    SCENARIOS.map((s) => ({ id: s.id, label: s.label })),
    scenario,
    (id) => {
      scenario = id;
      const found = SCENARIOS.find((s) => s.id === id);
      scenarioBlurbEl.textContent = found ? found.blurb : '';
      phone.update({ scenario });
    },
  );

  const connectionSeg = segmented(
    CONNECTIONS.map((c) => ({ id: c.id, label: c.label })),
    CONNECTIONS[0].id,
    (id) => {
      forecastAgeH = CONNECTIONS.find((c) => c.id === id)?.hours ?? 0;
      phone.update({ forecastAgeH });
    },
  );

  const unitsSeg = segmented(
    [
      { id: 'metric' as Units, label: 'Metric' },
      { id: 'imperial' as Units, label: 'Imperial' },
    ],
    units,
    (id) => {
      units = id;
      writeUnits(units);
      phone.update({ units });
      hydrateNumbers(docNumbers(region, units));
    },
  );

  // Reduced-motion readers never get scroll-linked driving in the first place, so the
  // note (and the "Show me" chips it refers to) are visible from the start for them.
  const autoAdvanceNote = h(
    'div',
    { class: 'auto-advance-note', hidden: !reducedMotion },
    'The phone now drives the story: navigate it and the prose follows. Use "Show me" to jump it yourself.',
  );

  const ctlRail = h(
    'div',
    { class: 'ctl-rail' },
    h('div', { class: 'ctl-group' }, h('div', { class: 'ctl-label' }, 'Region'), regionSeg),
    h(
      'div',
      { class: 'ctl-group' },
      h('div', { class: 'ctl-label' }, 'Scenario'),
      scenarioSeg,
      scenarioBlurbEl,
    ),
    h('div', { class: 'ctl-group' }, h('div', { class: 'ctl-label' }, 'Units'), unitsSeg),
    // Beside the other chrome controls and not on the frame, per the rule that everything
    // inside the phone reads as a real product: the phone shows the STATE (a data age, a
    // moved horizon wall), and the scaffolding that puts it into that state stays out here.
    h('div', { class: 'ctl-group' }, h('div', { class: 'ctl-label' }, 'Connection'), connectionSeg),
    autoAdvanceNote,
  );

  // Nothing stacks above or below the phone: the controls are a rail beside it,
  // so the frame gets the full viewport height.
  // Controls and phone share ONE sticky wrapper. Two sticky siblings in the grid
  // triggered a Chromium repaint bug that ghosted the prose column behind the rail.
  const rail = h('div', { class: 'scope-rail' }, ctlRail);
  const phoneCol = h('div', { class: 'scope-side' }, rail, phoneFrame);

  const showAutoAdvanceStopped = (): void => {
    autoAdvanceNote.removeAttribute('hidden');
  };

  // Mount the phone once the mount point exists in the DOM.
  phone = mountPhone(phoneScreen, {
    ...currentPhoneOpts(),
    onInteract: handleInteract,
  });

  return { phoneCol, showAutoAdvanceStopped };
}

// ---- interaction handling: stop auto-advance permanently, once -------------------

let onAutoAdvanceStopped: (() => void) | null = null;
let sectionObserver: IntersectionObserver | null = null;

function handleInteract(): void {
  if (!autoAdvance) return;
  autoAdvance = false;
  sectionObserver?.disconnect();
  sectionObserver = null;
  revealShowMeChips();
  onAutoAdvanceStopped?.();
  // The handover: prose driving is fully torn down above, so from here the phone drives
  // the prose instead. See "reverse sync" below for the other half of this.
  beginPhoneDrivesProse();
}

const showMeChips: HTMLButtonElement[] = [];

function revealShowMeChips(): void {
  for (const chip of showMeChips) chip.removeAttribute('hidden');
}

// ---- the document body -------------------------------------------------------------

function buildSection(spec: SectionSpec): HTMLElement {
  const headRow = h(
    'div',
    { class: 'sec-head-row' },
    h('div', { class: 'sec-kicker' }, spec.kicker),
  );

  if (spec.phoneState) {
    const goTo = spec.phoneState;
    const chip = h(
      'button',
      { type: 'button', class: 'show-me', hidden: !reducedMotion },
      'Show me →',
    ) as HTMLButtonElement;
    chip.addEventListener('click', () => {
      // A chip is a manual jump initiated from the prose side; do not let the phone's
      // resulting DOM immediately re-derive a scroll back somewhere else (see the
      // reverse-sync section below for why that can otherwise happen).
      suppressReverseSync();
      phone.goTo(goTo);
    });
    showMeChips.push(chip);
    headRow.appendChild(chip);
  }

  return h(
    'section',
    { class: 'sec', id: spec.id },
    headRow,
    h('h2', {}, spec.title),
    ...spec.body,
  );
}

function buildDoc(): HTMLElement[] {
  const header = h(
    'header',
    { class: 'doc-head' },
    h('div', { class: 'doc-kicker' }, 'TrailScope · product prototype'),
    h('h1', {}, 'Trail Scope'),
    h('p', { class: 'lede' }, strong('Trail discovery ranked by conditions, not popularity.')),
    // TL;DR, deliberately not a .sec so it stays out of the section machinery. A reader
    // who stops here should still have the whole argument.
    h(
      'div',
      { class: 'doc-tldr' },
      h('span', { class: 'note-label' }, 'In short'),
      ul(
        [
          'Open data has geometry, not curation. No photo, no stars. The card leads with terrain and ',
          'conditions, and UGC earns the rest.',
        ],
        [
          'Weather is simulated behind the interface the live API implements. The terrain half of ',
          'every grade is real.',
        ],
      ),
    ),
  );

  const sections = SECTIONS.map(buildSection);
  return [header, ...sections];
}

// ---- scroll spy: drive the phone from the section on screen ----------------------
//
// The contents rail is gone (the prose is now short enough that indexing it would be
// longer than it), so this does one job: while auto-advance is live, put the phone into
// the state the section on screen is talking about. Reduced motion never auto-drives.

function buildScrollSpy(): void {
  if (reducedMotion) return;

  const secs = [...document.querySelectorAll<HTMLElement>('.sec')];
  const specById = new Map(SECTIONS.map((sec) => [sec.id, sec]));

  sectionObserver = new IntersectionObserver(
    (entries) => {
      if (!autoAdvance) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const spec = specById.get((entry.target as HTMLElement).id);
        if (spec?.phoneState) phone.goTo(spec.phoneState);
      }
    },
    { rootMargin: '-20% 0px -70% 0px' },
  );
  for (const sec of secs) sectionObserver.observe(sec);
}

// ---- section tracker: know what's on screen, independent of who is driving ------
//
// Needed once the phone starts driving the prose (below): before scrolling anywhere we
// have to know whether the reader is already looking at the right section, or a
// reverse-scroll would yank them somewhere they already are. Kept separate from
// buildScrollSpy() because it must run under reduced motion too (reverse-driving still
// happens there, it just jumps instead of animating) and it never drives the phone
// itself, so it carries none of the auto-advance-only restrictions.

let currentSectionId: string | null = null;

function buildSectionTracker(): void {
  const secs = [...document.querySelectorAll<HTMLElement>('.sec')];
  const tracker = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) currentSectionId = (entry.target as HTMLElement).id;
      }
    },
    { rootMargin: '-20% 0px -70% 0px' },
  );
  for (const sec of secs) tracker.observe(sec);
}

// ---- reverse sync: once the reader takes the phone, the phone drives the prose ---
//
// The mirror image of buildScrollSpy(). Symmetry the reviewer asked for: before the
// reader touches the phone, scrolling the prose drives it; after, driving the phone
// scrolls the prose. The two must never run at once, which is why this is only ever
// switched on from handleInteract() (or immediately, for reduced-motion readers, who
// never get the forward direction to begin with) and forward driving's own observer is
// unconditionally torn down the moment that happens (see handleInteract above).

interface InferredPhoneState {
  screen: ScreenId;
  view: ViewMode;
  hint?: string;
}

/**
 * TODO(phone contract): PhoneHandle exposes only update/goTo/destroy, with no way to
 * observe its state. This function is a stand-in for a real `phone.observe(cb)` /
 * `phone.getState()` on that contract — everything it does, a real observer would do
 * for free and more reliably. Ask the phone workstream to add one; when it exists,
 * replace this whole function with reading the emitted state and delete the DOM
 * sniffing below.
 *
 * Reads the phone's own rendered markup to recover screen/view/hint, because that is
 * the only channel available without touching src/scope/phone/. Brittle by
 * construction: it depends on class names owned by another workstream (app.ts,
 * list.ts, filters.ts, ui.ts) that could rename or restructure without warning. Kept in
 * this one function, clearly marked, so a breakage is a one-place fix. Never throws:
 * any failure (unrecognised markup, a missing node) falls through to `null`, and the
 * caller treats that exactly like "nothing to sync", never as an error.
 */
function inferPhoneState(mount: HTMLElement): InferredPhoneState | null {
  try {
    const appRoot = mount.querySelector('.phone-app');
    if (!appRoot) return null;

    // A visible bottom sheet is the most specific signal: sort and filters are hints,
    // not screens, and the peek sheet is how a "peek" screen actually shows up in markup
    // (state.screen briefly touches 'map' internally, but nothing here targets it).
    const openSheet = appRoot.querySelector('.sheet-layer:not([hidden]) > .sh');
    const isPeek = openSheet?.classList.contains('sh-peek') ?? false;
    const hint: string | undefined = openSheet?.classList.contains('sh-sort')
      ? 'sort'
      : openSheet?.classList.contains('sh-filters')
        ? 'filters'
        : appRoot.querySelector('.day.on.is-outlook')
          ? 'horizon'
          : undefined;

    const isSearching = appRoot.querySelector('.sfield.is-active') != null;
    const isMap = appRoot.querySelector('.app-body.is-map') != null;

    let screen: ScreenId;
    let view: ViewMode;
    if (isSearching) {
      screen = 'search';
      view = 'list';
    } else if (isPeek) {
      screen = 'peek';
      view = 'map';
    } else if (isMap) {
      screen = 'results';
      view = 'map';
    } else {
      screen = 'results';
      view = 'list';
    }

    return { screen, view, hint };
  } catch {
    return null;
  }
}

/**
 * The section whose `phoneState` best matches what the phone is showing, or null when
 * nothing does (search and peek are never targets; neither is a screen no section
 * declares). Most specific wins: screen+view+hint beats screen+view beats screen alone,
 * and every field the section DOES declare must actually match, not just the leading one.
 */
function matchSection(actual: InferredPhoneState): SectionSpec | null {
  let best: SectionSpec | null = null;
  let bestScore = 0;
  for (const spec of SECTIONS) {
    const goal = spec.phoneState;
    if (!goal) continue;
    if (goal.screen !== actual.screen) continue;
    if (goal.view !== undefined && goal.view !== actual.view) continue;
    if (goal.hint !== undefined && goal.hint !== actual.hint) continue;
    const score = 1 + (goal.view !== undefined ? 1 : 0) + (goal.hint !== undefined ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = spec;
    }
  }
  return best;
}

let phoneDrivesProse = false;
let phoneObserver: MutationObserver | null = null;
let reverseScrollTimer: ReturnType<typeof setTimeout> | null = null;
// Rapid phone interaction (a filter sheet opening, a re-render off a grade fetch, a scrub
// drag) fires many mutations in a burst; settle before reading the DOM, so navigating the
// phone produces one scroll, not a storm of them.
const REVERSE_DEBOUNCE_MS = 220;

// goTo() is deliberately non-destructive (PhoneHandle's contract, see phone/app.ts's
// header): jumping to "card" does not reset a leftover outlook day from an earlier visit
// to "horizon", so the DOM right after a "Show me" tap can still read as the more
// specific section rather than the one the chip actually named. Rather than take that on
// faith, a chip click mutes the reverse direction for one debounce-and-settle window: the
// reader asked to go here from the prose side, so re-deriving "here" from the phone a
// moment later and possibly disagreeing would be exactly the yank this feature must not do.
let suppressReverseSyncUntil = 0;
const REVERSE_SUPPRESS_MS = REVERSE_DEBOUNCE_MS + 400;

function suppressReverseSync(): void {
  suppressReverseSyncUntil = Date.now() + REVERSE_SUPPRESS_MS;
}

/** Scroll the prose to match the phone, unless the reader is already looking at it. */
function driveProseFromPhone(mount: HTMLElement): void {
  if (!phoneDrivesProse) return;
  if (Date.now() < suppressReverseSyncUntil) return;
  const inferred = inferPhoneState(mount);
  if (!inferred) return;
  const spec = matchSection(inferred);
  if (!spec || spec.id === currentSectionId) return;
  const el = document.getElementById(spec.id);
  if (!el) return;
  el.scrollIntoView({
    behavior: reducedMotion ? 'auto' : 'smooth',
    block: 'start',
  });
}

/** Flip the handover switch and start watching the phone's DOM for state changes. */
function beginPhoneDrivesProse(): void {
  if (phoneDrivesProse) return;
  phoneDrivesProse = true;
  if (!phoneMountEl) return;
  const mount = phoneMountEl;

  phoneObserver = new MutationObserver(() => {
    if (reverseScrollTimer !== null) clearTimeout(reverseScrollTimer);
    reverseScrollTimer = setTimeout(() => {
      reverseScrollTimer = null;
      driveProseFromPhone(mount);
    }, REVERSE_DEBOUNCE_MS);
  });
  // attributeFilter to class/hidden: those are what every screen transition above keys
  // off (class swaps for active state, hidden toggles for sheets and the map layer), and
  // narrowing avoids waking the debounce for unrelated attribute churn (e.g. the map).
  phoneObserver.observe(mount, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden'],
  });
  // Don't wait for the first mutation: whatever the phone already shows at handover
  // (the reader may have just tapped a card, not scrubbed anything) gets a chance to
  // scroll the prose too.
  driveProseFromPhone(mount);
}

// ---- boot ---------------------------------------------------------------------------

function boot(): void {
  mountNav('scope');

  const shell = document.getElementById('scope-shell');
  if (!shell) return;

  const { phoneCol, showAutoAdvanceStopped } = buildRail();
  onAutoAdvanceStopped = showAutoAdvanceStopped;

  const docCol = h('article', { class: 'scope-doc' }, ...buildDoc());

  shell.append(phoneCol, docCol);
  buildScrollSpy();
  buildSectionTracker();

  // Interpolate every number in the prose from the derived data, after the document
  // exists. Region and units changes re-run it from their own handlers.
  hydrateNumbers(docNumbers(region, readUnits()));

  if (reducedMotion) {
    revealShowMeChips();
    // Reduced-motion readers never get the forward direction (buildScrollSpy() opts out
    // above), so there is no "first interaction" moment to hand over at: they start
    // already in the post-handover state, same as the note and the chips do.
    beginPhoneDrivesProse();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
