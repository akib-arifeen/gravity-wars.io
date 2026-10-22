// Shared fixtures for the game tests. Everything here is built from the public contract
// (types.ts, config.ts, rng.ts and the exported engine/bots signatures); tunables are always
// read from CONFIG by name so a rebalance cannot break the suite.

import { expect } from "vitest"
import { botIntent } from "../bots"
import type { BotBrain } from "../bots"
import { CONFIG } from "../config"
import { createWorld, radiusForMass, step } from "../engine"
import type { CreateWorldOptions } from "../engine"
import type {
  ArenaId,
  Body,
  Debris,
  DebrisKind,
  Difficulty,
  GameEvent,
  Intent,
  Pickup,
  PowerUpKind,
  Vec,
  Well,
  WellKind,
  World,
  Zone,
  ZoneKind,
} from "../types"

export const DT = CONFIG.dt
export const TWO_PI = Math.PI * 2

/** Radius at which controlledWorld parks the bodies (inside the arena, far from everything). */
export const PARK_RADIUS = 1200

export interface ControlledOptions {
  seed?: number
  difficulty?: Difficulty
  botCount?: number
  arena?: ArenaId
}

export type SpawnCredit = World["spawnCredit"]

/** A spawn-credit object with every stream switched off (hugely negative) unless overridden. */
export function credit(over: Partial<SpawnCredit> = {}): SpawnCredit {
  return { debris: -1e9, crystal: -1e9, comet: -1e9, pickup: -1e9, ...over }
}

/**
 * A quiet, fully scripted world: phase "playing", no countdown, no wells, wormholes or debris,
 * every shield 0, every body parked on a 1200 u ring at rest (px/py = x/y).
 *
 * Spawning (debris, crystals, comets, pickups) is switched off by giving every spawn credit a
 * hugely negative balance (the contract only spawns while credit >= 1) and cosmic events by
 * nextCosmicIn = 1e9; pickups, zones and any cosmic event are cleared, so nothing appears behind
 * a test's back. Tests that exercise spawning overwrite world.spawnCredit / nextCosmicIn.
 */
export function controlledWorld(opts: ControlledOptions = {}): World {
  const createOpts: CreateWorldOptions = {
    seed: opts.seed ?? 1,
    difficulty: opts.difficulty ?? "normal",
    cosmic: false,
  }
  if (opts.arena !== undefined) createOpts.arena = opts.arena
  if (opts.botCount !== undefined) createOpts.botCount = opts.botCount
  const world = createWorld(createOpts)
  world.phase = "playing"
  world.countdown = 0
  world.wells = []
  world.wormholes = []
  world.debris = []
  world.events = []
  world.spawnCredit = credit()
  world.pickups = []
  world.zones = []
  world.cosmic = null
  world.nextCosmicIn = 1e9
  const n = world.bodies.length
  world.bodies.forEach((b, i) => {
    const a = 0.3 + (TWO_PI * i) / n
    b.x = Math.cos(a) * PARK_RADIUS
    b.y = Math.sin(a) * PARK_RADIUS
    b.px = b.x
    b.py = b.y
    b.vx = 0
    b.vy = 0
    b.shield = 0
    b.warpCooldown = 0
    b.thrusting = false
    b.pulling = false
    b.charging = false
  })
  return world
}

export function placeBody(world: World, i: number, x: number, y: number, vx = 0, vy = 0): Body {
  const b = world.bodies[i]
  b.x = x
  b.y = y
  b.px = x
  b.py = y
  b.vx = vx
  b.vy = vy
  return b
}

/** Set a body's mass and keep radius consistent with the contract (radius = radiusForMass). */
export function setMass(b: Body, mass: number): Body {
  b.mass = mass
  b.radius = radiusForMass(mass)
  b.stats.peakMass = Math.max(b.stats.peakMass, mass)
  return b
}

const DEFAULT_DEBRIS_MASS: Record<DebrisKind, number> = {
  dust: (CONFIG.debris.dustMass[0] + CONFIG.debris.dustMass[1]) / 2,
  rock: (CONFIG.debris.rockMass[0] + CONFIG.debris.rockMass[1]) / 2,
  crystal: CONFIG.crystal.mass,
  comet: (CONFIG.comets.mass[0] + CONFIG.comets.mass[1]) / 2,
}

/** Append a piece of debris at rest to the world and return it. */
export function makeDebris(world: World, kind: DebrisKind, x: number, y: number, mass?: number): Debris {
  const m = mass ?? DEFAULT_DEBRIS_MASS[kind]
  const d: Debris = {
    id: world.nextDebrisId++,
    kind,
    x,
    y,
    vx: 0,
    vy: 0,
    px: x,
    py: y,
    mass: m,
    radius: radiusForMass(m),
  }
  world.debris.push(d)
  return d
}

let wellSerial = 0
/** A fixed well with the CONFIG parameters for its kind (not added to any world). */
export function makeWell(kind: WellKind, x: number, y: number): Well {
  wellSerial += 1
  const base = { id: `test-${kind}-${wellSerial}`, kind, x, y, vx: 0, vy: 0, orbit: null, beam: null }
  if (kind === "star") {
    return {
      ...base,
      gm: CONFIG.well.starGm,
      radius: CONFIG.well.starRadius,
      chargeRadius: CONFIG.well.starChargeRadius,
      chargeRate: CONFIG.well.starChargeRate,
      lethal: true,
    }
  }
  if (kind === "blackhole") {
    return { ...base, gm: CONFIG.well.holeGm, radius: CONFIG.well.holeRadius, chargeRadius: 0, chargeRate: 0, lethal: true }
  }
  const k = CONFIG.wellKinds[kind]
  const well: Well = { ...base, gm: k.gm, radius: k.radius, chargeRadius: k.chargeRadius, chargeRate: k.chargeRate, lethal: k.lethal }
  if (kind === "pulsar") {
    well.beam = { w: 0, phase: 0, halfWidth: CONFIG.pulsarBeam.halfWidth, length: CONFIG.pulsarBeam.length, accel: CONFIG.pulsarBeam.accel }
  }
  return well
}

export function addWell(world: World, kind: WellKind, x: number, y: number): Well {
  const w = makeWell(kind, x, y)
  world.wells.push(w)
  return w
}

/** Total linear momentum of the living bodies. */
export function momentum(world: World): Vec {
  let x = 0
  let y = 0
  for (const b of world.bodies) {
    if (!b.alive) continue
    x += b.mass * b.vx
    y += b.mass * b.vy
  }
  return { x, y }
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function snapshot(world: World): string {
  return JSON.stringify(world)
}

export function intent(ax: number, ay: number, pull = false): Intent {
  return { ax, ay, pull }
}

/** Step n times with the same intents. */
export function stepN(world: World, n: number, intents: Readonly<Record<string, Intent>> = {}): void {
  for (let i = 0; i < n; i++) step(world, intents)
}

/** Events of one type from the most recent step. */
export function eventsOf<T extends GameEvent["type"]>(world: World, type: T): Extract<GameEvent, { type: T }>[] {
  return world.events.filter((e) => e.type === type) as Extract<GameEvent, { type: T }>[]
}

export function expectClose(actual: number, expected: number, tol: number, what = "value"): void {
  const diff = Math.abs(actual - expected)
  expect(diff, `${what}: expected ${expected}, got ${actual} (|diff| ${diff} > ${tol})`).toBeLessThanOrEqual(tol)
}

/** Smallest absolute angle between two directions, in [0, PI]. */
export function angularGap(a: number, b: number): number {
  const g = Math.abs(a - b) % TWO_PI
  return Math.min(g, TWO_PI - g)
}

/**
 * Drive one brain against a (static) world until it has made `count` re-decisions, and return
 * the intent produced at each of them. A re-decision is detected through brain.thinkIn: the
 * contract says it counts down by dt per call and is topped up by the reaction time on a decision.
 */
export function decisionIntents(world: World, brain: BotBrain, count = 3): Intent[] {
  const out: Intent[] = []
  const maxCalls = Math.ceil(((count + 2) * CONFIG.difficulty[brain.difficulty].reaction) / DT) + 10
  for (let i = 0; i < maxCalls && out.length < count; i++) {
    const before = brain.thinkIn
    const result = botIntent(world, brain)
    if (brain.thinkIn > before - DT + 1e-12) out.push(result)
  }
  return out
}

export function makePickup(world: World, kind: PowerUpKind, x: number, y: number, ttl: number = CONFIG.powerups.ttl): Pickup {
  const p: Pickup = { id: world.nextDebrisId++, kind, x, y, ttl }
  world.pickups.push(p)
  return p
}

let zoneSerial = 0
export function addZone(world: World, kind: ZoneKind, x: number, y: number, r: number, strength: number, vx = 0, vy = 0): Zone {
  zoneSerial += 1
  const z: Zone = { id: `test-zone-${zoneSerial}`, kind, x, y, r, vx, vy, strength, eventId: null }
  world.zones.push(z)
  return z
}

/** Put a world into a state where its player has all abilities ready and plenty of energy. */
export function armed(world: World): void {
  for (const b of world.bodies) {
    b.energy = CONFIG.energy.max
    b.dashCd = 0
    b.repulseCd = 0
  }
}

export interface EndlessOptions {
  seed?: number
  difficulty?: Difficulty
  botCount?: number
  arena?: ArenaId
}

/**
 * A quiet Endless world: phase "playing", no wells/wormholes/zones/debris/pickups, all spawning and
 * cosmic events off, every body parked on a 1200 u ring at rest with no shield, the roster rotation
 * disabled (rotateIn = 1e9) and no joins pending. Tests re-enable what they exercise.
 */
export function endlessWorld(opts: EndlessOptions = {}): World {
  const createOpts: CreateWorldOptions = {
    seed: opts.seed ?? 1,
    difficulty: opts.difficulty ?? "normal",
    cosmic: false,
    mode: "endless",
  }
  if (opts.botCount !== undefined) createOpts.botCount = opts.botCount
  if (opts.arena !== undefined) createOpts.arena = opts.arena
  const world = createWorld(createOpts)
  world.phase = "playing"
  world.countdown = 0
  world.wells = []
  world.wormholes = []
  world.debris = []
  world.zones = []
  world.pickups = []
  world.events = []
  world.spawnCredit = credit()
  world.nextCosmicIn = 1e9
  const n = world.bodies.length
  world.bodies.forEach((b, i) => {
    const a = 0.3 + (TWO_PI * i) / n
    b.x = Math.cos(a) * PARK_RADIUS
    b.y = Math.sin(a) * PARK_RADIUS
    b.px = b.x
    b.py = b.y
    b.vx = 0
    b.vy = 0
    b.shield = 0
  })
  if (world.endless) world.endless.rotateIn = 1e9
  return world
}
