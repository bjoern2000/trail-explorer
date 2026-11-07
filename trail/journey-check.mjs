// Trail mode — headless check of the journey model.
//
//   node trail/journey-check.mjs [trailName]
//
// weather-on-route.html renders in a browser and its numbers only exist after paint, which makes
// them unreviewable: a plausible-looking chart is exactly what a wrong pace model
// produces. This prints the same journey the page draws, as numbers, so the model can be
// audited without reading a chart.
//
// It exists to check five things, in order of how badly each would break the page:
//
//   (a) ARRIVAL TIMES ARE PLAUSIBLE. The outbound leg of a 6.5 km / 790 m climb should
//       take a little over two and a half hours at a steady pace, and the return should
//       be visibly faster. If the pace model is wrong, everything downstream is decor.
//   (b) THE RETURN IS FASTER, BUT NOT BY THE FLAT RATIO. Tobler peaks on a slight
//       downgrade, so the descent should beat level ground, and a naive "downhill is
//       1.5x" fudge should NOT reproduce the number.
//   (c) TREELINE CROSSINGS FALL WHERE THE PROFILE SAYS. Marker hours are the page's most
//       load-bearing claim and the easiest to get subtly wrong by an index.
//   (d) THE JOURNEY FITS THE HORIZON. A journey occupies hours, so it has to fit inside
//       +36 h in full. This prints the end hour against the horizon for several
//       departures, which is where the today-and-tomorrow finding comes from.
//   (e) SEAM LEGS ARE EXCLUDED. Run it against East Longs Peak Trail (parts: 2, a 648 m
//       step between the last two profile samples) and the walked distance must come out
//       one leg short of the trail length rather than the profile's cliff being timed as
//       a descent.
//
// It imports the shipped .ts modules directly, so these are the page's numbers. The
// resolve hook only supplies the extension TypeScript source omits, as
// scope/grade-check.mjs does.

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
const { buildJourney, journeyClock, journeyDuration, tableRows } = await import(
  '../src/trail/journey.ts'
);
const { PACES, paceKph, toblerKph } = await import('../src/trail/pace.ts');

const REGION = 'rmnp';
const WANT = process.argv[2] ?? 'Flattop Mountain Trail';

const derived = JSON.parse(
  readFileSync(new URL('../scope/derived/rmnp.json', import.meta.url), 'utf8'),
);
const trail = derived.trails.find((t) => t.name === WANT);
if (!trail) {
  console.error(`No trail named "${WANT}" in ${REGION}. Try one of:`);
  for (const t of derived.trails.slice(0, 12)) console.error(`  ${t.name}`);
  process.exit(1);
}

const region = REGIONS[REGION];
const provider = simulatedProvider('storms', REGION);
const { hourOfDay } = provider.now();
const departHour = (day, clock) => day * 24 + clock - hourOfDay;

console.log('='.repeat(78));
console.log(`JOURNEY CHECK — ${trail.name}, ${region.name}`);
console.log('='.repeat(78));
console.log(
  `length ${(trail.lengthM / 1000).toFixed(2)} km   gain ${Math.round(trail.gainM)} m   ` +
    `elev ${Math.round(trail.minElevM)} to ${Math.round(trail.maxElevM)} m   ` +
    `treeline ${region.treelineM} m`,
);
console.log(
  `parts ${trail.parts}   seams [${trail.seamIndices.join(', ')}]   ` +
    `profile ${trail.profile.length} samples   routeType ${trail.routeType}`,
);

// ---- (a)/(b) the pace model ------------------------------------------------
console.log('\nPACE MODEL (Tobler, scaled)');
console.log('  grade    tobler   slow  steady   fast   (km/h)');
for (const s of [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.3]) {
  const row = PACES.map((p) => paceKph(s, p.factor).toFixed(2).padStart(6)).join(' ');
  console.log(
    `  ${String(Math.round(s * 100)).padStart(4)}%  ${toblerKph(s).toFixed(2).padStart(7)}  ${row}`,
  );
}

const j = await buildJourney(trail, region, provider, { departHour: departHour(1, 9), pace: 'steady' });

const outLast = [...j.waypoints].reverse().find((w) => w.outbound);
const outMin = (outLast.hour - j.departHour) * 60;
const backMin = j.totalMinutes - outMin;

console.log('\nJOURNEY');
console.log(
  `  depart ${journeyClock(provider, j.departHour)}   finish ${journeyClock(provider, j.endHour)}   ` +
    `total ${journeyDuration(j.totalMinutes)}`,
);
console.log(
  `  out ${journeyDuration(outMin)} over ${(outLast.travelM / 1000).toFixed(2)} km   ` +
    `back ${journeyDuration(backMin)}   ratio out/back ${(outMin / backMin).toFixed(2)}`,
);
console.log(
  `  walked ${(j.totalM / 1000).toFixed(2)} km of a possible ` +
    `${((trail.lengthM * (j.outAndBack ? 2 : 1)) / 1000).toFixed(2)} km   ` +
    `seam legs skipped ${j.seamCount}`,
);
console.log(
  `  above treeline ${journeyDuration(j.exposedMinutes)} ` +
    `(${Math.round((j.exposedMinutes / j.totalMinutes) * 100)}% of the walk)`,
);
console.log(
  `  temp ${j.tempRangeC[0].toFixed(1)} to ${j.tempRangeC[1].toFixed(1)} C   ` +
    `peak gust ${Math.round(j.peakGustKph)} km/h   storm peak ${Math.round(j.peakThunder * 100)}%   ` +
    `antecedent ${j.antecedentMm.toFixed(1)} mm`,
);

// ---- (c) markers -----------------------------------------------------------
console.log('\nMARKERS');
for (const m of j.markers) {
  console.log(
    `  ${journeyClock(provider, m.hour)}  ${(m.travelM / 1000).toFixed(2).padStart(5)} km  ` +
      `${m.label.padEnd(20)} ${m.sub}`,
  );
}

// ---- the table concept's rows ----------------------------------------------
console.log('\nTABLE ROWS (concept C)');
console.log('  time    km   elev   T   gust  storm  lvl  exposed');
for (const w of tableRows(j, 11)) {
  console.log(
    `  ${journeyClock(provider, w.hour)} ${(w.travelM / 1000).toFixed(1).padStart(5)} ` +
      `${String(Math.round(w.elevM)).padStart(6)} ${String(Math.round(w.sample.tempC)).padStart(3)} ` +
      `${String(Math.round(w.sample.gustKph)).padStart(5)} ` +
      `${String(Math.round(w.sample.thunderProb * 100) + '%').padStart(6)} ` +
      `${String(w.level).padStart(4)} ${w.exposed ? '  yes' : '   no'}`,
  );
}

// ---- (d) the horizon -------------------------------------------------------
console.log('\nHORIZON (+' + provider.horizonHours + ' h) BY DEPARTURE');
for (const [day, clock] of [
  [0, 12],
  [0, 15],
  [1, 6],
  [1, 9],
  [1, 13],
  [2, 6],
  [2, 9],
]) {
  const jj = await buildJourney(trail, region, provider, {
    departHour: departHour(day, clock),
    pace: 'steady',
  });
  const label = day === 0 ? 'today' : day === 1 ? 'tomorrow' : `day +${day}`;
  console.log(
    `  ${label.padEnd(9)} ${String(clock).padStart(2)}:00  ` +
      `ends ${jj.endHour.toFixed(1).padStart(5)} h out  ` +
      `${jj.withinHorizon ? 'route-specific' : 'PAST HORIZON — outlook only'}`,
  );
}

console.log('\nPACE SPREAD (same departure)');
for (const p of PACES) {
  const jj = await buildJourney(trail, region, provider, {
    departHour: departHour(1, 9),
    pace: p.id,
  });
  const up = jj.markers.find((m) => m.kind === 'treeline-up');
  console.log(
    `  ${p.label.padEnd(7)} total ${journeyDuration(jj.totalMinutes).padEnd(9)} ` +
      `finish ${journeyClock(provider, jj.endHour)}  ` +
      `${up ? `above treeline ${journeyClock(provider, up.hour)}` : 'no treeline crossing'}  ` +
      `storm peak ${Math.round(jj.peakThunder * 100)}%`,
  );
}
console.log('');
