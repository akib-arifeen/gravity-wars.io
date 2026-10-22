// Gravity Wars simulation. Pure TypeScript: no DOM, no timers, no Math.random (all randomness
// comes from world.rngState via rng.ts), so a seed plus a sequence of intents replays exactly.
//
// CONTRACT — the exported signatures and the behaviour documented here are fixed. Implement the
// bodies below; put helpers in the PRIVATE section at the bottom.

import { CONFIG } from "./config"
import { rand, randRange, seedState } from "./rng"
import type {
  Body,
  DeathCause,
  DebrisKind,
  Difficulty,
  HudSnapshot,
  Intent,
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

/** Pull ability radius for a body. */
export function pullRadius(body: Body): number {
  return CONFIG.pull.baseRadius + body.radius * CONFIG.pull.radiusPerR
}

/** True if `a` is heavy enough to absorb `b` (mass ratio only; ignores distance and shields). */
export function canAbsorb(a: Body, b: Body): boolean {
  return a.mass >= CONFIG.absorb.ratio * b.mass
}

export interface CreateWorldOptions {
  seed: number
  difficulty: Difficulty
  /** Defaults to CONFIG.difficulty[difficulty].bots. */
  botCount?: number
}

/**
 * Build a new round, in phase "countdown" with countdown = CONFIG.round.countdown,
 * timeLeft = CONFIG.round.duration, tick = 0, time = 0, events = [], result = null.
 *
 * Layout (all random draws from the seeded rng, so equal options give deep-equal worlds):
 * - wells: one black hole within CONFIG.well.holeOffsetMax of the centre; CONFIG.well.starCount
 *   stars at a distance in CONFIG.well.starOrbit from the centre, at least 90° apart in angle.
 *   Star: gm starGm, radius starRadius, chargeRadius starChargeRadius. Hole: gm holeGm,
 *   radius holeRadius, chargeRadius 0. Ids "star-1", "star-2", ..., "hole-1".
 * - wormholes: one linked pair, ids "wh-a" and "wh-b", radius CONFIG.wormhole.radius, each at a
 *   distance in CONFIG.wormhole.orbit from the centre, >= wellClearance from every well centre,
 *   >= minSeparation from each other (retry draws until satisfied; give up after 200 tries and
 *   use the last draw).
 * - bodies: player first (id "player", kind "player", CONFIG.player name/colour, mass
 *   startMass), then bots "bot-1".."bot-N" (names/colours from CONFIG.bots in order, mass
 *   startMass * a draw in the difficulty's startMassScale). All on a ring of radius
 *   CONFIG.spawn.ringRadius, evenly spaced, with one random rotation for the whole ring.
 *   Velocity 0, px/py = x/y, energy = CONFIG.energy.max, shield = CONFIG.body.spawnShield,
 *   warpCooldown 0, idleTime 0, flags false, stats zero with peakMass = mass, alive true.
 * - debris: filled to CONFIG.debris.target dust/rock pieces and CONFIG.crystal.target crystals,
 *   positions uniform over the arena disc (radius sqrt-distributed) but never within
 *   well.radius + CONFIG.debris.wellClearance of a well. Dust mass in dustMass, rock in
 *   rockMass (rock with probability rockShare), crystal mass CONFIG.crystal.mass. Velocity 0.
 *   Ids from 1, increasing; nextDebrisId is the next unused id.
 *
 * Throws RangeError if botCount is not an integer in [0, CONFIG.bots.names.length].
 */
export function createWorld(opts: CreateWorldOptions): World {
  const profile = CONFIG.difficulty[opts.difficulty]
  const botCount = opts.botCount ?? profile.bots
  if (!Number.isInteger(botCount) || botCount < 0 || botCount > CONFIG.bots.names.length) {
    throw new RangeError(`botCount must be an integer in [0, ${CONFIG.bots.names.length}], got ${botCount}`)
  }

  const world: World = {
    seed: opts.seed,
    difficulty: opts.difficulty,
    rngState: seedState(opts.seed),
    tick: 0,
    phase: "countdown",
    countdown: CONFIG.round.countdown,
    time: 0,
    timeLeft: CONFIG.round.duration,
    arenaRadius: CONFIG.arena.radius,
    bodies: [],
    debris: [],
    wells: [],
    wormholes: [],
    events: [],
    result: null,
    nextDebrisId: 1,
    spawnCredit: { debris: 0, crystal: 0 },
  }

  // Stars: distance in starOrbit, each at least 90 degrees from the others in angle.
  const starAngles: number[] = []
  for (let i = 0; i < CONFIG.well.starCount; i++) {
    let angle = 0
    for (let tries = 0; tries < 200; tries++) {
      angle = randRange(world, 0, TWO_PI)
      let ok = true
      for (let k = 0; k < starAngles.length; k++) {
        if (angularGap(angle, starAngles[k]) < Math.PI / 2) {
          ok = false
          break
        }
      }
      if (ok) break
    }
    starAngles.push(angle)
    const dist = randRange(world, CONFIG.well.starOrbit[0], CONFIG.well.starOrbit[1])
    world.wells.push({
      id: `star-${i + 1}`,
      kind: "star",
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      gm: CONFIG.well.starGm,
      radius: CONFIG.well.starRadius,
      chargeRadius: CONFIG.well.starChargeRadius,
    })
  }

  // Black hole: uniform over a disc of radius holeOffsetMax around the centre.
  {
    const dist = CONFIG.well.holeOffsetMax * Math.sqrt(rand(world))
    const angle = randRange(world, 0, TWO_PI)
    world.wells.push({
      id: "hole-1",
      kind: "blackhole",
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      gm: CONFIG.well.holeGm,
      radius: CONFIG.well.holeRadius,
      chargeRadius: 0,
    })
  }

  // Wormhole pair.
  const whPos: Vec[] = []
  for (let n = 0; n < 2; n++) {
    let x = 0
    let y = 0
    for (let tries = 0; tries < 200; tries++) {
      const dist = randRange(world, CONFIG.wormhole.orbit[0], CONFIG.wormhole.orbit[1])
      const angle = randRange(world, 0, TWO_PI)
      x = Math.cos(angle) * dist
      y = Math.sin(angle) * dist
      let ok = true
      for (const w of world.wells) {
        if (Math.hypot(x - w.x, y - w.y) < CONFIG.wormhole.wellClearance) {
          ok = false
          break
        }
      }
      if (ok && n === 1 && Math.hypot(x - whPos[0].x, y - whPos[0].y) < CONFIG.wormhole.minSeparation) ok = false
      if (ok) break
    }
    whPos.push({ x, y })
  }
  world.wormholes.push(
    { id: "wh-a", x: whPos[0].x, y: whPos[0].y, radius: CONFIG.wormhole.radius, linkId: "wh-b" },
    { id: "wh-b", x: whPos[1].x, y: whPos[1].y, radius: CONFIG.wormhole.radius, linkId: "wh-a" },
  )

  // Bodies on a ring.
  const total = botCount + 1
  const ringRot = randRange(world, 0, TWO_PI)
  for (let i = 0; i < total; i++) {
    const angle = ringRot + (TWO_PI * i) / total
    const isPlayer = i === 0
    const mass = isPlayer
      ? CONFIG.body.startMass
      : CONFIG.body.startMass * randRange(world, profile.startMassScale[0], profile.startMassScale[1])
    const x = Math.cos(angle) * CONFIG.spawn.ringRadius
    const y = Math.sin(angle) * CONFIG.spawn.ringRadius
    world.bodies.push({
      id: isPlayer ? "player" : `bot-${i}`,
      kind: isPlayer ? "player" : "bot",
      name: isPlayer ? CONFIG.player.name : CONFIG.bots.names[i - 1],
      color: isPlayer ? CONFIG.player.color : CONFIG.bots.colors[i - 1],
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
      stats: { debrisEaten: 0, crystals: 0, rivalsAbsorbed: 0, peakMass: mass },
    })
  }

  // Debris.
  for (let i = 0; i < CONFIG.debris.target; i++) spawnDebris(world, false)
  for (let i = 0; i < CONFIG.crystal.target; i++) spawnDebris(world, true)

  return world
}

/**
 * Advance the world by exactly one fixed step of dt = CONFIG.dt seconds. Mutates `world`.
 * `intents` maps body id -> Intent; a missing id means NO_INTENT. Intents for dead bodies are
 * ignored. NaN/Infinity components count as 0.
 *
 * Order of operations (tests and the reference implementation depend on it):
 *  0. world.events = []. If phase is "over": return (nothing else changes, tick included).
 *  1. tick += 1.
 *     Countdown: if phase is "countdown": countdown -= dt; set px/py = x/y for bodies and
 *     debris; if countdown <= 0 then countdown = 0, phase = "playing", emit {type:"phase"}.
 *     Return (no physics during the countdown, so the step that ends it does not move anything).
 *  2. time += dt; timeLeft = max(0, timeLeft - dt).
 *  3. Each ALIVE body, in array order:
 *     a. px,py = x,y. shield = max(0, shield - dt). warpCooldown = max(0, warpCooldown - dt).
 *     b. Clamp the intent vector a to length <= 1. thrusting = |a| > CONFIG.body.thrustDeadzone
 *        && energy > 0. pulling = intent.pull && energy > 0. idleTime = 0 if thrusting or
 *        pulling, else idleTime + dt.
 *     c. Energy: e -= thrustCost*|a|*dt if thrusting; e -= pullCost*dt if pulling;
 *        e += regen*dt; charging = false; for each star with radius < d < chargeRadius
 *        (d = centre distance): charging = true, e += starChargeRate * (1 - (d - radius) /
 *        (chargeRadius - radius)) * dt. Clamp e to [0, max]. If the old energy was
 *        >= lowThreshold and the new one < lowThreshold, emit {type:"lowEnergy"}.
 *     d. Accelerations: g = sum over wells of gm / (d² + soft²) toward the well (unit vector
 *        (well - body) / d; skip a well when d == 0). Wall: let r = distance from the arena
 *        centre (0,0) and lim = arenaRadius - radius; if r > lim, add
 *        -(r - lim) * wallStiffness along the outward radial unit vector.
 *        Idle safety: if kind === "player", S = CONFIG.difficulty[world.difficulty].idleSafety
 *        is not null and idleTime >= S.after, then for each well with d > 0 and surface distance
 *        s = d - well.radius < S.range, add S.push * gm / (d² + soft²) * (1 - max(0, s) / S.range)
 *        along the unit vector AWAY from the well. Like gravity, it counts in vNo below.
 *        Thrust: aT = thrustAccel(mass) * a when thrusting, else 0.
 *     e. Velocity: vNo = v + (g + wall) * dt. vNew = vNo + aT * dt. If |vNew| > maxSpeed(mass)
 *        and |vNew| > |vNo|, rescale vNew to length max(maxSpeed(mass), |vNo|) (thrust cannot
 *        push past maxSpeed; gravity can). Then v = vNew * exp(-drag * dt). Then clamp |v| to
 *        hardSpeedCap. Position: x += vx * dt, y += vy * dt.
 *  4. Pull: for each alive body P with pulling, R = pullRadius(P):
 *     - each debris with centre distance d < R: debris v += debrisAccel * (1 - d/R) * dt
 *       toward P (skip when d == 0);
 *     - each other alive body B with canAbsorb(P, B) and d < R: B.v += bodyAccel * (1 - d/R)
 *       * dt toward P.
 *  5. Debris, in array order: px,py = x,y; v += gravity from wells (same formula) * dt;
 *     v *= exp(-CONFIG.debris.drag * dt); x += v * dt. Debris whose centre ends inside any
 *     well's radius is removed (no event). Debris beyond the arena radius is placed back on
 *     the boundary and its radial velocity is reflected (v -= 2 (v·n) n).
 *  6. Wormholes: each alive body with warpCooldown == 0 whose centre is within a wormhole's
 *     radius moves to the linked end: position = link + u * (link.radius + body.radius + 4)
 *     where u is the body's unit velocity (or (1,0) if speed < 1e-6); velocity is kept;
 *     px,py = new position; warpCooldown = CONFIG.wormhole.cooldown; emit {type:"warp"}.
 *     A body warps at most once per step.
 *  7. Wells: each alive body with centre distance < well.radius + body.radius * killOverlap to
 *     any well dies (shield does not protect): alive = false; emit
 *     {type:"death", cause: {by:"star"} or {by:"blackhole"}}.
 *  8. Eating, bodies in array order, debris in array order: an alive body eats each debris
 *     whose centre distance < body.radius. mass += debris.mass; crystals also add
 *     CONFIG.crystal.energy energy (clamped) and count in stats.crystals, others count in
 *     stats.debrisEaten. Remove the debris; emit {type:"eat"} with the debris position.
 *     A piece is eaten by at most one body (the first in array order).
 *  9. Bodies vs bodies: each pair (i < j) of alive bodies with d < ri + rj. Let big be the
 *     heavier (tie: lower index) and small the other.
 *     - If canAbsorb(big, small) and big.shield == 0 and small.shield == 0: if
 *       d < big.radius - small.radius * CONFIG.absorb.overlap, big absorbs small:
 *       big.mass += small.mass * massGain; big.energy = min(max, big.energy + small.energy *
 *       energyGain); big.stats.rivalsAbsorbed += 1; small.alive = false; emit
 *       {type:"absorb", x/y = small's position} then {type:"death", cause {by:"body",
 *       killerId: big.id}}. Otherwise (not deep enough yet) do nothing: they may overlap.
 *     - Else (neither can absorb the other, or a shield is up): push them apart along the
 *       normal n = (j - i)/d (use (1,0) if d == 0) so they just touch, moving each by the
 *       overlap times the OTHER's share of total mass; then if they approach (vrel·n < 0,
 *       vrel = vj - vi), apply impulse J = -(1 + restitution) * (vrel·n) / (1/mi + 1/mj):
 *       vi -= J/mi n, vj += J/mj n. Emit {type:"bounce", impulse: J} when
 *       J / min(mi, mj) >= bounceEventMin.
 *     Pairs are resolved in order (i ascending, then j ascending) against the current state,
 *     skipping any pair where either body is no longer alive.
 * 10. For every body: radius = radiusForMass(mass); stats.peakMass = max(peakMass, mass).
 * 11. Spawning: spawnCredit.debris += debris.spawnRate * dt; while credit >= 1 and the
 *     dust+rock count < debris.target: spawn one (same rules as createWorld) and credit -= 1;
 *     then credit = min(credit, 1). Same for crystals with crystal.spawnRate / crystal.target.
 * 12. Round end, first match wins:
 *     a. player not alive -> "playerDied", playerWon false, playerCause = the player's death
 *        cause, winnerId = heaviest living bot or null.
 *     b. any living body with mass >= criticalMass -> "criticalMass", winnerId = the heaviest
 *        such body (tie: lower index).
 *     c. the player is the only living body and there was at least one bot -> "lastStanding",
 *        winner the player.
 *     d. timeLeft <= 0 -> "timeUp", winnerId = heaviest living body (tie: lower index).
 *     On a match: phase = "over", world.result = result (standings per RoundResult docs,
 *     durationS = time), playerWon = (winnerId === "player"), emit {type:"phase"} and
 *     {type:"roundEnd"}.
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

  const isMap = intents instanceof Map
  const bc = CONFIG.body
  const ec = CONFIG.energy
  const dragFactor = Math.exp(-bc.drag * dt)

  // 3.
  for (let bi = 0; bi < bodies.length; bi++) {
    const b = bodies[bi]
    if (!b.alive) continue
    b.px = b.x
    b.py = b.y
    b.shield = Math.max(0, b.shield - dt)
    b.warpCooldown = Math.max(0, b.warpCooldown - dt)

    const intent = isMap
      ? (intents as ReadonlyMap<string, Intent>).get(b.id)
      : (intents as Readonly<Record<string, Intent>>)[b.id]
    let ax = 0
    let ay = 0
    let wantPull = false
    if (intent) {
      ax = Number.isFinite(intent.ax) ? intent.ax : 0
      ay = Number.isFinite(intent.ay) ? intent.ay : 0
      wantPull = !!intent.pull
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

    // c. energy
    const oldE = b.energy
    let e = oldE
    if (thrusting) e -= ec.thrustCost * alen * dt
    if (pulling) e -= ec.pullCost * dt
    e += ec.regen * dt
    let charging = false
    for (let wi = 0; wi < wells.length; wi++) {
      const w = wells[wi]
      if (w.kind !== "star") continue
      const d = Math.hypot(b.x - w.x, b.y - w.y)
      if (d > w.radius && d < w.chargeRadius) {
        charging = true
        e += CONFIG.well.starChargeRate * (1 - (d - w.radius) / (w.chargeRadius - w.radius)) * dt
      }
    }
    b.charging = charging
    e = Math.min(ec.max, Math.max(0, e))
    b.energy = e
    if (oldE >= ec.lowThreshold && e < ec.lowThreshold) events.push({ type: "lowEnergy", bodyId: b.id })

    // d. accelerations
    wellGravity(wells, b.x, b.y)
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
          const k = ((S.push * w.gm) / (d * d + soft2)) * (1 - Math.max(0, sd) / S.range)
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

    // e. velocity
    const vNoX = b.vx + accX * dt
    const vNoY = b.vy + accY * dt
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
    vx *= dragFactor
    vy *= dragFactor
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
  }

  // 4. pull
  for (let pi = 0; pi < bodies.length; pi++) {
    const p = bodies[pi]
    if (!p.alive || !p.pulling) continue
    const R = pullRadius(p)
    for (let i = 0; i < debris.length; i++) {
      const d = debris[i]
      const dx = p.x - d.x
      const dy = p.y - d.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < R && dist > 0) {
        const a = CONFIG.pull.debrisAccel * (1 - dist / R) * dt
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
        const a = CONFIG.pull.bodyAccel * (1 - dist / R) * dt
        o.vx += (dx / dist) * a
        o.vy += (dy / dist) * a
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
      wellGravity(wells, d.x, d.y)
      d.vx += gravX * dt
      d.vy += gravY * dt
      d.vx *= dragD
      d.vy *= dragD
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

  // 7. wells kill
  for (let bi = 0; bi < bodies.length; bi++) {
    const b = bodies[bi]
    if (!b.alive) continue
    for (let wi = 0; wi < wells.length; wi++) {
      const w = wells[wi]
      if (Math.hypot(b.x - w.x, b.y - w.y) < w.radius + b.radius * CONFIG.well.killOverlap) {
        b.alive = false
        events.push({
          type: "death",
          bodyId: b.id,
          cause: w.kind === "star" ? { by: "star" } : { by: "blackhole" },
          x: b.x,
          y: b.y,
        })
        break
      }
    }
  }

  // 8. eating
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
        } else {
          b.stats.debrisEaten += 1
        }
        events.push({ type: "eat", bodyId: b.id, kind: d.kind, mass: d.mass, x: d.x, y: d.y })
      } else {
        debris[w++] = d
      }
    }
    debris.length = w
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
          events.push({ type: "absorb", eaterId: big.id, victimId: small.id, mass: gained, x: small.x, y: small.y })
          events.push({
            type: "death",
            bodyId: small.id,
            cause: { by: "body", killerId: big.id },
            x: small.x,
            y: small.y,
          })
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

  // 10.
  for (const b of bodies) {
    b.radius = radiusForMass(b.mass)
    if (b.mass > b.stats.peakMass) b.stats.peakMass = b.mass
  }

  // 11. spawning
  {
    let count = 0
    for (let i = 0; i < debris.length; i++) if (debris[i].kind !== "crystal") count++
    let crystals = debris.length - count
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
      if (b.mass >= CONFIG.round.criticalMass && (!crit || b.mass > crit.mass)) crit = b
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

/** HUD view of the player. countdown is Math.ceil(world.countdown); lowEnergy uses lowThreshold. */
export function hudSnapshot(world: World): HudSnapshot {
  const p = world.bodies[0]
  let alive = 0
  for (const b of world.bodies) if (b.alive) alive++
  return {
    phase: world.phase,
    countdown: Math.ceil(world.countdown),
    timeLeft: world.timeLeft,
    mass: p.mass,
    energy: p.energy,
    energyMax: CONFIG.energy.max,
    criticalMass: CONFIG.round.criticalMass,
    rank: rankOf(world, "player"),
    alive,
    total: world.bodies.length,
    pulling: p.pulling,
    charging: p.charging,
    lowEnergy: p.energy < CONFIG.energy.lowThreshold,
    shield: p.shield,
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

function angularGap(a: number, b: number): number {
  const d = Math.abs(a - b) % TWO_PI
  return d > Math.PI ? TWO_PI - d : d
}

/** Sum of well accelerations at (x, y); result in gravX/gravY. */
function wellGravity(wells: readonly Well[], x: number, y: number): void {
  let gx = 0
  let gy = 0
  const soft2 = CONFIG.well.soft * CONFIG.well.soft
  for (let i = 0; i < wells.length; i++) {
    const w = wells[i]
    const dx = w.x - x
    const dy = w.y - y
    const d2 = dx * dx + dy * dy
    if (d2 === 0) continue
    const d = Math.sqrt(d2)
    const a = w.gm / (d2 + soft2)
    gx += (dx / d) * a
    gy += (dy / d) * a
  }
  gravX = gx
  gravY = gy
}

/** Spawn one crystal, or one dust/rock piece, with createWorld's placement rules. */
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
  let x = 0
  let y = 0
  for (;;) {
    const r = world.arenaRadius * Math.sqrt(rand(world))
    const a = randRange(world, 0, TWO_PI)
    x = Math.cos(a) * r
    y = Math.sin(a) * r
    let ok = true
    for (const w of world.wells) {
      const lim = w.radius + CONFIG.debris.wellClearance
      const dx = x - w.x
      const dy = y - w.y
      if (dx * dx + dy * dy < lim * lim) {
        ok = false
        break
      }
    }
    if (ok) break
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
