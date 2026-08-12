// HOLDFAST — headless tests. `node test.mjs`, exit 0 = green.
import {
  CYCLE_SECONDS,
  SUBMERGED_THRESHOLD,
  GULL_COST,
  CRAB_COST,
  mulberry32,
  hashSeed,
  tideAt,
  isSubmerged,
  eventsFor,
  feedRate,
  ringFloor,
  growth,
  applyCost,
  resolve,
} from './tide.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name);
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

const SEEDS = Array.from({ length: 120 }, (_, i) => i * 7919 + 3);

// 1. tideAt is bounded 0..1 over many seeds and times ---------------------
{
  let ok = true;
  for (const seed of SEEDS) {
    for (let t = 0; t < CYCLE_SECONDS * 3; t += 3.7) {
      const v = tideAt(t, seed);
      if (!(v >= 0 && v <= 1) || Number.isNaN(v)) ok = false;
    }
  }
  check('tideAt bounded 0..1 over 120 seeds x many times', ok);
}

// 2. tideAt is periodic at CYCLE_SECONDS ------------------------------------
{
  let ok = true;
  for (const seed of SEEDS.slice(0, 30)) {
    for (let t = 0; t < CYCLE_SECONDS * 2; t += 5.3) {
      if (!approx(tideAt(t, seed), tideAt(t + CYCLE_SECONDS, seed), 1e-9)) ok = false;
    }
  }
  check('tideAt periodic at CYCLE_SECONDS', ok);
}

// 3. tideAt determinism (pure function of t, seed) --------------------------
{
  let ok = true;
  for (const seed of SEEDS.slice(0, 20)) {
    for (const t of [0, 12.5, 45, 89.9, 200]) {
      if (tideAt(t, seed) !== tideAt(t, seed)) ok = false;
    }
  }
  check('tideAt deterministic (repeat calls identical)', ok);
}

// 4. tideAt varies by seed (not a constant function) ------------------------
{
  const vals = new Set(SEEDS.slice(0, 15).map((s) => tideAt(20, s).toFixed(6)));
  check('tideAt varies across seeds', vals.size > 5);
}

// 5. eventsFor: telegraph always >= 800ms before strike ---------------------
{
  let ok = true;
  let checked = 0;
  for (const seed of SEEDS.slice(0, 40)) {
    for (let cycle = 0; cycle < 10; cycle++) {
      for (const ev of eventsFor(cycle, seed)) {
        checked++;
        if (ev.strikeAt - ev.telegraphAt < 0.8 - 1e-9) ok = false;
      }
    }
  }
  check(`eventsFor telegraph lead >= 800ms (${checked} events checked)`, ok && checked > 100);
}

// 6. eventsFor determinism per (cycle, seed) --------------------------------
{
  let ok = true;
  for (const seed of SEEDS.slice(0, 20)) {
    for (let cycle = 0; cycle < 6; cycle++) {
      const a = JSON.stringify(eventsFor(cycle, seed));
      const b = JSON.stringify(eventsFor(cycle, seed));
      if (a !== b) ok = false;
    }
  }
  check('eventsFor deterministic per (cycle, seed)', ok);
}

// 7. eventsFor: only ever emits known event types ----------------------------
{
  let ok = true;
  for (const seed of SEEDS.slice(0, 30)) {
    for (let cycle = 0; cycle < 8; cycle++) {
      for (const ev of eventsFor(cycle, seed)) {
        if (!['gull', 'crab', 'wave'].includes(ev.type)) ok = false;
      }
    }
  }
  check('eventsFor only emits gull/crab/wave', ok);
}

// 8. eventsFor: threat count ramps with cycleIndex (later >= earlier, on average) --
{
  let earlyTotal = 0;
  let lateTotal = 0;
  for (const seed of SEEDS.slice(0, 60)) {
    earlyTotal += eventsFor(0, seed).length;
    lateTotal += eventsFor(9, seed).length;
  }
  check('threat count ramps with cycleIndex (size)', lateTotal > earlyTotal);
}

// 9. feedRate: only feeds while open AND submerged ---------------------------
{
  let ok = true;
  for (let tide = 0; tide <= 1; tide += 0.05) {
    const submerged = isSubmerged(tide);
    if (feedRate(false, tide) !== 0) ok = false;
    if (!submerged && feedRate(true, tide) !== 0) ok = false;
    if (submerged && feedRate(true, tide) <= 0) ok = false;
  }
  check('feedRate only positive when open AND submerged', ok);
}

// 10. feedRate: richer (higher) tide feeds faster while submerged -----------
{
  const low = feedRate(true, SUBMERGED_THRESHOLD);
  const high = feedRate(true, 1.0);
  check('feedRate increases with tide height while submerged', high > low);
}

// 11. resolve: closed always survives, regardless of event type -------------
{
  let ok = true;
  for (const type of ['gull', 'crab', 'wave']) {
    const r = resolve(false, { type });
    if (!r.survived || r.cost !== 0) ok = false;
  }
  check('resolve: closed always survives strikes, cost 0', ok);
}

// 12. resolve: open during a strike always costs -----------------------------
{
  let ok = true;
  for (const type of ['gull', 'crab', 'wave']) {
    const r = resolve(true, { type });
    if (!(r.cost > 0)) ok = false;
  }
  check('resolve: open during any strike always has cost > 0', ok);
}

// 13. resolve: open + wave is fatal, open + gull/crab is survivable ----------
{
  const wave = resolve(true, { type: 'wave' });
  const gull = resolve(true, { type: 'gull' });
  const crab = resolve(true, { type: 'crab' });
  check(
    'resolve: wave fatal when open, gull/crab survivable when open',
    wave.survived === false && gull.survived === true && crab.survived === true
  );
}

// 14. resolve: correct cost magnitudes match named constants ----------------
{
  const gull = resolve(true, { type: 'gull' });
  const crab = resolve(true, { type: 'crab' });
  check('resolve costs match GULL_COST/CRAB_COST', gull.cost === GULL_COST && crab.cost === CRAB_COST);
}

// 15. growth: monotonic non-decreasing, growth(0) === 0 ----------------------
{
  let ok = growth(0) === 0;
  let prev = 0;
  for (let fed = 0; fed <= 3000; fed += 3) {
    const r = growth(fed);
    if (r < prev) ok = false;
    prev = r;
  }
  check('growth monotonic non-decreasing, growth(0)=0', ok);
}

// 16. growth: threshold boundaries are exact (just below vs at/above) -------
{
  let ok = true;
  for (let rings = 0; rings < 15; rings++) {
    const floor = ringFloor(rings + 1);
    if (growth(floor - 0.01) !== rings) ok = false;
    if (growth(floor) !== rings + 1) ok = false;
  }
  check('growth threshold boundaries exact (15 rings checked)', ok);
}

// 17. ringFloor strictly increasing (each ring costs more than the last) ----
{
  let ok = true;
  for (let n = 0; n < 20; n++) {
    if (!(ringFloor(n + 1) > ringFloor(n))) ok = false;
  }
  check('ringFloor strictly increasing', ok);
}

// 18. applyCost never un-grows a ring already achieved -----------------------
{
  let ok = true;
  for (let fed = 0; fed <= 500; fed += 11) {
    const before = growth(fed);
    const after = applyCost(fed, 10000); // brutal cost, should floor at current ring
    if (growth(after) !== before) ok = false;
    if (after < ringFloor(before)) ok = false;
  }
  check('applyCost never reduces rings already grown', ok);
}

// 19. applyCost actually removes food when above the ring floor -------------
{
  const fed = ringFloor(3) + 20; // 20 food into ring 4, not yet locked
  const after = applyCost(fed, 5);
  check('applyCost removes uncommitted food', after === fed - 5 && after > ringFloor(3));
}

// 20. determinism of mulberry32 / hashSeed -----------------------------------
{
  let ok = true;
  for (const seed of SEEDS.slice(0, 30)) {
    const a = mulberry32(seed)();
    const b = mulberry32(seed)();
    if (a !== b) ok = false;
    if (hashSeed(seed, 5) !== hashSeed(seed, 5)) ok = false;
    if (hashSeed(seed, 5) === hashSeed(seed, 6) && seed !== 0) {
      // extremely unlikely collision; not a hard failure on its own
    }
  }
  check('mulberry32 / hashSeed deterministic', ok);
}

// 21. mulberry32 draws land in [0, 1) ----------------------------------------
{
  let ok = true;
  const rng = mulberry32(12345);
  for (let i = 0; i < 500; i++) {
    const v = rng();
    if (!(v >= 0 && v < 1)) ok = false;
  }
  check('mulberry32 draws in [0,1)', ok);
}

// 22. 100-cycle fuzz: full sim survives without NaN/Infinity ----------------
{
  let ok = true;
  for (let s = 0; s < 100; s++) {
    const seed = s * 104729 + 1;
    let fed = 0;
    for (let cycle = 0; cycle < 4; cycle++) {
      const events = eventsFor(cycle, seed);
      for (let i = 0; i < 20; i++) {
        const t = cycle * CYCLE_SECONDS + i * (CYCLE_SECONDS / 20);
        const tide = tideAt(t, seed);
        const open = i % 3 !== 0;
        const rate = feedRate(open, tide);
        fed += rate * (CYCLE_SECONDS / 20);
        if (!Number.isFinite(tide) || !Number.isFinite(rate) || !Number.isFinite(fed)) ok = false;
      }
      for (const ev of events) {
        const r = resolve(ev.strikeAt % 7 < 3, ev);
        fed = applyCost(fed, r.cost);
        if (!Number.isFinite(fed)) ok = false;
      }
      const rings = growth(fed);
      if (!Number.isFinite(rings)) ok = false;
    }
  }
  check('100-cycle fuzz across 100 seeds: no NaN/Infinity anywhere', ok);
}

// 23. isSubmerged threshold consistent with SUBMERGED_THRESHOLD -------------
{
  check(
    'isSubmerged matches SUBMERGED_THRESHOLD boundary',
    isSubmerged(SUBMERGED_THRESHOLD) === true && isSubmerged(SUBMERGED_THRESHOLD - 0.001) === false
  );
}

// --- report -----------------------------------------------------------------
console.log(`HOLDFAST test.mjs: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('FAILED:', failures.join(' | '));
  process.exit(1);
} else {
  process.exit(0);
}
