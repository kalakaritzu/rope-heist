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
- [x] **Phase 6: Content and polish.** (Gamepad and mobile were deliberately left out.)
  - **Level system.** Levels are data in `src/levels.js`; the menu has a level picker, the host's choice is sent to everyone, and the simulation, renderer and rollback state all take the level as a parameter.
  - **The Gallery (second level, harder):** a zig-zag of three rooms (door on the east, first gap west, second gap east), three guards, a 4:00 timer, and the rule "deliver any 2 of 3 treasures".
  - **Loot with character:** loot is now any box. A giant painting (flat, two carriers), a grandfather clock (tall, two carriers), and a live pig that hops off in a random direction every 0.7 s unless someone holds it (deterministic, so prediction matches the host). The safe got a dial; the clock a face and pendulum; the pig a snout, ears and tail.
  - **Lasers:** beams pulse on and off (on about 1.6 s of every 4.5 s). A player touching a live beam adds 30 alert; just the rope crossing it adds 12. Beams are 0.55 high so they can be jumped. Each beam has a cooldown, and a tripped one flashes white. Alarm: siren, red screen flash, and an alert jump. Beams and alarm are part of the rollback state.
  - **Sound (no audio files, all synthesised):** footsteps (yours loudest, others fade with distance), grab and drop, knot and unknot, guard spotted sting, laser zap, siren, last-10-seconds tick, emote pop, pig oink, win jingle, bust sting. M or the speaker button mutes (remembered).
  - **Clip-friendly fail states:** after a win or a bust the banner shows for 1.5 s, then an instant replay of the last 5 s plays zoomed in at 0.8x with letterbox bars, then the banner returns; the round restarts 14 s after the end. V replays on demand, P saves a screenshot.
  - **Bugs found while building it:**
    - The rope is about four times heavier than a player and was dragging jumps down (only 0.66 high), so a 0.9 beam could not be cleared. Jump strength 7 to 9 and beams lowered to 0.55; a jump now clears a beam for about 0.38 s.
    - The pig's oink never fired because the hop detection needed it to be both high and rising fast at the same instant.
    - A negative time step (a clock running backwards) threw the camera to 10^47 units and it never recovered. Time steps are now clamped everywhere.
    - The client showed the Museum's objective text on every level.
  - **Tested:** laser timing, a player standing in a beam, jumping over one (three timings), a beam that is off, rope-only trips, the cooldown; pig determinism across two copies, upright, and held pigs staying put; 1 of 2 loot not winning and 2 of 2 winning; all three treasures carried through the 3-wide doorways into the zone; rollback on both levels (lasers, guards, pig, alarm and alert identical); every sound trigger (spied, one call per event, nothing while muted); the replay start, length, end and restart; a screenshot yields a valid PNG; the Museum bots still win 2 of 2.
  - **Not done:** bots only know the Museum, no hiding spots, no custom levels, no text chat. The Gallery has not been beaten by a bot or a person end to end (only its pieces were verified), so its difficulty is a guess.
- [x] **Phase 7: Public launch (what could be done without friends).**
  - **README.md** with how to play, controls, rules, levels, how it works, TURN setup, testing aids and the file map.
  - **Share preview:** Open Graph and Twitter tags plus a 1200x630 `public/og.jpg` made from a real frame (two bots carrying the safe).
  - **Optional TURN relay:** if `ice-config.json` sits next to `index.html` its servers are added to the connection settings (`public/ice-config.example.json` is the template). Nothing is configured by default.
  - **Desync hardening:** the unreliable channel can reorder messages, so snapshots and inputs are numbered and stale ones are ignored.
  - **Host reconnect:** the host used to lose its link to the signalling server while idle in the lobby, after which new players got "Room not found". It now re-registers the same code automatically (tested: back within 0.5 s, and a joiner connected afterwards).
  - **Stress test hooks:** `?lag=`, `&jitter=` and `&loss=` on a joiner's URL. Tested 60 ms lag, up to 80 ms jitter, 5% loss for 31 s of random play on The Gallery: 17 of 20 snapshots per second arrived, median error 0.18 units, no blow-ups, and after everyone stopped host and client agreed to within 0.01.
  - **Still needs real people:** playtests over real networks, and judging difficulty and fun. A TURN server (paid or free-tier account) is yours to choose.

## Risks
- **Rope physics** (stability, tension, network sync): prototype first, run on host only, sync positions.
- **P2P reliability:** NAT traversal can fail without a TURN server. Public STUN is used by default and a TURN relay can be added through `ice-config.json` (see README). Not configured yet.
- **Desync:** keep the host authoritative and snapshot at about 20 Hz with interpolation on clients.
