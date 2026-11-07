// Trail Scope phone — search entry and search results (screens 1 and 2).
//
// One free-form field resolving to two kinds of thing, as AllTrails does: PLACES above
// TRAILS, in labelled sections with typed icons. Place is the search, not a filter
// (SCOPE_PLAN §6): a park is where you are going, and turning park, forest and state into
// chips forces a nonsense interaction (pick a state, then a park inside it, then a forest
// which is not inside the park). Shortcuts on the empty state do the same job in one tap.
//
// The place index here is a hand-written stand-in for `src/data/places.ts`, which carries
// the 50 state bboxes, 329 NPS unit names and 112 USFS forest names for real. The
// prototype only has derived trails for three regions, so the index is deliberately seeded
// with two places it CANNOT open (Yosemite, Great Smoky Mountains): they resolve, they are
// findable, and tapping them declines. What they say when they decline is PRODUCT copy
// ("No trails here yet"), not an explanation of the prototype's data coverage: a real
// product with a partial rollout has exactly this state and says exactly this. Why the
// coverage is partial is the prose column's business, not the phone's.

import { h } from '../../ui/dom';
import { conditionPill, difficultyDot, dragScroll, icon } from './ui';
import { REGIONS, formatDuration, formatElevation, formatLength } from '../model';
import { matchesQuery } from './query';
import { displaySet } from '../data';
import type { Ctx } from './ctx';
import type { PlaceHit, RegionId, ScopeTrail } from '../types';

// ============================================================================
// THE PLACE INDEX
// ============================================================================

const PLACES: PlaceHit[] = [
  {
    kind: 'park',
    name: 'Rocky Mountain National Park',
    subtitle: 'National Park · Colorado, United States',
    bbox: REGIONS.rmnp.bbox,
    region: 'rmnp',
  },
  {
    kind: 'town',
    name: 'Estes Park',
    subtitle: 'Town · Colorado, United States',
    bbox: REGIONS.rmnp.bbox,
    region: 'rmnp',
  },
  {
    kind: 'peak',
    name: 'Longs Peak',
    subtitle: 'Peak · 4,346 m · Colorado, United States',
    bbox: REGIONS.rmnp.bbox,
    region: 'rmnp',
  },
  {
    kind: 'forest',
    name: 'Arapaho and Roosevelt National Forests',
    subtitle: 'National Forest · Colorado, United States',
    bbox: REGIONS.rmnp.bbox,
    region: 'rmnp',
  },
  {
    kind: 'state',
    name: 'Colorado',
    subtitle: 'State · United States',
    bbox: REGIONS.rmnp.bbox,
    region: 'rmnp',
  },
  {
    kind: 'region',
    name: 'Adirondack High Peaks',
    subtitle: 'Forest Preserve · New York, United States',
    bbox: REGIONS.adk.bbox,
    region: 'adk',
  },
  {
    kind: 'town',
    name: 'Lake Placid',
    subtitle: 'Town · New York, United States',
    bbox: REGIONS.adk.bbox,
    region: 'adk',
  },
  {
    kind: 'peak',
    name: 'Mount Marcy',
    subtitle: 'Peak · 1,629 m · New York, United States',
    bbox: REGIONS.adk.bbox,
    region: 'adk',
  },
  {
    kind: 'state',
    name: 'New York',
    subtitle: 'State · United States',
    bbox: REGIONS.adk.bbox,
    region: 'adk',
  },
  {
    kind: 'park',
    name: 'Lake of the Ozarks State Park',
    subtitle: 'State Park · Missouri, United States',
    bbox: REGIONS.ozarks.bbox,
    region: 'ozarks',
  },
  {
    kind: 'park',
    name: 'Ha Ha Tonka State Park',
    subtitle: 'State Park · Missouri, United States',
    bbox: REGIONS.ozarks.bbox,
    region: 'ozarks',
  },
  {
    kind: 'town',
    name: 'Camdenton',
    subtitle: 'Town · Missouri, United States',
    bbox: REGIONS.ozarks.bbox,
    region: 'ozarks',
  },
  // Findable, not openable. See the header.
  {
    kind: 'park',
    name: 'Yosemite National Park',
    subtitle: 'National Park · California, United States',
    bbox: [-119.89, 37.49, -119.2, 38.19],
    region: null,
  },
  {
    kind: 'park',
    name: 'Great Smoky Mountains National Park',
    subtitle: 'National Park · Tennessee, United States',
    bbox: [-84.0, 35.42, -83.0, 35.8],
    region: null,
  },
];

const PLACE_GLYPH: Record<PlaceHit['kind'], string> = {
  park: 'park',
  forest: 'forest',
  state: 'state',
  town: 'town',
  peak: 'peak',
  region: 'forest',
};

/** One shortcut per kind for the entry screen, restricted to what this build can open. */
function shortcutsFor(region: RegionId): PlaceHit[] {
  const own = PLACES.filter((p) => p.region === region);
  const pick = (kind: PlaceHit['kind']): PlaceHit | undefined => own.find((p) => p.kind === kind);
  return [pick('park') ?? pick('region'), pick('forest') ?? pick('peak'), pick('town')].filter(
    (p): p is PlaceHit => p != null,
  );
}

function placeMatches(query: string): PlaceHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return PLACES.filter((p) => p.name.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q)).slice(0, 5);
}

// ============================================================================
// ROWS
// ============================================================================

function placeRow(ctx: Ctx, place: PlaceHit): HTMLElement {
  const sub = h('span', { class: 's-sub' }, place.region ? place.subtitle : `${place.subtitle} · no trails yet`);
  const row = h(
    'button',
    { type: 'button', class: `s-row${place.region ? '' : ' is-inert'}` },
    h('span', { class: 's-tile' }, icon(PLACE_GLYPH[place.kind], 18)),
    h('span', { class: 's-body' }, h('span', { class: 's-name' }, place.name), sub),
  );
  row.addEventListener('click', () => {
    if (!place.region) {
      // A place that resolves but cannot open. Product tone: it says what the reader gets,
      // once, on the row they touched.
      row.classList.add('is-refused');
      sub.textContent = 'No trails here yet';
      return;
    }
    ctx.set({
      region: place.region,
      placeLabel: place.name,
      query: '',
      screen: 'results',
      view: 'list',
      selected: null,
    });
    ctx.setUi({ searching: false });
  });
  return row;
}

function trailRow(ctx: Ctx, trail: ScopeTrail, onOpen: () => void): HTMLElement {
  const units = ctx.units;
  const row = h(
    'button',
    { type: 'button', class: 's-row' },
    h('span', { class: 's-tile' }, icon('trail', 18)),
    h(
      'span',
      { class: 's-body' },
      h('span', { class: 's-name' }, trail.name),
      h(
        'span',
        { class: 's-meta' },
        difficultyDot(trail.difficulty, { label: false }),
        h('span', { class: 'cm-dot' }, '·'),
        h('span', {}, formatLength(trail.lengthM, units)),
        h('span', { class: 'cm-dot' }, '·'),
        h('span', {}, formatElevation(trail.gainM, units)),
        h('span', { class: 'cm-dot' }, '·'),
        h('span', {}, formatDuration(trail.estMinutes)),
      ),
      conditionPill(ctx.grade(trail), { compact: true, levelOnly: true }),
    ),
  );
  row.addEventListener('click', onOpen);
  return row;
}

function sectionHead(label: string): HTMLElement {
  return h('div', { class: 's-head' }, label);
}

// ============================================================================
// SCREEN 1 — SEARCH ENTRY
// ============================================================================

/** Two prominent trails in the region, standing in for a real recent-search history. */
function recentTrails(region: RegionId): ScopeTrail[] {
  return [...displaySet(region).trails].sort((a, b) => b.prominence - a.prominence).slice(0, 2);
}

export function searchEntry(ctx: Ctx, onOpenTrail: (t: ScopeTrail) => void): HTMLElement {
  const region = ctx.state.region;
  const home = PLACES.find((p) => p.region === region && (p.kind === 'park' || p.kind === 'region'));

  const current = h(
    'button',
    { type: 'button', class: 's-row' },
    h('span', { class: 's-tile' }, icon('locate', 18)),
    h(
      'span',
      { class: 's-body' },
      h('span', { class: 's-name' }, 'Current location'),
      h('span', { class: 's-sub' }, ctx.region.assumedLocationLabel),
    ),
  );
  current.addEventListener('click', () => {
    ctx.set({ query: '', placeLabel: null, screen: 'results', view: 'list' });
    ctx.setUi({ searching: false });
  });

  const shortcuts = dragScroll(h(
    'div',
    { class: 's-shortcuts' },
    ...shortcutsFor(region).map((p) => {
      const tile = h(
        'button',
        { type: 'button', class: 'sc-tile' },
        icon(PLACE_GLYPH[p.kind], 20),
        h('span', { class: 'sc-name' }, p.name),
        h('span', { class: 'sc-kind' }, p.kind === 'region' ? 'forest preserve' : p.kind),
      );
      tile.addEventListener('click', () => {
        ctx.set({ region: p.region ?? region, placeLabel: p.name, query: '', screen: 'results', view: 'list' });
        ctx.setUi({ searching: false });
      });
      return tile;
    }),
  ));

  // The strip that used to close this screen counted the place index (50 states, 329 NPS
  // units, 112 forests) and then admitted the prototype only has three of them. It was a
  // footnote about the build, sitting inside the product, and it is gone: the prose column
  // is where the coverage story belongs.
  return h(
    'div',
    { class: 'screen screen-search' },
    current,
    sectionHead('Recent searches'),
    home ? placeRow(ctx, home) : null,
    ...recentTrails(region).map((t) => trailRow(ctx, t, () => onOpenTrail(t))),
    sectionHead('Jump to'),
    shortcuts,
  );
}

// ============================================================================
// SCREEN 2 — SEARCH RESULTS
// ============================================================================

export function searchResults(ctx: Ctx, onOpenTrail: (t: ScopeTrail) => void): HTMLElement {
  const q = ctx.state.query;
  const places = placeMatches(q);
  const trails = ctx.pool.filter((t) => matchesQuery(t, q)).slice(0, 12);

  const body = h('div', { class: 'screen screen-search' });

  if (places.length) {
    body.appendChild(sectionHead('Places'));
    for (const p of places) body.appendChild(placeRow(ctx, p));
  }

  if (trails.length) {
    body.appendChild(sectionHead(`Trails in ${ctx.region.name}`));
    for (const t of trails) body.appendChild(trailRow(ctx, t, () => onOpenTrail(t)));
  }

  if (!places.length && !trails.length) {
    body.appendChild(
      h(
        'div',
        { class: 'empty-state' },
        icon('search', 22, 'es-glyph'),
        h('div', { class: 'es-title' }, `No results for "${q}"`),
        // The old copy here explained the open-data naming gap to a hiker who had mistyped
        // a trail name. An empty state's job is to say what to do next.
        h('div', { class: 'es-body' }, 'Try a different trail or place name.'),
      ),
    );
  } else {
    const seeAll = h('button', { type: 'button', class: 's-seeall' }, `See all ${ctx.region.name} trails matching "${q}"`);
    seeAll.addEventListener('click', () => {
      ctx.set({ screen: 'results', view: 'list' });
      ctx.setUi({ searching: false });
    });
    body.appendChild(seeAll);
  }

  return body;
}
