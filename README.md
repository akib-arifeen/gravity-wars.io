# Gravity Wars

A gravity brawler in the browser, built like an .io game. You are a small body in an arena of stars, black holes, pulsars and wormholes. Eat debris to grow, absorb rivals smaller than you, slingshot around stars, and shove bigger rivals into them. Play against bots on phone, tablet or desktop, with no server and nothing to install.

Play it: https://gravity-warsio.vercel.app

## Modes

- **First run** starts on **Easy** in the **Classic** arena, and the menu remembers whatever you pick from then on. That first-run pair is for a browser with no saved play at all: with any saved record but no stored choice (an older build never stored a skill), the menu opens on **Normal** and the **Random** arena instead, so it never guesses that a returning player is a newcomer. A stored choice is applied in the same commit that hydrates, before that first paint, so the menu is already yours when it becomes live; the exported HTML itself is the first-run menu until the page hydrates, so this shortens the swap rather than removing the window entirely. The in-game HUD shows live speed, `Esc` pauses to a screen that re-reads the controls, and the first death of an Endless round adds one tip.
- **Endless** (the default) never ends.
  - You respawn a few seconds after you die, and your best score for the session is kept.
  - Bots of varied skill join and leave all the time, and they get tougher as you grow.
  - A live leaderboard ranks everyone by mass, and the #1 body wears a crown.
  - The camera keeps following the leader while you wait to respawn, so the arena visibly carries on without you.
- **Round** is a 2:30 match against 3, 5 or 7 bots (Easy, Normal, Hard); in The Vast the clock runs 1.4x as long, 3:30, and Random can give you either. You win by reaching 130 mass first, the same goal on every skill, or by being the last one left. If the clock runs out, the heaviest body wins.
  - Why 130 everywhere: with every rival flown by the game's own bot brains over 12 seeds, an Easy-skill reference peaks 92-194 (median 131) and reaches 130 in 6 of 12 rounds; racing to it, the reference wins 4 of 12, and some rounds still go to the clock. A 90 goal won the same 4 of 12 but ended all 12 by mass at a median of 90 s, so it made the round shorter, not easier. This is simulated low-skill play, not a claim about how difficult the game feels to a person.
- **Campaign: The Long Fall** is twelve levels in three sectors against a fixed field, with three bosses.
  - Every level has a goal, a bonus objective and a hidden relic: up to three stars per level.
  - Stars unlock **Dash** (1 star), **Repulse** (3 stars) and the **Singularity** (6 stars) inside the campaign.
  - Recover all twelve relics to unlock the **Voidtouched** body skin.
  - Sectors end in a boss: the **Leviathan** (splits into fragments), the **Twin Pulsars** (two sweeping beams) and the **Void King** (a timed collapse you have to outrun).
  - A boss can be eaten once you out-grow it, or worn down first by landing Repulses on it.
- **Daily challenge** is one seeded round per UTC day: same arena, same rival roster, same cosmic events for everyone. Your score is the peak mass of the round; the best per day and a day streak are kept locally.
  - A local-only experiment can have that run replay-verified by the Worker in `backend/`. It is off unless the page is built with `NEXT_PUBLIC_GW_CHALLENGE_API` pointing at a loopback API, and it adds no UI otherwise. It is not a global leaderboard: the board is one local database, and replay proves the score followed from the inputs, not that a person produced them. See [backend/README.md](backend/README.md).
- **Share** any finished run from the end screen (Web Share sheet, or the text is copied to the clipboard). Text only, no backend, no analytics.

## Arenas

Pick one on the menu, or choose Random:

| Arena | What's in it |
|---|---|
| Classic | Two stars, a black hole and a wormhole pair |
| Binary | Twin stars orbiting each other, and a neutron star |
| The Maw | One enormous black hole, white dwarfs, and recharge stations |
| Nebula Field | Drag clouds, a repulsor field, and a pulsar whose beams sweep the arena |
| The Belt | A dense asteroid ring and planets on orbits |
| The Vast | A red supergiant with a riding solar current, a wide asteroid belt, and the long dark beyond |

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
- **Solar current (The Vast).** The giant star's wide band at one third of the arena pushes bodies along with it and thins the drag inside. Fly with the flow to fill a sail that raises your speed cap; it fades once you leave the band. It is a game simplification, not frame dragging or a magnetohydrodynamic simulation.
- **Power-ups:**
  - Overdrive triples your energy regen.
  - Magnet doubles your pull radius.
  - Phase makes you immune to the wells for a few seconds.
  - Bulk gives instant mass.
- **Cosmic events** arrive every 25–40 s: a meteor shower, a solar flare, a gravity storm, a wormhole storm, a nebula drift, or a quantum anomaly.
- **Campaign bosses.** Watch the ring: a telegraph means a gravity maw, a collapse or a lunge is about to fire. Repulse hits chip a boss's mass; once it is small enough to absorb, eat it.
- **Relics.** Each campaign level hides one relic. A shimmer marks it on screen; when it is off screen a chevron with the distance points to it, and it is yours when you fly into it.
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
npm test            # vitest: engine, arenas, cosmic events, Endless, bots, achievements, campaign, bosses, daily, share, feed, headless rounds
npm run typecheck
npm run build       # static export to out/
```

To host the build under a sub-path, set `BASE_PATH` at build time:

```bash
BASE_PATH=/play/gravity-wars npm run build   # assets resolve under /play/gravity-wars/
```

There is also a QA hook for tests and probes: `window.__gw` gives world access, the boss encounter state, the relic position, perf samples and a bot autopilot. It is available in `npm run dev`, or in a build made with `NEXT_PUBLIC_GW_DEBUG=1`, when the page is opened with `?debug`. Normal production builds don't contain it.

## How it is built

- `game/` is the game, written in plain TypeScript with no React and no DOM in the simulation.
  - `campaign.ts` holds the twelve levels, goals, stars, relics and the local progress.
  - `boss.ts` holds the three encounters and the telegraphed specials (the engine itself is untouched: a boss is a body driven through the ordinary `Intent` seam).
  - `daily.ts`, `share.ts` and `feed.ts` are pure: the daily seed, the share text and the arena activity feed.
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
  - `app/challenge/` is the experimental verified-run client: descriptor fetch, per-step trace recording, submission state and retry. It is only reached when a build sets `NEXT_PUBLIC_GW_CHALLENGE_API` to a loopback API base.
- The simulation is deterministic on a given JavaScript engine. A seed plus a sequence of inputs replays exactly the same round. Different browsers can differ in the last bit of `Math.exp` and `Math.pow`, so the same inputs can drift apart across engines.
- Every body, player or bot, is driven only through an `Intent` (thrust vector, pull, and ability presses). That is the seam for multiplayer: a networked version would feed remote players' intents into the same `step()` call. Because of the cross-engine drift, it should run that step on a server (or sync state between clients) rather than rely on lockstep across browsers. The Endless leaderboard and the join, leave and respawn events are plain data, so a server can feed the same shapes.

See [VISION.md](VISION.md) for the roadmap (Phase B is built; Phase C is online rooms and a global leaderboard, which need hosting).
