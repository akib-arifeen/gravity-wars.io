// Gravity Wars simulation. Pure TypeScript: no DOM, no timers, no Math.random (all randomness
// comes from world.rngState via rng.ts), so a seed plus a sequence of intents replays exactly.
//
// CONTRACT — the exported signatures and the behaviour documented here are fixed. Implement the
// bodies below; put helpers in the PRIVATE section at the bottom.

import { CONFIG } from "./config"
import { buildArena } from "./arenas"
import { gmScale, lethalRadius, updateCosmic } from "./cosmic"
import { rand, randRange, seedState } from "./rng"
import type {
  ArenaId,
  Body,
  CosmicEvent,
  DeathCause,
  DebrisKind,
  Difficulty,
  GameEvent,
  GameMode,
  LeaderboardEntry,
  HudSnapshot,
  Intent,
  LethalWellKind,
  PowerUpKind,
  RoundEndReason,
  RoundResult,
  Standing,
  Vec,
  Well,
  World,
  Wormhole,
} from "./types"

export const NO_INTENT: Intent = Object.freeze({ ax: 0, ay: 0, pull: false })

/** radius = CONFIG.body.radiusK * sqrt(mass). Used for bodies and debris alike. */
export function radiusForMass(mass: number): number {
  return CONFIG.body.radiusK * Math.sqrt(mass)
}

/** Thrust acceleration (u/s²) available to a body of this mass at full intent. */
export function thrustAccel(mass: number): number {
  const b = CONFIG.body
  return b.thrustAccel * Math.pow(b.refMass / mass, b.thrustMassExp)
}

/** Speed (u/s) that thrust alone can push a body of this mass to. */
export function maxSpeed(mass: number): number {
  const b = CONFIG.body
  return b.maxSpeed * Math.pow(b.refMass / mass, b.maxSpeedMassExp)
}

/**
 * Pull ability radius for a body: baseRadius + radius * radiusPerR, multiplied by
 * CONFIG.powerups.magnet.radiusMul while a magnet is active and by CONFIG.abilities.ult.pullRadiusMul
 * while the Singularity is active.
 */
export function pullRadius(body: Body): number {
  let r = CONFIG.pull.baseRadius + body.radius * CONFIG.pull.radiusPerR
  if (body.power.magnet > 0) r *= CONFIG.powerups.magnet.radiusMul
  if (body.ultActive > 0) r *= CONFIG.abilities.ult.pullRadiusMul
  return r
}

/** Absorb ratio for a body right now: CONFIG.abilities.ult.absorbRatio during Singularity, else CONFIG.absorb.ratio. */
export function absorbRatio(body: Body): number {
  return body.ultActive > 0 ? CONFIG.abilities.ult.absorbRatio : CONFIG.absorb.ratio
}

/** True if `a` is heavy enough to absorb `b` (mass ratio only; ignores distance and shields). */
export function canAbsorb(a: Body, b: Body): boolean {
  return a.mass >= absorbRatio(a) * b.mass
}

/** Repulse shockwave radius for a body. */
export function repulseRadius(body: Body): number {
  return CONFIG.abilities.repulse.radius + body.radius * CONFIG.abilities.repulse.radiusPerR
}

export interface CreateWorldOptions {
  seed: number
  difficulty: Difficulty
  /** Defaults to CONFIG.difficulty[difficulty].bots. */
  botCount?: number
  /** Defaults to "classic". */
  arena?: ArenaId
  /** false disables cosmic events (nextCosmicIn = 1e9). Defaults to true. */
  cosmic?: boolean
  /** Defaults to "round". "endless": see the Endless notes on createWorld and step(). */
  mode?: GameMode
  /** Mass that wins by critical mass. Defaults to CONFIG.round.criticalMass; campaign levels pass
   * a value no body can reach so the level ends on its own goal instead of the race. */
  criticalMass?: number
}

/**
 * Build a new round, in phase "countdown" with countdown = CONFIG.round.countdown,
 * timeLeft = CONFIG.round.duration, tick = 0, time = 0, events = [], result = null.
 *
 * Order (all random draws from the seeded rng, so equal options give deep-equal worlds):
 * 1. world.arena = opts.arena ?? "classic"; call buildArena(world, arena) (arenas.ts), which
 *    places wells, zones and wormholes and sets arenaBase/arenaRadius; it returns the spawn ring
 *    radius and the debris field (store the field in world.debrisField).
 *    For "classic" this reproduces the original layout: one black hole within
 *    CONFIG.well.holeOffsetMax of the centre; CONFIG.well.starCount stars at a distance in
 *    CONFIG.well.starOrbit, at least 90° apart; ids "star-1".., "hole-1"; one wormhole pair
 *    "wh-a"/"wh-b" (radius CONFIG.wormhole.radius, distance in CONFIG.wormhole.orbit,
 *    >= wellClearance from every well centre, >= minSeparation apart; 200 tries then the last
 *    draw). Stars: gm starGm, radius starRadius, chargeRadius starChargeRadius, chargeRate
 *    starChargeRate, lethal. Hole: gm holeGm, radius holeRadius, chargeRadius 0, chargeRate 0, lethal.
 * 2. Bodies: player first (id "player", kind "player", CONFIG.player name/colour, mass
 *    startMass), then bots "bot-1".."bot-N" (names/colours from CONFIG.bots in order, mass
 *    startMass * a draw in the difficulty's startMassScale), evenly spaced on the returned ring
 *    radius with one random rotation for the whole ring. Velocity 0, px/py = x/y, energy max,
 *    shield CONFIG.body.spawnShield, all timers/cooldowns/ult 0, power all 0, lastHitBy "",
 *    lastHitAt -1e9, flags false, stats all 0 with peakMass = mass, alive true.
 * 3. Debris: CONFIG.debris.target dust/rock and CONFIG.crystal.target crystals placed per the
 *    debris field (see step 11's placement rule), never within well.radius +
 *    CONFIG.debris.wellClearance of any well. Ids from 1; nextDebrisId is the next unused id.
 * 4. pickups = [], cosmic = null, nextCosmicId = 1, spawnCredit all 0, nextCosmicIn = a draw in
 *    CONFIG.cosmic.firstIn (or 1e9 when opts.cosmic === false).
 * 5. mode = opts.mode ?? "round". Every body gets skill = opts.difficulty. In "round" mode
 *    endless = null. In "endless" mode: botCount defaults to CONFIG.endless.bots (still
 *    overridable); timeLeft = 1e9 (no time-up, no escalation); each bot's skill is drawn with the
 *    skill-drift rule for player mass = startMass (draws made right after that bot's mass draw);
 *    endless = { respawnIn 0, best startMass, deaths 0, kills 0, lastKillerId "", nextBotNo =
 *    botCount + 1, joinIn = zeros (one per body), rotateIn = a draw in CONFIG.endless.rotateEvery }.
 *
 * Throws RangeError if botCount is not an integer in [0, CONFIG.bots.names.length] (endless mode:
 * [0, CONFIG.endless.names.length]; endless bots are named from CONFIG.endless.names in order).
 */
export function createWorld(opts: CreateWorldOptions): World {
  const profile = CONFIG.difficulty[opts.difficulty]
  const mode: GameMode = opts.mode ?? "round"
  const endless = mode === "endless"
  // Endless mode draws bot names from CONFIG.endless.names (its default of 10 bots exceeds
  // CONFIG.bots.names), so its upper bound is that list's length.
  const maxBots = endless ? CONFIG.endless.names.length : CONFIG.bots.names.length
  const botCount = opts.botCount ?? (endless ? CONFIG.endless.bots : profile.bots)
  if (!Number.isInteger(botCount) || botCount < 0 || botCount > maxBots) {
    throw new RangeError(`botCount must be an integer in [0, ${maxBots}], got ${botCount}`)
  }
  const arena = opts.arena ?? "classic"

  const world: World = {
    seed: opts.seed,
    difficulty: opts.difficulty,
    rngState: seedState(opts.seed),
    tick: 0,
    phase: "countdown",
    countdown: CONFIG.round.countdown,
    time: 0,
    timeLeft: endless ? 1e9 : CONFIG.round.duration,
    roundCriticalMass: opts.criticalMass ?? CONFIG.round.criticalMass,
    arenaRadius: CONFIG.arena.radius,
    arena,
    arenaBase: CONFIG.arena.radius,
    bodies: [],
    debris: [],
    wells: [],
    wormholes: [],
    events: [],
    result: null,
    nextDebrisId: 1,
    spawnCredit: { debris: 0, crystal: 0, comet: 0, pickup: 0 },
    pickups: [],
    zones: [],
    cosmic: null,
    nextCosmicIn: 0,
    nextCosmicId: 1,
    debrisField: { ringShare: 0, ringInner: 0, ringOuter: 0 },
    mode,
    endless: null,
  }

  // 1. Arena: wells, zones, wormholes, arenaBase/arenaRadius.
  const built = buildArena(world, arena)
  world.debrisField = { ringShare: built.field.ringShare, ringInner: built.field.ringInner, ringOuter: built.field.ringOuter }

  // 2. Bodies on a ring.
  const total = botCount + 1
  const ringRot = randRange(world, 0, TWO_PI)
  for (let i = 0; i < total; i++) {
    const angle = ringRot + (TWO_PI * i) / total
    const isPlayer = i === 0
    const mass = isPlayer
      ? CONFIG.body.startMass
      : CONFIG.body.startMass * randRange(world, profile.startMassScale[0], profile.startMassScale[1])
    const skill: Difficulty = !isPlayer && endless ? drawSkill(world, CONFIG.body.startMass) : opts.difficulty
    const x = Math.cos(angle) * built.ringRadius
    const y = Math.sin(angle) * built.ringRadius
    world.bodies.push({
      id: isPlayer ? "player" : `bot-${i}`,
      kind: isPlayer ? "player" : "bot",
      name: isPlayer ? CONFIG.player.name : endless ? CONFIG.endless.names[i - 1] : CONFIG.bots.names[i - 1],
      color: isPlayer ? CONFIG.player.color : CONFIG.bots.colors[(i - 1) % CONFIG.bots.colors.length],
      skill,
      x,
      y,
      vx: 0,
      vy: 0,
      px: x,
      py: y,
      mass,
      radius: radiusForMass(mass),
      energy: CONFIG.energy.max,
      alive: true,
      shield: CONFIG.body.spawnShield,
      warpCooldown: 0,
      idleTime: 0,
      thrusting: false,
      pulling: false,
      charging: false,
      dashCd: 0,
      repulseCd: 0,
      ult: 0,
      ultActive: 0,
      power: { overdrive: 0, magnet: 0, phase: 0 },
      slingCd: 0,
      lastHitBy: "",
      lastHitAt: -1e9,
      stats: {
        debrisEaten: 0,
        crystals: 0,
        rivalsAbsorbed: 0,
        peakMass: mass,
        dashes: 0,
        repulses: 0,
        ults: 0,
        slingshots: 0,
        assists: 0,
        pickups: 0,
        comets: 0,
        topSpeed: 0,
      },
    })
  }

  // 3. Debris.
  for (let i = 0; i < CONFIG.debris.target; i++) spawnDebris(world, false)
  for (let i = 0; i < CONFIG.crystal.target; i++) spawnDebris(world, true)

  // 4. Cosmic schedule.
  world.nextCosmicIn = opts.cosmic === false ? 1e9 : randRange(world, CONFIG.cosmic.firstIn[0], CONFIG.cosmic.firstIn[1])

  // 5. Endless bookkeeping.
  if (endless) {
    world.endless = {
      respawnIn: 0,
      best: CONFIG.body.startMass,
      deaths: 0,
      kills: 0,
      lastKillerId: "",
      nextBotNo: botCount + 1,
      joinIn: world.bodies.map(() => 0),
      rotateIn: randRange(world, CONFIG.endless.rotateEvery[0], CONFIG.endless.rotateEvery[1]),
    }
  }

  return world
}

/**
 * Advance the world by exactly one fixed step of dt = CONFIG.dt seconds. Mutates `world`.
 * `intents` maps body id -> Intent; a missing id means NO_INTENT. Intents for dead bodies are
 * ignored. NaN/Infinity components count as 0. "gs" below is gmScale(world) (cosmic.ts) and
 * multiplies every well's gm everywhere gravity is used in this step.
 *
 * Leaving play: whenever a body stops being alive in a step (a well death in 7, being absorbed in
 * 9, a rotation leave in 12E e), if its ultActive > 0 emit {type:"ultEnd"} for it first; then set
 * ultActive = 0 and every power timer to 0 (a corpse never carries an active Singularity).
 *
 * Order of operations (tests and the reference implementation depend on it):
 *  0. world.events = []. If phase is "over": return (nothing else changes, tick included).
 *  1. tick += 1. Countdown: if phase is "countdown": countdown -= dt; set px/py = x/y for bodies
 *     and debris; if countdown <= 0 then countdown = 0, phase = "playing", emit {type:"phase"}.
 *     Return.
 *  2. time += dt; timeLeft = max(0, timeLeft - dt). Then:
 *     a. Escalation: if timeLeft <= CONFIG.escalation.last, arenaRadius = arenaBase *
 *        (1 - (1 - shrinkTo) * (1 - timeLeft / last)); emit {type:"escalation"} on the first step
 *        this applies (detect: arenaRadius was still arenaBase before the update).
 *     b. Moving wells: for each well with an orbit, θ = phase + w * time; (x, y) = (cx, cy) +
 *        r (cos θ, sin θ); (vx, vy) = r w (-sin θ, cos θ).
 *     c. Zones: each zone moves by (vx, vy) * dt; if |centre| + r > arenaRadius afterwards,
 *        reflect the radial component of its velocity (v -= 2 (v·n) n, n = centre/|centre|).
 *     d. meteors = updateCosmic(world) (cosmic.ts); gs = gmScale(world).
 *  3. Each ALIVE body, in array order:
 *     a. px,py = x,y. shield, warpCooldown, dashCd, repulseCd, slingCd = max(0, value - dt); each
 *        power timer = max(0, value - dt). If ultActive > 0: ultActive -= dt; if it reaches <= 0,
 *        ultActive = 0 and emit {type:"ultEnd"}.
 *     b. Clamp the intent vector a to length <= 1. thrusting = |a| > CONFIG.body.thrustDeadzone
 *        && energy > 0. pulling = intent.pull && energy > 0. idleTime = 0 if thrusting or
 *        pulling, else idleTime + dt.
 *     c. Abilities, in this order, each only if requested and ready:
 *        - Singularity: intent.ult && ult >= 1 && ultActive == 0 -> ultActive =
 *          abilities.ult.duration, ult = 0, stats.ults += 1, emit {type:"ultStart"}.
 *        - Dash: intent.dash && dashCd == 0 && energy >= dash.cost -> direction u = a/|a| if
 *          thrusting-length |a| > thrustDeadzone, else v/|v| if |v| >= 1e-6, else no dash (and no
 *          cost). On a dash: energy -= cost; impulse = u * dash.impulse (added in 3f); dashCd =
 *          dash.cooldown; stats.dashes += 1; emit {type:"dash", dx/dy = u}.
 *        - Repulse: intent.repulse && repulseCd == 0 && energy >= repulse.cost -> energy -= cost;
 *          repulseCd = repulse.cooldown; the body repulses in step 4b; stats.repulses += 1; emit
 *          {type:"repulse", r: repulseRadius(body)}.
 *     d. Energy: e -= thrustCost*|a|*dt if thrusting; e -= pullCost*dt if pulling and
 *        ultActive == 0; e += regen*dt (times powerups.overdrive.regenMul while overdrive > 0).
 *        charging = false; for each well with chargeRate > 0 and radius < d < chargeRadius
 *        (d = centre distance): charging = true, e += chargeRate * (1 - (d - radius) /
 *        (chargeRadius - radius)) * dt. For each anomaly zone containing the centre (d < r):
 *        e += zones.anomalyEnergy*dt and ult = min(1, ult + zone.strength*dt). Clamp e to
 *        [0, max]. lowEnergy as before (old >= lowThreshold, new < lowThreshold).
 *     e. Accelerations:
 *        - gravity: sum over wells with gm > 0 of gs*gm / (d² + soft²) toward the well (skip d == 0);
 *        - wall: r = |centre|, lim = arenaRadius - radius; if r > lim add -(r - lim)*wallStiffness
 *          along the outward radial unit vector;
 *        - idle safety (player, difficulty's idleSafety non-null, idleTime >= after): per well
 *          with d > 0 and s = d - radius < range, push * gs*gm / (d² + soft²) * (1 - max(0, s)/range)
 *          AWAY from the well;
 *        - pulsar beams: for each well with a beam, θ = beam.phase + beam.w * time; for each of the
 *          two beam directions θ and θ + π: if radius < d < beam.length and the angle between
 *          (body - well) and the beam direction is <= halfWidth, add beam.accel * (1 - d/length)
 *          along (body - well)/d;
 *        - repulsor zones containing the centre: zone.strength * (1 - d/zone.r) away from the
 *          zone centre (skip d == 0);
 *        - thrust: aT = thrustAccel(mass) * a when thrusting, else 0.
 *     f. Velocity: vNo = v + (gravity + wall + safety + beams + repulsors) * dt + dash impulse.
 *        vNew = vNo + aT*dt. If |vNew| > maxSpeed(mass) and |vNew| > |vNo|, rescale vNew to
 *        length max(maxSpeed(mass), |vNo|). Drag: v = vNew * exp(-drag * m * dt), m = product of
 *        the strengths of nebula zones containing the centre (1 if none). Clamp |v| to
 *        hardSpeedCap. Position += v*dt. stats.topSpeed = max(topSpeed, |v|).
 *  4. Pull: for each alive pulling body P, R = pullRadius(P), k = (P.ultActive > 0 ?
 *     ult.pullAccelMul : 1): debris with d < R gets v += debrisAccel*k*(1 - d/R)*dt toward P
 *     (skip d == 0); each other alive body B with canAbsorb(P, B) and d < R gets
 *     v += bodyAccel*k*(1 - d/R)*dt toward P.
 *     4b. Repulse: for each body Q that repulsed in 3c (array order), Rr = repulseRadius(Q):
 *     debris with 0 < d < Rr: v += repulse.debrisImpulse * (1 - d/Rr) away from Q; each other
 *     alive body B with 0 < d < Rr: v += repulse.impulse * (1 - d/Rr) * min(1.6, 2*Q.mass /
 *     (Q.mass + B.mass)) away from Q, then B.lastHitBy = Q.id, B.lastHitAt = time.
 *  5. Debris, in array order: px,py = x,y; v += gravity (gs-scaled) * dt; v *= exp(-c * m * dt)
 *     where c = comets.drag for comets else debris.drag and m = nebula multiplier as in 3f;
 *     position += v*dt. Removed (no event) if its centre ends inside any well's radius. Outside
 *     arenaRadius: put back on the boundary and reflect the radial velocity.
 *     5b. Pickups: ttl -= dt; remove those with ttl <= 0 (no event).
 *  6. Wormholes: as before (each alive body with warpCooldown == 0 inside a wormhole radius moves
 *     to link + u*(link.radius + radius + 4), u = unit velocity or (1,0); keeps velocity; px/py =
 *     new position; warpCooldown = CONFIG.wormhole.cooldown; emit {type:"warp"}; once per step).
 *  7. Wells, for each alive body and each well in order:
 *     - lethal wells: if d < lethalRadius(world, well) + radius * killOverlap and power.phase == 0,
 *       the body dies: alive = false; cause {by: well.kind}; if lastHitBy !== "" and
 *       time - lastHitAt <= abilities.assistWindow and that body exists, add assistId =
 *       lastHitBy, increment the assister's stats.assists and emit {type:"assist"} after the
 *       death event. Emit {type:"death"}. Stop checking wells for this body.
 *     - solid wells (lethal false): if d < well.radius + radius: move the body out along
 *       n = (body - well)/d (use (1,0) if d == 0) to d = well.radius + radius; vrel = (v - wv)·n;
 *       if vrel < 0: v -= (1 + solidRestitution) * vrel * n and, when -vrel > 40, emit
 *       {type:"solidHit", impulse = -(1 + solidRestitution) * vrel * mass}.
 *  8. Eating, bodies then debris in array order (as before): an alive body eats each debris whose
 *     centre distance < radius: mass += debris.mass; crystals add CONFIG.crystal.energy (clamped)
 *     and count in stats.crystals; comets count in stats.comets; dust/rock in stats.debrisEaten.
 *     Every eaten piece adds debris.mass * ult.debrisShare / ult.chargeMass to ult (clamp 1;
 *     emit {type:"ultReady"} when ult reaches 1 from below). Emit {type:"eat"}; remove it.
 *     8b. Pickups, bodies then pickups in array order: an alive body collects a pickup whose
 *     centre distance < radius + powerups.radius: overdrive/magnet/phase set power[kind] =
 *     powerups[kind].duration; bulk adds powerups.bulk.mass; stats.pickups += 1; emit
 *     {type:"pickup"}; remove it.
 *  9. Bodies vs bodies: exactly as before (pairs i < j, big = heavier (tie: lower index),
 *     canAbsorb(big, small) — which now honours the Singularity ratio — shields, overlap depth,
 *     bounce otherwise). An absorption also adds small.mass / ult.chargeMass to big.ult (clamp 1;
 *     ultReady as in 8).
 * 10. For every body: radius = radiusForMass(mass); stats.peakMass = max(peakMass, mass).
 *     Slingshot: each alive body with slingCd == 0 whose speed > slingshot.minSpeedMul *
 *     maxSpeed(mass) and whose centre is within slingshot.band * well.radius + 60 of any well:
 *     energy += slingshot.energy (clamp), ult += slingshot.ult (clamp, ultReady as in 8), slingCd
 *     = slingshot.cooldown, stats.slingshots += 1, emit {type:"slingshot", speed}.
 * 11. Spawning (placement for dust/rock: if world.debrisField.ringShare > 0, with probability
 *     ringShare (one rand() draw, made only when ringShare > 0) pick a point uniform by area in
 *     the annulus [ringInner, ringOuter], else uniform over the disc of radius arenaRadius; retry
 *     while within well.radius + debris.wellClearance of any well; crystals always uniform):
 *     - debris and crystals: credit rules as before (spawnRate/target, credit capped at 1);
 *     - meteors: spawn `meteors` rocks (rockMass) uniform in the shower's circle — use the shower
 *       as it was BEFORE updateCosmic ran in 2d, so the final step's meteors still land — velocity
 *       uniform in [-80, 80] per axis; not counted against debris.target;
 *     - comets: credit += comets.spawnRate*dt; while credit >= 1 and live comets < comets.max:
 *       spawn at r = arenaRadius - 40 (random angle), aimed at a uniform point within 600 of the
 *       centre, speed in comets.speed, mass in comets.mass; credit -= 1; then credit = min(credit, 1);
 *     - pickups: credit += powerups.spawnRate*dt; while credit >= 1 and pickups < powerups.max:
 *       kind uniform over the 4 kinds, position uniform within arenaRadius - 200, not within 250
 *       of any living body nor within any lethal well's max(chargeRadius, radius) + 60 (200 tries
 *       then the last draw); ttl = powerups.ttl; id = nextDebrisId++; credit -= 1; then
 *       credit = min(credit, 1).
 * 12. Round mode — round end, first match wins (as before): a. player dead -> "playerDied"
 *     (playerCause from this step's death event); b. a living body with mass >= criticalMass ->
 *     "criticalMass"; c. only the player alive and at least one bot -> "lastStanding";
 *     d. timeLeft <= 0 -> "timeUp". On a match: phase "over", result set, emit {type:"phase"} and
 *     {type:"roundEnd"}.
 * 12E. Endless mode instead (never ends; phase stays "playing"), in this order:
 *     a. Mass decay: every living body with mass > endless.decayAbove loses
 *        (mass - decayAbove) * decayRate * dt; then radius = radiusForMass(mass).
 *     b. Bookkeeping from this step's events: each absorb with eaterId "player" -> kills += 1; if
 *        the player died this step: deaths += 1, respawnIn = respawnDelay, lastKillerId = killer id
 *        (cause.by === "body") else ""; each bot that died this step -> joinIn[i] = a draw in
 *        joinDelay. best = max(best, player.mass) while the player is alive.
 *     c. Player respawn: if the player is dead and respawnIn > 0: respawnIn -= dt; when it reaches
 *        <= 0: respawnIn = 0 and the player body is reset in place — mass startMass, radius,
 *        energy max, velocity 0, all timers/cooldowns/ult/power 0, lastHitBy "", shield
 *        respawnShield, alive true, position = safeSpawn (below), px/py = x/y; stats kept
 *        (cumulative); emit {type:"respawn"}.
 *     d. Joins: for each body index i with joinIn[i] > 0: joinIn[i] -= dt; when <= 0: joinIn[i] =
 *        0 and slot i becomes a NEW bot: id "bot-<nextBotNo++>", kind "bot", name = the first of
 *        endless.names (starting at a random offset, wrapping) not used by a living body, colour =
 *        CONFIG.bots.colors[(nextBotNo-1) % length], skill by the drift rule on the player's
 *        current mass (startMass if dead), mass = startMass * U(0.8, 1.0) * (1 + joinGrowth *
 *        clamp(m/100, 0, 1)), all other fields as a fresh body (stats zero, peakMass = mass),
 *        shield respawnShield, position = safeSpawn; emit {type:"join"}.
 *     e. Rotation: rotateIn -= dt; when <= 0: rotateIn = a draw in rotateEvery; choose a living
 *        bot uniformly among those that are not the heaviest living body and are >= 900 from the
 *        player (skip if none): it leaves — alive = false, emit {type:"leave"} (no death event,
 *        no stats) — and joinIn[i] = rotateJoinDelay.
 *     safeSpawn: 30 candidate points uniform by area in the annulus [500, arenaRadius - 300];
 *     discard candidates within (lethal well max(chargeRadius, radius) + 200) of a lethal well or
 *     inside a solid well + 150; pick the candidate maximising the distance to the nearest living
 *     body heavier than startMass * CONFIG.absorb.ratio (ties/none: the first candidate); if all
 *     were discarded use the last candidate.
 */
export function step(world: World, intents: ReadonlyMap<string, Intent> | Readonly<Record<string, Intent>>): void {
  // 0.
  world.events = []
  if (world.phase === "over") return
  const events = world.events
  const dt = CONFIG.dt
  const bodies = world.bodies
  const wells = world.wells
  const debris = world.debris
  const zones = world.zones

  // 1.
  world.tick += 1
  if (world.phase === "countdown") {
    world.countdown -= dt
    for (const b of bodies) {
      b.px = b.x
      b.py = b.y
    }
    for (const d of debris) {
      d.px = d.x
      d.py = d.y
    }
    if (world.countdown <= 0) {
      world.countdown = 0
      world.phase = "playing"
      events.push({ type: "phase", phase: "playing" })
    }
    return
  }

  // 2.
  world.time += dt
  world.timeLeft = Math.max(0, world.timeLeft - dt)
  const time = world.time

  // 2a. escalation
  if (world.timeLeft <= CONFIG.escalation.last) {
    const wasBase = world.arenaRadius === world.arenaBase
    world.arenaRadius =
      world.arenaBase * (1 - (1 - CONFIG.escalation.shrinkTo) * (1 - world.timeLeft / CONFIG.escalation.last))
    if (wasBase && world.arenaRadius < world.arenaBase) {
      events.push({ type: "escalation", arenaRadius: world.arenaRadius })
    }
  }

  // 2b. moving wells
  for (let wi = 0; wi < wells.length; wi++) {
    const w = wells[wi]
    const o = w.orbit
    if (!o) continue
    const th = o.phase + o.w * time
    const c = Math.cos(th)
    const s = Math.sin(th)
    w.x = o.cx + o.r * c
    w.y = o.cy + o.r * s
    w.vx = -o.r * o.w * s
    w.vy = o.r * o.w * c
  }

  // 2c. zones
  for (let zi = 0; zi < zones.length; zi++) {
    const z = zones[zi]
    z.x += z.vx * dt
    z.y += z.vy * dt
    const zr = Math.sqrt(z.x * z.x + z.y * z.y)
    if (zr > 0 && zr + z.r > world.arenaRadius) {
      const nx = z.x / zr
      const ny = z.y / zr
      const vn = z.vx * nx + z.vy * ny
      // Only when moving outward: a zone that starts just inside the wall heading inward must not be flipped.
      if (vn > 0) {
        z.vx -= 2 * vn * nx
        z.vy -= 2 * vn * ny
      }
    }
  }

  // 2d. cosmic
  const cosmicBefore = world.cosmic // the shower as it was before this step (it may end inside updateCosmic)
  const meteors = updateCosmic(world)
  const gs = gmScale(world)

  const isMap = intents instanceof Map
  const bc = CONFIG.body
  const ec = CONFIG.energy
  const ab = CONFIG.abilities
  const dragFactor = Math.exp(-bc.drag * dt)
  const hasZones = zones.length > 0
  repulsers.length = 0

  // 3.
  for (let bi = 0; bi < bodies.length; bi++) {
    const b = bodies[bi]
    if (!b.alive) continue
    // a.
    b.px = b.x
    b.py = b.y
    b.shield = Math.max(0, b.shield - dt)
    b.warpCooldown = Math.max(0, b.warpCooldown - dt)
    b.dashCd = Math.max(0, b.dashCd - dt)
    b.repulseCd = Math.max(0, b.repulseCd - dt)
    b.slingCd = Math.max(0, b.slingCd - dt)
    b.power.overdrive = Math.max(0, b.power.overdrive - dt)
    b.power.magnet = Math.max(0, b.power.magnet - dt)
    b.power.phase = Math.max(0, b.power.phase - dt)
    if (b.ultActive > 0) {
      b.ultActive -= dt
      if (b.ultActive <= 0) {
        b.ultActive = 0
        events.push({ type: "ultEnd", bodyId: b.id })
      }
    }

    // b.
    const intent = isMap
      ? (intents as ReadonlyMap<string, Intent>).get(b.id)
      : (intents as Readonly<Record<string, Intent>>)[b.id]
    let ax = 0
    let ay = 0
    let wantPull = false
    let wantDash = false
    let wantRepulse = false
    let wantUlt = false
    if (intent) {
      ax = Number.isFinite(intent.ax) ? intent.ax : 0
      ay = Number.isFinite(intent.ay) ? intent.ay : 0
      wantPull = !!intent.pull
      wantDash = !!intent.dash
      wantRepulse = !!intent.repulse
      wantUlt = !!intent.ult
    }
    let alen = Math.hypot(ax, ay) // hypot: no overflow for huge (untrusted) intents
    if (alen > 1) {
      ax /= alen
      ay /= alen
      alen = 1
    }
    const thrusting = alen > bc.thrustDeadzone && b.energy > 0
    const pulling = wantPull && b.energy > 0
    b.thrusting = thrusting
    b.pulling = pulling
    b.idleTime = thrusting || pulling ? 0 : b.idleTime + dt

    // c. abilities
    const oldE = b.energy
    let dashX = 0
    let dashY = 0
    if (wantUlt && b.ult >= 1 && b.ultActive === 0) {
      b.ultActive = ab.ult.duration
      b.ult = 0
      b.stats.ults += 1
      events.push({ type: "ultStart", bodyId: b.id, x: b.x, y: b.y })
    }
    if (wantDash && b.dashCd === 0 && b.energy >= ab.dash.cost) {
      let ux = 0
      let uy = 0
      let ok = false
      if (alen > bc.thrustDeadzone) {
        ux = ax / alen
        uy = ay / alen
        ok = true
      } else {
        const sp = Math.hypot(b.vx, b.vy)
        if (sp >= 1e-6) {
          ux = b.vx / sp
          uy = b.vy / sp
          ok = true
        }
      }
      if (ok) {
        b.energy -= ab.dash.cost
        dashX = ux * ab.dash.impulse
        dashY = uy * ab.dash.impulse
        b.dashCd = ab.dash.cooldown
        b.stats.dashes += 1
        events.push({ type: "dash", bodyId: b.id, x: b.x, y: b.y, dx: ux, dy: uy })
      }
    }
    if (wantRepulse && b.repulseCd === 0 && b.energy >= ab.repulse.cost) {
      b.energy -= ab.repulse.cost
      b.repulseCd = ab.repulse.cooldown
      b.stats.repulses += 1
      repulsers.push(b)
      events.push({ type: "repulse", bodyId: b.id, x: b.x, y: b.y, r: repulseRadius(b) })
    }

    // d. energy
    let e = b.energy
    if (thrusting) e -= ec.thrustCost * alen * dt
    if (pulling && b.ultActive === 0) e -= ec.pullCost * dt
    e += b.power.overdrive > 0 ? ec.regen * CONFIG.powerups.overdrive.regenMul * dt : ec.regen * dt
    let charging = false
    for (let wi = 0; wi < wells.length; wi++) {
      const w = wells[wi]
      if (!(w.chargeRate > 0)) continue
      const d = Math.hypot(b.x - w.x, b.y - w.y)
      if (d > w.radius && d < w.chargeRadius) {
        charging = true
        e += w.chargeRate * (1 - (d - w.radius) / (w.chargeRadius - w.radius)) * dt
      }
    }
    if (hasZones) {
      for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi]
        if (z.kind !== "anomaly") continue
        if (Math.hypot(b.x - z.x, b.y - z.y) < z.r) {
          e += CONFIG.zones.anomalyEnergy * dt
          addUlt(b, z.strength * dt, events)
        }
      }
    }
    b.charging = charging
    e = Math.min(ec.max, Math.max(0, e))
    b.energy = e
    if (oldE >= ec.lowThreshold && e < ec.lowThreshold) events.push({ type: "lowEnergy", bodyId: b.id })

    // e. accelerations
    wellGravity(wells, b.x, b.y, gs)
    let accX = gravX
    let accY = gravY
    const r = Math.sqrt(b.x * b.x + b.y * b.y)
    const lim = world.arenaRadius - b.radius
    if (r > lim) {
      const k = -(r - lim) * CONFIG.arena.wallStiffness
      accX += (b.x / r) * k
      accY += (b.y / r) * k
    }
    // Idle safety (player only): wells push back when the player has not acted for a while.
    // Removing it lets an idle easy-mode player drift into stars/the black hole.
    if (b.kind === "player") {
      const S = CONFIG.difficulty[world.difficulty].idleSafety
      if (S !== null && b.idleTime >= S.after) {
        const soft2 = CONFIG.well.soft * CONFIG.well.soft
        for (let wi = 0; wi < wells.length; wi++) {
          const w = wells[wi]
          const dx = b.x - w.x
          const dy = b.y - w.y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d === 0) continue
          const sd = d - w.radius
          if (sd >= S.range) continue
          const k = ((S.push * gs * w.gm) / (d * d + soft2)) * (1 - Math.max(0, sd) / S.range)
          accX += (dx / d) * k
          accY += (dy / d) * k
        }
      }
    }
    // Pulsar beams.
    for (let wi = 0; wi < wells.length; wi++) {
      const w = wells[wi]
      const bm = w.beam
      if (!bm) continue
      const dx = b.x - w.x
      const dy = b.y - w.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= w.radius || d >= bm.length) continue
      const th = bm.phase + bm.w * time
      const c = Math.cos(th)
      const s = Math.sin(th)
      const cosHalf = Math.cos(bm.halfWidth)
      const dot = (dx * c + dy * s) / d
      if (dot >= cosHalf || -dot >= cosHalf) {
        const k = bm.accel * (1 - d / bm.length)
        accX += (dx / d) * k
        accY += (dy / d) * k
      }
    }
    // Repulsor zones and nebula drag.
    let dragMul = 1
    if (hasZones) {
      for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi]
        if (z.kind === "anomaly") continue
        const dx = b.x - z.x
        const dy = b.y - z.y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d >= z.r) continue
        if (z.kind === "nebula") {
          dragMul *= z.strength
        } else if (d > 0) {
          const k = z.strength * (1 - d / z.r)
          accX += (dx / d) * k
          accY += (dy / d) * k
        }
      }
    }
    let aTx = 0
    let aTy = 0
    if (thrusting) {
      const ta = thrustAccel(b.mass)
      aTx = ta * ax
      aTy = ta * ay
    }

    // f. velocity
    const vNoX = b.vx + accX * dt + dashX
    const vNoY = b.vy + accY * dt + dashY
    let vx = vNoX + aTx * dt
    let vy = vNoY + aTy * dt
    const sNew = Math.sqrt(vx * vx + vy * vy)
    const ms = maxSpeed(b.mass)
    if (sNew > ms) {
      const sNo = Math.sqrt(vNoX * vNoX + vNoY * vNoY)
      if (sNew > sNo) {
        const target = Math.max(ms, sNo)
        const f = target / sNew
        vx *= f
        vy *= f
      }
    }
    const df = dragMul === 1 ? dragFactor : Math.exp(-bc.drag * dragMul * dt)
    vx *= df
    vy *= df
    const s2 = Math.sqrt(vx * vx + vy * vy)
    if (s2 > bc.hardSpeedCap) {
      const f = bc.hardSpeedCap / s2
      vx *= f
      vy *= f
    }
    b.vx = vx
    b.vy = vy
    b.x += vx * dt
    b.y += vy * dt
    const sp = s2 > bc.hardSpeedCap ? bc.hardSpeedCap : s2
    if (sp > b.stats.topSpeed) b.stats.topSpeed = sp
  }

  // 4. pull
  for (let pi = 0; pi < bodies.length; pi++) {
    const p = bodies[pi]
    if (!p.alive || !p.pulling) continue
    const R = pullRadius(p)
    const k = p.ultActive > 0 ? ab.ult.pullAccelMul : 1
    for (let i = 0; i < debris.length; i++) {
      const d = debris[i]
      const dx = p.x - d.x
      const dy = p.y - d.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < R && dist > 0) {
        const a = CONFIG.pull.debrisAccel * k * (1 - dist / R) * dt
        d.vx += (dx / dist) * a
        d.vy += (dy / dist) * a
      }
    }
    for (let bi = 0; bi < bodies.length; bi++) {
      const o = bodies[bi]
      if (bi === pi || !o.alive || !canAbsorb(p, o)) continue
      const dx = p.x - o.x
      const dy = p.y - o.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < R && dist > 0) {
        const a = CONFIG.pull.bodyAccel * k * (1 - dist / R) * dt
        o.vx += (dx / dist) * a
        o.vy += (dy / dist) * a
      }
    }
  }

  // 4b. repulse
  for (let ri = 0; ri < repulsers.length; ri++) {
    const q = repulsers[ri]
    const Rr = repulseRadius(q)
    for (let i = 0; i < debris.length; i++) {
      const d = debris[i]
      const dx = d.x - q.x
      const dy = d.y - q.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > 0 && dist < Rr) {
        const a = ab.repulse.debrisImpulse * (1 - dist / Rr)
        d.vx += (dx / dist) * a
        d.vy += (dy / dist) * a
      }
    }
    for (let bi = 0; bi < bodies.length; bi++) {
      const o = bodies[bi]
      if (o === q || !o.alive) continue
      const dx = o.x - q.x
      const dy = o.y - q.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > 0 && dist < Rr) {
        const a = ab.repulse.impulse * (1 - dist / Rr) * Math.min(1.6, (2 * q.mass) / (q.mass + o.mass))
        o.vx += (dx / dist) * a
        o.vy += (dy / dist) * a
        o.lastHitBy = q.id
        o.lastHitAt = time
      }
    }
  }

  // 5. debris (in-place compaction)
  {
    const dragD = Math.exp(-CONFIG.debris.drag * dt)
    const arenaR = world.arenaRadius
    let w = 0
    for (let i = 0; i < debris.length; i++) {
      const d = debris[i]
      d.px = d.x
      d.py = d.y
      wellGravity(wells, d.x, d.y, gs)
      d.vx += gravX * dt
      d.vy += gravY * dt
      let df = d.kind === "comet" ? Math.exp(-CONFIG.comets.drag * dt) : dragD
      if (hasZones) {
        let m = 1
        for (let zi = 0; zi < zones.length; zi++) {
          const z = zones[zi]
          if (z.kind !== "nebula") continue
          const dx = d.x - z.x
          const dy = d.y - z.y
          if (dx * dx + dy * dy < z.r * z.r) m *= z.strength
        }
        if (m !== 1) df = Math.exp(-(d.kind === "comet" ? CONFIG.comets.drag : CONFIG.debris.drag) * m * dt)
      }
      d.vx *= df
      d.vy *= df
      d.x += d.vx * dt
      d.y += d.vy * dt
      let inWell = false
      for (let wi = 0; wi < wells.length; wi++) {
        const well = wells[wi]
        const dx = d.x - well.x
        const dy = d.y - well.y
        if (dx * dx + dy * dy < well.radius * well.radius) {
          inWell = true
          break
        }
      }
      if (inWell) continue
      const r = Math.sqrt(d.x * d.x + d.y * d.y)
      if (r > arenaR) {
        const nx = d.x / r
        const ny = d.y / r
        d.x = nx * arenaR
        d.y = ny * arenaR
        const vn = d.vx * nx + d.vy * ny
        d.vx -= 2 * vn * nx
        d.vy -= 2 * vn * ny
      }
      debris[w++] = d
    }
    debris.length = w
  }

  // 5b. pickups
  {
    const pk = world.pickups
    let w = 0
    for (let i = 0; i < pk.length; i++) {
      const p = pk[i]
      p.ttl -= dt
      if (p.ttl > 0) pk[w++] = p
    }
    pk.length = w
  }

  // 6. wormholes
  const whs = world.wormholes
  for (let bi = 0; bi < bodies.length; bi++) {
    const b = bodies[bi]
    if (!b.alive || b.warpCooldown !== 0) continue
    for (let wi = 0; wi < whs.length; wi++) {
      const wh = whs[wi]
      if (Math.hypot(b.x - wh.x, b.y - wh.y) >= wh.radius) continue
      let link: Wormhole | undefined
      for (let k = 0; k < whs.length; k++) {
        if (whs[k].id === wh.linkId) {
          link = whs[k]
          break
        }
      }
      if (!link) break
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
      const ux = sp < 1e-6 ? 1 : b.vx / sp
      const uy = sp < 1e-6 ? 0 : b.vy / sp
      const fromX = b.x
      const fromY = b.y
      const off = link.radius + b.radius + 4
      b.x = link.x + ux * off
      b.y = link.y + uy * off
      b.px = b.x
      b.py = b.y
      b.warpCooldown = CONFIG.wormhole.cooldown
      events.push({ type: "warp", bodyId: b.id, fromX, fromY, toX: b.x, toY: b.y })
      break
    }
  }

  // 7. wells
  for (let bi = 0; bi < bodies.length; bi++) {
    const b = bodies[bi]
    if (!b.alive) continue
    for (let wi = 0; wi < wells.length; wi++) {
      const w = wells[wi]
      const dx = b.x - w.x
      const dy = b.y - w.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (w.lethal) {
        if (d < lethalRadius(world, w) + b.radius * CONFIG.well.killOverlap && b.power.phase === 0) {
          b.alive = false
          leavePlay(b, events)
          let assister: Body | null = null
          if (b.lastHitBy !== "" && time - b.lastHitAt <= ab.assistWindow) {
            for (let k = 0; k < bodies.length; k++) {
              if (bodies[k].id === b.lastHitBy) {
                assister = bodies[k]
                break
              }
            }
          }
          const lethalKind = w.kind as LethalWellKind
          events.push({
            type: "death",
            bodyId: b.id,
            cause: assister ? { by: lethalKind, assistId: assister.id } : { by: lethalKind },
            x: b.x,
            y: b.y,
          })
          if (assister) {
            assister.stats.assists += 1
            events.push({ type: "assist", bodyId: assister.id, victimId: b.id })
          }
          break
        }
      } else if (d < w.radius + b.radius) {
        const nx = d === 0 ? 1 : dx / d
        const ny = d === 0 ? 0 : dy / d
        const reach = w.radius + b.radius
        b.x = w.x + nx * reach
        b.y = w.y + ny * reach
        const vrel = (b.vx - w.vx) * nx + (b.vy - w.vy) * ny
        if (vrel < 0) {
          const f = (1 + CONFIG.solidRestitution) * vrel
          b.vx -= f * nx
          b.vy -= f * ny
          if (-vrel > 40) {
            events.push({
              type: "solidHit",
              bodyId: b.id,
              wellId: w.id,
              impulse: -f * b.mass,
              x: b.x,
              y: b.y,
            })
          }
        }
      }
    }
  }

  // 8. eating
  const debrisUlt = (CONFIG.abilities.ult.debrisShare) / CONFIG.abilities.ult.chargeMass
  for (let bi = 0; bi < bodies.length; bi++) {
    const b = bodies[bi]
    if (!b.alive) continue
    let w = 0
    for (let i = 0; i < debris.length; i++) {
      const d = debris[i]
      const dx = d.x - b.x
      const dy = d.y - b.y
      if (Math.sqrt(dx * dx + dy * dy) < b.radius) {
        b.mass += d.mass
        if (d.kind === "crystal") {
          b.energy = Math.min(ec.max, b.energy + CONFIG.crystal.energy)
          b.stats.crystals += 1
        } else if (d.kind === "comet") {
          b.stats.comets += 1
        } else {
          b.stats.debrisEaten += 1
        }
        addUlt(b, d.mass * debrisUlt, events)
        events.push({ type: "eat", bodyId: b.id, kind: d.kind, mass: d.mass, x: d.x, y: d.y })
      } else {
        debris[w++] = d
      }
    }
    debris.length = w
  }

  // 8b. pickups
  {
    const pk = world.pickups
    if (pk.length > 0) {
      const pu = CONFIG.powerups
      for (let bi = 0; bi < bodies.length; bi++) {
        const b = bodies[bi]
        if (!b.alive) continue
        let w = 0
        for (let i = 0; i < pk.length; i++) {
          const p = pk[i]
          if (Math.hypot(p.x - b.x, p.y - b.y) < b.radius + pu.radius) {
            if (p.kind === "bulk") b.mass += pu.bulk.mass
            else b.power[p.kind] = pu[p.kind].duration
            b.stats.pickups += 1
            events.push({ type: "pickup", bodyId: b.id, kind: p.kind, x: p.x, y: p.y })
          } else {
            pk[w++] = p
          }
        }
        pk.length = w
      }
    }
  }

  // 9. bodies vs bodies
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i]
      const c = bodies[j]
      if (!a.alive || !c.alive) continue
      const dx = c.x - a.x
      const dy = c.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist >= a.radius + c.radius) continue
      const big = c.mass > a.mass ? c : a
      const small = big === a ? c : a
      if (canAbsorb(big, small) && big.shield === 0 && small.shield === 0) {
        if (dist < big.radius - small.radius * CONFIG.absorb.overlap) {
          const gained = small.mass * CONFIG.absorb.massGain
          big.mass += gained
          big.energy = Math.min(ec.max, big.energy + small.energy * CONFIG.absorb.energyGain)
          big.stats.rivalsAbsorbed += 1
          small.alive = false
          leavePlay(small, events)
          events.push({ type: "absorb", eaterId: big.id, victimId: small.id, mass: gained, x: small.x, y: small.y })
          events.push({
            type: "death",
            bodyId: small.id,
            cause: { by: "body", killerId: big.id },
            x: small.x,
            y: small.y,
          })
          addUlt(big, small.mass / ab.ult.chargeMass, events)
        }
      } else {
        const nx = dist === 0 ? 1 : dx / dist
        const ny = dist === 0 ? 0 : dy / dist
        const overlap = a.radius + c.radius - dist
        const mt = a.mass + c.mass
        const moveA = (overlap * c.mass) / mt
        const moveC = (overlap * a.mass) / mt
        a.x -= nx * moveA
        a.y -= ny * moveA
        c.x += nx * moveC
        c.y += ny * moveC
        const vrn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny
        if (vrn < 0) {
          const J = (-(1 + CONFIG.absorb.restitution) * vrn) / (1 / a.mass + 1 / c.mass)
          a.vx -= (J / a.mass) * nx
          a.vy -= (J / a.mass) * ny
          c.vx += (J / c.mass) * nx
          c.vy += (J / c.mass) * ny
          if (J / Math.min(a.mass, c.mass) >= CONFIG.absorb.bounceEventMin) {
            events.push({
              type: "bounce",
              aId: a.id,
              bId: c.id,
              impulse: J,
              x: a.x + nx * a.radius,
              y: a.y + ny * a.radius,
            })
          }
        }
      }
    }
  }

  // 10. radius, peak mass, slingshot
  for (const b of bodies) {
    b.radius = radiusForMass(b.mass)
    if (b.mass > b.stats.peakMass) b.stats.peakMass = b.mass
  }
  {
    const sl = CONFIG.slingshot
    for (let bi = 0; bi < bodies.length; bi++) {
      const b = bodies[bi]
      if (!b.alive || b.slingCd !== 0) continue
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
      if (speed <= sl.minSpeedMul * maxSpeed(b.mass)) continue
      for (let wi = 0; wi < wells.length; wi++) {
        const w = wells[wi]
        if (Math.hypot(b.x - w.x, b.y - w.y) < sl.band * w.radius + 60) {
          b.energy = Math.min(ec.max, b.energy + sl.energy)
          addUlt(b, sl.ult, events)
          b.slingCd = sl.cooldown
          b.stats.slingshots += 1
          events.push({ type: "slingshot", bodyId: b.id, speed, x: b.x, y: b.y })
          break
        }
      }
    }
  }

  // 11. spawning
  {
    let count = 0
    let crystals = 0
    let comets = 0
    for (let i = 0; i < debris.length; i++) {
      const k = debris[i].kind
      if (k === "crystal") crystals++
      else if (k === "comet") comets++
      else count++
    }
    const sc = world.spawnCredit
    sc.debris += CONFIG.debris.spawnRate * dt
    while (sc.debris >= 1 && count < CONFIG.debris.target) {
      spawnDebris(world, false)
      count++
      sc.debris -= 1
    }
    sc.debris = Math.min(sc.debris, 1)
    sc.crystal += CONFIG.crystal.spawnRate * dt
    while (sc.crystal >= 1 && crystals < CONFIG.crystal.target) {
      spawnDebris(world, true)
      crystals++
      sc.crystal -= 1
    }
    sc.crystal = Math.min(sc.crystal, 1)

    const shower = cosmicBefore ?? world.cosmic
    if (meteors > 0 && shower !== null) {
      for (let i = 0; i < meteors; i++) spawnMeteor(world, shower)
    }

    sc.comet += CONFIG.comets.spawnRate * dt
    while (sc.comet >= 1 && comets < CONFIG.comets.max) {
      spawnComet(world)
      comets++
      sc.comet -= 1
    }
    sc.comet = Math.min(sc.comet, 1)

    sc.pickup += CONFIG.powerups.spawnRate * dt
    while (sc.pickup >= 1 && world.pickups.length < CONFIG.powerups.max) {
      spawnPickup(world)
      sc.pickup -= 1
    }
    sc.pickup = Math.min(sc.pickup, 1)
  }

  // 12E. endless mode: never ends.
  if (world.mode === "endless" && world.endless) {
    stepEndless(world, events.length)
    return
  }

  // 12. round end
  let reason: RoundEndReason | null = null
  let winner: Body | null = null
  let playerCause: DeathCause | undefined
  const player = bodies[0]
  if (!player.alive) {
    reason = "playerDied"
    for (const ev of events) {
      if (ev.type === "death" && ev.bodyId === player.id) playerCause = ev.cause
    }
    winner = heaviestAlive(bodies, 1)
  } else {
    let crit: Body | null = null
    let aliveCount = 0
    for (const b of bodies) {
      if (!b.alive) continue
      aliveCount++
      if (b.mass >= world.roundCriticalMass && (!crit || b.mass > crit.mass)) crit = b
    }
    if (crit) {
      reason = "criticalMass"
      winner = crit
    } else if (aliveCount === 1 && bodies.length > 1) {
      reason = "lastStanding"
      winner = player
    } else if (world.timeLeft <= 0) {
      reason = "timeUp"
      winner = heaviestAlive(bodies, 0)
    }
  }
  if (reason) {
    const result: RoundResult = {
      reason,
      winnerId: winner ? winner.id : null,
      playerWon: winner !== null && winner.id === "player",
      standings: buildStandings(bodies),
      durationS: world.time,
    }
    if (reason === "playerDied" && playerCause) result.playerCause = playerCause
    world.phase = "over"
    world.result = result
    events.push({ type: "phase", phase: "over" })
    events.push({ type: "roundEnd", result })
  }
}

/**
 * Live leaderboard: the top `n` living bodies by mass (tie: lower index first) as
 * LeaderboardEntry rows with 1-based rank; if the player is alive and not among them, its row is
 * appended (with its true rank). Plain data — a Phase C server can send the same shape.
 */
export function leaderboard(world: World, n = 10): LeaderboardEntry[] {
  const bodies = world.bodies
  const order: number[] = []
  for (let i = 0; i < bodies.length; i++) if (bodies[i].alive) order.push(i)
  order.sort((i, j) => (bodies[i].mass !== bodies[j].mass ? bodies[j].mass - bodies[i].mass : i - j))
  const rows: LeaderboardEntry[] = []
  const toRow = (i: number, rank: number): LeaderboardEntry => {
    const b = bodies[i]
    return { id: b.id, name: b.name, color: b.color, mass: b.mass, isPlayer: b.kind === "player", rank }
  }
  const top = Math.min(n, order.length)
  let playerIn = false
  for (let k = 0; k < top; k++) {
    rows.push(toRow(order[k], k + 1))
    if (bodies[order[k]].kind === "player") playerIn = true
  }
  if (!playerIn && bodies.length > 0 && bodies[0].alive) rows.push(toRow(0, order.indexOf(0) + 1))
  return rows
}

/** 1-based rank of the body by mass among living bodies (tie: lower index first); 0 if dead or unknown. */
export function rankOf(world: World, id: string): number {
  const bodies = world.bodies
  let idx = -1
  for (let i = 0; i < bodies.length; i++) {
    if (bodies[i].id === id) {
      idx = i
      break
    }
  }
  if (idx < 0 || !bodies[idx].alive) return 0
  const m = bodies[idx].mass
  let rank = 1
  for (let i = 0; i < bodies.length; i++) {
    if (i === idx || !bodies[i].alive) continue
    if (bodies[i].mass > m || (bodies[i].mass === m && i < idx)) rank++
  }
  return rank
}

/**
 * HUD view of the player. countdown is Math.ceil(world.countdown); lowEnergy uses lowThreshold;
 * dashMax/repulseMax = the abilities' cooldowns; cosmic = world.cosmic ? {kind, stage,
 * secondsLeft: (stage === "warning" ? warning : duration) - t} : null; escalating =
 * arenaRadius < arenaBase; arena = world.arena; mode = world.mode; endless = world.endless ?
 * {respawnIn, best, deaths, kills, lastKiller: name of lastKillerId's body or ""} : null;
 * leaderboard = leaderboard(world, 10); the rest mirrors the player body.
 */
export function hudSnapshot(world: World): HudSnapshot {
  const p = world.bodies[0]
  let alive = 0
  for (const b of world.bodies) if (b.alive) alive++
  const cz = world.cosmic
  const cfgCosmic = cz ? CONFIG.cosmic[cz.kind] : null
  return {
    phase: world.phase,
    countdown: Math.ceil(world.countdown),
    timeLeft: world.timeLeft,
    mass: p.mass,
    energy: p.energy,
    energyMax: CONFIG.energy.max,
    criticalMass: world.roundCriticalMass,
    rank: rankOf(world, "player"),
    alive,
    total: world.bodies.length,
    pulling: p.pulling,
    charging: p.charging,
    lowEnergy: p.energy < CONFIG.energy.lowThreshold,
    shield: p.shield,
    dashCd: p.dashCd,
    dashMax: CONFIG.abilities.dash.cooldown,
    repulseCd: p.repulseCd,
    repulseMax: CONFIG.abilities.repulse.cooldown,
    ult: p.ult,
    ultActive: p.ultActive,
    power: { overdrive: p.power.overdrive, magnet: p.power.magnet, phase: p.power.phase },
    cosmic:
      cz && cfgCosmic
        ? {
            kind: cz.kind,
            stage: cz.stage,
            secondsLeft: (cz.stage === "warning" ? cz.warning : cz.duration) - cz.t,
          }
        : null,
    escalating: world.arenaRadius < world.arenaBase,
    arena: world.arena,
    mode: world.mode,
    endless: world.endless
      ? {
          respawnIn: world.endless.respawnIn,
          best: world.endless.best,
          deaths: world.endless.deaths,
          kills: world.endless.kills,
          lastKiller: killerName(world, world.endless.lastKillerId),
        }
      : null,
    leaderboard: leaderboard(world, 10),
  }
}

/** Deep copy of a world (structuredClone is fine). The copy shares nothing with the original. */
export function cloneWorld(world: World): World {
  return structuredClone(world)
}

// ---------------------------------------------------------------------------------------------
// PRIVATE — implementation helpers go below this line. Not exported, not part of the contract.
// ---------------------------------------------------------------------------------------------

const TWO_PI = Math.PI * 2

// Scratch output of wellGravity (avoids allocating a vector per call; single-threaded, read
// immediately after each call).
let gravX = 0
let gravY = 0

// Bodies that fired a repulse this step (reused across steps; cleared at the start of step 3).
const repulsers: Body[] = []

const POWERUP_KINDS: readonly PowerUpKind[] = ["overdrive", "magnet", "phase", "bulk"]

/** Sum of well accelerations at (x, y), every gm scaled by gs; result in gravX/gravY. */
function wellGravity(wells: readonly Well[], x: number, y: number, gs: number): void {
  let gx = 0
  let gy = 0
  const soft2 = CONFIG.well.soft * CONFIG.well.soft
  for (let i = 0; i < wells.length; i++) {
    const w = wells[i]
    if (!(w.gm > 0)) continue
    const dx = w.x - x
    const dy = w.y - y
    const d2 = dx * dx + dy * dy
    if (d2 === 0) continue
    const d = Math.sqrt(d2)
    const a = (gs * w.gm) / (d2 + soft2)
    gx += (dx / d) * a
    gy += (dy / d) * a
  }
  gravX = gx
  gravY = gy
}

/** Add Singularity charge (clamped to 1); emits ultReady when it reaches 1 from below. */
function addUlt(b: Body, amount: number, events: GameEvent[]): void {
  if (!(amount > 0)) return
  const before = b.ult
  b.ult = Math.min(1, before + amount)
  if (before < 1 && b.ult >= 1) events.push({ type: "ultReady", bodyId: b.id })
}

/** True if (x, y) is within well.radius + debris.wellClearance of any well. */
function nearWell(wells: readonly Well[], x: number, y: number): boolean {
  for (const w of wells) {
    const lim = w.radius + CONFIG.debris.wellClearance
    const dx = x - w.x
    const dy = y - w.y
    if (dx * dx + dy * dy < lim * lim) return true
  }
  return false
}

/**
 * Spawn one crystal, or one dust/rock piece, with createWorld's placement rules: the ring/disc
 * choice (one draw, only when the arena has a debris ring) is made once per piece; the point is
 * redrawn until it clears every well.
 */
function spawnDebris(world: World, crystal: boolean): void {
  let kind: DebrisKind
  let mass: number
  if (crystal) {
    kind = "crystal"
    mass = CONFIG.crystal.mass
  } else if (rand(world) < CONFIG.debris.rockShare) {
    kind = "rock"
    mass = randRange(world, CONFIG.debris.rockMass[0], CONFIG.debris.rockMass[1])
  } else {
    kind = "dust"
    mass = randRange(world, CONFIG.debris.dustMass[0], CONFIG.debris.dustMass[1])
  }
  const f = world.debrisField
  let inRing = false
  if (!crystal && f.ringShare > 0) inRing = rand(world) < f.ringShare
  let x = 0
  let y = 0
  for (;;) {
    const r = inRing
      ? Math.sqrt(f.ringInner * f.ringInner + rand(world) * (f.ringOuter * f.ringOuter - f.ringInner * f.ringInner))
      : world.arenaRadius * Math.sqrt(rand(world))
    const a = randRange(world, 0, TWO_PI)
    x = Math.cos(a) * r
    y = Math.sin(a) * r
    if (!nearWell(world.wells, x, y)) break
  }
  world.debris.push({
    id: world.nextDebrisId++,
    kind,
    x,
    y,
    vx: 0,
    vy: 0,
    px: x,
    py: y,
    mass,
    radius: radiusForMass(mass),
  })
}

/** A meteor-shower rock: uniform in the event's circle, small random velocity. */
function spawnMeteor(world: World, ev: CosmicEvent): void {
  const mass = randRange(world, CONFIG.debris.rockMass[0], CONFIG.debris.rockMass[1])
  const r = ev.r * Math.sqrt(rand(world))
  const a = randRange(world, 0, TWO_PI)
  const x = ev.x + Math.cos(a) * r
  const y = ev.y + Math.sin(a) * r
  const vx = randRange(world, -80, 80)
  const vy = randRange(world, -80, 80)
  world.debris.push({
    id: world.nextDebrisId++,
    kind: "rock",
    x,
    y,
    vx,
    vy,
    px: x,
    py: y,
    mass,
    radius: radiusForMass(mass),
  })
}

/** A comet entering at the wall, aimed at a point within 600 u of the centre. */
function spawnComet(world: World): void {
  const ang = randRange(world, 0, TWO_PI)
  const x = Math.cos(ang) * (world.arenaRadius - 40)
  const y = Math.sin(ang) * (world.arenaRadius - 40)
  const tr = 600 * Math.sqrt(rand(world))
  const ta = randRange(world, 0, TWO_PI)
  const tx = Math.cos(ta) * tr
  const ty = Math.sin(ta) * tr
  const speed = randRange(world, CONFIG.comets.speed[0], CONFIG.comets.speed[1])
  const mass = randRange(world, CONFIG.comets.mass[0], CONFIG.comets.mass[1])
  let dx = tx - x
  let dy = ty - y
  const d = Math.hypot(dx, dy)
  if (d > 0) {
    dx /= d
    dy /= d
  } else {
    dx = 1
    dy = 0
  }
  world.debris.push({
    id: world.nextDebrisId++,
    kind: "comet",
    x,
    y,
    vx: dx * speed,
    vy: dy * speed,
    px: x,
    py: y,
    mass,
    radius: radiusForMass(mass),
  })
}

/** A power-up away from living bodies and lethal wells (200 tries, then the last draw). */
function spawnPickup(world: World): void {
  const kind = POWERUP_KINDS[Math.min(POWERUP_KINDS.length - 1, Math.floor(rand(world) * POWERUP_KINDS.length))]
  const reach = world.arenaRadius - 200
  let x = 0
  let y = 0
  for (let tries = 0; tries < 200; tries++) {
    const r = reach * Math.sqrt(rand(world))
    const a = randRange(world, 0, TWO_PI)
    x = Math.cos(a) * r
    y = Math.sin(a) * r
    let ok = true
    for (const b of world.bodies) {
      if (b.alive && Math.hypot(x - b.x, y - b.y) < 250) {
        ok = false
        break
      }
    }
    if (ok) {
      for (const w of world.wells) {
        if (w.lethal && Math.hypot(x - w.x, y - w.y) < Math.max(w.chargeRadius, w.radius) + 60) {
          ok = false
          break
        }
      }
    }
    if (ok) break
  }
  world.pickups.push({ id: world.nextDebrisId++, kind, x, y, ttl: CONFIG.powerups.ttl })
}

/** Heaviest living body from index `from` on (tie: lower index), or null. */
function heaviestAlive(bodies: readonly Body[], from: number): Body | null {
  let best: Body | null = null
  for (let i = from; i < bodies.length; i++) {
    const b = bodies[i]
    if (b.alive && (!best || b.mass > best.mass)) best = b
  }
  return best
}

function buildStandings(bodies: readonly Body[]): Standing[] {
  const order = bodies.map((_, i) => i)
  order.sort((i, j) => {
    const a = bodies[i]
    const b = bodies[j]
    if (a.alive !== b.alive) return a.alive ? -1 : 1
    if (a.mass !== b.mass) return b.mass - a.mass
    return i - j
  })
  return order.map((i) => {
    const b = bodies[i]
    return { id: b.id, name: b.name, color: b.color, mass: b.mass, alive: b.alive }
  })
}

/** A body stops being alive: end its Singularity (with an event) and clear its power-ups. */
function leavePlay(b: Body, events: GameEvent[]): void {
  if (b.ultActive > 0) events.push({ type: "ultEnd", bodyId: b.id })
  b.ultActive = 0
  b.power.overdrive = 0
  b.power.magnet = 0
  b.power.phase = 0
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Name of the body with this id, or "" (for the respawn screen). */
function killerName(world: World, id: string): string {
  if (id === "") return ""
  for (const b of world.bodies) if (b.id === id) return b.name
  return ""
}

/** Skill of a new bot by the drift rule for the player's mass m: one draw (easy, normal, hard cumulative). */
function drawSkill(world: World, m: number): Difficulty {
  const E = CONFIG.endless
  const pHard = clamp((m - E.hardFrom) / E.hardSpan, 0, E.hardMax)
  const pEasy = clamp(E.easyBase - m / E.easySpan, E.easyMin, E.easyBase)
  const u = rand(world)
  if (u < pEasy) return "easy"
  if (u < 1 - pHard) return "normal"
  return "hard"
}

/**
 * Spawn point for a respawning player or joining bot: 30 candidates uniform by area in the
 * annulus [500, arenaRadius - 300], away from lethal and solid wells; the one farthest from any
 * dangerous (heavier) living body wins. Always draws all 30 so the rng stream is predictable.
 */
function safeSpawn(world: World, out: Vec): void {
  const lo = 500
  const hi = Math.max(lo + 1, world.arenaRadius - 300)
  const heavy = CONFIG.body.startMass * CONFIG.absorb.ratio
  let bestD = -1
  let bx = 0
  let by = 0
  let haveBest = false
  let lx = 0
  let ly = 0
  for (let c = 0; c < 30; c++) {
    const r = Math.sqrt(lo * lo + rand(world) * (hi * hi - lo * lo))
    const a = randRange(world, 0, TWO_PI)
    const x = Math.cos(a) * r
    const y = Math.sin(a) * r
    lx = x
    ly = y
    let ok = true
    for (const w of world.wells) {
      const d = Math.hypot(x - w.x, y - w.y)
      if (w.lethal ? d < Math.max(w.chargeRadius, w.radius) + 200 : d < w.radius + 150) {
        ok = false
        break
      }
    }
    if (!ok) continue
    let nearest = Infinity
    for (const b of world.bodies) {
      if (b.alive && b.mass > heavy) {
        const d = Math.hypot(x - b.x, y - b.y)
        if (d < nearest) nearest = d
      }
    }
    // First valid candidate is the default; later ones must beat it strictly.
    if (!haveBest || nearest > bestD) {
      haveBest = true
      bestD = nearest
      bx = x
      by = y
    }
  }
  out.x = haveBest ? bx : lx
  out.y = haveBest ? by : ly
}

const spawnPt: Vec = { x: 0, y: 0 }

function freshBody(world: World, id: string, name: string, color: string, skill: Difficulty, mass: number): Body {
  safeSpawn(world, spawnPt)
  const x = spawnPt.x
  const y = spawnPt.y
  return {
    id,
    kind: "bot",
    name,
    color,
    skill,
    x,
    y,
    vx: 0,
    vy: 0,
    px: x,
    py: y,
    mass,
    radius: radiusForMass(mass),
    energy: CONFIG.energy.max,
    alive: true,
    shield: CONFIG.endless.respawnShield,
    warpCooldown: 0,
    idleTime: 0,
    thrusting: false,
    pulling: false,
    charging: false,
    dashCd: 0,
    repulseCd: 0,
    ult: 0,
    ultActive: 0,
    power: { overdrive: 0, magnet: 0, phase: 0 },
    slingCd: 0,
    lastHitBy: "",
    lastHitAt: -1e9,
    stats: {
      debrisEaten: 0,
      crystals: 0,
      rivalsAbsorbed: 0,
      peakMass: mass,
      dashes: 0,
      repulses: 0,
      ults: 0,
      slingshots: 0,
      assists: 0,
      pickups: 0,
      comets: 0,
      topSpeed: 0,
    },
  }
}

/** Step 12E. `nEv` = number of events emitted before this phase (bookkeeping reads only those). */
function stepEndless(world: World, nEv: number): void {
  const E = CONFIG.endless
  const st = world.endless as NonNullable<World["endless"]>
  const bodies = world.bodies
  const events = world.events
  const dt = CONFIG.dt
  const player = bodies[0]

  // a. mass decay
  for (const b of bodies) {
    if (b.alive && b.mass > E.decayAbove) {
      b.mass -= (b.mass - E.decayAbove) * E.decayRate * dt
      b.radius = radiusForMass(b.mass)
    }
  }

  // b. bookkeeping
  for (let k = 0; k < nEv; k++) {
    const ev = events[k]
    if (ev.type === "absorb" && ev.eaterId === "player") {
      st.kills += 1
    } else if (ev.type === "death") {
      if (ev.bodyId === "player") {
        st.deaths += 1
        st.respawnIn = E.respawnDelay
        st.lastKillerId = ev.cause.by === "body" ? ev.cause.killerId : ""
      } else {
        for (let i = 1; i < bodies.length; i++) {
          if (bodies[i].id === ev.bodyId) {
            st.joinIn[i] = randRange(world, E.joinDelay[0], E.joinDelay[1])
            break
          }
        }
      }
    }
  }
  if (player.alive && player.mass > st.best) st.best = player.mass

  // c. player respawn
  if (!player.alive && st.respawnIn > 0) {
    st.respawnIn -= dt
    if (st.respawnIn <= 0) {
      st.respawnIn = 0
      safeSpawn(world, spawnPt)
      player.mass = CONFIG.body.startMass
      player.radius = radiusForMass(player.mass)
      player.x = spawnPt.x
      player.y = spawnPt.y
      player.px = player.x
      player.py = player.y
      player.vx = 0
      player.vy = 0
      player.energy = CONFIG.energy.max
      player.alive = true
      player.shield = E.respawnShield
      player.warpCooldown = 0
      player.idleTime = 0
      player.thrusting = false
      player.pulling = false
      player.charging = false
      player.dashCd = 0
      player.repulseCd = 0
      player.ult = 0
      player.ultActive = 0
      player.power.overdrive = 0
      player.power.magnet = 0
      player.power.phase = 0
      player.slingCd = 0
      player.lastHitBy = ""
      player.lastHitAt = -1e9
      events.push({ type: "respawn", bodyId: player.id, x: player.x, y: player.y })
    }
  }

  // d. joins
  for (let i = 0; i < bodies.length; i++) {
    if (!(st.joinIn[i] > 0)) continue
    st.joinIn[i] -= dt
    if (st.joinIn[i] > 0) continue
    st.joinIn[i] = 0
    const no = st.nextBotNo++
    const offset = Math.floor(rand(world) * E.names.length)
    let name = E.names[offset % E.names.length]
    for (let k = 0; k < E.names.length; k++) {
      const cand = E.names[(offset + k) % E.names.length]
      let used = false
      for (const b of bodies) {
        if (b.alive && b.name === cand) {
          used = true
          break
        }
      }
      if (!used) {
        name = cand
        break
      }
    }
    const pm = player.alive ? player.mass : CONFIG.body.startMass
    const skill = drawSkill(world, pm)
    const mass =
      CONFIG.body.startMass * randRange(world, 0.8, 1.0) * (1 + E.joinGrowth * clamp(pm / 100, 0, 1))
    const nb = freshBody(world, `bot-${no}`, name, CONFIG.bots.colors[no % CONFIG.bots.colors.length], skill, mass)
    bodies[i] = nb
    events.push({ type: "join", bodyId: nb.id, name: nb.name, skill: nb.skill, x: nb.x, y: nb.y })
  }

  // e. rotation
  st.rotateIn -= dt
  if (st.rotateIn <= 0) {
    st.rotateIn = randRange(world, E.rotateEvery[0], E.rotateEvery[1])
    let heaviest = -1
    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i].alive && (heaviest < 0 || bodies[i].mass > bodies[heaviest].mass)) heaviest = i
    }
    const cands: number[] = []
    for (let i = 1; i < bodies.length; i++) {
      const b = bodies[i]
      if (!b.alive || i === heaviest) continue
      if (Math.hypot(b.x - player.x, b.y - player.y) >= 900) cands.push(i)
    }
    if (cands.length > 0) {
      const i = cands[Math.min(cands.length - 1, Math.floor(rand(world) * cands.length))]
      const b = bodies[i]
      b.alive = false
      leavePlay(b, events)
      st.joinIn[i] = E.rotateJoinDelay
      events.push({ type: "leave", bodyId: b.id, x: b.x, y: b.y })
    }
  }
}
