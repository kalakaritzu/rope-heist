// Physics simulation. Runs only on the host (or locally). Knows nothing about rendering or networking.
import RAPIER from '@dimforge/rapier3d-compat';

export const ROPE_SEGMENTS = 14;
export const ROPE_LENGTH = 7;
export const MAX_PLAYERS = 4;
export const STEP = 1 / 60;

const MOVE_SPEED = 5;
const JUMP_SPEED = 7;
const PLAYER_HALF_HEIGHT = 0.75; // capsule half-length 0.35 + radius 0.4
const ROPE_DENSITY = 40; // heavy enough that the joint solver can hold players
const SPAWN_GAP = ROPE_LENGTH * 0.94; // start nearly taut but not stretched
const SPAWN_Z = 3;
const GROUP_PLAYER = 0x0001;
const GROUP_ROPE = 0x0002;

export const PLAYER_COLORS = [0xff7a59, 0x59c3ff, 0x7be07b, 0xf2d34f];

// Shared with the renderer so both sides build the same level.
export const LEVEL = {
  statics: [
    { h: [30, 0.5, 30], p: [0, -0.5, 0], color: 0x3b4058 }, // floor
    { h: [0.6, 2.5, 0.6], p: [0, 2.5, -4], color: 0x6b5b95 }, // pillars to snag the rope on
    { h: [0.6, 2.5, 0.6], p: [7, 2.5, -1], color: 0x6b5b95 },
    { h: [4, 0.5, 4], p: [-10, 0.5, -6], color: 0x4a7c59 }, // raised platform
  ],
  // size, x, z. Kept clear of the spawn line (z = SPAWN_Z).
  crates: [
    { s: 1, x: 3, z: 6, color: 0xd9a441 },
    { s: 1, x: 4.5, z: -1, color: 0xd9a441 },
    { s: 1.4, x: -4, z: 7, color: 0xd9a441 },
    { s: 0.8, x: 2, z: 9, color: 0xd9a441 },
    { s: 1.2, x: 8, z: -3, color: 0xd9a441 },
  ],
};

/** Layout of the flat "pose" array (what the renderer draws) for n players. */
export function layout(n) {
  const ropes = n - 1;
  const pOff = 0; // per player: x y z facing
  const rOff = pOff + n * 4; // per rope segment: x y z
  const cOff = rOff + ropes * ROPE_SEGMENTS * 3; // per crate: x y z qx qy qz qw
  return { n, ropes, pOff, rOff, cOff, crates: LEVEL.crates.length, size: cOff + LEVEL.crates.length * 7 };
}

/**
 * Layout of the flat "state" array: everything needed to restore the simulation (see state / loadState).
 * player: x y z vx vy vz facing inputX inputZ inputJump
 * rope segment: x y z qx qy qz qw vx vy vz
 * crate: x y z qx qy qz qw vx vy vz wx wy wz
 */
export function stateLayout(n) {
  const PN = 10, RN = 10, CN = 13;
  const rOff = n * PN;
  const cOff = rOff + (n - 1) * ROPE_SEGMENTS * RN;
  return { n, PN, RN, CN, rOff, cOff, size: cOff + LEVEL.crates.length * CN };
}

let rapierReady = null;
export function initPhysics() {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

export function createSim(n) {
  const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
  world.integrationParameters.numSolverIterations = 16; // chains of joints need extra iterations

  for (const s of LEVEL.statics) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...s.p));
    world.createCollider(RAPIER.ColliderDesc.cuboid(...s.h), body);
  }

  const crates = LEVEL.crates.map((c) => {
    const y = c.s / 2 + 0.1;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(c.x, y, c.z).setLinearDamping(0.3).setAngularDamping(0.5),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(c.s / 2, c.s / 2, c.s / 2).setDensity(0.6).setFriction(0.8),
      body,
    );
    return { body, home: { x: c.x, y, z: c.z } };
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
    players.push({ body, collider, input: { x: 0, z: 0, jump: false }, facing: 0, spawn: { x, z: SPAWN_Z } });
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
  }

  function isGrounded(p) {
    const t = p.body.translation();
    const ray = new RAPIER.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 });
    // skip our own capsule and the rope; reach just past the capsule's feet
    const groups = (0xffff << 16) | (0xffff & ~GROUP_ROPE & ~GROUP_PLAYER);
    return world.castRay(ray, PLAYER_HALF_HEIGHT + 0.15, true, undefined, groups, p.collider) !== null;
  }

  function updatePlayer(p) {
    let { x: dx, z: dz } = p.input;
    const len = Math.hypot(dx, dz);
    if (len > 1) { dx /= len; dz /= len; }
    const v = p.body.linvel();
    const grounded = isGrounded(p);
    // blend toward target velocity so the rope can still yank us around
    const accel = grounded ? 0.35 : 0.1;
    const vx = v.x + (dx * MOVE_SPEED - v.x) * accel;
    const vz = v.z + (dz * MOVE_SPEED - v.z) * accel;
    const vy = p.input.jump && grounded ? JUMP_SPEED : v.y;
    p.body.setLinvel({ x: vx, y: vy, z: vz }, true);
    if (len > 0.01) p.facing = Math.atan2(dx, dz);
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
    for (const p of players) {
      p.body.setTranslation({ x: p.spawn.x, y: 1.2, z: p.spawn.z }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
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
    players.forEach(updatePlayer);
    world.step();
    for (let i = 0; i < n - 1; i++) enforceTether(players[i], players[i + 1]);
    // fell off the world: everyone back to the start
    if (players.some((p) => p.body.translation().y < -15)) resetAll();
  }

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
      d[o + 7] = r2(p.input.x); d[o + 8] = r2(p.input.z); d[o + 9] = p.input.jump ? 1 : 0;
    });
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
      p.input = { x: d[o + 7], z: d[o + 8], jump: d[o + 9] === 1 };
    });
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
    return d;
  }

  return { n, world, players, ropes, crates, step, pose, state, loadState, resetAll, isGrounded };
}
