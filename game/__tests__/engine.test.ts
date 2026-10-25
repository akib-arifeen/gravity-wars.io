// Engine tests, written from the contract only (types.ts, config.ts, rng.ts and the documented
// exported signatures of engine.ts). Tunables are referenced through CONFIG by name.

import { describe, expect, it } from "vitest"
import { CONFIG } from "../config"
import {
  NO_INTENT,
  canAbsorb,
  cloneWorld,
  createWorld,
  hudSnapshot,
  maxSpeed,
  pullRadius,
  radiusForMass,
  rankOf,
  step,
  thrustAccel,
} from "../engine"
import type { Difficulty, GameEvent, Intent, World } from "../types"
import {
  DT,
  TWO_PI,
  addWell,
  angularGap,
  controlledWorld,
  credit,
  dist,
  eventsOf,
  expectClose,
  intent,
  makeDebris,
  makeWell,
  momentum,
  placeBody,
  setMass,
  snapshot,
  stepN,
} from "./helpers"

const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"]
const DRAG = Math.exp(-CONFIG.body.drag * DT)
const DEBRIS_DRAG = Math.exp(-CONFIG.debris.drag * DT)

// ---------------------------------------------------------------------------------------------
describe("1. formulas", () => {
  it("radiusForMass = radiusK * sqrt(mass)", () => {
    for (const m of [0.5, 1, 10, 30, 120]) {
      expectClose(radiusForMass(m), CONFIG.body.radiusK * Math.sqrt(m), 1e-12, `radius(${m})`)
    }
  })

  it("thrustAccel = thrustAccel * (refMass/mass)^thrustMassExp and falls with mass", () => {
    const b = CONFIG.body
    for (const m of [2, 10, 40, 120]) {
      expectClose(thrustAccel(m), b.thrustAccel * Math.pow(b.refMass / m, b.thrustMassExp), 1e-9, `thrustAccel(${m})`)
    }
    expectClose(thrustAccel(b.refMass), b.thrustAccel, 1e-9, "thrustAccel at refMass")
    expect(thrustAccel(40)).toBeLessThan(thrustAccel(10))
  })

  it("maxSpeed = maxSpeed * (refMass/mass)^maxSpeedMassExp and falls with mass", () => {
    const b = CONFIG.body
    for (const m of [2, 10, 40, 120]) {
      expectClose(maxSpeed(m), b.maxSpeed * Math.pow(b.refMass / m, b.maxSpeedMassExp), 1e-9, `maxSpeed(${m})`)
    }
    expectClose(maxSpeed(b.refMass), b.maxSpeed, 1e-9, "maxSpeed at refMass")
    expect(maxSpeed(40)).toBeLessThan(maxSpeed(10))
  })

  it("pullRadius = baseRadius + radius * radiusPerR", () => {
    const w = controlledWorld({ botCount: 1 })
    const b = setMass(w.bodies[0], 30)
    expectClose(pullRadius(b), CONFIG.pull.baseRadius + b.radius * CONFIG.pull.radiusPerR, 1e-12)
  })

  it("canAbsorb is a pure mass-ratio test (>= ratio)", () => {
    const w = controlledWorld({ botCount: 1 })
    const [a, b] = w.bodies
    b.mass = 10
    a.mass = CONFIG.absorb.ratio * b.mass
    expect(canAbsorb(a, b)).toBe(true)
    a.mass = CONFIG.absorb.ratio * b.mass * (1 - 1e-9)
    expect(canAbsorb(a, b)).toBe(false)
    a.mass = b.mass
    expect(canAbsorb(a, b)).toBe(false)
    a.mass = 100 * b.mass
    expect(canAbsorb(a, b)).toBe(true)
    expect(canAbsorb(b, a)).toBe(false)
  })

  it("NO_INTENT is a zero, non-pulling intent", () => {
    expect(NO_INTENT).toEqual({ ax: 0, ay: 0, pull: false })
    expect(Object.isFrozen(NO_INTENT)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
describe("2. createWorld", { timeout: 30000 }, () => {
  it("is deterministic: equal options give deep-equal worlds, another seed differs", () => {
    for (const difficulty of DIFFICULTIES) {
      const a = createWorld({ seed: 7, difficulty })
      const b = createWorld({ seed: 7, difficulty })
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(a).toEqual(b)
      const c = createWorld({ seed: 8, difficulty })
      expect(JSON.stringify(c)).not.toBe(JSON.stringify(a))
    }
  })

  it("accepts odd seeds (0, negative, fractional) deterministically", () => {
    for (const seed of [0, -5, 3.7, 4294967296 + 5]) {
      const a = createWorld({ seed, difficulty: "normal" })
      const b = createWorld({ seed, difficulty: "normal" })
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(a.rngState).toBeGreaterThan(0)
    }
  })

  it("body count is 1 + profile.bots per difficulty; botCount overrides", () => {
    for (const difficulty of DIFFICULTIES) {
      expect(createWorld({ seed: 1, difficulty }).bodies).toHaveLength(1 + CONFIG.difficulty[difficulty].bots)
    }
    expect(createWorld({ seed: 1, difficulty: "hard", botCount: 2 }).bodies).toHaveLength(3)
    expect(createWorld({ seed: 1, difficulty: "easy", botCount: 0 }).bodies).toHaveLength(1)
    expect(createWorld({ seed: 1, difficulty: "easy", botCount: CONFIG.bots.names.length }).bodies).toHaveLength(
      CONFIG.bots.names.length + 1,
    )
  })

  it("throws RangeError for a botCount that is negative, fractional, NaN or too large", () => {
    for (const botCount of [-1, 1.5, Number.NaN, CONFIG.bots.names.length + 1]) {
      expect(() => createWorld({ seed: 1, difficulty: "normal", botCount }), `botCount ${botCount}`).toThrow(RangeError)
    }
  })

  it("starts in countdown with the documented header fields", () => {
    const w = createWorld({ seed: 3, difficulty: "normal" })
    expect(w.seed).toBe(3)
    expect(w.difficulty).toBe("normal")
    expect(w.phase).toBe("countdown")
    expect(w.countdown).toBe(CONFIG.round.countdown)
    expect(w.timeLeft).toBe(CONFIG.round.duration)
    expect(w.tick).toBe(0)
    expect(w.time).toBe(0)
    expect(w.events).toEqual([])
    expect(w.result).toBeNull()
    expect(w.arenaRadius).toBe(CONFIG.arena.radius)
  })

  it("bodies: player first, bots named and coloured from CONFIG in order, fresh stats", () => {
    for (const difficulty of DIFFICULTIES) {
      const w = createWorld({ seed: 11, difficulty })
      const p = w.bodies[0]
      expect(p.id).toBe("player")
      expect(p.kind).toBe("player")
      expect(p.name).toBe(CONFIG.player.name)
      expect(p.color).toBe(CONFIG.player.color)
      expect(p.mass).toBe(CONFIG.body.startMass)
      const [lo, hi] = CONFIG.difficulty[difficulty].startMassScale
      w.bodies.slice(1).forEach((b, i) => {
        expect(b.id).toBe(`bot-${i + 1}`)
        expect(b.kind).toBe("bot")
        expect(b.name).toBe(CONFIG.bots.names[i])
        expect(b.color).toBe(CONFIG.bots.colors[i])
        expect(b.mass).toBeGreaterThanOrEqual(CONFIG.body.startMass * lo - 1e-9)
        expect(b.mass).toBeLessThanOrEqual(CONFIG.body.startMass * hi + 1e-9)
      })
      for (const b of w.bodies) {
        expect(b.vx).toBe(0)
        expect(b.vy).toBe(0)
        expect(b.px).toBe(b.x)
        expect(b.py).toBe(b.y)
        expectClose(b.radius, radiusForMass(b.mass), 1e-12, "radius")
        expect(b.energy).toBe(CONFIG.energy.max)
        expect(b.alive).toBe(true)
        expect(b.shield).toBe(CONFIG.body.spawnShield)
        expect(b.warpCooldown).toBe(0)
        expect(b.thrusting).toBe(false)
        expect(b.pulling).toBe(false)
        expect(b.charging).toBe(false)
        // Contract (createWorld step 2): "stats all 0 with peakMass = mass" (Phase A added more stat fields).
        expect(b.stats).toEqual({
          debrisEaten: 0,
          crystals: 0,
          rivalsAbsorbed: 0,
          peakMass: b.mass,
          dashes: 0,
          repulses: 0,
          ults: 0,
          slingshots: 0,
          oberths: 0,
          assists: 0,
          pickups: 0,
          comets: 0,
          topSpeed: 0,
        })
      }
    }
  })

  it("bodies sit on the spawn ring, evenly spaced", () => {
    for (const difficulty of DIFFICULTIES) {
      for (const seed of [1, 2, 3]) {
        const w = createWorld({ seed, difficulty })
        const n = w.bodies.length
        for (const b of w.bodies) expectClose(Math.hypot(b.x, b.y), CONFIG.spawn.ringRadius, 1e-6, `${b.id} ring distance`)
        const angles = w.bodies.map((b) => Math.atan2(b.y, b.x)).sort((a, b) => a - b)
        for (let i = 0; i < n; i++) {
          const next = i + 1 < n ? angles[i + 1] : angles[0] + TWO_PI
          expectClose(next - angles[i], TWO_PI / n, 1e-9, `angular gap ${i}`)
        }
      }
    }
  })

  it("the ring rotation depends on the seed", () => {
    const angles = new Set<number>()
    for (const seed of [1, 2, 3, 4, 5]) {
      const b = createWorld({ seed, difficulty: "normal" }).bodies[0]
      angles.add(Math.round(Math.atan2(b.y, b.x) * 1e6))
    }
    expect(angles.size).toBeGreaterThan(1)
  })

  it("wells: one black hole near the centre, starCount stars in the orbit band, >= 90 degrees apart", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const w = createWorld({ seed, difficulty: "normal" })
      const stars = w.wells.filter((x) => x.kind === "star")
      const holes = w.wells.filter((x) => x.kind === "blackhole")
      expect(stars, `seed ${seed}`).toHaveLength(CONFIG.well.starCount)
      expect(holes, `seed ${seed}`).toHaveLength(1)
      expect(w.wells).toHaveLength(CONFIG.well.starCount + 1)
      stars.forEach((s, i) => {
        expect(s.id).toBe(`star-${i + 1}`)
        expect(s.gm).toBe(CONFIG.well.starGm)
        expect(s.radius).toBe(CONFIG.well.starRadius)
        expect(s.chargeRadius).toBe(CONFIG.well.starChargeRadius)
        const d = Math.hypot(s.x, s.y)
        expect(d, `seed ${seed} star ${i} orbit`).toBeGreaterThanOrEqual(CONFIG.well.starOrbit[0] - 1e-9)
        expect(d, `seed ${seed} star ${i} orbit`).toBeLessThanOrEqual(CONFIG.well.starOrbit[1] + 1e-9)
      })
      for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
          const gap = angularGap(Math.atan2(stars[i].y, stars[i].x), Math.atan2(stars[j].y, stars[j].x))
          expect(gap, `seed ${seed} stars ${i},${j}`).toBeGreaterThanOrEqual(Math.PI / 2 - 1e-9)
        }
      }
      const h = holes[0]
      expect(h.id).toBe("hole-1")
      expect(h.gm).toBe(CONFIG.well.holeGm)
      expect(h.radius).toBe(CONFIG.well.holeRadius)
      expect(h.chargeRadius).toBe(0)
      expect(Math.hypot(h.x, h.y), `seed ${seed} hole offset`).toBeLessThanOrEqual(CONFIG.well.holeOffsetMax + 1e-9)
    }
  })

  it("the black hole offset varies with the seed (not stuck at the centre)", () => {
    const offsets = new Set<number>()
    for (let seed = 1; seed <= 10; seed++) {
      const h = createWorld({ seed, difficulty: "easy" }).wells.find((x) => x.kind === "blackhole")!
      offsets.add(Math.round(Math.hypot(h.x, h.y)))
    }
    expect(offsets.size).toBeGreaterThan(3)
  })

  it("wormholes: linked pair wh-a/wh-b, in the orbit band, clear of wells, far apart", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const w = createWorld({ seed, difficulty: "normal" })
      expect(w.wormholes.map((x) => x.id)).toEqual(["wh-a", "wh-b"])
      const [a, b] = w.wormholes
      expect(a.linkId).toBe("wh-b")
      expect(b.linkId).toBe("wh-a")
      for (const wh of w.wormholes) {
        expect(wh.radius).toBe(CONFIG.wormhole.radius)
        const d = Math.hypot(wh.x, wh.y)
        expect(d, `seed ${seed} ${wh.id} orbit`).toBeGreaterThanOrEqual(CONFIG.wormhole.orbit[0] - 1e-9)
        expect(d, `seed ${seed} ${wh.id} orbit`).toBeLessThanOrEqual(CONFIG.wormhole.orbit[1] + 1e-9)
        for (const well of w.wells) {
          expect(dist(wh, well), `seed ${seed} ${wh.id} vs ${well.id}`).toBeGreaterThanOrEqual(
            CONFIG.wormhole.wellClearance - 1e-9,
          )
        }
      }
      expect(dist(a, b), `seed ${seed} separation`).toBeGreaterThanOrEqual(CONFIG.wormhole.minSeparation - 1e-9)
    }
  })

  it("debris: counts, bounds, well clearance, unique ids, mass ranges, at rest", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const w = createWorld({ seed, difficulty: "normal" })
      const loose = w.debris.filter((d) => d.kind !== "crystal")
      const crystals = w.debris.filter((d) => d.kind === "crystal")
      expect(loose, `seed ${seed}`).toHaveLength(CONFIG.debris.target)
      expect(crystals, `seed ${seed}`).toHaveLength(CONFIG.crystal.target)
      const ids = new Set<number>()
      for (const d of w.debris) {
        expect(Math.hypot(d.x, d.y)).toBeLessThanOrEqual(w.arenaRadius + 1e-9)
        for (const well of w.wells) {
          expect(dist(d, well), `seed ${seed} debris ${d.id} vs ${well.id}`).toBeGreaterThanOrEqual(
            well.radius + CONFIG.debris.wellClearance - 1e-9,
          )
        }
        expect(d.id).toBeGreaterThanOrEqual(1)
        expect(d.id).toBeLessThan(w.nextDebrisId)
        ids.add(d.id)
        expect(d.vx).toBe(0)
        expect(d.vy).toBe(0)
        expect(d.px).toBe(d.x)
        expect(d.py).toBe(d.y)
        expectClose(d.radius, radiusForMass(d.mass), 1e-12, "debris radius")
        if (d.kind === "dust") {
          expect(d.mass).toBeGreaterThanOrEqual(CONFIG.debris.dustMass[0] - 1e-9)
          expect(d.mass).toBeLessThanOrEqual(CONFIG.debris.dustMass[1] + 1e-9)
        } else if (d.kind === "rock") {
          expect(d.mass).toBeGreaterThanOrEqual(CONFIG.debris.rockMass[0] - 1e-9)
          expect(d.mass).toBeLessThanOrEqual(CONFIG.debris.rockMass[1] + 1e-9)
        } else {
          expect(d.mass).toBe(CONFIG.crystal.mass)
        }
      }
      expect(ids.size).toBe(w.debris.length)
    }
  })

  it("debris is spread uniformly over the disc (radius sqrt-distributed) with about rockShare rocks", () => {
    let sumR2 = 0
    let n = 0
    let rocks = 0
    let loose = 0
    for (const seed of [1, 2, 3, 4, 5]) {
      const w = createWorld({ seed, difficulty: "normal" })
      for (const d of w.debris) {
        sumR2 += (Math.hypot(d.x, d.y) / w.arenaRadius) ** 2
        n++
        if (d.kind !== "crystal") {
          loose++
          if (d.kind === "rock") rocks++
        }
      }
    }
    // Uniform over a disc: E[(r/R)^2] = 0.5. A uniform-in-radius draw would give 1/3.
    expect(sumR2 / n).toBeGreaterThan(0.43)
    expect(sumR2 / n).toBeLessThan(0.57)
    expect(Math.abs(rocks / loose - CONFIG.debris.rockShare)).toBeLessThan(0.06)
  })
})

// ---------------------------------------------------------------------------------------------
describe("3. countdown", () => {
  it("nothing moves, one phase event, playing after countdown/dt (+1) steps, tick counts every step", () => {
    const w = createWorld({ seed: 5, difficulty: "normal" })
    const initialBodies = JSON.stringify(w.bodies)
    const initialDebris = JSON.stringify(w.debris)
    const pushing: Record<string, Intent> = { player: intent(1, 0, true), "bot-1": intent(0, -1, true) }
    let steps = 0
    let phaseEvents: GameEvent[] = []
    while (w.phase === "countdown" && steps < 400) {
      step(w, pushing)
      steps++
      expect(w.tick).toBe(steps)
      phaseEvents = phaseEvents.concat(w.events.filter((e) => e.type === "phase"))
      if (w.phase === "countdown") expect(w.events).toEqual([])
    }
    const expected = Math.round(CONFIG.round.countdown / DT)
    expect(steps).toBeGreaterThanOrEqual(expected)
    expect(steps).toBeLessThanOrEqual(expected + 1)
    expect(w.phase).toBe("playing")
    expect(w.countdown).toBe(0)
    expect(phaseEvents).toEqual([{ type: "phase", phase: "playing" }])
    expect(w.events).toEqual([{ type: "phase", phase: "playing" }])
    // Nothing moved, including on the step that ended the countdown.
    expect(JSON.stringify(w.bodies)).toBe(initialBodies)
    expect(JSON.stringify(w.debris)).toBe(initialDebris)
    expect(w.time).toBe(0)
    expect(w.timeLeft).toBe(CONFIG.round.duration)
    // The very next step is a normal playing step: thrust now takes effect.
    step(w, pushing)
    expect(w.bodies[0].vx).toBeGreaterThan(0)
    expect(w.time).toBeCloseTo(DT, 12)
    expect(w.tick).toBe(steps + 1)
    expect(eventsOf(w, "phase")).toHaveLength(0)
  })

  it("countdown keeps px/py equal to x/y", () => {
    const w = createWorld({ seed: 6, difficulty: "easy" })
    w.bodies[0].px = -1
    w.debris[0].px = -1
    step(w, {})
    expect(w.bodies[0].px).toBe(w.bodies[0].x)
    expect(w.debris[0].px).toBe(w.debris[0].x)
  })
})

// ---------------------------------------------------------------------------------------------
describe("4. thrust from rest", () => {
  function playerAfterOneStep(i: Intent, mass?: number) {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    if (mass !== undefined) setMass(w.bodies[0], mass)
    step(w, { player: i })
    return w.bodies[0]
  }

  it("ax=1: vx = thrustAccel(m)*dt*exp(-drag*dt), x advances by vx*dt", () => {
    const b = playerAfterOneStep(intent(1, 0))
    const expected = thrustAccel(CONFIG.body.startMass) * DT * DRAG
    expectClose(b.vx, expected, 1e-9, "vx")
    expectClose(b.vy, 0, 1e-12, "vy")
    expectClose(b.x, b.vx * DT, 1e-9, "x")
    expect(b.px).toBe(0)
    expect(b.py).toBe(0)
    expect(b.thrusting).toBe(true)
  })

  it("intent length is clamped to 1 (ax=10 equals ax=1, (3,4) equals (0.6,0.8))", () => {
    const one = playerAfterOneStep(intent(1, 0))
    const ten = playerAfterOneStep(intent(10, 0))
    expectClose(ten.vx, one.vx, 1e-12)
    const diag = playerAfterOneStep(intent(3, 4))
    const unit = thrustAccel(CONFIG.body.startMass) * DT * DRAG
    expectClose(diag.vx, 0.6 * unit, 1e-9, "vx")
    expectClose(diag.vy, 0.8 * unit, 1e-9, "vy")
  })

  it("shorter intents scale thrust linearly (not clamped up)", () => {
    const half = playerAfterOneStep(intent(0.5, 0))
    expectClose(half.vx, 0.5 * thrustAccel(CONFIG.body.startMass) * DT * DRAG, 1e-9)
  })

  it("heavier bodies accelerate less, following thrustAccel(mass)", () => {
    const heavy = playerAfterOneStep(intent(1, 0), 40)
    expectClose(heavy.vx, thrustAccel(40) * DT * DRAG, 1e-9)
    expect(heavy.vx).toBeLessThan(playerAfterOneStep(intent(1, 0)).vx)
  })

  it("NaN and Infinity components count as 0", () => {
    const nan = playerAfterOneStep(intent(Number.NaN, Number.NaN, false))
    expect(nan.vx).toBe(0)
    expect(nan.vy).toBe(0)
    expect(nan.thrusting).toBe(false)
    const mixed = playerAfterOneStep(intent(Number.POSITIVE_INFINITY, 1))
    const up = playerAfterOneStep(intent(0, 1))
    expectClose(mixed.vx, 0, 1e-12)
    expectClose(mixed.vy, up.vy, 1e-12)
    const negInf = playerAfterOneStep(intent(Number.NEGATIVE_INFINITY, Number.NaN))
    expect(negInf.vx).toBe(0)
    expect(negInf.vy).toBe(0)
  })

  it("intents shorter than thrustDeadzone do not thrust; longer ones do", () => {
    const below = playerAfterOneStep(intent(CONFIG.body.thrustDeadzone * 0.5, 0))
    expect(below.thrusting).toBe(false)
    expect(below.vx).toBe(0)
    const above = playerAfterOneStep(intent(CONFIG.body.thrustDeadzone * 2, 0))
    expect(above.thrusting).toBe(true)
    expect(above.vx).toBeGreaterThan(0)
  })

  it("a missing intent means NO_INTENT; an explicit NO_INTENT matches; unknown ids are ignored", () => {
    const a = controlledWorld({ botCount: 1 })
    const b = controlledWorld({ botCount: 1 })
    const c = controlledWorld({ botCount: 1 })
    step(a, {})
    step(b, { player: NO_INTENT, "bot-1": NO_INTENT })
    step(c, { ghost: intent(1, 1, true) })
    expect(snapshot(a)).toBe(snapshot(b))
    expect(snapshot(a)).toBe(snapshot(c))
    expect(a.bodies[0].vx).toBe(0)
  })

  it("intents for dead bodies are ignored", () => {
    const w = controlledWorld({ botCount: 2 })
    placeBody(w, 1, 0, 0)
    w.bodies[1].alive = false
    const energy = w.bodies[1].energy
    step(w, { "bot-1": intent(1, 0, true) })
    expect(w.bodies[1].x).toBe(0)
    expect(w.bodies[1].vx).toBe(0)
    expect(w.bodies[1].alive).toBe(false)
    expect(w.bodies[1].energy).toBe(energy)
    expect(w.phase).toBe("playing")
  })

  it("Map and plain-object intents produce identical worlds", () => {
    const scripted = (tick: number, id: string): Intent => {
      const k = id === "player" ? 0 : 1 + Number(id.slice(4))
      return intent(Math.cos(tick * 0.05 + k), Math.sin(tick * 0.05 + k), Math.floor(tick / 30 + k) % 2 === 0)
    }
    const a = createWorld({ seed: 21, difficulty: "normal" })
    const b = createWorld({ seed: 21, difficulty: "normal" })
    for (let i = 0; i < 181 + 150; i++) {
      const obj: Record<string, Intent> = {}
      const map = new Map<string, Intent>()
      for (const body of a.bodies) {
        const it = scripted(i, body.id)
        obj[body.id] = it
        map.set(body.id, it)
      }
      step(a, obj)
      step(b, map)
    }
    expect(snapshot(a)).toBe(snapshot(b))
    expect(a.tick).toBeGreaterThan(300)
  })

  it("px/py hold the position at the start of the step", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 10, -20, 100, 50)
    makeDebris(w, "dust", 500, 500)
    w.debris[0].vx = 30
    step(w, {})
    expect(w.bodies[0].px).toBe(10)
    expect(w.bodies[0].py).toBe(-20)
    expect(w.bodies[0].x).toBeGreaterThan(10)
    expect(w.debris[0].px).toBe(500)
    expect(w.debris[0].py).toBe(500)
    expect(w.debris[0].x).toBeGreaterThan(500)
  })
})

// ---------------------------------------------------------------------------------------------
describe("5. speed limit", () => {
  it("600 steps of changing full thrust never exceed maxSpeed(mass)", () => {
    for (const mass of [CONFIG.body.startMass, 25, 60]) {
      const w = controlledWorld({ botCount: 1 })
      placeBody(w, 0, 0, 0)
      setMass(w.bodies[0], mass)
      w.bodies[0].energy = CONFIG.energy.max
      let top = 0
      for (let i = 0; i < 600; i++) {
        const a = i * 0.02
        step(w, { player: intent(Math.cos(a), Math.sin(a)) })
        const b = w.bodies[0]
        const speed = Math.hypot(b.vx, b.vy)
        top = Math.max(top, speed)
        expect(speed, `mass ${mass} step ${i}`).toBeLessThanOrEqual(maxSpeed(b.mass) + 1e-6)
      }
      expect(top, `mass ${mass} should get close to top speed`).toBeGreaterThan(0.5 * maxSpeed(mass))
    }
  })

  it("straight-line thrust settles at or below maxSpeed", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, -1000, 0)
    for (let i = 0; i < 200; i++) {
      step(w, { player: intent(1, 0) })
      expect(Math.hypot(w.bodies[0].vx, w.bodies[0].vy)).toBeLessThanOrEqual(maxSpeed(w.bodies[0].mass) + 1e-6)
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe("6. gravity", () => {
  it("a star pulls a body at rest with gm/(d^2+soft^2)", () => {
    const w = controlledWorld({ botCount: 1 })
    const d = CONFIG.well.starChargeRadius + 200
    const angle = 0.7
    placeBody(w, 0, 0, 0)
    addWell(w, "star", Math.cos(angle) * d, Math.sin(angle) * d)
    step(w, {})
    const b = w.bodies[0]
    const expected = (CONFIG.well.starGm / (d * d + CONFIG.well.soft ** 2)) * DT * DRAG
    expectClose(Math.hypot(b.vx, b.vy), expected, 1e-9, "|v|")
    expectClose(b.vx, Math.cos(angle) * expected, 1e-9, "vx points at the star")
    expectClose(b.vy, Math.sin(angle) * expected, 1e-9, "vy points at the star")
  })

  it("softening matters at close range (black hole at 150 u)", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    addWell(w, "blackhole", 150, 0)
    step(w, {})
    const expected = (CONFIG.well.holeGm / (150 * 150 + CONFIG.well.soft ** 2)) * DT * DRAG
    expectClose(w.bodies[0].vx, expected, 1e-9, "vx")
    expectClose(w.bodies[0].vy, 0, 1e-12, "vy")
  })

  it("gravity is the sum over all wells (opposed pulls cancel)", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    addWell(w, "blackhole", 600, 0)
    addWell(w, "blackhole", -600, 0)
    step(w, {})
    expectClose(w.bodies[0].vx, 0, 1e-9)
    const w2 = controlledWorld({ botCount: 1 })
    placeBody(w2, 0, 0, 0)
    addWell(w2, "blackhole", 0, 700)
    addWell(w2, "blackhole", 0, -700)
    step(w2, {})
    expectClose(w2.bodies[0].vy, 0, 1e-9)
    const w3 = controlledWorld({ botCount: 1 })
    placeBody(w3, 0, 0, 0)
    addWell(w3, "blackhole", 600, 0)
    addWell(w3, "blackhole", 0, 600)
    step(w3, {})
    const each = (CONFIG.well.holeGm / (600 * 600 + CONFIG.well.soft ** 2)) * DT * DRAG
    expectClose(w3.bodies[0].vx, each, 1e-9, "vx")
    expectClose(w3.bodies[0].vy, each, 1e-9, "vy")
  })

  it("debris feels the same gravity and its own drag", () => {
    const w = controlledWorld({ botCount: 1 })
    addWell(w, "star", 0, 0)
    const d = makeDebris(w, "dust", 500, 0)
    step(w, {})
    const expected = (CONFIG.well.starGm / (500 * 500 + CONFIG.well.soft ** 2)) * DT * DEBRIS_DRAG
    expectClose(d.vx, -expected, 1e-9, "debris vx")
    expectClose(d.vy, 0, 1e-12)
  })

  it("free debris loses speed to drag by exp(-debrisDrag*dt) per step", () => {
    const w = controlledWorld({ botCount: 1 })
    const d = makeDebris(w, "rock", 300, 300)
    d.vx = 40
    d.vy = -25
    step(w, {})
    expectClose(d.vx, 40 * DEBRIS_DRAG, 1e-12)
    expectClose(d.vy, -25 * DEBRIS_DRAG, 1e-12)
    expectClose(d.x, 300 + d.vx * DT, 1e-12)
  })

  it("debris pushed past the arena edge is put back on the boundary and reflected", () => {
    const w = controlledWorld({ botCount: 1 })
    const d = makeDebris(w, "dust", w.arenaRadius - 0.5, 0)
    d.vx = 200
    step(w, {})
    expect(Math.hypot(d.x, d.y)).toBeLessThanOrEqual(w.arenaRadius + 1e-9)
    expect(d.vx).toBeLessThan(0)
  })

  it("debris whose centre ends inside a well is removed silently", () => {
    const w = controlledWorld({ botCount: 1 })
    addWell(w, "star", 0, 0)
    makeDebris(w, "dust", 0, 0)
    makeDebris(w, "dust", 10, 0)
    const far = makeDebris(w, "dust", 800, 0)
    step(w, {})
    expect(w.debris.map((x) => x.id)).toEqual([far.id])
    expect(eventsOf(w, "eat")).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("7. energy", () => {
  it("60 steps of full thrust cost (thrustCost - regen) per second", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    for (let i = 0; i < 60; i++) step(w, { player: intent(i < 30 ? 1 : -1, 0) })
    const expected = CONFIG.energy.max - (CONFIG.energy.thrustCost - CONFIG.energy.regen) * 1
    expectClose(w.bodies[0].energy, expected, 1e-6, "energy after 1 s")
  })

  it("thrust cost scales with intent magnitude", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    for (let i = 0; i < 60; i++) step(w, { player: intent(i < 30 ? 0.5 : -0.5, 0) })
    const expected = CONFIG.energy.max - (CONFIG.energy.thrustCost * 0.5 - CONFIG.energy.regen)
    expectClose(w.bodies[0].energy, expected, 1e-6, "energy after 1 s at half thrust")
  })

  it("idle energy stays clamped at max (regen never overflows)", () => {
    const w = controlledWorld({ botCount: 1 })
    stepN(w, 30)
    expect(w.bodies[0].energy).toBe(CONFIG.energy.max)
    w.bodies[0].energy = CONFIG.energy.max - CONFIG.energy.regen * DT * 0.5
    step(w, {})
    expect(w.bodies[0].energy).toBe(CONFIG.energy.max)
  })

  it("pull drains pullCost per second (net of regen) and sets the pulling flag", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    step(w, { player: intent(0, 0, true) })
    expect(w.bodies[0].pulling).toBe(true)
    stepN(w, 59, { player: intent(0, 0, true) })
    const expected = CONFIG.energy.max - (CONFIG.energy.pullCost - CONFIG.energy.regen) * 1
    expectClose(w.bodies[0].energy, expected, 1e-6, "energy after 1 s of pull")
    step(w, {})
    expect(w.bodies[0].pulling).toBe(false)
  })

  it("at zero energy a body neither thrusts nor pulls", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    w.bodies[0].energy = 0
    const d = makeDebris(w, "dust", 60, 0)
    step(w, { player: intent(1, 0, true) })
    const b = w.bodies[0]
    expect(b.thrusting).toBe(false)
    expect(b.pulling).toBe(false)
    expect(b.vx).toBe(0)
    expect(b.vy).toBe(0)
    expect(d.vx).toBe(0)
    // Regeneration still runs.
    expectClose(b.energy, CONFIG.energy.regen * DT, 1e-12, "regen from empty")
  })

  it("lowEnergy fires exactly once when crossing lowThreshold, none when starting below", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    w.bodies[0].energy = CONFIG.energy.lowThreshold + 1
    let lows = 0
    let stepsToFire = -1
    for (let i = 0; i < 120; i++) {
      step(w, { player: intent(Math.cos(i * 0.05), Math.sin(i * 0.05), true) })
      const evs = eventsOf(w, "lowEnergy")
      if (evs.length && stepsToFire < 0) stepsToFire = i
      for (const e of evs) expect(e.bodyId).toBe("player")
      lows += evs.length
    }
    expect(lows).toBe(1)
    expect(stepsToFire).toBeGreaterThanOrEqual(0)

    const below = controlledWorld({ botCount: 1 })
    placeBody(below, 0, 0, 0)
    below.bodies[0].energy = CONFIG.energy.lowThreshold - 5
    let n = 0
    for (let i = 0; i < 60; i++) {
      step(below, { player: intent(Math.cos(i * 0.05), Math.sin(i * 0.05)) })
      n += eventsOf(below, "lowEnergy").length
    }
    expect(n).toBe(0)
  })

  it("a body inside a star's charge band is charging and gains energy; outside it is not", () => {
    const w = controlledWorld({ botCount: 1 })
    const star = addWell(w, "star", 0, 0)
    const d = star.radius + 20
    placeBody(w, 0, d, 0)
    w.bodies[0].energy = 50
    step(w, {})
    const b = w.bodies[0]
    expect(b.charging).toBe(true)
    const rate = CONFIG.well.starChargeRate * (1 - (d - star.radius) / (star.chargeRadius - star.radius))
    expectClose(b.energy, 50 + (CONFIG.energy.regen + rate) * DT, 1e-6, "charged energy")
    expect(b.energy).toBeGreaterThan(50 + CONFIG.energy.regen * DT)

    const out = controlledWorld({ botCount: 1 })
    const s2 = addWell(out, "star", 0, 0)
    placeBody(out, 0, s2.chargeRadius + 50, 0)
    out.bodies[0].energy = 50
    step(out, {})
    expect(out.bodies[0].charging).toBe(false)
    expectClose(out.bodies[0].energy, 50 + CONFIG.energy.regen * DT, 1e-9, "no charge outside the band")
  })

  it("charging is strongest at the surface and fades towards the edge of the band", () => {
    const gains: number[] = []
    for (const frac of [0.1, 0.5, 0.9]) {
      const w = controlledWorld({ botCount: 1 })
      const star = addWell(w, "star", 0, 0)
      placeBody(w, 0, star.radius + frac * (star.chargeRadius - star.radius), 0)
      w.bodies[0].energy = 20
      step(w, {})
      gains.push(w.bodies[0].energy - 20)
    }
    expect(gains[0]).toBeGreaterThan(gains[1])
    expect(gains[1]).toBeGreaterThan(gains[2])
  })

  it("black holes never charge", () => {
    const w = controlledWorld({ botCount: 1 })
    addWell(w, "blackhole", 0, 0)
    placeBody(w, 0, CONFIG.well.holeRadius + 60, 0)
    w.bodies[0].energy = 50
    step(w, {})
    expect(w.bodies[0].charging).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe("8. arena wall", () => {
  it("a body past the wall moving outward is pushed back in", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, w.arenaRadius + 50, 0, 100, 0)
    step(w, {})
    const dragOnly = 100 * DRAG
    expect(w.bodies[0].vx).toBeLessThan(dragOnly - 1)
    expectClose(w.bodies[0].vy, 0, 1e-9, "vy stays radial")
  })

  it("a deeper penetration is pushed back harder", () => {
    const kick = (extra: number) => {
      const w = controlledWorld({ botCount: 1 })
      placeBody(w, 0, w.arenaRadius + extra, 0, 0, 0)
      step(w, {})
      return -w.bodies[0].vx
    }
    expect(kick(20)).toBeGreaterThan(0)
    expect(kick(80)).toBeGreaterThan(kick(20))
  })

  it("works in any direction (radial, towards the centre)", () => {
    const w = controlledWorld({ botCount: 1 })
    const a = 2.1
    placeBody(w, 0, Math.cos(a) * (w.arenaRadius + 40), Math.sin(a) * (w.arenaRadius + 40))
    step(w, {})
    const b = w.bodies[0]
    expect(b.vx * Math.cos(a) + b.vy * Math.sin(a)).toBeLessThan(0)
    expectClose(-b.vx * Math.sin(a) + b.vy * Math.cos(a), 0, 1e-9, "no tangential kick")
  })

  it("well inside the arena there is no wall force", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, w.arenaRadius - 300, 0, 100, 0)
    step(w, {})
    expectClose(w.bodies[0].vx, 100 * DRAG, 1e-9)
  })
})

// ---------------------------------------------------------------------------------------------
describe("9. eating", () => {
  it("dust at the centre: mass grows, radius follows, piece removed, eat event, stats", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    const dust = makeDebris(w, "dust", 0, 0, 1)
    const id = dust.id
    step(w, {})
    const b = w.bodies[0]
    expectClose(b.mass, CONFIG.body.startMass + 1, 1e-12, "mass")
    expectClose(b.radius, radiusForMass(b.mass), 1e-12, "radius")
    expect(w.debris.find((x) => x.id === id)).toBeUndefined()
    expect(w.debris).toHaveLength(0)
    const eats = eventsOf(w, "eat")
    expect(eats).toHaveLength(1)
    expect(eats[0]).toMatchObject({ type: "eat", bodyId: "player", kind: "dust", mass: 1 })
    expectClose(eats[0].x, 0, 1e-9)
    expect(b.stats.debrisEaten).toBe(1)
    expect(b.stats.crystals).toBe(0)
    expectClose(b.stats.peakMass, b.mass, 1e-12, "peakMass")
  })

  it("rock counts as debris and gives its mass", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    makeDebris(w, "rock", 3, 0, 3)
    step(w, {})
    expectClose(w.bodies[0].mass, CONFIG.body.startMass + 3, 1e-12)
    expect(w.bodies[0].stats.debrisEaten).toBe(1)
    expect(eventsOf(w, "eat")[0].kind).toBe("rock")
  })

  it("crystal: energy bonus (clamped), crystal mass, stats.crystals", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    w.bodies[0].energy = 50
    makeDebris(w, "crystal", 0, 0)
    step(w, {})
    const b = w.bodies[0]
    expect(b.energy).toBeGreaterThanOrEqual(50 + CONFIG.crystal.energy - 1e-9)
    expect(b.energy).toBeLessThanOrEqual(50 + CONFIG.crystal.energy + CONFIG.energy.regen * DT + 1e-6)
    expectClose(b.mass, CONFIG.body.startMass + CONFIG.crystal.mass, 1e-12)
    expect(b.stats.crystals).toBe(1)
    expect(b.stats.debrisEaten).toBe(0)
    expect(eventsOf(w, "eat")[0].kind).toBe("crystal")

    const full = controlledWorld({ botCount: 1 })
    placeBody(full, 0, 0, 0)
    full.bodies[0].energy = CONFIG.energy.max - 5
    makeDebris(full, "crystal", 0, 0)
    step(full, {})
    expect(full.bodies[0].energy).toBe(CONFIG.energy.max)
  })

  it("debris outside the body radius is left alone", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    makeDebris(w, "dust", w.bodies[0].radius + 2, 0, 1)
    step(w, {})
    expect(w.debris).toHaveLength(1)
    expect(eventsOf(w, "eat")).toHaveLength(0)
    expect(w.bodies[0].mass).toBe(CONFIG.body.startMass)
  })

  it("a piece overlapping two bodies is eaten once, by the lower index", () => {
    const w = controlledWorld({ botCount: 2 })
    placeBody(w, 0, 0, 0)
    placeBody(w, 1, 10, 0)
    setMass(w.bodies[0], CONFIG.body.startMass)
    setMass(w.bodies[1], CONFIG.body.startMass)
    makeDebris(w, "dust", 5, 0, 0.1)
    step(w, {})
    const eats = eventsOf(w, "eat")
    expect(eats).toHaveLength(1)
    expect(eats[0].bodyId).toBe("player")
    expectClose(w.bodies[0].mass, CONFIG.body.startMass + 0.1, 1e-12)
    expect(w.bodies[1].mass).toBe(CONFIG.body.startMass)
    expect(w.bodies[0].stats.debrisEaten).toBe(1)
    expect(w.bodies[1].stats.debrisEaten).toBe(0)
    expect(w.debris).toHaveLength(0)
  })

  it("every piece under the body is eaten in one step", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    for (let i = 0; i < 5; i++) makeDebris(w, "dust", i - 2, 0, 0.5)
    step(w, {})
    expect(eventsOf(w, "eat")).toHaveLength(5)
    expect(w.bodies[0].stats.debrisEaten).toBe(5)
    expectClose(w.bodies[0].mass, CONFIG.body.startMass + 2.5, 1e-12)
  })

  it("dead bodies do not eat", () => {
    const w = controlledWorld({ botCount: 2 })
    placeBody(w, 1, 0, 0)
    w.bodies[1].alive = false
    makeDebris(w, "dust", 0, 0)
    step(w, {})
    expect(w.debris).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------
describe("10. absorb", () => {
  function pair(bigMass: number, smallMass: number, d: number, bigIdx = 0, smallIdx = 1) {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[bigIdx], bigMass)
    setMass(w.bodies[smallIdx], smallMass)
    placeBody(w, bigIdx, 0, 0)
    placeBody(w, smallIdx, d, 0)
    return w
  }

  it("deep overlap: the big body absorbs the small one", () => {
    const w = pair(30, 10, 2)
    w.bodies[0].energy = 20
    w.bodies[1].energy = 40
    step(w, {})
    const [big, small] = w.bodies
    expect(small.alive).toBe(false)
    expect(big.alive).toBe(true)
    expectClose(big.mass, 30 + 10 * CONFIG.absorb.massGain, 1e-9, "big mass")
    expectClose(big.radius, radiusForMass(big.mass), 1e-12)
    expect(Math.abs(big.energy - (20 + 40 * CONFIG.absorb.energyGain))).toBeLessThan(0.1)
    expect(big.stats.rivalsAbsorbed).toBe(1)
    const absorbAt = w.events.findIndex((e) => e.type === "absorb")
    const deathAt = w.events.findIndex((e) => e.type === "death")
    expect(absorbAt).toBeGreaterThanOrEqual(0)
    expect(deathAt).toBeGreaterThan(absorbAt)
    expect(w.events[absorbAt]).toMatchObject({ type: "absorb", eaterId: "player", victimId: "bot-1" })
    expect(w.events[deathAt]).toMatchObject({
      type: "death",
      bodyId: "bot-1",
      cause: { by: "body", killerId: "player" },
    })
    expect(w.phase).toBe("playing")
  })

  it("the absorb event reports the mass gained", () => {
    const w = pair(30, 10, 2)
    step(w, {})
    const ev = eventsOf(w, "absorb")[0]
    expectClose(ev.mass, 10 * CONFIG.absorb.massGain, 1e-9, "absorb event mass")
  })

  it("the heavier body wins regardless of array order (bot absorbs bot)", () => {
    const w = pair(30, 10, 2, 2, 1)
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
    expect(w.bodies[2].alive).toBe(true)
    expect(w.bodies[2].stats.rivalsAbsorbed).toBe(1)
    expect(eventsOf(w, "death")[0].cause).toEqual({ by: "body", killerId: "bot-2" })
  })

  it("overlapping but not deep enough yet: nothing happens", () => {
    const bigR = radiusForMass(30)
    const smallR = radiusForMass(10)
    const deepLimit = bigR - smallR * CONFIG.absorb.overlap
    const d = (deepLimit + bigR + smallR) / 2
    expect(d).toBeGreaterThan(deepLimit)
    expect(d).toBeLessThan(bigR + smallR)
    const w = pair(30, 10, d)
    step(w, {})
    expect(w.bodies[0].alive).toBe(true)
    expect(w.bodies[1].alive).toBe(true)
    expect(eventsOf(w, "absorb")).toHaveLength(0)
    expect(w.bodies[1].x).toBe(d)
    expect(w.bodies[0].x).toBe(0)
    expect(w.bodies[0].mass).toBe(30)
  })

  it("a mass ratio below absorb.ratio cannot absorb: bodies bounce apart instead", () => {
    const w = pair(10 * CONFIG.absorb.ratio * 0.99, 10, 2)
    step(w, {})
    expect(w.bodies[0].alive).toBe(true)
    expect(w.bodies[1].alive).toBe(true)
    expect(dist(w.bodies[0], w.bodies[1])).toBeGreaterThanOrEqual(w.bodies[0].radius + w.bodies[1].radius - 1e-6)
  })

  it("shielded small body: no absorb, they end up separated, centre of mass preserved", () => {
    const w = pair(30, 10, 2)
    w.bodies[1].shield = 1
    const com = (30 * 0 + 10 * 2) / 40
    step(w, {})
    const [big, small] = w.bodies
    expect(big.alive).toBe(true)
    expect(small.alive).toBe(true)
    expect(eventsOf(w, "absorb")).toHaveLength(0)
    expect(dist(big, small)).toBeGreaterThanOrEqual(big.radius + small.radius - 1e-6)
    expectClose((big.mass * big.x + small.mass * small.x) / (big.mass + small.mass), com, 1e-9, "centre of mass")
    // The lighter body is displaced further than the heavier one.
    expect(Math.abs(small.x - 2)).toBeGreaterThan(Math.abs(big.x - 0))
  })

  it("shielded big body: no absorb either", () => {
    const w = pair(30, 10, 2)
    w.bodies[0].shield = 1
    step(w, {})
    expect(w.bodies[1].alive).toBe(true)
    expect(eventsOf(w, "absorb")).toHaveLength(0)
    expect(dist(w.bodies[0], w.bodies[1])).toBeGreaterThanOrEqual(w.bodies[0].radius + w.bodies[1].radius - 1e-6)
  })

  it("shield counts down by dt per step and never goes negative", () => {
    const w = controlledWorld({ botCount: 1 })
    w.bodies[0].shield = 1.5 * DT
    step(w, {})
    expectClose(w.bodies[0].shield, 0.5 * DT, 1e-12)
    step(w, {})
    expect(w.bodies[0].shield).toBe(0)
    step(w, {})
    expect(w.bodies[0].shield).toBe(0)
  })

  it("absorbed player ends the round with a body cause", () => {
    const w = pair(30, 10, 2, 1, 0)
    step(w, {})
    expect(w.phase).toBe("over")
    expect(w.result?.reason).toBe("playerDied")
    expect(w.result?.playerWon).toBe(false)
    expect(w.result?.playerCause).toEqual({ by: "body", killerId: "bot-1" })
    expect(w.result?.winnerId).toBe("bot-1")
  })
})

// ---------------------------------------------------------------------------------------------
describe("11. bounce", () => {
  function collide(m0: number, m1: number, v0: [number, number], v1: [number, number], d = 20) {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[0], m0)
    setMass(w.bodies[1], m1)
    placeBody(w, 0, 0, 0, v0[0], v0[1])
    placeBody(w, 1, d, 0, v1[0], v1[1])
    const before = momentum(w)
    step(w, {})
    return { w, before }
  }

  it("equal masses: separated afterwards and momentum is conserved (up to drag)", () => {
    const { w, before } = collide(10, 10, [80, 10], [-20, -5])
    const [a, b] = w.bodies
    expect(dist(a, b)).toBeGreaterThanOrEqual(a.radius + b.radius - 1e-6)
    const after = momentum(w)
    expectClose(after.x, before.x * DRAG, 1e-9, "px")
    expectClose(after.y, before.y * DRAG, 1e-9, "py")
    expect(a.alive && b.alive).toBe(true)
    // They were approaching, so now they are no longer closing.
    expect((b.vx - a.vx) * (b.x - a.x) + (b.vy - a.vy) * (b.y - a.y)).toBeGreaterThanOrEqual(-1e-9)
  })

  it("unequal masses within the absorb ratio also conserve momentum", () => {
    const m1 = 10 * Math.min(1.05, CONFIG.absorb.ratio)
    const { w, before } = collide(10, m1, [120, -30], [-60, 40])
    const after = momentum(w)
    expectClose(after.x, before.x * DRAG, 1e-9, "px")
    expectClose(after.y, before.y * DRAG, 1e-9, "py")
    expect(dist(w.bodies[0], w.bodies[1])).toBeGreaterThanOrEqual(w.bodies[0].radius + w.bodies[1].radius - 1e-6)
  })

  it("restitution: head-on equal masses swap velocities scaled by the restitution", () => {
    const v = 100
    const { w } = collide(10, 10, [v, 0], [-v, 0])
    const e = CONFIG.absorb.restitution
    expectClose(w.bodies[0].vx, -e * v * DRAG, 1e-9, "left body rebounds")
    expectClose(w.bodies[1].vx, e * v * DRAG, 1e-9, "right body rebounds")
  })

  it("a hard hit emits a bounce event, a soft one does not", () => {
    const e = CONFIG.absorb.restitution
    const minEv = CONFIG.absorb.bounceEventMin
    const hard = (2 * minEv) / (1 + e) // each body moves at this speed: closing speed is 2x, 2x margin on the threshold
    const fast = collide(10, 10, [hard, 0], [-hard, 0]).w
    const bounces = eventsOf(fast, "bounce")
    expect(bounces).toHaveLength(1)
    expect(bounces[0].impulse).toBeGreaterThan(0)
    expect([bounces[0].aId, bounces[0].bId].sort()).toEqual(["bot-1", "player"])
    const soft = collide(10, 10, [(0.25 * minEv) / (1 + e), 0], [(-0.25 * minEv) / (1 + e), 0]).w
    expect(eventsOf(soft, "bounce")).toHaveLength(0)
    expect(dist(soft.bodies[0], soft.bodies[1])).toBeGreaterThanOrEqual(soft.bodies[0].radius + soft.bodies[1].radius - 1e-6)
  })

  it("bodies that overlap while moving apart are separated but get no extra impulse", () => {
    const { w } = collide(10, 10, [-30, 0], [30, 0])
    expectClose(w.bodies[0].vx, -30 * DRAG, 1e-9)
    expectClose(w.bodies[1].vx, 30 * DRAG, 1e-9)
    expect(eventsOf(w, "bounce")).toHaveLength(0)
    expect(dist(w.bodies[0], w.bodies[1])).toBeGreaterThanOrEqual(w.bodies[0].radius + w.bodies[1].radius - 1e-6)
  })

  it("coincident bodies (d = 0) are still pushed apart without NaN", () => {
    const w = controlledWorld({ botCount: 2 })
    placeBody(w, 0, 100, 100)
    placeBody(w, 1, 100, 100)
    setMass(w.bodies[0], 10)
    setMass(w.bodies[1], 10)
    step(w, {})
    for (const b of w.bodies) {
      expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true)
    }
    expect(dist(w.bodies[0], w.bodies[1])).toBeGreaterThanOrEqual(w.bodies[0].radius + w.bodies[1].radius - 1e-6)
  })
})

// ---------------------------------------------------------------------------------------------
describe("12. wells kill", () => {
  it("a body at a star's centre dies with {by: star}; for the player the round ends", () => {
    const w = controlledWorld({ botCount: 2 })
    addWell(w, "star", 0, 0)
    placeBody(w, 0, 0, 0)
    step(w, {})
    expect(w.bodies[0].alive).toBe(false)
    expect(eventsOf(w, "death")[0]).toMatchObject({ bodyId: "player", cause: { by: "star" } })
    expect(w.phase).toBe("over")
    expect(w.result?.reason).toBe("playerDied")
    expect(w.result?.playerCause).toEqual({ by: "star" })
    expect(w.result?.playerWon).toBe(false)
    expect(eventsOf(w, "roundEnd")).toHaveLength(1)
  })

  it("a black hole gives {by: blackhole}; a dead bot does not end the round", () => {
    const w = controlledWorld({ botCount: 2 })
    addWell(w, "blackhole", 300, 300)
    placeBody(w, 1, 300, 300)
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
    const deaths = eventsOf(w, "death")
    expect(deaths).toHaveLength(1)
    expect(deaths[0]).toMatchObject({ bodyId: "bot-1", cause: { by: "blackhole" } })
    expect(w.phase).toBe("playing")
    expect(w.result).toBeNull()
  })

  it("the player swallowed by a black hole: playerCause is blackhole", () => {
    const w = controlledWorld({ botCount: 1 })
    addWell(w, "blackhole", 0, 0)
    placeBody(w, 0, 3, 0)
    step(w, {})
    expect(w.result?.reason).toBe("playerDied")
    expect(w.result?.playerCause).toEqual({ by: "blackhole" })
  })

  it("spawn shield does not protect against wells", () => {
    const w = controlledWorld({ botCount: 2 })
    addWell(w, "star", 0, 0)
    placeBody(w, 1, 0, 0)
    w.bodies[1].shield = CONFIG.body.spawnShield
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
  })

  it("just outside the kill distance a body survives the step", () => {
    const w = controlledWorld({ botCount: 1 })
    const star = addWell(w, "star", 0, 0)
    placeBody(w, 0, star.radius + w.bodies[0].radius * CONFIG.well.killOverlap + 15, 0)
    step(w, {})
    expect(w.bodies[0].alive).toBe(true)
  })

  it("just inside the kill distance a body dies", () => {
    const w = controlledWorld({ botCount: 2 })
    const hole = addWell(w, "blackhole", 0, 0)
    placeBody(w, 1, hole.radius + w.bodies[1].radius * CONFIG.well.killOverlap - 3, 0)
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
  })

  it("wells are not affected by bodies: never move, never die", () => {
    const w = controlledWorld({ botCount: 1 })
    const s = makeWell("star", 100, 100)
    w.wells.push(s)
    const copy = JSON.stringify(s)
    placeBody(w, 0, 100, 100)
    step(w, {})
    expect(JSON.stringify(w.wells[0])).toBe(copy)
  })
})

// ---------------------------------------------------------------------------------------------
describe("13. wormholes", () => {
  const A = { x: -500, y: 0 }
  const B = { x: 600, y: 300 }
  function withPair(world: World) {
    world.wormholes = [
      { id: "wh-a", x: A.x, y: A.y, radius: CONFIG.wormhole.radius, linkId: "wh-b" },
      { id: "wh-b", x: B.x, y: B.y, radius: CONFIG.wormhole.radius, linkId: "wh-a" },
    ]
    return world
  }

  it("a body at rest on wh-a lands beside wh-b, gets the cooldown, emits warp, and does not bounce back", () => {
    const w = withPair(controlledWorld({ botCount: 1 }))
    placeBody(w, 0, A.x, A.y)
    step(w, {})
    const b = w.bodies[0]
    const off = CONFIG.wormhole.radius + b.radius + 4
    expectClose(b.x, B.x + off, 1e-9, "x")
    expectClose(b.y, B.y, 1e-9, "y")
    expect(b.warpCooldown).toBe(CONFIG.wormhole.cooldown)
    expect(b.px).toBe(b.x)
    expect(b.py).toBe(b.y)
    const warps = eventsOf(w, "warp")
    expect(warps).toHaveLength(1)
    expect(warps[0]).toMatchObject({ type: "warp", bodyId: "player" })
    expectClose(warps[0].fromX, A.x, 1e-9)
    expectClose(warps[0].fromY, A.y, 1e-9)
    expectClose(warps[0].toX, b.x, 1e-9)
    expectClose(warps[0].toY, b.y, 1e-9)
    // Next step: no second warp, cooldown ticks down.
    const x = b.x
    step(w, {})
    expect(eventsOf(w, "warp")).toHaveLength(0)
    expect(w.bodies[0].x).toBe(x)
    expectClose(w.bodies[0].warpCooldown, CONFIG.wormhole.cooldown - DT, 1e-12)
  })

  it("warping is symmetric: wh-b sends to wh-a", () => {
    const w = withPair(controlledWorld({ botCount: 1 }))
    placeBody(w, 0, B.x, B.y)
    step(w, {})
    const b = w.bodies[0]
    expectClose(b.x, A.x + CONFIG.wormhole.radius + b.radius + 4, 1e-9)
    expectClose(b.y, A.y, 1e-9)
  })

  it("velocity is kept and the exit side follows the direction of travel", () => {
    const w = withPair(controlledWorld({ botCount: 1 }))
    placeBody(w, 0, A.x, A.y, 0, 100)
    step(w, {})
    const b = w.bodies[0]
    const off = CONFIG.wormhole.radius + b.radius + 4
    expectClose(b.x, B.x, 1e-9, "x")
    expectClose(b.y, B.y + off, 1e-9, "y")
    expectClose(b.vy, 100 * DRAG, 1e-9, "velocity survives the warp")
    expectClose(b.vx, 0, 1e-12)
  })

  it("only the wormhole's radius counts: inside warps, outside does not", () => {
    const inside = withPair(controlledWorld({ botCount: 1 }))
    placeBody(inside, 0, A.x + CONFIG.wormhole.radius * 0.8, A.y)
    step(inside, {})
    expect(eventsOf(inside, "warp")).toHaveLength(1)
    const outside = withPair(controlledWorld({ botCount: 1 }))
    placeBody(outside, 0, A.x + CONFIG.wormhole.radius * 1.3, A.y)
    step(outside, {})
    expect(eventsOf(outside, "warp")).toHaveLength(0)
  })

  it("a body with warpCooldown > 0 does not warp until the cooldown has run out", () => {
    const w = withPair(controlledWorld({ botCount: 1 }))
    placeBody(w, 0, A.x, A.y)
    w.bodies[0].warpCooldown = 1.5 * DT
    step(w, {})
    expect(eventsOf(w, "warp")).toHaveLength(0)
    expect(w.bodies[0].x).toBe(A.x)
    step(w, {})
    expect(eventsOf(w, "warp")).toHaveLength(1)
  })

  it("dead bodies do not warp", () => {
    const w = withPair(controlledWorld({ botCount: 2 }))
    placeBody(w, 1, A.x, A.y)
    w.bodies[1].alive = false
    step(w, {})
    expect(eventsOf(w, "warp")).toHaveLength(0)
    expect(w.bodies[1].x).toBe(A.x)
  })
})

// ---------------------------------------------------------------------------------------------
describe("14. round end", () => {
  function evenMasses(w: World) {
    for (const b of w.bodies) setMass(b, CONFIG.body.startMass)
  }

  function roundEnds(w: World): GameEvent[] {
    return w.events.filter((e) => e.type === "roundEnd")
  }

  it("a bot reaching criticalMass ends the round, the bot wins", () => {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[1], CONFIG.round.criticalMass)
    step(w, {})
    expect(w.phase).toBe("over")
    expect(w.result?.reason).toBe("criticalMass")
    expect(w.result?.winnerId).toBe("bot-1")
    expect(w.result?.playerWon).toBe(false)
    expect(w.result?.playerCause).toBeUndefined()
    expect(roundEnds(w)).toHaveLength(1)
    expect(eventsOf(w, "phase")).toEqual([{ type: "phase", phase: "over" }])
  })

  it("the player reaching criticalMass wins", () => {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[0], CONFIG.round.criticalMass)
    step(w, {})
    expect(w.result?.reason).toBe("criticalMass")
    expect(w.result?.winnerId).toBe("player")
    expect(w.result?.playerWon).toBe(true)
  })

  it("just below criticalMass does not end the round", () => {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[1], CONFIG.round.criticalMass - 0.01)
    step(w, {})
    expect(w.phase).toBe("playing")
    expect(w.result).toBeNull()
  })

  it("two bodies past criticalMass: the heaviest wins, equal masses go to the lower index", () => {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[0], CONFIG.round.criticalMass + 5)
    setMass(w.bodies[1], CONFIG.round.criticalMass + 20)
    step(w, {})
    expect(w.result?.winnerId).toBe("bot-1")
    const t = controlledWorld({ botCount: 2 })
    setMass(t.bodies[1], CONFIG.round.criticalMass + 3)
    setMass(t.bodies[2], CONFIG.round.criticalMass + 3)
    step(t, {})
    expect(t.result?.winnerId).toBe("bot-1")
    const u = controlledWorld({ botCount: 2 })
    setMass(u.bodies[0], CONFIG.round.criticalMass)
    setMass(u.bodies[1], CONFIG.round.criticalMass)
    step(u, {})
    expect(u.result?.winnerId).toBe("player")
  })

  it("all bots dead: lastStanding, the player wins", () => {
    const w = controlledWorld({ botCount: 2 })
    w.bodies[1].alive = false
    w.bodies[2].alive = false
    step(w, {})
    expect(w.phase).toBe("over")
    expect(w.result?.reason).toBe("lastStanding")
    expect(w.result?.winnerId).toBe("player")
    expect(w.result?.playerWon).toBe(true)
  })

  it("a lone player with no bots does not win by 'last standing'", () => {
    const w = controlledWorld({ botCount: 0 })
    stepN(w, 10)
    expect(w.phase).toBe("playing")
    expect(w.result).toBeNull()
  })

  it("timeUp: the heaviest living body wins (a bot here)", () => {
    const w = controlledWorld({ botCount: 2 })
    evenMasses(w)
    setMass(w.bodies[2], 40)
    w.timeLeft = DT / 2
    step(w, {})
    expect(w.timeLeft).toBe(0)
    expect(w.result?.reason).toBe("timeUp")
    expect(w.result?.winnerId).toBe("bot-2")
    expect(w.result?.playerWon).toBe(false)
  })

  it("timeUp: the player wins when heaviest, and ties go to the lower index", () => {
    const w = controlledWorld({ botCount: 2 })
    evenMasses(w)
    setMass(w.bodies[0], 40)
    w.timeLeft = DT / 2
    step(w, {})
    expect(w.result?.reason).toBe("timeUp")
    expect(w.result?.playerWon).toBe(true)
    const t = controlledWorld({ botCount: 2 })
    evenMasses(t)
    t.timeLeft = DT / 2
    step(t, {})
    expect(t.result?.winnerId).toBe("player")
  })

  it("timeUp ignores dead bodies when picking the winner", () => {
    const w = controlledWorld({ botCount: 2 })
    evenMasses(w)
    setMass(w.bodies[1], 90)
    w.bodies[1].alive = false
    setMass(w.bodies[2], 30)
    w.timeLeft = DT / 2
    step(w, {})
    expect(w.result?.reason).toBe("timeUp")
    expect(w.result?.winnerId).toBe("bot-2")
  })

  it("timeLeft counts down by dt per playing step and time counts up", () => {
    const w = controlledWorld({ botCount: 1 })
    w.timeLeft = CONFIG.round.duration
    stepN(w, 60)
    expectClose(w.timeLeft, CONFIG.round.duration - 60 * DT, 1e-9)
    expectClose(w.time, 60 * DT, 1e-9)
  })

  it("player death beats a same-step critical mass: playerDied wins the precedence", () => {
    const w = controlledWorld({ botCount: 2 })
    addWell(w, "blackhole", 0, 0)
    placeBody(w, 0, 0, 0)
    setMass(w.bodies[1], CONFIG.round.criticalMass + 10)
    step(w, {})
    expect(w.result?.reason).toBe("playerDied")
    expect(w.result?.playerWon).toBe(false)
    expect(w.result?.playerCause).toEqual({ by: "blackhole" })
    expect(w.result?.winnerId).toBe("bot-1")
    expect(roundEnds(w)).toHaveLength(1)
  })

  it("player death when no bot is left alive: winnerId is null", () => {
    const w = controlledWorld({ botCount: 1 })
    addWell(w, "star", 0, 0)
    placeBody(w, 0, 0, 0)
    w.bodies[1].alive = false
    step(w, {})
    expect(w.result?.reason).toBe("playerDied")
    expect(w.result?.winnerId).toBeNull()
    expect(w.result?.playerWon).toBe(false)
  })

  it("standings: alive by mass desc, then dead by mass desc; durationS = play time", () => {
    const w = controlledWorld({ botCount: 4 })
    setMass(w.bodies[0], 10)
    setMass(w.bodies[1], 30)
    setMass(w.bodies[2], 20)
    setMass(w.bodies[3], 40)
    setMass(w.bodies[4], 25)
    w.bodies[3].alive = false
    w.bodies[4].alive = false
    w.timeLeft = DT / 2
    step(w, {})
    expect(w.phase).toBe("over")
    const result = w.result!
    expect(result.reason).toBe("timeUp")
    expect(result.standings.map((s) => s.id)).toEqual(["bot-1", "bot-2", "player", "bot-3", "bot-4"])
    expect(result.standings.map((s) => s.alive)).toEqual([true, true, true, false, false])
    expect(result.standings).toHaveLength(w.bodies.length)
    for (const s of result.standings) {
      const b = w.bodies.find((x) => x.id === s.id)!
      expect(s).toEqual({ id: b.id, name: b.name, color: b.color, mass: b.mass, alive: b.alive })
    }
    expect(result.durationS).toBe(w.time)
    expectClose(result.durationS, DT, 1e-12)
  })

  it("exactly one roundEnd event ever; its result is world.result", () => {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[1], CONFIG.round.criticalMass)
    let total = 0
    for (let i = 0; i < 6; i++) {
      step(w, {})
      total += roundEnds(w).length
    }
    expect(total).toBe(1)
    const w2 = controlledWorld({ botCount: 2 })
    setMass(w2.bodies[1], CONFIG.round.criticalMass)
    step(w2, {})
    const ev = eventsOf(w2, "roundEnd")[0]
    expect(ev.result).toEqual(w2.result)
  })

  it("the winner's standing leads the list when it is alive and heaviest", () => {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[2], CONFIG.round.criticalMass)
    step(w, {})
    expect(w.result?.standings[0].id).toBe("bot-2")
    expect(w.result?.standings.every((s) => s.alive)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
describe("15. after the round is over", () => {
  it("step() changes nothing except clearing events", () => {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[1], CONFIG.round.criticalMass)
    step(w, {})
    expect(w.phase).toBe("over")
    expect(w.events.length).toBeGreaterThan(0)
    const frozen = cloneWorld(w)
    frozen.events = []
    for (let i = 0; i < 5; i++) {
      step(w, { player: intent(1, 0, true), "bot-1": intent(0, 1, true) })
      expect(snapshot(w)).toBe(snapshot(frozen))
      expect(w.events).toEqual([])
    }
  })

  it("an 'over' world from a countdown-created world also stays frozen", () => {
    const w = createWorld({ seed: 4, difficulty: "easy", botCount: 1 })
    stepN(w, 200)
    w.timeLeft = DT / 2
    stepN(w, 1)
    expect(w.phase).toBe("over")
    const tick = w.tick
    const frozen = cloneWorld(w)
    frozen.events = []
    step(w, { player: intent(1, 1, true) })
    expect(w.tick).toBe(tick)
    expect(snapshot(w)).toBe(snapshot(frozen))
  })
})

// ---------------------------------------------------------------------------------------------
describe("16. determinism and cloning", { timeout: 30000 }, () => {
  const scripted = (tick: number, index: number): Intent =>
    intent(Math.cos(tick * 0.031 + index * 1.7), Math.sin(tick * 0.027 + index * 0.9), Math.floor(tick / 45 + index) % 3 === 0)

  function run(w: World, from: number, to: number) {
    for (let t = from; t < to; t++) {
      const intents: Record<string, Intent> = {}
      w.bodies.forEach((b, i) => {
        intents[b.id] = scripted(t, i)
      })
      step(w, intents)
    }
  }

  it("same seed and same scripted intents for 600 playing steps are JSON-equal", () => {
    for (const difficulty of DIFFICULTIES) {
      const a = createWorld({ seed: 99, difficulty })
      const b = createWorld({ seed: 99, difficulty })
      run(a, 0, 181 + 600)
      run(b, 0, 181 + 600)
      expect(snapshot(a)).toBe(snapshot(b))
      expect(snapshot(a)).not.toBe(snapshot(createWorld({ seed: 99, difficulty })))
    }
  })

  it("different seeds diverge", () => {
    const a = createWorld({ seed: 1, difficulty: "normal" })
    const b = createWorld({ seed: 2, difficulty: "normal" })
    run(a, 0, 400)
    run(b, 0, 400)
    expect(snapshot(a)).not.toBe(snapshot(b))
  })

  it("cloneWorld shares nothing with the original and continues identically", () => {
    const a = createWorld({ seed: 17, difficulty: "normal" })
    run(a, 0, 300)
    const c = cloneWorld(a)
    expect(snapshot(c)).toBe(snapshot(a))
    run(a, 300, 700)
    run(c, 300, 700)
    expect(snapshot(c)).toBe(snapshot(a))
    // Mutating the clone must not touch the original.
    const d = cloneWorld(a)
    const before = snapshot(a)
    d.bodies[0].mass += 100
    d.debris.pop()
    d.wells[0].x += 1
    d.spawnCredit.debris += 5
    d.events.push({ type: "lowEnergy", bodyId: "player" })
    expect(snapshot(a)).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
describe("17. pull", () => {
  function pullWorld(debrisX: number, pulling = true, mass?: number) {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    if (mass !== undefined) setMass(w.bodies[0], mass)
    const d = makeDebris(w, "dust", debrisX, 0)
    step(w, { player: intent(0, 0, pulling) })
    return { w, d }
  }

  it("debris inside pullRadius is accelerated toward the puller; strength falls off linearly", () => {
    const w0 = controlledWorld({ botCount: 1 })
    const R = pullRadius(w0.bodies[0])
    const near = 40
    const far = R * 0.8
    const a = pullWorld(near)
    const b = pullWorld(far)
    const exp = (d: number) => CONFIG.pull.debrisAccel * (1 - d / R) * DT * DEBRIS_DRAG
    expectClose(a.d.vx, -exp(near), 1e-9, "near debris vx")
    expectClose(b.d.vx, -exp(far), 1e-9, "far debris vx")
    expectClose(a.d.vy, 0, 1e-12)
    expect(Math.abs(a.d.vx)).toBeGreaterThan(Math.abs(b.d.vx))
  })

  it("debris outside pullRadius is untouched; without pull nothing is pulled", () => {
    const R = pullRadius(controlledWorld({ botCount: 1 }).bodies[0])
    const out = pullWorld(R + 100)
    expect(out.d.vx).toBe(0)
    expect(out.d.vy).toBe(0)
    expect(out.d.x).toBe(R + 100)
    const idle = pullWorld(100, false)
    expect(idle.d.vx).toBe(0)
  })

  it("a bigger body has a longer reach", () => {
    const R10 = pullRadius(controlledWorld({ botCount: 1 }).bodies[0])
    const probe = R10 + 40
    const small = pullWorld(probe)
    const big = pullWorld(probe, true, 60)
    expect(small.d.vx).toBe(0)
    expect(big.d.vx).toBeLessThan(0)
  })

  it("a lone pulling body does not move itself", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    step(w, { player: intent(0, 0, true) })
    expect(w.bodies[0].vx).toBe(0)
    expect(w.bodies[0].vy).toBe(0)
  })

  it("a smaller absorbable body is pulled in; a heavier or equal one is not", () => {
    const build = (puller: number, other: number) => {
      const w = controlledWorld({ botCount: 1 })
      setMass(w.bodies[0], puller)
      setMass(w.bodies[1], other)
      placeBody(w, 0, 0, 0)
      placeBody(w, 1, 100, 0)
      step(w, { player: intent(0, 0, true) })
      return w
    }
    const pulled = build(30, 10)
    const R = pullRadius(pulled.bodies[0])
    expectClose(pulled.bodies[1].vx, -CONFIG.pull.bodyAccel * (1 - 100 / R) * DT, 1e-9, "pulled body vx")
    expect(pulled.bodies[1].vy).toBe(0)
    const heavier = build(10, 30)
    expect(heavier.bodies[1].vx).toBe(0)
    const equal = build(10, 10)
    expect(equal.bodies[1].vx).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("18. rankOf and hudSnapshot", () => {
  it("rankOf ranks the living by mass; 0 for the dead and for unknown ids; ties go to the lower index", () => {
    const w = controlledWorld({ botCount: 3 })
    setMass(w.bodies[0], 20)
    setMass(w.bodies[1], 50)
    setMass(w.bodies[2], 30)
    setMass(w.bodies[3], 30)
    expect(rankOf(w, "bot-1")).toBe(1)
    expect(rankOf(w, "bot-2")).toBe(2)
    expect(rankOf(w, "bot-3")).toBe(3)
    expect(rankOf(w, "player")).toBe(4)
    expect(rankOf(w, "nobody")).toBe(0)
    w.bodies[1].alive = false
    expect(rankOf(w, "bot-1")).toBe(0)
    expect(rankOf(w, "bot-2")).toBe(1)
    expect(rankOf(w, "player")).toBe(3)
  })

  it("hudSnapshot mirrors the player", () => {
    const w = controlledWorld({ botCount: 3 })
    const p = w.bodies[0]
    setMass(p, 33)
    p.energy = 61
    p.shield = 1.25
    p.pulling = true
    p.charging = true
    w.timeLeft = 77.5
    w.bodies[2].alive = false
    const h = hudSnapshot(w)
    expect(h.phase).toBe("playing")
    expect(h.countdown).toBe(0)
    expect(h.timeLeft).toBe(77.5)
    expect(h.mass).toBe(33)
    expect(h.energy).toBe(61)
    expect(h.energyMax).toBe(CONFIG.energy.max)
    expect(h.criticalMass).toBe(CONFIG.round.criticalMass)
    expect(h.rank).toBe(rankOf(w, "player"))
    expect(h.alive).toBe(3)
    expect(h.total).toBe(4)
    expect(h.pulling).toBe(true)
    expect(h.charging).toBe(true)
    expect(h.lowEnergy).toBe(false)
    expect(h.shield).toBe(1.25)
  })

  it("hud lowEnergy flips at lowThreshold; countdown is rounded up; rank is 0 when the player is dead", () => {
    const w = controlledWorld({ botCount: 2 })
    w.bodies[0].energy = CONFIG.energy.lowThreshold
    expect(hudSnapshot(w).lowEnergy).toBe(false)
    w.bodies[0].energy = CONFIG.energy.lowThreshold - 0.01
    expect(hudSnapshot(w).lowEnergy).toBe(true)
    w.phase = "countdown"
    w.countdown = 2.2
    expect(hudSnapshot(w).countdown).toBe(3)
    w.countdown = 1
    expect(hudSnapshot(w).countdown).toBe(1)
    w.countdown = 0.01
    expect(hudSnapshot(w).countdown).toBe(1)
    w.bodies[0].alive = false
    expect(hudSnapshot(w).rank).toBe(0)
    expect(hudSnapshot(w).alive).toBe(2)
  })

  it("hud on a fresh world reports the countdown phase", () => {
    const w = createWorld({ seed: 1, difficulty: "easy" })
    const h = hudSnapshot(w)
    expect(h.phase).toBe("countdown")
    expect(h.countdown).toBe(CONFIG.round.countdown)
    expect(h.total).toBe(1 + CONFIG.difficulty.easy.bots)
    expect(h.alive).toBe(h.total)
    expect(h.timeLeft).toBe(CONFIG.round.duration)
  })
})

// ---------------------------------------------------------------------------------------------
describe("spawning", () => {
  it("refills dust/rock at spawnRate per second", () => {
    const w = controlledWorld({ botCount: 1 })
    w.spawnCredit = credit({ debris: 0, crystal: -1e9 })
    const startId = w.nextDebrisId
    stepN(w, 120)
    const expected = CONFIG.debris.spawnRate * 120 * DT
    expect(w.debris.length).toBeGreaterThanOrEqual(Math.floor(expected) - 1)
    expect(w.debris.length).toBeLessThanOrEqual(Math.ceil(expected))
    const ids = new Set(w.debris.map((d) => d.id))
    expect(ids.size).toBe(w.debris.length)
    for (const d of w.debris) {
      expect(d.id).toBeGreaterThanOrEqual(startId)
      expect(d.id).toBeLessThan(w.nextDebrisId)
      expect(d.kind).not.toBe("crystal")
    }
  })

  it("never overshoots the target and caps leftover credit at 1", () => {
    const w = controlledWorld({ botCount: 1 })
    w.spawnCredit = credit({ debris: CONFIG.debris.target + 100, crystal: -1e9 })
    step(w, {})
    expect(w.debris.filter((d) => d.kind !== "crystal")).toHaveLength(CONFIG.debris.target)
    expect(w.spawnCredit.debris).toBeLessThanOrEqual(1 + 1e-9)
    const before = w.debris.length
    stepN(w, 10)
    expect(w.debris.filter((d) => d.kind !== "crystal").length).toBeLessThanOrEqual(CONFIG.debris.target)
    expect(w.debris.length).toBeLessThanOrEqual(before)
  })

  it("crystals respawn at crystal.spawnRate up to crystal.target", () => {
    const w = controlledWorld({ botCount: 1 })
    w.spawnCredit = credit({ debris: -1e9, crystal: 1 - CONFIG.crystal.spawnRate * DT * 0.5 })
    step(w, {})
    expect(w.debris).toHaveLength(1)
    expect(w.debris[0].kind).toBe("crystal")
    expect(w.debris[0].mass).toBe(CONFIG.crystal.mass)

    const capped = controlledWorld({ botCount: 1 })
    capped.spawnCredit = credit({ debris: -1e9, crystal: CONFIG.crystal.target + 10 })
    step(capped, {})
    expect(capped.debris.filter((d) => d.kind === "crystal")).toHaveLength(CONFIG.crystal.target)
    expect(capped.spawnCredit.crystal).toBeLessThanOrEqual(1 + 1e-9)
  })

  it("new debris respects the arena and well clearance and starts at rest", () => {
    const w = controlledWorld({ botCount: 1 })
    addWell(w, "star", 0, 0)
    addWell(w, "blackhole", 300, 0)
    const burst = Math.floor(CONFIG.debris.target / 2)
    w.spawnCredit = credit({ debris: burst, crystal: -1e9 })
    step(w, {})
    expect(w.debris.length).toBeGreaterThanOrEqual(burst - 1)
    for (const d of w.debris) {
      expect(Math.hypot(d.x, d.y)).toBeLessThanOrEqual(w.arenaRadius + 1e-9)
      for (const well of w.wells) {
        expect(dist(d, well)).toBeGreaterThanOrEqual(well.radius + CONFIG.debris.wellClearance - 1e-9)
      }
      expect(d.vx).toBe(0)
      expect(d.vy).toBe(0)
      expect(d.px).toBe(d.x)
      expect(d.py).toBe(d.y)
      expectClose(d.radius, radiusForMass(d.mass), 1e-12)
    }
  })

  it("no spawning during the countdown", () => {
    const w = createWorld({ seed: 2, difficulty: "easy" })
    w.debris = []
    w.spawnCredit = credit({ debris: 100, crystal: 100 })
    stepN(w, 20)
    expect(w.phase).toBe("countdown")
    expect(w.debris).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("edge cases of the speed caps, precedence and the charge band", () => {
  it("thrust against the motion of an over-speed body is not rescaled back up to its old speed", () => {
    const w = controlledWorld({ botCount: 1 })
    const v0 = Math.min(maxSpeed(CONFIG.body.startMass) * 1.5, CONFIG.body.hardSpeedCap * 0.8)
    expect(v0).toBeGreaterThan(maxSpeed(CONFIG.body.startMass))
    placeBody(w, 0, -1000, 0, v0, 0)
    step(w, { player: intent(-1, 0) })
    // |vNew| = v0 - thrust*dt is still above maxSpeed but below |vNo| = v0: it must stay |vNew|, then drag.
    const expected = (v0 - thrustAccel(CONFIG.body.startMass) * DT) * DRAG
    expectClose(w.bodies[0].vx, expected, 1e-9, "vx")
    expectClose(w.bodies[0].vy, 0, 1e-12, "vy")
  })

  it("thrust along the motion of an over-speed body cannot add speed", () => {
    const w = controlledWorld({ botCount: 1 })
    const v0 = Math.min(maxSpeed(CONFIG.body.startMass) * 1.5, CONFIG.body.hardSpeedCap * 0.8)
    placeBody(w, 0, -1000, 0, v0, 0)
    step(w, { player: intent(1, 0) })
    expectClose(w.bodies[0].vx, v0 * DRAG, 1e-9, "vx")
  })

  it("hardSpeedCap clamps a body that starts far above it", () => {
    for (const dir of [[1, 0], [0, -1], [0.6, 0.8]]) {
      const w = controlledWorld({ botCount: 1 })
      const v = CONFIG.body.hardSpeedCap * 3
      placeBody(w, 0, -dir[0] * 800, -dir[1] * 800, dir[0] * v, dir[1] * v)
      step(w, {})
      const b = w.bodies[0]
      expect(Math.hypot(b.vx, b.vy)).toBeLessThanOrEqual(CONFIG.body.hardSpeedCap + 1e-9)
      expect(Math.hypot(b.vx, b.vy)).toBeGreaterThan(CONFIG.body.hardSpeedCap * 0.99)
      expectClose(b.vx / Math.hypot(b.vx, b.vy), dir[0], 1e-9, "direction kept")
    }
  })

  it("timeLeft <= 0 and a critical-mass body on the same step: criticalMass wins, heaviest critical body", () => {
    const w = controlledWorld({ botCount: 3 })
    for (const b of w.bodies) setMass(b, CONFIG.body.startMass)
    setMass(w.bodies[1], CONFIG.round.criticalMass + 5)
    setMass(w.bodies[2], CONFIG.round.criticalMass + 25)
    setMass(w.bodies[3], CONFIG.round.criticalMass - 1)
    w.timeLeft = DT / 2
    step(w, {})
    expect(w.timeLeft).toBe(0)
    expect(w.result?.reason).toBe("criticalMass")
    expect(w.result?.winnerId).toBe("bot-2")
  })

  it("lastStanding beats timeUp on the same step", () => {
    const w = controlledWorld({ botCount: 2 })
    w.bodies[1].alive = false
    w.bodies[2].alive = false
    setMass(w.bodies[0], 10)
    w.timeLeft = DT / 2
    step(w, {})
    expect(w.result?.reason).toBe("lastStanding")
  })

  it("a body exactly on the outer edge of the charge band is not charging and gets only regen", () => {
    const w = controlledWorld({ botCount: 1 })
    const star = addWell(w, "star", 0, 0)
    placeBody(w, 0, star.chargeRadius, 0)
    w.bodies[0].energy = 50
    step(w, {})
    expect(w.bodies[0].charging).toBe(false)
    expectClose(w.bodies[0].energy, 50 + CONFIG.energy.regen * DT, 1e-9, "only regen at the band edge")
  })

  it("when the player dies the winner is the heaviest LIVING bot, never the player", () => {
    const w = controlledWorld({ botCount: 3 })
    addWell(w, "blackhole", 0, 0)
    placeBody(w, 0, 0, 0)
    setMass(w.bodies[0], 200)
    setMass(w.bodies[1], 15)
    setMass(w.bodies[2], 90)
    w.bodies[2].alive = false
    setMass(w.bodies[3], 25)
    step(w, {})
    expect(w.result?.reason).toBe("playerDied")
    expect(w.result?.winnerId).toBe("bot-3")
    expect(w.result?.playerWon).toBe(false)
  })

  it("when the player dies and no bot lives, there is no winner", () => {
    const w = controlledWorld({ botCount: 2 })
    addWell(w, "star", 0, 0)
    placeBody(w, 0, 0, 0)
    w.bodies[1].alive = false
    w.bodies[2].alive = false
    step(w, {})
    expect(w.result?.reason).toBe("playerDied")
    expect(w.result?.winnerId).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
describe("idleTime", () => {
  it("is 0 for every body at createWorld, on every difficulty", () => {
    for (const difficulty of DIFFICULTIES) {
      for (const b of createWorld({ seed: 4, difficulty }).bodies) expect(b.idleTime, `${difficulty} ${b.id}`).toBe(0)
    }
  })

  it("grows by dt per step with no intent (players and bots)", () => {
    const w = controlledWorld({ botCount: 1 })
    stepN(w, 25)
    for (const b of w.bodies) expectClose(b.idleTime, 25 * DT, 1e-9, `${b.id} idleTime`)
  })

  it("resets to 0 on a step with thrust, then grows again", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    stepN(w, 10)
    expectClose(w.bodies[0].idleTime, 10 * DT, 1e-9)
    step(w, { player: intent(1, 0) })
    expect(w.bodies[0].idleTime).toBe(0)
    step(w, {})
    expectClose(w.bodies[0].idleTime, DT, 1e-12)
    expectClose(w.bodies[1].idleTime, 12 * DT, 1e-9, "the other body kept idling")
  })

  it("resets to 0 on a step with pull (energy > 0)", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    stepN(w, 10)
    step(w, { player: intent(0, 0, true) })
    expect(w.bodies[0].idleTime).toBe(0)
  })

  it("an intent shorter than the thrust deadzone does not reset it", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    stepN(w, 5)
    step(w, { player: intent(CONFIG.body.thrustDeadzone * 0.5, 0) })
    expectClose(w.bodies[0].idleTime, 6 * DT, 1e-9)
  })

  it("keeps growing while the intent asks for thrust or pull but energy is 0", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    w.bodies[0].idleTime = 1
    w.bodies[0].energy = 0
    step(w, { player: intent(1, 0, true) })
    expect(w.bodies[0].thrusting).toBe(false)
    expect(w.bodies[0].pulling).toBe(false)
    expectClose(w.bodies[0].idleTime, 1 + DT, 1e-12)
  })
})

// ---------------------------------------------------------------------------------------------
describe("idle safety push", () => {
  const S = CONFIG.difficulty.easy.idleSafety
  const gravityAt = (gm: number, d: number) => gm / (d * d + CONFIG.well.soft ** 2)

  /** Idle body 0 at the origin, one well to its right at surface distance s; others parked far. */
  function scene(difficulty: Difficulty, kind: "star" | "blackhole", s: number, idleTime: number) {
    const w = controlledWorld({ difficulty, botCount: 1 })
    placeBody(w, 0, 0, 0)
    w.bodies[0].idleTime = idleTime
    const probe = makeWell(kind, 0, 0)
    const d = probe.radius + s
    const well = addWell(w, kind, d, 0)
    return { w, well, d }
  }

  for (const kind of ["star", "blackhole"] as const) {
    for (const frac of [0.1, 0.25, 0.5]) {
      it(`easy, idle player, ${kind} at s = ${frac} * range: velocity = (gravity - push*gravity*(1 - s/range)) * dt * drag`, () => {
        const s = frac * S.range
        const { w, well, d } = scene("easy", kind, s, S.after + 1)
        step(w, {})
        const g = gravityAt(well.gm, d)
        const towardWell = g - S.push * g * (1 - s / S.range)
        expectClose(w.bodies[0].vx, towardWell * DT * DRAG, 1e-9, "vx")
        expectClose(w.bodies[0].vy, 0, 1e-12, "vy")
        expectClose(w.bodies[0].x, w.bodies[0].vx * DT, 1e-9, "x")
      })
    }
  }

  it("easy: the push is net outward when push*(1 - s/range) > 1", () => {
    const s = 0.1 * S.range
    expect(S.push * (1 - s / S.range)).toBeGreaterThan(1)
    const { w } = scene("easy", "star", s, S.after + 1)
    step(w, {})
    expect(w.bodies[0].vx).toBeLessThan(0)
  })

  it("easy: the push starts when idleTime reaches `after` during the step", () => {
    const s = 0.25 * S.range
    const { w, well, d } = scene("easy", "star", s, S.after - 0.5 * DT)
    step(w, {})
    const g = gravityAt(well.gm, d)
    expectClose(w.bodies[0].vx, (g - S.push * g * (1 - s / S.range)) * DT * DRAG, 1e-9, "vx")
  })

  it("no push while idleTime is below `after` (plain gravity only)", () => {
    const s = 0.25 * S.range
    const { w, well, d } = scene("easy", "star", s, S.after - 2 * DT)
    step(w, {})
    expectClose(w.bodies[0].vx, gravityAt(well.gm, d) * DT * DRAG, 1e-9, "vx")
  })

  it("no push at or beyond the range (s >= range)", () => {
    for (const mult of [1, 1.5]) {
      const { w, well, d } = scene("easy", "blackhole", mult * S.range, S.after + 1)
      step(w, {})
      expectClose(w.bodies[0].vx, gravityAt(well.gm, d) * DT * DRAG, 1e-9, `vx at s = ${mult} * range`)
    }
  })

  it("no push for a bot, however idle", () => {
    const s = 0.25 * S.range
    const w = controlledWorld({ difficulty: "easy", botCount: 1 })
    placeBody(w, 1, 0, 0)
    w.bodies[1].idleTime = S.after + 5
    const probe = makeWell("star", 0, 0)
    const well = addWell(w, "star", probe.radius + s, 0)
    step(w, {})
    expectClose(w.bodies[1].vx, gravityAt(well.gm, well.x) * DT * DRAG, 1e-9, "bot vx")
  })

  for (const difficulty of ["normal", "hard"] as const) {
    it(`no push on ${difficulty} (idleSafety is null)`, () => {
      expect(CONFIG.difficulty[difficulty].idleSafety).toBeNull()
      const s = 0.25 * S.range
      const { w, well, d } = scene(difficulty, "star", s, S.after + 5)
      step(w, {})
      expectClose(w.bodies[0].vx, gravityAt(well.gm, d) * DT * DRAG, 1e-9, "vx")
    })
  }

  it("an actively thrusting easy player gets no push (idleTime stays 0)", () => {
    const s = 0.25 * S.range
    const { w, well, d } = scene("easy", "star", s, S.after + 5)
    step(w, { player: intent(0, 1) })
    expect(w.bodies[0].idleTime).toBe(0)
    expectClose(w.bodies[0].vx, gravityAt(well.gm, d) * DT * DRAG, 1e-9, "vx")
  })

  function idleNearStar(difficulty: Difficulty) {
    const w = controlledWorld({ difficulty, botCount: 1 })
    const star = addWell(w, "star", 0, 0)
    const p = w.bodies[0]
    placeBody(w, 0, star.radius + p.radius * CONFIG.well.killOverlap + 10, 0)
    // Start already idle, so the safety net is armed from the first step.
    if (difficulty === "easy") p.idleTime = S.after
    const park = { x: w.bodies[1].x, y: w.bodies[1].y }
    const deaths: string[] = []
    let steps = 0
    for (; steps < Math.round(60 / DT) && w.bodies[0].alive; steps++) {
      step(w, {})
      for (const e of eventsOf(w, "death")) deaths.push(`${e.bodyId}:${e.cause.by}`)
      // Keep the bot out of the star's pull so the round cannot end under the player.
      placeBody(w, 1, park.x, park.y)
    }
    return { w, deaths, steps }
  }

  it("easy: an idle player just outside a star's kill distance survives 60 s", () => {
    const { w, deaths, steps } = idleNearStar("easy")
    expect(deaths).toEqual([])
    expect(w.bodies[0].alive).toBe(true)
    expect(steps).toBe(Math.round(60 / DT))
    expect(w.phase).toBe("playing")
  })

  it("normal: the same idle player is pulled into the star and dies", () => {
    const { w, deaths } = idleNearStar("normal")
    expect(w.bodies[0].alive).toBe(false)
    expect(deaths).toContain("player:star")
  })
})
