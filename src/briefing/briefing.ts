// Region briefing — the document.
//
// The only section of TrailScope that prints something it did not compute. Every other page in this repo derives what it states, and `src/trail/route.ts`
// records why: a hand-drawn mockup of a weather chart always looks good, because the person
// drawing it picks the numbers. This page breaks that rule once, on purpose, and the whole
// design of the page is the argument for why breaking it here is honest.
//
// WHAT IT ANSWERS. Three questions Björn put in his own words: where is the weather good,
// where is it bad, and what should I do. The first two are spatial, and the third is a
// recommendation rather than a ranking. The conditions digest one page earlier can answer
// none of them, for two separate reasons:
//
//   1. It has no geography. `sampleAt` in `src/scope/weather/scenarios.ts` takes a position
//      and uses it only as deterministic jitter (`hashUnit(lng, lat, absHour)` times a small
//      per-scenario term, plus latitude for sunrise). Temperature, thunder, precipitation
//      and wind are functions of elevation and hour alone, so the simulated field has no
//      horizontal structure to read a briefing out of. Computing one anyway would produce
//      elevation dressed as geography: a page that looks like a spatial forecast and is
//      nothing of the sort. Real Super Resolution at 3 km does have that structure, which is
//      the whole reason it is being built, so the concept is fine and only our fake weather
//      cannot show it.
//   2. Its ranking is not a recommendation. Ordering RMNP purely by conditions on a storm
//      day puts the entire top six under 500 m, because a short route occupies less of the
//      convective window. That is the grade working as designed and useless as advice.
//
// So: a static mockup with sample content, showing what the real thing would look like.
//
// HOW THE PAGE SAYS IT IS A SAMPLE. Once, at the top, and in the browser furniture around
// it: the sticky banner under the top bar, the "(sample mockup)" in the document title, and
// the nav tab's own blurb. Plus the provenance section near the bottom, which is now the only
// place on the page where the real/invented split is stated in words.
//
// IT USED TO BE THREE REDUNDANT LAYERS. A tiled "SAMPLE / NOT A FORECAST" watermark over the
// page and every opaque panel; the banner; and a per-object badge on every element carrying
// an invented value (SAMPLE TEXT, SAMPLE CONDITIONS, SAMPLE) or a measured one (REAL). Björn
// removed the watermark first and then the badges. The reasoning that built them is not
// retracted and is kept in `briefing.css`; what changed is the judgement about how much
// marking a page can carry before the marking is what the page is about.
//
// WHAT THAT COSTS, STATED PLAINLY BECAUSE IT IS NOW TRUE OF EVERY OBJECT HERE. Real trail
// measurements and invented weather sit side by side with nothing at the value level telling
// them apart. A pick card is the sharp case: its length, climb, walking time and high point
// are computed from the committed OSM snapshot and the window beside them was typed by hand,
// and the card no longer says which is which. Any crop that does not include the banner
// carries no indication that anything on it is invented.
//
// The structural half of the separation is untouched and is what a reader of the CODE can
// still rely on: `sample.ts` imports no data and the picks carry a trail ID and no
// measurements, so a number printed on a card cannot have come from the invented half.
//
// WHERE THE HALVES COME FROM. `sample.ts` holds all the fiction and imports no data.
// `model.ts` is the only place the fiction and the derived data touch. The picks name a
// trail by ID and carry no measurements at all, so a length printed on a card cannot have
// come from the invented half, because there is none there to come from.
//
// FORMAT. The `merge.html` document genre, as the digest uses it: `merge.css` for the
// shell, prose top to bottom, figures wider than the prose, nothing sticky but the chrome.
// No phone frame, for the reason the digest states: this is a view of what the data would
// support, not a screen being proposed for build.
//
// NO RISK LANGUAGE, per TRAIL_PLAN §1. No warnings, no "avoid", no hazard naming, no
// warning iconography. That decision was taken for the on-route screen and its cost was
// written down there; it binds harder here, because advice generated from invented weather
// by a prototype is the worst possible place to start giving it.

import '../tokens.css';
// The long-form document genre: `body.doc-page`, `.doc-shell`, `.doc-head`, `.sec`,
// `.tldr`, `.doc-foot`. Imported rather than re-declared so this page, the digest and the
// segment merge page cannot drift apart typographically.
import '../merge/merge.css';
import './briefing.css';

import { mountNav } from '../ui/nav';
import { h } from '../ui/dom';
// Read-only, from the discovery prototype: the icon set (so this page introduces no second
// visual language), the region registry and the unit formatters, and the derived-data
// aggregates for the footer's provenance line.
import { icon } from '../scope/phone/ui';
import { regionStats } from '../scope/data';
import {
  formatDuration,
  formatElevation,
  formatHourOfDay,
  formatLength,
  formatSpeed,
  formatTemp,
  needsOneWayLabel,
} from '../scope/model';
import type { Units } from '../types';
import {
  HOUR_FROM,
  HOUR_TO,
  SAMPLE_AREAS,
  SAMPLE_DAY_LABEL,
  SAMPLE_INTENTS,
  SAMPLE_OVERVIEW,
  SAMPLE_REGION,
  SAMPLE_REGIONAL,
  PLAN_HOUR,
  levelAt,
  turnsAt,
  verifyConsistency,
  type OverviewLine,
  type SampleArea,
  type SampleIntent,
  type SampleLevel,
  type SamplePick,
} from './sample';
import { areaOf, areaRollups, briefedTrailCount, sampleRegionDef, trailById } from './model';
import { planFigure } from './plan';

// ============================================================================
// UNITS — the app-wide key, read and written like every other page
// ============================================================================
//
// `trailscope-units` is the same localStorage key the digest, the merge page and the
// discovery prototype use, so the setting follows a reader across all seven sections.
// Metric is the default here as it is everywhere else in TrailScope.
//
// The toggle has to reach the invented values too, which is why `sample.ts` stores them in
// SI rather than writing "22°C" into the prose: a page where the trail lengths convert and
// the temperature does not is exactly the desync `src/scope/model.ts` was written to
// prevent, and the fact that half the numbers are made up does not exempt them from it.

const UNITS_KEY = 'trailscope-units';

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
    // localStorage unavailable (private browsing): the toggle still works for this load,
    // it just does not follow the reader to the next page.
  }
}

// ============================================================================
// COPY HELPERS — the same small vocabulary the digest and Trail Explorer pages use
// ============================================================================

const p = (...children: (string | Node)[]): HTMLElement => h('p', {}, ...children);
const strong = (t: string): HTMLElement => h('strong', {}, t);
const lede = (...children: (string | Node)[]): HTMLElement =>
  h('p', { class: 'sec-lede' }, ...children);

/** A boxed claim the reader must not skim past. Same object as the digest's. */
const note = (label: string, ...children: (string | Node)[]): HTMLElement =>
  h('div', { class: 'sec-note' }, h('span', { class: 'note-label' }, label), ...children);

function section(id: string, kicker: string, title: string, ...body: (Node | null)[]): HTMLElement {
  return h(
    'section',
    { class: 'sec', id },
    h('div', { class: 'sec-kicker' }, kicker),
    h('h2', {}, title),
    ...body,
  );
}

/**
 * Segmented control, the same shape and `.seg` styling every other page's chrome uses.
 *
 * A third local copy of a nine-line helper, after `src/digest/digest.ts` and
 * `src/scope/doc.ts`. Neither exports it, and a page reaching into another page's module
 * for one control would couple two documents that otherwise share nothing but tokens.
 */
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

const LEVEL_LABEL: Record<SampleLevel, string> = { good: 'Good', mixed: 'Mixed', poor: 'Poor' };

/** Compact hour for a column header. `formatHourOfDay` is the long form, for prose. */
const hourShort = (hour: number): string => String(hour).padStart(2, '0');

/** Pin index of an area, one-based, so the plan, the list and the strips key to each other. */
function pinOf(area: SampleArea): number {
  return SAMPLE_AREAS.findIndex((a) => a.id === area.id) + 1;
}

// ============================================================================
// HEADER + BANNER
// ============================================================================

/**
 * The banner. First element in the document, sticky under the top bar.
 *
 * It says three things in one line, in the order a reader needs them: this is sample
 * content, the weather is invented, the trail data is not. The third clause matters as much
 * as the first two: a blanket "everything here is fake" would throw away the real
 * geography, which is what makes the mockup worth looking at.
 */
function banner(): HTMLElement {
  return h(
    'div',
    { class: 'bf-flag', role: 'note' },
    icon('info', 15),
    h('span', { class: 'bf-flag-mark' }, 'SAMPLE MOCKUP'),
    h(
      'span',
      { class: 'bf-flag-text' },
      // "Nothing here is a forecast" was a third sentence and is dropped: it is what "typed
      // by hand" already means, and the banner is the one object on the page that has to be
      // read in a glance rather than parsed.
      'Every weather value here was typed by hand. Trail data is real.',
    ),
  );
}

/**
 * Kicker, title, one line.
 *
 * THE "IN SHORT" BLOCK IS GONE. Its three bullets were, in order: that the page is a
 * mockup, why it is a mockup, and why the picks are grouped by intent. The first is the
 * banner's job and the banner is one line above it. The second and third are the reasoning
 * behind two design decisions, which is the single largest category of copy this page was
 * carrying and the first thing Björn asked to lose; both are written down at length in
 * `sample.ts` and in this file's header, where a reader who wants the argument can find it
 * and a reader who wants the briefing does not have to step over it.
 */
function header(): HTMLElement {
  return h(
    'header',
    { class: 'doc-head' },
    // Not "TrailScope · region briefing": the h1 says that already, and the one thing a
    // reader needs before the h1 is what kind of document this is.
    h('div', { class: 'doc-kicker' }, 'TrailScope · sample mockup'),
    h('h1', {}, 'Region briefing'),
    h('p', { class: 'lede' }, 'Real geography, sample conditions, one day.'),
  );
}

/** Region, day and units. Not sticky: there is one region and one day to compare against. */
function chrome(units: Units, onUnits: (u: Units) => void): HTMLElement {
  const def = sampleRegionDef();
  const group = (label: string, ...body: Node[]): HTMLElement =>
    h('div', { class: 'bf-ctl' }, h('div', { class: 'bf-ctl-label' }, label), ...body);

  return h(
    'div',
    { class: 'bf-chrome' },
    // The region's `where` clause is off the control: this page names one region and one
    // region only, and "Colorado" beside "Rocky Mountain National Park" was disambiguating
    // nothing.
    group('Region', h('div', { class: 'bf-ctl-value' }, def.name)),
    group('Day', h('div', { class: 'bf-ctl-value' }, SAMPLE_DAY_LABEL)),
    group(
      'Units',
      segmented(
        [
          { id: 'metric' as Units, label: 'Metric' },
          { id: 'imperial' as Units, label: 'Imperial' },
        ],
        units,
        onUnits,
      ),
    ),
  );
}

// ============================================================================
// SECTION 1 — the overview
// ============================================================================

/**
 * One narrative line: glyph, claim, quiet measure.
 *
 * A COPY OF `briefRow` FROM `src/scope/phone/peek.ts`, down to the aria-label shape, and
 * that is the point rather than an accident. Björn asked for the region narrative to use the
 * pattern this app already settled on, and peek's is it: the glyph is `aria-hidden`, so the
 * row carries the line's `kind` as its own name and reads out as "West of the Divide: the
 * Kawuneeche and North Inlet sit upwind and stay clear, to 17:00" rather than as a loose
 * clause, and the measure joins that one utterance instead of being a second focus stop.
 *
 * Rebuilt rather than imported for the reason every borrowed object on this page is: peek's
 * markup renders `.pvb-*` classes that live in `phone.css`, and pulling the discovery app's
 * stylesheet into a document to borrow one row would drag a whole app's styling across.
 * `briefing.css` restates the four rules and says so.
 */
function overviewRow(line: OverviewLine): HTMLElement {
  return h(
    'div',
    {
      class: 'bf-brief-line',
      role: 'listitem',
      'aria-label': line.measure ? `${line.kind}: ${line.text}, ${line.measure}` : `${line.kind}: ${line.text}`,
    },
    icon(line.glyph, 15, 'bf-brief-glyph'),
    h('span', { class: 'bf-brief-text' }, line.text),
    // Absent, not empty, exactly as in peek: a line with no measure renders no node, so
    // nothing reserves width for a column entry that will never arrive.
    line.measure ? h('span', { class: 'bf-brief-measure' }, line.measure) : null,
  );
}

/**
 * The narrative and the regional figures.
 *
 * THE LEDE IS GONE and no replacement was written. It said that one paragraph is the whole
 * answer, that this is the shape the real system would generate from a 3 km field, and that
 * I wrote this one. The first was a claim about the object sitting directly below it, the
 * second is the argument for the page and belongs in `sample.ts` where it is made properly,
 * and the third is the SAMPLE TEXT badge in words.
 *
 * The figure strip lost its trailing paragraph too, which explained that these values are
 * held in SI and travel the app's own converters. True, load-bearing, and a note about the
 * implementation of a unit toggle: `sample.ts` keeps it.
 */
function overviewSection(units: Units): HTMLElement {
  const figures: [string, string][] = [
    ['Valley high', formatTemp(SAMPLE_REGIONAL.valleyHighC, units)],
    ['Tundra high', formatTemp(SAMPLE_REGIONAL.tundraHighC, units)],
    // ONE UNIT ON THE RANGE, NOT TWO. `formatSpeed` returns a number and its unit, so the
    // obvious `${formatSpeed(min)} to ${formatSpeed(max)}` printed "25 km/h to 40 km/h",
    // which states the unit twice for one measurement. The unit is taken off the low end by
    // splitting on the space the formatter puts there rather than by re-deriving the
    // conversion here, so the imperial toggle still goes through exactly one code path and
    // this cannot drift from the rest of the app's speeds.
    [
      'Wind above treeline',
      `${formatSpeed(SAMPLE_REGIONAL.windMinKph, units).split(' ')[0]} to ${formatSpeed(SAMPLE_REGIONAL.windMaxKph, units)}`,
    ],
    // "Storms over the Divide 13:00" used to be a fourth figure here. It is the crest line's
    // own measure, one object up the page, and printing an hour twice is exactly the
    // restatement this pass was cutting. `SAMPLE_REGIONAL.stormOnsetHour` still defines it.
  ];

  return section(
    'overview',
    'Synthesis',
    'The sample day, region wide',
    h(
      'div',
      { class: 'bf-overview' },
      // The panel is the narrative and nothing else now. It used to open with a head row
      // carrying the day label and a SAMPLE TEXT badge; the day label was the chrome's, three
      // objects up, and the badge is gone with the rest of them.
      //
      // A real list to a screen reader, as peek's is. Five loose divs read as one run-on
      // paragraph, which is the shape this block just stopped being.
      h('div', { class: 'bf-brief', role: 'list' }, ...SAMPLE_OVERVIEW.map(overviewRow)),
    ),
    h(
      'div',
      { class: 'bf-figures' },
      ...figures.map(([k, v]) =>
        h(
          'div',
          { class: 'bf-figure' },
          h('div', { class: 'bf-figure-k' }, k),
          h('div', { class: 'bf-figure-v' }, v),
        ),
      ),
    ),
  );
}

// ============================================================================
// SECTION 2 — where the day is good, and when it turns
// ============================================================================
//
// THIS USED TO BE TWO SECTIONS. "Geography" carried the plan figure plus a five-row list of
// areas (pin, name, where it sits, three example trail names, its level at 14:00, its trail
// count); "Detail" carried the same five areas again as hour strips. Two objects, one row
// per area each, stacked 2,300 px apart, and the second was a superset of the first: a strip
// that draws every hour states the level at 14:00 as one of its cells.
//
// Merged, the row is pin, name, count and the whole day. What was dropped in the merge is
// the area's `where` clause and its example trail names. The `where` clause survives as the
// row's title attribute, because the narrative above now opens each line with its place
// ("West of the Divide", "East moraines") and the plan draws the rest. The example names
// were the nicest thing on the old list and are the clearest loss in this pass; the trail
// COUNT is what carried the actual claim, which is that real trails attach to invented
// areas, and it stays.

/**
 * The five areas: pin, name, real trail count, and the level at every hour of the day.
 *
 * ORDERED BY WHEN THE DAY STOPS BEING GOOD, earliest first, so the figure staircases and the
 * narrative's "tracking east" has a picture. Geographic order would put the west side in the
 * middle and flatten it. The pin numbers are what tie this order back to the plan's.
 */
function stripsFigure(): HTMLElement {
  const hours: number[] = [];
  for (let hour = HOUR_FROM; hour <= HOUR_TO; hour++) hours.push(hour);

  const rows = areaRollups()
    .slice()
    .sort((a, b) => (turnsAt(a.area) ?? 99) - (turnsAt(b.area) ?? 99));

  const grid = h('div', { class: 'bf-strip-grid' });
  grid.style.setProperty('--bf-hours', String(hours.length));

  grid.appendChild(h('div', { class: 'bf-strip-corner' }));
  for (const hour of hours) {
    // A TICK EVERY THREE HOURS, plus the last one, which is the digest's own rule for its
    // window strips and for the same reason: fifteen labels over fifteen 26 px columns is a
    // wall of numerals that reads as texture rather than as an axis, and the reader's actual
    // question is which third of the day a cell sits in. Unticked hours still render their
    // cell and still carry the full "area, hour, level" title.
    const tick = (hour - HOUR_FROM) % 3 === 0 || hour === HOUR_TO;
    grid.appendChild(h('div', { class: 'bf-strip-hour' }, tick ? hourShort(hour) : null));
  }

  for (const row of rows) {
    grid.appendChild(
      h(
        'div',
        // The `where` clause, off the page and onto the row it describes. Real geography, so
        // it is worth keeping addressable even when it is not worth a rendered line.
        { class: 'bf-strip-name', title: `${row.area.name}, ${row.area.where}` },
        h('span', { class: `bf-area-n lv-${row.level}` }, String(pinOf(row.area))),
        h('span', { class: 'bf-strip-label' }, row.area.name),
        h('span', { class: 'bf-strip-count' }, String(row.trails.length)),
      ),
    );
    for (const hour of hours) {
      const level = levelAt(row.area, hour);
      grid.appendChild(
        h('div', {
          class: `bf-cell lv-${level}`,
          title: `${row.area.name}, ${formatHourOfDay(hour)}: ${LEVEL_LABEL[level]} (sample)`,
        }),
      );
    }
  }

  return h('div', { class: 'bf-strips' }, grid);
}

function areasSection(): HTMLElement {
  const plan = planFigure();
  const west = areaRollups().find((r) => r.area.id === 'kawuneeche');

  const legend = h(
    'div',
    { class: 'bf-legend' },
    ...(['good', 'mixed', 'poor'] as SampleLevel[]).map((level) =>
      h('span', { class: 'bf-leg' }, h('i', { class: `bf-swatch lv-${level}` }), LEVEL_LABEL[level]),
    ),
    h('span', { class: 'bf-leg' }, h('i', { class: 'bf-swatch divide' }), 'Divide, sketched'),
  );

  return section(
    'areas',
    'Geography',
    'Where it is good, and when it turns',
    h(
      'figure',
      { class: 'bf-fig' },
      h(
        'div',
        { class: 'bf-fig-head' },
        h('span', { class: 'bf-fig-title' }, `The network at ${formatHourOfDay(PLAN_HOUR)}`),
        // This figure is the page's real/invented seam drawn in a single picture: the lines
        // are merged OSM geometry and the colours are typed. It used to carry a badge for
        // each half. Both are gone, and the provenance section is where the distinction is
        // now made.
      ),
      plan.node,
      legend,
      // The one figure caption on the page, kept to the two facts a reader cannot see: what
      // a line is, and what an area boundary is not.
      h(
        'figcaption',
        {},
        `Each of the ${plan.drawn} trails here, coloured by its nearest of five hand-placed ` +
          'centres. No boundary was surveyed.',
      ),
    ),
    h(
      'div',
      { class: 'bf-fig' },
      h(
        'div',
        { class: 'bf-fig-head' },
        // No hour range in the title: the axis under it starts at 05 and ends at 19.
        h('span', { class: 'bf-fig-title' }, 'The day by area'),
        h('span', { class: 'bf-fig-note' }, 'Taller is better; the count is real trails.'),
      ),
      stripsFigure(),
    ),
    // The one caveat on the page that changes how a number should be read, so it keeps its
    // box while the four other notes this section and the next one carried were deleted.
    note(
      'The west side is thin',
      p(
        'Only ',
        strong(`${west?.trails.length ?? 0} of ${briefedTrailCount()} trails`),
        ' fall west of the Divide. The snapshot bbox thins out there, not the park.',
      ),
    ),
  );
}

// ============================================================================
// SECTION 4 — what to do
// ============================================================================

/**
 * How many trails each intent shows.
 *
 * ONE, DOWN FROM TWO, AND THIS IS THE ONE JUDGEMENT CALL IN THIS PASS THAT CUT CONTENT
 * RATHER THAN COPY. Eight cards were 288 of the page's 845 rendered words, and no amount of
 * editing gets a card below about 33: the name, four real measurements, the REAL badge, a
 * window, the SAMPLE badge and a reason are all load-bearing, and the two badges are the
 * marking the removed watermark handed its job to. Eight of them cannot coexist with a
 * 500-word page. Four intents each answered once still is what the section promises: a
 * recommendation per kind of day, with a reason.
 *
 * The second pick of each intent is still in `sample.ts`, written and consistent with the
 * grids. Restoring it is this constant, and costs about 130 words.
 */
const PICKS_PER_INTENT = 1;

/**
 * One pick, headed by the intent it answers.
 *
 * THE CARD IS THE SPLIT, AND NO LONGER SHOWS IT. The name, the measurements and the area all
 * come from the derived data through `trailById`; the intent, the window and the reason come
 * from `sample.ts`. They used to carry a REAL and a SAMPLE badge respectively, which made a
 * single card legible on its own. Without them this is the most exposed object on the page:
 * a computed 12.4 km and a typed "Clear to 14:00" two rows apart with nothing between them.
 * The split is still structural in the code and still stated in the provenance section.
 *
 * THE INTENT MOVED INSIDE THE CARD. It used to be a titled block above a row of cards, which
 * is the right shape for two or more picks and pure overhead for one: a heading, a rule and
 * 14 px of margin to introduce a single object sitting directly under it. As the card's own
 * overline it costs nothing and the four intents read as a set of four answers.
 */
function pickCard(intent: SampleIntent, pick: SamplePick, units: Units): HTMLElement | null {
  const trail = trailById(pick.trailId);
  // A stale ID costs one card, not the page. See `trailById`.
  if (!trail) return null;

  const area = areaOf(trail);
  const level = areaRollups().find((r) => r.area.id === area.id)?.level ?? 'good';

  return h(
    'article',
    { class: 'bf-pick' },
    h(
      'div',
      { class: 'bf-pick-intent' },
      h('span', { class: 'bf-intent-label' }, intent.label),
      h('span', { class: 'bf-intent-blurb' }, intent.blurb),
    ),
    h('h3', { class: 'bf-pick-name' }, trail.name),
    h(
      'div',
      { class: 'bf-pick-meta' },
      h('span', {}, formatLength(trail.lengthM, units)),
      h('span', {}, `${formatElevation(trail.gainM, units)} up`),
      h(
        'span',
        {},
        formatDuration(trail.estMinutes),
        needsOneWayLabel(trail.routeType) ? ' one way' : null,
      ),
      // Kept where the other three measures were trimmed, because one of the four intents is
      // "below treeline" and this is the number that answers it.
      h('span', {}, `${formatElevation(trail.maxElevM, units)} high`),
      // The area, folded into the measures row rather than taking a line of its own under
      // it. It is the pin number from the plan and the strips, so it is a two-character
      // cross-reference, and it sat on a full-width row that also spelled out the area name
      // (already in the figure), the surface tag and whether there was one. The surface tag
      // is gone: it is the only measure on the card that decided nothing on this page.
      h('span', { class: 'bf-pick-area', title: area.name }, `Area ${pinOf(area)}`),
    ),
    h(
      'div',
      { class: `bf-pick-window lv-${level}` },
      icon('clock', 14),
      h('span', {}, pick.window),
    ),
    h('p', { class: 'bf-pick-reason' }, pick.reason),
  );
}

/**
 * The four intent groups.
 *
 * THREE OBJECTS WERE DELETED HERE and all three were arguments rather than content. A boxed
 * note, "Why not just rank by conditions", spent about a hundred words on the finding that
 * the digest's conditions ranking puts the whole RMNP top six under 500 m on a storm day,
 * plus a paragraph on why a fifth group is absent. A closing paragraph explained that the
 * measurements are real and the treeline is the grader's own, which is what the REAL badge
 * on every card says. And each group's own blurb ended by explaining the grouping again.
 * `sample.ts` holds the ranking argument in full.
 *
 * What is left is the lede's one line, which is the only part a reader of the briefing needs
 * in order to use the section: conditions decide within a group, not across all of them.
 */
function picksSection(units: Units): HTMLElement {
  const cards = SAMPLE_INTENTS.flatMap((intent) =>
    intent.picks
      .slice(0, PICKS_PER_INTENT)
      .map((pick) => pickCard(intent, pick, units))
      // `pickCard` returns null for an ID the derived data no longer carries; the section
      // renders one card short rather than the page rendering none.
      .filter((card): card is HTMLElement => card !== null),
  );

  return section(
    'picks',
    'Recommendations',
    'Grouped by intent',
    lede('Conditions decide within a group, not across it.'),
    h('div', { class: 'bf-picks' }, ...cards),
  );
}

// ============================================================================
// SECTION 5 — provenance
// ============================================================================
//
// IT WAS THE SECOND LONGEST SECTION ON THE PAGE and is now the shortest. It carried the two
// columns below plus three paragraphs under a "Why it could not be computed" heading, plus a
// boxed note listing the three things that would have to change. All of it was true and none
// of it was needed here: the per-value badges already answer the question this section
// exists for, on every object, at the exact granularity a reader cares about, and they do it
// where the value is rather than 4,000 px below it. The argument about the simulated field
// having no horizontal structure is written out in full in `sample.ts`'s header and in this
// file's, which is where a reader who wants it will be.
//
// The two columns stay because they answer something the badges cannot: what is real and
// invented ACROSS the page, in one place, including the parts of it that carry no badge
// because they are not values (the area boundaries, the sketched Divide, the choice of which
// trail answers which intent).

function provenanceSection(units: Units): HTMLElement {
  const stats = regionStats(SAMPLE_REGION);
  const def = sampleRegionDef();

  const column = (cls: string, head: string, items: string[]): HTMLElement =>
    h(
      'div',
      { class: `bf-split-col ${cls}` },
      h('div', { class: 'bf-split-head' }, head),
      h('ul', {}, ...items.map((t) => h('li', {}, t))),
    );

  return section(
    'provenance',
    'Method',
    'Real and invented',
    h(
      'div',
      { class: 'bf-split' },
      column('real', 'Real', [
        `${stats.shownCount} trails, ${stats.wayCount} OpenStreetMap ways.`,
        'Every name and measurement.',
        `Every line in the plan; the ${formatElevation(def.treelineM, units)} treeline.`,
      ]),
      column('invented', 'Invented', [
        'Every weather value, hour and window.',
        'The narrative, the areas, the sketched Divide.',
        'Which trail answers which intent.',
      ]),
    ),
  );
}

/**
 * Attribution, and one line on what the weather is.
 *
 * No `units` parameter any more. The footer used to close with the treeline in the reader's
 * chosen units, which the provenance columns two objects above it already print; it was the
 * last of five restatements of "this is not a forecast" that this footer was carrying.
 */
function footer(): HTMLElement {
  const stats = regionStats(SAMPLE_REGION);
  return h(
    'footer',
    { class: 'doc-foot' },
    p(
      `Trail geometry: OpenStreetMap contributors, ODbL. ${stats.wayCount} ways, ${stats.trailCount} ` +
        `clusters, ${stats.shownCount} shown, ${stats.fetchedAt.slice(0, 10)}. ${stats.elevationSource}.`,
    ),
    // The attribution line above is required and stays whole. This one is down to its claim:
    // the three sentences it replaces said "not simulated", "not forecast", "typed by hand",
    // "invented" and "describes no day" between them, which is one fact five times, under a
    // banner that opens the page with the same fact.
    p('Weather here was typed by hand and describes no day, past or future.'),
  );
}

// ============================================================================
// PAGE STATE
// ============================================================================

let units: Units = readUnits();

function bodyEl(): HTMLElement | null {
  return document.getElementById('bf-body');
}

/**
 * Rebuild everything below the chrome.
 *
 * Units never touch the content: the sample is SI at rest and the formatters convert at
 * render time, so this rewrites strings and nothing else.
 */
function renderBody(): void {
  const host = bodyEl();
  if (!host) return;
  host.replaceChildren(
    overviewSection(units),
    // The old `timingSection` is gone: its hour strips are the second figure inside
    // `areasSection` now. See SECTION 2's header for why the two were one thing all along.
    areasSection(),
    picksSection(units),
    provenanceSection(units),
    footer(),
  );
}

// ============================================================================
// BOOT
// ============================================================================

function boot(): void {
  mountNav('briefing');

  const root = document.getElementById('briefing-root');
  if (!root) return;

  // Throws if a clock time in the overview paragraph disagrees with the area hour grids.
  // Better a blank page in development than a wrong claim in a deck.
  verifyConsistency();

  root.append(
    banner(),
    header(),
    chrome(units, (picked) => {
      units = picked;
      writeUnits(units);
      renderBody();
    }),
    h('div', { id: 'bf-body' }),
  );
  renderBody();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
