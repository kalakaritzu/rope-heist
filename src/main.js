import { initPhysics, createSim, layout, STEP, MAX_PLAYERS, PLAYER_COLORS } from './sim.js';
import { createView } from './view.js';
import { createHost, joinRoom } from './net.js';

const $ = (id) => document.getElementById(id);
const colorCss = (i) => '#' + PLAYER_COLORS[i].toString(16).padStart(6, '0');

// ---------- input ----------
const keysDown = new Set();
addEventListener('keydown', (e) => {
  keysDown.add(e.code);
  if (e.code === 'KeyR' && game?.role !== 'client' && game?.sim) game.sim.resetAll();
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keysDown.delete(e.code));
addEventListener('blur', () => keysDown.clear());

const anyDown = (codes) => codes.some((c) => keysDown.has(c));
function readInput(scheme) {
  const x = (anyDown(scheme.right) ? 1 : 0) - (anyDown(scheme.left) ? 1 : 0);
  const z = (anyDown(scheme.down) ? 1 : 0) - (anyDown(scheme.up) ? 1 : 0);
  return { x, z, jump: anyDown(scheme.jump) };
}
const SCHEME_A = { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], jump: ['Space'] };
const SCHEME_B = { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], jump: ['Enter'] };
// online you only control one player, so either hand works
const SCHEME_ONLINE = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space', 'Enter'],
};

// ---------- UI ----------
let game = null; // { sim?, view, hostTick?, ... } exposed for debugging
window.addEventListener('error', (e) => showError(e.message));

function showPanel(id) {
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('show', p.id === id));
}
function showError(msg) { $('error').textContent = msg || ''; }
function hideMenu(hud) {
  $('menu').classList.add('hidden');
  $('hud').style.display = 'block';
  $('hud').innerHTML = hud;
}
function renderPlayerDots(count, mine = -1) {
  $('players').innerHTML = Array.from({ length: MAX_PLAYERS }, (_, i) =>
    `<div class="dot" style="${i < count ? `background:${colorCss(i)}` : ''}${i === mine ? ';outline:3px solid #fff' : ''}"></div>`).join('');
}

// ---------- host / local loop (runs the physics) ----------
function startHostLoop({ n, net, local, hud }) {
  const sim = createSim(n);
  const view = createView(n, local ? -1 : 0);
  hideMenu(hud);

  let acc = 0, last = performance.now(), tick = 0;
  const acks = []; // last input sequence number applied per joiner, echoed back so they can replay the rest
  const wander = new Map(); // idle players in the local chain test just stumble around

  function hostTick() {
    if (local) {
      sim.players[0].input = readInput(SCHEME_A);
      if (n >= 2) sim.players[1].input = readInput(SCHEME_B);
      for (let i = 2; i < n; i++) {
        let w = wander.get(i);
        if (!w || performance.now() > w.until) {
          w = { x: Math.random() * 2 - 1, z: Math.random() * 2 - 1, jump: Math.random() < 0.15, until: performance.now() + 800 + Math.random() * 1500 };
          wander.set(i, w);
        }
        sim.players[i].input = w;
      }
    } else {
      sim.players[0].input = readInput(SCHEME_ONLINE); // joiners' inputs arrive via the network
    }
    sim.step();
    if (net && ++tick % 3 === 0) net.broadcast(sim.state(), acks); // 20 Hz
  }

  function update(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    acc += dt;
    while (acc >= STEP) { hostTick(); acc -= STEP; }
    view.apply(sim.pose());
    view.render(dt, now);
  }
  const frame = (now) => { requestAnimationFrame(frame); update(now); };
  requestAnimationFrame(frame);
  game = window.__game = { role: local ? 'local' : 'host', sim, view, hostTick, update, net, acks }; // window hook is for console testing
  return sim;
}

// ---------- client loop (client-side prediction) ----------
// The client runs its own copy of the simulation so your own input responds instantly. Every host
// snapshot carries the full state plus the last input the host had applied for us. We load that
// state, replay the inputs the host hasn't seen yet, and fade away whatever error is left.
const SMOOTH_TIME = 0.1; // seconds for a correction to fade out
const TELEPORT_DIST = 3; // bigger jumps than this (a reset, say) snap instead of fading
const MAX_REPLAY = 60; // ticks

function startClientLoop({ n, index, conn, hooks }) {
  const sim = createSim(n);
  const view = createView(n, index);
  hideMenu(`<b>ROPE HEIST</b><br><span style="color:${colorCss(index)}">You are player ${index + 1}</span> &nbsp; WASD / arrows + Space`);

  const L = layout(n);
  // which entries of the pose array are positions (x y z) and so can carry a smoothing offset
  const isPos = new Uint8Array(L.size);
  for (let i = 0; i < n; i++) isPos.fill(1, L.pOff + i * 4, L.pOff + i * 4 + 3);
  isPos.fill(1, L.rOff, L.cOff);
  for (let i = 0; i < L.crates; i++) isPos.fill(1, L.cOff + i * 7, L.cOff + i * 7 + 3);

  let seq = 0;
  const history = new Map(); // seq -> input we used on that tick
  const offset = new Array(L.size).fill(0);
  let shown = sim.pose(); // what was last drawn
  let acc = 0, last = performance.now();
  const stats = { snapshots: 0, replayed: 0, lastError: 0, maxError: 0 };

  function clientTick() {
    seq++;
    const input = readInput(SCHEME_ONLINE);
    history.set(seq, input);
    history.delete(seq - MAX_REPLAY - 5);
    sim.players[index].input = input;
    conn.sendInput([input.x, input.z, input.jump ? 1 : 0], seq);
    sim.step();
  }

  function onSnapshot(d, ack) {
    // 1. roll back to the host's state (this also loads everyone's last known input)
    sim.loadState(d);
    // 2. replay our own inputs that the host hasn't applied yet
    for (let s = Math.max(ack + 1, seq - MAX_REPLAY + 1); s <= seq; s++) {
      sim.players[index].input = history.get(s) ?? sim.players[index].input;
      sim.step();
    }
    stats.snapshots++;
    stats.replayed += seq - ack;
    // 3. whatever we were drawing vs where we now think things are becomes a fading offset
    const pose = sim.pose();
    let worst = 0;
    for (let i = 0; i < L.size; i++) if (isPos[i]) worst = Math.max(worst, Math.abs(shown[i] - pose[i]));
    stats.lastError = worst;
    stats.maxError = Math.max(stats.maxError, worst);
    for (let i = 0; i < L.size; i++) offset[i] = isPos[i] && worst < TELEPORT_DIST ? shown[i] - pose[i] : 0;
  }
  hooks.onSnap = onSnapshot;

  function update(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    acc += dt;
    while (acc >= STEP) { clientTick(); acc -= STEP; }
    const pose = sim.pose();
    const fade = Math.exp(-dt / SMOOTH_TIME);
    for (let i = 0; i < L.size; i++) {
      if (isPos[i]) { offset[i] *= fade; pose[i] += offset[i]; }
    }
    shown = pose;
    view.apply(pose);
    view.render(dt, now);
  }
  const frame = (now) => { requestAnimationFrame(frame); update(now); };
  requestAnimationFrame(frame);
  game = window.__game = { role: 'client', sim, view, conn, update, clientTick, stats, offset, get seq() { return seq; } };
}

// ---------- menu wiring ----------
async function hostOnline() {
  showError('');
  $('b-host').disabled = true;
  try {
    let net;
    net = await createHost({
      onLobby(count) {
        renderPlayerDots(count, 0);
        $('lobby-status').textContent = count < 2 ? 'Waiting for friends to join…' : `${count} players ready`;
        $('b-start').disabled = count < 2;
      },
      onInput(i, d, q) {
        if (!game?.sim) return;
        game.sim.players[i].input = { x: d[0], z: d[1], jump: !!d[2] };
        game.acks[i] = q;
      },
      onLeave(i) { if (game?.sim) game.sim.players[i].input = { x: 0, z: 0, jump: false }; },
    });
    const link = `${location.origin}${location.pathname}?join=${net.code}`;
    $('lobby-code').textContent = net.code;
    $('lobby-link').textContent = link;
    $('lobby-title').textContent = 'Share this code (or link)';
    renderPlayerDots(1, 0);
    $('lobby-status').textContent = 'Waiting for friends to join…';
    $('b-start').disabled = true;
    $('b-start').onclick = () => {
      const n = net.start();
      startHostLoop({ n, net, local: false, hud: `<b>ROPE HEIST</b> &nbsp; room <b>${net.code}</b> &nbsp; ${n} players<br><span style="color:${colorCss(0)}">You are player 1</span> &nbsp; WASD / arrows + Space &nbsp; R: reset` });
    };
    showPanel('p-lobby');
  } catch (err) {
    showError(`Could not host: ${err.message || err.type}`);
  } finally {
    $('b-host').disabled = false;
  }
}

async function joinOnline(code) {
  showError('');
  if (code.trim().length !== 4) return showError('Enter the 4-letter room code');
  $('b-join').disabled = true;
  $('b-join').textContent = 'Joining…';
  const hooks = { onSnap: () => {} }; // filled in once the game starts
  let conn = null;
  try {
    conn = await joinRoom(code, {
      onLobby(count) {
        renderPlayerDots(count);
        $('lobby-status').textContent = `${count} players in the room. Waiting for the host to start…`;
      },
      onStart({ n, index }) { startClientLoop({ n, index, conn, hooks }); },
      onSnap(d, ack) { hooks.onSnap(d, ack); },
      onClose() {
        $('hud').innerHTML += '<br><b style="color:#ff8a8a">Disconnected from host.</b> Reload to rejoin.';
        if (!game) { showPanel('p-main'); showError('Host closed the room'); }
      },
      onFull() { showPanel('p-main'); showError('That room is full or already started'); },
    });
    $('lobby-title').textContent = 'Joined room';
    $('lobby-code').textContent = code.trim().toUpperCase();
    $('lobby-link').textContent = '';
    $('b-start').style.display = 'none';
    $('lobby-status').textContent = 'Connected. Waiting for the host to start…';
    showPanel('p-lobby');
  } catch (err) {
    showError(err.message || String(err.type));
  } finally {
    $('b-join').disabled = false;
    $('b-join').textContent = 'Join with code';
  }
}

await initPhysics();

$('b-host').onclick = hostOnline;
$('b-join').onclick = () => joinOnline($('in-code').value);
$('in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinOnline($('in-code').value); e.stopPropagation(); });
$('in-code').addEventListener('keyup', (e) => e.stopPropagation());
$('b-local').onclick = () => startHostLoop({ n: 2, local: true, hud: '<b>ROPE HEIST</b> &mdash; local test<br><span style="color:#ff7a59">P1</span>: WASD + Space &nbsp; <span style="color:#59c3ff">P2</span>: Arrows + Enter &nbsp; R: reset' });
$('b-chain').onclick = () => startHostLoop({ n: 4, local: true, hud: '<b>ROPE HEIST</b> &mdash; 4-player chain test (P3 and P4 stumble around by themselves)<br><span style="color:#ff7a59">P1</span>: WASD + Space &nbsp; <span style="color:#59c3ff">P2</span>: Arrows + Enter &nbsp; R: reset' });

// share links look like ?join=ABCD
const joinParam = new URLSearchParams(location.search).get('join');
if (joinParam) {
  $('in-code').value = joinParam.slice(0, 4).toUpperCase();
  joinOnline(joinParam);
}
