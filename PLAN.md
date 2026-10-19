# Rope Heist: plan

Co-op "friendslop" heist game. 2-4 crooks are tied together by one physics rope while robbing a building.
Browser game: Three.js + Rapier physics, peer-to-peer multiplayer (WebRTC), hosted free on GitHub Pages.

## Design pillars
1. **The rope is a tool.** Swing across gaps, lower a friend down a vent, wrap it round a pillar.
2. **The rope is a liability.** It snags on doors, knocks over vases, trips guards. Too much tension sets off alarms.
3. **Wobbly loot.** Oversized stolen items (giant painting, grandfather clock, a live pig) must be carried together.
4. **Guards react to the rope.** They can grab and reel you in; you can tie them up.
5. **Dead-simple controls.** Move, jump, grab, tie. Complexity comes from friends, not buttons.

## Tech
- Vite + Three.js (low-poly flat-shaded look) + Rapier WASM (`@dimforge/rapier3d-compat`)
- PeerJS (WebRTC) for P2P: host runs physics, clients send inputs and receive snapshots. No backend, no Firebase.
- Deploy: GitHub Actions -> GitHub Pages (`.github/workflows/deploy.yml`).

## Phases
- [x] **Phase 0: Scaffold.** Vite project, deploy workflow, this plan.
- [x] **Phase 1: Rope prototype.** Two local players, physics rope, crates and pillars to snag it. Playtested: feels good.
- [x] **Phase 4 (pulled forward): Multiplayer.** Rope is now a chain for 2-4 players. PeerJS room codes + share link, lobby, host-authoritative physics (60 Hz), 20 Hz snapshots, 100 ms interpolation on clients. Code split into `sim.js` / `view.js` / `net.js` / `main.js`.
  - **Client-side prediction (done):** each client runs its own copy of the sim. Host snapshots carry full state plus an input ack; the client rolls back, replays unacknowledged inputs, and fades the leftover error over 100 ms. Test with `?lag=100` on the joiner's URL (adds 100 ms each way). Measured at 200 ms round trip: own movement shows after 36 ms, median error 0.1 units, host and client converge to within 0.002 after everyone stops.
  - Known gaps: other players are predicted by holding their last input, so they visibly correct when they change direction under high lag; no mid-game join; no host migration; no TURN server (some strict networks will fail to connect); JSON snapshots (about 134 KB/s host upload at 4 players, could go binary); only tested with simulated lag on one machine.
- [x] **Phase 2: Core verbs.** All three work in the simulation, are part of the rollback state, and sync online.
  - **Grab (hold E):** pick up the nearest crate and carry it in front of you. Mass is size^3 x density. Light crates are a one-person carry; the gold safe (4.5) can't be lifted by one player (they can only drag it slowly) and needs two holders. Heavy loads slow you down and drag you.
  - **Yank (removed after playtesting feedback):** the F key that pulled your neighbour toward you was cut. The stun it used is still used when a guard shoves you.
  - **Tie (Q):** pins the loose rope segment nearest a pillar to its face (a fixed body, so the rope becomes a real anchor). Q again near the knot unties.
  - Controls: P1 `WASD Space E F Q`, local P2 `Arrows Enter . / ,`. Online, either hand works.
  - Rough edges: no kill zones or alarms yet, tie-off only works on the two pillars, held crates can clip the rope.
- [x] **Phase 3: Heist level ("The Museum").** Start in the green getaway zone, sneak through the front door and the hall, past the inner gap into the vault, and carry the gold safe (two players) back to the zone.
  - **Guards (3):** loop through waypoints, pause and look around at each one. Vision cone (8 m, about 80 degrees) with line of sight: walls and crates block it, the door gap does not. Seeing a player fills a shared ALERT meter; seeing only the rope fills it slower. After 0.6 s of continuous sight a guard chases at 3.6 u/s (players walk at 5), shoves you on contact (alert +15) and gives up 2.5 s after losing sight.
  - **Rules:** win when the safe sits in the zone for half a second. Lose when ALERT reaches 100 or the 2:30 timer runs out. The round restarts by itself 10 s after either, so clients need no button (R still resets on the host).
  - Guards, alert, timer and status are all in the rollback state, so prediction covers them (restored copies chase on the same tick). HUD: timer, alert bar, win/lose banner.
  - Rough edges: guards can't open doors or be tied up yet, no sound, one level only, the first physics tick has no sight queries (harmless), chase routing is straight-line (they can get stuck behind walls).
  - **Bot playtest (input-only bot, not a human):** the heist is beatable. Findings and fixes:
    - Vault pillars sat on the vault guard's patrol line, so the guard walked into one and stood there forever. Pillars moved, and patrolling guards now skip a waypoint after 1.5 s without moving.
    - Exposure map over a full 24 s guard cycle: every spot in the hall and vault is in some guard's sight 10-30% of the time (front door up to 50%), with very few permanently hidden corners. The two inner guards have equal-length loops and start in phase, so their windows line up.
    - Carrying the safe was slower than a chasing guard (2.3 vs 3.6 units/s), so any chase while carrying lost the run. Tuned: carry slowdown 0.2 -> 0.1, carrier drag 0.3 -> 0.15, chase speed 3.6 -> 3.3, view distance 8 -> 7.
    - After tuning, a crew that never stops wins only for start times in a 2-3 s window per 24 s cycle (about 32 s of play, alert peaks 18-86%). Timing the front door (about 2 s wait) and the hall (under 1 s) is easy. Hard but fair for a bot; needs real human playtesting before more tuning.
    - Ideas if it proves too hard: offset the guard phases, add hiding spots, let the rope or a thrown crate distract guards.
- [x] **Phase 5: Identity.** Names, colours, nametags and emotes. (Proximity voice chat was dropped: friends use their own voice app.)
  - **Menu:** name box and 8 colour swatches, remembered between visits (browser storage, optional). The lobby lists everyone by name and colour.
  - **Colours:** if two people pick the same one, the host gives the later joiner the next free colour, so everyone always looks different.
  - **Names:** cleaned on the host (markup characters and control characters removed, 12 characters max, emoji never split, empty becomes "Player N"). They are only ever drawn through text nodes or the canvas, never as HTML.
  - **Nametags:** a dark plate with a border in the player's colour floats above each head; your own head also has the white arrow.
  - **Emotes:** keys 1-4 pop a bubble (thumbs up, laughing, scared, SOS) over your head for 2.5 s. Your own shows instantly; the host relays it to everyone, ignores spam (300 ms) and invalid ids. Cosmetic only, not part of the simulation or rollback state.
  - Tested with a host and two joiners who all picked the same colour (resolved to three different ones), a hostile name, a very long name with an emoji, emotes both ways, spam and bad ids.
  - Not done: choosing a colour after entering the lobby, custom emotes, a text chat.
- [x] **Watch the bots (extra).** A "Watch 2 bots play" button on the menu starts a round with two AI crew, Botty and Clank, who try to pull off the heist together while you spectate.
  - **How they decide:** the guards patrol on a fixed schedule, so before moving the bots scout on a hidden copy of the world, trying "wait N seconds in the safe getaway zone, then do the whole heist without stopping". They pick the earliest wait that stays quiet (the game is paused with a thinking bubble while they do this, about 7 s). If no clean non-stop run exists they fall back to scouting stage by stage.
  - **Teamwork:** they move single file through the door and gap, walk round either side of the safe, grab it together, and carry it side by side to the zone. They react with emotes (thinking, panic, SOS, party).
  - **Watching:** attempt / won / busted counter, stage text, speed 1x / 2x / 4x, R restarts them, Leave returns to the menu. After a win or loss the game restarts by itself and they plan again.
  - **Result:** two bots win on every attempt tested, about 32 s of game time, 2 of 2 in a row.
  - **Limits:** 3 and 4 bots can't beat the level yet (the extra bots trailing behind keep the crew exposed longer than the 2-3 s windows, and scouting takes about 45 s), so only the two-bot team is offered. Ideas: smarter hiding, extras that wait in the zone, bots filling empty seats online.
- [ ] **Phase 6: Content and polish.** More levels and loot, alarms/lasers, sound, clip-friendly fail states, mobile/gamepad.
- [ ] **Phase 7: Public launch.** Playtest with friends, fix desync, share link.

## Risks
- **Rope physics** (stability, tension, network sync): prototype first, run on host only, sync positions.
- **P2P reliability:** NAT traversal can fail without a TURN server. Plan: public STUN by default, optional TURN later.
- **Desync:** keep the host authoritative and snapshot at about 20 Hz with interpolation on clients.
