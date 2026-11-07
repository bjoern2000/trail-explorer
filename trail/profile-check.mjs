// Trail mode — headless check of Concept B's monotone cubic profile curve.
//
//   node trail/profile-check.mjs [trailName]
//
// The claim `trail/monotone.ts` makes is that its curve cannot overshoot: between any two
// samples the drawn line stays within the closed interval [min(y0,y3), max(y0,y3)] of
// those two samples' own y values. That is provable from the Fritsch-Carlson
// construction, but "provable" is not "proven on the actual output", and a page whose
// whole argument is "never invent a bump that is not in the data" cannot rest that on
// maths nobody re-checked against the numbers the page actually draws. This samples every
// segment of the ACTUAL curve `route.ts` builds (same journey, same chart scale) at fine
// resolution and asserts the property numerically.
//
// It imports `trail/monotone.ts` directly, the same module `route.ts` calls to draw, so
// this is checking the shipped curve rather than a re-implementation of it. The chart
// scale constants (CH_W/CH_TOP/CH_BOT) are mirrored from `route.ts` rather than imported:
// route.ts has DOM/CSS side effects at module scope (it boots the page), so it cannot be
// imported under plain Node the way journey.ts and pace.ts can. Keep these three numbers
// in sync with route.ts's own CH_W/CH_TOP/CH_BOT if either changes.

import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) {
      const candidate = new URL(`${spec}.ts`, ctx.parentURL);
      if (existsSync(fileURLToPath(candidate))) return next(`${spec}.ts`, ctx);
    }
    return next(spec, ctx);
  },
});

const { REGIONS } = await import('../src/scope/model.ts');
const { simulatedProvider } = await import('../src/scope/weather/simulated.ts');
const { buildJourney } = await import('../src/trail/journey.ts');
const { monotoneSegments, bezierAt } = await import('../src/trail/monotone.ts');

// Mirrors route.ts's own constants (see the header note).
const CH_W = 340;
const CH_TOP = 26;
const CH_BOT = 298;

function chartElevRange(j) {
  return [j.minElevM - 40, j.maxElevM + 60];
}

async function checkJourney(label, trail, region, provider, opts) {
  const j = await buildJourney(trail, region, provider, opts);
  const [loElev, hiElev] = chartElevRange(j);
  const x = (travelM) => (travelM / j.totalM) * CH_W;
  const y = (elevM) => CH_BOT - ((elevM - loElev) / (hiElev - loElev)) * (CH_BOT - CH_TOP);
  const pts = j.waypoints.map((w) => ({ x: x(w.travelM), y: y(w.elevM) }));

  const segs = monotoneSegments(pts);
  const SAMPLES = 200;
  let maxOver = 0; // largest amount any sampled point exceeded its segment's own [min,max]
  let worstSeg = -1;
  let worstT = 0;
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    const lo = Math.min(seg.y0, seg.y3);
    const hi = Math.max(seg.y0, seg.y3);
    for (let k = 0; k <= SAMPLES; k++) {
      const t = k / SAMPLES;
      const p = bezierAt(seg, t);
      const over = p.y < lo ? lo - p.y : p.y > hi ? p.y - hi : 0;
      if (over > maxOver) {
        maxOver = over;
        worstSeg = s;
        worstT = t;
      }
    }
  }

  const span = hiElev - loElev;
  const exagg = ((CH_BOT - CH_TOP) * j.totalM) / (CH_W * span);

  console.log(`\n${label}`);
  console.log(`  waypoints ${pts.length}, segments ${segs.length}, sampled ${SAMPLES + 1}/segment`);
  console.log(`  vertical exaggeration: ${exagg.toFixed(2)}x`);
  console.log(
    `  max overshoot beyond [min(y0,y3),max(y0,y3)]: ${maxOver.toFixed(6)} px` +
      (maxOver > 1e-6 ? ` (WORST at segment ${worstSeg}, t=${worstT.toFixed(3)})` : ' — none detected'),
  );
  return maxOver;
}

const REGION = 'rmnp';
const WANT = process.argv[2] ?? 'Flattop Mountain Trail';

const derived = JSON.parse(readFileSync(new URL('../scope/derived/rmnp.json', import.meta.url), 'utf8'));
const trail = derived.trails.find((t) => t.name === WANT);
if (!trail) {
  console.error(`No trail named "${WANT}" in ${REGION}. Try one of:`);
  for (const t of derived.trails.slice(0, 12)) console.error(`  ${t.name}`);
  process.exit(1);
}

const region = REGIONS[REGION];
const provider = simulatedProvider('storms', REGION);
const { hourOfDay } = provider.now();
const departHour = 1 * 24 + 11 - hourOfDay;

console.log('='.repeat(78));
console.log(`PROFILE CHECK — ${trail.name}, ${region.name}`);
console.log('='.repeat(78));

let worst = 0;
worst = Math.max(
  worst,
  await checkJourney('out-and-back, steady', trail, region, provider, {
    departHour,
    pace: 'steady',
    traversal: 'out-and-back',
  }),
);
worst = Math.max(
  worst,
  await checkJourney('one-way, steady', trail, region, provider, {
    departHour,
    pace: 'steady',
    traversal: 'one-way',
  }),
);
worst = Math.max(
  worst,
  await checkJourney('out-and-back, fast', trail, region, provider, {
    departHour,
    pace: 'fast',
    traversal: 'out-and-back',
  }),
);

console.log('\n' + '='.repeat(78));
if (worst > 1e-6) {
  console.error(`FAIL: monotone curve overshot its own samples by up to ${worst.toFixed(6)} px.`);
  process.exit(1);
}
console.log('PASS: no overshoot detected in any segment, any journey checked.');
