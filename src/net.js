// Peer-to-peer networking over WebRTC (PeerJS). The host runs the physics; clients send inputs and
// receive snapshots. PeerJS's free public cloud server is only used to introduce peers to each other.
import Peer from 'peerjs';

const PREFIX = 'rope-heist-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomCode = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

// Testing aid: ?lag=100 delays this client's traffic by 100 ms each way (200 ms round trip).
const LAG_MS = Number(new URLSearchParams(location.search).get('lag')) || 0;
const delayed = (fn) => (LAG_MS ? setTimeout(fn, LAG_MS) : fn());

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
 * Host side. handlers: onLobby(count), onInput(playerIndex, [x, z, jump], seq), onLeave(playerIndex).
 * Player 0 is the host, joiners are 1..3 in join order.
 */
export async function createHost({ onLobby, onInput, onLeave }, maxPlayers = 4) {
  const conns = [];
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

  const sendLobby = () => {
    const count = 1 + conns.length;
    onLobby(count);
    for (const c of conns) if (c.open) c.send({ t: 'lobby', count });
  };

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      if (started || conns.length >= maxPlayers - 1) {
        conn.send({ t: 'full' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      conns.push(conn);
      sendLobby();
    });
    conn.on('data', (m) => {
      const i = conns.indexOf(conn);
      if (started && i >= 0 && m && m.t === 'in') onInput(i + 1, m.d, m.q);
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

  return {
    code,
    get playerCount() { return 1 + conns.length; },
    start() {
      started = true;
      const n = 1 + conns.length;
      conns.forEach((c, i) => c.send({ t: 'start', n, index: i + 1 }));
      return n;
    },
    /** Send the full state to everyone. acks[playerIndex] = last input sequence number we applied for them. */
    broadcast(state, acks) {
      conns.forEach((c, i) => { if (c.open) c.send({ t: 's', d: state, a: acks[i + 1] || 0 }); });
    },
    close() { peer.destroy(); },
  };
}

/** Client side. handlers: onLobby(count), onStart({ n, index }), onSnap(state, ackedSeq), onClose(), onFull(). */
export function joinRoom(code, { onLobby, onStart, onSnap, onClose, onFull }) {
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
        resolve({
          sendInput(input, seq) { delayed(() => { if (conn.open) conn.send({ t: 'in', d: input, q: seq }); }); },
          close() { peer.destroy(); },
        });
      });
      conn.on('data', (m) => {
        if (!m) return;
        if (m.t === 's') delayed(() => onSnap(m.d, m.a));
        else if (m.t === 'lobby') onLobby(m.count);
        else if (m.t === 'start') onStart({ n: m.n, index: m.index });
        else if (m.t === 'full') onFull();
      });
      conn.on('close', () => onClose());
    });
  });
}
