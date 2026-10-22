# Gravity Wars

A gravity brawler in the browser, built like an .io game. You are a small body in an arena of stars, black holes, pulsars and wormholes. Eat debris to grow, absorb rivals smaller than you, slingshot around stars, and shove bigger rivals into them. Play against bots on phone, tablet or desktop, with no server and nothing to install.

Play it: https://gravity-warsio.vercel.app

## Modes

- **Endless** (the default) never ends.
  - You respawn a few seconds after you die, and your best score for the session is kept.
  - Bots of varied skill join and leave all the time, and they get tougher as you grow.
  - A live leaderboard ranks everyone by mass, and the #1 body wears a crown.
- **Round** is a 3-minute match against 3, 5 or 7 bots (Easy, Normal, Hard). You win by reaching 130 mass first or by being the last one left. If the clock runs out, the heaviest body wins.

## Arenas

Pick one on the menu, or choose Random:

| Arena | What's in it |
|---|---|
| Classic | Two stars, a black hole and a wormhole pair |
| Binary | Twin stars orbiting each other, and a neutron star |
| The Maw | One enormous black hole, white dwarfs, and recharge stations |
| Nebula Field | Drag clouds, a repulsor field, and a pulsar whose beams sweep the arena |
| The Belt | A dense asteroid ring and planets on orbits |

## How to play

- **Grow.** Debris and comets add mass. Cyan crystals restore energy.
- **Absorb.** A rival with a green ring is small enough to eat. A red ring means it can eat you.
- **Energy.** Thrust, pull and abilities all cost energy.
  - Orbit a star or a station inside its dashed ring to recharge.
  - Touching a star, a black hole, a white dwarf, a neutron star or a pulsar is fatal. Planets and stations are solid, and you bounce off them.
- **Abilities:**
  - **Pull** drags debris and smaller rivals toward you.
  - **Dash** is an instant burst of speed.
  - **Repulse** is a shockwave. Use it to knock a rival into a star.
  - **Singularity**: absorbing charges it. When you fire it, you become a black hole for 5 seconds.
- **Slingshot.** Whip past a well fast enough and you earn energy and Singularity charge.
- **Power-ups:**
  - Overdrive triples your energy regen.
  - Magnet doubles your pull radius.
  - Phase makes you immune to the wells for a few seconds.
  - Bulk gives instant mass.
- **Cosmic events** arrive every 25–40 s: a meteor shower, a solar flare, a gravity storm, a wormhole storm, a nebula drift, or a quantum anomaly.
- **End of a round.** In the last 30 seconds of a round, the arena wall closes in.
- **Achievements.** There are 23, kept on your device along with your lifetime stats (menu: Stats & achievements).

## Controls

| | Keyboard | Mouse | Touch (phone and tablet) |
|---|---|---|---|
| Thrust | WASD / arrows | hold left button (toward cursor) | drag on the left half |
| Pull | Space | hold right button | hold PULL |
| Dash | Shift | ability bar button | DASH |
| Repulse | E | ability bar button | REPULSE |
| Singularity | Q | ability bar button | ULT |
| Pause | Esc or P | pause button | pause button |
| Menus | Enter play, R restart, Q menu (when paused or ended), M mute | | tap |

The game pauses itself when the tab or iframe loses focus.

## Develop

```bash
npm install
npm run dev         # http://localhost:3000
npm test            # vitest: engine, arenas, cosmic events, Endless, bots, achievements, headless rounds
npm run typecheck
npm run build       # static export to out/
```

To host the build under a sub-path, set `BASE_PATH` at build time:

```bash
BASE_PATH=/play/gravity-wars npm run build   # assets resolve under /play/gravity-wars/
```

There is also a QA hook for tests and probes: `window.__gw` gives world access, perf samples and a bot autopilot. It is available in `npm run dev`, or in a build made with `NEXT_PUBLIC_GW_DEBUG=1`, when the page is opened with `?debug`. Normal production builds don't contain it.

## How it is built

- `game/` is the game, written in plain TypeScript with no React and no DOM in the simulation.
  - `engine.ts` holds the simulation. `step()` advances it one fixed 1/60 s step.
  - `bots.ts` holds the bot brains.
  - `config.ts` holds every tunable number.
  - `render.ts` draws on a Canvas 2D context, interpolating between physics steps.
  - `audio.ts` synthesises the sound with Web Audio. There are no audio files.
  - `input.ts` handles keyboard, mouse and touch.
  - `arenas.ts` holds the arena layouts.
  - `cosmic.ts` runs the cosmic events.
  - `achievements.ts` holds the achievements and local stats. It's pure and unit-tested.
- `app/` is the React shell: the menu with an attract-mode round behind it, the HUD, pause and end screens, and the fixed-timestep loop.
- The simulation is deterministic on a given JavaScript engine. A seed plus a sequence of inputs replays exactly the same round. Different browsers can differ in the last bit of `Math.exp` and `Math.pow`, so the same inputs can drift apart across engines.
- Every body, player or bot, is driven only through an `Intent` (thrust vector, pull, and ability presses). That is the seam for multiplayer: a networked version would feed remote players' intents into the same `step()` call. Because of the cross-engine drift, it should run that step on a server (or sync state between clients) rather than rely on lockstep across browsers. The Endless leaderboard and the join, leave and respawn events are plain data, so a server can feed the same shapes.

See [VISION.md](VISION.md) for the roadmap (campaign, daily challenge, online rooms).
