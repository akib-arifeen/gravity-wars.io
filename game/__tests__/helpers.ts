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
  Body,
  Debris,
  DebrisKind,
  Difficulty,
  GameEvent,
  Intent,
  Vec,
  Well,
  WellKind,
  World,
} from "../types"

export const DT = CONFIG.dt
export const TWO_PI = Math.PI * 2

/** Radius at which controlledWorld parks the bodies (inside the arena, far from everything). */
export const PARK_RADIUS = 1200

export interface ControlledOptions {
  seed?: number
  difficulty?: Difficulty
  botCount?: number
}

/**
 * A quiet, fully scripted world: phase "playing", no countdown, no wells, wormholes or debris,
 * every shield 0, every body parked on a 1200 u ring at rest (px/py = x/y).
 *
 * Spawning is switched off by giving the spawn credit a hugely negative balance (the contract
 * only refills debris while credit >= 1), so nothing appears behind a test's back. Tests that
 * exercise spawning overwrite world.spawnCredit themselves.
 */
export function controlledWorld(opts: ControlledOptions = {}): World {
  const createOpts: CreateWorldOptions = { seed: opts.seed ?? 1, difficulty: opts.difficulty ?? "normal" }
  if (opts.botCount !== undefined) createOpts.botCount = opts.botCount
  const world = createWorld(createOpts)
  world.phase = "playing"
  world.countdown = 0
  world.wells = []
  world.wormholes = []
  world.debris = []
  world.events = []
  world.spawnCredit = { debris: -1e9, crystal: -1e9 }
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
/** A well with the CONFIG parameters for its kind (not added to any world). */
export function makeWell(kind: WellKind, x: number, y: number): Well {
  wellSerial += 1
  if (kind === "star") {
    return {
      id: `test-star-${wellSerial}`,
      kind,
      x,
      y,
      gm: CONFIG.well.starGm,
      radius: CONFIG.well.starRadius,
      chargeRadius: CONFIG.well.starChargeRadius,
    }
  }
  return {
    id: `test-hole-${wellSerial}`,
    kind,
    x,
    y,
    gm: CONFIG.well.holeGm,
    radius: CONFIG.well.holeRadius,
    chargeRadius: 0,
  }
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
