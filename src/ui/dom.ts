// Shared DOM + formatting helpers. (Phase 0 — owned by workstream C thereafter.)

import type { Units } from '../types';

type Child = Node | string | number | null | undefined | false;

interface Attrs {
  class?: string;
  id?: string;
  title?: string;
  href?: string;
  target?: string;
  rel?: string;
  type?: string;
  value?: string;
  html?: string; // innerHTML (already-escaped/trusted markup)
  dataset?: Record<string, string>;
  style?: string;
  [key: string]: unknown;
}

/**
 * Terse hyperscript helper. `h('div.foo#bar', {…}, child, child)`.
 * Tag string supports `tag.class.class#id` shorthand.
 */
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const idMatch = tag.match(/#([\w-]+)/);
  const classMatches = tag.match(/\.([\w-]+)/g);
  const tagName = tag.replace(/[.#].*$/, '') || 'div';
  const el = document.createElement(tagName);

  if (idMatch) el.id = idMatch[1];
  if (classMatches) el.className = classMatches.map((c) => c.slice(1)).join(' ');

  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (val == null || val === false) continue;
      if (key === 'class') {
        el.className = (el.className ? el.className + ' ' : '') + String(val);
      } else if (key === 'html') {
        el.innerHTML = String(val);
      } else if (key === 'dataset') {
        for (const [dk, dv] of Object.entries(val as Record<string, string>)) {
          el.dataset[dk] = dv;
        }
      } else if (key === 'style') {
        el.setAttribute('style', String(val));
      } else if (key in el) {
        // property assignment (value, href, type, …)
        (el as unknown as Record<string, unknown>)[key] = val;
      } else {
        el.setAttribute(key, String(val));
      }
    }
  }

  for (const child of children) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Tokens kept uppercase when title-casing shouty trail names. Deliberately short:
// ambiguous words (AT, US, CO) are left to the default rule.
const NAME_ACRONYMS = new Set([
  'nst', 'nht', 'nrt', 'cdt', 'pct', 'ohv', 'atv', '4wd', 'mtb', 'blm', 'usfs',
  'nps', 'usgs', 'ccc', 'ii', 'iii', 'iv', 'xc',
]);
const NAME_SMALL_WORDS = new Set(['of', 'the', 'and', 'to', 'a', 'an', 'at', 'in', 'on', 'for', 'de', 'del', 'la']);

/**
 * Harmonize trail names for display: "BLACK BEAR LAKE TRAIL #942" → "Black Bear
 * Lake Trail #942". Only transforms names that are entirely uppercase (mixed-case
 * names are already deliberate); underlying data stays verbatim.
 */
export function displayTrailName(raw: string | null | undefined): string {
  if (!raw) return '';
  if (raw !== raw.toUpperCase()) return raw;
  let first = true;
  return raw.toLowerCase().replace(/[a-z0-9][a-z0-9']*/g, (w) => {
    let out: string;
    if (NAME_ACRONYMS.has(w)) out = w.toUpperCase();
    else if (!first && NAME_SMALL_WORDS.has(w)) out = w;
    else {
      out = w.charAt(0).toUpperCase() + w.slice(1);
      out = out.replace(/^Mc([a-z])/, (_m, c: string) => `Mc${c.toUpperCase()}`);
      out = out.replace(/^O'([a-z])/, (_m, c: string) => `O'${c.toUpperCase()}`);
    }
    first = false;
    return out;
  });
}

/** Escape a string for safe interpolation into innerHTML. */
export function escapeHtml(input: unknown): string {
  const s = input == null ? '' : String(input);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Fixed-decimal number with thousands separators. */
export function fmtNumber(n: number, decimals = 0): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Meters → miles, one decimal (e.g. 3.2). */
export function metersToMiles(m: number): number {
  return m / 1609.344;
}

/** Meters → feet, rounded. */
export function metersToFeet(m: number): number {
  return m * 3.28084;
}

/** Format a lon/lat pair as "40.3128°N 105.6459°W" (4 decimals). */
export function fmtCoord(lng: number, lat: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns} ${Math.abs(lng).toFixed(4)}°${ew}`;
}

/** Format miles for display, e.g. "3.2 MI". */
export function fmtMiles(miles: number): string {
  return `${miles.toFixed(1)} MI`;
}

/** Format an elevation in feet, e.g. "9,475 FT". */
export function fmtFeet(feet: number): string {
  return `${fmtNumber(Math.round(feet))} FT`;
}

// --- units-aware formatters (source attribute values stay verbatim) ------------
// These are the single source of truth for lengths/elevations WE derive. They take
// meters (our internal unit) and render in the user's chosen system.

/** Meters → display distance per units, e.g. "9.2 mi" / "14.8 km" (1 decimal). */
export function fmtDistance(meters: number, units: Units): string {
  return units === 'metric'
    ? `${(meters / 1000).toFixed(1)} km`
    : `${(meters / 1609.344).toFixed(1)} mi`;
}

/** Meters → display elevation per units, e.g. "12,713 ft" / "3,875 m" (0 decimals). */
export function fmtElevation(meters: number, units: Units): string {
  return units === 'metric'
    ? `${fmtNumber(Math.round(meters))} m`
    : `${fmtNumber(Math.round(meters * 3.28084))} ft`;
}
