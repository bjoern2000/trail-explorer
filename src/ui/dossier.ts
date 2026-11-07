// Workstream C — source drill-down card, anchored top-left over the map.
// Opens from the sidebar INFO button / source name (via store.dossierOpen).
// One at a time; ✕ or ESC closes. Content is entirely from registry dossier fields
// plus a live line reflecting the current viewport count/capped for that source.

import type { AppState, SourceId } from '../types';
import type { Store } from '../store';
import { SOURCES } from '../registry';
import { h, fmtNumber } from './dom';

/** Live "in view" line text for the open source. */
function liveText(state: Readonly<AppState>, id: SourceId): string {
  if (!state.enabled[id]) return 'Layer off — enable it to load features';
  const vp = state.viewport[id];
  switch (vp.status) {
    case 'ready':
      return `${fmtNumber(vp.featureCount)} in view${vp.capped ? ' · capped at 2,000' : ''}`;
    case 'loading':
      return 'Loading…';
    case 'below-zoom':
      return 'Zoom in to load features';
    case 'error':
      return `Error: ${vp.error || 'request failed'}`;
    default:
      return 'Pan the map to load features';
  }
}

/** Wire the dossier card to the store (dossierOpen + live viewport line). */
export function initDossier(root: HTMLElement, store: Store<AppState>): void {
  const card = root.querySelector<HTMLElement>('#dossier');
  if (!card) return;

  const close = () => store.set({ dossierOpen: null });

  // ESC closes the open dossier.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && store.get().dossierOpen) close();
  });

  const render = (state: Readonly<AppState>) => {
    const id = state.dossierOpen;
    if (!id) {
      card.hidden = true;
      card.replaceChildren();
      return;
    }
    const def = SOURCES[id];
    const d = def.dossier;

    const facts = h('dl.dos-facts', null,
      fact('Scope', d.scope),
      fact('License', d.license),
      fact('Access', d.access),
      fact('Updated', d.updated),
      fact('Attributes', d.attributes),
    );

    const verdict = h('div.dos-verdict', null,
      ...d.strengths.map((s) => h('div.good', null, `+ ${s}`)),
      ...d.limitations.map((s) => h('div.bad', null, `− ${s}`)),
    );

    const links = d.links.length
      ? h('div.dos-links', null,
          h('div.dos-links-head', null, 'LEARN MORE'),
          ...d.links.map((l) =>
            h('a', { href: l.url, target: '_blank', rel: 'noopener' },
              l.label,
              h('span.ext', { 'aria-hidden': 'true' }, ' ↗'),
            ),
          ),
        )
      : null;

    card.replaceChildren(
      h('div.dos-head', null,
        h('span.swatch', { style: `background:${def.color}` }),
        h('h3', null, def.label),
        h('button.close', { 'aria-label': 'Close source details' }, '✕'),
      ),
      h('p.dos-lede', null, d.lede),
      facts,
      h('div.dos-live', null, liveText(state, id)),
      verdict,
      ...(links ? [links] : []),
      h('div.ep', null, d.endpointDisplay),
    );

    card.querySelector('.dos-head .close')?.addEventListener('click', close);
    card.hidden = false;
  };

  store.subscribe(['dossierOpen', 'viewport', 'enabled'], render);
  render(store.get());
}

function fact(label: string, value: string): HTMLElement {
  return h('div', null, h('dt', null, label), h('dd', null, value));
}
