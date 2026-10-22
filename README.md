# Gravity Wars

A single-player gravity brawler in the browser. You are a small body in an arena with stars, a
black hole and a wormhole pair. Eat debris to grow, absorb rivals smaller than you, and avoid
anything bigger. The first body to reach critical mass wins. So does the last one left alive.

Play it: https://gravity-warsio.vercel.app

## How a round works

- 3, 2, 1, go. You start on a ring with 3, 5 or 7 rival bots (Easy, Normal, Hard).
- **Grow.** Debris adds mass. Cyan crystals restore energy.
- **Absorb.** A rival with a green ring is small enough to eat. A red ring means it can eat you.
- **Pull.** Hold pull to drag nearby debris and smaller rivals toward you. It drains energy.
- **Energy.** Thrust and pull cost energy. Orbiting a star recharges it (the dashed ring). Touching a star or the black hole is fatal.
- **Win** by reaching 130 mass or by being the last body left. If the clock runs out, the heaviest body wins.

## Controls

| | Keyboard | Mouse | Touch |
|---|---|---|---|
| Thrust | WASD / arrows | hold left button (toward cursor) | drag on the left half |
| Pull | Space or Shift | hold right button | hold PULL |
| Pause | Esc or P | pause button | pause button |
| Menu / end screen | Enter play, R restart, Q menu, M mute | | |

The game pauses itself when the tab or iframe loses focus.

## Develop

```bash
npm install
npm run dev         # http://localhost:3000
npm test            # vitest: engine, bots, full headless rounds
npm run typecheck
npm run build       # static export to out/
```

To host the build under a sub-path, set `BASE_PATH` at build time:

```bash
BASE_PATH=/play/gravity-wars npm run build   # assets resolve under /play/gravity-wars/
```

## How it is built

- `game/` is the game, written in plain TypeScript with no React and no DOM in the simulation.
  - `engine.ts` holds the simulation. `step()` advances it one fixed 1/60 s step.
  - `bots.ts` holds the bot brains.
  - `config.ts` holds every tunable number.
  - `render.ts` draws on a Canvas 2D context, interpolating between physics steps.
  - `audio.ts` synthesises the sound with Web Audio. There are no audio files.
  - `input.ts` handles keyboard, mouse and touch.
- `app/` is the React shell: the menu with an attract-mode round behind it, the HUD, pause and end screens, and the fixed-timestep loop.
- The simulation is deterministic. A seed plus a sequence of inputs replays exactly the same round. Every body, player or bot, is driven only through an `Intent` (thrust vector plus pull). That gives a multiplayer seam: a networked version would feed remote players' intents into the same `step()` call.
