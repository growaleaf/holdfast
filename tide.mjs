// HOLDFAST — pure core. No DOM, no WebAudio, no Date.now(), no Math.random().
// Every function here is deterministic: same arguments, same result, forever.

export const CYCLE_SECONDS = 90;           // one full low-high-low tide cycle
export const SUBMERGED_THRESHOLD = 0.45;   // tide >= this = water covers the rock

export const GULL_COST = 15;    // food lost to a peck if you're open when it stabs
export const CRAB_COST = 25;    // food lost to a pinch if you're open when it prowls

export const RING_BASE = 30;    // food needed for ring 1
export const RING_STEP = 6;     // each subsequent ring costs this much more than the last

const MIN_TELEGRAPH_LEAD = 0.8; // seconds — never less warning than this
const MAX_TELEGRAPH_LEAD = 2.0;

// --- deterministic PRNG (mulberry32) ---------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Combine a base seed with an integer index into a new deterministic seed.
export function hashSeed(seed, n) {
  let h = (seed ^ Math.imul(n | 0, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return h >>> 0;
}

function seedPhase(seed) {
  const draw = mulberry32(seed)();
  return draw * Math.PI * 2;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// --- tide -------------------------------------------------------------------

// tideAt(t, seed) -> 0 (fully exposed/dry) .. 1 (fully submerged)
// A mixed semidiurnal curve: a primary swing plus a smaller second harmonic
// (real tides aren't a clean sine — two highs a "day", unequal in height).
// The harmonic's frequency is an exact multiple of the primary's, so the
// whole thing stays periodic at CYCLE_SECONDS.
export function tideAt(t, seed) {
  const phase = seedPhase(seed >>> 0);
  const w = (t / CYCLE_SECONDS) * Math.PI * 2;
  const primary = Math.sin(w + phase);
  const harmonic = 0.15 * Math.sin(2 * w + phase * 1.7);
  const raw = primary + harmonic; // range approx [-1.15, 1.15]
  return clamp01((raw + 1.15) / 2.3);
}

export function isSubmerged(tide) {
  return tide >= SUBMERGED_THRESHOLD;
}

// --- threats ------------------------------------------------------------

// eventsFor(cycleIndex, seed) -> [{ type, cycleIndex, telegraphAt, strikeAt }]
// Absolute times (seconds from game start). Type is chosen from the local
// tide state at the moment of the strike: gulls stab when exposed, waves
// slam at high water, crabs prowl the water's edge in between. Threat
// count ramps with cycleIndex (the longer you've held on, the busier the
// rock gets).
export function eventsFor(cycleIndex, seed) {
  const rng = mulberry32(hashSeed(seed, cycleIndex));
  const base = 1 + Math.min(2, Math.floor(cycleIndex / 3));
  const count = base + (rng() < 0.35 ? 1 : 0);
  const events = [];
  const cycleStart = cycleIndex * CYCLE_SECONDS;

  for (let i = 0; i < count; i++) {
    const localOffset = 2 + rng() * (CYCLE_SECONDS - 4); // keep clear of edges
    const strikeAt = cycleStart + localOffset;
    const tide = tideAt(strikeAt, seed);
    let type;
    if (tide < 0.35) type = 'gull';
    else if (tide > 0.65) type = 'wave';
    else type = 'crab';
    const lead = MIN_TELEGRAPH_LEAD + rng() * (MAX_TELEGRAPH_LEAD - MIN_TELEGRAPH_LEAD);
    events.push({
      type,
      cycleIndex,
      strikeAt,
      telegraphAt: strikeAt - lead,
    });
  }

  events.sort((a, b) => a.strikeAt - b.strikeAt);
  return events;
}

// feedRate(open, tide) -> food per second. Only feeds while open AND submerged;
// richer water (higher tide) carries more plankton.
export function feedRate(open, tide) {
  if (!open) return 0;
  if (!isSubmerged(tide)) return 0;
  const FEED_BASE = 6;
  return FEED_BASE * (0.5 + 0.5 * tide);
}

// --- growth ---------------------------------------------------------------

// Cumulative food needed to have grown exactly `n` rings (n >= 0).
export function ringFloor(rings) {
  let total = 0;
  let cost = RING_BASE;
  for (let i = 0; i < rings; i++) {
    total += cost;
    cost += RING_STEP;
  }
  return total;
}

// growth(fed) -> ring count reached by this much lifetime food.
export function growth(fed) {
  let rings = 0;
  let threshold = 0;
  let cost = RING_BASE;
  while (fed >= threshold + cost) {
    threshold += cost;
    rings++;
    cost += RING_STEP;
  }
  return rings;
}

// A gull peck or crab pinch can eat into food not yet calcified into a ring,
// but never un-grows a ring you already have — the shell is permanent.
export function applyCost(fed, cost) {
  const floor = ringFloor(growth(fed));
  return Math.max(floor, fed - cost);
}

// --- resolving a strike -----------------------------------------------------

// resolve(open, event) -> { survived, cost }
// Closed is always safe (the whole point of the verb): survived true, cost 0.
// Open always costs something when a strike lands: a wave open is fatal,
// a gull or crab open costs food but you live.
export function resolve(open, event) {
  if (!open) return { survived: true, cost: 0 };
  if (event.type === 'wave') return { survived: false, cost: 1 };
  if (event.type === 'gull') return { survived: true, cost: GULL_COST };
  if (event.type === 'crab') return { survived: true, cost: CRAB_COST };
  return { survived: true, cost: 0 };
}
