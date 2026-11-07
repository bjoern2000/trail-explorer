// Shared top-bar navigation across every TrailScope page.
//
// One list, one component: adding an exploration means adding ONE entry to PAGES
// (plus its html file + a vite input). Each page entry point calls mountNav('<id>')
// before its own boot so the bar is present even if that page's map/data fails.
//
// The bar carries the wordmark; page-level headers (sidebar .brand, .mx-head) carry
// the section name and descriptor, so nothing is duplicated.

export interface NavPage {
  id: string;
  /** Tab label. Kept short — the bar is one line at every width the app supports. */
  label: string;
  href: string;
  /** Descriptor for the page's own header; also the tab's title attribute. */
  blurb: string;
  /**
   * Which half of the argument this page belongs to.
   *
   * `evidence` pages ask whether open trail data is good enough to build on; `product` pages
   * argue what to build with it. Two different audiences and two different questions, and
   * with eight sections in one bar they had started reading as one undifferentiated run. The
   * bar draws a rule between the groups rather than sorting them apart, because the order
   * they are already in is the order the work happened in and that is worth keeping.
   */
  group: 'evidence' | 'product';
}

export const PAGES: NavPage[] = [
  { id: 'map', label: 'Map', href: '/index.html', blurb: 'US trail data sources on one 3D map' , group: 'evidence' },
  {
    id: 'matrix',
    label: 'Source matrix',
    href: '/matrix.html',
    blurb: 'What each open source covers, licenses, and reports',
    group: 'evidence',
  },
  {
    id: 'benchmark',
    label: 'Benchmark',
    href: '/benchmark.html',
    blurb: 'AllTrails vs open-data coverage, three regions',
    group: 'evidence',
  },
  {
    id: 'merge',
    label: 'Segment merge',
    href: '/merge.html',
    blurb: 'How OSM way fragments become one trail',
    group: 'evidence',
  },
  {
    id: 'datamodel',
    // "Data model", not "Trail data model": the bar is already at 892 px of a 940 px budget
    // at 1024 px (see the briefing label comment below); the blurb carries the rest.
    label: 'Data model',
    href: '/data-model.html',
    blurb: 'Entities behind a trail: segments, routes, places, and attribute provenance',
    group: 'evidence',
  },
  {
    id: 'scope',
    label: 'Trail Explorer',
    href: '/scope.html',
    blurb: 'Discovery UX prototype: conditions as a first-class ranking and filter dimension',
    group: 'product',
  },
  {
    id: 'trail',
    label: 'Weather-on-route',
    href: '/weather-on-route.html',
    blurb: 'On-route conditions along a trail, mapped to arrival times',
    group: 'product',
  },
  {
    id: 'digest',
    label: 'Conditions digest',
    href: '/digest.html',
    blurb: 'A whole region across a whole week, from the same grades the list ranks with',
    group: 'product',
  },
  {
    id: 'briefing',
    // "Briefing" rather than "Region briefing": at 1024 px the eight-tab bar is 892 px of a
    // 940 px budget, and the longer label pushed the whole bar into a horizontal scroll on
    // every page in the app. The blurb carries the rest of the name.
    label: 'Briefing',
    href: '/briefing.html',
    // The only page in the app whose content is not computed, so the tab says so: a reader
    // arriving from the digest has to know before the click that the numbers change status.
    blurb: 'Sample mockup: where a region\'s day is good, where it is not, and what to do',
    group: 'product',
  },
];

/**
 * The Super Res tab exists only in a build that contains the page.
 *
 * `superres.html` is an opt-in vite input (see vite.config.ts for why: its /api/ssds/*
 * proxy routes are unauthenticated, so a default-on build would publish a proxy to a TWC
 * QA API). Listing the tab unconditionally would leave every deployed page linking to a
 * 404, so the entry follows the same build flag rather than a second, hand-kept list.
 */
declare const __SUPERRES__: boolean;

if (typeof __SUPERRES__ !== 'undefined' && __SUPERRES__) {
  PAGES.push({
    id: 'superres',
    label: 'Super Res API',
    href: '/superres.html',
    blurb: 'Live TWC super-resolution point forecasts for a coordinate',
    group: 'product',
  });
}

/** Insert the nav bar as the first element in <body> and flag the body for layout. */
export function mountNav(activeId: string): void {
  const body = document.body;
  if (!body || body.querySelector('.topnav')) return;

  const nav = document.createElement('header');
  nav.className = 'topnav';

  const brand = document.createElement('a');
  brand.className = 'tn-brand';
  brand.href = '/index.html';
  brand.innerHTML = 'Trail<span class="thin">Scope</span>';
  nav.appendChild(brand);

  const tabs = document.createElement('nav');
  tabs.className = 'tn-tabs';
  tabs.setAttribute('aria-label', 'Sections');
  // A rule wherever the group changes, so the evidence half and the product half read as two
  // runs rather than eight peers. Driven off the data rather than a hard-coded index, so
  // adding a section cannot put the rule in the wrong place. `aria-hidden` because it is a
  // visual grouping cue and a screen reader already has each tab's blurb as its title.
  let lastGroup: NavPage['group'] | null = null;
  for (const page of PAGES) {
    if (lastGroup !== null && page.group !== lastGroup) {
      const sep = document.createElement('span');
      sep.className = 'tn-sep';
      sep.setAttribute('aria-hidden', 'true');
      tabs.appendChild(sep);
    }
    lastGroup = page.group;

    const a = document.createElement('a');
    a.className = 'tn-tab' + (page.id === activeId ? ' on' : '');
    a.href = page.href;
    a.textContent = page.label;
    a.title = page.blurb;
    if (page.id === activeId) a.setAttribute('aria-current', 'page');
    tabs.appendChild(a);
  }
  nav.appendChild(tabs);

  const tag = document.createElement('span');
  tag.className = 'tn-tag';
  tag.textContent = 'OPEN TRAIL DATA EVALUATION';
  nav.appendChild(tag);

  body.insertBefore(nav, body.firstChild);
  body.classList.add('has-topnav');
}
