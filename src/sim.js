// Physics simulation. Runs on the host, and on every client for prediction. Knows nothing about
// rendering or networking.
import RAPIER from '@dimforge/rapier3d-compat';

export const ROPE_SEGMENTS = 14;
export const ROPE_LENGTH = 7;
export const MAX_PLAYERS = 4;
export const STEP = 1 / 60;

const MOVE_SPEED = 5;
const JUMP_SPEED = 7;
const GRAVITY = 20;
const PLAYER_HALF_HEIGHT = 0.75; // capsule half-length 0.35 + radius 0.4
const ROPE_DENSITY = 40; // heavy enough that the joint solver can hold players
const SPAWN_GAP = ROPE_LENGTH * 0.94; // start nearly taut but not stretched
const SPAWN_Z = 3;
const GROUP_PLAYER = 0x0001;
const GROUP_ROPE = 0x0002;

// verbs
const GRAB_REACH = 1.4; // gap between you and the crate's surface
const GRAB_DROP_DIST = 4; // a held crate this far away (someone got yanked, say) is let go
const HOLD_FORCE_MAX = 64; // one player can lift mass up to about 3.2 against gravity 20, so the safe (4.5) takes two
const HOLD_SPRING = 70;
const HOLD_DAMPING = 9;
const HOLD_REACTION = 0.3; // how much a heavy load drags the carrier
const YANK_SPEED = 15;
const YANK_COOLDOWN = 60; // ticks
const YANK_STUN = 22; // ticks of reduced steering so the yank actually carries you
const TIE_REACH = 2.4; // how close you must stand to a pillar
const TIE_SNAP = 1.5; // a rope segment further than this from the pillar can't be tied

export const PLAYER_COLORS = [0xff7a59, 0x59c3ff, 0x7be07b, 0xf2d34f];

// Shared with the renderer so both sides build the same level.
export const LEVEL = {
  statics: [
    { h: [30, 0.5, 30], p: [0, -0.5, 0], color: 0x3b4058 }, // floor
    { h: [0.6, 2.5, 0.6], p: [0, 2.5, -4], color: 0x6b5b95, pillar: true }, // pillars: tie the rope here
    { h: [0.6, 2.5, 0.6], p: [7, 2.5, -1], color: 0x6b5b95, pillar: true },
    { h: [4, 0.5, 4], p: [-10, 0.5, -6], color: 0x4a7c59 }, // raised platform
  ],
  // size, position, density. Kept clear of the spawn line (z = SPAWN_Z).
  // mass = size^3 * density: light crates are a one-person carry, the safe needs two.
  crates: [
    { s: 1, x: 3, z: 6, density: 0.6, color: 0xd9a441 },
    { s: 1, x: 4.5, z: -1, density: 0.6, color: 0xd9a441 },
    { s: 1.4, x: -4, z: 7, density: 0.6, color: 0xd9a441 },
    { s: 0.8, x: 2, z: 9, density: 0.6, color: 0xd9a441 },
    { s: 1.2, x: 8, z: -3, density: 0.6, color: 0xd9a441 },
    { s: 1.2, x: -2, z: 10, density: 2.6, color: 0xffd166 }, // the safe: heavy loot
  ],
};

export const emptyInput = () => ({ x: 0, z: 0, jump: false, grab: false, yank: false, tie: false });

/** Wire format for inputs: [x, z, jump, grab, yank, tie]. */
export const inputToArray = (i) => [i.x, i.z, i.jump ? 1 : 0, i.grab ? 1 : 0, i.yank ? 1 : 0, i.tie ? 1 : 0];
export const inputFromArray = (d) => ({ x: d[0], z: d[1], jump: !!d[2], grab: !!d[3], yank: !!d[4], tie: !!d[5] });

/** Layout of the flat "pose" array (what the renderer draws) for n players. */
export function layout(n) {
  const ropes = n - 1;
  const pOff = 0; // per player: x y z facing
  const rOff = pOff + n * 4; // per rope segment: x y z
  const cOff = rOff + ropes * ROPE_SEGMENTS * 3; // per crate: x y z qx qy qz qw
  const nc = LEVEL.crates.length;
  const kOff = cOff + nc * 7; // per rope: index of the tied-off segment, or -1
  const fOff = kOff + ropes; // per player: yank cooldown 0..1 (for the flash)
  const hOff = fOff + n; // per crate: how many players hold it
  return { n, ropes, pOff, rOff, cOff, kOff, fOff, hOff, crates: nc, size: hOff + nc };
}

/**
 * Layout of the flat "state" array: everything needed to restore the simulation (see state / loadState).
 * player: x y z, vx vy vz, facing, input x z jump grab yank tie, held prevGrab prevYank prevTie cooldown stun
 * pin (per rope): tied-off segment index or -1
 * rope segment: x y z qx qy qz qw vx vy vz
 * crate: x y z qx qy qz qw vx vy vz wx wy wz
 */
export function stateLayout(n) {
  const PN = 19, RN = 10, CN = 13;
  const pinOff = n * PN;
  const rOff = pinOff + (n - 1);
  const cOff = rOff + (n - 1) * ROPE_SEGMENTS * RN;
  return { n, PN, RN, CN, pinOff, rOff, cOff, size: cOff + LEVEL.crates.length * CN };
}

let rapierReady = null;
export function initPhysics() {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export function createSim(n) {
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.integrationParameters.numSolverIterations = 16; // chains of joints need extra iterations

  for (const s of LEVEL.statics) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...s.p));
    world.createCollider(RAPIER.ColliderDesc.cuboid(...s.h), body);
  }
  const pillars = LEVEL.statics.filter((s) => s.pillar);

  const crates = LEVEL.crates.map((c) => {
    const y = c.s / 2 + 0.1;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(c.x, y, c.z).setLinearDamping(0.3).setAngularDamping(0.8),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(c.s / 2, c.s / 2, c.s / 2).setDensity(c.density).setFriction(0.8),
      body,
    );
    return { body, home: { x: c.x, y, z: c.z }, size: c.s, mass: body.mass() };
  });

  // players
  const players = [];
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * SPAWN_GAP;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 1.2, SPAWN_Z).lockRotations().setLinearDamping(0.2).setCcdEnabled(true),
    );
    const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.35, 0.4).setDensity(1).setFriction(0.0), body);
    // players don't collide with rope (it would jitter), but they do collide with each other and the world
    collider.setCollisionGroups((GROUP_PLAYER << 16) | (0xffff & ~GROUP_ROPE));
    players.push({
      body, collider, input: emptyInput(), facing: 0, spawn: { x, z: SPAWN_Z },
      held: -1, prevGrab: false, prevYank: false, prevTie: false, cooldown: 0, stun: 0,
    });
  }

  // One rope between each pair of neighbours: a chain of small spheres joined by spherical joints.
  // Joint anchors sit along local X, so every rope starts laid out along X.
  const ropeSpacing = ROPE_LENGTH / ROPE_SEGMENTS; // player -> half link -> full links -> half link -> player
  const ropeRest = (r, i) => ({
    x: players[r].spawn.x + (i + 0.5) * (SPAWN_GAP / ROPE_SEGMENTS),
    y: 1.2,
    z: SPAWN_Z,
  });
  const ropes = [];
  const pinSeg = []; // per rope: which segment is tied to a pillar (-1 = none)
  for (let r = 0; r < n - 1; r++) {
    const segs = [];
    let prev = players[r].body;
    for (let i = 0; i < ROPE_SEGMENTS; i++) {
      const rest = ropeRest(r, i);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(rest.x, rest.y, rest.z)
          .setLinearDamping(0.6).setAngularDamping(1.0).setCcdEnabled(true),
      );
      const col = world.createCollider(RAPIER.ColliderDesc.ball(0.1).setDensity(ROPE_DENSITY).setFriction(0.6), body);
      col.setCollisionGroups((GROUP_ROPE << 16) | (0xffff & ~GROUP_PLAYER));
      const anchorOnPrev = i === 0 ? { x: 0, y: 0, z: 0 } : { x: ropeSpacing / 2, y: 0, z: 0 };
      world.createImpulseJoint(
        RAPIER.JointData.spherical(anchorOnPrev, { x: -ropeSpacing / 2, y: 0, z: 0 }),
        prev, body, true,
      );
      segs.push(body);
      prev = body;
    }
    world.createImpulseJoint(
      RAPIER.JointData.spherical({ x: ropeSpacing / 2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
      prev, players[r + 1].body, true,
    );
    ropes.push(segs);
    pinSeg.push(-1);
  }

  // ---------- movement ----------
  function isGrounded(p) {
    const t = p.body.translation();
    const ray = new RAPIER.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 });
    // skip our own capsule and the rope; reach just past the capsule's feet
    const groups = (0xffff << 16) | (0xffff & ~GROUP_ROPE & ~GROUP_PLAYER);
    return world.castRay(ray, PLAYER_HALF_HEIGHT + 0.15, true, undefined, groups, p.collider) !== null;
  }

  const holdersOf = (ci) => players.filter((p) => p.held === ci);

  /** Mass this player is hauling (heavy loot is shared between everyone holding it). */
  function carriedMass(p) {
    if (p.held < 0) return 0;
    return crates[p.held].mass / holdersOf(p.held).length;
  }

  function updatePlayer(p) {
    let { x: dx, z: dz } = p.input;
    const len = Math.hypot(dx, dz);
    if (len > 1) { dx /= len; dz /= len; }
    const speed = MOVE_SPEED / (1 + 0.2 * carriedMass(p)); // heavy loads slow you down
    const v = p.body.linvel();
    const grounded = isGrounded(p);
    // blend toward target velocity so the rope can still yank us around; right after a yank
    // we barely steer at all, otherwise the blend would cancel the yank in a few ticks
    const accel = p.stun > 0 ? 0.03 : grounded ? 0.35 : 0.1;
    const vx = v.x + (dx * speed - v.x) * accel;
    const vz = v.z + (dz * speed - v.z) * accel;
    const vy = p.input.jump && grounded && p.stun === 0 ? JUMP_SPEED : v.y;
    p.body.setLinvel({ x: vx, y: vy, z: vz }, true);
    if (len > 0.01) p.facing = Math.atan2(dx, dz);
    if (p.stun > 0) p.stun--;
  }

  // ---------- verbs ----------
  function pickCrate(p) {
    const t = p.body.translation();
    let best = -1, bestGap = GRAB_REACH;
    crates.forEach((c, i) => {
      const ct = c.body.translation();
      if (Math.abs(ct.y - t.y) > 1.6) return;
      const gap = Math.hypot(ct.x - t.x, ct.z - t.z) - c.size / 2 - 0.4;
      if (gap < bestGap) { bestGap = gap; best = i; }
    });
    return best;
  }

  /** Each holder pulls the crate towards a spot in front of them. Two holders share a heavy crate. */
  function applyHolds() {
    crates.forEach((c, ci) => {
      const holders = holdersOf(ci);
      if (!holders.length) return;
      const ct = c.body.translation(), cv = c.body.linvel();
      for (const p of holders) {
        const pt = p.body.translation(), pv = p.body.linvel();
        const reach = 0.85 + c.size / 2;
        const tx = pt.x + Math.sin(p.facing) * reach;
        const tz = pt.z + Math.cos(p.facing) * reach;
        const ty = pt.y - 0.2 + c.size / 2;
        // spring-damper towards the target, plus the share of gravity this holder is carrying
        let fx = c.mass * (HOLD_SPRING * (tx - ct.x) - HOLD_DAMPING * (cv.x - pv.x));
        let fy = c.mass * (HOLD_SPRING * (ty - ct.y) - HOLD_DAMPING * (cv.y - pv.y) + GRAVITY / holders.length);
        let fz = c.mass * (HOLD_SPRING * (tz - ct.z) - HOLD_DAMPING * (cv.z - pv.z));
        const f = Math.hypot(fx, fy, fz);
        if (f > HOLD_FORCE_MAX) { const k = HOLD_FORCE_MAX / f; fx *= k; fy *= k; fz *= k; }
        c.body.applyImpulse({ x: fx * STEP, y: fy * STEP, z: fz * STEP }, true);
        // heavy loads drag the carrier (horizontal only, so nobody gets pushed into the floor)
        p.body.applyImpulse({ x: -fx * STEP * HOLD_REACTION, y: 0, z: -fz * STEP * HOLD_REACTION }, true);
      }
    });
  }

  function doYank(i) {
    const p = players[i];
    const me = p.body.translation();
    const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    // pull whichever neighbour you're facing most (an end of the chain only has one)
    let target = -1, bestScore = -Infinity;
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= n) continue;
      const t = players[j].body.translation();
      const d = Math.hypot(t.x - me.x, t.z - me.z) || 1;
      const score = (fx * (t.x - me.x) + fz * (t.z - me.z)) / d;
      if (score > bestScore) { bestScore = score; target = j; }
    }
    if (target < 0) return;
    const other = players[target];
    const t = other.body.translation();
    const dx = me.x - t.x, dy = me.y - t.y, dz = me.z - t.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const v = other.body.linvel(), mv = p.body.linvel();
    other.body.setLinvel({ x: v.x + (dx / d) * YANK_SPEED, y: v.y + 3, z: v.z + (dz / d) * YANK_SPEED }, true);
    other.stun = YANK_STUN;
    p.body.setLinvel({ x: mv.x - (dx / d) * 2, y: mv.y, z: mv.z - (dz / d) * 2 }, true); // small recoil
    p.cooldown = YANK_COOLDOWN;
  }

  const setPinned = (body, pinned) =>
    body.setBodyType(pinned ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic, true);

  /** Nearest point on a pillar's sides to (x, z): { qx, qz, nx, nz, d }. */
  function nearestOnPillar(s, x, z) {
    const qx = clamp(x, s.p[0] - s.h[0], s.p[0] + s.h[0]);
    const qz = clamp(z, s.p[2] - s.h[2], s.p[2] + s.h[2]);
    const d = Math.hypot(x - qx, z - qz);
    return { qx, qz, nx: d > 1e-6 ? (x - qx) / d : 1, nz: d > 1e-6 ? (z - qz) / d : 0, d };
  }

  /** Q: tie the nearest bit of your rope to a pillar. Q again nearby: untie it. */
  function toggleTie(i) {
    const me = players[i].body.translation();
    const mine = [i - 1, i].filter((r) => r >= 0 && r < n - 1); // the ropes attached to you

    for (const r of mine) { // already tied close to you? let it go
      if (pinSeg[r] < 0) continue;
      const t = ropes[r][pinSeg[r]].translation();
      if (Math.hypot(t.x - me.x, t.y - me.y, t.z - me.z) < TIE_REACH + 1.5) {
        setPinned(ropes[r][pinSeg[r]], false);
        pinSeg[r] = -1;
        return;
      }
    }

    // otherwise find the pillar you're standing at, and the loose rope segment closest to it
    let best = null;
    for (const s of pillars) {
      if (nearestOnPillar(s, me.x, me.z).d > TIE_REACH) continue;
      for (const r of mine) {
        if (pinSeg[r] >= 0) continue;
        ropes[r].forEach((b, k) => {
          const t = b.translation();
          const q = nearestOnPillar(s, t.x, t.z);
          if (q.d < TIE_SNAP && (!best || q.d < best.q.d)) best = { r, k, q, y: t.y };
        });
      }
    }
    if (!best) return;
    const { r, k, q, y } = best;
    const body = ropes[r][k];
    body.setTranslation({ x: q.qx + q.nx * 0.12, y: clamp(y, 0.5, 2.0), z: q.qz + q.nz * 0.12 }, true);
    body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    setPinned(body, true);
    pinSeg[r] = k;
  }

  function handleActions(p, i) {
    const inp = p.input;
    if (inp.grab) {
      if (p.held < 0 && !p.prevGrab) p.held = pickCrate(p);
      if (p.held >= 0) { // too far away (yanked, say)? let go
        const t = p.body.translation(), c = crates[p.held].body.translation();
        if (Math.hypot(t.x - c.x, t.y - c.y, t.z - c.z) > GRAB_DROP_DIST) p.held = -1;
      }
    } else {
      p.held = -1;
    }
    if (p.cooldown > 0) p.cooldown--;
    if (inp.yank && !p.prevYank && p.cooldown === 0) doYank(i);
    if (inp.tie && !p.prevTie) toggleTie(i);
    p.prevGrab = inp.grab; p.prevYank = inp.yank; p.prevTie = inp.tie;
  }

  // Safety net: a rope can never really be longer than ROPE_LENGTH, so if two neighbours drift
  // further apart than that the joints have been overpowered. Pull them back together.
  function enforceTether(a, b) {
    const ta = a.body.translation(), tb = b.body.translation();
    const dx = tb.x - ta.x, dy = tb.y - ta.y, dz = tb.z - ta.z;
    const d = Math.hypot(dx, dy, dz);
    const limit = ROPE_LENGTH * 0.99;
    if (d <= limit) return;
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const va = a.body.linvel(), vb = b.body.linvel();
    const closing = (vb.x - va.x) * nx + (vb.y - va.y) * ny + (vb.z - va.z) * nz; // >0 means moving apart
    const push = Math.max(closing, 0) * 0.5 + (d - limit) * 3;
    a.body.setLinvel({ x: va.x + nx * push, y: va.y + ny * push, z: va.z + nz * push }, true);
    b.body.setLinvel({ x: vb.x - nx * push, y: vb.y - ny * push, z: vb.z - nz * push }, true);
  }

  function resetAll() {
    ropes.forEach((segs, r) => {
      if (pinSeg[r] >= 0) { setPinned(segs[pinSeg[r]], false); pinSeg[r] = -1; }
    });
    for (const p of players) {
      p.body.setTranslation({ x: p.spawn.x, y: 1.2, z: p.spawn.z }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.held = -1; p.cooldown = 0; p.stun = 0;
    }
    ropes.forEach((segs, r) => segs.forEach((rb, i) => {
      rb.setTranslation(ropeRest(r, i), true);
      rb.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }));
    for (const c of crates) {
      c.body.setTranslation(c.home, true);
      c.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      c.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      c.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  function step() {
    players.forEach(handleActions);
    players.forEach(updatePlayer);
    applyHolds();
    world.step();
    for (let i = 0; i < n - 1; i++) enforceTether(players[i], players[i + 1]);
    // fell off the world: everyone back to the start
    if (players.some((p) => p.body.translation().y < -15)) resetAll();
  }

  // ---------- snapshots ----------
  /** Full simulation state as a flat array of numbers (see stateLayout). Sent to clients for rollback. */
  function state() {
    const S = stateLayout(n);
    const d = new Array(S.size);
    const r2 = (v) => Math.round(v * 100) / 100;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    players.forEach((p, i) => {
      const t = p.body.translation(), v = p.body.linvel(), o = i * S.PN;
      d[o] = round3(t.x); d[o + 1] = round3(t.y); d[o + 2] = round3(t.z);
      d[o + 3] = r2(v.x); d[o + 4] = r2(v.y); d[o + 5] = r2(v.z);
      d[o + 6] = round3(p.facing);
      d[o + 7] = r2(p.input.x); d[o + 8] = r2(p.input.z);
      d[o + 9] = p.input.jump ? 1 : 0; d[o + 10] = p.input.grab ? 1 : 0;
      d[o + 11] = p.input.yank ? 1 : 0; d[o + 12] = p.input.tie ? 1 : 0;
      d[o + 13] = p.held;
      d[o + 14] = p.prevGrab ? 1 : 0; d[o + 15] = p.prevYank ? 1 : 0; d[o + 16] = p.prevTie ? 1 : 0;
      d[o + 17] = p.cooldown; d[o + 18] = p.stun;
    });
    pinSeg.forEach((k, r) => { d[S.pinOff + r] = k; });
    ropes.forEach((segs, r) => segs.forEach((b, i) => {
      const t = b.translation(), q = b.rotation(), v = b.linvel(), o = S.rOff + (r * ROPE_SEGMENTS + i) * S.RN;
      d[o] = round3(t.x); d[o + 1] = round3(t.y); d[o + 2] = round3(t.z);
      d[o + 3] = r4(q.x); d[o + 4] = r4(q.y); d[o + 5] = r4(q.z); d[o + 6] = r4(q.w);
      d[o + 7] = r2(v.x); d[o + 8] = r2(v.y); d[o + 9] = r2(v.z);
    }));
    crates.forEach((c, i) => {
      const t = c.body.translation(), q = c.body.rotation(), v = c.body.linvel(), w = c.body.angvel(), o = S.cOff + i * S.CN;
      d[o] = round3(t.x); d[o + 1] = round3(t.y); d[o + 2] = round3(t.z);
      d[o + 3] = r4(q.x); d[o + 4] = r4(q.y); d[o + 5] = r4(q.z); d[o + 6] = r4(q.w);
      d[o + 7] = r2(v.x); d[o + 8] = r2(v.y); d[o + 9] = r2(v.z);
      d[o + 10] = r2(w.x); d[o + 11] = r2(w.y); d[o + 12] = r2(w.z);
    });
    return d;
  }

  const setBody = (b, d, o, withRotation, angvelAt) => {
    b.setTranslation({ x: d[o], y: d[o + 1], z: d[o + 2] }, true);
    let k = o + 3;
    if (withRotation) {
      const len = Math.hypot(d[o + 3], d[o + 4], d[o + 5], d[o + 6]) || 1;
      b.setRotation({ x: d[o + 3] / len, y: d[o + 4] / len, z: d[o + 5] / len, w: d[o + 6] / len }, true);
      k = o + 7;
    }
    b.setLinvel({ x: d[k], y: d[k + 1], z: d[k + 2] }, true);
    b.setAngvel(angvelAt === null ? { x: 0, y: 0, z: 0 } : { x: d[angvelAt], y: d[angvelAt + 1], z: d[angvelAt + 2] }, true);
  };

  /** Restore the simulation from state(). Also loads every player's last input. */
  function loadState(d) {
    const S = stateLayout(n);
    players.forEach((p, i) => {
      const o = i * S.PN;
      setBody(p.body, d, o, false, null);
      p.facing = d[o + 6];
      p.input = { x: d[o + 7], z: d[o + 8], jump: d[o + 9] === 1, grab: d[o + 10] === 1, yank: d[o + 11] === 1, tie: d[o + 12] === 1 };
      p.held = d[o + 13];
      p.prevGrab = d[o + 14] === 1; p.prevYank = d[o + 15] === 1; p.prevTie = d[o + 16] === 1;
      p.cooldown = d[o + 17]; p.stun = d[o + 18];
    });
    for (let r = 0; r < n - 1; r++) { // tied-off segments are fixed bodies, so switch body types before loading them
      const want = d[S.pinOff + r];
      if (pinSeg[r] !== want) {
        if (pinSeg[r] >= 0) setPinned(ropes[r][pinSeg[r]], false);
        if (want >= 0) setPinned(ropes[r][want], true);
        pinSeg[r] = want;
      }
    }
    ropes.forEach((segs, r) => segs.forEach((b, i) => setBody(b, d, S.rOff + (r * ROPE_SEGMENTS + i) * S.RN, true, null)));
    crates.forEach((c, i) => { const o = S.cOff + i * S.CN; setBody(c.body, d, o, true, o + 10); });
  }

  /** Flat array of numbers, see layout(). What the renderer draws. */
  function pose() {
    const L = layout(n);
    const d = new Array(L.size);
    players.forEach((p, i) => {
      const t = p.body.translation(), o = L.pOff + i * 4;
      d[o] = round3(t.x); d[o + 1] = round3(t.y); d[o + 2] = round3(t.z); d[o + 3] = round3(p.facing);
    });
    ropes.forEach((segs, r) => segs.forEach((b, i) => {
      const t = b.translation(), o = L.rOff + (r * ROPE_SEGMENTS + i) * 3;
      d[o] = round3(t.x); d[o + 1] = round3(t.y); d[o + 2] = round3(t.z);
    }));
    crates.forEach((c, i) => {
      const t = c.body.translation(), q = c.body.rotation(), o = L.cOff + i * 7;
      d[o] = round3(t.x); d[o + 1] = round3(t.y); d[o + 2] = round3(t.z);
      d[o + 3] = round3(q.x); d[o + 4] = round3(q.y); d[o + 5] = round3(q.z); d[o + 6] = round3(q.w);
    });
    pinSeg.forEach((k, r) => { d[L.kOff + r] = k; });
    players.forEach((p, i) => { d[L.fOff + i] = p.cooldown / YANK_COOLDOWN; });
    crates.forEach((_, i) => { d[L.hOff + i] = holdersOf(i).length; });
    return d;
  }

  return { n, world, players, ropes, crates, pinSeg, step, pose, state, loadState, resetAll, isGrounded };
}
