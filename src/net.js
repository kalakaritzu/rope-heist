// Peer-to-peer networking over WebRTC (PeerJS). The host runs the physics; clients send inputs and
// receive snapshots. PeerJS's free public cloud server is only used to introduce peers to each other.
import Peer from 'peerjs';
import { EMOTES, resolveProfiles } from './profile.js';

const PREFIX = 'rope-heist-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomCode = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

// Testing aids, set in the page address: ?lag=100 delays this client's traffic by 100 ms each way,
// &jitter=60 adds up to 60 ms of random extra delay (so messages can arrive out of order),
// &loss=5 drops 5% of the snapshots and inputs.
const query = new URLSearchParams(location.search);
const LAG_MS = Number(query.get('lag')) || 0;
const JITTER_MS = Number(query.get('jitter')) || 0;
const LOSS_PERCENT = Number(query.get('loss')) || 0;
/** Runs fn after the simulated delay. Droppable messages may be thrown away to simulate packet loss. */
function delayed(fn, droppable = false) {
  if (droppable && LOSS_PERCENT > 0 && Math.random() * 100 < LOSS_PERCENT) return;
  const wait = LAG_MS + (JITTER_MS ? Math.random() * JITTER_MS : 0);
  if (wait > 0) setTimeout(fn, wait);
  else fn();
}

// ---------- connection settings ----------
// Free public STUN servers are enough for most home networks. Some strict networks (company, school, mobile
// carriers) need a TURN relay as well. If a file called ice-config.json sits next to index.html, e.g.
//   { "iceServers": [{ "urls": "turn:example.com:3478", "username": "...", "credential": "..." }] }
// its servers are added. See README.md. Nothing happens when the file is missing.
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }];
let iceConfig = null;
async function peerOptions() {
  iceConfig ??= (async () => {
    try {
      const res = await fetch('./ice-config.json', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const json = await res.json();
      return Array.isArray(json.iceServers) ? json.iceServers : null;
    } catch { return null; }
  })();
  const extra = await iceConfig;
  return { config: { iceServers: [...DEFAULT_ICE, ...(extra ?? [])] } };
}

const EMOTE_MIN_GAP_MS = 300; // the host ignores emote spam
const validEmote = (e) => Number.isInteger(e) && e >= 0 && e < EMOTES.length;

async function openPeer(id) {
  const options = await peerOptions();
  return new Promise((resolve, reject) => {
    let settled = false;
    const peer = new Peer(id, options);
    peer.on('open', () => { settled = true; resolve(peer); });
    peer.on('error', (err) => {
      if (settled) { console.warn('peer error', err); return; }
      settled = true;
      peer.destroy();
      reject(err);
    });
  });
}

/**
 * Host side. Player 0 is the host, joiners are 1..3 in join order.
 * handlers: onLobby(profiles), onInput(playerIndex, [x, z, jump, ...], seq), onLeave(playerIndex), onEmote(playerIndex, emoteId)
 * myProfile: { name, color }
 */
export async function createHost({ onLobby, onInput, onLeave, onEmote }, myProfile, level = 0, maxPlayers = 4) {
  const conns = []; // each connection carries its player's profile as conn.profile
  let snapshotSeq = 0; // numbers every snapshot so clients can drop ones that arrive late
  let started = false;
  let peer = null;
  let code = '';
  for (let attempt = 0; attempt < 5 && !peer; attempt++) {
    code = randomCode();
    try {
      peer = await openPeer(PREFIX + code);
    } catch (err) {
      if (err.type !== 'unavailable-id') throw err; // code already taken, try another
    }
  }
  if (!peer) throw new Error('Could not reserve a room code, try again');

  // The signalling server drops idle connections. Without this the room stays alive for the people already in it,
  // but anyone new gets "Room not found". Re-register the same room code whenever we are cut off.
  peer.on('disconnected', () => {
    const retry = () => {
      if (peer.destroyed) return;
      peer.reconnect();
      setTimeout(() => { if (!peer.destroyed && peer.disconnected) retry(); }, 3000);
    };
    setTimeout(retry, 500);
  });

  const profiles = () => resolveProfiles([myProfile, ...conns.map((c) => c.profile)]);
  const sendLobby = () => {
    const players = profiles();
    onLobby(players);
    for (const c of conns) if (c.open) c.send({ t: 'lobby', players, level });
  };

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      if (started || conns.length >= maxPlayers - 1) {
        conn.send({ t: 'full' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      conn.profile = { name: '', color: 0 }; // replaced by the 'hello' message
      conn.lastEmote = 0;
      conn.lastSeq = 0; // the newest input we have applied: the channel can deliver messages late or out of order
      conns.push(conn);
      sendLobby();
    });
    conn.on('data', (m) => {
      const i = conns.indexOf(conn);
      if (i < 0 || !m) return;
      if (m.t === 'hello') {
        conn.profile = { name: m.name, color: m.color };
        if (!started) sendLobby();
      } else if (started && m.t === 'in') {
        if (!(m.q > conn.lastSeq)) return; // an older input arriving after a newer one: ignore it
        conn.lastSeq = m.q;
        onInput(i + 1, m.d, m.q);
      } else if (started && m.t === 'emote' && validEmote(m.e)) {
        const now = Date.now();
        if (now - conn.lastEmote < EMOTE_MIN_GAP_MS) return;
        conn.lastEmote = now;
        relayEmote(i + 1, m.e);
      }
    });
    conn.on('close', () => {
      const i = conns.indexOf(conn);
      if (i < 0) return;
      if (started) {
        onLeave(i + 1); // keep the slot so player indices stay stable during the game
      } else {
        conns.splice(i, 1);
        sendLobby();
      }
    });
  });

  /** Everyone, including the host's own screen, sees every emote. */
  function relayEmote(playerIndex, e) {
    onEmote(playerIndex, e);
    for (const c of conns) if (c.open) c.send({ t: 'emote', i: playerIndex, e });
  }

  return {
    code,
    get playerCount() { return 1 + conns.length; },
    profiles,
    start() {
      started = true;
      const players = profiles();
      conns.forEach((c, i) => c.send({ t: 'start', n: players.length, index: i + 1, players, level }));
      return { n: players.length, players, level };
    },
    /** Send the full state to everyone. acks[playerIndex] = last input sequence number we applied for them. */
    broadcast(state, acks) {
      snapshotSeq++;
      conns.forEach((c, i) => { if (c.open) c.send({ t: 's', d: state, a: acks[i + 1] || 0, k: snapshotSeq }); });
    },
    emote(e) { if (validEmote(e)) relayEmote(0, e); },
    close() { peer.destroy(); },
    peer, // exposed for tests: lets them cut the signalling connection on purpose
  };
}

/**
 * Client side. handlers: onLobby(profiles, level), onStart({ n, index, players, level }), onSnap(state, ackedSeq),
 * onEmote(playerIndex, emoteId), onClose(), onFull()
 */
export async function joinRoom(code, { onLobby, onStart, onSnap, onEmote, onClose, onFull }, myProfile) {
  const options = await peerOptions();
  return new Promise((resolve, reject) => {
    let settled = false;
    let newestSnapshot = 0;
    const peer = new Peer(undefined, options);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new Error('Timed out. Check the code. The host may be behind a strict firewall.')),
      12000,
    );
    peer.on('error', (err) => {
      if (settled) { console.warn('peer error', err); return; }
      fail(err.type === 'peer-unavailable' ? new Error('Room not found, check the code') : err);
    });
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code.trim().toUpperCase(), { serialization: 'json' });
      conn.on('open', () => {
        settled = true;
        clearTimeout(timer);
        conn.send({ t: 'hello', name: myProfile.name, color: myProfile.color });
        resolve({
          sendInput(input, seq) { delayed(() => { if (conn.open) conn.send({ t: 'in', d: input, q: seq }); }, true); },
          sendEmote(e) { delayed(() => { if (conn.open) conn.send({ t: 'emote', e }); }); },
          close() { peer.destroy(); },
        });
      });
      conn.on('data', (m) => {
        if (!m) return;
        if (m.t === 's') {
          delayed(() => {
            if (!(m.k > newestSnapshot)) return; // older than one we already applied: ignore it
            newestSnapshot = m.k;
            onSnap(m.d, m.a);
          }, true);
        }
        else if (m.t === 'lobby') onLobby(resolveProfiles(m.players || []), Number.isInteger(m.level) ? m.level : 0);
        else if (m.t === 'start') onStart({ n: m.n, index: m.index, players: resolveProfiles(m.players || []), level: Number.isInteger(m.level) ? m.level : 0 });
        else if (m.t === 'emote' && validEmote(m.e) && Number.isInteger(m.i)) delayed(() => onEmote(m.i, m.e));
        else if (m.t === 'full') onFull();
      });
      conn.on('close', () => onClose());
    });
  });
}
