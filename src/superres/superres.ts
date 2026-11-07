// Super Res API — a deliberately plain probe of the TWC super-resolution point
// forecast, read through the server-side proxy in server.js.
//
// This page is a test harness, not a product surface: it submits one coordinate
// and prints what came back, including the states that are easy to mistake for a
// bug (no key configured, and a valid 200 with no coverage because the point sits
// outside the HRRR/CONUS domain). Anything the proxy does not send is not shown.

import '../tokens.css';
import './superres.css';
import { mountNav } from '../ui/nav';
import { h, fmtNumber } from '../ui/dom';
import {
  fetchStatus,
  fetchPoint,
  ProxyError,
  celsiusTo,
  metersPerSecondTo,
  compassPoint,
  type HorizonInfo,
  type PointResponse,
  type PointRow,
  type StatusResponse,
  type UnitSystem,
} from './api';

// Six probe points spanning what the domain does and does not cover. Honolulu is
// deliberate: the page has to show an out-of-domain answer as an answer.
interface Preset {
  name: string;
  tests: string;
  lat: number;
  lon: number;
}

const PRESETS: Preset[] = [
  { name: 'Longs Peak trailhead, CO', tests: 'high terrain, in domain', lat: 40.2725, lon: -105.5566 },
  { name: 'Cascade Mountain, NY', tests: 'in domain, eastern edge', lat: 44.219, lon: -73.86 },
  { name: 'Lake of the Ozarks, MO', tests: 'lowland control', lat: 38.12, lon: -92.66 },
  { name: 'Seattle, WA', tests: 'coastal edge', lat: 47.6062, lon: -122.3321 },
  { name: 'Denver, CO', tests: "the guide's own example", lat: 39.7392, lon: -104.9903 },
  { name: 'Honolulu, HI', tests: 'outside CONUS, expect no data', lat: 21.3069, lon: -157.8583 },
];

const DEFAULT_HOURS = 36;

// --- element handles ----------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const latInput = el<HTMLInputElement>('sr-lat');
const lonInput = el<HTMLInputElement>('sr-lon');
const hoursInput = el<HTMLInputElement>('sr-hours');
const backInput = el<HTMLInputElement>('sr-back');
const submitBtn = el<HTMLButtonElement>('sr-submit');
const orderEcho = el<HTMLElement>('sr-order');
const presetRow = el<HTMLElement>('sr-presets');
const stateBox = el<HTMLElement>('sr-state');
const resultBox = el<HTMLElement>('sr-result');
const rawBox = el<HTMLElement>('sr-raw');
const form = el<HTMLFormElement>('sr-form');

let units: UnitSystem = 'metric';
let last: PointResponse | null = null;
let status: StatusResponse | null = null;
let busy = false;
// Latches once the proxy tells us there is no key. Nothing re-enables the button
// after that, because every further request would fail the same way.
let keyMissing = false;

// --- state banner -------------------------------------------------------------

type StateKind = 'idle' | 'loading' | 'error' | 'unconfigured' | 'blocked' | 'note';

function setState(kind: StateKind, title: string, detail?: string): void {
  stateBox.className = `sr-state sr-${kind}`;
  stateBox.hidden = kind === 'idle';
  stateBox.replaceChildren(
    kind === 'loading' ? h('span.spinner') : h('span.sr-dot'),
    h('span.sr-state-text', null, h('strong', null, title), detail ? h('span', null, detail) : null),
  );
}

// --- form -------------------------------------------------------------------

/**
 * Accept a pasted "lat, lon" pair into either coordinate box. Humans write
 * lat first and the API wants [lon, lat], so the paste is split into the two
 * labelled fields rather than being trusted in whichever box it landed.
 */
function handlePaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text') ?? '';
  const nums = text.match(/-?\d+(\.\d+)?/g);
  if (!nums || nums.length < 2) return;
  event.preventDefault();
  latInput.value = nums[0];
  lonInput.value = nums[1];
  updateOrderEcho();
}

function updateOrderEcho(): void {
  const lat = Number(latInput.value);
  const lon = Number(lonInput.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    orderEcho.textContent = 'Sends [lon, lat] to the tiler.';
    return;
  }
  orderEcho.textContent = `Sends [lon, lat] = [${lon}, ${lat}]`;
}

function renderPresets(): void {
  presetRow.replaceChildren(
    ...PRESETS.map((p) => {
      const btn = h(
        'button.sr-chip',
        { type: 'button', title: `${p.lat}, ${p.lon}` },
        h('span.sr-chip-name', null, p.name),
        h('span.sr-chip-tests', null, p.tests),
      );
      btn.addEventListener('click', () => {
        latInput.value = String(p.lat);
        lonInput.value = String(p.lon);
        updateOrderEcho();
        if (!submitBtn.disabled) void submit();
      });
      return btn;
    }),
  );
}

// --- rendering ---------------------------------------------------------------

const LOCAL_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function utcClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}Z`;
}

/** Every null renders as an explicit no-data dash, never as a blank or a zero. */
function cell(value: number | null, render: (n: number) => string): HTMLElement {
  if (value == null || !Number.isFinite(value)) {
    return h('td.sr-null', { title: 'no data at this point and hour' }, '—');
  }
  return h('td.sr-num', null, render(value));
}

function temp(n: number): string {
  return `${celsiusTo(n, units).toFixed(1)}${units === 'metric' ? '°C' : '°F'}`;
}

function speed(n: number): string {
  return `${metersPerSecondTo(n, units).toFixed(1)}${units === 'metric' ? ' m/s' : ' mph'}`;
}

function rowNode(row: PointRow): HTMLElement {
  const v = row.values;
  const blank = row.windDirDeg == null && v.temperature_2m == null && v.wind_speed == null;
  return h(
    'tr',
    blank ? { class: 'sr-row-empty' } : null,
    h('td.sr-time', null, LOCAL_TIME.format(new Date(row.tDisplayMs))),
    h('td.sr-utc', null, utcClock(row.tDisplayMs)),
    h('td.sr-num', null, fmtLead(row.leadHours)),
    cell(v.temperature_2m, temp),
    cell(v.dewpoint_2m, temp),
    cell(v.wind_speed, speed),
    cell(v.wind_gust, speed),
    row.windDirDeg == null
      ? h('td.sr-null', { title: 'no data at this point and hour' }, '—')
      : h('td.sr-num', null, `${Math.round(row.windDirDeg)}° ${compassPoint(row.windDirDeg)}`),
  );
}

function unitsToggle(): HTMLElement {
  const wrap = h('div.sr-units', null, h('span.sr-units-label', null, 'Units'));
  for (const opt of ['metric', 'imperial'] as UnitSystem[]) {
    const btn = h(
      'button.sr-unit' + (units === opt ? '.on' : ''),
      { type: 'button' },
      opt === 'metric' ? '°C · m/s' : '°F · mph',
    );
    btn.addEventListener('click', () => {
      if (units === opt) return;
      units = opt;
      renderResult();
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

/** Leads run negative when the run began before now, so the sign is always shown. */
function fmtLead(hours: number): string {
  return hours < 0 ? `${hours} h` : `+${hours} h`;
}

/**
 * The server measures the horizon from the rows that carry finite values. It is
 * re-derived here only when an older server build omits the field, so the page
 * still shows a measured number rather than nothing.
 */
function measuredHorizon(res: PointResponse): HorizonInfo {
  if (res.horizon) return res.horizon;
  const withData = res.rows.filter((r) =>
    Object.values(r.values).some((v) => typeof v === 'number' && Number.isFinite(v)),
  );
  const first = withData[0] ?? null;
  const lastRow = withData.length > 0 ? withData[withData.length - 1] : null;
  return {
    firstDataMs: first ? first.tDisplayMs : null,
    lastDataMs: lastRow ? lastRow.tDisplayMs : null,
    firstLeadHours: first ? first.leadHours : null,
    lastLeadHours: lastRow ? lastRow.leadHours : null,
    hoursWithData: withData.length,
    hoursRequested: res.rows.length,
  };
}

function summaryLine(res: PointResponse): HTMLElement {
  const hz = measuredHorizon(res);
  const pct = hz.hoursRequested > 0 ? Math.round((hz.hoursWithData / hz.hoursRequested) * 100) : 0;
  const run = res.run;

  // [key, value, measured?]. "Measured" is the point of the horizon numbers: the
  // page establishes the real horizon from the data rather than reading it off a
  // field, which matters while run discovery is denied.
  const items: Array<[string, string, boolean]> = [];
  if (run) {
    items.push(['Run', run.labelDisplay || run.label || 'unlabelled', false]);
    items.push([
      'Valid from',
      `${LOCAL_TIME.format(new Date(run.rtDisplay))} (${utcClock(run.rtDisplay)})`,
      false,
    ]);
  }
  items.push(['Point', `${res.requested.lat}, ${res.requested.lon}`, false]);
  // Row count can exceed the requested hours: the run's timesteps reach back
  // before now, so the request is a horizon, not a row budget.
  const back = res.requested.hoursBack ?? 0;
  const asked = back > 0 ? `${res.requested.hours} h ahead, ${back} back` : `${res.requested.hours} h ahead`;
  items.push(['Rows', `${fmtNumber(res.rows.length)} (asked ${asked})`, false]);
  items.push([
    'Hours with data',
    `${fmtNumber(hz.hoursWithData)} of ${fmtNumber(hz.hoursRequested)} (${pct}%)`,
    true,
  ]);
  items.push([
    'Lead range',
    hz.firstLeadHours == null || hz.lastLeadHours == null
      ? 'no data'
      : `${fmtLead(hz.firstLeadHours)} to ${fmtLead(hz.lastLeadHours)}`,
    true,
  ]);
  if (hz.firstDataMs != null && hz.lastDataMs != null) {
    items.push([
      'Data window',
      `${LOCAL_TIME.format(new Date(hz.firstDataMs))} to ${LOCAL_TIME.format(new Date(hz.lastDataMs))}`,
      true,
    ]);
  }
  items.push(['Upstream', `${fmtNumber(Math.round(res.upstreamMs))} ms`, false]);

  return h(
    'div.sr-summary',
    null,
    ...items.map(([k, v, measured]) =>
      h(
        'span.sr-sum',
        null,
        h('span.sr-sum-k', null, k, measured ? h('span.sr-tag', null, 'measured') : null),
        h('span.sr-sum-v', null, v),
      ),
    ),
  );
}

function renderResult(): void {
  const res = last;
  if (!res) {
    resultBox.replaceChildren();
    return;
  }

  const parts: HTMLElement[] = [
    h('div.sr-result-head', null, h('h2.sr-h2', null, 'Forecast rows'), unitsToggle()),
    summaryLine(res),
  ];

  const discovery = res.runDiscovery;
  if (discovery && !discovery.available) {
    parts.push(
      h(
        'p.sr-caveat',
        null,
        h('span.sr-caveat-k', null, 'Note'),
        discovery.note,
      ),
    );
  }

  if (measuredHorizon(res).hoursWithData === 0) {
    parts.push(
      h(
        'div.sr-empty',
        null,
        h('strong', null, 'No forecast coverage at this point.'),
        h(
          'p',
          null,
          'The request succeeded and the hours came back, but every value is null. ' +
            'The super-resolution model is tied to the HRRR domain, so it covers the contiguous ' +
            'US only. A point outside that domain returns rows with no values rather than an error.',
        ),
      ),
    );
  } else {
    const head = h(
      'tr',
      null,
      h('th', null, 'Valid time (local)'),
      h('th', null, 'UTC'),
      h('th', null, 'Lead'),
      h('th', null, 'Temperature'),
      h('th', null, 'Dewpoint'),
      h('th', null, 'Wind'),
      h('th', null, 'Gust'),
      h('th', null, 'Wind from'),
    );
    parts.push(
      h(
        'div.sr-tablewrap',
        null,
        h('table.sr-table', null, h('thead', null, head), h('tbody', null, ...res.rows.map(rowNode))),
      ),
    );
  }

  // The +2h correction is only worth a footnote when the proxy is actually
  // applying one. Read it off the response; never assume the value.
  // Only meaningful when there is a corrected run time to talk about. With run
  // discovery denied there is none, so the note would dangle.
  if (res.rtOffsetHours !== 0 && res.run) {
    parts.push(
      h(
        'p.sr-foot',
        null,
        `Times above are corrected model valid times: the tiler stamps its reference time ` +
          `${res.rtOffsetHours} h late, and the proxy subtracts that before sending. The raw ` +
          `tiler-stamped time is kept as tMs in the JSON below.`,
      ),
    );
  }

  resultBox.replaceChildren(...parts);
}

function renderRaw(): void {
  if (!last) {
    rawBox.replaceChildren();
    return;
  }
  const json = JSON.stringify(last, null, 2);
  const copy = h('button.sr-copy', { type: 'button' }, 'Copy JSON');
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(json).then(
      () => {
        copy.textContent = 'Copied';
        window.setTimeout(() => (copy.textContent = 'Copy JSON'), 1500);
      },
      () => (copy.textContent = 'Copy failed'),
    );
  });
  const details = h(
    'details.sr-details',
    null,
    h('summary', null, 'Raw response'),
    h('div.sr-raw-head', null, h('span.sr-raw-note', null, 'Exactly what the proxy returned.'), copy),
    h('pre.sr-pre', null, json),
  );
  rawBox.replaceChildren(details);
}

// --- submit ------------------------------------------------------------------

async function submit(): Promise<void> {
  if (busy) return;
  const lat = Number(latInput.value);
  const lon = Number(lonInput.value);
  const hours = Math.max(1, Math.round(Number(hoursInput.value) || DEFAULT_HOURS));
  const hoursBack = Math.max(0, Math.round(Number(backInput.value) || 0));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    setState('error', 'Enter a latitude and a longitude.', 'Both fields take decimal degrees.');
    return;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    setState(
      'error',
      'Coordinate out of range.',
      'Latitude runs to ±90 and longitude to ±180. A swapped pair is the usual cause.',
    );
    return;
  }

  busy = true;
  submitBtn.disabled = true;
  setState(
    'loading',
    'Requesting…',
    `${lat}, ${lon} for ${hours} hours ahead` + (hoursBack > 0 ? ` and ${hoursBack} back` : ''),
  );

  try {
    last = await fetchPoint({ lon, lat, hours, hoursBack });
    renderResult();
    renderRaw();
    if (measuredHorizon(last).hoursWithData === 0) {
      setState('note', 'Returned 200 with no values.', 'See the coverage note below.');
    } else {
      setState('idle', '');
    }
  } catch (err) {
    const e = err instanceof ProxyError ? err : new ProxyError(0, String(err), null);
    if (e.configured === false || e.status === 503) {
      showUnconfigured();
    } else if (e.edgeDenied || e.status === 401 || e.status === 403) {
      showBlocked(e.status, e.hint);
    } else {
      setState(
        'error',
        e.status ? `Upstream error, HTTP ${e.status}.` : 'Request failed.',
        e.detail,
      );
    }
  } finally {
    busy = false;
    submitBtn.disabled = keyMissing;
  }
}

/**
 * The SSDS edge denies unrecognised networks before it looks at the key, so a real
 * key, a bogus key and no key at all all come back as the same 401. Saying "bad
 * key" here would send the reader after the wrong thing, so this state names the
 * likely cause and stays separate from both the missing-key and error states.
 */
function showBlocked(httpStatus: number, hint: string): void {
  setState(
    'blocked',
    `SSDS edge refused the request, HTTP ${httpStatus}.`,
    `${
      hint ||
      'The tiler denied the call before checking the key, which is normally network access, ' +
        'an IP allowlist or VPN, rather than a key problem.'
    } The key is configured and the proxy is working, so nothing on this page needs fixing.`,
  );
}

function showUnconfigured(): void {
  keyMissing = true;
  submitBtn.disabled = true;
  setState(
    'unconfigured',
    'No API key configured.',
    'Put SSDS_API_KEY in .env at the app root and restart the server (node server.js). ' +
      'The key stays server-side; this page never sees it.',
  );
}

// --- boot --------------------------------------------------------------------

async function boot(): Promise<void> {
  mountNav('superres');
  renderPresets();
  updateOrderEcho();
  setState('idle', '');

  latInput.addEventListener('paste', handlePaste);
  lonInput.addEventListener('paste', handlePaste);
  latInput.addEventListener('input', updateOrderEcho);
  lonInput.addEventListener('input', updateOrderEcho);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });

  try {
    status = await fetchStatus();
    if (!status.configured) {
      showUnconfigured();
    }
  } catch (err) {
    const e = err instanceof ProxyError ? err : new ProxyError(0, String(err), null);
    if (e.configured === false || e.status === 503) {
      showUnconfigured();
      return;
    }
    if (e.edgeDenied || e.status === 401 || e.status === 403) {
      showBlocked(e.status, e.hint);
      return;
    }
    submitBtn.disabled = true;
    setState(
      'error',
      e.status ? `Proxy unreachable, HTTP ${e.status}.` : 'Proxy unreachable.',
      `${e.detail}. The page talks to /api/ssds on the Express server; start it with node server.js.`,
    );
  }
}

void boot();
