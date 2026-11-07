// Benchmark page — the selection detail card (inspector-style, anchored right).
//
// Shows the AllTrails route record (names/points/aggregates only — no descriptions or
// photos, which the derived JSON deliberately omits), the per-source name-match rows,
// and the trailhead network-presence line. A "VIEW ON ALLTRAILS" link renders only when
// the snapshot carries a trailUrl (the current snapshot does not, so it is omitted).

import type { SourceId, Units } from '../types';
import { SOURCE_IDS, SOURCES } from '../registry';
import { h, displayTrailName, fmtDistance, fmtElevation, fmtNumber } from '../ui/dom';
import {
  OUTCOME_COLOR,
  OUTCOME_LABEL,
  REASON_LABEL,
  lengthMismatch,
  lengthWithType,
  outcomeOf,
  type Route,
  type SourceMatch,
} from './model';

export const SHORT_LABEL: Record<SourceId, string> = {
  osm: 'OSM',
  usfs: 'USFS',
  nps: 'NPS',
  blm: 'BLM',
  usgs: 'USGS',
  cotrex: 'COTREX',
  dec: 'DEC',
};

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface MatchRowOpts {
  /** Cap on matched names shown (default 3; pass Infinity for the table accordion). */
  maxNames?: number;
  /** Extra failure annotation on a matched row: 'fetch failed' (red). */
  failedText?: string | null;
  /** Truncation annotation on a matched row: 'partial data' (amber). */
  partialText?: string | null;
  /** Replacement for the default 'no name match' (table view: 'fetch n/a'). */
  noMatchText?: string;
  /** Length-agreement audit hint (see model.lengthMismatch); renders a muted flag. */
  mismatch?: boolean;
}

const MISMATCH_TITLE =
  'matched segments much shorter/longer than the route corridor — weak match or partial coverage';

/** One per-source match line: swatch + label + tier chip / no-match state + names. */
export function matchRow(id: SourceId, m: SourceMatch, units: Units, opts: MatchRowOpts = {}): HTMLElement {
  const maxNames = opts.maxNames ?? 3;
  const head = h('div', { class: 'bm-mr-head' },
    h('span', { class: 'bm-mr-sw', style: `background:${SOURCES[id].color}` }),
    h('span', { class: 'bm-mr-label' }, SHORT_LABEL[id]),
  );

  if (m.matched) {
    const tierChip =
      m.tier === 'exact'
        ? h('span', { class: 'bm-tier bm-tier-exact' }, 'EXACT')
        : h('span', { class: 'bm-tier bm-tier-fuzzy' }, m.rule ? `FUZZY ${m.rule}` : 'FUZZY');
    head.append(tierChip);
    const distParts: string[] = [];
    if (m.distM != null) distParts.push(`${fmtElevation(m.distM, units)} from trailhead`);
    if (m.matchedLenM != null) distParts.push(`${fmtDistance(m.matchedLenM, units)} matched`);
    if (distParts.length) head.append(h('span', { class: 'bm-mr-dist' }, distParts.join(' · ')));
    if (opts.mismatch) {
      head.append(h('span', { class: 'bm-mr-mismatch', title: MISMATCH_TITLE }, '⚠ length mismatch'));
    }
    if (opts.failedText) head.append(h('span', { class: 'bm-mr-failed' }, opts.failedText));
    else if (opts.partialText) head.append(h('span', { class: 'bm-mr-partial' }, opts.partialText));
  } else {
    head.append(h('span', { class: 'bm-mr-none' }, opts.noMatchText ?? 'no name match'));
  }

  const row = h('div', { class: 'bm-mr' }, head);
  if (m.matched && m.names.length) {
    const names = m.names.slice(0, maxNames).map(displayTrailName).join(', ');
    const extra = m.names.length > maxNames ? ` +${m.names.length - maxNames}` : '';
    row.append(h('div', { class: 'bm-mr-names' }, names + extra));
  }
  return row;
}

export interface DetailState {
  loadingSegments: boolean;
  failed: Set<SourceId>;
  partial: Set<SourceId>;
}

/** Build the detail card body for a route. */
export function renderDetail(
  route: Route,
  units: Units,
  state: DetailState,
  onClose: () => void,
): HTMLElement[] {
  const outcome = outcomeOf(route);

  // ---- header: outcome badge, reviews, name, length/difficulty ----
  const closeBtn = h('button', { class: 'close', 'aria-label': 'Close' }, '✕');
  closeBtn.addEventListener('click', onClose);
  const row1 = h('div', { class: 'row1' },
    h('span', { class: 'bm-outcome-badge', style: `background:${OUTCOME_COLOR[outcome]}` }, OUTCOME_LABEL[outcome].toUpperCase()),
    route.numReviews ? h('span', { class: 'bm-reviews' }, `${fmtNumber(route.numReviews)} reviews`) : null,
    closeBtn,
  );

  const meta = h('div', { class: 'meta' },
    h('span', null,
      route.lengthMeters == null
        ? '—'
        : lengthWithType(fmtDistance(route.lengthMeters, units), route.routeType),
    ),
    route.difficulty ? h('span', null, titleCase(route.difficulty)) : null,
    route.avgRating != null ? h('span', null, `★ ${route.avgRating.toFixed(1)}`) : null,
  );

  const head = h('div', { class: 'insp-head' },
    row1,
    h('h3', null, displayTrailName(route.name)),
    meta,
  );
  if (route.excluded) {
    head.append(
      h('div', { class: 'bm-excluded' },
        h('span', { class: 'bm-excluded-badge' }, 'EXCLUDED'),
        route.exclusionReason ? h('span', { class: 'bm-excluded-reason' }, REASON_LABEL[route.exclusionReason] ?? route.exclusionReason) : null,
      ),
    );
  }

  // ---- per-source match rows ----
  const matches = h('div', { class: 'bm-matches' },
    h('h4', null, 'Name match by source'),
  );
  if (state.loadingSegments) {
    matches.append(h('div', { class: 'bm-seg-loading' }, h('span', { class: 'spinner' }), 'loading segments…'));
  }
  for (const id of SOURCE_IDS) {
    const m = route.matches[id];
    if (!m) continue;
    matches.append(matchRow(id, m, units, {
      failedText: m.matched && state.failed.has(id) ? 'fetch failed' : null,
      partialText: m.matched && state.partial.has(id) ? 'partial data' : null,
      mismatch: lengthMismatch(route, m),
    }));
  }

  // ---- network presence ----
  const nearest = route.nearestFeatureM?.overall;
  const netpres = h('div', { class: 'bm-netpres' },
    'nearest open-data feature: ',
    h('strong', null, nearest == null ? '—' : fmtElevation(nearest, units)),
  );

  const nodes: HTMLElement[] = [head, matches, netpres];

  // ---- optional AllTrails link (only when the snapshot carries a URL) ----
  if (route.trailUrl) {
    nodes.push(
      h('div', { class: 'bm-actions' },
        h('a', { class: 'btn', href: route.trailUrl, target: '_blank', rel: 'noopener' }, 'VIEW ON ALLTRAILS ↗'),
      ),
    );
  }

  return nodes;
}
