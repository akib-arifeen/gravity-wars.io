// Bot brains. A bot sees the same World the renderer sees and answers with an Intent, exactly
// like a human controller would (see the multiplayer seam note on Intent in types.ts).
//
// CONTRACT — exported signatures and documented behaviour are fixed. Put helpers and any extra
// brain fields' logic in the PRIVATE section at the bottom.

import { CONFIG } from "./config"
import { gmScale, lethalRadius } from "./cosmic"
import { canAbsorb, maxSpeed, pullRadius, repulseRadius } from "./engine"
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
 *
 * Phase A behaviours (all gated by difficulty: easy uses none of the abilities, normal uses
 * dash and repulse, hard uses all three; usage frequency scales with aggression):
 * - Dash to escape a threat that is closing fast, or to lunge at prey within ~1.5x pull radius.
 * - Repulse when a rival it cannot beat is within the repulse radius (escape), or when a rival
 *   sits between it and a lethal well (shove it in).
 * - Singularity (hard only) when ult === 1 and absorbable prey or a dense debris patch is near.
 * - Treat pickups as high-value graze targets (bulk and phase most), and comets as big debris.
 * - Cosmic events: avoid a flaring star's flare radius during warning and active stages; seek an
 *   active meteor shower or quantum anomaly when no threat is near; treat lethal wells as
 *   stronger during a gravity storm (scale the survival margin by gmScale).
 * - Pulsar beams: steer out of a beam's current sweep when inside its length.
 * Ability flags follow the Intent contract (true only on the decision step that wants them;
 * botIntent returns them only on decision steps, never repeated between decisions).
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

  const it = decide(world, brain, me)
  // Held between decisions without ability flags: a press is one step only.
  brain.current = { ax: it.ax, ay: it.ay, pull: it.pull }
  return it
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

/** True if the straight line me -> (tx, ty) passes within a well's danger radius + 80 (solid wells: + 30). */
function crossesWell(world: World, me: Body, tx: number, ty: number): boolean {
  for (const w of world.wells) {
    const reach = w.lethal ? lethalRadius(world, w) + 80 : w.radius + 30
    if (distToSegment(w.x, w.y, me.x, me.y, tx, ty) < reach) return true
  }
  return false
}

const TWO_PI = Math.PI * 2

function angGap(a: number, b: number): number {
  let d = Math.abs(a - b) % TWO_PI
  if (d > Math.PI) d = TWO_PI - d
  return d
}

/** Relative worth of a power-up, in "mass of dust" units for the graze score. */
const PICKUP_VALUE = { bulk: 30, phase: 24, overdrive: 14, magnet: 10 } as const

/** One re-decision. Pure with respect to `world`; only advances brain.rngState / memory. */
function decide(world: World, brain: BotBrain, me: Body): Intent {
  const profile = CONFIG.difficulty[brain.difficulty]
  const caution = profile.caution
  const energyLow = CONFIG.energy.lowThreshold
  // Ability tier: easy none, normal dash + repulse, hard all three.
  const tier = brain.difficulty === "easy" ? 0 : brain.difficulty === "normal" ? 1 : 2
  const gms = gmScale(world)
  const ev = world.cosmic
  let sx = 0
  let sy = 0

  // 1. Wells: survival, highest priority. Moving wells are looked ahead 0.5 s.
  let wellMax = 0
  for (const w of world.wells) {
    const dx = me.x - (w.x + w.vx * 0.5)
    const dy = me.y - (w.y + w.vy * 0.5)
    const d = Math.max(Math.hypot(dx, dy), 1e-6)
    const ux = dx / d
    const uy = dy / d
    const inward = Math.max(0, -((me.vx - w.vx) * ux + (me.vy - w.vy) * uy))
    if (w.lethal) {
      let rad = lethalRadius(world, w)
      if (ev && ev.kind === "solarFlare" && ev.stage === "warning" && ev.targetId === w.id) {
        rad = w.radius * CONFIG.cosmic.solarFlare.radiusMul
      }
      // A low-energy bot tolerates a charging well's band instead of fleeing it.
      const kindScale = w.kind === "blackhole" ? 1.4 : me.energy < 35 && w.chargeRadius > 0 ? 0.3 : 1
      const margin = (180 + me.radius * 3) * (0.5 + caution) * kindScale * gms + inward * 0.6
      const danger = rad + me.radius + margin
      if (d < 2 * danger) {
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
    } else {
      // Solid wells are not deadly: just do not ram them at speed.
      const danger = w.radius + me.radius + 30 + inward * 0.4
      if (d < 2 * danger) {
        const f = clamp((2 * danger - d) / danger, 0, 2)
        sx += 0.8 * f * f * ux
        sy += 0.8 * f * f * uy
      }
    }
    if (w.beam && d < w.beam.length + 50) {
      // Leave the beam's sweep: it moves with +w, so slide the other way to exit its trailing edge.
      const th = w.beam.phase + w.beam.w * world.time
      const phi = Math.atan2(dy, dx)
      const gap = Math.min(angGap(phi, th), angGap(phi, th + Math.PI))
      if (gap < w.beam.halfWidth + 0.12 + Math.abs(w.beam.w) * 0.5) {
        const sgn = w.beam.w >= 0 ? -1 : 1
        sx += 2.5 * sgn * -uy
        sy += 2.5 * sgn * ux
        if (wellMax < 2.5) wellMax = 2.5
      }
    }
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
  let fastThreat = false
  let escapeRepulse = false
  let shove = false
  let prey: Body | undefined
  let preyScore = 0
  let preyAx = 0
  let preyAy = 0
  let preyD = 0
  const speedMe = Math.max(maxSpeed(me.mass), 1)
  const huntOpen = world.time >= profile.huntGrace
  const pr = pullRadius(me)
  const rr = repulseRadius(me)
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
        const closing = -((r.vx - me.vx) * dx + (r.vy - me.vy) * dy) / Math.max(d, 1e-6)
        if (closing > 90 && d < range * 0.7) fastThreat = true
        if (d < rr * 0.85) escapeRepulse = true
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
    // A rival sitting between us and a lethal well can be shoved in with a repulse.
    if (tier > 0 && huntOpen && !shove && d < rr * 0.9 && d > 1e-6 && r.shield === 0) {
      for (const w of world.wells) {
        if (!w.lethal) continue
        const wx = w.x - r.x
        const wy = w.y - r.y
        const wd = Math.hypot(wx, wy)
        if (wd < 380 && wd > 1e-6 && (dx * wx + dy * wy) / (d * wd) > 0.8) {
          shove = true
          break
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

  // 4b. Zones: a fleeing bot stays out of drag clouds; seek a quantum anomaly to charge up.
  for (const z of world.zones) {
    const dx = z.x - me.x
    const dy = z.y - me.y
    const d = Math.max(Math.hypot(dx, dy), 1e-6)
    if (z.kind === "nebula" && threat && d < z.r + 80) {
      sx -= (dx / d) * 1.0
      sy -= (dy / d) * 1.0
    } else if (z.kind === "anomaly" && !threat && !wellPanic && me.ult < 1 && (tier === 2 || me.energy < 60)) {
      if (d > z.r * 0.4 && d < 1100) {
        sx += (dx / d) * 1.1
        sy += (dy / d) * 1.1
      }
    }
  }
  // An active meteor shower is free mass: go and stand in it.
  if (ev && ev.kind === "meteorShower" && ev.stage === "active" && !threat && !wellPanic) {
    const dx = ev.x - me.x
    const dy = ev.y - me.y
    const d = Math.max(Math.hypot(dx, dy), 1e-6)
    if (d > ev.r * 0.5 && d < 1400) {
      sx += (dx / d) * 0.7
      sy += (dy / d) * 0.7
    }
  }

  // 5. Graze: best food by value / distance. Debris, comets (led by velocity) and power-ups.
  let nearDebris = 0
  let targetD = Infinity
  let pickedId = -1
  let bestScore = 0
  let bestAx = 0
  let bestAy = 0
  let bestD = 0
  const keepDebrisId = typeof brain.memory.debris === "number" ? brain.memory.debris : -1
  let keepScore = 0
  let keepFound = false
  let keepAx2 = 0
  let keepAy2 = 0
  let keepD2 = 0
  const crystalMul = me.energy < 50 ? 6 : 2
  const consider = (id: number, ax: number, ay: number, score: number, d: number): void => {
    const isKeep = id === keepDebrisId
    if ((score > bestScore || isKeep) && !crossesWell(world, me, ax, ay)) {
      if (isKeep) {
        keepFound = true
        keepScore = score
        keepAx2 = ax
        keepAy2 = ay
        keepD2 = d
      }
      if (score > bestScore) {
        bestScore = score
        pickedId = id
        bestAx = ax
        bestAy = ay
        bestD = d
      }
    }
  }
  if (!wellPanic) {
    for (const p of world.pickups) {
      const d = Math.hypot(p.x - me.x, p.y - me.y)
      if (d > 800 || p.ttl < d / speedMe) continue
      consider(p.id, p.x, p.y, PICKUP_VALUE[p.kind] / (d + 30), d)
    }
    for (const c of world.debris) {
      const dx = c.x - me.x
      const dy = c.y - me.y
      const d2 = dx * dx + dy * dy
      if (d2 < pr * pr) nearDebris++
      const comet = c.kind === "comet"
      if (d2 > (comet ? 700 * 700 : 600 * 600)) continue
      const d = Math.sqrt(d2)
      let ax = c.x
      let ay = c.y
      if (comet) {
        // Comets are fast: skip ones running away, lead the rest.
        if ((c.vx * dx + c.vy * dy) / Math.max(d, 1e-6) > speedMe * 0.9) continue
        const lead = Math.min(d / speedMe, 1.5) * Math.max(profile.aimLead, 0.5)
        ax += c.vx * lead
        ay += c.vy * lead
      }
      const score = (c.kind === "crystal" ? c.mass * crystalMul : c.mass) / (d + 30)
      consider(c.id, ax, ay, score, d)
    }
    if (keepFound && keepScore * 1.3 >= bestScore && pickedId !== keepDebrisId) {
      pickedId = keepDebrisId
      bestAx = keepAx2
      bestAy = keepAy2
      bestD = keepD2
    }
    brain.memory.debris = pickedId
    if (pickedId !== -1) {
      const dx = bestAx - me.x
      const dy = bestAy - me.y
      const dl = Math.max(Math.hypot(dx, dy), 1e-6)
      const weight = prey ? 1 - profile.aggression : 1
      sx += (dx / dl) * weight
      sy += (dy / dl) * weight
      targetD = bestD
    }
  }

  // 6. Charge: low energy, no threat -> nearest charging well (stations are safe, stars are not).
  let halfThrust = false
  if (me.energy < 35 && !threat && !wellPanic) {
    let star: (typeof world.wells)[number] | undefined
    let starD = Infinity
    for (const w of world.wells) {
      if (w.chargeRadius <= 0 || w.chargeRate <= 0 || w.kind === "pulsar") continue
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
    const tD = prey ? preyD : targetD
    if (tD < me.radius * 2) mag *= 0.5
  }

  // Pull.
  let pull = false
  if (profile.usesPull && me.energy > energyLow + 10 && !threat) {
    pull = (prey !== undefined && preyD < pr) || nearDebris >= 3
    // During the hunt grace period a debris pull must not drag an absorbable rival into us.
    if (pull && world.time < profile.huntGrace && rivalInPull) pull = false
  }

  const out: Intent = { ax: dirX * mag, ay: dirY * mag, pull }

  // Abilities (decision steps only; frequency scales with aggression).
  if (tier > 0) {
    const aggr = profile.aggression
    const A = CONFIG.abilities
    if (me.dashCd <= 0 && me.energy >= A.dash.cost + 8 && mag > 0 && !wellPanic) {
      if (fastThreat) {
        if (rand(brain) < 0.5 + 0.5 * aggr) out.dash = true
      } else if (prey && preyD < 1.5 * pr && preyD > me.radius * 3) {
        const pdx = preyAx - me.x
        const pdy = preyAy - me.y
        const align = (dirX * pdx + dirY * pdy) / Math.max(Math.hypot(pdx, pdy), 1e-6)
        if (align > 0.85 && rand(brain) < 0.15 + 0.5 * aggr) out.dash = true
      }
    }
    if (me.repulseCd <= 0 && me.energy >= A.repulse.cost + 5) {
      if (escapeRepulse) {
        if (rand(brain) < 0.6 + 0.4 * aggr) out.repulse = true
      } else if (shove && rand(brain) < 0.2 + 0.6 * aggr) out.repulse = true
    }
    if (tier === 2 && me.ult >= 1 && ((prey !== undefined && preyD < pr * 1.3) || nearDebris >= 5)) out.ult = true
  }
  return out
}
