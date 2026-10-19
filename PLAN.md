# Rope Heist: plan

Co-op "friendslop" heist game. 2-4 crooks are tied together by one physics rope while robbing a building.
Browser game: Three.js + Rapier physics, peer-to-peer multiplayer (WebRTC), hosted free on GitHub Pages.

## Design pillars
1. **The rope is a tool.** Swing across gaps, lower a friend down a vent, yank someone out of a laser, wrap it round a pillar.
2. **The rope is a liability.** It snags on doors, knocks over vases, trips guards. Too much tension sets off alarms.
3. **Wobbly loot.** Oversized stolen items (giant painting, grandfather clock, a live pig) must be carried together.
4. **Guards react to the rope.** They can grab and reel you in; you can tie them up.
5. **Dead-simple controls.** Move, jump, grab, yank. Complexity comes from friends, not buttons.

## Tech
- Vite + Three.js (low-poly flat-shaded look) + Rapier WASM (`@dimforge/rapier3d-compat`)
- PeerJS (WebRTC) for P2P: host runs physics, clients send inputs and receive snapshots. No backend, no Firebase.
- Proximity voice chat over WebRTC audio, volume by distance.
- Deploy: GitHub Actions -> GitHub Pages (`.github/workflows/deploy.yml`).

## Phases
- [x] **Phase 0: Scaffold.** Vite project, deploy workflow, this plan.
- [x] **Phase 1: Rope prototype.** Two local players, physics rope, crates and pillars to snag it. Playtested: feels good.
- [x] **Phase 4 (pulled forward): Multiplayer.** Rope is now a chain for 2-4 players. PeerJS room codes + share link, lobby, host-authoritative physics (60 Hz), 20 Hz snapshots, 100 ms interpolation on clients. Code split into `sim.js` / `view.js` / `net.js` / `main.js`.
  - **Client-side prediction (done):** each client runs its own copy of the sim. Host snapshots carry full state plus an input ack; the client rolls back, replays unacknowledged inputs, and fades the leftover error over 100 ms. Test with `?lag=100` on the joiner's URL (adds 100 ms each way). Measured at 200 ms round trip: own movement shows after 36 ms, median error 0.1 units, host and client converge to within 0.002 after everyone stops.
  - Known gaps: other players are predicted by holding their last input, so they visibly correct when they change direction under high lag; no mid-game join; no host migration; no TURN server (some strict networks will fail to connect); JSON snapshots (about 134 KB/s host upload at 4 players, could go binary); only tested with simulated lag on one machine.
- [ ] **Phase 2: Core verbs.** Grab/carry objects, yank, tie rope around a pillar, camera polish.
- [ ] **Phase 3: Heist level.** One building: entry, loot target, guard patrol, exit, timer, win/lose.
- [ ] **Phase 5: Proximity voice + identity.** Voice chat, nametags, colours, emotes.
- [ ] **Phase 6: Content and polish.** More levels and loot, alarms/lasers, sound, clip-friendly fail states, mobile/gamepad.
- [ ] **Phase 7: Public launch.** Playtest with friends, fix desync, share link.

## Risks
- **Rope physics** (stability, tension, network sync): prototype first, run on host only, sync positions.
- **P2P reliability:** NAT traversal can fail without a TURN server. Plan: public STUN by default, optional TURN later.
- **Desync:** keep the host authoritative and snapshot at about 20 Hz with interpolation on clients.
