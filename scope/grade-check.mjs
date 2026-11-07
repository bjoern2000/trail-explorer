// Trail Scope — headless check of the weather simulation and the conditions grade.
//
//   node scope/grade-check.mjs [day ...]
//
// Standalone Node, no dependencies, no browser, no derived data. It builds eight synthetic
// trails spanning the space that matters (short valley loop, long above-treeline
// point-to-point, steep unsurfaced, flat gravel, short exposed ridge, high lake basin, long
// low gravel track, long shaded valley), then grades every one of them under all four
// scenarios for every day the scrubber offers, 0 to 4. The last three trails are the
// inversion set: a high cool exposed route and a low hot sheltered one have to swap ends of
// the list between storms and heat.
//
// It exists to prove three things, because if any of them fails the design has failed:
//   (a) the four scenarios produce genuinely DIFFERENT ORDERINGS, not just different
//       colours on the same list. The ordering table and the pairwise disagreement
//       counts at the bottom are the evidence.
//   (b) days past +36 h degrade to `outlook` for everything, with no hourly claim and no
//       best window, because that is the provider's horizon.
//   (c) NO DAY OF THE SCRUBBER COMES BACK EMPTY. Every day returns a real level, and every
//       condition filter passes something somewhere. This is claim (c) at the bottom and it
//       is the regression test for the bug that motivated it: past the horizon every grade
//       was mixed with no best window, which no condition filter could satisfy, so
//       scrubbing to Monday with a condition chip active silently emptied the list.
//
// It imports the shipped .ts modules directly (Node type-stripping), so the numbers here
// are the numbers the page will show. The resolve hook below only supplies the file
// extension that TypeScript source omits; it changes no behaviour.

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
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

const { SCENARIO_LIST } = await import('../src/scope/weather/scenarios.ts');
const { simulatedProvider } = await import('../src/scope/weather/simulated.ts');
const { fetchRouteWeather, routeSamplePoints, weekdayLabel } = await import(
  '../src/scope/weather/provider.ts'
);
const {
  CONDITION_FILTERS,
  conditionFilterDegraded,
  gradeTrail,
  matchesConditionFilter,
  terrainFacts,
} = await import('../src/scope/weather/grade.ts');
// SCRUB_DAYS is the UI's, and the phone module is off limits to this check, so the day list
// below is the same 5 and the mismatch would show up as a missing column rather than
// silently. `MAX_DAY` fetches one day further, as a field-coverage check.

// ============================================================================
// FIXTURES — synthetic, deliberately not the derived regions
// ============================================================================

/** Rocky Mountain NP numbers, matching what scope/derive.mjs will seed. */
const RMNP = {
  id: 'rmnp',
  name: 'Rocky Mountain National Park',
  where: 'Colorado Front Range',
  bbox: [-105.9, 40.15, -105.45, 40.55],
  assumedLocation: [-105.5217, 40.3772],
  assumedLocationLabel: 'Estes Park, Colorado',
  treelineM: 3450,
  manager: 'National Park Service',
};

const PROFILE_POINTS = 48;

/** Profile shapes. `ramp` climbs and stays, `hump` goes over and back, `flat` undulates. */
function makeProfile(minElevM, maxElevM, shape) {
  const out = [];
  for (let i = 0; i < PROFILE_POINTS; i++) {
    const t = i / (PROFILE_POINTS - 1);
    let f;
    if (shape === 'ramp') f = Math.min(1, t / 0.85);
    else if (shape === 'hump') f = 1 - Math.abs(2 * t - 1);
    else f = 0.5 - 0.5 * Math.cos(2 * Math.PI * t * 1.5);
    out.push(minElevM + (maxElevM - minElevM) * f);
  }
  return out;
}

/** A straight west-to-east line of the right real length, at RMNP latitude. */
function makeGeometry(lng, lat, lengthM) {
  const degPerM = 1 / (111320 * Math.cos((lat * Math.PI) / 180));
  const coords = [];
  for (let i = 0; i <= 20; i++) coords.push([lng + degPerM * lengthM * (i / 20), lat]);
  return { type: 'LineString', coordinates: coords };
}

function makeTrail(t) {
  const geometry = makeGeometry(t.lng, t.lat, t.lengthM);
  const profile = makeProfile(t.minElevM, t.maxElevM, t.shape);
  const gainM = t.gainM ?? Math.round(t.maxElevM - t.minElevM);
  const lengthMi = t.lengthM / 1609.344;
  const gainFt = gainM * 3.28084;
  return {
    id: `rmnp/${t.id}`,
    name: t.name,
    region: 'rmnp',
    geometry,
    parts: 1,
    start: geometry.coordinates[0],
    bbox: [t.lng, t.lat, geometry.coordinates[20][0], t.lat],
    centroid: [(t.lng + geometry.coordinates[20][0]) / 2, t.lat],
    lengthM: t.lengthM,
    gainM,
    minElevM: t.minElevM,
    maxElevM: t.maxElevM,
    maxGradePct: t.maxGradePct,
    profile,
    routeType: t.routeType,
    difficulty: t.difficulty,
    difficultyScore: Math.round(Math.sqrt(gainFt * 2 * lengthMi)),
    estMinutes: t.estMinutes,
    surface: t.surface,
    activities: t.activities ?? ['hike', 'run'],
    prominence: t.prominence ?? 0.5,
    osmWayIds: [1],
  };
}

const TRAILS = [
  makeTrail({
    id: 'valley-loop',
    name: 'Sprague Valley Loop',
    lng: -105.62,
    lat: 40.31,
    lengthM: 4500,
    minElevM: 2450,
    maxElevM: 2560,
    gainM: 110,
    maxGradePct: 8,
    shape: 'hump',
    routeType: 'loop',
    difficulty: 'easy',
    estMinutes: 75,
    surface: 'gravel',
  }),
  makeTrail({
    id: 'alpine-traverse',
    name: 'Continental Divide Traverse',
    lng: -105.7,
    lat: 40.29,
    lengthM: 26000,
    minElevM: 3100,
    maxElevM: 3850,
    gainM: 1150,
    maxGradePct: 22,
    shape: 'ramp',
    routeType: 'point-to-point',
    difficulty: 'hard',
    estMinutes: 690,
    surface: 'rock',
  }),
  makeTrail({
    id: 'steep-unsurfaced',
    name: 'Bear Gulch Climb',
    lng: -105.6,
    lat: 40.33,
    lengthM: 7000,
    minElevM: 2500,
    maxElevM: 3150,
    gainM: 680,
    maxGradePct: 34,
    shape: 'ramp',
    routeType: 'point-to-point',
    difficulty: 'hard',
    estMinutes: 200,
    surface: null,
  }),
  makeTrail({
    id: 'flat-gravel-lake',
    name: 'Lake Shore Path',
    lng: -105.58,
    lat: 40.27,
    lengthM: 9000,
    minElevM: 2300,
    maxElevM: 2340,
    gainM: 60,
    maxGradePct: 4,
    shape: 'flat',
    routeType: 'loop',
    difficulty: 'easy',
    estMinutes: 120,
    surface: 'fine_gravel',
  }),
  makeTrail({
    id: 'ridge-short',
    name: 'Sundance Ridge',
    lng: -105.68,
    lat: 40.35,
    lengthM: 3000,
    minElevM: 3400,
    maxElevM: 3660,
    gainM: 270,
    maxGradePct: 26,
    shape: 'ramp',
    routeType: 'point-to-point',
    difficulty: 'moderate',
    estMinutes: 95,
    surface: 'rock',
  }),
  // The inversion pair. Same region, same scenario, opposite answers: the high basin is
  // cool and exposed, the low track is hot and sheltered.
  makeTrail({
    id: 'high-lake-basin',
    name: 'Blue Lake Basin',
    lng: -105.72,
    lat: 40.32,
    lengthM: 6000,
    minElevM: 3350,
    maxElevM: 3550,
    gainM: 220,
    maxGradePct: 14,
    shape: 'ramp',
    routeType: 'point-to-point',
    difficulty: 'moderate',
    estMinutes: 150,
    surface: 'rock',
  }),
  makeTrail({
    id: 'low-gravel-track',
    name: 'Meadow Draw Track',
    lng: -105.55,
    lat: 40.24,
    lengthM: 12000,
    minElevM: 2150,
    maxElevM: 2210,
    gainM: 80,
    maxGradePct: 5,
    shape: 'flat',
    routeType: 'point-to-point',
    difficulty: 'easy',
    estMinutes: 180,
    surface: 'gravel',
  }),
  makeTrail({
    id: 'long-forest-river',
    name: 'North Fork River Trail',
    lng: -105.75,
    lat: 40.4,
    lengthM: 16000,
    minElevM: 2200,
    maxElevM: 2460,
    gainM: 300,
    maxGradePct: 7,
    shape: 'flat',
    routeType: 'point-to-point',
    difficulty: 'moderate',
    estMinutes: 270,
    surface: 'ground',
  }),
];

// ============================================================================
// RUN
// ============================================================================

const DAYS = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [0, 1, 2, 3, 4];
// One day past the furthest graded day. The app no longer needs the following day for a
// filter (`good-tomorrow` is gone; every chip reads the selected day), but fetching one
// day further is still the sharper field-coverage test: it proves the series does not stop
// exactly where the scrubber does.
const MAX_DAY = Math.max(...DAYS) + 1;
/** Every day any grade is needed for, plus the one past the end, for coverage. */
const GRADE_DAYS = [...new Set(DAYS.flatMap((d) => [d, d + 1]))].sort((a, b) => a - b);

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const shortId = (t) => t.id.split('/')[1];
/** Column heads for the per-scenario tables. */
const scenarioHead = () => SCENARIO_LIST.map((s) => padL(s.id, 11)).join('');

const probe = simulatedProvider('storms', 'rmnp');
const now = probe.now();

console.log('');
console.log('TRAIL SCOPE — conditions grade check');
console.log(
  `provider  : ${probe.label}, horizon ${probe.horizonHours} h, nominal ${probe.resolutionM} m (stand-in)`,
);
console.log(
  `clock     : day 0 = ${weekdayLabel(now.dayIndex)} ${String(now.hourOfDay).padStart(2, '0')}:00, fixed`,
);
console.log(`region    : ${RMNP.name}, treeline ${RMNP.treelineM} m`);

console.log('\n--- terrain, computed from the trail, identical in every scenario ---');
console.log(
  `${pad('trail', 20)}${padL('km', 6)}${padL('gain', 6)}${padL('max m', 7)}${padL('grade', 7)}${padL('est h', 7)}${padL('exposed', 9)}${padL('flat', 7)}${padL('holds', 7)}  surface`,
);
for (const t of TRAILS) {
  const f = terrainFacts(t, RMNP);
  console.log(
    pad(shortId(t), 20) +
      padL(f.lengthKm.toFixed(1), 6) +
      padL(t.gainM, 6) +
      padL(t.maxElevM, 7) +
      padL(`${t.maxGradePct}%`, 7) +
      padL(f.durationH.toFixed(1), 7) +
      padL(`${Math.round(f.exposedShare * 100)}%`, 9) +
      padL(`${Math.round(f.flatShare * 100)}%`, 7) +
      padL(f.holdsWater.toFixed(2), 7) +
      `  ${t.surface ?? '(untagged)'}`,
  );
}

// Weather is fetched once per scenario per trail and every day is graded off it, exactly
// as the page will do it.
const weather = new Map();
for (const scenario of SCENARIO_LIST) {
  const provider = simulatedProvider(scenario.id, 'rmnp');
  for (const t of TRAILS) {
    weather.set(`${scenario.id}|${t.id}`, await fetchRouteWeather(provider, t, MAX_DAY));
  }
}

const grades = new Map(); // `${scenarioId}|${day}|${trailId}` → grade
for (const scenario of SCENARIO_LIST) {
  const provider = simulatedProvider(scenario.id, 'rmnp');
  for (const day of GRADE_DAYS) {
    for (const t of TRAILS) {
      grades.set(
        `${scenario.id}|${day}|${t.id}`,
        gradeTrail(t, RMNP, weather.get(`${scenario.id}|${t.id}`), day, provider),
      );
    }
  }
}

/** Anything that would be a real defect rather than a number worth reading. */
const failures = [];

const ordered = (scenarioId, day) =>
  [...TRAILS].sort(
    (a, b) =>
      grades.get(`${scenarioId}|${day}|${b.id}`).score - grades.get(`${scenarioId}|${day}|${a.id}`).score ||
      a.id.localeCompare(b.id),
  );

const hhmm = (h) => {
  const abs = Math.round(now.hourOfDay + h);
  return `${String(((abs % 24) + 24) % 24).padStart(2, '0')}:00`;
};

for (const day of DAYS) {
  console.log(
    `\n\n================ DAY ${day} (${weekdayLabel(now.dayIndex + day)}) ================`,
  );
  for (const scenario of SCENARIO_LIST) {
    const rows = ordered(scenario.id, day);
    console.log(`\n  [${scenario.id}] ${scenario.label}`);
    console.log(
      `  ${pad('#', 3)}${pad('trail', 20)}${pad('level', 7)}${pad('conf', 16)}${pad('window', 14)}headline`,
    );
    rows.forEach((t, i) => {
      const g = grades.get(`${scenario.id}|${day}|${t.id}`);
      const win = g.bestWindow ? `${hhmm(g.bestWindow.startHour)}-${hhmm(g.bestWindow.endHour)}` : '(none)';
      console.log(
        `  ${pad(i + 1, 3)}${pad(shortId(t), 20)}${pad(g.level, 7)}${pad(g.confidence, 16)}${pad(win, 14)}${g.headline}`,
      );
    });
  }
}

// ---- claim (a): the orderings actually differ -------------------------------
// Ties are shown as `=` and excluded from the pairwise counts. Two trails the grade
// cannot separate are not evidence of anything, in either direction.
console.log('\n\n================ CLAIM (a): DIFFERENT ORDERINGS ================\n');
const TIE = 0.5;
const scoreOf = (s, day, t) => grades.get(`${s}|${day}|${t.id}`).score;

for (const day of DAYS.filter((d) => d <= 1)) {
  console.log(`  day ${day} — Best-today ordering under each scenario, ties as "="\n`);
  for (const scenario of SCENARIO_LIST) {
    const rows = ordered(scenario.id, day);
    let line = '';
    rows.forEach((t, i) => {
      if (i > 0) {
        const gap = scoreOf(scenario.id, day, rows[i - 1]) - scoreOf(scenario.id, day, t);
        line += gap <= TIE ? ' = ' : ' > ';
      }
      line += shortId(t);
    });
    const distinct = new Set(rows.map((t) => Math.round(scoreOf(scenario.id, day, t) / 1))).size;
    console.log(`  ${pad(scenario.id, 11)}${line}`);
    console.log(`  ${pad('', 11)}${distinct} distinct grades${scenario.id === 'bluebird' ? ', flat by design: nothing binds, so conditions carry no ranking information' : ''}`);
  }

  console.log('');
  console.log(`  ${pad('trail', 20)}${SCENARIO_LIST.map((s) => padL(s.id, 13)).join('')}`);
  for (const t of TRAILS) {
    console.log(
      `  ${pad(shortId(t), 20)}` +
        SCENARIO_LIST.map((s) => {
          const rows = ordered(s.id, day);
          const g = grades.get(`${s.id}|${day}|${t.id}`);
          return padL(`#${rows.indexOf(t) + 1} ${g.level}`, 13);
        }).join(''),
    );
  }

  console.log('');
  for (let i = 0; i < SCENARIO_LIST.length; i++) {
    for (let j = i + 1; j < SCENARIO_LIST.length; j++) {
      const a = SCENARIO_LIST[i].id;
      const b = SCENARIO_LIST[j].id;
      let reversed = 0;
      let comparable = 0;
      for (let x = 0; x < TRAILS.length; x++) {
        for (let y = x + 1; y < TRAILS.length; y++) {
          const ad = scoreOf(a, day, TRAILS[x]) - scoreOf(a, day, TRAILS[y]);
          const bd = scoreOf(b, day, TRAILS[x]) - scoreOf(b, day, TRAILS[y]);
          if (Math.abs(ad) <= TIE || Math.abs(bd) <= TIE) continue;
          comparable++;
          if (Math.sign(ad) !== Math.sign(bd)) reversed++;
        }
      }
      const sameOrder = ordered(a, day).map(shortId).join() === ordered(b, day).map(shortId).join();
      const flips = TRAILS.filter(
        (t) => grades.get(`${a}|${day}|${t.id}`).level !== grades.get(`${b}|${day}|${t.id}`).level,
      ).length;
      console.log(
        `  ${pad(`${a} vs ${b}`, 26)}${padL(`${reversed}/${comparable}`, 7)} orderable pairs REVERSED, ` +
          `${flips}/${TRAILS.length} trails change level` +
          (sameOrder && flips === 0 ? '   IDENTICAL  <-- design failure' : ''),
      );
    }
  }
  console.log('');
}

// ---- claim (b): past the horizon everything is outlook ----------------------
console.log('================ CLAIM (b): PAST THE HORIZON ================\n');
for (const day of DAYS) {
  let routeSpecific = 0;
  let outlook = 0;
  let windows = 0;
  let hourClaims = 0;
  for (const scenario of SCENARIO_LIST) {
    for (const t of TRAILS) {
      const g = grades.get(`${scenario.id}|${day}|${t.id}`);
      if (g.confidence === 'route-specific') routeSpecific++;
      else outlook++;
      if (g.bestWindow) windows++;
      if (g.factors.some((f) => f.fromHour !== undefined)) hourClaims++;
      // An outlook grade IS allowed to be poor: a coarse forecast can honestly write off a
      // whole area for a day. What it is never allowed to do is make an hourly or a
      // terrain claim, which is what the window and hour-claim columns above police.
      if (g.confidence === 'outlook' && g.bestWindow) {
        console.log(`  !! outlook grade carried a best window: ${scenario.id} ${shortId(t)}`);
        failures.push(`day ${day} ${scenario.id} ${shortId(t)}: outlook with a best window`);
      }
      if (g.confidence === 'outlook' && /\d\d:\d\d/.test(g.headline)) {
        console.log(`  !! outlook headline named an hour: ${scenario.id} ${shortId(t)}`);
        failures.push(`day ${day} ${scenario.id} ${shortId(t)}: outlook headline named an hour`);
      }
      if (g.confidence === 'outlook' && g.factors.some((f) => f.kind === 'exposure')) {
        console.log(`  !! outlook grade claimed exposure: ${scenario.id} ${shortId(t)}`);
        failures.push(`day ${day} ${scenario.id} ${shortId(t)}: outlook claimed a terrain factor`);
      }
    }
  }
  const n = SCENARIO_LIST.length * TRAILS.length;
  console.log(
    `  day ${day}: ${padL(routeSpecific, 2)}/${n} route-specific, ${padL(outlook, 2)}/${n} outlook, ` +
      `${padL(windows, 2)}/${n} with a best window, ${padL(hourClaims, 2)}/${n} making an hourly claim`,
  );
}
console.log(`\n  horizon is read off the provider (${probe.horizonHours} h), never hard-coded in grade.ts.`);

// ---- claim (c): no day of the scrubber comes back empty ---------------------
//
// Two tables per day. The first is the level mix, which has to be a real distribution and
// not a single bucket every route falls into. The second is what each condition chip would
// leave in the list, chip by chip, with the degraded chips marked: past the horizon four of
// the six are answering a coarser question than their label promises, and two are pure
// terrain facts that mean exactly the same thing on every day.
//
// The bar is the whole point of this section. A chip that can never pass is a chip that
// empties the list, and an empty list past the horizon is what a reader reports as a broken
// app, not as an honest limit. So: for every day, every chip has to pass at least one trail
// somewhere across the four scenarios, and every day has to return a level for every trail.
console.log('\n\n================ CLAIM (c): NO DAY COMES BACK EMPTY ================\n');

const LEVELS = ['prime', 'mixed', 'poor'];

// Field coverage first, because everything below is meaningless if the simulated series
// stops short. `gradeTrail` falls through to the no-data grade when the provider's series
// does not reach the requested day, and that is the shape the original bug would take if
// the scrubber ever outran the fetch. Checked over GRADE_DAYS, not DAYS, so it also covers
// the day past the end of the scrubber.
{
  const short = [];
  for (const day of GRADE_DAYS) {
    let n = 0;
    for (const scenario of SCENARIO_LIST) {
      for (const t of TRAILS) {
        if (/^no forecast past/.test(grades.get(`${scenario.id}|${day}|${t.id}`).headline)) n++;
      }
    }
    if (n > 0) {
      short.push(`day ${day}: ${n} grades had no field to read`);
      failures.push(`day ${day}: simulated field does not reach it, ${n} no-data grades`);
    }
  }
  console.log(
    `  field coverage: days ${GRADE_DAYS.join(', ')} all have hourly field to grade off` +
      (short.length ? `  <-- ${short.join('; ')}` : ' (nothing falls off the end)'),
  );
  console.log('');
}

// One day, the selected one: every condition filter reads the day the reader picked and no
// other. The second grade here was for a `good-tomorrow` chip that no longer exists.
const conditionCtx = (scenarioId, day, trail) => ({
  trail,
  region: RMNP,
  today: grades.get(`${scenarioId}|${day}|${trail.id}`),
});

for (const day of DAYS) {
  const anyGrade = grades.get(`${SCENARIO_LIST[0].id}|${day}|${TRAILS[0].id}`);
  const conf = anyGrade.confidence;
  console.log(
    `  --- day ${day} (${weekdayLabel(now.dayIndex + day)}), ${conf} ` +
      `${conf === 'outlook' ? '(past the +' + probe.horizonHours + ' h horizon)' : ''}`,
  );

  console.log(
    `  ${pad('scenario', 13)}${LEVELS.map((l) => padL(l, 7)).join('')}${padL('graded', 9)}`,
  );
  const levelTotals = { prime: 0, mixed: 0, poor: 0 };
  for (const scenario of SCENARIO_LIST) {
    const counts = { prime: 0, mixed: 0, poor: 0 };
    for (const t of TRAILS) counts[grades.get(`${scenario.id}|${day}|${t.id}`).level]++;
    for (const l of LEVELS) levelTotals[l] += counts[l];
    console.log(
      `  ${pad(scenario.id, 13)}${LEVELS.map((l) => padL(counts[l], 7)).join('')}` +
        padL(`${counts.prime + counts.mixed + counts.poor}/${TRAILS.length}`, 9),
    );
  }
  const gradedAll = levelTotals.prime + levelTotals.mixed + levelTotals.poor;
  console.log(
    `  ${pad('ALL', 13)}${LEVELS.map((l) => padL(levelTotals[l], 7)).join('')}` +
      padL(`${gradedAll}/${SCENARIO_LIST.length * TRAILS.length}`, 9),
  );
  if (gradedAll !== SCENARIO_LIST.length * TRAILS.length) {
    failures.push(`day ${day}: ${gradedAll} graded, expected ${SCENARIO_LIST.length * TRAILS.length}`);
  }

  console.log('');
  console.log(
    `  ${pad('condition filter', 20)}${scenarioHead()}${padL('all', 7)}  meaning on this day`,
  );
  for (const cf of CONDITION_FILTERS) {
    const per = SCENARIO_LIST.map(
      (s) => TRAILS.filter((t) => matchesConditionFilter(cf.id, conditionCtx(s.id, day, t))).length,
    );
    const all = per.reduce((a, b) => a + b, 0);
    // Every chip reads the selected day, so one confidence covers the whole group.
    const readsConf = grades.get(`${SCENARIO_LIST[0].id}|${day}|${TRAILS[0].id}`).confidence;
    const degraded = conditionFilterDegraded(cf.id, readsConf);
    console.log(
      `  ${pad(cf.label, 20)}${per.map((n) => padL(n, 11)).join('')}${padL(all, 7)}  ` +
        (degraded ? `COARSE · ${cf.coarseHelp}` : cf.help),
    );
    if (all === 0) failures.push(`day ${day}: filter "${cf.label}" passes nothing in any scenario`);
  }
  console.log('');
}

// ---- determinism ------------------------------------------------------------
const p = simulatedProvider('storms', 'rmnp');
const t0 = TRAILS[1];
const w1 = await fetchRouteWeather(p, t0, 3);
const w2 = await fetchRouteWeather(p, t0, 3);
const g1 = JSON.stringify(gradeTrail(t0, RMNP, w1, 0, p));
const g2 = JSON.stringify(gradeTrail(t0, RMNP, w2, 0, p));
console.log(`\n  determinism: two independent fetch+grade runs ${g1 === g2 ? 'agree' : 'DIFFER  <-- bug'}`);
if (g1 !== g2) failures.push('determinism: two identical runs produced different grades');
console.log(
  `  sampling   : ${routeSamplePoints(t0).length} points on ${shortId(t0)} at ` +
    `${routeSamplePoints(t0)
      .map((x) => Math.round(x.elevM))
      .join(', ')} m`,
);

// ---- verdict ----------------------------------------------------------------
// Exits non-zero on a real defect, so this can be run as a check rather than read as a
// report. Numbers that are merely interesting never fail it.
if (failures.length === 0) {
  console.log(`\n  OK: days ${DAYS.join(', ')} all return grades, and every condition filter passes something.\n`);
} else {
  console.log(`\n  FAILED (${failures.length}):`);
  for (const f of failures) console.log(`    - ${f}`);
  console.log('');
  process.exitCode = 1;
}
