import {
  CYCLE_SECONDS,
  tideAt,
  isSubmerged,
  eventsFor,
  feedRate,
  growth,
  ringFloor,
  applyCost,
  resolve,
} from './tide.mjs';

const NS_KEY = 'hdfst_v1';
const dev = new URLSearchParams(location.search).get('dev') === '1';

// ---------------------------------------------------------------- storage --

function loadSave() {
  try {
    const raw = localStorage.getItem(NS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeSave(data) {
  try {
    localStorage.setItem(NS_KEY, JSON.stringify(data));
  } catch (e) {
    /* storage unavailable — silently continue, nothing persists this life */
  }
}

function recordRun(rings, storms) {
  const prev = loadSave() || { bestRings: 0, rockHistory: [] };
  const bestRings = Math.max(prev.bestRings || 0, rings);
  const rockHistory = [...(prev.rockHistory || []), { rings, storms }].slice(-5);
  const data = { bestRings, rockHistory };
  writeSave(data);
  return data;
}

// ------------------------------------------------------------- share text --

function shareText(rings, storms) {
  const url = `${location.origin}${location.pathname}`.replace(/\/$/, '') || 'http://holdfast.defimagic.io';
  return `HOLDFAST · ${rings} rings · outlived ${storms} storms · ${url}`;
}

// ------------------------------------------------------------------ state --

function freshState() {
  const seed = ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0) || 1;
  return {
    seed,
    elapsed: 0,
    lastRafNow: null,
    running: false,
    alive: true,
    open: false,
    fed: 0,
    rings: 0,
    tide: 0,
    stormsOutlived: 0,
    lastCycleIndex: -1,
    pendingEvents: [],
    activeTelegraphs: [],
    flashes: [],
  };
}

let state = freshState();

// -------------------------------------------------------------- WebAudio --

let audioCtx = null;
function ensureAudio() {
  if (audioCtx) return audioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  } catch (e) {
    audioCtx = null;
  }
  return audioCtx;
}

function tone({ freq = 440, dur = 0.15, type = 'sine', gain = 0.08, sweepTo = null, delay = 0 }) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweepTo != null) osc.frequency.linearRampToValueAtTime(sweepTo, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function sfxOpen() {
  tone({ freq: 260, sweepTo: 340, dur: 0.12, type: 'triangle', gain: 0.07 });
}
function sfxClose() {
  tone({ freq: 340, sweepTo: 180, dur: 0.1, type: 'triangle', gain: 0.09 });
}
function sfxTelegraph(type) {
  if (type === 'gull') tone({ freq: 900, sweepTo: 1300, dur: 0.35, type: 'sine', gain: 0.03 });
  else if (type === 'crab') {
    tone({ freq: 500, dur: 0.05, type: 'square', gain: 0.03 });
    tone({ freq: 500, dur: 0.05, type: 'square', gain: 0.03, delay: 0.12 });
  } else if (type === 'wave') tone({ freq: 90, sweepTo: 60, dur: 0.8, type: 'sawtooth', gain: 0.025 });
}
function sfxStrike(type, survived) {
  if (!survived) {
    tone({ freq: 220, sweepTo: 40, dur: 0.6, type: 'sawtooth', gain: 0.1 });
    return;
  }
  if (type === 'gull') tone({ freq: 700, sweepTo: 300, dur: 0.15, type: 'sine', gain: 0.06 });
  else if (type === 'crab') tone({ freq: 400, sweepTo: 200, dur: 0.12, type: 'square', gain: 0.06 });
  else if (type === 'wave') tone({ freq: 150, dur: 0.3, type: 'sine', gain: 0.05 });
}

// -------------------------------------------------------------------- DOM --

const screens = {
  title: document.getElementById('screen-title'),
  howto: document.getElementById('screen-howto'),
  play: document.getElementById('screen-play'),
  end: document.getElementById('screen-end'),
};

function showScreen(name) {
  for (const k in screens) screens[k].classList.toggle('active', k === name);
}

const hudRings = document.getElementById('hud-rings');
const hudStorms = document.getElementById('hud-storms');
const openFlag = document.getElementById('open-flag');
const hint = document.getElementById('hint');
const rockMemory = document.getElementById('rock-memory');
const canvas = document.getElementById('c');
const ctx2d = canvas.getContext('2d');

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);

// title screen memory line
(function paintMemory() {
  const save = loadSave();
  if (save && save.rockHistory && save.rockHistory.length) {
    const last = save.rockHistory[save.rockHistory.length - 1];
    rockMemory.style.display = '';
    rockMemory.textContent = `The last one to sit here left ${last.rings} ring${last.rings === 1 ? '' : 's'} on the rock.`;
  }
})();

// ---------------------------------------------------------------- input --

function setOpen(v) {
  if (state.alive === false) return;
  if (state.open === v) return;
  state.open = v;
  openFlag.classList.toggle('show', v);
  if (v) sfxOpen();
  else sfxClose();
}

let holding = false;
function pointerDown(e) {
  if (e.cancelable) e.preventDefault();
  ensureAudio();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  holding = true;
  hint.style.opacity = '0';
  setOpen(true);
}
function pointerUp() {
  if (!holding) return;
  holding = false;
  setOpen(false);
}

const stage = document.getElementById('stage');
stage.addEventListener('pointerdown', pointerDown);
window.addEventListener('pointerup', pointerUp);
window.addEventListener('pointercancel', pointerUp);
window.addEventListener('blur', pointerUp);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pointerUp();
});

window.addEventListener('keydown', (e) => {
  if (screens.play.classList.contains('active') && (e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
    e.preventDefault();
    pointerDown(e);
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'Enter') pointerUp();
});

// ------------------------------------------------------------- game loop --

function startGame() {
  state = freshState();
  state.running = true;
  showScreen('play');
  resizeCanvas();
  hint.style.opacity = '1';
  hudRings.textContent = '0';
  hudStorms.textContent = '0';
  requestAnimationFrame(tick);
}

function endGame() {
  state.alive = false;
  state.running = false;
  setOpen(false);
  const saved = recordRun(state.rings, state.stormsOutlived);
  document.getElementById('end-rings').textContent = String(state.rings);
  document.getElementById('end-storms').textContent = String(state.stormsOutlived);
  const legacy = document.getElementById('legacy-line');
  if (saved.bestRings > state.rings) {
    legacy.textContent = `Your best on this rock is still ${saved.bestRings} rings.`;
  } else if (saved.rockHistory.length > 1) {
    legacy.textContent = `A new best for this rock: ${saved.bestRings} rings.`;
  } else {
    legacy.textContent = `Your rings stay on the rock for the next one.`;
  }
  document.getElementById('share-text').textContent = shareText(state.rings, state.stormsOutlived);
  showScreen('end');
}

function step(rafNow) {
  if (state.lastRafNow == null) state.lastRafNow = rafNow;
  let dt = (rafNow - state.lastRafNow) / 1000;
  state.lastRafNow = rafNow;
  if (!(dt >= 0)) dt = 0;
  if (dt > 0.5) dt = 0.5; // clamp huge jumps (backgrounded tab regaining focus)
  if (!state.alive) return;

  state.elapsed += dt;
  const t = state.elapsed;
  const tide = tideAt(t, state.seed);
  state.tide = tide;

  const cycleIndex = Math.floor(t / CYCLE_SECONDS);
  if (cycleIndex !== state.lastCycleIndex) {
    state.lastCycleIndex = cycleIndex;
    state.pendingEvents.push(...eventsFor(cycleIndex, state.seed));
  }

  const rate = feedRate(state.open, tide);
  state.fed += rate * dt;

  for (const ev of state.pendingEvents) {
    if (!ev.telegraphed && t >= ev.telegraphAt) {
      ev.telegraphed = true;
      state.activeTelegraphs.push(ev);
      sfxTelegraph(ev.type);
    }
    if (!ev.resolved && t >= ev.strikeAt) {
      ev.resolved = true;
      const r = resolve(state.open, ev);
      state.fed = applyCost(state.fed, r.cost);
      if (ev.type === 'wave' && r.survived) state.stormsOutlived++;
      sfxStrike(ev.type, r.survived);
      state.flashes.push({ t, danger: !r.survived || r.cost > 0, x: 0.5, y: 0.55 });
      state.activeTelegraphs = state.activeTelegraphs.filter((e) => e !== ev);
      if (!r.survived) {
        state.rings = growth(state.fed);
        render(t);
        endGame();
        return;
      }
    }
  }

  state.pendingEvents = state.pendingEvents.filter((e) => !e.resolved || t - e.strikeAt < 4);
  state.flashes = state.flashes.filter((f) => t - f.t < 0.6);

  const newRings = growth(state.fed);
  if (newRings !== state.rings) {
    state.rings = newRings;
    hudRings.textContent = String(state.rings);
  }
  hudStorms.textContent = String(state.stormsOutlived);

  render(t);
}

function tick(rafNow) {
  step(rafNow);
  if (state.running) requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ draw --

function render(t) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  ctx2d.clearRect(0, 0, w, h);

  const skyTop = '#0b171b';
  const skyBottom = '#173038';
  const sky = ctx2d.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, skyTop);
  sky.addColorStop(1, skyBottom);
  ctx2d.fillStyle = sky;
  ctx2d.fillRect(0, 0, w, h);

  const rockTopY = h * 0.62;
  const waterY = rockTopY - state.tide * h * 0.38 + Math.sin(t * 1.3) * 2;

  // rock
  ctx2d.fillStyle = '#3a4750';
  ctx2d.beginPath();
  ctx2d.moveTo(0, h);
  ctx2d.lineTo(0, rockTopY + 30);
  ctx2d.quadraticCurveTo(w * 0.5, rockTopY - 10, w, rockTopY + 30);
  ctx2d.lineTo(w, h);
  ctx2d.closePath();
  ctx2d.fill();

  // barnacle (fixed point, never moves)
  const bx = w * 0.5;
  const by = rockTopY - 4;
  const baseR = 12 + Math.min(state.rings, 24) * 1.7;

  ctx2d.strokeStyle = 'rgba(231,200,138,0.55)';
  ctx2d.lineWidth = 1.4;
  const ringCount = Math.min(state.rings, 24);
  for (let i = 0; i < ringCount; i++) {
    const r = 6 + i * 1.7;
    ctx2d.beginPath();
    ctx2d.arc(bx, by, r, Math.PI, 0);
    ctx2d.stroke();
  }

  ctx2d.fillStyle = '#c7b28a';
  ctx2d.beginPath();
  ctx2d.arc(bx, by, baseR, Math.PI, 0);
  ctx2d.closePath();
  ctx2d.fill();

  if (state.open && isSubmerged(state.tide)) {
    ctx2d.strokeStyle = 'rgba(167,236,224,0.85)';
    ctx2d.lineWidth = 1.5;
    for (let i = -2; i <= 2; i++) {
      const cx = bx + i * (baseR * 0.28);
      ctx2d.beginPath();
      ctx2d.moveTo(cx, by - baseR * 0.6);
      ctx2d.quadraticCurveTo(cx + Math.sin(t * 4 + i) * 4, by - baseR * 1.15, cx + Math.sin(t * 4 + i) * 6, by - baseR * 1.5);
      ctx2d.stroke();
    }
  } else {
    ctx2d.strokeStyle = 'rgba(11,23,27,0.5)';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(bx - baseR * 0.5, by - 1);
    ctx2d.lineTo(bx + baseR * 0.5, by - 1);
    ctx2d.stroke();
  }

  // telegraphs
  for (const ev of state.activeTelegraphs) {
    const frac = Math.min(1, Math.max(0, (t - ev.telegraphAt) / (ev.strikeAt - ev.telegraphAt)));
    const pulse = 0.4 + 0.4 * Math.sin(t * 12);
    if (ev.type === 'gull') {
      ctx2d.fillStyle = `rgba(10,10,10,${0.15 + 0.15 * pulse})`;
      const gx = w * (0.15 + 0.7 * frac);
      ctx2d.beginPath();
      ctx2d.ellipse(gx, by - 40, 26, 10, 0, 0, Math.PI * 2);
      ctx2d.fill();
    } else if (ev.type === 'crab') {
      ctx2d.strokeStyle = `rgba(167,236,224,${0.25 + 0.25 * pulse})`;
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.arc(bx + (w * 0.28), by + 6, 14 + frac * 20, 0, Math.PI * 2);
      ctx2d.stroke();
    } else if (ev.type === 'wave') {
      ctx2d.fillStyle = `rgba(95,201,189,${0.12 + 0.12 * pulse})`;
      ctx2d.fillRect(0, waterY - 10 - frac * 30, w, 40 + frac * 30);
    }
  }

  // water overlay
  ctx2d.fillStyle = 'rgba(44,110,107,0.35)';
  ctx2d.fillRect(0, waterY, w, h - waterY);
  ctx2d.fillStyle = 'rgba(167,236,224,0.5)';
  ctx2d.fillRect(0, waterY, w, 2);

  // flashes
  for (const f of state.flashes) {
    const age = t - f.t;
    const alpha = Math.max(0, 0.5 - age * 0.9);
    ctx2d.fillStyle = f.danger ? `rgba(226,118,95,${alpha})` : `rgba(167,236,224,${alpha})`;
    ctx2d.beginPath();
    ctx2d.arc(bx, by, baseR + age * 60, 0, Math.PI * 2);
    ctx2d.strokeStyle = ctx2d.fillStyle;
    ctx2d.lineWidth = 2;
    ctx2d.stroke();
  }
}

// -------------------------------------------------------------- buttons --

document.getElementById('btn-play').addEventListener('click', startGame);
document.getElementById('btn-howto').addEventListener('click', () => showScreen('howto'));
document.getElementById('btn-howto-play').addEventListener('click', startGame);
document.getElementById('btn-howto-back').addEventListener('click', () => showScreen('title'));
document.getElementById('btn-restart').addEventListener('click', startGame);
document.getElementById('btn-copy').addEventListener('click', async () => {
  const text = document.getElementById('share-text').textContent;
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('btn-copy');
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = original), 1200);
  } catch (e) {
    /* clipboard unavailable — the text is already visible on screen */
  }
});

// ---------------------------------------------------------- dev hook ------

if (dev) {
  window.__g = {
    get state() {
      return state;
    },
    start: startGame,
    restart: startGame,
    open: () => setOpen(true),
    close: () => setOpen(false),
    showScreen,
    step,
    advance(seconds, dtStep = 0.1) {
      let base = state.lastRafNow == null ? 0 : state.lastRafNow;
      const stepsN = Math.round(seconds / dtStep);
      for (let i = 0; i < stepsN; i++) {
        base += dtStep * 1000;
        step(base);
      }
    },
    shareText: () => shareText(state.rings, state.stormsOutlived),
  };
}
