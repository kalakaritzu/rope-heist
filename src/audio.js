// Sound effects, synthesised in the browser with WebAudio: no audio files to download.
// `observe()` watches what the renderer is about to draw and plays a sound whenever something happens.
import { levelById } from './sim.js';

const KEY = 'rope-heist-muted';
let ctx = null;
let master = null;
let muted = false;
try { muted = localStorage.getItem(KEY) === '1'; } catch { /* storage unavailable: fine */ }

/** Browsers only allow sound after a click or key press, so this is called from the first one. */
export function initAudio() {
  if (!ctx) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.7;
      master.connect(ctx.destination);
    } catch { ctx = null; return; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.7;
  try { localStorage.setItem(KEY, m ? '1' : '0'); } catch { /* fine */ }
}

/** One shaped beep. slideTo bends the pitch over its life, delay is in seconds. */
function tone(freq, dur, { type = 'sine', gain = 0.2, slideTo = null, delay = 0 } = {}) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

let noiseBuffer = null;
/** A short burst of filtered noise: footsteps, thuds, rope sounds. */
function noise(dur, { gain = 0.15, freq = 800, q = 1, delay = 0 } = {}) {
  if (!ctx || muted) return;
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + dur + 0.02);
}

export const sfx = {
  step: (vol = 1) => noise(0.07, { gain: 0.09 * vol, freq: 420 + Math.random() * 160, q: 0.8 }),
  grab: () => { tone(300, 0.07, { type: 'square', gain: 0.07, slideTo: 460 }); noise(0.05, { gain: 0.06, freq: 1800 }); },
  drop: () => { noise(0.12, { gain: 0.12, freq: 180, q: 0.6 }); tone(110, 0.1, { gain: 0.1, slideTo: 70 }); },
  knot: () => { noise(0.1, { gain: 0.1, freq: 1200, q: 2 }); tone(190, 0.12, { type: 'triangle', gain: 0.14, slideTo: 120 }); },
  unknot: () => { tone(260, 0.1, { type: 'triangle', gain: 0.1, slideTo: 380 }); noise(0.08, { gain: 0.07, freq: 1500 }); },
  spotted: () => { tone(520, 0.1, { type: 'square', gain: 0.1 }); tone(780, 0.16, { type: 'square', gain: 0.1, delay: 0.1 }); },
  zap: () => { noise(0.25, { gain: 0.22, freq: 2600, q: 0.7 }); tone(900, 0.22, { type: 'sawtooth', gain: 0.12, slideTo: 140 }); },
  siren: (high) => tone(high ? 880 : 620, 0.3, { type: 'square', gain: 0.07 }),
  tick: () => tone(1000, 0.05, { type: 'square', gain: 0.05 }),
  pop: () => { tone(500, 0.08, { gain: 0.14, slideTo: 900 }); },
  oink: () => { tone(260, 0.14, { type: 'sawtooth', gain: 0.07, slideTo: 170 }); tone(240, 0.12, { type: 'sawtooth', gain: 0.06, slideTo: 150, delay: 0.14 }); },
  shove: () => { noise(0.14, { gain: 0.18, freq: 250 }); tone(130, 0.14, { gain: 0.14, slideTo: 60 }); },
  win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', gain: 0.16, delay: i * 0.12 })); tone(1047, 0.7, { type: 'triangle', gain: 0.14, delay: 0.5 }); },
  lose: () => { [440, 392, 330, 262].forEach((f, i) => tone(f, 0.28, { type: 'sawtooth', gain: 0.1, delay: i * 0.16, slideTo: f * 0.92 })); },
};

/**
 * Plays sounds for whatever changed since the last call. `d` is the pose array that is about to be drawn,
 * `L` its layout, `me` the index of the player on this screen (-1 when spectating). Call once per frame.
 */
export function createSoundObserver(L, me) {
  const lv = levelById(L.levelId);
  const pigIndex = lv.crates.findIndex((c) => c.pig);
  let prev = null;
  const lastStep = new Array(L.n).fill(0);
  const cooldown = { spotted: 0, siren: 0, tick: 0, shove: 0 };
  let sirenHigh = false;

  return function observe(d, now) {
    if (!ctx || muted) { prev = d; return; }
    const p = prev;
    prev = d;
    if (!p || p.length !== d.length) return;

    // game end
    const status = d[L.sOff], pStatus = p[L.sOff];
    if (status !== pStatus && pStatus === 0) (status === 1 ? sfx.win : sfx.lose)();

    // footsteps: your own are loudest, others fade with distance
    const mine = me >= 0 ? { x: d[L.pOff + me * 4], z: d[L.pOff + me * 4 + 2] } : null;
    for (let i = 0; i < L.n; i++) {
      const o = L.pOff + i * 4;
      const moved = Math.hypot(d[o] - p[o], d[o + 2] - p[o + 2]);
      if (moved > 0.035 && d[o + 1] < 1.05 && now - lastStep[i] > 280) {
        lastStep[i] = now;
        const dist = mine ? Math.hypot(d[o] - mine.x, d[o + 2] - mine.z) : 0;
        sfx.step((i === me ? 1 : 0.55) / (1 + dist / 6));
      }
    }

    // guards start chasing, or shove someone
    for (let g = 0; g < L.guards; g++) {
      const o = L.gOff + g * 5 + 4;
      if (d[o] === 2 && p[o] !== 2 && now - cooldown.spotted > 1200) { cooldown.spotted = now; sfx.spotted(); }
    }

    // the rope is tied to or untied from a pillar
    for (let r = 0; r < L.ropes; r++) {
      const a = d[L.kOff + r] >= 0, b = p[L.kOff + r] >= 0;
      if (a && !b) sfx.knot();
      else if (!a && b) sfx.unknot();
    }

    // something is picked up or put down
    for (let c = 0; c < L.crates; c++) {
      const a = d[L.hOff + c] > 0, b = p[L.hOff + c] > 0;
      if (a && !b) sfx.grab();
      else if (!a && b) sfx.drop();
    }

    // a laser beam trips
    for (let l = 0; l < L.lasers; l++) if (d[L.lOff + l * 2 + 1] === 1 && p[L.lOff + l * 2 + 1] === 0) sfx.zap();

    // the pig hops
    if (pigIndex >= 0) {
      const o = L.cOff + pigIndex * 7 + 1;
      // rising off the floor (it rests at y = 0.25)
      if (d[o] - p[o] > 0.02 && d[o] > 0.3 && now - (cooldown.oink ?? 0) > 1800) { cooldown.oink = now; sfx.oink(); }
    }

    // siren while the alarm is going, and a ticking clock for the last ten seconds
    const alarm = d[L.sOff + 4], secs = d[L.sOff + 2];
    if (alarm > 0 && status === 0 && now - cooldown.siren > 320) { cooldown.siren = now; sirenHigh = !sirenHigh; sfx.siren(sirenHigh); }
    if (status === 0 && secs <= 10 && secs !== p[L.sOff + 2] && secs > 0) sfx.tick();
  };
}
