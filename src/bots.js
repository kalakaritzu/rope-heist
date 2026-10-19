// Bot crew: a team of AI players that try to pull off the heist together. Used by "Watch bots".
//
// The guards patrol on a fixed schedule, so a bot can find a safe moment to move by trying the next
// stage on a hidden copy of the world ("scouting") with different waiting times, then doing it for
// real with the best one. While it scouts, the real game is paused.
import { createSim, levelById } from './sim.js';

const FOLLOW_LAG = 35; // ticks each bot trails the one in front of it
const SCOUT_STEP = 40; // candidate waiting times are tried in steps of this many ticks
const SCOUT_MAX_WAIT = 1520; // a bit over one full guard patrol cycle (24 s)
const OK_RISE = 10; // a stage is "safe enough" if it adds no more than this much alert
const ABORT_RISE = 30; // stop scouting a candidate once it is clearly going badly
const THROUGH_OK_RISE = 30; // ...and a non-stop run through the whole heist may add this much and still count
const THROUGH_ABORT = 36; // a non-stop candidate is dropped once it has added this much alert (it could no longer be clean)

const EMOTE = { THINK: 4, CHEER: 5, PANIC: 2, SOS: 3 }; // indexes into EMOTES (profile.js)

// The plan, stage by stage. Players 0 and 1 are the carriers; anyone else tags along behind.
export const STAGES = [
  { name: 'slipping through the front door', kind: 'path', pts: [[0, 4], [0, -1], [0, -7]], maxTicks: 600 },
  { name: 'crossing the hall', kind: 'path', pts: [[0, -10], [0, -13], [0, -16.5]], maxTicks: 600 },
  { name: 'getting to the safe', kind: 'approach', maxTicks: 600 },
  { name: 'carrying the safe to the gap', kind: 'carry', pts: [[0, -15], [0, -13.5]], endAt: [0, -13.5], maxTicks: 500 },
  { name: 'crossing the hall with it', kind: 'carry', pts: [[0, -12], [0, -8], [0, -5.5]], endAt: [0, -5.5], maxTicks: 600 },
  { name: 'running for the getaway zone', kind: 'carry', pts: [[0, -3], [0, 3], [0, 7.5]], endAt: null, maxTicks: 700 },
];
const SAFE = levelById(0).crates.findIndex((c) => c.loot); // the bots only know the Museum
const AROUND_WEST = [[-2.3, -17.5], [-2.3, -20.7], [-0.7, -20.8]]; // the two carriers go round either side of the safe
const AROUND_EAST = [[2.3, -17.5], [2.3, -20.7], [0.7, -20.8]];

const idle = (n, stage) => Array.from({ length: n }, (_, i) => ({ grab: stage.kind === 'carry' && i < 2 }));

/** Builds the "what should everyone press right now" function for one stage, for a given sim. */
function makeController(stage, sim) {
  const n = sim.n;
  const pos = (i) => sim.players[i].body.translation();
  const steer = (i, tx, tz, stop = 0.35) => {
    const q = pos(i), dx = tx - q.x, dz = tz - q.z, d = Math.hypot(dx, dz);
    return d < stop ? { x: 0, z: 0, arrived: true } : { x: dx / d, z: dz / d, arrived: false };
  };
  const trail = []; // where player 0 has been, so the others can walk the same route
  const behind = (i, lag) => trail[Math.max(0, trail.length - 1 - lag)] ?? pos(0);
  let k = 0, k0 = 0, k1 = 0;

  return () => {
    const q = pos(0);
    trail.push({ x: q.x, z: q.z });
    if (trail.length > 400) trail.shift();
    const inputs = Array.from({ length: n }, () => ({}));
    let done = false;

    if (stage.kind === 'path') {
      const s = steer(0, ...stage.pts[k]);
      if (s.arrived && k < stage.pts.length - 1) k++;
      inputs[0] = s;
      for (let i = 1; i < n; i++) { const t = behind(i, FOLLOW_LAG * i); inputs[i] = steer(i, t.x, t.z, 0.5); }
      done = k === stage.pts.length - 1 && s.arrived;
    } else if (stage.kind === 'approach') {
      const a = steer(0, ...AROUND_WEST[Math.min(k0, 2)], 0.3), b = steer(1, ...AROUND_EAST[Math.min(k1, 2)], 0.3);
      if (a.arrived) k0++;
      if (b.arrived) k1++;
      inputs[0] = k0 >= 3 ? {} : a;
      inputs[1] = k1 >= 3 ? {} : b;
      for (let i = 2; i < n; i++) { const t = behind(i, FOLLOW_LAG * i); inputs[i] = steer(i, t.x, t.z, 0.5); }
      done = k0 >= 3 && k1 >= 3;
    } else { // carry: the two carriers walk side by side holding the safe between/in front of them
      const sp = sim.crates[SAFE].body.translation();
      if (k < stage.pts.length - 1 && Math.hypot(sp.x - stage.pts[k][0], sp.z - stage.pts[k][1]) < 0.8) k++;
      const [tx, tz] = stage.pts[k];
      inputs[0] = { ...steer(0, tx - 0.85, tz, 0.2), grab: true };
      inputs[1] = { ...steer(1, tx + 0.85, tz, 0.2), grab: true };
      for (let i = 2; i < n; i++) { const t = behind(i, FOLLOW_LAG * (i - 1)); inputs[i] = steer(i, t.x, t.z, 0.5); }
      done = stage.endAt ? Math.hypot(sp.x - stage.endAt[0], sp.z - stage.endAt[1]) < 0.8 : sim.game.status === 1;
    }
    return { inputs, done };
  };
}

const apply = (sim, inputs) => sim.players.forEach((p, i) => { p.input = { x: 0, z: 0, jump: false, grab: false, tie: false, ...inputs[i] }; });

/** Tries "wait w ticks, then do this stage" on a hidden copy of the world for growing w, a little at a time per frame. */
class Scout {
  constructor(n) { this.n = n; this.sim = createSim(n); }

  /** through: scout "wait, then do this stage and every later one without stopping", judged on winning. */
  begin(liveState, stageIndex, alert, through = false) {
    this.live = liveState;
    this.through = through;
    this.firstStage = stageIndex;
    this.stageIndex = stageIndex;
    this.stage = STAGES[stageIndex];
    this.alert0 = alert;
    this.wait = 0;
    this.phase = 'load';
    this.tried = [];
    this.result = null;
  }

  /** Does up to `ms` milliseconds of scouting. Returns true once it has picked a waiting time (this.result). */
  work(ms) {
    const t0 = performance.now();
    const { sim } = this;
    while (performance.now() - t0 < ms) {
      const stage = this.stage;
      if (this.phase === 'load') {
        sim.loadState(this.live);
        this.t = 0;
        this.peak = this.alert0;
        this.phase = 'wait';
      }
      if (this.phase === 'wait') {
        if (this.t < this.wait) {
          apply(sim, idle(this.n, stage));
          sim.step();
          this.t++;
          this.peak = Math.max(this.peak, sim.game.alert);
          if (this.peak - this.alert0 > ABORT_RISE) { this.finishCandidate(false); if (this.result !== null) return true; }
          continue;
        }
        this.stage = STAGES[this.stageIndex];
        this.ctrl = makeController(this.stage, sim);
        this.t = 0;
        this.phase = 'run';
      }
      if (this.phase === 'run') {
        const c = this.ctrl();
        apply(sim, c.inputs);
        sim.step();
        this.t++;
        this.peak = Math.max(this.peak, sim.game.alert);
        const won = stage.endAt === null ? sim.game.status === 1 : false;
        if (this.through) {
          if (c.done && !won && sim.game.status === 0 && this.stageIndex + 1 < STAGES.length) { // on to the next stage, no stopping
            this.stageIndex++;
            this.stage = STAGES[this.stageIndex];
            this.ctrl = makeController(this.stage, sim);
            this.t = 0;
            continue;
          }
          const failed = sim.game.status === 2 || this.peak - this.alert0 > THROUGH_ABORT || this.t >= stage.maxTicks;
          if (won || failed) { this.finishCandidate(won); if (this.result !== null) return true; }
          continue;
        }
        const ok = (c.done && sim.game.status === 0) || won;
        if (ok || sim.game.status !== 0 || this.peak - this.alert0 > ABORT_RISE || this.t >= stage.maxTicks) {
          this.finishCandidate(ok);
          if (this.result !== null) return true;
        }
      }
    }
    return false;
  }

  finishCandidate(ok) {
    const rise = this.peak - this.alert0;
    this.tried.push({ wait: this.wait, ok, rise });
    if (ok && rise <= (this.through ? THROUGH_OK_RISE : OK_RISE)) { this.result = this.wait; return; }
    this.wait += SCOUT_STEP;
    this.phase = 'load';
    this.stageIndex = this.firstStage;
    if (this.wait > SCOUT_MAX_WAIT) {
      if (this.through) { this.result = -1; return; } // no clean non-stop run exists: the crew will scout stage by stage instead
      // nothing was clean: settle for the least risky way that still worked, else just go
      const finished = this.tried.filter((r) => r.ok).sort((a, b) => a.rise - b.rise)[0];
      this.result = finished ? finished.wait : 0;
    }
  }
}

/**
 * The crew. Each tick when not thinking: `inputs()` gives everyone's controls. While `thinking` is true the
 * caller should pause the game and keep calling `think(ms)` until it clears.
 * onEmote(playerIndex, emoteId) lets the view show their reactions.
 */
export function createBots(sim, { onEmote = () => {} } = {}) {
  const n = sim.n;
  const scout = new Scout(n);
  const stats = { attempts: 1, wins: 0, busts: 0 };
  let stageIndex = -1;
  let ctrl = null;
  let waitLeft = 0;
  let thinking = false;
  let ended = false;
  let finished = false; // every stage done, waiting for the win to register
  let panicked = false;
  const plans = [];

  let nonStop = false; // true when the whole heist was planned as one go, so there is no scouting between stages

  function beginStage(i, through = false) {
    stageIndex = i;
    ctrl = null;
    finished = false;
    scout.begin(sim.state(), i, sim.game.alert, through);
    thinking = true;
    onEmote(0, EMOTE.THINK);
  }

  function newRound() {
    stageIndex = -1;
    ended = false;
    finished = false;
    panicked = false;
    ctrl = null;
    nonStop = false;
    beginStage(0, true); // first, look for a moment to go from the getaway zone and do the whole thing without stopping
  }
  newRound();

  return {
    stats,
    get thinking() { return thinking; },
    get stageName() { return stageIndex >= 0 ? STAGES[stageIndex].name : ''; },
    get stageIndex() { return stageIndex; },
    get stageCount() { return STAGES.length; },
    /** The scout's tried waiting times so far, for the HUD. */
    get scouting() { return scout.tried.length; },

    think(ms) {
      if (!thinking) return;
      if (scout.work(ms)) {
        plans.push({ stage: stageIndex, through: scout.through, wait: scout.result, tried: scout.tried.length, best: scout.tried.find((r) => r.wait === scout.result) });
        if (scout.through && scout.result < 0) { // no clean non-stop run: do it stage by stage, scouting before each
          beginStage(0, false);
          return;
        }
        nonStop = scout.through;
        waitLeft = scout.result;
        thinking = false;
      }
    },
    /** What each scouting session decided, for debugging. */
    plans,

    /** Start over (used by the R key). */
    restart() {
      sim.resetAll();
      stats.attempts++;
      newRound();
    },

    inputs() {
      const g = sim.game;
      if (g.status !== 0) { // round over: celebrate or sulk, then wait for the game to restart itself
        if (!ended) {
          ended = true;
          if (g.status === 1) { stats.wins++; for (let i = 0; i < n; i++) onEmote(i, EMOTE.CHEER); }
          else { stats.busts++; onEmote(0, EMOTE.SOS); onEmote(1, EMOTE.PANIC); }
        }
        return idle(n, { kind: 'none' });
      }
      if (ended) { // the game restarted by itself
        stats.attempts++;
        newRound();
        return idle(n, { kind: 'none' });
      }
      if (!panicked && g.alert > 55) { panicked = true; onEmote(1, EMOTE.PANIC); }
      if (finished) return idle(n, STAGES[stageIndex]);

      const stage = STAGES[stageIndex];
      if (waitLeft > 0) { waitLeft--; return idle(n, stage); }
      ctrl ??= makeController(stage, sim);
      const r = ctrl();
      if (r.done) {
        if (stageIndex + 1 >= STAGES.length) finished = true;
        else if (nonStop) { stageIndex++; ctrl = null; } // planned as one go: straight on to the next stage
        else beginStage(stageIndex + 1);
      }
      return r.inputs;
    },
  };
}
