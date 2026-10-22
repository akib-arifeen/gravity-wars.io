# Gravity Wars: vision and roadmap

This takes the original prototype's vision (its README "Planned Features" and the mechanics already sketched in its code) and maps it onto the current build. Then it orders what remains by fun per effort, and by what impresses a first-time player within 60 seconds.

Status key: **done**: in the current build and verified. **partial**: something like it exists, but not the full idea. **missing**: not started.

Sources:
- The original README.
- The prototype's `app/page.tsx` (commit `ae8c50a`).
- The reverted WebSocket server, `server/websocket.ts`, in commit `56c8c39` (removed in `cae96e4`).

## 1. Planned features from the original README

| Area | Feature | Status | Notes |
|---|---|---|---|
| Core | Gravity-based movement and combat | done | Wells, thrust, the pull ability, absorbing rivals. |
| Core | Real-time physics simulation | done | Deterministic fixed 60 Hz step, checked against a Python reference. |
| Core | Power-up system with various abilities | done | Overdrive, Magnet, Phase and Bulk pickups, plus crystals (Phase A). |
| Core | Score tracking and leaderboard | partial | Endless mode has a live in-arena top-10 leaderboard; local lifetime stats. A global leaderboard needs hosting (Phase C). |
| Core | Responsive desktop and mobile | done | Works at 360 px wide, in an 800×520 iframe, and on desktop. |
| Mobile | Touch controls, action buttons | done | Floating joystick and PULL. |
| Mobile | Pause menu with stats, respawn | done | Pause, restart, quit. End screen with standings. |
| Visual | Particles for gravity interactions | done | Absorb shockwaves, pull spokes, charge sparkles. |
| Visual | Cosmic-themed UI, smooth animation | done | Glass HUD, attract-mode menu, eased camera, pops, shake. |
| Multiplayer | Real-time multiplayer battles | missing | The `Intent` seam exists, and `step()` can run on a server unchanged. |
| Multiplayer | Global leaderboard | missing | Needs hosting (Phase C). |
| Multiplayer | Custom game rooms | missing | Needs hosting (Phase C). |
| Story | Single-player campaign | missing | Phase B. |
| Story | Unique boss battles | missing | Phase B. |
| Story | Character progression system | missing | Phase B (unlocks, from campaign stars). |
| Story | Unlockable abilities and upgrades | missing | Abilities come in Phase A; unlocking them is Phase B. |
| Story | Rich narrative with cosmic lore | missing | Phase B, as short briefings between levels. |
| Levels | Multiple themed arenas | done | Classic, Binary, The Maw, Nebula Field and The Belt (Phase A). |
| Levels | Dynamic environmental hazards | done | Orbiting stars and planets, a sweeping pulsar beam, solar flares, gravity storms, the closing wall (Phase A). |
| Levels | Special gravity zones | done | Nebula drag clouds, repulsor fields and quantum anomalies (Phase A). |
| Levels | Hidden collectibles | missing | Phase B (relics per level). |
| Levels | Progressive difficulty scaling | partial | Three difficulties; in-round escalation; Endless skill drifts with your mass (Phase A). Across levels comes with the campaign (Phase B). |
| Gameplay | New power-up types | done | Phase A. |
| Gameplay | Advanced gravity mechanics | done | Slingshots, orbiting wells, repulse shoves into stars, pulsar beams (Phase A). |
| Gameplay | Special abilities and ultimate moves | done | Pull, Dash, Repulse and the Singularity ultimate (Phase A). |
| Gameplay | Team-based game modes | missing | Against bots in Phase B; against humans in Phase C. |
| Social | Player profiles and statistics | partial | Local lifetime stats and an Endless best (Phase A); online profiles need hosting. |
| Social | Achievement system | done | 23 local achievements with toasts (Phase A). |
| Social | Daily challenges | missing | Phase B, seeded by the date, with no backend. |
| Social | Social media integration | missing | Phase B: a share card through the Web Share API or copied text. Client only. |
| Social | Community events | missing | Phase C (needs a server). |

## 2. Mechanics sketched in the prototype code

| Prototype mechanic | Status | Notes |
|---|---|---|
| `player`, `ai` bodies | done | Bots with 3 difficulty profiles. |
| `debris`, `asteroid` | done | Dust and rock debris. |
| `star` (glowing, recharges energy) | done | Charge band. Contact is fatal. |
| `blackhole` | done | Strong pull. Contact is fatal. |
| `wormhole` (teleport) | done | A linked pair with cooldown. The prototype's version never fired. |
| `comet` (fast small body with a tail) | done | Comets streak across the arena as big, fast food. |
| `planet` (large non-glowing mass) | done | Solid planets orbit the Belt's star. |
| `whitedwarf` (small, dense, glowing) | done | Compact lethal wells in The Maw. |
| `pulsar` (pulsing, glowing) | done | Twin rotating beams that shove bodies (Nebula Field). |
| `neutronstar` | done | A tiny lethal well (Binary). |
| `spacestation` (glowing, recharges) | done | Solid recharge stations (The Maw, The Belt). |
| `anomaly` | done | The quantum anomaly cosmic event charges the Singularity. |
| Landmarks (big bodies on the compass) | partial | The minimap shows wells and wormholes. |
| Energy decay and charging radius | done | Energy is spent by thrust and pull and recharged at stars. |
| Orbital absorption ("keep moving or be absorbed") | partial | Reworked: touching a star kills you, and orbiting its band recharges you. The prototype's version was effectively disabled. |
| Tangential orbit assist near glowing bodies | partial | Slingshots reward fast orbits; an explicit orbit assist was not needed. |
| Gravity pull ability (Space) | done | Pulls debris and smaller rivals. |
| Gravity compass (force arrows) | partial | Off-screen rival indicators plus minimap. A force-arrow compass is optional in Phase A. |
| AI states: hunt, flee, explore, charge | done | Bots blend these, with a hunt grace and difficulty tuning. |
| AI growth over time | changed | Bots grow by eating, like the player. |
| Cosmic events: meteor shower, asteroid belt | done | Meteor showers; the Belt arena is the asteroid belt. |
| Cosmic events: solar flare, coronal mass ejection | done | Telegraphed solar flares widen a star's lethal radius. |
| Cosmic events: wormhole storm | done | The wormholes keep jumping. |
| Cosmic events: solar wind | missing | Deferred (lower fun per effort than the six built events). |
| Cosmic events: magnetic storm | missing | Deferred: an event that scrambles the player's controls risks feeling unfair; revisit with playtesting. |
| Cosmic events: nebula | done | Nebula drift (a drifting drag cloud). |
| Cosmic events: quantum anomaly (reward) | done | A timed zone that charges energy and the Singularity. |
| Space activities: derelict ship, ancient relic, alien structure, space whale | missing | Phase B: hidden collectibles and lore objects. The space whale becomes a boss. |
| Space activity: energy crystal | done | Crystal pickups restore energy. |
| WebSocket server relaying player state (`init`, `playerJoined`, `playerLeft`, `gameState`) | missing | Phase C: rebuilt as server-authoritative, running the same `step()`. |

## 3. Roadmap

Each phase is ordered by fun per effort. The first 60 seconds matter most: a new player should feel the gravity, see something spectacular, and understand the goal.

### Phase A: the gravity toolkit and a living arena (no server) — built

Status: all items below are built. On top of them comes the **Endless mode**, the new default, added from player feedback ("it's not an io yet, because the game ends"):
- The arena never ends, and you respawn after you die.
- Bots of varied skill drop in and out, and they get tougher as you grow.
- Mass decays above 80.
- A live top-10 leaderboard puts a crown on the leader.
- The leaderboard rows and the join, leave and respawn events are plain data, so a Phase C server can feed the same shapes.

The aim is to make every round different, and to give the player gravity as a weapon rather than only a hazard.

1. **Abilities.** These are the biggest change to how the game feels.
   - **Dash** (Shift or double-tap): a short impulse along your thrust, costing energy on a cooldown. It is your escape and your lunge.
   - **Repulse** (E, or a button on touch): a radial shockwave that shoves debris and rivals away. Because the wells kill, a well-timed repulse can knock a rival into a star.
   - **Singularity ultimate** (Q or R, or a button on touch): it charges by absorbing. For a few seconds you become a mini black hole, with a huge pull radius and an easier absorb ratio.
2. **Slingshot.** Passing close to a well at speed builds a slingshot meter, released as a speed burst with streak visuals and a "SLINGSHOT" pop. This is the "advanced gravity" moment.
3. **New celestial bodies from the prototype:**
   - comets crossing the arena;
   - planets orbiting stars (moving wells);
   - white dwarfs and neutron stars (compact slingshot wells);
   - a pulsar with a rotating push beam;
   - a space station that recharges you safely.
4. **Power-ups**, as timed pickups: Overdrive (energy regen ×3), Magnet (pull radius ×2), Phase (well immunity for 3 s, flashing near the end) and Bulk (an instant +mass burst).
5. **Cosmic events.** These are announced with a banner and a sound stinger, about one every 25–40 s: meteor shower, solar flare (telegraphed), gravity storm, wormhole storm, nebula drift and quantum anomaly.
6. **Themed arenas.** Each round picks one of 4 presets, or the player chooses:
   - **Binary**: two stars in mutual orbit;
   - **The Maw**: one huge central black hole;
   - **Nebula Field**: drag zones;
   - **Belt**: an asteroid ring.
   Gravity zones (drag nebulae, repulsor fields) live in the arena data.
7. **Escalation within a round.** The arena gets harsher as the clock runs down, for example stronger events and a shrinking arena wall in the last 30 s.
8. **Achievements and lifetime stats**, stored locally. About 20 achievements: first absorb, slingshot at 600 u/s, knock a rival into a star, win on Hard, win without pulling, and so on. They show as toasts in game and on a stats page.
9. **Juice and audio.** Ability, event and power-up sounds, plus a procedural ambient music bed that reacts to danger. Audio stays synthesised; CC0 samples only if verified.

Gate:
- bot-vs-bot sims (rounds end, no NaN, abilities used, balance table per arena);
- engine tests for every new rule;
- browser playtests at desktop and 390 px;
- 60 fps with 0 frames over 20 ms on Hard at DPR 2, plus a CPU-throttled mid-phone profile.

### Phase B: campaign and daily challenge (no server)

1. **Campaign: "The Long Fall".**
   - 12 handcrafted levels across 3 sectors, each with an objective: reach a mass, survive N seconds, absorb a named rival, collect hidden relics, escape through a wormhole.
   - 1 to 3 stars per level, awarded for time, mass and relics.
   - One-paragraph briefings carry the cosmic lore.
2. **Bosses.**
   - **The Leviathan**: a space whale that hunts you and splits into fragments.
   - **Twin Pulsars**: two beams you have to read and time.
   - **The Void King**: a mobile black hole you weaken by slingshotting comets into it.
3. **Progression.** Stars unlock abilities (Dash, Repulse, Singularity) and cosmetic trails and skins. Hidden collectibles appear as space activities: derelict ships, ancient relics, alien structures.
4. **Team mode against bots**: 2v2 or 3v3. Teammates can't absorb each other.
5. **Daily challenge.** It is seeded by the UTC date: arena, modifiers and rival roster. The best score is kept locally, and a share card goes out through the Web Share API or copied text.

Gate: every level can be completed by a scripted bot run, so none are unwinnable; plus the same browser, fps and test gates as Phase A.

### Phase C: online (needs hosting; the costed choice comes before any account)

1. **Real-time rooms.** The server runs the same `step()` and is authoritative. Clients send `Intent`s and render snapshots with interpolation. This replaces the prototype's relay design.
2. **Global leaderboards** for the daily challenge and campaign times.
3. **Team modes** against humans, custom rooms and community events.
4. **Hosting research.** Cloudflare Durable Objects / PartyServer, Colyseus Cloud and similar: free tiers, limits and cost per active room, brought to the user through the lead. No account or infrastructure is created without approval.

## 4. Method

- **Work model:** lead plus workers. The lead owns the contract (`game/types.ts`, `game/config.ts`, the engine docs), specs, integration and the final check. Workers build and peer-review, and tests are written from the contract by a different worker.
- **PRs:** one PR per phase, each stacked on the previous one. No merge or production deploy without the user's OK.
- **Audio assets:** only verified CC0 (for example Kenney). No Sonniss or Freesound files in the repo. Synthesised by default.
