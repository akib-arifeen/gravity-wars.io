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
      dashRadial: 0,
      dashIn: false,
      dashPeriIn: 0,
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
  p.dashRadial = 0
  p.dashIn = false
  p.dashPeriIn = 0
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
  // The latest dash is the one graded: a later one replaces an earlier one.
  p.dashAt = now
  p.dashIn = p.stage === "in"
  if (p.dashIn) {
    // Judge an inbound dash by when it was told periapsis would be, not by where its own impulse
    // later pushes the periapsis: the HUD advertises exactly this prediction, so a dash on the
    // prompt always qualifies and one outside it never does.
    const pred = predictPeri(body, w)
    p.dashPeriIn = pred ? pred.periIn : Infinity
  }
  if (p.stage !== "out") return null
  return grade(body, w, now)
}

/**
 * True when the dash just recorded is aimed at the burn: inside the window the HUD advertised, on
 * a pass that has not paid yet. The engine uses it to keep the dash's own impulse out of the legacy
 * fast-pass perk, which would otherwise pay on the dash frame — before periapsis is graded.
 */
export function dashAimedAtBurn(body: Body): boolean {
  const p = body.assist.pass
  return p.wellId !== "" && !p.paid && p.dashIn && Math.abs(p.dashPeriIn) <= CONFIG.assist.window
}

/**
 * Record the radial part of the dash impulse that just fired (u/s). The engine calls this before
 * the dash payout, so trackPass can subtract it on the same step and refuse a periapsis the dash
 * itself created. No pass, no record.
 */
export function noteDashImpulse(body: Body, wells: readonly Well[], impulseX: number, impulseY: number): void {
  const p = body.assist.pass
  if (p.wellId === "") return
  const w = findWell(wells, p.wellId)
  if (!w) return
  const dx = body.x - w.x
  const dy = body.y - w.y
  const d = Math.sqrt(dx * dx + dy * dy)
  p.dashRadial = d > 1e-6 ? (impulseX * dx + impulseY * dy) / d : 0
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
    // Leaving the band drops the pass. A pass pays at most once, and a later one only opens from a
    // fresh closing entry that clears the payout cooldown and same-well lock gates below.
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
    const vrNow = dist > 0 ? (dx * vrx + dy * vry) / dist : 0
    // A dash this step must not manufacture the periapsis it is graded on: judge the flip on the
    // radial velocity the dash-free trajectory would have had, i.e. without the impulse's radial
    // part. Gravity can still turn the approach (that is a real flyby), and a near-tangential dash
    // at periapsis barely changes the radial term, so those burns still count.
    const vr = p.dashAt === now ? vrNow - p.dashRadial : vrNow
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
    p.prevVr = vrNow
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
  p.dashRadial = 0
  p.dashIn = false
  p.dashPeriIn = 0
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
  // Inbound: the dash is timed against the periapsis it predicted (what the HUD showed).
  // Outbound: the periapsis is already known, so the dash is timed against the real one.
  const timing = p.dashIn ? p.dashPeriIn : p.dashAt - p.periAt
  if (!(Math.abs(timing) <= assistWindow(body))) return null
  // A real flyby: periapsis has to be a close pass, not a distant drift through the band.
  if (!deepEnough(w, p.periDist, p.periRelSpeed)) return null

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
 * HUD/renderer view of the pass. `window` is true only when a dash this frame could actually pay:
 * the pass is eligible (not paid, not cooling down, not locked to this well), the periapsis is
 * inside the deep band with enough relative speed, and the timing is inside the dash window.
 *
 * For an inbound pass the periapsis is predicted from the current closing geometry (the closest
 * point of a straight-line pass) and that same prediction is what an inbound dash is timed
 * against, so "the prompt is up" and "a dash now pays" mean the same thing. Outbound, the real
 * periapsis is known and is used for both. A pass that cannot pay is never advertised.
 */
export function assistView(world: { time: number; wells: readonly Well[] }, body: Body): AssistView {
  const a = body.assist
  const p = a.pass
  const none: AssistView = { wellId: "", stage: "none", window: false, periIn: null }
  if (p.wellId === "" || p.paid) return none
  const w = findWell(world.wells, p.wellId)
  if (!w) return none
  // A cooling-down or same-well-locked pass would not pay, so it must not prompt.
  if (a.cd > 0 || wellLocked(a, w.id, world.time)) return { ...none, wellId: p.wellId }
  const win = assistWindow(body)
  if (p.stage === "out" && p.periAt >= 0) {
    const periIn = p.periAt - world.time
    const real = deepEnough(w, p.periDist, p.periRelSpeed)
    return { wellId: p.wellId, stage: "out", window: real && Math.abs(periIn) <= win, periIn }
  }
  if (p.stage === "in") {
    const pred = predictPeri(body, w)
    if (!pred) return { wellId: p.wellId, stage: "in", window: false, periIn: null }
    // A predicted periapsis inside the well's own surface is a collision, not a flyby, and can
    // never pay. Gravity can only bend the real path closer than this straight-line estimate, so
    // anything admitted here is genuinely a deep, fast pass.
    const survivable = pred.impact > w.radius + body.radius
    const real = survivable && deepEnough(w, pred.impact, pred.rel)
    return { wellId: p.wellId, stage: "in", window: real && pred.periIn <= win, periIn: pred.periIn }
  }
  return { wellId: p.wellId, stage: p.stage, window: false, periIn: null }
}

/**
 * Whether the burn prompt and the dash control's glow may be shown: a payable pass window, the
 * dash off cooldown, enough energy for it, and the ability not campaign-locked.
 */
export function burnPromptVisible(window: boolean, dashCd: number, energy: number, locked: boolean): boolean {
  return window && !locked && dashCd <= 0 && energy >= CONFIG.abilities.dash.cost
}

/** A periapsis close and fast enough, relative to the well, to be a real flyby. */
function deepEnough(w: Well, periDist: number, periRelSpeed: number): boolean {
  const A = CONFIG.assist
  return periDist <= w.radius * A.periBand && periRelSpeed >= A.minRelSpeed
}

interface PeriPrediction {
  /** Seconds to the closest point of the current relative motion. */
  periIn: number
  /** Impact parameter: the closest approach of a straight-line pass (u). */
  impact: number
  /** Current speed relative to the well (u/s). */
  rel: number
}

/**
 * Straight-line prediction of the nearest approach for the body's current relative motion. Gravity
 * bends a real path closer than this, so `impact` is an upper bound on the real periapsis distance.
 */
function predictPeri(body: Body, w: Well): PeriPrediction | null {
  const rx = body.x - w.x
  const ry = body.y - w.y
  const vx = body.vx - w.vx
  const vy = body.vy - w.vy
  const rel = Math.sqrt(vx * vx + vy * vy)
  if (rel <= 1) return null
  const dist = Math.sqrt(rx * rx + ry * ry)
  const impact = Math.abs(rx * vy - ry * vx) / rel
  return { periIn: Math.sqrt(Math.max(0, dist * dist - impact * impact)) / rel, impact, rel }
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
