// Physics simulation. Runs on the host, and on every client for prediction. Knows nothing about
// rendering or networking.
import RAPIER from '@dimforge/rapier3d-compat';
import { LEVELS, levelById } from './levels.js';

export { LEVELS, levelById };

export const ROPE_SEGMENTS = 14;
export const ROPE_LENGTH = 7;
export const MAX_PLAYERS = 4;
export const STEP = 1 / 60;

const MOVE_SPEED = 5;
const JUMP_SPEED = 9; // the heavy rope drags a jump down, so this lifts you about 1 unit in practice
const GRAVITY = 20;
const PLAYER_HALF_HEIGHT = 0.75; // capsule half-length 0.35 + radius 0.4
const ROPE_DENSITY = 40; // heavy enough that the joint solver can hold players
const SPAWN_GAP = ROPE_LENGTH * 0.94; // start nearly taut but not stretched
const GROUP_PLAYER = 0x0001;
const GROUP_ROPE = 0x0002;

// verbs
const GRAB_REACH = 1.4; // gap between you and the crate's surface
const GRAB_DROP_DIST = 4; // a held crate this far away (you got shoved by a guard, say) is let go
const HOLD_FORCE_MAX = 64; // one player can lift mass up to about 3.2 against gravity 20, so the safe (4.5) takes two
const HOLD_SPRING = 70;
const HOLD_DAMPING = 9;
const HOLD_REACTION = 0.15; // how much a heavy load drags the carrier
const SHOVE_STUN = 22; // ticks of reduced steering after a guard shoves you, so the shove actually carries you
const TIE_REACH = 2.4; // how close you must stand to a pillar
const TIE_SNAP = 1.5; // a rope segment further than this from the pillar can't be tied

// heist rules (time limit and quota come from the level)
const END_RESTART_TICKS = 14 * 60; // after a win or loss the round restarts by itself (long enough for the instant replay)
const WIN_HOLD_TICKS = 30; // enough loot has to sit in the getaway zone this long
// lasers
export const LASER_HEIGHT = 0.55; // beams stop here, so a jump (feet above this) clears them
const LASER_ALERT_PLAYER = 30;
const LASER_ALERT_ROPE = 12; // dragging just the rope through a beam still sets it off
const LASER_COOLDOWN = 100; // ticks before the same beam can trip again
const ALARM_TICKS = 150; // how long the siren and red flash last
// guards
const GUARD_PATROL_SPEED = 2.0;
const GUARD_CHASE_SPEED = 3.3;
const GUARD_PAUSE_TICKS = 45; // they stop and look around at each waypoint
const GUARD_STUCK_TICKS = 90; // a patrolling guard that has not moved for this long skips its waypoint
export const VIEW_DIST = 7;
export const VIEW_HALF_ANGLE = 0.7; // radians either side of facing
const SEE_TO_CHASE_TICKS = 36; // seeing a player this long (0.6 s) starts a chase
const LOSE_TARGET_TICKS = 150; // a chaser gives up this long after losing sight
const ALERT_PLAYER = 0.5; // alert per tick (of 100) while a player is in a cone
const ALERT_ROPE = 0.2; // ... while only the rope is
const ALERT_DECAY = 0.1; // per tick when nobody is seen
const ALERT_CONTACT = 15; // a chasing guard catching you
const CONTACT_COOLDOWN = 60;


export const emptyInput = () => ({ x: 0, z: 0, jump: false, grab: false, tie: false });

/** Wire format for inputs: [x, z, jump, grab, tie]. */
export const inputToArray = (i) => [i.x, i.z, i.jump ? 1 : 0, i.grab ? 1 : 0, i.tie ? 1 : 0];
export const inputFromArray = (d) => ({ x: d[0], z: d[1], jump: !!d[2], grab: !!d[3], tie: !!d[4] });

/** Layout of the flat "pose" array (what the renderer draws) for n players on a level. */
export function layout(n, levelId = 0) {
  const lv = levelById(levelId);
  const ropes = n - 1;
  const pOff = 0; // per player: x y z facing
  const rOff = pOff + n * 4; // per rope segment: x y z
  const cOff = rOff + ropes * ROPE_SEGMENTS * 3; // per crate: x y z qx qy qz qw
  const nc = lv.crates.length;
  const kOff = cOff + nc * 7; // per rope: index of the tied-off segment, or -1
  const hOff = kOff + ropes; // per crate: how many players hold it
  const gOff = hOff + nc; // per guard: x y z facing mode
  const lOff = gOff + lv.guards.length * 5; // per laser: beam on (0/1), tripped lately (0/1)
  const sOff = lOff + lv.lasers.length * 2; // game: status, reason, seconds left, alert, alarm ticks, loot delivered
  return { n, levelId, ropes, pOff, rOff, cOff, kOff, hOff, gOff, lOff, sOff, crates: nc, guards: lv.guards.length, lasers: lv.lasers.length, size: sOff + 6 };
}

/**
 * Layout of the flat "state" array: everything needed to restore the simulation (see state / loadState).
 * player: x y z, vx vy vz, facing, input x z jump grab tie, held prevGrab prevTie stun
 * pin (per rope): tied-off segment index or -1
 * rope segment: x y z qx qy qz qw vx vy vz
 * crate: x y z qx qy qz qw vx vy vz wx wy wz
 * guard: x y z vx vy vz facing waypoint mode timer target seeTicks contactCooldown
 * laser: cooldown
 * game: tick alert status reason winHold endTicks alarm
 */
export function stateLayout(n, levelId = 0) {
  const lv = levelById(levelId);
  const PN = 16, RN = 10, CN = 13, GN = 13, GAMEN = 7;
  const pinOff = n * PN;
  const rOff = pinOff + (n - 1);
  const cOff = rOff + (n - 1) * ROPE_SEGMENTS * RN;
  const gOff = cOff + lv.crates.length * CN;
  const lOff = gOff + lv.guards.length * GN;
  const mOff = lOff + lv.lasers.length;
  return { n, levelId, PN, RN, CN, GN, GAMEN, pinOff, rOff, cOff, gOff, lOff, mOff, size: mOff + GAMEN };
}

let rapierReady = null;
export function initPhysics() {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Small integer hash to a number in [0, 1): the same on every machine, unlike Math.random or trig. */
function hash01(a, b) {
  let x = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Distance from a point to a segment, on the floor plane. */
function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

export function createSim(n, levelId = 0) {
  const lv = levelById(levelId);
  const spawnZ = lv.spawnZ; // the crew starts in the getaway zone, south of the building
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.integrationParameters.numSolverIterations = 16; // chains of joints need extra iterations

  for (const s of lv.statics) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...s.p));
    world.createCollider(RAPIER.ColliderDesc.cuboid(...s.h), body);
  }
  const pillars = lv.statics.filter((s) => s.pillar);

  const crates = lv.crates.map((c) => {
    const [dx, dy, dz] = c.s != null ? [c.s, c.s, c.s] : [c.sx, c.sy, c.sz];
    const y = dy / 2 + 0.1;
    let desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(c.x, y, c.z).setLinearDamping(0.3).setAngularDamping(0.8);
    if (c.pig) desc = desc.enabledRotations(false, true, false); // a pig stays on its feet
    const body = world.createRigidBody(desc);
    world.createCollider(RAPIER.ColliderDesc.cuboid(dx / 2, dy / 2, dz / 2).setDensity(c.density).setFriction(0.8), body);
    // r: how far the box reaches sideways (for grabbing), hy: half its height
    return { body, home: { x: c.x, y, z: c.z }, dims: [dx, dy, dz], r: Math.max(dx, dz) / 2, hy: dy / 2, mass: body.mass(), pig: !!c.pig };
  });

  // players
  const players = [];
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * SPAWN_GAP;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 1.2, spawnZ).lockRotations().setLinearDamping(0.2).setCcdEnabled(true),
    );
    const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.35, 0.4).setDensity(1).setFriction(0.0), body);
    // players don't collide with rope (it would jitter), but they do collide with each other and the world
    collider.setCollisionGroups((GROUP_PLAYER << 16) | (0xffff & ~GROUP_ROPE));
    players.push({
      body, collider, input: emptyInput(), facing: 0, spawn: { x, z: spawnZ },
      held: -1, prevGrab: false, prevTie: false, stun: 0,
    });
  }

  // One rope between each pair of neighbours: a chain of small spheres joined by spherical joints.
  // Joint anchors sit along local X, so every rope starts laid out along X.
  const ropeSpacing = ROPE_LENGTH / ROPE_SEGMENTS; // player -> half link -> full links -> half link -> player
  const ropeRest = (r, i) => ({
    x: players[r].spawn.x + (i + 0.5) * (SPAWN_GAP / ROPE_SEGMENTS),
    y: 1.2,
    z: spawnZ,
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

  // ---------- guards and the heist rules ----------
  const lootIndexes = lv.crates.map((c, i) => (c.loot ? i : -1)).filter((i) => i >= 0);
  const timeLimitTicks = lv.timeLimit * 60;
  const laserCd = lv.lasers.map(() => 0); // ticks until each beam can trip again
  // status: 0 playing, 1 won, 2 lost.  reason (when lost): 1 alarm, 2 out of time.  alarm: ticks of siren left
  const game = { tick: 0, alert: 0, status: 0, reason: 0, winHold: 0, endTicks: 0, alarm: 0 };
  const facingToward = (def, from, to) => Math.atan2(def.wps[to][0] - def.wps[from][0], def.wps[to][1] - def.wps[from][1]);
  const guards = lv.guards.map((def) => {
    const [sx, sz] = def.wps[0];
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(sx, 1.2, sz).lockRotations().setLinearDamping(0.5).setCcdEnabled(true),
    );
    const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.35, 0.4).setDensity(3).setFriction(0), body);
    return { body, collider, def, facing: facingToward(def, 0, 1), wp: 1, mode: 0, timer: 0, target: -1, see: 0, contactCd: 0 }; // mode: 0 patrol, 1 pause, 2 chase
  });

  const SIGHT_GROUPS = (0xffff << 16) | (0xffff & ~GROUP_ROPE & ~GROUP_PLAYER); // walls and crates block sight, people and rope do not
  const COS_VIEW = Math.cos(VIEW_HALF_ANGLE);
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  /** How far away the point is, if this guard can see it (inside the cone, nothing solid in between), else -1. */
  function sightDistance(g, tx, ty, tz) {
    const gt = g.body.translation();
    const dx = tx - gt.x, dz = tz - gt.z;
    const flat = Math.hypot(dx, dz);
    if (flat < 0.01) return 0;
    if (flat > VIEW_DIST) return -1;
    if ((dx * Math.sin(g.facing) + dz * Math.cos(g.facing)) / flat < COS_VIEW) return -1;
    const ey = gt.y + 0.2, dy = ty - ey, d3 = Math.hypot(dx, dy, dz);
    const ray = new RAPIER.Ray({ x: gt.x, y: ey, z: gt.z }, { x: dx / d3, y: dy / d3, z: dz / d3 });
    return world.castRay(ray, d3 - 0.25, true, undefined, SIGHT_GROUPS, g.collider) === null ? flat : -1;
  }

  /** One tick of guard behaviour. Returns how much it adds to the shared alert meter. */
  function updateGuard(g) {
    const t = g.body.translation(), v = g.body.linvel();
    if (g.contactCd > 0) g.contactCd--;

    // what can we see? players first, otherwise a bit of rope
    let seen = -1, seenDist = Infinity;
    players.forEach((p, i) => {
      const q = p.body.translation();
      const d = sightDistance(g, q.x, q.y, q.z);
      if (d >= 0 && d < seenDist) { seen = i; seenDist = d; }
    });
    let ropeSeen = false;
    if (seen < 0) {
      scan: for (const segs of ropes) {
        for (let k = 0; k < segs.length; k += 3) {
          const q = segs[k].translation();
          if (sightDistance(g, q.x, q.y, q.z) >= 0) { ropeSeen = true; break scan; }
        }
      }
    }
    let gain = seen >= 0 ? ALERT_PLAYER * (1.2 - seenDist / VIEW_DIST) : ropeSeen ? ALERT_ROPE : 0;

    g.see = seen >= 0 ? g.see + 1 : Math.max(0, g.see - 2);
    if (g.mode !== 2 && g.see >= SEE_TO_CHASE_TICKS) { g.mode = 2; g.target = seen; g.timer = 0; }
    if (g.mode === 2) {
      if (seen >= 0) { g.target = seen; g.timer = 0; }
      else if (++g.timer > LOSE_TARGET_TICKS) { g.mode = 0; g.timer = 0; g.see = 0; g.target = -1; }
    }

    // where to, and how fast
    let tx = t.x, tz = t.z, speed = 0, lookX = null, lookZ = null;
    if (g.mode === 2) {
      const q = players[g.target].body.translation(), pv = players[g.target].body.linvel();
      tx = q.x; tz = q.z; speed = GUARD_CHASE_SPEED;
      if (Math.hypot(q.x - t.x, q.z - t.z) < 1.15 && g.contactCd === 0) { // caught someone: shove them and raise the alarm
        const dx = q.x - t.x, dz = q.z - t.z, d = Math.hypot(dx, dz) || 1;
        players[g.target].body.setLinvel({ x: pv.x + (dx / d) * 7, y: pv.y + 3, z: pv.z + (dz / d) * 7 }, true);
        players[g.target].stun = SHOVE_STUN;
        gain += ALERT_CONTACT;
        g.contactCd = CONTACT_COOLDOWN;
      }
    } else if (g.mode === 1) { // pause at the waypoint and look towards the next one
      const next = g.def.wps[(g.wp + 1) % g.def.wps.length];
      lookX = next[0] - t.x; lookZ = next[1] - t.z;
      if (++g.timer >= GUARD_PAUSE_TICKS) { g.mode = 0; g.timer = 0; g.wp = (g.wp + 1) % g.def.wps.length; }
    } else {
      [tx, tz] = g.def.wps[g.wp];
      speed = GUARD_PATROL_SPEED;
      if (Math.hypot(tx - t.x, tz - t.z) < 0.5) { g.mode = 1; g.timer = 0; speed = 0; }
      // wedged against something for 1.5 s? give up on this waypoint and head for the next
      else if (Math.hypot(v.x, v.z) < 0.3 ? ++g.timer > GUARD_STUCK_TICKS : (g.timer = 0)) { g.wp = (g.wp + 1) % g.def.wps.length; g.timer = 0; }
    }

    const dx = (lookX ?? tx - t.x), dz = (lookZ ?? tz - t.z), d = Math.hypot(dx, dz);
    if (speed > 0 && d > 0.01) {
      g.body.setLinvel({ x: v.x + ((dx / d) * speed - v.x) * 0.25, y: v.y, z: v.z + ((dz / d) * speed - v.z) * 0.25 }, true);
    } else {
      g.body.setLinvel({ x: v.x * 0.7, y: v.y, z: v.z * 0.7 }, true);
    }
    if (d > 0.01) g.facing += clamp(wrapAngle(Math.atan2(dx, dz) - g.facing), -0.1, 0.1);
    return gain;
  }

  /** How many loot items are inside the getaway zone right now. */
  function deliveredCount() {
    const e = lv.exit;
    let count = 0;
    for (const i of lootIndexes) {
      const s = crates[i].body.translation();
      if (Math.abs(s.x - e.x) < e.hx && Math.abs(s.z - e.z) < e.hz && s.y < 1.8) count++;
    }
    return count;
  }

  /** Lasers: a beam trips the alarm if a player (not jumping over it) or even just the rope touches it while it is on. */
  const laserOn = (L, tick) => (tick + L.phase) % L.period < L.on;
  function laserTick() {
    let gain = 0;
    lv.lasers.forEach((L, li) => {
      if (laserCd[li] > 0) laserCd[li]--;
      if (laserCd[li] > 0 || !laserOn(L, game.tick)) return;
      let hitPlayer = false, hitRope = false;
      for (const p of players) {
        const t = p.body.translation();
        if (t.y - PLAYER_HALF_HEIGHT < LASER_HEIGHT && distToSegment(t.x, t.z, L.a[0], L.a[1], L.b[0], L.b[1]) < 0.55) hitPlayer = true;
      }
      if (!hitPlayer) {
        scan: for (const segs of ropes) {
          for (const b of segs) {
            const t = b.translation();
            if (t.y < LASER_HEIGHT && distToSegment(t.x, t.z, L.a[0], L.a[1], L.b[0], L.b[1]) < 0.25) { hitRope = true; break scan; }
          }
        }
      }
      if (hitPlayer || hitRope) {
        gain += hitPlayer ? LASER_ALERT_PLAYER : LASER_ALERT_ROPE;
        laserCd[li] = LASER_COOLDOWN;
        game.alarm = ALARM_TICKS;
      }
    });
    return gain;
  }

  /** Pigs hop off in a random direction every so often unless someone is holding them. Same on every machine. */
  function wanderPigs() {
    crates.forEach((c, ci) => {
      if (!c.pig || holdersOf(ci).length || (game.tick + ci * 17) % 40 !== 0) return;
      const angle = hash01(game.tick, ci) * Math.PI * 2;
      const push = c.mass * 3.6;
      c.body.applyImpulse({ x: Math.cos(angle) * push, y: c.mass * 2.6, z: Math.sin(angle) * push }, true);
    });
  }

  function updateGame(gain) {
    if (game.status !== 0) { // round is over: wait a bit, then start again
      if (++game.endTicks >= END_RESTART_TICKS) resetAll();
      return;
    }
    game.tick++;
    if (game.alarm > 0) game.alarm--;
    game.alert = gain > 0 ? Math.min(100, game.alert + gain) : Math.max(0, game.alert - ALERT_DECAY);
    game.winHold = deliveredCount() >= lv.quota ? game.winHold + 1 : 0;
    if (game.winHold >= WIN_HOLD_TICKS) game.status = 1;
    else if (game.alert >= 100) { game.status = 2; game.reason = 1; }
    else if (game.tick >= timeLimitTicks) { game.status = 2; game.reason = 2; }
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
    const speed = MOVE_SPEED / (1 + 0.1 * carriedMass(p)); // heavy loads slow you down
    const v = p.body.linvel();
    const grounded = isGrounded(p);
    // blend toward target velocity so the rope can still pull us around; right after a guard's shove
    // we barely steer at all, otherwise the blend would cancel the shove in a few ticks
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
      const gap = Math.hypot(ct.x - t.x, ct.z - t.z) - c.r - 0.4;
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
        const reach = 0.85 + c.r;
        const tx = pt.x + Math.sin(p.facing) * reach;
        const tz = pt.z + Math.cos(p.facing) * reach;
        const ty = pt.y - 0.2 + c.hy;
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
      if (p.held >= 0) { // too far away (shoved by a guard, say)? let go
        const t = p.body.translation(), c = crates[p.held].body.translation();
        if (Math.hypot(t.x - c.x, t.y - c.y, t.z - c.z) > GRAB_DROP_DIST) p.held = -1;
      }
    } else {
      p.held = -1;
    }
    if (inp.tie && !p.prevTie) toggleTie(i);
    p.prevGrab = inp.grab; p.prevTie = inp.tie;
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
      p.held = -1; p.stun = 0;
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
    for (const g of guards) {
      const [sx, sz] = g.def.wps[0];
      g.body.setTranslation({ x: sx, y: 1.2, z: sz }, true);
      g.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      Object.assign(g, { facing: facingToward(g.def, 0, 1), wp: 1, mode: 0, timer: 0, target: -1, see: 0, contactCd: 0 });
    }
    Object.assign(game, { tick: 0, alert: 0, status: 0, reason: 0, winHold: 0, endTicks: 0, alarm: 0 });
    laserCd.fill(0);
  }

  function step() {
    players.forEach(handleActions);
    players.forEach(updatePlayer);
    applyHolds();
    let gain = 0;
    for (const g of guards) {
      if (game.status === 0) gain += updateGuard(g);
      else g.body.setLinvel({ x: 0, y: g.body.linvel().y, z: 0 }, true); // round over: guards stand still
    }
    if (game.status === 0) wanderPigs();
    world.step();
    for (let i = 0; i < n - 1; i++) enforceTether(players[i], players[i + 1]);
    // fell off the world: everyone back to the start
    if (players.some((p) => p.body.translation().y < -15)) resetAll();
    else {
      if (game.status === 0) gain += laserTick();
      updateGame(gain);
    }
  }

  // ---------- snapshots ----------
  /** Full simulation state as a flat array of numbers (see stateLayout). Sent to clients for rollback. */
  function state() {
    const S = stateLayout(n, levelId);
    const d = new Array(S.size);
    const r2 = (v) => Math.round(v * 100) / 100;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    players.forEach((p, i) => {
      const t = p.body.translation(), v = p.body.linvel(), o = i * S.PN;
      d[o] = round3(t.x); d[o + 1] = round3(t.y); d[o + 2] = round3(t.z);
      d[o + 3] = r2(v.x); d[o + 4] = r2(v.y); d[o + 5] = r2(v.z);
      d[o + 6] = round3(p.facing);
      d[o + 7] = r2(p.input.x); d[o + 8] = r2(p.input.z);
      d[o + 9] = p.input.jump ? 1 : 0; d[o + 10] = p.input.grab ? 1 : 0; d[o + 11] = p.input.tie ? 1 : 0;
      d[o + 12] = p.held;
      d[o + 13] = p.prevGrab ? 1 : 0; d[o + 14] = p.prevTie ? 1 : 0;
      d[o + 15] = p.stun;
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
    guards.forEach((g, i) => {
      const t = g.body.translation(), v = g.body.linvel(), o = S.gOff + i * S.GN;
      d[o] = round3(t.x); d[o + 1] = round3(t.y); d[o + 2] = round3(t.z);
      d[o + 3] = r2(v.x); d[o + 4] = r2(v.y); d[o + 5] = r2(v.z);
      d[o + 6] = round3(g.facing);
      d[o + 7] = g.wp; d[o + 8] = g.mode; d[o + 9] = g.timer; d[o + 10] = g.target; d[o + 11] = g.see; d[o + 12] = g.contactCd;
    });
    laserCd.forEach((cd, i) => { d[S.lOff + i] = cd; });
    d[S.mOff] = game.tick; d[S.mOff + 1] = round3(game.alert); d[S.mOff + 2] = game.status;
    d[S.mOff + 3] = game.reason; d[S.mOff + 4] = game.winHold; d[S.mOff + 5] = game.endTicks; d[S.mOff + 6] = game.alarm;
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
    const S = stateLayout(n, levelId);
    players.forEach((p, i) => {
      const o = i * S.PN;
      setBody(p.body, d, o, false, null);
      p.facing = d[o + 6];
      p.input = { x: d[o + 7], z: d[o + 8], jump: d[o + 9] === 1, grab: d[o + 10] === 1, tie: d[o + 11] === 1 };
      p.held = d[o + 12];
      p.prevGrab = d[o + 13] === 1; p.prevTie = d[o + 14] === 1;
      p.stun = d[o + 15];
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
    guards.forEach((g, i) => {
      const o = S.gOff + i * S.GN;
      setBody(g.body, d, o, false, null);
      g.facing = d[o + 6]; g.wp = d[o + 7]; g.mode = d[o + 8]; g.timer = d[o + 9]; g.target = d[o + 10]; g.see = d[o + 11]; g.contactCd = d[o + 12];
    });
    laserCd.forEach((_, i) => { laserCd[i] = d[S.lOff + i]; });
    game.tick = d[S.mOff]; game.alert = d[S.mOff + 1]; game.status = d[S.mOff + 2];
    game.reason = d[S.mOff + 3]; game.winHold = d[S.mOff + 4]; game.endTicks = d[S.mOff + 5]; game.alarm = d[S.mOff + 6];
  }

  /** Flat array of numbers, see layout(). What the renderer draws. */
  function pose() {
    const L = layout(n, levelId);
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
    crates.forEach((_, i) => { d[L.hOff + i] = holdersOf(i).length; });
    guards.forEach((g, i) => {
      const t = g.body.translation(), o = L.gOff + i * 5;
      d[o] = round3(t.x); d[o + 1] = round3(t.y); d[o + 2] = round3(t.z); d[o + 3] = round3(g.facing); d[o + 4] = g.mode;
    });
    lv.lasers.forEach((La, i) => { d[L.lOff + i * 2] = laserOn(La, game.tick) ? 1 : 0; d[L.lOff + i * 2 + 1] = laserCd[i] > 0 ? 1 : 0; });
    d[L.sOff] = game.status; d[L.sOff + 1] = game.reason;
    d[L.sOff + 2] = Math.max(0, Math.ceil((timeLimitTicks - game.tick) / 60));
    d[L.sOff + 3] = Math.round(game.alert * 10) / 10;
    d[L.sOff + 4] = game.alarm;
    d[L.sOff + 5] = deliveredCount();
    return d;
  }

  return { n, level: lv, levelId, world, players, ropes, crates, guards, game, pinSeg, laserCd, step, pose, state, loadState, resetAll, isGrounded, sightDistance };
}
