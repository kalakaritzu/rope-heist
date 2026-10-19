// Level data, shared by the simulation, the renderer and the bots. Positions are x, z on the floor
// (north is negative z). Walls are low (too tall to jump, low enough to see over).

const WALL = 0.8; // wall half-height
const wall = (hx, hz, x, z) => ({ h: [hx, WALL, hz], p: [x, WALL, z], color: 0x5a6078 });
const pillar = (x, z) => ({ h: [0.6, 1.6, 0.6], p: [x, 1.6, z], color: 0x6b5b95, pillar: true });
const floor = () => ({ h: [40, 0.5, 40], p: [0, -0.5, 0], color: 0x3b4058 });

/**
 * A level:
 *  statics   boxes that never move (floor, walls, pillars you can tie the rope to)
 *  crates    things you can pick up. Cubes use s, other boxes use sx sy sz. mass = volume x density.
 *            loot: counts towards the quota. pig: wanders off by itself while nobody holds it. kind: how it is drawn.
 *  exit      the getaway zone (centre x, z and half sizes); loot has to end up inside
 *  quota     how many loot items must be inside the zone at once to win
 *  guards    each loops through its waypoints [x, z]
 *  lasers    a beam from a to b that pulses: on for `on` ticks out of every `period`, shifted by `phase`
 *  timeLimit seconds
 *  bots      whether the "watch bots" crew knows this level
 */
export const LEVELS = [
  {
    id: 0,
    name: 'The Museum',
    blurb: 'Easy to read: one door, one hall, one vault, one very heavy safe.',
    objective: 'Steal the gold safe (it takes two of you) and bring it back to the green zone',
    timeLimit: 150,
    quota: 1,
    spawnZ: 9,
    bots: true,
    statics: [
      floor(),
      wall(12.25, 0.25, 0, -22), // back wall
      wall(0.25, 9.25, -12, -13), wall(0.25, 9.25, 12, -13), // side walls
      wall(5.375, 0.25, -6.875, -4), wall(5.375, 0.25, 6.875, -4), // front wall, door gap at x in [-1.5, 1.5]
      wall(5, 0.25, -7, -13), wall(5, 0.25, 7, -13), // inner wall, gap at x in [-2, 2] leads to the vault
      pillar(4, 0), pillar(-6, -8.5), pillar(6, -8.5), pillar(-6, -18.5), pillar(6, -18.5),
    ],
    crates: [
      { s: 1, x: -9, z: 10, density: 0.6, color: 0xd9a441 },
      { s: 1.2, x: 9, z: 6, density: 0.6, color: 0xd9a441 },
      { s: 0.8, x: -7, z: 2, density: 0.6, color: 0xd9a441 },
      { s: 1.4, x: -8, z: -6, density: 0.6, color: 0xd9a441 },
      { s: 1, x: 8, z: -11, density: 0.6, color: 0xd9a441 },
      { s: 1, x: 5, z: -6, density: 0.6, color: 0xd9a441 },
      { s: 0.8, x: -8, z: -19, density: 0.6, color: 0xe9c46a },
      { s: 0.8, x: 8, z: -19, density: 0.6, color: 0xe9c46a },
      { s: 1.2, x: 0, z: -19, density: 2.6, color: 0xffd166, loot: true, kind: 'safe' }, // THE SAFE: heavy, needs two players
    ],
    exit: { x: 0, z: 9, hx: 6, hz: 4 },
    guards: [
      { wps: [[-9, -7], [9, -7], [9, -10], [-9, -10]] }, // the hall
      { wps: [[-9, -17], [9, -17], [9, -20], [-9, -20]] }, // the vault
      { wps: [[-9, -1.5], [9, -1.5]] }, // outside the front wall
    ],
    lasers: [],
  },

  {
    id: 1,
    name: 'The Gallery',
    blurb: 'Harder: a zig-zag of rooms, pulsing lasers, and three treasures. Deliver any two.',
    objective: 'Bring any 2 of the 3 treasures (painting, clock, live pig) back to the green zone. Jump or time the lasers!',
    timeLimit: 240,
    quota: 2,
    spawnZ: 9,
    bots: false,
    statics: [
      floor(),
      wall(14.25, 0.25, 0, -24), // back wall
      wall(0.25, 10.25, -14, -14), wall(0.25, 10.25, 14, -14), // side walls
      wall(8.125, 0.25, -6.125, -4), wall(4.625, 0.25, 9.625, -4), // front wall: door gap at x in [2, 5]
      wall(4.125, 0.25, -10.125, -11), wall(8.625, 0.25, 5.625, -11), // first inner wall: gap at x in [-6, -3]
      wall(9.125, 0.25, -5.125, -18), wall(3.625, 0.25, 10.625, -18), // second inner wall: gap at x in [4, 7]
      pillar(6, 2), pillar(-9, -8.8), pillar(9, -8.8), pillar(-9, -16.3), pillar(9, -12.8), pillar(-9, -22.2), pillar(9, -22.2),
    ],
    crates: [
      { s: 1, x: -9, z: 10, density: 0.6, color: 0xd9a441 },
      { s: 1.2, x: 10, z: 6, density: 0.6, color: 0xd9a441 },
      { s: 0.9, x: -11, z: -5.3, density: 0.6, color: 0xd9a441 },
      { s: 1, x: 11, z: -9.8, density: 0.6, color: 0xd9a441 },
      { s: 1, x: 10, z: -16.5, density: 0.6, color: 0xd9a441 },
      // the treasures
      { sx: 1.8, sy: 0.25, sz: 1.2, x: -8, z: -22.6, density: 8, color: 0x9b59b6, loot: true, kind: 'painting' }, // behind a laser, needs two
      { sx: 0.8, sy: 1.9, sz: 0.6, x: 8, z: -22.2, density: 4, color: 0x7a4b2a, loot: true, kind: 'clock' }, // tall and heavy, needs two
      { sx: 0.6, sy: 0.5, sz: 1.0, x: 1, z: -21, density: 1.8, color: 0xf4a6b8, loot: true, pig: true, kind: 'pig' }, // light, but it will not stay put
    ],
    exit: { x: 0, z: 9, hx: 6, hz: 4 },
    guards: [
      { wps: [[-12, -7], [12, -7]] }, // first room
      { wps: [[12, -14.5], [-12, -14.5]] }, // second room
      { wps: [[-12, -20.2], [12, -20.2]] }, // the vault
    ],
    lasers: [
      { a: [-1, -4.3], b: [-1, -10.7], period: 270, on: 100, phase: 0 }, // first room, crosses your path to the first gap
      { a: [1, -11.3], b: [1, -17.7], period: 270, on: 100, phase: 135 }, // second room
      { a: [-3, -18.3], b: [-3, -23.7], period: 300, on: 120, phase: 60 }, // in the vault, guarding the painting
    ],
  },
];

export const levelById = (id) => LEVELS[id] ?? LEVELS[0];
