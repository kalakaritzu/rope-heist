# Rope Heist

A co-op heist game for 2-4 friends who are **tied together by one stretchy rope** while they rob a building. Sneak past guards, carry heavy loot together, and try not to trip over each other. It runs in the browser, with no install and no account.

**Play it: https://kalakaritzu.github.io/rope-heist/**

## How to play with friends

1. One person clicks **Host a game** and sends the 4-letter code (or the share link) to the others.
2. Everyone else opens the link, or clicks **Join with code**.
3. The host picks the level before hosting and clicks **Start heist** once everybody is in.

Pick a name and a colour on the menu first. If two people choose the same colour, the host gives the later joiner the next free one.

No friends around? **Watch 2 bots play** shows a pair of AI crooks planning and pulling off the Museum heist (speed 1x/2x/4x, R makes them start over).

## Controls

| Key | Action |
|---|---|
| `W` `A` `S` `D` or arrows | Move |
| `Space` | Jump (you can hop over low laser beams) |
| Hold `E` | Grab and carry the nearest crate or treasure |
| `Q` | Tie the rope to a nearby pillar. Press again by the knot to untie |
| `1` `2` `3` `4` | Emotes (thumbs up, laughing, scared, SOS) |
| `V` | Instant replay of the last few seconds |
| `P` | Save a screenshot |
| `M` | Mute or unmute |
| `R` | Host only: restart the round |

Local testing on one keyboard (**Local 2P**): player 2 uses the arrow keys, `Enter`, `.` to grab and `,` to tie.

## The rules

- Guards patrol with vision cones. If they see you (or even just your rope) the shared **ALERT** bar fills. A guard that watches you for a moment will chase and shove you.
- Heavy loot takes **two** people to lift. Light loot (like the pig) takes one.
- **You win** when enough loot sits inside the green getaway zone. **You lose** if the ALERT bar fills or the timer runs out.
- After a win or a loss you get an instant replay, then the round restarts by itself.

### Levels

- **The Museum** (easier): one door, one hall, one vault, and a very heavy gold safe. Bring back the safe.
- **The Gallery** (harder): a zig-zag of rooms, pulsing **laser beams** that trip an alarm if you or just your rope touch them (jump them or wait for them to switch off), and three treasures: a giant painting, a grandfather clock and a live pig that will not stay put. Deliver any two.

## Run it yourself

```bash
npm install
npm run dev      # local dev server
npm run build    # production build in dist/
```

Pushing to the `main` branch deploys to GitHub Pages through `.github/workflows/deploy.yml`.

## How it works

- **Three.js** draws the low-poly world and **Rapier** (WebAssembly) simulates the physics, including the rope, which is a chain of small bodies joined together.
- **Multiplayer is peer to peer** (WebRTC through PeerJS). There is no game server. The host runs the authoritative simulation and sends snapshots about 20 times a second.
- **Client-side prediction:** every player also runs a copy of the simulation, so your own movement responds instantly. Each snapshot includes the full state plus the last input the host applied; the client rolls back to it, replays the inputs the host has not seen yet, and fades away any small error.
- Snapshots and inputs are numbered, so ones that arrive late or out of order are ignored.
- The host re-registers its room code automatically if the signalling connection drops, so new players can still join.
- All sound is synthesised in the browser. No audio files.

### Strict networks and TURN

Most home connections work with the free public STUN servers the game uses. Some company, school and mobile networks need a **TURN relay** as well. To add one, create a file named `ice-config.json` next to `index.html` (in `public/` before building):

```json
{ "iceServers": [{ "urls": "turn:your-relay.example.com:3478", "username": "name", "credential": "secret" }] }
```

`public/ice-config.example.json` is a template. Anything in `public/` is served to everyone, so use credentials that are fine to be public (for example the short-lived or free-tier ones relay providers give you).

### Testing bad connections

Add these to the page address of a joining player:

- `?lag=100` delays their traffic by 100 ms each way
- `&jitter=60` adds up to 60 ms of random extra delay, so messages can arrive out of order
- `&loss=5` drops 5% of snapshots and inputs

For example `https://kalakaritzu.github.io/rope-heist/?join=ABCD&lag=60&jitter=80&loss=5`.

## Project layout

| File | What it does |
|---|---|
| `src/sim.js` | The physics simulation and all the rules. Runs on the host and on every client |
| `src/levels.js` | Level data: walls, loot, guards, lasers |
| `src/view.js` | Drawing the world from a snapshot |
| `src/net.js` | Peer-to-peer networking |
| `src/main.js` | Menu, lobby, game loops and HUD |
| `src/bots.js` | The AI crew for "Watch bots" |
| `src/audio.js` | Synthesised sound effects |
| `src/director.js` | Instant replay and screenshots |
| `src/profile.js` | Names, colours and emotes |

See `PLAN.md` for the development history, what was tested, and what is still missing.
