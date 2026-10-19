import { initPhysics, createSim, layout, inputToArray, inputFromArray, STEP, MAX_PLAYERS } from './sim.js';
import { createView } from './view.js';
import { createHost, joinRoom } from './net.js';
import { PALETTE, EMOTES, colorCss, cleanName, loadSavedProfile, saveProfile } from './profile.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- input ----------
const keysDown = new Set();
addEventListener('keydown', (e) => {
  keysDown.add(e.code);
  if (e.code === 'KeyR' && game?.role !== 'client' && game?.sim) game.sim.resetAll();
  if (/^Digit[1-4]$/.test(e.code) && !e.repeat) emote(Number(e.code.slice(5)) - 1);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keysDown.delete(e.code));
addEventListener('blur', () => keysDown.clear());

const anyDown = (codes) => codes.some((c) => keysDown.has(c));
function readInput(scheme) {
  const x = (anyDown(scheme.right) ? 1 : 0) - (anyDown(scheme.left) ? 1 : 0);
  const z = (anyDown(scheme.down) ? 1 : 0) - (anyDown(scheme.up) ? 1 : 0);
  return { x, z, jump: anyDown(scheme.jump), grab: anyDown(scheme.grab), yank: anyDown(scheme.yank), tie: anyDown(scheme.tie) };
}
const SCHEME_A = { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], jump: ['Space'], grab: ['KeyE'], yank: ['KeyF'], tie: ['KeyQ'] };
const SCHEME_B = { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], jump: ['Enter'], grab: ['Period'], yank: ['Slash'], tie: ['Comma'] };
// online you only control one player, so either hand works
const SCHEME_ONLINE = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space', 'Enter'], grab: ['KeyE', 'Period'], yank: ['KeyF', 'Slash'], tie: ['KeyQ', 'Comma'],
};
const CONTROLS_HINT = 'WASD move &middot; Space jump &middot; <b>E</b> hold to grab &middot; <b>F</b> yank rope &middot; <b>Q</b> tie to pillar &middot; <b>1-4</b> emotes ' + EMOTES.join(' ');

// ---------- emotes ----------
const EMOTE_COOLDOWN_MS = 700;
let lastEmote = 0;
function emote(id) {
  const now = performance.now();
  if (!game?.sendEmote || now - lastEmote < EMOTE_COOLDOWN_MS) return;
  lastEmote = now;
  game.sendEmote(id);
}

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
  $('game').style.display = 'block';
}

const LOSS_REASON = { 1: 'The alarm went off', 2: 'Out of time' };
/** Timer, alert meter and win/lose banner, read from the pose array's game section. */
function updateGameHud(d, L) {
  const status = d[L.sOff], reason = d[L.sOff + 1], secs = d[L.sOff + 2], alert = d[L.sOff + 3];
  $('timer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  $('timer').classList.toggle('low', secs <= 20 && status === 0);
  $('alertfill').style.width = `${alert}%`;
  const banner = $('banner');
  banner.className = status === 0 ? '' : `show ${status === 1 ? 'won' : 'lost'}`;
  if (status !== 0) {
    $('banner-title').textContent = status === 1 ? 'HEIST COMPLETE' : 'BUSTED';
    $('banner-sub').textContent = `${status === 1 ? 'You got away with the safe' : LOSS_REASON[reason] || ''}. Restarting shortly...`;
  }
}
/** The lobby list. Names are other people's input, so they only ever go in through textContent. */
function renderLobby(players, mine = -1) {
  $('players').replaceChildren(...Array.from({ length: MAX_PLAYERS }, (_, i) => {
    const row = document.createElement('div');
    row.className = players[i] ? 'prow' : 'prow empty';
    const dot = document.createElement('span');
    dot.className = 'dot';
    if (players[i]) dot.style.background = colorCss(players[i].color);
    const name = document.createElement('span');
    name.textContent = players[i] ? players[i].name + (i === 0 ? ' (host)' : '') + (i === mine ? ' (you)' : '') : 'waiting for a friend...';
    row.append(dot, name);
    return row;
  }));
}

// ---------- your name and colour ----------
let selectedColor = 0;
function readProfile() {
  const profile = { name: cleanName($('in-name').value, ''), color: selectedColor };
  saveProfile(profile);
  return profile;
}
function buildProfilePicker() {
  const saved = loadSavedProfile();
  $('in-name').value = saved.name;
  selectedColor = saved.color;
  const box = $('swatches');
  PALETTE.forEach((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw';
    b.style.background = colorCss(i);
    b.setAttribute('aria-label', `Colour ${i + 1}`);
    b.onclick = () => { selectedColor = i; refresh(); };
    box.append(b);
  });
  const refresh = () => [...box.children].forEach((b, i) => b.classList.toggle('on', i === selectedColor));
  refresh();
}

// ---------- host / local loop (runs the physics) ----------
function startHostLoop({ n, net, local, hud, profiles }) {
  const sim = createSim(n);
  const view = createView(n, local ? -1 : 0, profiles);
  const L = layout(n);
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
          w = { x: Math.random() * 2 - 1, z: Math.random() * 2 - 1, jump: Math.random() < 0.15, grab: false, yank: false, tie: false, until: performance.now() + 800 + Math.random() * 1500 };
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
    const pose = sim.pose();
    view.apply(pose);
    updateGameHud(pose, L);
    view.render(dt, now);
  }
  const frame = (now) => { requestAnimationFrame(frame); update(now); };
  requestAnimationFrame(frame);
  const sendEmote = (id) => (net ? net.emote(id) : view.showEmote(0, id)); // online the host relays it to everyone, itself included
  game = window.__game = { role: local ? 'local' : 'host', sim, view, hostTick, update, net, acks, sendEmote, profiles }; // window hook is for console testing
  return sim;
}

// ---------- client loop (client-side prediction) ----------
// The client runs its own copy of the simulation so your own input responds instantly. Every host
// snapshot carries the full state plus the last input the host had applied for us. We load that
// state, replay the inputs the host hasn't seen yet, and fade away whatever error is left.
const SMOOTH_TIME = 0.1; // seconds for a correction to fade out
const TELEPORT_DIST = 3; // bigger jumps than this (a reset, say) snap instead of fading
const MAX_REPLAY = 60; // ticks

function startClientLoop({ n, index, conn, hooks, profiles }) {
  const sim = createSim(n);
  const view = createView(n, index, profiles);
  hideMenu(`<b>ROPE HEIST</b><br><span style="color:${colorCss(profiles[index].color)}">You are ${esc(profiles[index].name)}</span><br>${CONTROLS_HINT}`);

  const L = layout(n);
  // which entries of the pose array are positions (x y z) and so can carry a smoothing offset
  const isPos = new Uint8Array(L.size);
  for (let i = 0; i < n; i++) isPos.fill(1, L.pOff + i * 4, L.pOff + i * 4 + 3);
  isPos.fill(1, L.rOff, L.cOff);
  for (let i = 0; i < L.guards; i++) isPos.fill(1, L.gOff + i * 5, L.gOff + i * 5 + 3);
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
    conn.sendInput(inputToArray(input), seq);
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
  hooks.onEmote = (i, e) => { if (i !== index) view.showEmote(i, e); }; // our own already popped up the moment we pressed the key

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
    updateGameHud(pose, L);
    view.render(dt, now);
  }
  const frame = (now) => { requestAnimationFrame(frame); update(now); };
  requestAnimationFrame(frame);
  const sendEmote = (id) => { view.showEmote(index, id); conn.sendEmote(id); };
  game = window.__game = { role: 'client', sim, view, conn, update, clientTick, stats, offset, sendEmote, profiles, get seq() { return seq; } };
}

// ---------- menu wiring ----------
async function hostOnline() {
  showError('');
  $('b-host').disabled = true;
  try {
    let net;
    net = await createHost({
      onLobby(players) {
        renderLobby(players, 0);
        $('lobby-status').textContent = players.length < 2 ? 'Waiting for friends to join…' : `${players.length} players ready`;
        $('b-start').disabled = players.length < 2;
      },
      onInput(i, d, q) {
        if (!game?.sim) return;
        game.sim.players[i].input = inputFromArray(d);
        game.acks[i] = q;
      },
      onLeave(i) { if (game?.sim) game.sim.players[i].input = inputFromArray([0, 0, 0, 0, 0, 0]); },
      onEmote(i, e) { game?.view?.showEmote(i, e); },
    }, readProfile());
    const link = `${location.origin}${location.pathname}?join=${net.code}`;
    $('lobby-code').textContent = net.code;
    $('lobby-link').textContent = link;
    $('lobby-title').textContent = 'Share this code (or link)';
    renderLobby(net.profiles(), 0);
    $('lobby-status').textContent = 'Waiting for friends to join…';
    $('b-start').disabled = true;
    $('b-start').onclick = () => {
      const { n, players } = net.start();
      startHostLoop({ n, net, local: false, profiles: players, hud: `<b>ROPE HEIST</b> &nbsp; room <b>${net.code}</b> &nbsp; ${n} players<br><span style="color:${colorCss(players[0].color)}">You are ${esc(players[0].name)}</span> &nbsp; R: reset<br>${CONTROLS_HINT}` });
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
  const hooks = { onSnap: () => {}, onEmote: () => {} }; // filled in once the game starts
  let conn = null;
  try {
    conn = await joinRoom(code, {
      onLobby(players) {
        renderLobby(players);
        $('lobby-status').textContent = `${players.length} players in the room. Waiting for the host to start…`;
      },
      onStart({ n, index, players }) { startClientLoop({ n, index, conn, hooks, profiles: players }); },
      onSnap(d, ack) { hooks.onSnap(d, ack); },
      onEmote(i, e) { hooks.onEmote(i, e); },
      onClose() {
        $('hud').innerHTML += '<br><b style="color:#ff8a8a">Disconnected from host.</b> Reload to rejoin.';
        if (!game) { showPanel('p-main'); showError('Host closed the room'); }
      },
      onFull() { showPanel('p-main'); showError('That room is full or already started'); },
    }, readProfile());
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
$('in-name').addEventListener('keydown', (e) => e.stopPropagation()); // typing a name must not trigger emotes or movement
$('in-name').addEventListener('keyup', (e) => e.stopPropagation());
buildProfilePicker();
const LOCAL_PROFILES = [{ name: 'P1', color: 0 }, { name: 'P2', color: 1 }, { name: 'P3', color: 2 }, { name: 'P4', color: 3 }];
$('b-local').onclick = () => startHostLoop({ n: 2, local: true, profiles: LOCAL_PROFILES, hud: '<b>ROPE HEIST</b> &mdash; local test &nbsp; R: reset<br><span style="color:#ff7a59">P1</span>: WASD, Space, E grab, F yank, Q tie<br><span style="color:#59c3ff">P2</span>: Arrows, Enter, . grab, / yank, , tie' });
$('b-chain').onclick = () => startHostLoop({ n: 4, local: true, profiles: LOCAL_PROFILES, hud: '<b>ROPE HEIST</b> &mdash; 4-player chain test (P3 and P4 stumble around by themselves) &nbsp; R: reset<br><span style="color:#ff7a59">P1</span>: WASD, Space, E grab, F yank, Q tie<br><span style="color:#59c3ff">P2</span>: Arrows, Enter, . grab, / yank, , tie' });

// share links look like ?join=ABCD
const joinParam = new URLSearchParams(location.search).get('join');
if (joinParam) {
  $('in-code').value = joinParam.slice(0, 4).toUpperCase();
  joinOnline(joinParam);
}
