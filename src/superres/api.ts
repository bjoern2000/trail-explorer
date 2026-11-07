// Typed client for the server-side SSDS proxy (server.js, /api/ssds/*).
//
// The upstream tiler (references/SSDS_API_GUIDE.md) is never called from the
// browser: the API key is server-side only, and the server also applies the +2h
// reference-time correction from guide §7.1 before anything reaches us. So this
// module knows the proxy's contract and nothing about the tiler's.
//
// Every response shape the page consumes is declared here, once.

/** The six megapoints variables the guide catalogs (§6). All SI. */
export interface PointValues {
  temperature_2m: number | null;
  dewpoint_2m: number | null;
  wind_speed: number | null;
  wind_gust: number | null;
  u_wind_10m: number | null;
  v_wind_10m: number | null;
}

export interface StatusResponse {
  configured: boolean;
  baseUrl: string;
  /** Hours the proxy subtracts from upstream times for display. 0 once fixed upstream. */
  rtOffsetHours: number;
}

export interface RunSummary {
  rt: number;
  rtDisplay: number;
  label: string | null;
  /** Label rebuilt from the corrected time; preferred over `label` for display. */
  labelDisplay?: string | null;
}

/**
 * Why the run block may be missing. The point data itself comes from /multipoint,
 * which answers, while run metadata comes from /info and /runs, which are still
 * edge-denied. So `available: false` is a caveat on the labelling, not a failure
 * of the request: the rows underneath it are real.
 */
export interface RunDiscovery {
  available: boolean;
  status: number | null;
  note: string;
}

/**
 * The horizon as MEASURED from which rows carry finite values, not as declared by
 * the API. Leads can be negative when the run began before now.
 */
export interface HorizonInfo {
  firstDataMs: number | null;
  lastDataMs: number | null;
  firstLeadHours: number | null;
  lastLeadHours: number | null;
  hoursWithData: number;
  hoursRequested: number;
}

export interface PointRow {
  /** Raw tiler-stamped valid time, epoch ms. */
  tMs: number;
  /** Corrected valid time for display, epoch ms. */
  tDisplayMs: number;
  leadHours: number;
  values: PointValues;
  /** Meteorological "from" bearing derived from u/v, or null with no wind data. */
  windDirDeg: number | null;
}

export interface PointResponse {
  /** Null whenever run discovery is unavailable; never assume it exists. */
  run: RunSummary | null;
  runDiscovery: RunDiscovery;
  horizon: HorizonInfo;
  rtOffsetHours: number;
  requested: { lon: number; lat: number; hours: number; hoursBack?: number };
  variables: Array<{ key: string; label: string; units: string }>;
  rows: PointRow[];
  coverage: { total: number; withData: number };
  upstreamMs: number;
}

export interface PointRequest {
  lon: number;
  lat: number;
  hours?: number;
  /** Hours before now to also request. Nonzero is what produces negative leads. */
  hoursBack?: number;
  rt?: number;
  products?: string[];
}

/**
 * One error type for every failure the page distinguishes. `configured === false`
 * is the "no key in .env" case and gets its own screen; everything else is an
 * upstream or transport failure and shows status + detail verbatim.
 */
export class ProxyError extends Error {
  readonly status: number;
  readonly configured: boolean | null;
  readonly detail: string;
  /** Set by the proxy when the CDN edge denied the call before the tiler saw it. */
  readonly edgeDenied: boolean;
  /** The proxy's own explanation of the failure, when it has one. */
  readonly hint: string;

  constructor(
    status: number,
    detail: string,
    configured: boolean | null,
    edgeDenied = false,
    hint = '',
  ) {
    super(detail);
    this.name = 'ProxyError';
    this.status = status;
    this.detail = detail;
    this.configured = configured;
    this.edgeDenied = edgeDenied;
    this.hint = hint;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ProxyError(0, err instanceof Error ? err.message : 'network request failed', null);
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const body = (parsed ?? {}) as {
      error?: string;
      detail?: string | null;
      configured?: boolean;
      edgeDenied?: boolean;
      hint?: string;
    };
    // A non-JSON body is usually Express's own HTML error page. Dumping that into
    // the banner buries the status, so fall back to the status line instead.
    const plain = !parsed && text.trim() && !text.trimStart().startsWith('<') ? text.trim() : '';
    const detail =
      body.detail ??
      body.error ??
      (plain ? plain.slice(0, 300) : `HTTP ${res.status} ${res.statusText || 'error'}`);
    const configured = typeof body.configured === 'boolean' ? body.configured : null;
    throw new ProxyError(
      res.status,
      detail,
      configured,
      body.edgeDenied === true,
      typeof body.hint === 'string' ? body.hint : '',
    );
  }
  if (parsed == null) {
    throw new ProxyError(res.status, 'proxy returned a non-JSON body', null);
  }
  return parsed as T;
}

export function fetchStatus(): Promise<StatusResponse> {
  return request<StatusResponse>('/api/ssds/status');
}

export function fetchPoint(body: PointRequest): Promise<PointResponse> {
  return request<PointResponse>('/api/ssds/point', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// --- units (guide §4) ---------------------------------------------------------

export type UnitSystem = 'metric' | 'imperial';

export function celsiusTo(c: number, units: UnitSystem): number {
  return units === 'metric' ? c : c * (9 / 5) + 32;
}

export function metersPerSecondTo(ms: number, units: UnitSystem): number {
  return units === 'metric' ? ms : ms * 2.23694;
}

const COMPASS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

/** Bearing to a 16-point cardinal label. The bearing is the direction wind comes FROM. */
export function compassPoint(deg: number): string {
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS[idx];
}
