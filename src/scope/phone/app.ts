// Trail Scope — the in-phone discovery prototype.
//
// mountPhone() owns PhoneState and screen routing; every screen is a pure render function
// in a sibling module. THE EXPORTED CONTRACT IS FROZEN: src/scope/doc.ts codes against
// PhoneOpts, PhoneHandle and mountPhone, and drives this app from the prose column.
//
// Three things in the contract are load-bearing and easy to get subtly wrong:
//
//   onInteract  must fire on ANY user interaction inside the phone, because the document
//               uses the first call to permanently stop scroll-linked auto-advance. It is
//               wired ONCE, as a delegated capture-phase listener on the app root, rather
//               than per control: a new button added to a sheet next month must not be
//               able to forget to report itself. `isTrusted` keeps programmatic
//               update()/goTo() calls from tripping it.
//   goTo        must be non-destructive. It drives the phone to the state a prose section
//               illustrates without discarding what the reader built: filters, sort, the
//               search text and the selected trail all survive unless the hint is
//               explicitly about one of them.
//   update      applies a partial patch without remounting. Units in particular must never
//               remount: everything is SI at rest and the formatters convert at render
//               time, so a units flip re-renders and regrades nothing.
//
// RENDER MODEL. One synchronous render() draws whatever is in the grade cache and starts
// an async fill for whatever is missing; when that resolves it renders again. The map and
// the search input are the two nodes that survive a render (a WebGL canvas and a focused
// field cannot be rebuilt on every keystroke); everything else is rebuilt, which keeps the
// state-to-DOM path honest.

import './phone.css';

import { h } from '../../ui/dom';
import { dragScroll, icon } from './ui';
import { filterChipRow, filterSheet } from './filters';
import {
  CONDITION_SORTS,
  OUTLOOK_FALLBACK_SORT,
  listHeader,
  orderLabel,
  resultsList,
  sortIsUnavailable,
  sortSheet,
} from './list';
import { areaStrip, areaWeatherOf, ensureAreaWeather } from './area';
import { searchEntry, searchResults } from './search';
import { peekSheet, teardownPeekMap } from './peek';
import { PhoneMap, trailFeature, LEVEL_COLOR } from './pmap';
import {
  SCRUB_DAYS,
  ensureGrades,
  firstOutlookDay,
  forecastAge,
  freshProviderFor,
  gradeOf,
  providerFor,
  setForecastAge,
  weatherOf,
} from './grading';
import { allTrails, displaySet } from '../data';
import { revokeUgcObjectUrls } from '../ugc';
import { DEFAULT_SORT, REGIONS, SORTS, emptyFilters } from '../model';
import { clockLabel, dateLabel, weekdayLabel } from '../weather/provider';
import { matchesFilters, matchesQuery, sortTrails, distanceAwayM } from './query';
import type { Ctx, UiExtras } from './ctx';
import type {
  ConditionGrade,
  Filters,
  PhoneState,
  RegionId,
  ScenarioId,
  ScopeTrail,
  ScreenId,
  ViewMode,
} from '../types';

export interface PhoneOpts {
  region: RegionId;
  scenario: ScenarioId;
  units: 'imperial' | 'metric';
  /**
   * Hours since the forecast was last fetched. 0, the default, is live: the app is online
   * and reading the current run. Anything higher puts the phone in the OFFLINE state,
   * reading a cached run whose route-specific reach has been shrinking ever since it landed
   * (`grading.ts`'s FORECAST AGE block owns the model and the reasoning).
   *
   * Optional, so a caller that never mentions connection gets exactly the behaviour it had
   * before this existed. `mountPhone` still calls `setForecastAge` unconditionally, because
   * the age is module state in `grading.ts` and a second phone mounted after a first one
   * left it offline must not inherit that.
   */
  forecastAgeH?: number;
  /** Fired on ANY user interaction inside the phone; the doc uses it to stop auto-advance. */
  onInteract: () => void;
}

export interface PhoneHandle {
  /** Chrome control changed. */
  update(opts: Partial<PhoneOpts>): void;
  /** Drive the phone to the state a prose section illustrates. */
  goTo(state: { screen: ScreenId; view?: ViewMode; hint?: string }): void;
  destroy(): void;
}

/** The search field's empty state, in both the real input and the idle fake one. */
const SEARCH_PLACEHOLDER = 'Search trails and places';

/** What the 'query' hint types into the field, per region. */
const DEMO_QUERY: Record<RegionId, string> = {
  rmnp: 'long',
  adk: 'marcy',
  ozarks: 'lake',
};

const TABS: { id: string; label: string; glyph: string }[] = [
  { id: 'explore', label: 'Explore', glyph: 'explore' },
  { id: 'foryou', label: 'For You', glyph: 'foryou' },
  { id: 'navigate', label: 'Navigate', glyph: 'navigate' },
  { id: 'saved', label: 'Saved', glyph: 'saved' },
  { id: 'activity', label: 'Activity', glyph: 'activity' },
];

export function mountPhone(container: HTMLElement, opts: PhoneOpts): PhoneHandle {
  let alive = true;
  let onInteract = opts.onInteract;

  // Connection state is module state in grading.ts (one device, one radio, one cache), so
  // it is set here rather than carried in PhoneState, and set unconditionally so a remount
  // starts from a known one.
  setForecastAge(opts.forecastAgeH ?? 0);

  // THE PHONE OPENS ON THE TRAILS LIST. It used to open on the search entry screen, on the
  // reasoning that a discovery product starts with a query; the review verdict was the
  // opposite, and it is right. A reader who has just scrolled to the phone should see the
  // thing being argued for (a ranked, condition-graded list) rather than an empty field
  // asking them to think of a trail name. The prose column's first section drives to the
  // same state; this is what the phone shows before a single line of it is read.
  let state: PhoneState = {
    region: opts.region,
    scenario: opts.scenario,
    screen: 'results',
    view: 'list',
    query: '',
    placeLabel: null,
    filters: emptyFilters(),
    sort: DEFAULT_SORT,
    day: 0,
    selected: null,
    units: opts.units,
  };

  let ui: UiExtras = { sheet: null, includeExcluded: false, filterGroup: 'conditions', searching: false };

  // ---- persistent nodes ------------------------------------------------------------
  // Rebuilt-every-render is the rule; these two are the exceptions, for reasons that are
  // not stylistic: a WebGL canvas is expensive to recreate and a focused input loses its
  // caret when it leaves the DOM.
  const root = h('div', { class: 'phone-app' });
  const scrollArea = h('div', { class: 'app-scroll' });
  const mapLayer = h('div', { class: 'map-layer', hidden: true });
  const mapCanvas = h('div', { class: 'map-canvas' });
  const body = h('div', { class: 'app-body' }, scrollArea, mapLayer);
  const headHost = h('div', { class: 'app-head' });
  const sheetLayer = h('div', { class: 'sheet-layer', hidden: true });
  const tabBar = buildTabBar();

  const searchInput = h('input', {
    class: 'sf-input',
    type: 'text',
    // Same words as the idle field's placeholder, so tapping the field changes nothing but
    // the caret.
    placeholder: SEARCH_PLACEHOLDER,
    autocomplete: 'off',
    spellcheck: false,
  }) as HTMLInputElement;

  const legendNote = h(
    'div',
    { class: 'lg-note', hidden: true },
    'Faded: regional outlook, not hour by hour',
  );

  mapLayer.append(mapCanvas, mapLegend(), mapZoom());
  root.append(headHost, body, sheetLayer, tabBar);
  container.replaceChildren(root);

  let pmap: PhoneMap | null = null;

  /** Wheel zoom exists but is undiscoverable, and touch pinch has no mouse equivalent a
   *  reader can see. Two plain buttons; they read the live `pmap` so building them once
   *  at mount is safe even though the map itself is created lazily. */
  function mapZoom(): HTMLElement {
    const btn = (label: string, title: string, fn: () => void): HTMLElement => {
      const b = h('button', { type: 'button', class: 'mz-btn', 'aria-label': title, title }, label);
      b.addEventListener('click', fn);
      return b;
    };
    return h(
      'div',
      { class: 'map-zoom' },
      btn('+', 'Zoom in', () => pmap?.zoomIn()),
      btn('−', 'Zoom out', () => pmap?.zoomOut()),
    );
  }

  // ---- one delegated interaction listener ------------------------------------------
  const report = (ev: Event): void => {
    if (!ev.isTrusted) return;
    onInteract();
  };
  for (const type of ['pointerdown', 'keydown', 'input', 'change', 'wheel'] as const) {
    root.addEventListener(type, report, { capture: true, passive: true });
  }

  // ---- derived state ----------------------------------------------------------------

  function pool(): ScopeTrail[] {
    return ui.includeExcluded ? allTrails(state.region) : displaySet(state.region).trails;
  }

  const grade = (trail: ScopeTrail, day = state.day): ConditionGrade | null =>
    gradeOf(state.scenario, state.region, trail, day);

  // Every condition filter reads the selected day and only the selected day. The day bar
  // owns the date dimension; a filter with a day of its own contradicted it.
  function passes(trail: ScopeTrail, filters: Filters): boolean {
    return matchesFilters({ trail, region: REGIONS[state.region], today: grade(trail) }, filters);
  }

  function computeResults(): { results: ScopeTrail[]; filteredCount: number } {
    const p = pool();
    const filtered = p.filter((t) => passes(t, state.filters));
    const searched = state.query ? filtered.filter((t) => matchesQuery(t, state.query)) : filtered;
    const region = REGIONS[state.region];
    // Past the horizon there is no route-specific grade, so a conditions sort has nothing
    // to rank on. Fall back rather than order by a grade that no longer exists; the list
    // header names the fallback so the change is never silent.
    const effectiveSort =
      state.day >= firstOutlookDay(providerFor(state.scenario, state.region)) &&
      CONDITION_SORTS.includes(state.sort)
        ? OUTLOOK_FALLBACK_SORT
        : state.sort;
    const rows = sortTrails(
      searched.map((t) => ({ trail: t, grade: grade(t), awayM: distanceAwayM(t, region) })),
      effectiveSort,
    );
    return { results: rows.map((r) => r.trail), filteredCount: searched.length };
  }

  function makeCtx(): Ctx {
    const { results, filteredCount } = computeResults();
    return {
      state,
      ui,
      units: state.units,
      region: REGIONS[state.region],
      provider: providerFor(state.scenario, state.region),
      display: displaySet(state.region),
      pool: pool(),
      results,
      filteredCount,
      grade,
      weather: (trail) => weatherOf(state.scenario, state.region, trail),
      countWith: (filters) => pool().filter((t) => passes(t, filters)).length,
      set: (patch) => {
        state = { ...state, ...patch };
        render();
      },
      setUi: (patch) => {
        ui = { ...ui, ...patch };
        render();
      },
    };
  }

  // ---- header ------------------------------------------------------------------------

  function searchField(ctx: Ctx): HTMLElement {
    const active = state.screen === 'search';
    const field = h('div', { class: `sfield${active ? ' is-active' : ''}` });

    if (active) {
      const back = h('button', { type: 'button', class: 'sf-back', 'aria-label': 'Back' }, icon('back', 16));
      back.addEventListener('click', () => {
        ui = { ...ui, searching: false };
        state = { ...state, screen: 'results' };
        render();
      });
      field.appendChild(back);
    } else {
      field.appendChild(icon('search', 16, 'sf-glyph'));
    }

    if (active) {
      // Assigning `.value` unconditionally would collapse the selection to the end of the
      // field on every render, so a caret parked mid-word jumps to the end on the next
      // keystroke. Only write when the DOM and the state actually disagree (a clear, a
      // goTo hint, a region change), never on the echo of the reader's own typing.
      if (searchInput.value !== state.query) searchInput.value = state.query;
      field.appendChild(searchInput);
    } else {
      // THE IDLE FIELD IS A PLACEHOLDER UNTIL THE READER PUTS SOMETHING IN IT. It used to
      // print the region name, which looks like entered text and like a scope the reader
      // cannot clear, when in fact it was only the default. Three states now:
      //
      //   a query          "long" in Rocky Mountain National Park
      //   a chosen place   the place, because tapping one in search IS entered scope
      //   neither          the placeholder, greyed, in the words the real input uses
      const placeholder = !state.query && state.placeLabel === null;
      const label = state.query
        ? `"${state.query}" in ${ctx.region.name}`
        : (state.placeLabel ?? SEARCH_PLACEHOLDER);
      const btn = h('button', { type: 'button', class: `sf-fake${placeholder ? ' is-placeholder' : ''}` }, label);
      btn.addEventListener('click', () => {
        ui = { ...ui, searching: true };
        state = { ...state, screen: 'search' };
        render();
      });
      field.appendChild(btn);
    }

    if (state.query) {
      const clear = h('button', { type: 'button', class: 'sf-clear', 'aria-label': 'Clear search' }, icon('close', 14));
      clear.addEventListener('click', () => {
        state = { ...state, query: '' };
        render();
      });
      field.appendChild(clear);
    }
    return field;
  }

  /**
   * The day bar.
   *
   * It read "Today / Tomorrow / Mon / Tue / Wed" and the review verdict was a question:
   * what does that mean? Three problems, all fixed here.
   *
   *   NO TITLE. A bare row of days above a list of trails could be anything: a filter, a
   *     departure day, a history. It now carries an overline naming its job, so the row
   *     reads "Conditions for → Tomorrow, Aug 5".
   *   NO DATES. A weekday abbreviation on its own makes the reader count forward from
   *     today, and "Mon" three days out is genuinely ambiguous. Every button now prints
   *     the real calendar date under the day name, from the device clock (see dayDate() in
   *     weather/provider.ts, which the weekday names are anchored to as well, so the two
   *     halves can never disagree).
   *   A WEAK SELECTED STATE. The active day was an amber fill on a row of pale buttons,
   *     which loses against the chip row directly above it. It now also carries a ring and
   *     a bolder name.
   *
   * The +36 h wall stays and gets louder rather than quieter: it is the single most
   * product-relevant constraint in the science response, and this row is where a reader
   * meets it. Each button still says HOURLY or OUTLOOK under the date, and the wall itself
   * carries the horizon and a title explaining what changes across it.
   */
  function dayScrubber(ctx: Ctx): HTMLElement {
    const provider = ctx.provider;
    const outlookFrom = firstOutlookDay(provider);
    const { dayIndex } = provider.now();
    const horizon = Math.round(provider.horizonHours);

    // WHERE THE WALL WOULD BE IF THE FORECAST WERE FRESH. Online the two are the same day
    // and only one wall is drawn, exactly as before. Offline the cached run reaches less far
    // than a current one would, so the live wall moves LEFT and a ghost is left standing
    // where a fresh fetch would have put it — see the ghost's own construction below.
    const freshFrom = firstOutlookDay(freshProviderFor(state.scenario, state.region));
    const freshHorizon = Math.round(freshProviderFor(state.scenario, state.region).horizonHours);
    const ageH = forecastAge();

    const wall = (hours: number, ghost: boolean): HTMLElement =>
      h(
        'div',
        {
          // No space before the unit: the wall sits between two day buttons in a row that
          // has to fit five of them, and every character here costs one there.
          class: `day-wall${ghost ? ' is-ghost' : ''}`,
          title: ghost
            ? `A forecast fetched now would reach +${hours} h. This one was fetched ${ageH} h ago, so it reaches ${hours - ageH} h and the live wall has moved back by a day.`
            : `Route-specific hourly forecasts reach +${hours} h. Past this line every trail shares one regional outlook.`,
        },
        h('span', { class: 'dw-line' }),
        h('span', { class: 'dw-label' }, `+${hours}h`),
      );

    const row = dragScroll(h('div', { class: 'dayscrub' }));
    for (let d = 0; d < SCRUB_DAYS; d++) {
      if (d === outlookFrom) row.appendChild(wall(horizon, false));
      // Drawn only when it is somewhere else. Two walls on one boundary would be one mark
      // pretending to be two, and online they are always the same boundary.
      else if (d === freshFrom && freshFrom !== outlookFrom) row.appendChild(wall(freshHorizon, true));
      // Today and Tomorrow keep their names: they are what people say, and they are
      // unambiguous. Everything past them is a weekday, abbreviated to three letters to
      // hold the row's width now that a date sits under it.
      const name = d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : weekdayLabel(dayIndex + d).slice(0, 3);
      const date = dateLabel(dayIndex + d);
      const on = d === state.day;
      const btn = h(
        'button',
        {
          type: 'button',
          class: `day${on ? ' on' : ''}${d >= outlookFrom ? ' is-outlook' : ''}`,
          'aria-label': `${weekdayLabel(dayIndex + d)} ${date}, ${d >= outlookFrom ? `regional outlook, past the +${horizon} h forecast` : 'hourly forecast'}`,
        },
        h('span', { class: 'd-name' }, name),
        h('span', { class: 'd-date' }, date),
        h('span', { class: 'd-mode' }, d >= outlookFrom ? 'outlook' : 'hourly'),
      );
      btn.setAttribute('aria-pressed', String(on));
      btn.addEventListener('click', () => {
        state = { ...state, day: d };
        render();
      });
      row.appendChild(btn);
    }

    // The title is part of the control, not a separate strip: it scrolls with nothing and
    // sits on the row it names. The data age shares that line rather than taking one of its
    // own, and it shares it with the day bar specifically because the wall in the row below
    // is the same fact: how old the forecast is and how far ahead it still reaches are one
    // number read from its two ends.
    return h(
      'div',
      { class: 'dayblock' },
      h(
        'div',
        { class: 'dayblock-head' },
        h('div', { class: 'dayblock-title' }, 'Conditions for'),
        dataAgeChip(ctx),
      ),
      row,
    );
  }

  /**
   * WHEN THIS FORECAST WAS FETCHED, in the SnowCast pattern: always on screen, no
   * interaction to reveal it, and quiet enough that it never reads as an error. Being
   * offline is the NORMAL condition on a US trail, not a fault, so nothing here is red,
   * nothing is a warning mark, and the online and offline forms are the same chip in the
   * same place at the same weight — one of them simply carries a glyph and a duration.
   *
   * TWO FACTS OFFLINE, AND THEY ARE NOT THE SAME FACT. The clock time is what SnowCast
   * shows and what a reader compares against their own watch; the duration is what actually
   * means something on a screen whose "now" is nowhere in view, and it is the number the
   * wall in the row below is derived from. Online there is only one, because a live run has
   * no age worth printing.
   */
  function dataAgeChip(ctx: Ctx): HTMLElement {
    const ageH = forecastAge();
    // Hours BEFORE now, so a negative offset: the run was fetched in the past and `now()`
    // has not moved (grading.ts's FORECAST AGE block explains why it must not).
    const fetched = clockLabel(ctx.provider, -ageH);
    if (ageH <= 0) {
      return h('div', { class: 'data-age' }, h('span', {}, `Updated ${fetched}`));
    }
    return h(
      'div',
      { class: 'data-age is-offline' },
      icon('offline', 12, 'da-glyph'),
      // Same relabelling as weather-on-route's chip, and for the same reason: a bare clock
      // beside "Offline" does not say whether it is now or the fetch. Kept identical across
      // the two pages so a reader who learns one has learned both.
      h('span', {}, `Offline · data from ${fetched} (${ageH} h old)`),
    );
  }

  /**
   * Four strips above the list and no more: the field, one chip row, the scrubber, the area
   * conditions readout. The count-and-sort row sits with the list itself.
   *
   * Two mono notes used to hang off the scrubber, one describing the provider's grid and
   * one explaining what happens past +36 h. Both were narrative: the scrubber already
   * marks the wall and labels every day HOURLY or OUTLOOK, and the pill on each card says
   * Outlook. The prose column beside the phone explains it once, which is the right
   * number of times.
   *
   * The area strip is the fourth, and it goes UNDER the day bar on purpose: the bar owns the
   * date dimension, and the strip answers "what is the day like here" for whichever day the
   * bar has selected. It is not in the list, so it does not scroll away from the cards it is
   * meant to be compared against; area.ts has the rest of the reasoning. It is dropped on the
   * search screen along with the chips and the bar, because there is no selected day on screen
   * there to attach it to.
   */
  function buildHeader(ctx: Ctx): void {
    const kids: (HTMLElement | null)[] = [searchField(ctx)];
    if (state.screen !== 'search') {
      kids.push(filterChipRow(ctx), dayScrubber(ctx), areaStrip(ctx));
    }
    headHost.replaceChildren(...kids.filter((k): k is HTMLElement => k != null));
  }

  // ---- map ---------------------------------------------------------------------------

  // Outlook is no longer a fourth colour. It is the same three levels drawn muted, so the
  // legend says that rather than listing a grey the map no longer paints.
  //
  // The legend is mounted ONCE with the map layer (a WebGL canvas is not rebuilt per
  // render), so the note cannot be built conditionally here or it would never update when
  // the day changes. It is a persistent node toggled by syncMap.
  function mapLegend(): HTMLElement {
    const item = (level: string, label: string): HTMLElement =>
      h('span', { class: 'lg-item' }, h('i', { class: 'lg-swatch', style: `background:${LEVEL_COLOR[level]}` }), label);
    return h(
      'div',
      { class: 'map-legend' },
      // "not by source" was a benchmark answer to a benchmark question, and nobody inside a
      // trail app is asking which agency published a line.
      h('div', { class: 'lg-title' }, 'Tinted by conditions'),
      h('div', { class: 'lg-row' }, item('prime', 'Good'), item('mixed', 'Mixed'), item('poor', 'Poor')),
      legendNote,
    );
  }

  function syncMap(ctx: Ctx): void {
    const showMap = state.view === 'map' || state.screen === 'map' || state.screen === 'peek';
    if (!showMap) {
      mapLayer.setAttribute('hidden', '');
      return;
    }
    mapLayer.removeAttribute('hidden');

    // The muted-colour note only means anything on an outlook day.
    legendNote.hidden = state.day < firstOutlookDay(ctx.provider);

    if (!pmap) {
      pmap = new PhoneMap(mapCanvas, {
        bbox: ctx.region.bbox,
        onPick: (id) => {
          if (!alive) return;
          state = id
            ? { ...state, selected: id, screen: 'peek', view: 'map' }
            : { ...state, selected: null, screen: 'results', view: 'map' };
          render();
        },
      });
    }
    pmap.setTrails(ctx.results.map((t) => trailFeature(t, grade(t))));
    pmap.setSelected(state.selected);
    // The layer was display:none a moment ago, so the canvas has no size until now.
    requestAnimationFrame(() => pmap?.resize());
  }

  let mapRegion: RegionId | null = null;
  let wasMap = false;

  /**
   * Camera policy: frame the region on a region change, and frame the current result set
   * each time the reader arrives on the map from the list. A pan or zoom inside the map
   * then sticks, because refitting under someone's finger is worse than a stale frame.
   * Opening a trail is the exception and is handled by openTrail(), which frames the trail.
   */
  function syncMapCamera(ctx: Ctx): void {
    if (!pmap) return;
    const onMap = state.view === 'map' || state.screen === 'map' || state.screen === 'peek';
    if (mapRegion !== state.region) {
      mapRegion = state.region;
      pmap.fitBBox(ctx.region.bbox, 20);
    } else if (onMap && !wasMap && state.screen !== 'peek') {
      pmap.fitBBox(resultsBBox(ctx) ?? ctx.region.bbox, 22);
    }
    wasMap = onMap;
  }

  function resultsBBox(ctx: Ctx): [number, number, number, number] | null {
    if (ctx.results.length === 0) return null;
    let [w, s, e, n] = [180, 90, -180, -90];
    for (const t of ctx.results) {
      w = Math.min(w, t.bbox[0]);
      s = Math.min(s, t.bbox[1]);
      e = Math.max(e, t.bbox[2]);
      n = Math.max(n, t.bbox[3]);
    }
    return [w, s, e, n];
  }

  // ---- view toggle + tab bar -----------------------------------------------------------

  function viewToggle(): HTMLElement {
    const toMap = state.view !== 'map';
    const btn = h(
      'button',
      { type: 'button', class: 'view-toggle' },
      icon(toMap ? 'map' : 'list', 15),
      h('span', {}, toMap ? 'Map' : 'List'),
    );
    btn.addEventListener('click', () => {
      state = { ...state, view: toMap ? 'map' : 'list', screen: 'results', selected: toMap ? state.selected : null };
      render();
    });
    return btn;
  }

  function buildTabBar(): HTMLElement {
    const bar = h('nav', { class: 'tabbar', 'aria-label': 'Sections' });
    for (const t of TABS) {
      const live = t.id === 'explore';
      const btn = h(
        'button',
        { type: 'button', class: `tab${live ? ' on' : ' is-off'}` },
        icon(t.glyph, 19),
        h('span', {}, t.label),
      );
      if (!live) {
        btn.setAttribute('aria-disabled', 'true');
        // In-UI copy is product copy: a disabled tab says "coming soon", not "phase 2 of a
        // prototype". What is and is not built is the prose column's business.
        btn.title = 'Coming soon';
      }
      bar.appendChild(btn);
    }
    return bar;
  }

  // ---- sheets ---------------------------------------------------------------------------

  function buildSheets(ctx: Ctx): void {
    let content: HTMLElement | null = null;
    let dismiss: (() => void) | null = null;

    if (ui.sheet === 'filters') {
      content = filterSheet(ctx);
      dismiss = () => ctx.setUi({ sheet: null });
    } else if (ui.sheet === 'sort') {
      content = sortSheet(ctx);
      dismiss = () => ctx.setUi({ sheet: null });
    } else if (state.screen === 'peek' && state.selected) {
      const trail = pool().find((t) => t.id === state.selected) ?? allTrails(state.region).find((t) => t.id === state.selected);
      if (trail) {
        content = peekSheet(ctx, trail);
        dismiss = () => ctx.set({ selected: null, screen: 'results', view: 'map' });
      }
    }

    // The peek owns its own MapLibre instance (see peek.ts's header note on lifecycle),
    // and it has no way to know its sheet closed: a closed peek simply stops being asked
    // to render. This is the other half of that lifecycle, torn down whenever the peek is
    // not what is actually going on screen this render, on every close path uniformly (the
    // X, the scrim, a filter or sort sheet superseding it, a region or search navigation).
    if (!(state.screen === 'peek' && state.selected && content)) teardownPeekMap();

    if (!content) {
      sheetLayer.setAttribute('hidden', '');
      sheetLayer.replaceChildren();
      return;
    }
    const scrim = h('div', { class: 'sh-scrim' });
    if (dismiss) scrim.addEventListener('click', dismiss);
    sheetLayer.removeAttribute('hidden');
    sheetLayer.replaceChildren(scrim, content);
  }

  // ---- render ----------------------------------------------------------------------------

  function render(): void {
    if (!alive) return;
    const ctx = makeCtx();

    // ---- focus and caret, captured BEFORE any DOM work -------------------------------
    //
    // THE TYPING BUG THIS FIXES. Every keystroke re-renders, and buildHeader() builds a
    // fresh .sfield and moves the persistent input into it. Moving a node detaches it, and
    // detaching a focused node blurs it, so the field lost focus on the first character and
    // every character after it went to <body>: typing "long" left "l" in the field.
    //
    // The old refocus below was gated on `ui.searching`, which is only set when the reader
    // taps the FAKE field. A reader who arrived on the search screen another way (the
    // prose column's goTo, or simply clicking the real input) was never covered.
    //
    // Two changes fix it at the root rather than at the symptom. Focusing the input now
    // sets `ui.searching` itself (see the listener at the bottom of this file), so intent
    // is recorded wherever it comes from; and the render captures whether the input held
    // focus and where the caret was, then puts both back after the move. The caret is
    // restored to its exact offsets, not to the end, so typing mid-string works.
    const hadFocus = document.activeElement === searchInput;
    const caretStart = searchInput.selectionStart;
    const caretEnd = searchInput.selectionEnd;

    buildHeader(ctx);

    const prevScroll = scrollArea.scrollTop;
    const kids: HTMLElement[] = [];

    if (state.screen === 'search') {
      kids.push(state.query ? searchResults(ctx, openTrail) : searchEntry(ctx, openTrail));
    } else if (state.view === 'map' || state.screen === 'map' || state.screen === 'peek') {
      // The map is its own layer; the scroll area only carries the count strip above it.
      // The same statement the list header makes, in one line: the count, and what the
      // order is. On a conditions sort that includes the day it ranks for, because the map
      // hides the list header and would otherwise drop the binding.
      const mapSort = sortIsUnavailable(ctx) ? OUTLOOK_FALLBACK_SORT : state.sort;
      kids.push(
        h(
          'div',
          { class: 'map-bar' },
          h('span', { class: 'mb-count' }, `${ctx.results.length} trails`),
          h(
            'span',
            { class: 'mb-sort' },
            CONDITION_SORTS.includes(mapSort)
              ? orderLabel(ctx, mapSort)
              : `sorted by ${SORTS.find((s) => s.id === mapSort)?.label ?? ''}`,
          ),
        ),
      );
    } else {
      kids.push(listHeader(ctx), resultsList(ctx, openTrail));
    }

    scrollArea.replaceChildren(...kids);
    // A re-render must not throw the reader back to the top of a long list. The search
    // screen is the one place a reset is right, because its content changes wholesale.
    scrollArea.scrollTop = state.screen === 'search' ? 0 : prevScroll;

    body.classList.toggle('is-map', state.view === 'map' || state.screen === 'peek' || state.screen === 'map');
    syncMap(ctx);
    syncMapCamera(ctx);
    buildSheets(ctx);

    // The view toggle floats over whichever body is showing, and only outside search.
    root.querySelector('.view-toggle')?.remove();
    if (state.screen !== 'search') body.appendChild(viewToggle());

    // Restore the field. `hadFocus` covers the reader who is typing right now; `ui.searching`
    // covers the reader who has just declared intent (tapped the fake field, or arrived via
    // a goTo hint) and whose focus has not landed yet. Nothing here can steal focus from
    // elsewhere in the phone: outside the search screen it does not run at all, and inside
    // it the only other focusable things are the back and clear buttons, which set
    // `searching: false` or re-render with the input already focused.
    if (state.screen === 'search' && (hadFocus || ui.searching) && document.activeElement !== searchInput) {
      searchInput.focus({ preventScroll: true });
      const n = searchInput.value.length;
      const from = hadFocus && caretStart != null ? Math.min(caretStart, n) : n;
      const to = hadFocus && caretEnd != null ? Math.min(caretEnd, n) : n;
      searchInput.setSelectionRange(from, to);
    }

    fillGrades();
    fillArea();
  }

  // ---- grade filling ----------------------------------------------------------------------

  let fetching = false;
  function fillGrades(): void {
    if (fetching) return;
    // One day, the selected one. It used to fetch the following day as well, for a
    // `good-tomorrow` chip that no longer exists.
    const days = [state.day];
    const trails = allTrails(state.region);
    const missing = trails.some((t) => days.some((d) => gradeOf(state.scenario, state.region, t, d) === null));
    if (!missing) return;

    fetching = true;
    const scenario = state.scenario;
    const region = state.region;
    void ensureGrades(scenario, region, trails, days).then(() => {
      fetching = false;
      if (alive) render();
    });
  }

  /**
   * The area strip's own one-point fetch, on its own in-flight flag.
   *
   * Separate from `fillGrades` rather than folded into it because they are not the same
   * request and must not gate each other: 87 route fetches are in flight for most of the
   * first frame, and the strip should not wait behind them for a single point. One request
   * per scenario and region, cached in area.ts, so this is a no-op on every render after the
   * first for each combination.
   */
  let fetchingArea = false;
  function fillArea(): void {
    if (fetchingArea) return;
    const provider = providerFor(state.scenario, state.region);
    if (areaWeatherOf(state.scenario, state.region)) return;

    fetchingArea = true;
    const scenario = state.scenario;
    const region = state.region;
    void ensureAreaWeather(provider, scenario, region, REGIONS[region].assumedLocation).then(() => {
      fetchingArea = false;
      if (alive) render();
    });
  }

  // ---- actions -------------------------------------------------------------------------------

  function openTrail(trail: ScopeTrail): void {
    state = { ...state, selected: trail.id, screen: 'peek', view: 'map' };
    ui = { ...ui, searching: false };
    render();
    pmap?.fitBBox(trail.bbox, 60);
  }

  // ---- the search input ----------------------------------------------------------------------

  // Focusing the field IS the intent to search, whichever way the reader got there: a tap
  // on the fake field, a tab, a click straight into the real input, or a goTo from the
  // prose column. Recording it here rather than only in the fake field's click handler is
  // what makes the refocus in render() reliable. It deliberately does NOT re-render: a
  // render on focus during the browser's own focus dispatch is a good way to lose the
  // focus that just arrived, and nothing on screen depends on the flag until the next one.
  searchInput.addEventListener('focus', () => {
    if (!ui.searching) ui = { ...ui, searching: true };
  });

  searchInput.addEventListener('input', () => {
    state = { ...state, query: searchInput.value };
    render();
  });
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      state = { ...state, screen: 'results', view: 'list' };
      ui = { ...ui, searching: false };
      render();
    }
  });

  render();

  // ============================================================================
  // THE FROZEN CONTRACT
  // ============================================================================

  return {
    update(patch) {
      if (patch.onInteract) onInteract = patch.onInteract;
      // Connection state lives in grading.ts, not in PhoneState, so it is applied here
      // rather than folded into the state patch below. `!== undefined` and not a falsy
      // test: 0 is the live case and has to be able to arrive as a patch, or going back
      // online would be the one transition the control could not make.
      if (patch.forecastAgeH !== undefined) setForecastAge(patch.forecastAgeH);

      const nextRegion = patch.region ?? state.region;
      const regionChanged = nextRegion !== state.region;

      state = {
        ...state,
        region: nextRegion,
        scenario: patch.scenario ?? state.scenario,
        units: patch.units ?? state.units,
        // A trail id is region-scoped, and a place label names a place in the old region.
        // Filters, sort and day are region-independent and deliberately survive.
        ...(regionChanged ? { selected: null, placeLabel: null, query: '' } : {}),
      };
      if (regionChanged && state.screen === 'peek') state.screen = 'results';
      render();
    },

    goTo(next) {
      const hint = next.hint;
      const patch: Partial<PhoneState> = { screen: next.screen };
      if (next.view) patch.view = next.view;

      if (hint === 'empty') {
        patch.screen = 'search';
        patch.query = '';
        ui = { ...ui, searching: true, sheet: null };
      } else if (hint === 'query') {
        patch.screen = 'search';
        patch.query = DEMO_QUERY[state.region];
        ui = { ...ui, searching: true, sheet: null };
      } else if (hint === 'filters') {
        ui = { ...ui, sheet: 'filters', filterGroup: 'conditions', searching: false };
      } else if (hint === 'sort') {
        ui = { ...ui, sheet: 'sort', searching: false };
      } else if (hint === 'horizon') {
        // Park the scrubber on the first day the provider cannot resolve, which is the
        // whole point of the section: the card has to visibly change character.
        patch.day = Math.min(SCRUB_DAYS - 1, firstOutlookDay(providerFor(state.scenario, state.region)));
        ui = { ...ui, sheet: null, searching: false };
      } else {
        ui = { ...ui, sheet: null, searching: false };
      }

      // The peek needs something to peek at. Pick the top result rather than clearing the
      // reader's selection, so returning to the section shows the trail they were on.
      if (patch.screen === 'peek' && !state.selected) {
        const { results } = computeResults();
        if (results.length) patch.selected = results[0].id;
        patch.view = 'map';
      }
      if (patch.screen === 'map') patch.view = 'map';

      state = { ...state, ...patch };
      render();
      if (state.screen === 'peek' && state.selected) {
        const trail = pool().find((t) => t.id === state.selected);
        if (trail) pmap?.fitBBox(trail.bbox, 60);
      }
    },

    destroy() {
      alive = false;
      // Module state in grading.ts outlives this instance, so a phone torn down while
      // offline would hand its connection state to whatever mounts next.
      setForecastAge(0);
      for (const type of ['pointerdown', 'keydown', 'input', 'change', 'wheel'] as const) {
        root.removeEventListener(type, report, { capture: true });
      }
      pmap?.destroy();
      pmap = null;
      teardownPeekMap();
      // Reader photo uploads are live object URLs; the browser holds the file until they
      // are revoked, so leaving them behind leaks the image data for the page's lifetime.
      revokeUgcObjectUrls();
      container.replaceChildren();
    },
  };
}
