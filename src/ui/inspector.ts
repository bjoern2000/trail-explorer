// Workstream D — selected-trail card: source badge + license, name, meta, elevation
// profile, populated-first attribute table, license note, and FLY TO 3D / RAW JSON /
// GPX actions. Reads the selection from the store; the ✕ clears it (store.selected =
// null), which the layers module observes to drop the selection halo.

import type { AppState, SelectedTrail, SourceId, Units } from '../types';
import type { Store } from '../store';
import { SOURCES, SOURCE_IDS } from '../registry';
import { h, escapeHtml, fmtNumber, fmtDistance, fmtElevation, displayTrailName } from './dom';
import { buildElevationProfile, type ElevationProfile } from '../data/elevation';
import { flyToTrail } from '../map/camera';
import { findCandidateSources, selectFromSource, nameFromMerged, probeSource, cacheHasTrail } from '../data/altsources';
import { featureLengthMeters } from '../data/loader';

const INTERNAL_KEYS = new Set(['__fid', '__source', '__segments', '__parts', '__other_clusters', '__sublayer']);

const FEET_PER_METER = 3.28084;

// The current card's unit-relabeler, so a units toggle updates the open card in place
// (no rebuild). Set on each buildCard, cleared when the selection is dropped.
let currentApplyUnits: ((units: Units) => void) | null = null;

// Merged features longer than this skip terrain sampling (hundreds of tile fetches).
const MAX_PROFILE_MI = 300;

const BADGE: Record<SourceId, string> = {
  osm: 'OSM',
  usfs: 'USFS',
  nps: 'NPS',
  blm: 'BLM',
  usgs: 'USGS',
  cotrex: 'COTREX',
  dec: 'DEC',
};

const LICENSE_INLINE: Record<string, { text: string; color: string }> = {
  'PUB DOM': { text: 'PUBLIC DOMAIN', color: 'var(--good)' },
  ODbL: { text: 'ODbL · SHARE-ALIKE', color: 'var(--accent-ink)' },
  STATE: { text: 'STATE OPEN DATA', color: 'var(--info)' },
};

const PROFILE_W = 286;
const PROFILE_H = 64;

let rawDialog: HTMLDialogElement | null = null;
let profileToken = 0; // bumped on each selection to discard stale async runs

// --- geometry helpers ---------------------------------------------------------
// Per-part length (featureLengthMeters sums each MultiLineString part independently),
// so a disconnected part boundary is never bridged into phantom trail distance.
function lengthMiles(feature: GeoJSON.Feature): number {
  return featureLengthMeters(feature) / 1609.344;
}

// --- attribute formatting -----------------------------------------------------
// Human-readable labels for source field names that a generic splitter can't fix
// (agency schemas use unseparated or heavily abbreviated names). Keys lowercase.
const FIELD_LABELS: Record<string, string> = {
  // shared / ArcGIS
  objectid: 'Object ID', globalid: 'Global ID',
  // NPS (TRL* prefix, unseparated)
  trlname: 'Trail Name', trlaltname: 'Alternate Name', trlsurface: 'Surface',
  trlclass: 'Trail Class', trluse: 'Allowed Uses', trlstatus: 'Status',
  trltype: 'Trail Type', trlfeattype: 'Feature Type', maplabel: 'Map Label',
  unitname: 'Park Unit', unitcode: 'Unit Code', unittype: 'Unit Type',
  seasdesc: 'Season Description', accessnotes: 'Access Notes',
  opentopublic: 'Open To Public', isextant: 'Is Extant',
  createdate: 'Create Date', editdate: 'Edit Date', sourcedate: 'Source Date',
  mapmethod: 'Map Method', mapsource: 'Map Source', xyaccuracy: 'XY Accuracy',
  publicdisplay: 'Public Display', dataaccess: 'Data Access',
  altlangname: 'Alt-language Name', altlang: 'Alt Language', linetype: 'Line Type',
  geometryid: 'Geometry ID', featureid: 'Feature ID',
  faclocid: 'Facility Location ID', facassetid: 'Facility Asset ID', imlocid: 'IM Location ID',
  // USGS NDT (lowercase, unseparated)
  permanentidentifier: 'Permanent Identifier', namealternate: 'Alternate Name',
  trailnumber: 'Trail Number', trailnumberalternate: 'Alternate Trail Number',
  sourcefeatureid: 'Source Feature ID', sourcedatasetid: 'Source Dataset ID',
  sourcedatadecscription: 'Source Data Description', sourceoriginator: 'Source Originator',
  sourceeditdate: 'Source Edit Date', publisheddate: 'Published Date', loaddate: 'Load Date',
  trailtype: 'Trail Type', trailsurface: 'Surface', routetype: 'Route Type',
  seasonopen: 'Season Open', hikerpedestrian: 'Hiker / Pedestrian',
  packsaddle: 'Pack & Saddle', ohvover50inches: 'OHV > 50 in',
  ohvisorunder50inches: 'OHV ≤ 50 in', crosscountryski: 'Cross-country Ski',
  dogsled: 'Dog Sled', nonmotorizedwatercraft: 'Non-motorized Watercraft',
  electricwatercraft: 'Electric Watercraft', icewatercraft: 'Ice Watercraft',
  osvm: 'Over-snow Vehicle', ebike: 'E-bike', livestock: 'Livestock', pets: 'Pets',
  primarytrailmaintainer: 'Primary Maintainer', nationaltraildesignation: 'National Trail Designation',
  lengthmiles: 'Length (mi)', networklength: 'Network Length (mi)',
  // COTREX (truncated column names)
  length_mi_: 'Length (mi)', min_elevat: 'Min Elevation (ft)', max_elevat: 'Max Elevation (ft)',
  highway_ve: 'Highway Vehicle', groomer_ur: 'Groomer URL', seasonalit: 'Seasonality',
  input_date: 'Input Date', edit_date: 'Edit Date', ohv_gt_50: 'OHV > 50 in',
  // USFS
  trail_cn: 'Trail Control Number', bmp: 'Begin Milepost', emp: 'End Milepost',
  attributesubset: 'Attribute Subset',
  // OSM
  '@id': 'OSM ID', sac_scale: 'SAC Scale',
};

// Abbreviated words inside snake_case names (mostly BLM/USFS) → readable words.
const WORD_FIX: Record<string, string> = {
  accpt: 'Accepted', disc: 'Discouraged', rstrct: 'Restriction', rstrt: 'Restriction',
  prmry: 'Primary', scndry: 'Secondary', nm: 'Name', srfce: 'Surface',
  trnsprt: 'Transport', dsgntn: 'Designation', obsrve: 'Observed', spcl: 'Special',
  mngt: 'Management', objtv: 'Objective', exstng: 'Existing', dstrbte: 'Distribute',
  extrnl: 'External', elevat: 'Elevation',
};

const ACRONYMS = new Set([
  'id', 'gis', 'ohv', 'atv', 'blm', 'nps', 'usfs', 'usgs', 'osm', 'mtb', 'sac',
  'url', 'xy', 'nepa', 'mvum', 'fltp', 'tma', 'tmp', 'imba', 'nfs', 'st', 'cn',
]);

/** "TYPICAL_TREAD_WIDTH" → "Typical Tread Width", "mtb:scale:imba" → "MTB Scale IMBA". */
function humanizeKey(raw: string): string {
  const known = FIELD_LABELS[raw.toLowerCase()];
  if (known) return known;
  return raw
    .replace(/[:._]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((w) => {
      const lw = w.toLowerCase();
      if (WORD_FIX[lw]) return WORD_FIX[lw];
      if (ACRONYMS.has(lw)) return lw.toUpperCase();
      return lw.charAt(0).toUpperCase() + lw.slice(1);
    })
    .join(' ');
}

const OK_WORDS = /^(yes|open|managed|accepted|allowed|designated|y|true)$/i;
const NO_WORDS = /^(no|closed|restricted|prohibited|private|discouraged|n|false)$/i;

function isPopulated(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).trim();
  return s !== '' && s.toLowerCase() !== 'null';
}

function valueNode(v: unknown): HTMLElement {
  const s = String(v);
  if (OK_WORDS.test(s.trim())) return h('span.ok', null, s.toUpperCase());
  if (NO_WORDS.test(s.trim())) return h('span.no', null, s.toUpperCase());
  return h('span', null, /[a-z]/i.test(s) ? s.toUpperCase() : s);
}

function shortId(feature: GeoJSON.Feature, def: (typeof SOURCES)[SourceId]): string | null {
  const raw = feature.properties?.[def.idField];
  if (raw == null || raw === '') return null;
  const s = String(raw);
  return s.includes('/') ? s.slice(s.indexOf('/') + 1) : s;
}

// --- GPX export ---------------------------------------------------------------
function buildGpx(feature: GeoJSON.Feature, name: string): string {
  const g = feature.geometry;
  const segs: number[][][] =
    g.type === 'LineString'
      ? [g.coordinates]
      : g.type === 'MultiLineString'
        ? g.coordinates
        : [];
  const trksegs = segs
    .map(
      (seg) =>
        '    <trkseg>\n' +
        seg
          .map((c) => `      <trkpt lat="${c[1]}" lon="${c[0]}"/>`)
          .join('\n') +
        '\n    </trkseg>',
    )
    .join('\n');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="TrailScope" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    '  <trk>\n' +
    `    <name>${escapeHtml(name)}</name>\n` +
    trksegs +
    '\n  </trk>\n' +
    '</gpx>\n'
  );
}

function downloadGpx(feature: GeoJSON.Feature, name: string): void {
  const blob = new Blob([buildGpx(feature, name)], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const slug = name.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'trail';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- RAW JSON dialog ----------------------------------------------------------
function openRawDialog(feature: GeoJSON.Feature): void {
  if (!rawDialog) {
    rawDialog = document.createElement('dialog');
    rawDialog.className = 'raw';
    rawDialog.addEventListener('click', (e) => {
      if (e.target === rawDialog) rawDialog?.close();
    });
    document.body.appendChild(rawDialog);
  }
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(feature, null, 2); // textContent = inherently escaped
  const head = h('div.raw-head', null,
    h('span', null, 'RAW FEATURE'),
    h('button.close', { 'aria-label': 'Close raw JSON' }, '✕'),
  );
  head.querySelector('.close')?.addEventListener('click', () => rawDialog?.close());
  rawDialog.replaceChildren(head, pre);
  rawDialog.showModal();
}

// --- profile SVG --------------------------------------------------------------
function renderProfileSvg(svg: SVGSVGElement, p: ElevationProfile, color: string): void {
  const n = p.elevationsFt.length;
  if (n < 2) {
    svg.innerHTML = '';
    return;
  }
  const maxDist = p.distancesMi[n - 1] || 1;
  const min = p.minFt;
  const max = p.maxFt;
  const span = max - min || 1;
  const X = (i: number): number => (p.distancesMi[i] / maxDist) * PROFILE_W;
  const Y = (i: number): number => PROFILE_H - 8 - ((p.elevationsFt[i] - min) / span) * (PROFILE_H - 18);

  // Split the polyline into contiguous runs at part seams so genuinely-disconnected
  // parts are drawn separately (a visual break) rather than a stroke bridging the gap.
  const seams = new Set(p.seamIndices ?? []);
  const runs: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < n; i++) {
    if (seams.has(i) && cur.length) {
      runs.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length) runs.push(cur);

  let fills = '';
  let strokes = '';
  for (const run of runs) {
    if (run.length < 2) continue;
    const d = run.map((i, k) => (k ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(i).toFixed(1)).join('');
    const x0 = X(run[0]).toFixed(1);
    const x1 = X(run[run.length - 1]).toFixed(1);
    fills += `<path d="${d}L${x1} ${PROFILE_H - 2}L${x0} ${PROFILE_H - 2}Z" fill="${color}2e"/>`;
    strokes += `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
  }
  // Faint dashed marker at each seam (a disconnected part boundary).
  let breaks = '';
  for (const i of p.seamIndices ?? []) {
    const x = X(i).toFixed(1);
    breaks += `<line x1="${x}" y1="6" x2="${x}" y2="${PROFILE_H - 2}" stroke="#b8b0a0" stroke-width="1" stroke-dasharray="2 2"/>`;
  }
  const lastX = X(n - 1).toFixed(1);
  const lastY = Y(n - 1).toFixed(1);
  svg.innerHTML =
    fills +
    breaks +
    strokes +
    `<line x1="0" y1="${PROFILE_H - 2}" x2="${PROFILE_W}" y2="${PROFILE_H - 2}" stroke="#d8d2c0"/>` +
    `<circle cx="${lastX}" cy="${lastY}" r="2.6" fill="#a35e00"/>`;
}

// --- source switcher ("VIEW IN" chips) ----------------------------------------
// Abort/stale guard shared across rapid chip switches (independent of the profile
// token). Bumped on every selection render and every chip click.
let switchToken = 0;
let switchController: AbortController | null = null;
// Availability probes for the current card; aborted on rebuild so stale probes from a
// prior selection never paint. Guarded by switchToken (shared with the click flow).
let probeController: AbortController | null = null;

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function relLuminance(rgb: [number, number, number]): number {
  const lin = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
const INK_LUM = relLuminance([31, 42, 36]); // var(--ink) #1f2a24

/**
 * Colors for the active (filled) chip: fill = the source color, darkened only as far
 * as needed so text hits >= 4.5:1. Prefers dark ink when the raw color already passes;
 * otherwise white on a (possibly darkened) fill.
 */
function activeChipColors(hex: string): { bg: string; fg: string } {
  let rgb = hexToRgb(hex);
  const lum = relLuminance(rgb);
  const cWhite = contrastRatio(lum, 1);
  const cInk = contrastRatio(lum, INK_LUM);
  if (cInk >= 4.5 && cInk >= cWhite) return { bg: hex, fg: 'var(--ink)' };
  if (cWhite >= 4.5) return { bg: hex, fg: '#ffffff' };
  // Neither passes: darken toward black until white text reaches 4.5:1.
  for (let i = 0; i < 40; i++) {
    rgb = [rgb[0] * 0.92, rgb[1] * 0.92, rgb[2] * 0.92] as [number, number, number];
    if (contrastRatio(relLuminance(rgb), 1) >= 4.5) break;
  }
  const toHex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return { bg: `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`, fg: '#ffffff' };
}

// Render a candidate chip into one of its three post-active states. `available`
// (clickable) and `absent` (dimmed, aria-disabled, tooltip, not clickable) are the
// probe outcomes; `probing` shows a spinner while the probe is in flight.
function paintChipAvailable(chip: HTMLButtonElement, target: SourceId): void {
  const def = SOURCES[target];
  chip.className = 'src-chip available';
  chip.removeAttribute('aria-disabled');
  chip.title = `View this trail as ${def.label} sees it`;
  chip.replaceChildren(
    h('span.src-sw', { style: `background:${def.color}` }),
    h('span.src-txt', null, BADGE[target]),
  );
}
function paintChipProbing(chip: HTMLButtonElement, target: SourceId): void {
  chip.className = 'src-chip probing';
  chip.setAttribute('aria-disabled', 'true');
  chip.title = `Checking ${BADGE[target]} for this trail…`;
  chip.replaceChildren(h('span.spinner'), h('span.src-txt', null, BADGE[target]));
}
function paintChipAbsent(chip: HTMLButtonElement, target: SourceId): void {
  const def = SOURCES[target];
  // Cache-only sources (OSM / any non-searchable) can't be probed nationwide, so
  // absence is only ever "not in the data already loaded" — say so honestly rather
  // than implying a definitive spatial search.
  const cacheOnly = def.kind !== 'arcgis' || !def.searchable;
  chip.className = 'src-chip absent';
  chip.setAttribute('aria-disabled', 'true');
  chip.title = cacheOnly
    ? `No matching trail in loaded ${BADGE[target]} data`
    : `No matching trail in ${BADGE[target]} near this selection`;
  chip.replaceChildren(
    h('span.src-sw', null), // grayed by CSS (no inline color)
    h('span.src-txt', null, BADGE[target]), // struck through by CSS to signal absence
  );
}

/**
 * The "VIEW IN" chip row: active chip for the current source plus one chip per
 * candidate source. Each candidate is probed for upfront availability the moment the
 * card builds: cache-verified sources render clickable immediately, others show a
 * spinner and resolve to `available` (clickable) or `absent` (dimmed, non-clickable,
 * tooltip). Clicking an available chip re-selects the SAME trail from that source in
 * place (no camera move). Returns null when there is nothing to switch to.
 */
// Build one candidate chip: clickable switch handler + initial state. Cache-verified
// sources paint available instantly; others start `probing` and settle in place when
// their probe resolves — never reordered, and chip width stays stable across states.
function buildCandidateChip(
  sel: SelectedTrail,
  target: SourceId,
  store: Store<AppState>,
  note: HTMLElement,
  probeSignal: AbortSignal,
  cardToken: number,
): HTMLButtonElement {
  const chip = h('button.src-chip', { type: 'button' }) as HTMLButtonElement;

  chip.addEventListener('click', () => {
    // Only available chips switch; probing / absent / mid-switch are inert.
    if (!chip.classList.contains('available')) return;
    note.textContent = '';
    const my = ++switchToken;
    switchController?.abort();
    const ctrl = new AbortController();
    switchController = ctrl;

    chip.className = 'src-chip loading';
    chip.replaceChildren(h('span.spinner'), h('span.src-txt', null, BADGE[target]));

    selectFromSource(sel, target, ctrl.signal)
      .then((merged) => {
        if (my !== switchToken) return; // superseded by a newer switch / selection
        if (!merged) {
          paintChipAvailable(chip, target);
          note.textContent = `not found in ${BADGE[target]}`;
          return;
        }
        const name = nameFromMerged(merged, target, sel.name);
        // Re-select in place; the store.selected subscription rebuilds the card.
        store.set({ selected: { sourceId: target, feature: merged, name } });
      })
      .catch((err) => {
        if (my !== switchToken) return;
        if ((err as Error).name === 'AbortError') return;
        paintChipAvailable(chip, target);
        note.textContent = `couldn't load from ${BADGE[target]}`;
      });
  });

  // Cache-verified → available instantly (no spinner flash). Otherwise probe in place.
  if (cacheHasTrail(sel, target)) {
    paintChipAvailable(chip, target);
  } else {
    paintChipProbing(chip, target);
    probeSource(sel, target, probeSignal)
      .then((present) => {
        if (cardToken !== switchToken) return; // stale: selection/switch moved on
        if (present) paintChipAvailable(chip, target);
        else paintChipAbsent(chip, target);
      })
      .catch((err) => {
        if (cardToken !== switchToken) return;
        if ((err as Error).name === 'AbortError') return;
        // Probe failed (not a confident absence): keep the chip clickable and let
        // the click-time fetch surface any real miss.
        paintChipAvailable(chip, target);
      });
  }
  return chip;
}

/** The current-source (active) chip — filled, its position fixed in registry order. */
function buildActiveChip(sel: SelectedTrail): HTMLElement {
  const active = activeChipColors(SOURCES[sel.sourceId].color);
  return h('span.src-chip.active',
    { style: `background:${active.bg};color:${active.fg};border-color:${active.bg}` },
    h('span.src-sw', { style: `background:${active.fg === 'var(--ink)' ? 'var(--ink)' : '#ffffff'};opacity:.55` }),
    BADGE[sel.sourceId],
  );
}

function buildSourceSwitcher(sel: SelectedTrail, store: Store<AppState>): HTMLElement | null {
  const candidates = new Set(findCandidateSources(sel, store.get().enabled));
  if (candidates.size === 0) return null;

  const note = h('span.src-note', null);
  // "VIEW IN" sits on its own micro-header line (like the attributes header) so the
  // chips get the full card width on a single row.
  const label = h('div.src-label', null, 'VIEW IN');
  const row = h('div.src-switch', null);

  // All probes for this card share one controller + the current switchToken so a
  // rebuild (or a click, which bumps the token) discards stale results.
  probeController = new AbortController();
  const probeSignal = probeController.signal;
  const cardToken = switchToken;

  // Fixed registry order (osm, usfs, nps, blm, usgs, cotrex): the active source keeps
  // its slot rather than jumping to the front, and probe resolution never reorders.
  for (const id of SOURCE_IDS) {
    if (id === sel.sourceId) {
      row.append(buildActiveChip(sel));
    } else if (candidates.has(id)) {
      row.append(buildCandidateChip(sel, id, store, note, probeSignal, cardToken));
    }
  }

  return h('div.xsource', null, label, row, note);
}

// --- card build ---------------------------------------------------------------
function buildCard(inspector: HTMLElement, sel: SelectedTrail, store: Store<AppState>): void {
  // A new card supersedes any in-flight source switch (its result must not apply
  // to a card that has since been rebuilt).
  switchToken++;
  switchController?.abort();
  switchController = null;
  probeController?.abort();
  probeController = null;

  const def = SOURCES[sel.sourceId];
  const feature = sel.feature;
  const lic = LICENSE_INLINE[def.licenseChip] || { text: def.licenseChip, color: 'var(--muted)' };
  const idStr = shortId(feature, def);
  const miles = lengthMiles(feature);
  const lengthM = miles * 1609.344;

  const close = h('button.close', { 'aria-label': 'Close inspector' }, '✕');
  close.addEventListener('click', () => store.set({ selected: null }));

  const metaLen = h('span', null, '');
  const metaGain = h('span', null, '+…');
  const metaRange = h('span', null, '…');
  const props = feature.properties as Record<string, unknown> | null;
  const rawSublayer = props?.__sublayer;
  const sublayer =
    rawSublayer != null && String(rawSublayer).trim() !== '' ? String(rawSublayer).toUpperCase() : null;
  const segCount = Number(props?.__segments) || 0;
  const metaSeg = segCount > 1 ? h('span', null, `${fmtNumber(segCount)} SEGMENTS MERGED`) : null;
  const otherClusters = Number(props?.__other_clusters) || 0;
  const metaOther =
    otherClusters > 0
      ? h('span', { style: 'color:var(--faint)' }, `${fmtNumber(otherClusters)} SAME-NAMED TRAILS ELSEWHERE`)
      : null;

  const head = h('div.insp-head', null,
    h('div.row1', null,
      h('span.badge', { style: `background:${def.color}` }, BADGE[sel.sourceId]),
      h('span.lic-inline', { style: `color:${lic.color}` }, lic.text),
      sublayer ? h('span.sublayer-inline', null, `· ${sublayer}`) : null,
      close,
    ),
    h('h3', { title: sel.name || undefined }, displayTrailName(sel.name) || '(unnamed)', idStr ? h('span.tno', null, ` #${idStr}`) : null),
    h('div.meta', null, metaLen, metaGain, metaRange, metaSeg, metaOther),
  );

  // Profile block (placeholder until terrain sampling resolves).
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${PROFILE_W} ${PROFILE_H}`);
  svg.setAttribute('height', String(PROFILE_H));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Elevation profile');
  const pfStatus = h('span', null, 'ELEV FROM TERRAIN TILES (Z13)');
  const pfStart = h('span', null, '');
  const pfEnd = h('span', null, '');
  const profile = h('div.profile', null,
    svg,
    h('div.pf-meta', null,
      pfStart,
      pfStatus,
      pfEnd,
    ),
  );
  pfStatus.textContent = 'SAMPLING TERRAIN…';

  // Unit-dependent labels (length, gain, min–max, profile axis ends). Recomputed
  // from stored meters/feet so a units toggle relabels the open card in place.
  let profileFt: Pick<ElevationProfile, 'gainFt' | 'minFt' | 'maxFt'> | null = null;
  const applyUnits = (units: Units): void => {
    metaLen.textContent = fmtDistance(lengthM, units);
    pfStart.textContent = units === 'metric' ? '0 km' : '0 mi';
    pfEnd.textContent = fmtDistance(lengthM, units);
    if (profileFt) {
      metaGain.textContent = `+${fmtElevation(profileFt.gainFt / FEET_PER_METER, units)}`;
      metaRange.textContent =
        `${fmtElevation(profileFt.minFt / FEET_PER_METER, units)}–${fmtElevation(profileFt.maxFt / FEET_PER_METER, units)}`;
    }
  };
  applyUnits(store.get().units);
  currentApplyUnits = applyUnits;

  // Attribute table (populated first).
  const entries = Object.entries(feature.properties || {}).filter(([k]) => !INTERNAL_KEYS.has(k));
  const populated = entries.filter(([, v]) => isPopulated(v));
  const empty = entries.filter(([, v]) => !isPopulated(v));
  let showEmpty = false;

  const table = h('table.kv') as HTMLTableElement;
  const toggleBtn = h('button.toggle-empty', null, `show empty (${empty.length})`);
  const attrsHead = h('h4', null,
    `Attributes · ${populated.length} of ${entries.length} populated`,
    empty.length ? toggleBtn : null,
  );

  const renderRows = () => {
    const rows = showEmpty ? [...populated, ...empty] : populated;
    table.replaceChildren(
      ...rows.map(([k, v]) =>
        h('tr', null,
          h('td.k', { title: k }, humanizeKey(k)),
          h('td.v', null, isPopulated(v) ? valueNode(v) : h('span', { style: 'color:var(--faint)' }, '—')),
        ),
      ),
    );
  };
  toggleBtn.addEventListener('click', () => {
    showEmpty = !showEmpty;
    toggleBtn.textContent = showEmpty ? 'hide empty' : `show empty (${empty.length})`;
    renderRows();
  });
  renderRows();
  const attrs = h('div.attrs', null, attrsHead, table);

  // License note from registry.
  const d = def.dossier;
  const licNote = h('div.lic-note', null,
    h('h4', null, 'Source & license'),
    `${d.license} ${d.updated}`,
    h('div.ep', null, d.endpointDisplay),
  );

  // Actions.
  const flyBtn = h('button.btn.primary', null, 'FLY TO 3D');
  flyBtn.addEventListener('click', () => {
    try {
      flyToTrail(feature);
    } catch (err) {
      console.warn('[inspector] flyToTrail unavailable:', (err as Error).message);
    }
  });
  const rawBtn = h('button.btn', null, 'RAW JSON');
  rawBtn.addEventListener('click', () => openRawDialog(feature));
  const gpxBtn = h('button.btn', null, 'GPX');
  gpxBtn.addEventListener('click', () => downloadGpx(feature, sel.name || 'trail'));
  const actions = h('div.insp-actions', null, flyBtn, rawBtn, gpxBtn);

  const switcher = buildSourceSwitcher(sel, store);
  inspector.replaceChildren(head, ...(switcher ? [switcher] : []), profile, attrs, licNote, actions);
  inspector.hidden = false;
  inspector.scrollTop = 0;

  // Async elevation sampling — discard if the selection changes underneath us.
  const token = ++profileToken;
  const priorAbort = (inspector as unknown as { _pfAbort?: AbortController })._pfAbort;
  priorAbort?.abort();

  // Pathologically long merges would spawn hundreds of tile fetches; skip sampling.
  if (miles > MAX_PROFILE_MI) {
    (inspector as unknown as { _pfAbort?: AbortController })._pfAbort = undefined;
    pfStatus.textContent = 'TRAIL TOO LONG FOR ELEVATION PROFILE';
    return;
  }

  const controller = new AbortController();
  (inspector as unknown as { _pfAbort?: AbortController })._pfAbort = controller;

  buildElevationProfile(feature, controller.signal)
    .then((p) => {
      if (token !== profileToken) return;
      pfStatus.textContent = 'ELEV FROM TERRAIN TILES (Z13)';
      renderProfileSvg(svg, p, def.color);
      profileFt = { gainFt: p.gainFt, minFt: p.minFt, maxFt: p.maxFt };
      applyUnits(store.get().units);
    })
    .catch((err) => {
      if (token !== profileToken) return;
      if ((err as Error).name === 'AbortError') return;
      pfStatus.textContent = 'TERRAIN SAMPLING FAILED';
    });
}

/** Wire the inspector to the store (selected). */
export function initInspector(root: HTMLElement, store: Store<AppState>): void {
  const inspector = root.querySelector<HTMLElement>('#inspector');
  if (!inspector) return;

  const render = (state: Readonly<AppState>) => {
    if (!state.selected) {
      (inspector as unknown as { _pfAbort?: AbortController })._pfAbort?.abort();
      profileToken++;
      switchToken++;
      switchController?.abort();
      switchController = null;
      probeController?.abort();
      probeController = null;
      currentApplyUnits = null;
      inspector.hidden = true;
      inspector.replaceChildren();
      return;
    }
    buildCard(inspector, state.selected, store);
  };

  store.subscribe(['selected'], render);
  // A units toggle relabels the open card in place (no rebuild).
  store.subscribe(['units'], (state) => {
    if (state.selected) currentApplyUnits?.(state.units);
  });
  render(store.get());
}
