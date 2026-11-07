// Regional conditions digest — the two product screens.
//
// WHY THEY EXIST. The four figures on this page argue about a region across a week, and they
// argue as a document: a matrix, three strips, three wide cards. Every other product page in
// TrailScope shows its argument as a phone screen (`scope.html` and `weather-on-route.html`
// both do), and a digest that never becomes a screen reads as a report about a product rather
// than as a product. Björn's note, verbatim: "Digest needs mobile UI mockups too then, not
// just narrative."
//
// TWO SCREENS BECAUSE THE DIGEST IS TWO QUESTIONS. Week answers "when this week", which is the
// matrix turned portrait. Day answers "and then what", which is the windows and the picks for
// the one day Week has selected. They share the page's selected day, so a reader watching the
// matrix, the two frames, the strips and the picks all move on one press is watching a single
// object drawn five ways.
//
// NOTHING HERE COMPUTES ANYTHING. Every count, level, hour, band, name and sky comes off the
// `RegionDigest` the figures are drawn from, which comes off the grade cache the discovery
// app's own results list reads. There is no threshold, no band cut, no level label and no
// hour written down in this file. That is the whole point: a frame that disagreed with the
// figure two sections above it would be worse than no frame at all.
//
// WHAT IS BORROWED AND WHAT IS LOCAL.
//
//   borrowed, from the discovery app   `.card`, `.card-hero`, `.card-name`, `.card-meta`, the
//     conditions pill, the conditions row, the elevation sparkline, the area strip, and the
//     `.dg-bar` / `.dg-strip` encodings this page's own figures use. The pick cards are
//     literally the results list's cards, so they cannot drift from them.
//   local, in digest.css under `dg-ph-` / `dg-wk-` / `dg-dy-`   the two screens' own chrome:
//     the head, the week row grid, the day screen's blocks.
//
// THE ONE THING DELIBERATELY NOT BORROWED is `trailCard` itself, which also draws
// `ratingLine`. Seeded star ratings are carried on the discovery page by a Sample data caveat
// in the prose column beside the phone (SCOPE_PLAN §10); this page has no such caveat and, per
// the brief, open data has no photo and no star rating and the prototype must not invent one.
// So the card is assembled from the same parts minus the stars. If a rating ever appears on
// this page, the caveat has to arrive with it.
//
// THE FRAME RULE (SCOPE_PLAN §10) HOLDS INSIDE THESE BEZELS. Nothing in here explains the
// prototype, the data or the simulation. The horizon wall and the HOURLY / OUTLOOK words are
// not exceptions to that: the discovery app's own day scrubber draws both, inside its phone,
// because where the hourly forecast stops is a fact about the product rather than about the
// prototype.

import { h } from '../ui/dom';
import { deviceFrame } from '../ui/phone-frame';
import { conditionPill, difficultyDot, icon, profileSparkline, routeTypeGlyph, weatherGlyph } from '../scope/phone/ui';
import { HERO_H, HERO_W, cardConditionsRow } from '../scope/phone/list';
import { conditionsRow, frameFor } from '../scope/phone/conditions';
import { weatherOf } from '../scope/phone/grading';
import {
  REGIONS,
  formatDuration,
  formatElevation,
  formatLength,
  hasTreeline,
  needsOneWayLabel,
} from '../scope/model';
import { clockLabel } from '../scope/weather/provider';
import type { Units } from '../types';
import { bandDef, hourLabel, type BandCell, type DigestDay, type Pick, type RegionDigest } from './model';

// ============================================================================
// SHARED BITS
// ============================================================================

/**
 * The sky for one day, from the region's own reading rather than from its grades.
 *
 * `weatherGlyph` is the app-wide precedence (thunder, then rain, then cloud cover) and it is
 * called with the reading's PEAK fields for the same reason the conditions row's own glyph is:
 * a day-scale glyph drawn off one hour would draw a clear morning over a stormy afternoon.
 *
 * Falls back to nothing rather than to a sun when the provider call has not landed. An
 * invented clear sky is the one wrong answer here.
 */
function skyGlyph(day: DigestDay, size: number): SVGSVGElement | null {
  const r = day.areaReading;
  if (!r) return null;
  return icon(weatherGlyph(r.peakThunderProb, r.peakPrecipMm, r.cloudPct), size, 'dg-ph-sky');
}

/** HOURLY / OUTLOOK, in the day scrubber's own vocabulary and the matrix column headers'. */
function modeWord(day: DigestDay): string {
  return day.outlook ? 'outlook' : 'hourly';
}

/** A screen's title block. Both frames use it, so the two read as one app. */
function screenHead(title: string, sub: string, trailing?: Node | null): HTMLElement {
  return h(
    'div',
    { class: 'dg-ph-head' },
    h(
      'div',
      { class: 'dg-ph-head-top' },
      h('div', { class: 'dg-ph-title' }, title),
      trailing ?? null,
    ),
    h('div', { class: 'dg-ph-sub' }, sub),
  );
}

// ============================================================================
// FRAME 1 — WEEK
// ============================================================================

/**
 * One band's distribution in one cell, in the matrix's own bar.
 *
 * `.dg-bar` / `.dg-seg` are the matrix's classes, used here unchanged and on purpose: the
 * week row IS a matrix column stood on its side, and drawing it with a second encoding would
 * make a reader work out that the two figures show the same thing.
 */
function bandBar(cell: BandCell | undefined): HTMLElement {
  const bar = h('div', { class: 'dg-bar' });
  if (!cell || cell.total === 0) return bar;
  // Level order is the matrix's: Good, Mixed, Poor, left to right. Read off the cell rather
  // than declared, so a level added to the grade turns up here without being listed.
  for (const [level, n] of Object.entries(cell.counts) as [keyof BandCell['counts'], number][]) {
    if (n === 0) continue;
    const seg = h('span', { class: `dg-seg lv-${level}` });
    seg.style.width = `${(n / cell.total) * 100}%`;
    bar.appendChild(seg);
  }
  return bar;
}

/**
 * The week screen: seven days down, the region's bands across.
 *
 * PORTRAIT, NOT A SCROLLER. The matrix above puts seven days across and scrolls sideways
 * inside its own figure to do it; a phone cannot, and a horizontally scrolling week is a week
 * a reader cannot see. So the axes swap. That is not a compromise made for width: days down a
 * list is how every calendar and every forecast app on a phone already reads, and it is the
 * bands, three of them, that fit across.
 *
 * Rows are buttons. Pressing one selects the day for the whole page, which is what makes the
 * two frames one flow rather than two pictures.
 */
function weekScreen(
  digest: RegionDigest,
  selectedDay: number,
  units: Units,
  onPickDay: (day: number) => void,
): HTMLElement {
  const def = REGIONS[digest.region];
  const horizon = `+${Math.round(digest.horizonH)}h`;

  const grid = h('div', { class: 'dg-wk' });
  grid.style.setProperty('--dg-bands', String(digest.bands.defs.length));

  // Header: the band names and their route counts, said once for all seven rows rather than
  // twenty-one times. The matrix does the same thing with its row headers.
  grid.appendChild(
    h(
      'div',
      { class: 'dg-wk-row is-head' },
      h('span', { class: 'dg-wk-day' }),
      h('span', { class: 'dg-wk-sky' }),
      ...digest.bands.defs.map((band) =>
        h(
          'span',
          { class: 'dg-wk-band' },
          h('span', { class: 'dg-wk-bandname' }, band.label),
          h('span', { class: 'dg-wk-bandn' }, String(digest.perBand[band.id])),
        ),
      ),
      h('span', { class: 'dg-wk-good' }, 'Good'),
    ),
  );

  for (const day of digest.days) {
    // The horizon, drawn as its own rule between the last hourly day and the first outlook
    // one. Same object the day scrubber and the matrix draw, rotated with the axes.
    if (day.day === digest.firstOutlook) {
      grid.appendChild(h('div', { class: 'dg-wk-wall' }, h('span', {}, horizon)));
    }

    const row = h(
      'button',
      {
        type: 'button',
        class:
          'dg-wk-row' +
          (day.day === selectedDay ? ' on' : '') +
          (day.outlook ? ' is-outlook' : ''),
        'aria-label':
          `${day.weekday} ${day.date}, ${day.counts.prime} of ${day.total} routes grading Good, ` +
          (day.outlook ? `regional outlook, past the ${horizon} forecast` : 'hourly forecast'),
      },
      h(
        'span',
        { class: 'dg-wk-day' },
        h('span', { class: 'dg-wk-dayname' }, day.relative ?? day.weekday.slice(0, 3)),
        h('span', { class: 'dg-wk-daymode' }, modeWord(day)),
      ),
      h('span', { class: 'dg-wk-sky' }, skyGlyph(day, 15)),
      ...digest.bands.defs.map((band) =>
        h('span', { class: 'dg-wk-band' }, bandBar(day.cells.find((c) => c.bandId === band.id))),
      ),
      h('span', { class: 'dg-wk-good' }, String(day.counts.prime)),
    ) as HTMLButtonElement;
    row.setAttribute('aria-pressed', String(day.day === selectedDay));
    row.addEventListener('click', () => onPickDay(day.day));
    grid.appendChild(row);
  }

  return h(
    'div',
    { class: 'phone-app dg-ph' },
    screenHead(
      digest.regionName,
      // The treeline is what the bands are cut against, so it is the one number the header
      // owes a reader looking at three band columns. Read through the units formatter, and
      // omitted where there is no treeline to state (the Ozarks' sentinel must never be
      // printed as a height; see model.ts).
      hasTreeline(def)
        ? `${digest.total} routes · treeline ${formatElevation(digest.treelineM, units)}`
        : `${digest.total} routes · banded by drainage`,
    ),
    h('div', { class: 'dg-ph-body' }, grid),
  );
}

// ============================================================================
// FRAME 2 — DAY
// ============================================================================

/**
 * One band's window agreement, at phone width.
 *
 * `.dg-strip` and its columns are the windows figure's own classes. The only difference is
 * the row layout around them, which is `.dg-dy-strip` in digest.css: the figure puts the band
 * name in a 200 px column and the peak on the right, and neither fits here.
 */
function dayStrip(digest: RegionDigest, cell: BandCell): HTMLElement {
  const band = bandDef(digest, cell.bandId);
  const track = h('div', { class: 'dg-strip' });
  const { hourOfDay } = digest.provider.now();

  for (const hour of cell.coverage) {
    const share = cell.total === 0 ? 0 : hour.count / cell.total;
    const peak =
      cell.consensus !== null && hour.hour >= cell.consensus.startHour && hour.hour < cell.consensus.endHour;
    const col = h('div', { class: 'dg-hour' + (peak ? ' is-peak' : '') });
    const fill = h('span', { class: 'dg-hour-fill' });
    fill.style.height = `${Math.round(share * 100)}%`;
    col.appendChild(fill);
    // An axis tick every three hours, exactly as the figure spaces them: denser and the
    // labels collide, sparser and a reader cannot place the peak on a clock.
    const abs = Math.round(hourOfDay + hour.hour);
    if (abs % 3 === 0) col.appendChild(h('span', { class: 'dg-hour-tick' }, hourLabel(digest, hour.hour).slice(0, 2)));
    track.appendChild(col);
  }

  return h(
    'div',
    { class: 'dg-dy-strip' },
    h(
      'div',
      { class: 'dg-dy-striphead' },
      h('span', { class: 'dg-dy-band' }, band.label),
      h('span', { class: 'dg-dy-bandn' }, `${cell.withWindow}/${cell.total}`),
    ),
    track,
  );
}

/** The windows block, or the honest absence of one. */
function windowsBlock(digest: RegionDigest, day: DigestDay): HTMLElement {
  const populated = day.cells.filter((c) => c.total > 0);
  const headline =
    day.consensus === null
      ? null
      : day.consensus.endHour - day.consensus.startHour <= 1
        ? hourLabel(digest, day.consensus.startHour)
        : `${hourLabel(digest, day.consensus.startHour)} to ${hourLabel(digest, day.consensus.endHour)}`;

  return h(
    'section',
    { class: 'dg-dy-block' },
    h(
      'div',
      { class: 'dg-dy-blockhead' },
      h('span', {}, 'Best windows'),
      // The peak, in the same careful wording the figure and `summary.ts` use: two hours can
      // sit at the same peak count without the same routes behind them, so it is a peak and
      // never a window the region shares.
      headline
        ? h('span', { class: 'dg-strip-win' }, `peak ${headline}`)
        : h('span', { class: 'dg-strip-none' }, day.outlook ? 'not hour by hour' : 'none'),
    ),
    day.outlook || day.hourTo <= day.hourFrom
      ? h(
          'div',
          { class: 'dg-dy-nowin' },
          icon(day.outlook ? 'outlook' : 'clock', 14),
          h(
            'span',
            {},
            // The app's own outlook vocabulary, not a note about the model: the day scrubber
            // and the area strip both already say "not hour by hour", and the mode pill in
            // this screen's head says OUTLOOK. One more sentence, in the same register.
            day.outlook
              ? `${day.weekday} is a regional outlook, with no hours in it.`
              : `No route fits ${day.weekday}.`,
          ),
        )
      : h('div', { class: 'dg-dy-strips' }, ...populated.map((c) => dayStrip(digest, c))),
  );
}

/**
 * A pick as the product's own card.
 *
 * Same parts as `trailCard` in the same order minus the seeded star row (see this file's
 * header), so a reader who has been through `scope.html` meets an object they already know.
 * The hero is the elevation profile because open data has no photograph, and the pill sits
 * where AllTrails puts a star rating because open data has no crowd signal either. Both of
 * those are the discovery page's argument, and the card carries it without saying it.
 */
function pickCard(digest: RegionDigest, day: DigestDay, pick: Pick, units: Units): HTMLElement {
  const { trail, grade } = pick;
  const outlook = grade.confidence === 'outlook';
  const oneWay = needsOneWayLabel(trail.routeType);
  const loopGlyph = routeTypeGlyph(trail.routeType);

  return h(
    'article',
    { class: 'card dg-ph-card' },
    h(
      'div',
      { class: 'card-hero' },
      profileSparkline(trail, { w: HERO_W, h: HERO_H, level: grade.level, outlook }),
    ),
    conditionPill(grade),
    h('h3', { class: 'card-name' }, trail.name),
    h(
      'div',
      { class: 'card-meta' },
      difficultyDot(trail.difficulty, { label: false }),
      h('span', { class: 'cm-dot' }, '·'),
      h('span', {}, formatLength(trail.lengthM, units)),
      h('span', { class: 'cm-dot' }, '·'),
      h('span', { class: 'cm-gain' }, icon('up', 13), formatElevation(trail.gainM, units)),
      h('span', { class: 'cm-dot' }, '·'),
      h('span', {}, formatDuration(trail.estMinutes) + (oneWay ? ' one way' : '')),
      loopGlyph ? h('span', { class: 'cm-dot' }, '·') : null,
      loopGlyph,
    ),
    cardConditionsRow(
      trail,
      weatherOf(digest.scenario, digest.region, trail),
      digest.provider,
      units,
      day.day,
      day.relative ?? day.weekday.slice(0, 3),
      grade,
    ),
  );
}

/** The day screen: one day's windows, then its picks. */
function dayScreen(digest: RegionDigest, day: DigestDay, units: Units): HTMLElement {
  const frame = frameFor(digest.provider, day.day);

  return h(
    'div',
    { class: 'phone-app dg-ph' },
    screenHead(
      day.relative ?? day.weekday,
      `${day.date} · ${digest.regionName}`,
      h('span', { class: `dg-ph-mode${day.outlook ? ' is-outlook' : ''}` }, modeWord(day)),
    ),
    h(
      'div',
      { class: 'dg-ph-scroll' },
      // The area strip, the discovery app's own object and its own classes: one point at the
      // valley reference, which IS the point-based model this product argues past. It sits
      // above the cards here for the same reason it sits above the list there, so the reader
      // can compare a valley readout against a route's own without being told to.
      h(
        'div',
        { class: 'area-strip dg-dy-area' },
        h(
          'div',
          { class: 'as-label' },
          h('span', { class: 'as-scope' }, 'Area'),
          h('span', { class: 'as-dot' }, '·'),
          h('span', { class: 'as-place' }, digest.assumedLocationLabel),
          h('span', { class: 'as-dot' }, '·'),
          h(
            'span',
            { class: `as-frame${frame === 'outlook' ? ' is-outlook' : ''}` },
            frame === 'now' ? 'now' : frame === 'daytime' ? 'daytime' : 'not hour by hour',
          ),
        ),
        conditionsRow(day.areaReading, units, {
          lead: `Area conditions for ${day.weekday} near ${digest.assumedLocationLabel}`,
        }),
      ),
      windowsBlock(digest, day),
      h('div', { class: 'card-list dg-dy-picks' }, ...day.picks.map((p) => pickCard(digest, day, p, units))),
    ),
  );
}

// ============================================================================
// THE SECTION'S FIGURE
// ============================================================================

/**
 * The two frames, side by side, wrapping to one column when the column is too narrow to
 * hold both. Never a horizontal scroller: a phone that has to be scrolled sideways to be
 * seen is not showing what a phone shows.
 */
export function screensFigure(
  digest: RegionDigest,
  day: DigestDay,
  units: Units,
  onPickDay: (day: number) => void,
): HTMLElement {
  // The status bar reads the provider's own clock, for the reason `src/trail/route.ts`
  // records: a stock 9:41 above a screen whose whole subject is time is two clocks
  // disagreeing inside one phone.
  const clock = clockLabel(digest.provider, 0);

  const one = (label: string, screen: HTMLElement): HTMLElement =>
    h(
      'div',
      { class: 'dg-ph-frame' },
      h('div', { class: 'dg-ph-label' }, label),
      deviceFrame(clock, screen),
    );

  return h(
    'div',
    { class: 'dg-ph-frames' },
    one('Week', weekScreen(digest, day.day, units, onPickDay)),
    one('Day', dayScreen(digest, day, units)),
  );
}
