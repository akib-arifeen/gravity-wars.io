// Bot brains. A bot sees the same World the renderer sees and answers with an Intent, exactly
// like a human controller would (see the multiplayer seam note on Intent in types.ts).
//
// CONTRACT — exported signatures and documented behaviour are fixed. Put helpers and any extra
// brain fields' logic in the PRIVATE section at the bottom.

import { CONFIG } from "./config"
import { canAbsorb, maxSpeed, pullRadius } from "./engine"
import { rand, randRange, seedState } from "./rng"
import type { Body, Difficulty, Intent, World } from "./types"

export interface BotBrain {
  /** The body this brain drives. */
  bodyId: string
  difficulty: Difficulty
  /** Private PRNG state (rng.ts); never touch world.rngState. */
  rngState: number
  /** Seconds until the next re-decision (counts down by CONFIG.dt per botIntent call). */
  thinkIn: number
  /** The intent decided at the last re-decision; returned unchanged between decisions. */
  current: Intent
  /** Free-form private state for the implementation (goal ids, wander angle, ...). */
  memory: Record<string, number | string | boolean>
}

/** New brain with its own seeded PRNG. thinkIn starts at a random fraction of the reaction time. */
export function createBotBrain(bodyId: string, difficulty: Difficulty, seed: number): BotBrain {
  // Mix the body id into the seed so bots created from one world seed do not share a stream.
  let h = 0
  for (let i = 0; i < bodyId.length; i++) h = (Math.imul(h, 31) + bodyId.charCodeAt(i)) | 0
  const brain: BotBrain = {
    bodyId,
    difficulty,
    rngState: seedState((seed ^ h) + 0x1234567),
    thinkIn: 0,
    current: { ax: 0, ay: 0, pull: false },
    memory: {},
  }
  brain.thinkIn = rand(brain) * CONFIG.difficulty[difficulty].reaction
  return brain
}

/**
 * Decide the bot's intent for this fixed step. Call once per step for each living bot.
 *
 * - Never mutates `world` (it may mutate `brain`).
 * - Returns a finite intent with length <= CONFIG.difficulty[d].thrustScale, and pull === false
 *   whenever the difficulty's usesPull is false.
 * - Returns NO_INTENT-equivalent ({ax:0, ay:0, pull:false}) if the body is dead, missing, or
 *   world.phase !== "playing".
 * - Re-decides only when thinkIn <= 0 (then thinkIn += reaction time), otherwise returns
 *   brain.current, so reaction time is real.
 *
 * Behaviour, blended as steering weights (strongest wins when they conflict):
 * - Survive: steer away from any well when inside a danger distance that grows with caution,
 *   with the body's mass (bigger bodies have weaker thrust), and with the inward speed. Never
 *   aim through a well to reach a target.
 * - Flee: rivals the bot cannot beat (canAbsorb(rival, bot)) within a threat range.
 * - Hunt: rivals the bot can absorb (canAbsorb(bot, rival)) when aggression allows, aiming at
 *   an intercept point scaled by aimLead. The player is a valid target like any rival. No bot
 *   hunts (or pulls at prey) before world.time >= CONFIG.difficulty[d].huntGrace: the opening
 *   seconds are for grazing, so a new player is not eaten while still finding the controls.
 * - Graze: otherwise seek the best nearby debris (mass / distance), preferring crystals when
 *   energy is low; recharge in a star's charge band when energy is low and no threat is near.
 * - Stay off the arena wall.
 * - Pull (if usesPull): when prey or a dense debris patch is inside pullRadius and energy is
 *   comfortably above CONFIG.energy.lowThreshold.
 * - Add aim noise of up to `noise` radians per decision; coast (zero thrust) briefly when
 *   energy is very low so it can regenerate.
 */
export function botIntent(world: World, brain: BotBrain): Intent {
  let me: Body | undefined
  for (const b of world.bodies) {
    if (b.id === brain.bodyId) {
      me = b
      break
    }
  }
  if (world.phase !== "playing" || !me || !me.alive) return { ax: 0, ay: 0, pull: false }

  brain.thinkIn -= CONFIG.dt
  if (brain.thinkIn > 0) return { ax: brain.current.ax, ay: brain.current.ay, pull: brain.current.pull }
  brain.thinkIn += CONFIG.difficulty[brain.difficulty].reaction

  brain.current = decide(world, brain, me)
  return { ax: brain.current.ax, ay: brain.current.ay, pull: brain.current.pull }
}

// ---------------------------------------------------------------------------------------------
// PRIVATE — implementation helpers go below this line.
// ---------------------------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Distance from point (px, py) to the segment (ax, ay)-(bx, by). */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const sx = bx - ax
  const sy = by - ay
  const len2 = sx * sx + sy * sy
  const t = len2 > 1e-9 ? clamp(((px - ax) * sx + (py - ay) * sy) / len2, 0, 1) : 0
  return Math.hypot(px - (ax + sx * t), py - (ay + sy * t))
}

/** True if the straight line me -> (tx, ty) passes within well.radius + 80 of any well. */
function crossesWell(world: World, me: Body, tx: number, ty: number): boolean {
  for (const w of world.wells) {
    if (distToSegment(w.x, w.y, me.x, me.y, tx, ty) < w.radius + 80) return true
  }
  return false
}

/** One re-decision. Pure with respect to `world`; only advances brain.rngState / memory. */
function decide(world: World, brain: BotBrain, me: Body): Intent {
  const profile = CONFIG.difficulty[brain.difficulty]
  const caution = profile.caution
  const energyLow = CONFIG.energy.lowThreshold
  let sx = 0
  let sy = 0

  // 1. Wells: survival, highest priority.
  let wellMax = 0
  for (const w of world.wells) {
    const dx = me.x - w.x
    const dy = me.y - w.y
    const d = Math.max(Math.hypot(dx, dy), 1e-6)
    const ux = dx / d
    const uy = dy / d
    const inward = Math.max(0, -(me.vx * ux + me.vy * uy))
    // A low-energy bot tolerates a star's charge band instead of fleeing it.
    const kindScale = w.kind === "blackhole" ? 1.4 : me.energy < 35 ? 0.3 : 1
    const margin = (180 + me.radius * 3) * (0.5 + caution) * kindScale + inward * 0.6
    const danger = w.radius + me.radius + margin
    if (d >= 2 * danger) continue
    const f = clamp((2 * danger - d) / danger, 0, 3)
    const weight = 3 * f * f
    // Tangent (perpendicular to the away direction) in the sense the body already circles.
    let tx = -uy
    let ty = ux
    if (me.vx * tx + me.vy * ty < 0) {
      tx = -tx
      ty = -ty
    }
    sx += weight * (0.7 * ux + 0.3 * tx)
    sy += weight * (0.7 * uy + 0.3 * ty)
    if (weight > wellMax) wellMax = weight
  }
  const wellPanic = wellMax > 2

  // 2. Wall.
  const distC = Math.hypot(me.x, me.y)
  const wallEdge = world.arenaRadius - 250
  if (distC > wallEdge) {
    const w = (2 * (distC - wallEdge)) / 250
    sx += (-me.x / distC) * w
    sy += (-me.y / distC) * w
  }

  // 3. Threats (bigger rivals) and 4. prey, in one pass over the bodies.
  let threat = false
  let prey: Body | undefined
  let preyScore = 0
  let preyAx = 0
  let preyAy = 0
  let preyD = 0
  const speedMe = Math.max(maxSpeed(me.mass), 1)
  const huntOpen = world.time >= profile.huntGrace
  const pr = pullRadius(me)
  // Prey hysteresis: the previously chosen prey stays unless another is > 1.3x better.
  const keepPreyId = brain.memory.prey
  let keepPreyScore = 0
  let keepPrey: Body | undefined
  let keepAx = 0
  let keepAy = 0
  let keepD = 0
  let rivalInPull = false
  for (const r of world.bodies) {
    if (r === me || !r.alive) continue
    const dx = r.x - me.x
    const dy = r.y - me.y
    const d = Math.hypot(dx, dy)
    if (d < pr && canAbsorb(me, r)) rivalInPull = true
    if (canAbsorb(r, me)) {
      const range = (350 + r.radius * 4) * (0.6 + 0.4 * caution)
      if (d < range) {
        threat = true
        const ax = me.x - (r.x + r.vx * 0.3)
        const ay = me.y - (r.y + r.vy * 0.3)
        const al = Math.max(Math.hypot(ax, ay), 1e-6)
        const weight = 2.5 * (1 - d / range) * (0.5 + caution)
        sx += (ax / al) * weight
        sy += (ay / al) * weight
      }
    } else if (!wellPanic && huntOpen && canAbsorb(me, r) && r.shield === 0 && d < 500 + 400 * profile.aggression) {
      const score = r.mass / (d + 50)
      const isKeep = r.id === keepPreyId
      if (score > preyScore || isKeep) {
        const lead = (d / speedMe) * profile.aimLead
        const ax = r.x + r.vx * lead
        const ay = r.y + r.vy * lead
        if (!crossesWell(world, me, ax, ay)) {
          if (isKeep) {
            keepPrey = r
            keepPreyScore = score
            keepAx = ax
            keepAy = ay
            keepD = d
          }
          if (score > preyScore) {
            prey = r
            preyScore = score
            preyAx = ax
            preyAy = ay
            preyD = d
          }
        }
      }
    }
  }
  if (keepPrey && keepPrey !== prey && keepPreyScore * 1.3 >= preyScore) {
    prey = keepPrey
    preyAx = keepAx
    preyAy = keepAy
    preyD = keepD
  }
  brain.memory.prey = prey ? prey.id : ""
  if (prey) {
    const dx = preyAx - me.x
    const dy = preyAy - me.y
    const dl = Math.max(Math.hypot(dx, dy), 1e-6)
    const weight = 1.6 * profile.aggression
    sx += (dx / dl) * weight
    sy += (dy / dl) * weight
  }

  // 5. Graze: best debris by mass / distance (crystals worth more when energy is low).
  let nearDebris = 0
  let debris: { x: number; y: number } | undefined
  let debrisScore = 0
  let debrisD = 0
  // Debris hysteresis: keep the previous piece while it exists and is within 1.3x of the best.
  const keepDebrisId = typeof brain.memory.debris === "number" ? brain.memory.debris : -1
  let keepDebris: { x: number; y: number; id: number } | undefined
  let keepDebrisScore = 0
  let keepDebrisD = 0
  let pickedId = -1
  const crystalMul = me.energy < 50 ? 6 : 2
  if (!wellPanic) {
    for (const c of world.debris) {
      const dx = c.x - me.x
      const dy = c.y - me.y
      const d2 = dx * dx + dy * dy
      if (d2 < pr * pr) nearDebris++
      if (d2 > 600 * 600) continue
      const d = Math.sqrt(d2)
      const score = (c.kind === "crystal" ? c.mass * crystalMul : c.mass) / (d + 30)
      const isKeep = c.id === keepDebrisId
      if ((score > debrisScore || isKeep) && !crossesWell(world, me, c.x, c.y)) {
        if (isKeep) {
          keepDebris = c
          keepDebrisScore = score
          keepDebrisD = d
        }
        if (score > debrisScore) {
          debris = c
          debrisScore = score
          debrisD = d
          pickedId = c.id
        }
      }
    }
    if (keepDebris && keepDebris.id !== pickedId && keepDebrisScore * 1.3 >= debrisScore) {
      debris = keepDebris
      debrisD = keepDebrisD
      pickedId = keepDebris.id
    }
    brain.memory.debris = pickedId
    if (debris) {
      const dx = debris.x - me.x
      const dy = debris.y - me.y
      const dl = Math.max(Math.hypot(dx, dy), 1e-6)
      const weight = prey ? 1 - profile.aggression : 1
      sx += (dx / dl) * weight
      sy += (dy / dl) * weight
    }
  }

  // 6. Charge: low energy, no threat -> nearest star.
  let halfThrust = false
  if (me.energy < 35 && !threat && !wellPanic) {
    let star: (typeof world.wells)[number] | undefined
    let starD = Infinity
    for (const w of world.wells) {
      if (w.kind !== "star") continue
      const d = Math.hypot(w.x - me.x, w.y - me.y)
      if (d < starD) {
        starD = d
        star = w
      }
    }
    if (star) {
      const ux = (me.x - star.x) / Math.max(starD, 1e-6)
      const uy = (me.y - star.y) / Math.max(starD, 1e-6)
      if (starD > star.chargeRadius) {
        const mid = (star.radius + star.chargeRadius) / 2
        const dx = star.x + ux * mid - me.x
        const dy = star.y + uy * mid - me.y
        const dl = Math.max(Math.hypot(dx, dy), 1e-6)
        sx += (dx / dl) * 1.2
        sy += (dy / dl) * 1.2
      } else if (starD > star.radius) {
        let tx = -uy
        let ty = ux
        if (me.vx * tx + me.vy * ty < 0) {
          tx = -tx
          ty = -ty
        }
        sx += tx * 1.2
        sy += ty * 1.2
        halfThrust = true
      }
    }
  }

  // 7. Wander when nothing else pulls.
  let sl = Math.hypot(sx, sy)
  if (sl < 1e-3) {
    let a = brain.memory.wander
    if (typeof a !== "number") a = randRange(brain, 0, Math.PI * 2)
    a += randRange(brain, -0.4, 0.4)
    brain.memory.wander = a
    sx = Math.cos(a) * 0.4
    sy = Math.sin(a) * 0.4
    sl = 0.4
  }

  // Direction with aim noise (always draws once so the stream is decision-count deterministic).
  const rot = (rand(brain) * 2 - 1) * profile.noise
  const cs = Math.cos(rot)
  const sn = Math.sin(rot)
  const ux = sx / sl
  const uy = sy / sl
  const dirX = ux * cs - uy * sn
  const dirY = ux * sn + uy * cs

  // Magnitude.
  let mag = profile.thrustScale
  if (me.energy < 10 && !threat && !wellPanic) mag = 0
  else if (halfThrust) mag *= 0.5
  else {
    const targetD = prey ? preyD : debris ? debrisD : Infinity
    if (targetD < me.radius * 2) mag *= 0.5
  }

  // Pull.
  let pull = false
  if (profile.usesPull && me.energy > energyLow + 10 && !threat) {
    pull = (prey !== undefined && preyD < pr) || nearDebris >= 3
    // During the hunt grace period a debris pull must not drag an absorbable rival into us.
    if (pull && world.time < profile.huntGrace && rivalInPull) pull = false
  }

  return { ax: dirX * mag, ay: dirY * mag, pull }
}
