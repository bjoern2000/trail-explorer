// The device chrome as a node. Pairs with `phone-frame.css`; see that file for why it is
// shared rather than copied a third time.
//
// It builds the bezel, the status strip, the screen box and the home indicator, and it knows
// nothing whatsoever about what a page puts on the screen. Callers wrap it in their own
// figure element (`src/trail/route.ts` wraps it in `.cx-frame` with a label above it; the
// digest wraps it in `.dg-ph-frame`).

import { h } from './dom';

/**
 * `clock` is the status bar's time, and it is a required argument rather than a default for
 * the reason `src/trail/route.ts` records at its own call site: the stock 9:41 every iOS
 * mockup uses was sitting above a screen that said the walker set off at 11:00 and it is now
 * 12:48, which is three clocks disagreeing inside one phone. Every page that draws this frame
 * has a provider with a real clock on it, so every page can pass the real one.
 */
export function deviceFrame(clock: string, ...screen: (Node | null)[]): HTMLElement {
  return h(
    'div.phone',
    {},
    h(
      'div.phone-in',
      {},
      h(
        'div.ph-status',
        {},
        h('span', {}, clock),
        h('span.ph-glyphs', {}, h('i', {}), h('i', {}), h('i', {})),
      ),
      h('div.ph-screen', {}, ...screen.filter((n): n is Node => n != null)),
      h('div.ph-home', {}),
    ),
  );
}
