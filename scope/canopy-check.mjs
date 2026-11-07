// Trail Scope — headless audit of the canopy and terrain-shading data.
//
//   node scope/canopy-check.mjs              distributions, aspect verification, grade delta
//   node scope/canopy-check.mjs identical    proof that grade.ts's change is behaviour-free
//
// Written in the spirit of scope/grade-check.mjs: standalone Node, no dependencies, no
// browser, every number printed so it can be argued with. Unlike grade-check it reads the
// COMMITTED derived data rather than synthetic fixtures, because the question here is what
// the real three regions actually contain.
//
// It exists to answer four things, and the third is the deliverable:
//
//   (a) DOES THE CANOPY DATA MEAN WHAT IT LOOKS LIKE. Per-region canopy share against the
//       share of the bbox OSM has drawn a forest polygon over at all. The first number is
//       worthless without the second, and this is the only place both are printed together.
//   (b) IS THE ASPECT RIGHT. Verified rather than asserted: step 2 DEM cells downslope in
//       the computed aspect direction and the ground must be lower; step the same distance
//       the other way and it must be higher. A pass rate, per region, from real tiles.
//   (c) WHAT WOULD CHANGE IF THE HEAT TERM READ REAL CANOPY. Every trail in the default
//       list, graded twice under all four scenarios: once by the shipped grade.ts, once by
//       an isolated copy whose heat sun-load reads `1 - canopyShare` instead of the
//       treeline proxy `exposedShare`. Counted by level and by direction. NOTHING IS
//       CHANGED — this measures the swap so the decision can be taken on numbers.
//   (d) IS THE SHIPPED GRADE UNTOUCHED. `identical` builds the same isolated copy against
//       `git show HEAD:./src/scope/weather/grade.ts`, runs scope/grade-check.mjs in both,
//       and diffs the two outputs byte for byte.
//
// The isolated copy is the technique that makes (c) and (d) honest. Patching the real
// grade.ts and reverting would leave the measurement unreproducible and the tree briefly
// broken; copying the whole of src/ into .cache/ and swapping one file leaves the working
// tree untouched and the counterfactual re-runnable.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two resolve fixes, both supplying only what the bundler supplies and changing no
// behaviour: the file extension TypeScript source omits, and the `type: 'json'` import
// attribute that Vite's `resolveJsonModule` provides implicitly and plain Node requires
// explicitly. Without the second, `src/scope/data.ts` cannot be imported here at all, and
// this check would have to reimplement the display rules it exists to measure against.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) {
      const candidate = new URL(`${spec}.ts`, ctx.parentURL);
      if (existsSync(fileURLToPath(candidate))) return next(`${spec}.ts`, ctx);
    }
    const resolved = next(spec, ctx);
    if (resolved.url.endsWith('.json')) return { ...resolved, importAttributes: { type: 'json' } };
    return resolved;
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GRADE_REL = 'src/scope/weather/grade.ts';
/** Sandboxes live under .cache/, which is gitignored, so a run leaves no trace in git. */
const SANDBOX_DIR = join(ROOT, '.cache', 'canopy-cf');

const { REGIONS } = await import('../src/scope/model.ts');
const { allTrails, displaySet, regionData } = await import('../src/scope/data.ts');
const { gradeTrail, terrainFacts, shadedEnough } = await import('../src/scope/weather/grade.ts');
const { SCENARIO_LIST } = await import('../src/scope/weather/scenarios.ts');
const { simulatedProvider } = await import('../src/scope/weather/simulated.ts');
const { fetchRouteWeather, routeSamplePoints } = await import('../src/scope/weather/provider.ts');
const { sunPosition, selfShadeAt, selfShadedShare } = await import('../src/scope/weather/shading.ts');
const { SIM_DAY_OF_YEAR, SIM_NOW } = await import('../src/scope/weather/simulated.ts');
const { sampleElevation } = await import('./terrarium.mjs');
const { ASPECT_FLAT_DEG } = await import('./canopy.mjs');

const REGION_IDS = ['rmnp', 'adk', 'ozarks'];
/** Days the scrubber offers, as scope/grade-check.mjs enumerates them. */
const DAYS = [0, 1, 2, 3, 4];

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const pctOf = (n, d) => `${Math.round((n / Math.max(1, d)) * 100)}%`;

// ============================================================================
// (a) THE DATA, AND THE NUMBER THAT QUALIFIES IT
// ============================================================================

const OCTANTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

console.log('=== (a) canopy and aspect, per region ===\n');
console.log(
  `${pad('region', 8)}${padL('trails', 7)}${padL('shown', 7)}${padL('bbox wooded', 13)}` +
    `${padL('canopy mean', 13)}${padL('0% canopy', 11)}${padL('100% canopy', 13)}${padL('slope p50', 11)}`,
);
for (const id of REGION_IDS) {
  const data = regionData(id);
  const all = allTrails(id);
  const shown = displaySet(id).trails;
  const zero = shown.filter((t) => t.canopyShare === 0).length;
  const full = shown.filter((t) => t.canopyShare === 1).length;
  const mean = shown.reduce((a, t) => a + t.canopyShare, 0) / Math.max(1, shown.length);
  const slopes = shown.flatMap((t) => t.slopeDeg).sort((a, b) => a - b);
  console.log(
    pad(id, 8) +
      padL(all.length, 7) +
      padL(shown.length, 7) +
      padL(`${Math.round((data.canopy?.mappedShare ?? 0) * 100)}%`, 13) +
      padL(`${Math.round(mean * 100)}%`, 13) +
      padL(`${zero} (${pctOf(zero, shown.length)})`, 11) +
      padL(`${full} (${pctOf(full, shown.length)})`, 13) +
      padL(`${slopes[Math.floor(slopes.length / 2)]}°`, 11),
  );
}
console.log(
  '\n"bbox wooded" is the share of the region bbox with ANY OSM forest/wood polygon over it.\n' +
    'Read the canopy columns against it: a 0% canopy trail in a 53%-mapped region is a\n' +
    'measurement, and the same trail in a 9%-mapped region is a missing polygon.',
);

console.log('\n--- canopy share, banded (default list only) ---');
console.log(`${pad('region', 8)}${padL('0%', 9)}${padL('1-25%', 9)}${padL('26-50%', 9)}${padL('51-75%', 9)}${padL('76-99%', 9)}${padL('100%', 9)}`);
for (const id of REGION_IDS) {
  const shown = displaySet(id).trails;
  const b = [0, 0, 0, 0, 0, 0];
  for (const t of shown) {
    const s = t.canopyShare;
    b[s === 0 ? 0 : s <= 0.25 ? 1 : s <= 0.5 ? 2 : s <= 0.75 ? 3 : s < 1 ? 4 : 5]++;
  }
  console.log(pad(id, 8) + b.map((v) => padL(`${v} (${pctOf(v, shown.length)})`, 9)).join(''));
}

console.log('\n--- terrain aspect, per DEM sample, all trails ---');
console.log(`${pad('region', 8)}${OCTANTS.map((o) => padL(o, 7)).join('')}${padL('flat', 7)}`);
for (const id of REGION_IDS) {
  const hist = new Map(OCTANTS.map((o) => [o, 0]));
  let flat = 0;
  let n = 0;
  for (const t of allTrails(id)) {
    for (const a of t.aspectDeg) {
      n++;
      if (a < 0) flat++;
      else hist.set(OCTANTS[Math.round(a / 45) % 8], hist.get(OCTANTS[Math.round(a / 45) % 8]) + 1);
    }
  }
  console.log(pad(id, 8) + OCTANTS.map((o) => padL(pctOf(hist.get(o), n), 7)).join('') + padL(pctOf(flat, n), 7));
}
console.log(`"flat" is slope < ${ASPECT_FLAT_DEG}°, where the DEM cannot resolve a direction at all.`);

// The proxy and the measurement, side by side. This is the disagreement the grade delta
// below prices: `shadedShare` is 1 - exposedShare, so on any trail entirely below treeline
// it is exactly 1 no matter what is or is not growing there.
console.log('\n--- the proxy against the measurement (default list) ---');
console.log(`${pad('region', 8)}${padL('proxy mean', 12)}${padL('canopy mean', 13)}${padL('mean abs gap', 14)}${padL('proxy says 100%', 17)}${padL('…of those, 0% canopy', 22)}`);
for (const id of REGION_IDS) {
  const region = REGIONS[id];
  const shown = displaySet(id).trails;
  let proxySum = 0;
  let canopySum = 0;
  let gapSum = 0;
  let fullProxy = 0;
  let fullProxyNoCanopy = 0;
  for (const t of shown) {
    const f = terrainFacts(t, region);
    proxySum += f.shadedShare;
    canopySum += t.canopyShare;
    gapSum += Math.abs(f.shadedShare - t.canopyShare);
    if (f.shadedShare === 1) {
      fullProxy++;
      if (t.canopyShare === 0) fullProxyNoCanopy++;
    }
  }
  const n = Math.max(1, shown.length);
  console.log(
    pad(id, 8) +
      padL(`${Math.round((proxySum / n) * 100)}%`, 12) +
      padL(`${Math.round((canopySum / n) * 100)}%`, 13) +
      padL(`${Math.round((gapSum / n) * 100)} pts`, 14) +
      padL(`${fullProxy} (${pctOf(fullProxy, shown.length)})`, 17) +
      padL(`${fullProxyNoCanopy} (${pctOf(fullProxyNoCanopy, fullProxy)})`, 22),
  );
}

// ============================================================================
// (b) THE ASPECT, VERIFIED AGAINST THE GROUND RATHER THAN ASSERTED
// ============================================================================
//
// A sign error in a Horn kernel produces a beautifully plausible histogram pointing the
// wrong way, and no distribution can catch it. The only test that can is the definition:
// walk downslope in the direction the aspect claims and the ground must go DOWN.
//
// 30 m is two terrarium cells at these latitudes, chosen so the step clears the cell the
// sample sits in — a shorter step lands in the same pixel and compares a value with itself.
// Samples flatter than 3 x ASPECT_FLAT_DEG are skipped: on genuinely gentle ground the
// step is inside the DEM's own vertical noise and the test is measuring the noise.

console.log('\n=== (b) aspect verified against the DEM ===\n');
const STEP_M = 30;
const VERIFY_SLOPE_MIN_DEG = ASPECT_FLAT_DEG * 3;
const VERIFY_PER_REGION = 400;
const R_EARTH = 6371008.8;

function offsetLonLat([lon, lat], bearingDeg, distM) {
  const dNorth = distM * Math.cos((bearingDeg * Math.PI) / 180);
  const dEast = distM * Math.sin((bearingDeg * Math.PI) / 180);
  const dLat = (dNorth / R_EARTH) * (180 / Math.PI);
  const dLon = (dEast / (R_EARTH * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
  return [lon + dLon, lat + dLat];
}

console.log(`${pad('region', 8)}${padL('tested', 8)}${padL('downhill ok', 13)}${padL('uphill ok', 12)}${padL('both ok', 10)}${padL('median drop', 13)}`);
for (const id of REGION_IDS) {
  const trails = displaySet(id).trails;
  let tested = 0;
  let down = 0;
  let up = 0;
  let both = 0;
  const drops = [];
  // Every Nth sample across the region rather than the first N trails, so the test cannot
  // be passed by one well-behaved corner of the map.
  const candidates = [];
  for (const t of trails) {
    const pts = routeSamplePoints(t, t.aspectDeg.length);
    for (let i = 0; i < t.aspectDeg.length && i < pts.length; i++) {
      if (t.aspectDeg[i] < 0 || t.slopeDeg[i] < VERIFY_SLOPE_MIN_DEG) continue;
      candidates.push({ lngLat: pts[i].lngLat, aspect: t.aspectDeg[i] });
    }
  }
  const stride = Math.max(1, Math.floor(candidates.length / VERIFY_PER_REGION));
  for (let k = 0; k < candidates.length; k += stride) {
    const c = candidates[k];
    const here = await sampleElevation(c.lngLat[0], c.lngLat[1]);
    const ahead = await sampleElevation(...offsetLonLat(c.lngLat, c.aspect, STEP_M));
    const behind = await sampleElevation(...offsetLonLat(c.lngLat, (c.aspect + 180) % 360, STEP_M));
    tested++;
    const d = ahead < here;
    const u = behind > here;
    if (d) down++;
    if (u) up++;
    if (d && u) both++;
    drops.push(here - ahead);
  }
  drops.sort((a, b) => a - b);
  console.log(
    pad(id, 8) +
      padL(tested, 8) +
      padL(`${down} (${pctOf(down, tested)})`, 13) +
      padL(`${up} (${pctOf(up, tested)})`, 12) +
      padL(`${both} (${pctOf(both, tested)})`, 10) +
      padL(`${drops[Math.floor(drops.length / 2)]?.toFixed(1)} m`, 13),
  );
}
console.log(
  `Step ${STEP_M} m, samples steeper than ${VERIFY_SLOPE_MIN_DEG}° only. A perfect score is not\n` +
    'expected: the Horn window smooths over 3 cells, so on a convex nose the smoothed\n' +
    'gradient and a single 30 m probe can legitimately disagree.',
);

// ============================================================================
// (b2) SELF-SHADING THROUGH THE DAY — the runtime half, exercised, not wired
// ============================================================================
//
// Printed so the runtime function has an audited output before anything consumes it, and
// so the limit is visible as a shape rather than as a sentence: the share peaks at the ends
// of the day and collapses at midday, which is what self-shading alone does. Real shade in
// a valley does the opposite at dawn, and this method cannot see it.

console.log('\n=== (b2) self-shading share through the day (SELF-SHADING ONLY, no cast shadows) ===\n');
const DEMO_HOURS = [7, 9, 11, 13, 15, 17, 19];
console.log(`${pad('region', 8)}${DEMO_HOURS.map((h) => padL(`${String(h).padStart(2, '0')}:00`, 8)).join('')}   sun alt at noon`);
for (const id of REGION_IDS) {
  const trails = displaySet(id).trails;
  const lat = REGIONS[id].assumedLocation[1];
  const row = DEMO_HOURS.map((h) => {
    // Solar noon is the simulation's 13:00; passed explicitly rather than imported, exactly
    // as the shading module's contract requires (it holds no solar constant of its own).
    const shares = trails
      .map((t) => selfShadedShare(t, lat, SIM_DAY_OF_YEAR, h, 13))
      .filter((v) => v !== null);
    const mean = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;
    return padL(`${Math.round(mean * 100)}%`, 8);
  }).join('');
  const noon = sunPosition(lat, SIM_DAY_OF_YEAR, 13, 13);
  console.log(pad(id, 8) + row + `   ${noon.altitudeDeg.toFixed(1)}° az ${noon.azimuthDeg.toFixed(0)}°`);
}
// One worked point, so the geometry can be checked by hand rather than trusted, and one
// derived threshold, because the table above is nearly all zeros and the reason matters.
{
  const lat = 40.31;
  console.log(`\n  worked example, a WEST-facing slope at ${lat}°N on day ${SIM_DAY_OF_YEAR} (11 July):`);
  console.log(`  ${pad('hour', 8)}${padL('sun alt', 9)}${padL('sun az', 8)}${padL('cos i at 25°', 14)}${padL('state at 25°', 14)}${padL('self-shades above', 19)}`);
  for (const h of [6, 7, 8, 9, 12, 16, 19, 20]) {
    const sun = sunPosition(lat, SIM_DAY_OF_YEAR, h, 13);
    const at25 = selfShadeAt(270, 25, sun);
    // Smallest slope, to the degree, at which this aspect turns away from this sun.
    let threshold = null;
    for (let deg = 1; deg <= 89; deg++) {
      if (selfShadeAt(270, deg, sun).state === 'self-shaded') {
        threshold = deg;
        break;
      }
    }
    console.log(
      `  ${pad(`${String(h).padStart(2, '0')}:00`, 8)}${padL(`${sun.altitudeDeg.toFixed(1)}°`, 9)}` +
        `${padL(`${sun.azimuthDeg.toFixed(0)}°`, 8)}${padL(at25.incidenceCos.toFixed(2), 14)}` +
        `${padL(at25.state, 14)}${padL(threshold === null ? '(never)' : `${threshold}°`, 19)}`,
    );
  }
  console.log(
    '\n  THE FINDING IN THAT LAST COLUMN. In midsummer at CONUS latitudes the sun spends the\n' +
      '  middle of the day so high that almost no real hillside is turned away from it: a\n' +
      '  west-facing slope needs to be near-vertical at noon and is still lit at 25° well into\n' +
      '  the evening. Self-shading is therefore a WEAK input to a summer heat term precisely\n' +
      '  when the heat term matters most. The shade a walker actually finds at 14:00 in a\n' +
      '  Colorado valley is cast by the ridge opposite and by the trees overhead — one of\n' +
      '  which this method cannot see at all, and the other of which is the canopy field.',
  );
}

// ============================================================================
// THE ISOLATED COPY
// ============================================================================

/**
 * Materialise `src/` and `scope/grade-check.mjs` under .cache/canopy-cf/<label>/ with
 * grade.ts replaced by `gradeSource`, and return the sandbox root.
 *
 * The relative layout is reproduced exactly (scope/ beside src/) because grade-check.mjs
 * imports `../src/scope/weather/...` and the derived JSON is imported as
 * `../../scope/derived/<region>.json`: a sandbox that flattened either would resolve back
 * into the real tree and quietly measure the shipped code twice.
 */
function sandbox(label, gradeSource) {
  const dest = join(SANDBOX_DIR, label);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(ROOT, 'src'), join(dest, 'src'), { recursive: true });
  mkdirSync(join(dest, 'scope'), { recursive: true });
  cpSync(join(ROOT, 'scope', 'derived'), join(dest, 'scope', 'derived'), { recursive: true });
  cpSync(join(ROOT, 'scope', 'grade-check.mjs'), join(dest, 'scope', 'grade-check.mjs'));
  writeFileSync(join(dest, GRADE_REL), gradeSource);
  return dest;
}

// ============================================================================
// (d) THE SHIPPED GRADE IS UNTOUCHED
// ============================================================================

if (process.argv[2] === 'identical') {
  const head = execFileSync('git', ['show', `HEAD:./${GRADE_REL}`], { cwd: ROOT, encoding: 'utf8' });
  const dest = sandbox('head', head);
  const run = (dir) =>
    execFileSync(process.execPath, [join(dir, 'scope', 'grade-check.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  const before = run(dest);
  const after = run(ROOT);
  const same = before === after;
  console.log('\n=== (d) grade-check.mjs against HEAD grade.ts vs the working tree ===\n');
  console.log(`  HEAD    : ${before.length} bytes`);
  console.log(`  working : ${after.length} bytes`);
  console.log(`  ${same ? 'BYTE-IDENTICAL: PASS' : '** DIFFERS: FAIL **'}`);
  if (!same) {
    const a = before.split('\n');
    const b = after.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) console.log(`  line ${i + 1}:\n    HEAD    ${a[i]}\n    working ${b[i]}`);
    }
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

// ============================================================================
// (c) WHAT THE SWAP WOULD COST
// ============================================================================
//
// The counterfactual is ONE expression. The heat factor's sun load is
//
//     (0.6 + 0.4 * terrain.exposedShare) * (1 - 0.7 * cloudMean)
//
// where `exposedShare` is the treeline proxy's "no trees here" term. Swapping it for
// `1 - canopyShare` is the whole change, and nothing else in grade.ts is touched: the
// exposure and wind terms keep reading `exposedShare`, because those are about SHELTER FROM
// CONVECTION AND WIND, which is genuinely a treeline question and not a canopy one. Trees
// do not stop a gust the way a ridge line stops being a ridge line.
//
// The heat COPY thresholds (`exposedShare > 0.5`, `> 0.4`) are deliberately left alone too.
// They choose words, not levels, so including them would have blurred a level-change count
// with a wording-change count.

const CF_FIND = 'const sunLoad = (0.6 + 0.4 * terrain.exposedShare) * (1 - 0.7 * cloudMean);';
const CF_REPLACE =
  '// COUNTERFACTUAL (scope/canopy-check.mjs): real canopy in place of the treeline proxy.\n' +
  '  const cfCanopy = Number.isFinite(terrain.canopyShare) ? 1 - terrain.canopyShare : terrain.exposedShare;\n' +
  '  const sunLoad = (0.6 + 0.4 * cfCanopy) * (1 - 0.7 * cloudMean);';

const shipped = readFileSync(join(ROOT, GRADE_REL), 'utf8');
if (!shipped.includes(CF_FIND)) {
  console.error(
    `\n** the heat sun-load line has moved. canopy-check cannot build its counterfactual.\n` +
      `   looked for: ${CF_FIND}\n   Update CF_FIND in scope/canopy-check.mjs and re-read the delta. **`,
  );
  process.exit(1);
}
const cfRoot = sandbox('canopy-heat', shipped.replace(CF_FIND, CF_REPLACE));
const cf = await import(join(cfRoot, GRADE_REL));

console.log('\n=== (c) grade delta if the heat term read real canopy ===\n');

const ORDER = { prime: 0, mixed: 1, poor: 2 };
const totals = { compared: 0, changed: 0, better: 0, worse: 0 };

console.log(
  `${pad('region', 8)}${pad('scenario', 11)}${padL('day', 5)}${padL('trails', 8)}${padL('changed', 9)}` +
    `${padL('better', 8)}${padL('worse', 7)}  worst-case example`,
);
// Weather is fetched once per scenario per trail and every day is graded off it, exactly as
// scope/grade-check.mjs and the page both do. Both grade.ts copies are handed the SAME
// `WeatherResult` object, so any difference between them is the one patched expression and
// nothing else.
const WEATHER = new Map();
async function weatherFor(provider, trail) {
  const key = `${provider.id}|${trail.id}`;
  const hit = WEATHER.get(key);
  if (hit) return hit;
  const made = await fetchRouteWeather(provider, trail, Math.max(...DAYS));
  WEATHER.set(key, made);
  return made;
}

for (const id of REGION_IDS) {
  const region = REGIONS[id];
  const trails = displaySet(id).trails;
  for (const scenario of SCENARIO_LIST) {
    const provider = simulatedProvider(scenario.id, id);
    for (const t of trails) await weatherFor(provider, t);
    for (const day of DAYS) {
      let changed = 0;
      let better = 0;
      let worse = 0;
      let example = '';
      let exampleGap = 0;
      for (const t of trails) {
        const weather = await weatherFor(provider, t);
        const a = gradeTrail(t, region, weather, day, provider);
        const b = cf.gradeTrail(t, region, weather, day, provider);
        totals.compared++;
        if (a.level === b.level) continue;
        changed++;
        totals.changed++;
        const d = ORDER[b.level] - ORDER[a.level];
        if (d < 0) {
          better++;
          totals.better++;
        } else {
          worse++;
          totals.worse++;
        }
        const gap = Math.abs(terrainFacts(t, region).shadedShare - t.canopyShare);
        if (gap >= exampleGap) {
          exampleGap = gap;
          example = `${t.name} ${a.level}→${b.level} (proxy shade ${Math.round(terrainFacts(t, region).shadedShare * 100)}%, canopy ${Math.round(t.canopyShare * 100)}%)`;
        }
      }
      if (changed === 0) continue;
      console.log(
        pad(id, 8) +
          pad(scenario.id, 11) +
          padL(day, 5) +
          padL(trails.length, 8) +
          padL(`${changed} (${pctOf(changed, trails.length)})`, 9) +
          padL(better, 8) +
          padL(worse, 7) +
          `  ${example}`,
      );
    }
  }
}
console.log(
  `\n  ${totals.compared} trail x scenario x day grades compared.\n` +
    `  ${totals.changed} changed level (${pctOf(totals.changed, totals.compared)}): ` +
    `${totals.better} improved, ${totals.worse} degraded.\n` +
    '  Rows with zero changes are omitted. Days past the +36 h horizon carry no terrain\n' +
    '  term at all (outlookGrade), so they cannot move and are structurally zero.',
);

// The other place the proxy is user-visible: the Shaded condition chip is `shadedShare >=
// 0.75`. It is not part of the grade and is reported separately, because swapping the proxy
// changes which trails a reader can filter to even on a day whose grade does not move.
console.log('\n--- the "Shaded" filter chip, if it read real canopy instead ---');
console.log(`${pad('region', 8)}${padL('shown', 7)}${padL('proxy passes', 14)}${padL('canopy passes', 15)}${padL('gained', 8)}${padL('lost', 7)}`);
for (const id of REGION_IDS) {
  const region = REGIONS[id];
  const trails = displaySet(id).trails;
  let proxy = 0;
  let canopy = 0;
  let gained = 0;
  let lost = 0;
  for (const t of trails) {
    const p = shadedEnough(t, region);
    const c = t.canopyShare >= 0.75;
    if (p) proxy++;
    if (c) canopy++;
    if (!p && c) gained++;
    if (p && !c) lost++;
  }
  console.log(
    pad(id, 8) +
      padL(trails.length, 7) +
      padL(`${proxy} (${pctOf(proxy, trails.length)})`, 14) +
      padL(`${canopy} (${pctOf(canopy, trails.length)})`, 15) +
      padL(gained, 8) +
      padL(lost, 7),
  );
}

console.log(
  '\nNOTHING ABOVE HAS BEEN APPLIED. grade.ts computes exactly what it computed before;\n' +
    'run `node scope/canopy-check.mjs identical` for the proof.',
);
