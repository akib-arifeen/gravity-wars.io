// The Vast's solar current: a co-rotating band that pushes living bodies tangentially, thins
// drag, and builds a per-life sail charge that raises the speed ceiling. These tests pin the
// physics, the resets, the composition with the Oberth surge, and the promise that no other
// arena behaves differently.

import { describe, expect, it } from "vitest"
import { botIntent, createBotBrain } from "../bots"
import { CONFIG } from "../config"
import { createWorld, maxSpeed, step } from "../engine"
import { solarCurrentFalloff, solarCurrentRadius, solarCurrentVisual, updateSolarSail } from "../solarCurrent"
import type { Body, World } from "../types"
import { DT, controlledWorld, endlessWorld, makeDebris, placeBody } from "./helpers"

const S = CONFIG.vast.solarCurrent
const R = CONFIG.vast.arenaRadius * S.bandRadiusFrac

function vastWorld(seed = 1): World {
  return controlledWorld({ seed, arena: "vast", botCount: 0 })
}

function atBand(b: Body, angle = 0): Body {
  b.x = Math.cos(angle) * R
  b.y = Math.sin(angle) * R
  b.px = b.x
  b.py = b.y
  b.vx = 0
  b.vy = 0
  b.sail = 0
  return b
}

describe("solar current: geometry and force", () => {
  it("sits at arenaBase/3 (1600 u in The Vast) and nowhere else", () => {
    expect(R).toBe(1600)
    expect(solarCurrentRadius(vastWorld())).toBe(1600)
    expect(solarCurrentRadius(controlledWorld({ arena: "classic" }))).toBe(0)
    expect(solarCurrentFalloff(controlledWorld({ arena: "classic" }), 1600, 0)).toBe(0)
  })

  it("pushes counter-clockwise, purely tangentially, with no radial component", () => {
    const w = vastWorld()
    const b = atBand(w.bodies[0])
    step(w, {})
    // At (1600, 0) the counter-clockwise tangent is +y; x must not move.
    expect(b.vy).toBeGreaterThan(0)
    expect(Math.abs(b.vx)).toBeLessThan(1e-12)

    const w2 = vastWorld(2)
    const b2 = atBand(w2.bodies[0], Math.PI / 2)
    step(w2, {})
    // At (0, 1600) the same co-rotation points -x.
    expect(b2.vx).toBeLessThan(0)
    expect(Math.abs(b2.vy)).toBeLessThan(1e-12)
  })

  it("is exactly zero outside the band and falls smoothly from the centre", () => {
    const w = vastWorld()
    expect(solarCurrentFalloff(w, R, 0)).toBe(1)
    expect(solarCurrentFalloff(w, R + S.halfWidth, 0)).toBe(0)
    expect(solarCurrentFalloff(w, R - S.halfWidth, 0)).toBe(0)
    expect(solarCurrentFalloff(w, R + S.halfWidth + 1e-6, 0)).toBe(0)
    expect(solarCurrentFalloff(w, 4000, 0)).toBe(0)
    // Just inside the edge the force is already almost gone (zero slope at the edge).
    expect(solarCurrentFalloff(w, R + S.halfWidth - 1, 0)).toBeLessThan(0.001)
    let prev = Infinity
    for (let off = 0; off <= S.halfWidth; off += 10) {
      const f = solarCurrentFalloff(w, R + off, 0)
      expect(f).toBeLessThanOrEqual(prev)
      prev = f
    }
    // Symmetric inwards and outwards.
    for (let off = 10; off < S.halfWidth; off += 40) {
      expect(solarCurrentFalloff(w, R - off, 0)).toBeCloseTo(solarCurrentFalloff(w, R + off, 0), 12)
    }
  })

  it("never pushes debris", () => {
    const w = vastWorld()
    const d = makeDebris(w, "dust", R, 0)
    step(w, {})
    expect(d.vx).toBe(0)
    expect(d.vy).toBe(0)
    expect(d.x).toBe(R)
    expect(d.y).toBe(0)
  })
})

describe("solar current: sail charge", () => {
  it("fills in about 4 s of aligned motion and ignores a body at rest or crossing the band", () => {
    const w = vastWorld()
    const b = atBand(w.bodies[0])
    b.vy = 200
    for (let t = 0; t < 2; t += DT) updateSolarSail(w, b, DT)
    expect(b.sail).toBeGreaterThan(0.45)
    expect(b.sail).toBeLessThan(0.55)
    for (let t = 2; t < 4; t += DT) updateSolarSail(w, b, DT)
    expect(b.sail).toBe(1)

    b.sail = 0
    b.vy = 0
    for (let t = 0; t < 4; t += DT) updateSolarSail(w, b, DT)
    expect(b.sail).toBe(0)

    // Moving radially, perpendicular to the current, builds nothing.
    b.vx = 200
    b.vy = 0
    for (let t = 0; t < 4; t += DT) updateSolarSail(w, b, DT)
    expect(b.sail).toBe(0)
  })

  it("decays outside the band over about 20 s", () => {
    const w = vastWorld()
    const b = atBand(w.bodies[0])
    b.x = 2600
    b.y = 0
    b.px = b.x
    b.py = b.y
    b.sail = 1
    for (let t = 0; t < 20; t += DT) updateSolarSail(w, b, DT)
    expect(b.sail).toBe(0)
  })

  it("builds through the engine from real motion, and resets on death, respawn and a fresh body", () => {
    const w = vastWorld()
    expect(w.bodies.every((body) => body.sail === 0)).toBe(true)
    const b = atBand(w.bodies[0])
    b.vy = 200
    step(w, {})
    expect(b.sail).toBeGreaterThan(0)

    // Death (a lethal well) clears the charge on the same step.
    const dead = vastWorld(3)
    const p = atBand(dead.bodies[0])
    p.sail = 1
    dead.wells.push({
      id: "test-star",
      kind: "star",
      x: p.x,
      y: p.y,
      vx: 0,
      vy: 0,
      gm: CONFIG.well.starGm,
      radius: CONFIG.well.starRadius,
      chargeRadius: CONFIG.well.starChargeRadius,
      chargeRate: CONFIG.well.starChargeRate,
      lethal: true,
      orbit: null,
      beam: null,
    })
    step(dead, {})
    expect(p.alive).toBe(false)
    expect(p.sail).toBe(0)

    // Endless respawn.
    const e = endlessWorld({ seed: 4, arena: "vast" })
    const player = e.bodies[0]
    player.sail = 1
    player.alive = false
    e.endless!.respawnIn = DT / 2
    step(e, {})
    expect(player.alive).toBe(true)
    expect(player.sail).toBe(0)

    // A joining bot is built fresh.
    const e2 = endlessWorld({ seed: 5, arena: "vast" })
    e2.bodies[1].alive = false
    e2.bodies[1].sail = 1
    e2.endless!.joinIn[1] = DT / 2
    step(e2, {})
    expect(e2.bodies[1].alive).toBe(true)
    expect(e2.bodies[1].sail).toBe(0)
  })
})

describe("solar current: speed ceiling", () => {
  /** Hold a thrusting body on the band centre and report the speed the ceiling settles at. */
  function ceilingSpeed(sail: number, surgeMul = 0): number {
    const w = vastWorld()
    const b = w.bodies[0]
    for (let i = 0; i < 240; i++) {
      b.x = R
      b.y = 0
      b.px = R
      b.py = 0
      const sp = Math.hypot(b.vx, b.vy)
      b.vx = 0
      b.vy = sp
      b.sail = sail
      b.assist.surge = surgeMul > 0 ? 10 : 0
      b.assist.surgeMul = surgeMul > 0 ? surgeMul : 1
      step(w, { player: { ax: 0, ay: 1, pull: false } })
    }
    return Math.hypot(b.vx, b.vy)
  }

  it("raises the ceiling by 18% at a full sail and stacks multiplicatively with a surge", () => {
    const base = maxSpeed(CONFIG.body.startMass)
    const none = ceilingSpeed(0)
    const full = ceilingSpeed(1)
    const both = ceilingSpeed(1, CONFIG.assist.tiers[2].speedMul)
    expect(none).toBeGreaterThan(base * 0.95)
    expect(none).toBeLessThanOrEqual(base + 1)
    expect(full).toBeGreaterThan(base * 1.15)
    expect(full).toBeLessThanOrEqual(base * (1 + S.thrustMul) + 1)
    const composed = base * CONFIG.assist.tiers[2].speedMul * (1 + S.thrustMul)
    expect(both).toBeGreaterThan(base * CONFIG.assist.tiers[2].speedMul * 1.15)
    expect(both).toBeLessThanOrEqual(composed + 1)
    expect(full / none).toBeCloseTo(1 + S.thrustMul, 1)
  })

  it("still respects the hard speed cap", () => {
    expect(CONFIG.body.hardSpeedCap).toBeGreaterThan(maxSpeed(CONFIG.body.startMass) * CONFIG.assist.maxSpeedMul * (1 + S.thrustMul) * 1.2)
  })
})

describe("solar current: other arenas and determinism", () => {
  it("changes no other arena's trajectory, even if a sail value is present", () => {
    const run = (sail: number) => {
      const w = controlledWorld({ seed: 11, arena: "classic" })
      w.bodies.forEach((b) => (b.sail = sail))
      for (let i = 0; i < 120; i++) step(w, { player: { ax: 0.4, ay: 0.9, pull: false } })
      return w.bodies.map((b) => [b.x, b.y, b.vx, b.vy])
    }
    expect(run(1)).toEqual(run(0))
  })

  it("leaves layout and world.rngState untouched", () => {
    const a = createWorld({ seed: 7, difficulty: "normal", arena: "vast", cosmic: false })
    const state = a.rngState
    for (let i = 0; i < 50; i++) solarCurrentVisual(a)
    solarCurrentFalloff(a, R, 0)
    expect(a.rngState).toBe(state)
    const b = createWorld({ seed: 7, difficulty: "normal", arena: "vast", cosmic: false })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(b.rngState).toBe(state)
    expect(a.wells.length).toBe(b.wells.length)
    expect(a.zones.length).toBe(b.zones.length)
    expect(a.wormholes.length).toBe(b.wormholes.length)
    expect(a.debris.length).toBe(b.debris.length)
  })
})

describe("solar current: bots can leave the band", () => {
  it("a bot chasing food outside the band exits it instead of being held on the arc", () => {
    const w = controlledWorld({ seed: 21, arena: "vast", botCount: 1 })
    const player = w.bodies[0]
    placeBody(w, 0, 3200, 0, 0, 0)
    player.sail = 0
    const bot = atBand(w.bodies[1])
    bot.shield = 0
    makeDebris(w, "rock", 2200, 0)
    const brain = createBotBrain(bot.id, "hard", 99)
    const intents = new Map<string, ReturnType<typeof botIntent>>()
    let exited = false
    for (let i = 0; i < Math.round(20 / DT); i++) {
      intents.clear()
      if (bot.alive) intents.set(bot.id, botIntent(w, brain))
      step(w, intents)
      if (bot.alive && Math.abs(Math.hypot(bot.x, bot.y) - R) > S.halfWidth) {
        exited = true
        break
      }
    }
    expect(bot.alive).toBe(true)
    expect(exited).toBe(true)
  })
})
