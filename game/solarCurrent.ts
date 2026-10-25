// The Vast's solar current: a co-rotating magnetospheric band around the giant central star.
//
// This is deliberately game physics, not frame dragging or magnetohydrodynamics. Inside a
// half-width band at a fraction of the arena radius, a living body feels a tangential
// acceleration and reduced drag; both fade smoothly to zero at the band's edges. Riding with the
// flow charges a per-life "sail" that raises the body's speed ceiling, and the charge bleeds away
// outside the band. Debris is never touched: its path and drag stay exactly what they were.
//
// The visual variation (band phase, streamers, granulation) comes from a local PRNG stream seeded
// from world.seed. It never reads or advances world.rngState, so layouts and replays are unchanged.

import { CONFIG } from "./config"
import { nextRandom, seedState } from "./rng"
import type { Body, World } from "./types"

/** Reusable output for sampleSolarCurrent: no allocation in the fixed-step hot loop. */
export interface SolarCurrentSample {
  /** 1 at the band centre, 0 outside it. */
  falloff: number
  /** Tangential acceleration (u/s²), zero outside the band. */
  ax: number
  ay: number
  /** Linear-drag multiplier: 1 outside, bandDragMul at the centre. */
  dragMul: number
}

/** True when this world carries the solar current (only The Vast). */
export function hasSolarCurrent(world: World): boolean {
  return world.arena === "vast"
}

/** Band centre radius in world units (arenaBase / 3 = 1600 in The Vast), or 0 elsewhere. */
export function solarCurrentRadius(world: World): number {
  return hasSolarCurrent(world) ? world.arenaBase * CONFIG.vast.solarCurrent.bandRadiusFrac : 0
}

/**
 * Smooth radial falloff: 1 at the band centre, 0 at or beyond halfWidth, with zero slope at both
 * ends so crossing the edge never produces a force or drag step. 0 outside The Vast.
 */
export function solarCurrentFalloff(world: World, x: number, y: number): number {
  if (!hasSolarCurrent(world)) return 0
  const S = CONFIG.vast.solarCurrent
  const d = Math.hypot(x, y)
  const off = Math.abs(d - solarCurrentRadius(world))
  if (off >= S.halfWidth) return 0
  const t = 1 - off / S.halfWidth
  return t * t * (3 - 2 * t)
}

/**
 * Sample the current at a point into `out`: tangential acceleration for a living body and the
 * drag multiplier. The tangent runs counter-clockwise, matching the visuals.
 */
export function sampleSolarCurrent(world: World, x: number, y: number, out: SolarCurrentSample): SolarCurrentSample {
  out.falloff = 0
  out.ax = 0
  out.ay = 0
  out.dragMul = 1
  if (!hasSolarCurrent(world)) return out
  const f = solarCurrentFalloff(world, x, y)
  if (f <= 0) return out
  const S = CONFIG.vast.solarCurrent
  const d = Math.hypot(x, y)
  out.falloff = f
  out.dragMul = 1 + (S.bandDragMul - 1) * f
  if (d > 1e-6) {
    const k = S.strength * f
    out.ax = (-y / d) * k
    out.ay = (x / d) * k
  }
  return out
}

/**
 * Advance one living body's sail charge by dt from its actual motion.
 *
 * Inside the band the charge grows at up to 1/buildSeconds while the velocity has a component
 * along the current's tangent; a body at rest, or moving only across the band, builds nothing.
 * Outside the band it decays at 1/decaySeconds. A body that is inside but not aligned neither
 * builds nor decays: the band is a place, not a timer.
 */
export function updateSolarSail(world: World, body: Body, dt: number): void {
  if (!hasSolarCurrent(world)) {
    body.sail = 0
    return
  }
  const S = CONFIG.vast.solarCurrent
  const f = solarCurrentFalloff(world, body.x, body.y)
  if (f <= 0) {
    body.sail = Math.max(0, body.sail - dt / S.decaySeconds)
    return
  }
  const d = Math.hypot(body.x, body.y)
  const sp = Math.hypot(body.vx, body.vy)
  if (d <= 1e-6 || sp <= 1e-6) return
  const align = (body.vx * -body.y + body.vy * body.x) / (sp * d)
  if (align <= 0) return
  body.sail = Math.min(1, body.sail + (align * f * dt) / S.buildSeconds)
}

/** Speed-ceiling multiplier from the sail: 1 with no charge, 1 + thrustMul at a full sail. */
export function sailSpeedMul(sail: number): number {
  const s = sail < 0 ? 0 : sail > 1 ? 1 : sail
  return 1 + CONFIG.vast.solarCurrent.thrustMul * s
}

/** Seed for the local visual stream. Depends only on world.seed. */
export function solarCurrentSeed(world: World): number {
  return seedState(Math.imul(Math.floor(Math.abs(world.seed)) | 0, 0x9e3779b1) ^ 0x5bd1e995)
}

export interface SolarCurrentVisual {
  /** Initial rotation of the chevrons (radians). */
  chevronPhase: number
  /** Start angles (radians) for the streamers/prominences on the star's limb. */
  streamerAngles: number[]
  /** Seed for the star-surface granulation. */
  granulationSeed: number
}

/**
 * A stable, per-seed set of visual parameters. Built from a local mulberry32 stream; it neither
 * reads nor advances world.rngState, so arena layout and replays are untouched.
 */
export function solarCurrentVisual(world: World): SolarCurrentVisual {
  let state = solarCurrentSeed(world)
  const next = (): number => {
    const [v, s] = nextRandom(state)
    state = s
    return v
  }
  const S = CONFIG.vast.solarCurrent
  const chevronPhase = next() * Math.PI * 2
  const streamerAngles: number[] = []
  for (let i = 0; i < S.streamers; i++) streamerAngles.push(next() * Math.PI * 2)
  const granulationSeed = Math.floor(next() * 0xffffffff) >>> 0
  return { chevronPhase, streamerAngles, granulationSeed }
}
