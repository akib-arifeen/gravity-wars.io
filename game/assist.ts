// Gravity assist ("Oberth burn"): flyby tracking, grading and the earned speed surge.
//
// Pure and deterministic: reads bodies/wells and the fixed step's time, never RNG, DOM or audio.
// The engine calls tickAssist() every step, noteDash() when a dash actually fires, and
// trackPass() after the well step; it applies the reward itself (energy, ult, velocity) so the
// side effects stay in one place.
//
// The model is deliberately simplified game physics: a well is a point mass with softened
// Newtonian gravity, periapsis is sampled once per fixed step, and the "Oberth effect" is a
// graded reward for burning there — not a simulated frame-dependent engine burn, and not
// relativistic.

import { CONFIG } from "./config"
import type { AssistState, AssistTier, Body, Well } from "./types"

/** A graded burn waiting for the engine to apply it. */
export interface BurnReady {
  well: Well
  tier: AssistTier
  /** 0..1: periapsis depth and speed relative to the well, plus the moving-well bonus. */
  quality: number
  /** True when the well itself was moving (its velocity did real work). */
  moving: boolean
  /** Speed relative to the well at periapsis (u/s). */
  speed: number
  energy: number
  ult: number
  /** Prograde impulse along the body's velocity relative to the well (u/s). */
  impulse: number
  surge: number
  speedMul: number
  thrustMul: number
}

/** What the renderer and HUD need to telegraph a pass. */
export interface AssistView {
  wellId: string
  stage: "none" | "in" | "out"
  /** True while a dash would be the burn (periapsis within the difficulty's window). */
  window: boolean
  /** Seconds until (negative: since) the predicted/actual periapsis, null when unknown. */
  periIn: number | null
}

export function emptyAssist(): AssistState {
  return {
    pass: {
      wellId: "",
      stage: "none",
      t: 0,
      dist: 0,
      minDist: 0,
      prevVr: 0,
      dashAt: -1,
      periAt: -1,
      periDist: 0,
      periRelSpeed: 0,
      paid: false,
    },
    cd: 0,
    lastWellId: "",
    lastWellAt: -1e9,
    surge: 0,
    surgeFull: 0,
    surgeMul: 1,
    thrustMul: 1,
  }
}

/** Drop the current pass but keep cooldowns, the same-well lock and any live surge. */
export function resetPass(a: AssistState): void {
  const p = a.pass
  p.wellId = ""
  p.stage = "none"
  p.t = 0
  p.dist = 0
  p.minDist = 0
  p.prevVr = 0
  p.dashAt = -1
  p.periAt = -1
  p.periDist = 0
  p.periRelSpeed = 0
  p.paid = false
}

/** Reset everything (respawn, death, a body leaving play). */
export function resetAssist(a: AssistState): void {
  resetPass(a)
  a.cd = 0
  a.lastWellId = ""
  a.lastWellAt = -1e9
  a.surge = 0
  a.surgeFull = 0
  a.surgeMul = 1
  a.thrustMul = 1
}

/** Cooldown and surge decay. Called once per step for every alive body. */
export function tickAssist(a: AssistState, dt: number): void {
  a.cd = a.cd > dt ? a.cd - dt : 0
  if (a.surge > 0) {
    a.surge = a.surge > dt ? a.surge - dt : 0
    if (a.surge === 0) {
      a.surgeFull = 0
      a.surgeMul = 1
      a.thrustMul = 1
    }
  }
}

/** Radius of a well's assist band: where a pass is tracked and telegraphed (u). */
export function assistBand(w: Well): number {
  return w.radius * CONFIG.assist.band + CONFIG.assist.margin
}

/** Dash window either side of periapsis for this body's difficulty (s). */
export function assistWindow(body: Body): number {
  return CONFIG.assist.window * CONFIG.difficulty[body.skill].assistWindowMul
}

/** Speed ceiling multiplier currently granted by the surge (1 = none). */
export function surgeSpeedMul(body: Body): number {
  return body.assist.surge > 0 ? body.assist.surgeMul : 1
}

/** Thrust multiplier currently granted by the surge (1 = none). */
export function surgeThrustMul(body: Body): number {
  return body.assist.surge > 0 ? body.assist.thrustMul : 1
}

/** True while the same well that last paid this body is still locked (repeat prevention). */
function wellLocked(a: AssistState, wellId: string, now: number): boolean {
  return a.lastWellId === wellId && now - a.lastWellAt < CONFIG.assist.sameWell
}

/**
 * Record that a dash fired this step. Returns a burn when periapsis is already known and the
 * dash is inside its window; a dash during the inbound half is graded when periapsis is crossed.
 * A dash anywhere else does nothing.
 */
export function noteDash(body: Body, wells: readonly Well[], now: number): BurnReady | null {
  const a = body.assist
  const p = a.pass
  if (p.wellId === "" || p.paid) return null
  const w = findWell(wells, p.wellId)
  if (!w) return null
  // The last dash is the one closest to periapsis, so it is the one graded.
  p.dashAt = now
  if (p.stage !== "out") return null
  return grade(body, w, now)
}

/**
 * Advance (or open) this body's pass and return a burn if periapsis was just crossed with a dash
 * already inside the window. Called once per step after the well/death step, for living bodies.
 */
export function trackPass(body: Body, wells: readonly Well[], now: number): BurnReady | null {
  const a = body.assist
  const p = a.pass
  const A = CONFIG.assist

  if (p.wellId !== "") {
    const w = findWell(wells, p.wellId)
    if (!w) {
      resetPass(a)
      return null
    }
    const dx = body.x - w.x
    const dy = body.y - w.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    // Leaving the band ends the pass; a new one can only open from outside, so an orbit that never
    // exits cannot be re-graded, and a pass pays at most once.
    if (dist > assistBand(w)) {
      resetPass(a)
      return null
    }
    p.t += CONFIG.dt
    if (p.t > A.maxPass) {
      // Hovering inside the band is not a flyby.
      resetPass(a)
      return null
    }
    const vrx = body.vx - w.vx
    const vry = body.vy - w.vy
    const vr = dist > 0 ? (dx * vrx + dy * vry) / dist : 0
    p.dist = dist
    if (dist < p.minDist) p.minDist = dist

    let burn: BurnReady | null = null
    // Periapsis: the closing radial speed flips to receding. This can only happen after an
    // inbound entry (prevVr < 0), never for a body hovering or drifting across the band.
    if (p.stage === "in" && p.prevVr < 0 && vr >= 0) {
      p.stage = "out"
      p.periAt = now
      p.periDist = p.minDist
      p.periRelSpeed = Math.sqrt(vrx * vrx + vry * vry)
      if (p.dashAt >= 0) burn = grade(body, w, now)
    }
    p.prevVr = vr
    return burn
  }

  // Open a pass around the nearest well whose band contains the body, if the body is really
  // closing on it. A body drifting or holding station inside a band never opens a pass.
  let best: Well | null = null
  let bestDist = Infinity
  for (let i = 0; i < wells.length; i++) {
    const w = wells[i]
    if (w.gm <= 0) continue
    const dx = body.x - w.x
    const dy = body.y - w.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist > assistBand(w) || dist >= bestDist) continue
    const vr = dist > 0 ? (dx * (body.vx - w.vx) + dy * (body.vy - w.vy)) / dist : 0
    if (vr > -A.minInbound) continue
    if (a.cd > 0 || wellLocked(a, w.id, now)) continue
    best = w
    bestDist = dist
  }
  if (!best) return null
  const dx = body.x - best.x
  const dy = body.y - best.y
  p.wellId = best.id
  p.stage = "in"
  p.t = 0
  p.dist = bestDist
  p.minDist = bestDist
  p.prevVr = bestDist > 0 ? (dx * (body.vx - best.vx) + dy * (body.vy - best.vy)) / bestDist : 0
  p.dashAt = -1
  p.periAt = -1
  p.periDist = 0
  p.periRelSpeed = 0
  p.paid = false
  return null
}

/**
 * Grade the pass at periapsis and return the reward, or null when it does not qualify: no dash
 * in the window, periapsis too far out, too slow relative to the well, already paid, on cooldown,
 * or the same well inside its repeat lock.
 */
function grade(body: Body, w: Well, now: number): BurnReady | null {
  const a = body.assist
  const p = a.pass
  const A = CONFIG.assist
  if (p.paid || p.periAt < 0 || p.dashAt < 0) return null
  if (a.cd > 0 || wellLocked(a, w.id, now)) return null
  if (Math.abs(p.dashAt - p.periAt) > assistWindow(body)) return null
  // A real flyby: periapsis has to be a close pass, not a distant drift through the band.
  if (p.periDist > w.radius * A.periBand) return null
  if (p.periRelSpeed < A.minRelSpeed) return null

  const span = w.radius * (A.periBand - 1)
  const depth = clamp01(span > 0 ? 1 - (p.periDist - w.radius) / span : 1)
  const speedQ = clamp01((p.periRelSpeed - A.minRelSpeed) / A.speedRange)
  const moving = w.orbit !== null
  const quality = clamp01(0.5 * depth + 0.5 * speedQ + (moving ? A.movingBonus : 0))
  const t = tierFor(quality)
  return {
    well: w,
    tier: t.tier,
    quality,
    moving,
    speed: p.periRelSpeed,
    energy: t.energy,
    ult: t.ult,
    impulse: t.impulse,
    surge: t.surge,
    speedMul: t.speedMul,
    thrustMul: t.thrustMul,
  }
}

/** Mark a paid pass: one reward per pass, then the payout cooldown and same-well lock. */
export function markPaid(body: Body, wellId: string, now: number): void {
  const a = body.assist
  a.pass.paid = true
  a.cd = CONFIG.assist.cooldown
  a.lastWellId = wellId
  a.lastWellAt = now
}

/**
 * Extend the surge. Surges do not stack: a weaker burn never downgrades a live stronger surge,
 * and the multipliers are hard-capped.
 */
export function grantSurge(body: Body, burn: BurnReady): void {
  const a = body.assist
  const A = CONFIG.assist
  if (burn.surge > a.surge) a.surge = burn.surge
  if (a.surge > a.surgeFull) a.surgeFull = a.surge
  a.surgeMul = Math.min(A.maxSpeedMul, Math.max(a.surgeMul, burn.speedMul))
  a.thrustMul = Math.min(A.maxThrustMul, Math.max(a.thrustMul, burn.thrustMul))
}

/**
 * HUD/renderer view of the pass. For an inbound pass the periapsis time is predicted from the
 * current closing geometry (time to the closest point of a straight-line pass); the graded
 * window still uses the actual periapsis, so the prediction only drives feedback.
 */
export function assistView(world: { time: number; wells: readonly Well[] }, body: Body): AssistView {
  const a = body.assist
  const p = a.pass
  if (p.wellId === "" || p.paid) return { wellId: "", stage: "none", window: false, periIn: null }
  const w = findWell(world.wells, p.wellId)
  if (!w) return { wellId: "", stage: "none", window: false, periIn: null }
  const win = assistWindow(body)
  let periIn: number | null = null
  if (p.stage === "out" && p.periAt >= 0) {
    periIn = p.periAt - world.time
  } else if (p.stage === "in") {
    const rx = body.x - w.x
    const ry = body.y - w.y
    const vx = body.vx - w.vx
    const vy = body.vy - w.vy
    const rv = Math.sqrt(vx * vx + vy * vy)
    if (rv > 1) {
      const d = Math.sqrt(rx * rx + ry * ry)
      // Impact parameter of the current relative motion: where the closest approach will be.
      const b = Math.abs(rx * vy - ry * vx) / rv
      const along = Math.sqrt(Math.max(0, d * d - b * b))
      periIn = along / rv
    }
  }
  return {
    wellId: p.wellId,
    stage: p.stage,
    window: periIn !== null && Math.abs(periIn) <= win,
    periIn,
  }
}

type TierDef = (typeof CONFIG.assist.tiers)[number]

function tierFor(quality: number): TierDef {
  const tiers = CONFIG.assist.tiers
  let out: TierDef = tiers[0]
  for (let i = 1; i < tiers.length; i++) if (quality >= tiers[i].at) out = tiers[i]
  return out
}

function findWell(wells: readonly Well[], id: string): Well | null {
  for (let i = 0; i < wells.length; i++) if (wells[i].id === id) return wells[i]
  return null
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
