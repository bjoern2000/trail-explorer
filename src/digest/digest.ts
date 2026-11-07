// Regional conditions digest — the document.
//
// The sixth section of TrailScope, and the first one that looks at the grades in
// aggregate. Every other page asks about one thing: one source, one merge, one trail, one
// results list. This one asks what a whole region is doing across a whole week, which is
// the question review feedback actually raised ("a narrative for a region about what the
// best trails are and when to go"), and it is answerable only because the discovery
// prototype already computes every grade it needs and then discards all but one list.
//
// FORMAT. A long-form document in the `merge.html` genre rather than the `scope.html` one:
// prose top to bottom, figures wider than the prose, nothing sticky but the chrome.
//
// IT HAS DEVICE FRAMES NOW, WHICH THIS COMMENT USED TO RULE OUT. The old version said there
// was none on purpose, because "the digest is not a screen I am proposing to build; it is a
// view of the data that a screen could be built from, and putting it in a phone would make it
// an unreviewed product proposal instead of the analysis it is." Björn's call overrides that,
// and the reasoning it overrides is worth keeping rather than deleting: "Digest needs mobile
// UI mockups too then, not just narrative." Every other product page in TrailScope shows its
// argument as a screen, and a digest that never does reads as a report about a product. The
// caution the old note carried is real and is answered by construction rather than by copy:
// the frames are drawn from the same `RegionDigest` the figures are, so they cannot propose
// anything the analysis does not already contain. See `src/digest/screens.ts`.
//
// WHERE THE STYLING COMES FROM. `merge.css` is imported for the document genre, exactly as
// `src/merge/merge.ts` does, so the section rhythm, the tables and the footer are the same
// objects a reader has already met two pages earlier. `digest.css` adds what is new (the
// chrome bar, the matrix, the window strips, the pick cards and the two screens' own chrome)
// and imports the device frame and the discovery app's stylesheet for the rest.
//
// NOTHING ON THIS PAGE IS TYPED. Every count, hour, band and name is read out of
// `model.ts`, which reads it out of the same grade cache the results list reads. The
// sentences come from `summary.ts`. The only literal strings here are labels and
// connectives, and where a sentence needed a number it was moved into `summary.ts` rather
// than interpolated here, so there is one place a claim can be wrong.

import '../tokens.css';
// The long-form document genre: `body.doc-page`, `.doc-shell`, `.doc-head`, `.sec`,
// `.tldr`, `.doc-foot`. Imported rather than re-declared so this page and the segment
// merge page cannot drift apart typographically. `digest.css` loads after it and owns
// everything below.
import '../merge/merge.css';
import './digest.css';

import { mountNav } from '../ui/nav';
import { h } from '../ui/dom';
// Read-only, from the discovery prototype: the icon set (so this page introduces no second
// visual language), the region registry and the unit formatters, the scenario registry, and
// the derived-data aggregates for the footer's provenance line.
import { icon } from '../scope/phone/ui';
import { regionStats } from '../scope/data';
import {
  REGIONS,
  REGION_IDS,
  formatDuration,
  formatElevation,
  formatHourOfDay,
  formatLength,
  hasTreeline,
  needsOneWayLabel,
} from '../scope/model';
import { scenarioDefs } from '../scope/weather/scenarios';
// The grade's own frozen parameter set, read rather than transcribed, exactly as
// `src/scope/doc.ts` reads it: the windows section has to name the hour the grade assumes
// someone sets off, and a hand-typed 09:00 here would go stale the moment it is retuned.
import { GRADE_MODEL } from '../scope/weather/grade';
import type { GradeLevel, RegionId, ScenarioId } from '../scope/types';
import type { Units } from '../types';
import {
  bandDef,
  buildDigest,
  hourLabel,
  type BandCell,
  type DigestDay,
  type Pick,
  type RegionDigest,
} from './model';
import { summaryClaims } from './summary';
import { screensFigure } from './screens';

// ============================================================================
// UNITS — the app-wide key, read and written like every other page
// ============================================================================
//
// `trailscope-units` is the same localStorage key `src/scope/doc.ts` and `src/merge/model.ts`
// use, so the setting follows a reader across all six sections. Metric is the default here
// as it is everywhere else in TrailScope.

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
// COPY HELPERS — the same small vocabulary src/scope/doc.ts uses
// ============================================================================

const p = (...children: (string | Node)[]): HTMLElement => h('p', {}, ...children);
const strong = (t: string): HTMLElement => h('strong', {}, t);
const lede = (...children: (string | Node)[]): HTMLElement => h('p', { class: 'sec-lede' }, ...children);

/** A boxed claim the reader must not skim past. Same object as the Trail Explorer page's. */
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

/** Segmented control, the same shape and `.seg` styling the Trail Explorer chrome uses. */
function segmented<T extends string>(
  options: { id: T; label: string }[],
  active: T,
  onPick: (id: T) => void,
): HTMLElement {
  const seg = h('div', { class: 'seg' });
  const buttons = options.map((opt) => {
    const btn = h('button', { type: 'button', class: opt.id === active ? 'on' : '' }, opt.label) as HTMLButtonElement;
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

const LEVELS: GradeLevel[] = ['prime', 'mixed', 'poor'];
const LEVEL_LABEL: Record<GradeLevel, string> = { prime: 'Good', mixed: 'Mixed', poor: 'Poor' };
/** Same silhouettes the conditions pill uses, so a level reads without its colour. */
const LEVEL_GLYPH: Record<GradeLevel, string> = { prime: 'sun', mixed: 'suncloud', poor: 'bolt' };

// ============================================================================
// SECTION 1 — the generated summary
// ============================================================================

function summarySection(digest: RegionDigest, day: DigestDay): HTMLElement {
  const claims = h(
    'dl',
    { class: 'dg-claims' },
    ...summaryClaims(digest, day).flatMap((c) => [
      h('dt', {}, c.label),
      h('dd', {}, c.text),
    ]),
  );

  return section(
    'summary',
    'Synthesis',
    'What the grades add up to',
    // NO LEDE. It said these sentences are assembled from the grades for the selected day
    // and rewrite when the chrome changes, which is a description of a mechanism the reader
    // can operate: press a day in the matrix and watch them rewrite.
    claims,
    // THE ONE NOTE THIS SECTION KEEPS, because "best" is a word the page uses in a narrower
    // sense than a reader arrives with, and no figure on the page states which sense.
    note(
      'What best means',
      p(
        strong('Best is best by conditions: '),
        'grade, then prominence, then distance from ',
        digest.assumedLocationLabel,
        '. No popularity term: open data has no crowd signal.',
      ),
    ),
  );
}

// ============================================================================
// SECTION 2 — the day-by-band matrix
// ============================================================================

/** One cell's three-level bar. Zero-count levels take no width and draw nothing. */
function levelBar(cell: BandCell): HTMLElement {
  const bar = h('div', { class: 'dg-bar' });
  if (cell.total === 0) return bar;
  for (const level of LEVELS) {
    const n = cell.counts[level];
    if (n === 0) continue;
    const seg = h('span', { class: `dg-seg lv-${level}` });
    seg.style.width = `${(n / cell.total) * 100}%`;
    bar.appendChild(seg);
  }
  return bar;
}

function cellTitle(digest: RegionDigest, day: DigestDay, cell: BandCell): string {
  const band = bandDef(digest, cell.bandId).label;
  const counts = LEVELS.map((l) => `${cell.counts[l]} ${LEVEL_LABEL[l]}`).join(', ');
  const scope = day.outlook ? 'regional outlook' : 'route-specific and hourly';
  return `${band}, ${day.weekday}: ${counts} (${scope})`;
}

/**
 * The matrix. Days across, bands down, and the horizon drawn as a wall between the last
 * route-specific column and the first outlook one.
 *
 * THREE SIGNALS SEPARATE THE TWO HALVES, not one, because a reader who misses the
 * distinction reads a Saturday cell as carrying the same authority as today's:
 *
 *   1. every column header says HOURLY or OUTLOOK under its date, which is the day
 *      scrubber's own vocabulary from `phone/app.ts`;
 *   2. the outlook columns are washed and their bars are drawn at reduced weight, which is
 *      the same treatment `phone/ui.ts` gives an outlook elevation profile;
 *   3. a dashed wall carrying the horizon sits between the two halves, as it does in the
 *      scrubber.
 *
 * The column headers are buttons: the matrix is also the day control, because a reader who
 * has just seen a Saturday column go faint should be able to select it and watch the
 * windows and the picks degrade with it.
 */
function matrixSection(
  digest: RegionDigest,
  selectedDay: number,
  units: Units,
  onPickDay: (day: number) => void,
): HTMLElement {
  const def = REGIONS[digest.region];
  const treeline = digest.bands.axis === 'treeline';
  const horizon = `+${Math.round(digest.horizonH)} h`;

  const grid = h('div', { class: 'dg-matrix' });
  grid.style.setProperty('--dg-days', String(digest.days.length));

  // Header row: an empty corner over the band labels, then one button per day.
  // The corner used to be empty. It now names what the numeral in every cell below it is,
  // which is what let the cells stop saying it themselves.
  grid.appendChild(h('div', { class: 'dg-corner' }, h('span', {}, 'Grading Good')));
  for (const day of digest.days) {
    const first = day.day === digest.firstOutlook;
    const btn = h(
      'button',
      {
        type: 'button',
        class:
          'dg-day' +
          (day.day === selectedDay ? ' on' : '') +
          (day.outlook ? ' is-outlook' : '') +
          (first ? ' is-wall' : ''),
        'aria-label':
          `${day.weekday} ${day.date}, ` +
          (day.outlook ? `regional outlook, past the ${horizon} forecast` : 'hourly forecast'),
      },
      h('span', { class: 'dg-day-name' }, day.relative ?? day.weekday.slice(0, 3)),
      // NO DATE UNDER THE WEEKDAY. "Sat" and "Aug 29" are two names for one column, and the
      // matrix is read across a week rather than against a calendar; the snapshot date is in
      // the footer for anyone who needs to place it. The full weekday and date are still on
      // the button's aria-label, which is the one place a reader cannot see the column.
      //
      // THE MODE WORD STAYS. It is one of the three signals that separate the two halves of
      // the matrix (see this function's header) and the only one of the three that survives
      // greyscale and a glance, so it is the last thing on this figure to cut.
      h('span', { class: 'dg-day-mode' }, day.outlook ? 'outlook' : 'hourly'),
      first ? h('span', { class: 'dg-wall-label' }, horizon.replace(' ', '')) : null,
    ) as HTMLButtonElement;
    btn.setAttribute('aria-pressed', String(day.day === selectedDay));
    btn.addEventListener('click', () => onPickDay(day.day));
    grid.appendChild(btn);
  }

  // One row per band, in the scheme's own order (highest exposure or best drainage first).
  const lastBand = digest.bands.defs[digest.bands.defs.length - 1];
  for (const band of digest.bands.defs) {
    // The figure's own border closes the grid, so the final row drops its own rule. CSS
    // cannot count rows here (the column count is a custom property), so it is marked.
    const lastRow = band.id === lastBand.id ? ' is-lastrow' : '';
    grid.appendChild(
      h(
        'div',
        { class: `dg-band${lastRow}` },
        h('span', { class: 'dg-band-name' }, band.label),
        // Just the count. The corner cell says these are routes, and saying it again on
        // every row said it three more times: the row is a band label beside a number.
        h('span', { class: 'dg-band-n' }, String(digest.perBand[band.id])),
      ),
    );
    for (const day of digest.days) {
      const cell = day.cells.find((c) => c.bandId === band.id);
      const classes =
        'dg-cell' +
        lastRow +
        (day.day === selectedDay ? ' on' : '') +
        (day.outlook ? ' is-outlook' : '') +
        (day.day === digest.firstOutlook ? ' is-wall' : '');
      if (!cell || cell.total === 0) {
        // A band with no routes in this region. Drawn as an explicit blank rather than a
        // zero, because zero Good out of zero routes is not a result.
        grid.appendChild(h('div', { class: `${classes} is-empty` }, h('span', { class: 'dg-cell-none' }, 'no routes')));
        continue;
      }
      grid.appendChild(
        h(
          'div',
          { class: classes, title: cellTitle(digest, day, cell) },
          levelBar(cell),
          // THE COUNT ALONE, not "5 of 12 Good". The denominator is the row header's own
          // "12 routes" repeated in all seven cells of that row, and the word Good was in
          // all twenty-one: 84 words of matrix where 21 numerals say the same thing. The
          // corner cell now labels the column of numbers once, the row header still carries
          // the total, and the title attribute on every cell still gives the full three-level
          // breakdown on hover. This is the largest single word saving on the page and it
          // removes nothing a reader could not already see.
          h('div', { class: 'dg-cell-n' }, h('span', { class: 'dg-cell-good' }, String(cell.counts.prime))),
        ),
      );
    }
  }

  const legend = h(
    'div',
    { class: 'dg-legend' },
    ...LEVELS.map((l) =>
      h('span', { class: 'dg-leg' }, h('i', { class: `dg-swatch lv-${l}` }), LEVEL_LABEL[l]),
    ),
    h('span', { class: 'dg-leg-note' }, 'Faded is outlook, not hourly.'),
  );

  return section(
    'matrix',
    'Distribution',
    treeline ? 'Day by elevation band' : 'Day by drainage band',
    // ONE LINE. The long version spelled out the three band cuts as fractions of a profile
    // and then argued that the rows are the shape of a grade term rather than an arbitrary
    // slice. The cuts are `bandScheme`'s to define and the argument is `model.ts`'s to make;
    // what a reader needs here is what the row labels mean.
    treeline
      ? lede(
          'Profile against the ',
          formatElevation(def.treelineM, units),
          ' treeline: the grader\'s exposure input.',
        )
      : lede(digest.regionName, ' has no treeline, so the bands are drainage instead.'),
    h('div', { class: 'dg-matrix-wrap' }, grid),
    legend,
  );
}

// ============================================================================
// SECTION 3 — the product screens
// ============================================================================

/**
 * The two frames, and the whole of this page's copy about them.
 *
 * SIXTEEN WORDS, and that is the budget rather than an accident. The page was cut from 994
 * rendered words to about 400 on Björn's instruction, and a section that narrated its own
 * frames ("the week screen lists seven days, each row showing...") would put every one of
 * them back to say what the picture already says. The lede states what the frames are made
 * of, which is the one thing a reader cannot see; the caption states that they are live,
 * which is the one thing a reader cannot see either. Nothing else here is worth a word.
 */
function screensSection(
  digest: RegionDigest,
  day: DigestDay,
  units: Units,
  onPickDay: (day: number) => void,
): HTMLElement {
  return section(
    'screens',
    'Product',
    'Week and day screens',
    lede('The same grades the figures above are drawn from, as two screens.'),
    screensFigure(digest, day, units, onPickDay),
    h('p', { class: 'dg-caption' }, 'Both are live: press a day in Week and the whole page follows.'),
  );
}

// ============================================================================
// SECTION 4 — where the windows agree
// ============================================================================

/**
 * One band's window agreement, hour by hour.
 *
 * The bar at each hour is the share of that band's routes whose best window covers the
 * whole of it, and the hours at the band's own peak are marked. Bands share one axis across
 * the section so the three strips can be read against each other, which is the point: a
 * valley band flat across the day beside an alpine band that stops at noon is the argument
 * in one picture.
 */
function windowStrip(digest: RegionDigest, cell: BandCell): HTMLElement {
  const band = bandDef(digest, cell.bandId);
  const track = h('div', { class: 'dg-strip' });
  const { hourOfDay } = digest.provider.now();

  for (const hour of cell.coverage) {
    const share = cell.total === 0 ? 0 : hour.count / cell.total;
    const peak =
      cell.consensus !== null && hour.hour >= cell.consensus.startHour && hour.hour < cell.consensus.endHour;
    const col = h('div', {
      class: 'dg-hour' + (peak ? ' is-peak' : ''),
      title: `${hourLabel(digest, hour.hour)}: ${hour.count} of ${cell.total} ${band.label.toLowerCase()}`,
    });
    const fill = h('span', { class: 'dg-hour-fill' });
    fill.style.height = `${Math.round(share * 100)}%`;
    col.appendChild(fill);
    // An axis tick every three hours. Denser than that and the labels collide at 375 px;
    // sparser and a reader cannot place the peak on a clock.
    const abs = Math.round(hourOfDay + hour.hour);
    if (abs % 3 === 0) col.appendChild(h('span', { class: 'dg-hour-tick' }, hourLabel(digest, hour.hour).slice(0, 2)));
    track.appendChild(col);
  }

  // Labelled "peak", not as a window the band shares: two hours can sit at the same peak
  // count without the same routes being behind them, and `summary.ts` states it the same
  // careful way. A one-hour peak prints one time rather than a span of zero length.
  const single = cell.consensus !== null && cell.consensus.endHour - cell.consensus.startHour <= 1;
  const window =
    cell.consensus === null
      ? h('span', { class: 'dg-strip-none' }, 'no window')
      : h(
          'span',
          { class: 'dg-strip-win' },
          single
            ? `peak ${hourLabel(digest, cell.consensus.startHour)}`
            : `peak ${hourLabel(digest, cell.consensus.startHour)} to ${hourLabel(digest, cell.consensus.endHour)}`,
        );

  return h(
    'div',
    { class: 'dg-strip-row' },
    h(
      'div',
      { class: 'dg-strip-head' },
      h('span', { class: 'dg-band-name' }, band.label),
      // "7 of 10", not "7 of 10 carry a window": the section is titled "Where the windows
      // agree" and its lede defines a window one line above this strip.
      h('span', { class: 'dg-band-n' }, `${cell.withWindow} of ${cell.total}`),
    ),
    track,
    h('div', { class: 'dg-strip-foot' }, window),
  );
}

function windowsSection(digest: RegionDigest, day: DigestDay): HTMLElement {
  const horizon = `+${Math.round(digest.horizonH)} h`;

  const body: (Node | null)[] = [
    // "A window is" is dropped from the front: the section is titled "Where the windows
    // agree" one line above, so the sentence has a subject already.
    lede('The best span a route fits inside on that day.'),
  ];

  if (day.outlook) {
    // Not an empty state: an explanation of a limit. The section keeps its heading and its
    // lede so a reader scrubbing between days sees the same object lose its content, which
    // is what the horizon actually does.
    body.push(
      h(
        'div',
        { class: 'dg-void' },
        h('div', { class: 'dg-void-head' }, icon('outlook', 16), `No window on ${day.weekday}`),
        p(
          `A window is an hourly claim and there are no hours past ${horizon}. Every route in `,
          digest.regionName,
          ' shares one regional level for the day, with no time in it, so there is nothing here to align.',
        ),
      ),
    );
  } else if (day.hourTo <= day.hourFrom) {
    body.push(
      h(
        'div',
        { class: 'dg-void' },
        h('div', { class: 'dg-void-head' }, icon('clock', 16), `No route carries a window on ${day.weekday}`),
        p('The day does not fit any route in the region at the usability the grader asks for.'),
      ),
    );
  } else {
    body.push(
      h('div', { class: 'dg-strips' }, ...day.cells.filter((c) => c.total > 0).map((c) => windowStrip(digest, c))),
      // ONE LINE, AND ONLY THE ARTEFACT. The caption's first two sentences described the bar
      // height and the marked hours (the figure's own encoding, restated) and repeated the
      // no-window count that `summary.ts` already states in the claims above. What is left is
      // the one thing a reader cannot see and would misread: today's first column is tall
      // because the window can only open now, not because it is the best hour.
      h(
        'p',
        { class: 'dg-caption' },
        day.day === 0
          ? 'Today a window can only open now, so the first column holds every route.'
          : `The grade assumes a ${formatHourOfDay(GRADE_MODEL.typicalStartHour)} start, not the best hour.`,
      ),
    );
  }

  return section('windows', 'Timing', 'Where the windows agree', ...body);
}

// ============================================================================
// SECTION 5 — the named trails
// ============================================================================

function pickCard(digest: RegionDigest, pick: Pick, units: Units): HTMLElement {
  const { trail, grade } = pick;
  const outlook = grade.confidence === 'outlook';
  // A window whose ends round to the same hour is not a zero-length window, it is a route
  // shorter than an hour: the median derived trail is under a kilometre and grade.ts rounds
  // both ends to the hour. "08:00 to 08:00" reads as a bug, so the collapsed case names the
  // hour to start instead of printing a span of nothing.
  const w = grade.bestWindow;
  const window = !w
    ? null
    : w.endHour - w.startHour < 1
      ? `Best hour ${hourLabel(digest, w.startHour)}`
      : `Window ${hourLabel(digest, w.startHour)} to ${hourLabel(digest, w.endHour)}`;

  return h(
    'article',
    { class: 'dg-pick' },
    h('h3', { class: 'dg-pick-name' }, trail.name),
    // The pill vocabulary, rebuilt rather than imported: `phone/ui.ts`'s `conditionPill`
    // renders classes that live in `phone.css`, and pulling the discovery app's whole
    // stylesheet into a document page to borrow one component would be a worse trade than
    // restating the four class names. `digest.css` reads the same hues from the same place.
    h(
      'div',
      { class: `dg-pill ${outlook ? `is-outlook lv-${grade.level}` : `is-${grade.level}`}` },
      icon(outlook ? 'outlook' : LEVEL_GLYPH[grade.level], 14, 'dg-pill-glyph'),
      h('span', { class: 'dg-pill-level' }, outlook ? `Outlook · ${LEVEL_LABEL[grade.level]}` : LEVEL_LABEL[grade.level]),
      h('span', { class: 'dg-pill-text' }, grade.headline),
    ),
    h(
      'div',
      { class: 'dg-pick-meta' },
      h('span', {}, formatLength(trail.lengthM, units)),
      h('span', {}, `${formatElevation(trail.gainM, units)} up`),
      h(
        'span',
        {},
        formatDuration(trail.estMinutes),
        needsOneWayLabel(trail.routeType) ? h('span', { class: 'dg-oneway' }, ' one way') : null,
      ),
    ),
    h(
      'div',
      { class: 'dg-pick-window' },
      window ?? (outlook ? 'No window past the horizon' : 'No window on this day'),
    ),
  );
}

function picksSection(digest: RegionDigest, day: DigestDay, units: Units): HTMLElement {
  return section(
    'picks',
    'Picks',
    'Top of the list',
    // NO LEDE AT ALL, which makes this the only section on the page without one. It said this
    // is the results list's own Best conditions comparator run over the region, and then
    // argued at length that a short route occupies less of a convective afternoon and
    // therefore grades better, so the ranking wants pairing with an intent filter. That
    // argument is the most interesting thing on this page and is still an argument about what
    // to build rather than a description of what is shown; the region briefing one section
    // later IS that argument, made as a page. What the first half said is now carried by the
    // kicker and title plus section 1's "What best means", which defines the order once.
    day.picksFellBack
      ? note(
          'The order fell back',
          p(
            'Past the horizon every route shares one regional outlook, so the conditions order ties on ' +
              'every row and falls back to the closest routes to ',
            digest.assumedLocationLabel,
            '. These are ordered by distance.',
          ),
        )
      : null,
    h('div', { class: 'dg-picks' }, ...day.picks.map((pick) => pickCard(digest, pick, units))),
  );
}

// ============================================================================
// PAGE STATE
// ============================================================================

let region: RegionId = 'rmnp';
let scenario: ScenarioId = 'storms';
let units: Units = readUnits();
let selectedDay = 0;

/** Latest digest for the current chrome, or null while the first one is still building. */
let digest: RegionDigest | null = null;
/**
 * Guards against an out-of-order build. `buildDigest` is async by the provider contract,
 * and a reader can change region twice before the first resolves; without the token the
 * slower build would land last and the page would show a region the chrome does not name.
 */
let buildToken = 0;

const REGION_OPTIONS = REGION_IDS.map((id) => ({ id, label: REGIONS[id].name.replace('National Park', 'NP') }));
const SCENARIOS = scenarioDefs();

function bodyEl(): HTMLElement | null {
  return document.getElementById('dg-body');
}

/** Rebuild everything below the chrome from the current digest and the selected day. */
function renderBody(): void {
  const host = bodyEl();
  if (!host) return;
  host.replaceChildren();

  if (!digest) {
    host.appendChild(
      h('div', { class: 'dg-loading' }, h('span', { class: 'spinner' }), 'Grading the region across the week'),
    );
    return;
  }

  const day = digest.days[Math.min(selectedDay, digest.days.length - 1)];
  // One handler behind the matrix's column headers and the Week screen's rows, so the two
  // day controls on this page cannot disagree about which day is selected.
  const pickDay = (picked: number): void => {
    selectedDay = picked;
    renderBody();
  };
  host.append(
    summarySection(digest, day),
    matrixSection(digest, day.day, units, pickDay),
    screensSection(digest, day, units, pickDay),
    windowsSection(digest, day),
    picksSection(digest, day, units),
    footer(digest),
  );
}

/** Rebuild the digest for the current region and scenario, then re-render. */
async function rebuild(): Promise<void> {
  const token = ++buildToken;
  digest = null;
  renderBody();
  const built = await buildDigest(region, scenario);
  if (token !== buildToken) return;
  digest = built;
  renderBody();
}

// ============================================================================
// CHROME + SHELL
// ============================================================================

/**
 * Region, scenario and units, in the doc-chrome idiom the Trail Explorer page established:
 * outside any frame, labelled, and sticky under the top bar so a reader comparing two
 * regions never has to scroll back to the control that changed.
 */
function chrome(): HTMLElement {
  const group = (label: string, ...body: Node[]): HTMLElement =>
    h('div', { class: 'dg-ctl' }, h('div', { class: 'dg-ctl-label' }, label), ...body);

  return h(
    'div',
    { class: 'dg-chrome' },
    group(
      'Region',
      segmented(REGION_OPTIONS, region, (id) => {
        region = id;
        // The selected day survives a region change on purpose: a reader comparing two
        // regions on the same Thursday should not be sent back to today by the switch.
        void rebuild();
      }),
    ),
    // NO SCENARIO BLURB UNDER THE CONTROL. It was a reserved two-line slot restating the
    // scenario the button beside it already names ("an afternoon of storms building over the
    // high ground"), and the whole page below it is that scenario's consequences drawn four
    // ways. The `blurb` field is still on the scenario definitions and still used by the
    // discovery prototype, where the reader has not just pressed the button.
    group(
      'Scenario',
      segmented(
        SCENARIOS.map((s) => ({ id: s.id, label: s.label })),
        scenario,
        (id) => {
          scenario = id;
          void rebuild();
        },
      ),
    ),
    group(
      'Units',
      segmented(
        [
          { id: 'metric' as Units, label: 'Metric' },
          { id: 'imperial' as Units, label: 'Imperial' },
        ],
        units,
        (id) => {
          units = id;
          writeUnits(units);
          // Units never touch the grades: everything is SI at rest and the formatters
          // convert at render time, so this re-renders and regrades nothing.
          renderBody();
        },
      ),
    ),
  );
}

/**
 * Kicker, title, one line.
 *
 * THE "IN SHORT" BLOCK IS GONE. Its three bullets said that the discovery prototype already
 * grades a whole region and this page reads the pattern out of it, that best means best by
 * conditions, and that two of seven days are hourly and the rest an outlook. The first is
 * the reasoning behind building the page at all, which belongs in this file's header where
 * it already is. The second is the "What best means" note in section 1, verbatim. The third
 * is the matrix: every column says HOURLY or OUTLOOK under its own date, the outlook half is
 * washed, and a dashed wall carrying the horizon sits between them. A summary of a figure
 * placed 400 px above the figure is the page reading itself out.
 */
function header(): HTMLElement {
  return h(
    'header',
    { class: 'doc-head' },
    h('div', { class: 'doc-kicker' }, 'TrailScope · regional digest'),
    h('h1', {}, 'Conditions digest'),
    h(
      'p',
      { class: 'lede' },
      'A whole region across a whole week, off the list\'s own grades.',
    ),
  );
}

function footer(d: RegionDigest): HTMLElement {
  const stats = regionStats(d.region);
  const treeline = hasTreeline(REGIONS[d.region])
    ? `Treeline ${formatElevation(d.treelineM, units)}.`
    : 'No treeline in this region.';
  return h(
    'footer',
    { class: 'doc-foot' },
    // The two trail counts are both stated, because they differ and a reader who compares
    // the footer against the matrix will notice: the merge emits every name-cluster, and the
    // results list applies two display rules on top of it (no subdivision streets, nothing
    // under the display floor). The digest counts what the list shows.
    p(
      `Trail geometry: OpenStreetMap contributors, ODbL. ${stats.wayCount} ways, ${stats.trailCount} ` +
        `clusters, ${d.total} shown, ${stats.fetchedAt.slice(0, 10)}. ${stats.elevationSource}. ${treeline}`,
    ),
    p(
      `Weather is simulated (${d.provider.label}, ${d.provider.resolutionM} m grid, ` +
        `+${Math.round(d.horizonH)} h). Terrain is computed. Not a forecast.`,
    ),
  );
}

// ============================================================================
// BOOT
// ============================================================================

function boot(): void {
  mountNav('digest');

  const root = document.getElementById('digest-root');
  if (!root) return;

  root.append(header(), chrome(), h('div', { id: 'dg-body' }));
  void rebuild();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
