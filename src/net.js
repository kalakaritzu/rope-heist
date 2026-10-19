// Peer-to-peer networking over WebRTC (PeerJS). The host runs the physics; clients send inputs and
// receive snapshots. PeerJS's free public cloud server is only used to introduce peers to each other.
import Peer from 'peerjs';
import { EMOTES, resolveProfiles } from './profile.js';

const PREFIX = 'rope-heist-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomCode = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

// Testing aid: ?lag=100 delays this client's traffic by 100 ms each way (200 ms round trip).
const LAG_MS = Number(new URLSearchParams(location.search).get('lag')) || 0;
const delayed = (fn) => (LAG_MS ? setTimeout(fn, LAG_MS) : fn());

const EMOTE_MIN_GAP_MS = 300; // the host ignores emote spam
const validEmote = (e) => Number.isInteger(e) && e >= 0 && e < EMOTES.length;

function openPeer(id) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const peer = new Peer(id);
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
export async function createHost({ onLobby, onInput, onLeave, onEmote }, myProfile, maxPlayers = 4) {
  const conns = []; // each connection carries its player's profile as conn.profile
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

  const profiles = () => resolveProfiles([myProfile, ...conns.map((c) => c.profile)]);
  const sendLobby = () => {
    const players = profiles();
    onLobby(players);
    for (const c of conns) if (c.open) c.send({ t: 'lobby', players });
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
      conns.forEach((c, i) => c.send({ t: 'start', n: players.length, index: i + 1, players }));
      return { n: players.length, players };
    },
    /** Send the full state to everyone. acks[playerIndex] = last input sequence number we applied for them. */
    broadcast(state, acks) {
      conns.forEach((c, i) => { if (c.open) c.send({ t: 's', d: state, a: acks[i + 1] || 0 }); });
    },
    emote(e) { if (validEmote(e)) relayEmote(0, e); },
    close() { peer.destroy(); },
  };
}

/**
 * Client side. handlers: onLobby(profiles), onStart({ n, index, players }), onSnap(state, ackedSeq),
 * onEmote(playerIndex, emoteId), onClose(), onFull()
 */
export function joinRoom(code, { onLobby, onStart, onSnap, onEmote, onClose, onFull }, myProfile) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const peer = new Peer();
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
          sendInput(input, seq) { delayed(() => { if (conn.open) conn.send({ t: 'in', d: input, q: seq }); }); },
          sendEmote(e) { delayed(() => { if (conn.open) conn.send({ t: 'emote', e }); }); },
          close() { peer.destroy(); },
        });
      });
      conn.on('data', (m) => {
        if (!m) return;
        if (m.t === 's') delayed(() => onSnap(m.d, m.a));
        else if (m.t === 'lobby') onLobby(resolveProfiles(m.players || []));
        else if (m.t === 'start') onStart({ n: m.n, index: m.index, players: resolveProfiles(m.players || []) });
        else if (m.t === 'emote' && validEmote(m.e) && Number.isInteger(m.i)) delayed(() => onEmote(m.i, m.e));
        else if (m.t === 'full') onFull();
      });
      conn.on('close', () => onClose());
    });
  });
}
