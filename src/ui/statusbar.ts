// Workstream C — status bar: live coords/zoom/pitch (polled off the map's 'move'
// event) plus per-source count chips driven by the store. Chips hide when a source
// is disabled; a capped source gets a ▲ suffix.

import type { AppState, SourceId } from '../types';
import type { Store } from '../store';
import { SOURCE_IDS, SOURCES } from '../registry';
import { getMap } from '../map/map';
import { h, fmtNumber, fmtCoord } from './dom';

/** Wire the status bar to the store + map movement. */
export function initStatusbar(root: HTMLElement, store: Store<AppState>): void {
  const posEl = root.querySelector<HTMLElement>('#sb-pos');
  const viewEl = root.querySelector<HTMLElement>('#sb-view');
  const countsEl = root.querySelector<HTMLElement>('#sb-counts');

  // --- Map readout: attach once the map exists (getMap throws until then). ---
  const updateFromMap = () => {
    try {
      const map = getMap();
      const c = map.getCenter();
      if (posEl) posEl.textContent = fmtCoord(c.lng, c.lat);
      if (viewEl) {
        viewEl.textContent = `Z ${map.getZoom().toFixed(1)} · PITCH ${Math.round(map.getPitch())}°`;
      }
    } catch {
      // map not ready yet — no-op.
    }
  };

  const tryAttach = () => {
    try {
      const map = getMap();
      map.on('move', updateFromMap);
      updateFromMap();
    } catch {
      window.setTimeout(tryAttach, 300);
    }
  };
  tryAttach();

  // --- Per-source count chips from the store. ---
  const renderCounts = (state: Readonly<AppState>) => {
    if (!countsEl) return;
    const chips: Node[] = [];
    for (const id of SOURCE_IDS as SourceId[]) {
      if (!state.enabled[id]) continue;
      const vp = state.viewport[id];
      if (vp.status !== 'ready') continue;
      chips.push(
        h('span.chip', null,
          h('span.dot', { style: `background:${SOURCES[id].color}` }),
          `${fmtNumber(vp.featureCount)}${vp.capped ? '▲' : ''}`,
        ),
      );
    }
    countsEl.replaceChildren(...chips);
  };

  store.subscribe(['viewport', 'enabled'], renderCounts);
  renderCounts(store.get());
}
