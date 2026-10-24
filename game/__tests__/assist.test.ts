// Gravity assist ("Oberth burn"): what opens a pass, what grades it, what cannot farm it, and
// what the earned surge is allowed to do. All fixtures are deterministic (fixed step, no RNG in
// this path) and use the shared helpers.

import { describe, expect, it } from "vitest"
import { assistWindow, grantSurge, tickAssist, type BurnReady } from "../assist"
import { CONFIG } from "../config"
import { createWorld, hudSnapshot, maxSpeed, step } from "../engine"
import type { Body, Difficulty, GameEvent, Intent, Well, World } from "../types"
import { DT, addWell, controlledWorld, eventsOf } from "./helpers"

type OberthEvent = Extract<GameEvent, { type: "oberth" }>

const NONE: Intent = { ax: 0, ay: 0, pull: false }
const DASH: Intent = { ax: 0, ay: 0, pull: false, dash: true }

/**
 * A pilot holding prograde thrust. Body drag (CONFIG.body.drag) is strong enough that a ballistic
 * body bleeds to a stop before reaching a well, so a real approach is flown under thrust exactly
 * as a player flies it. `dash` adds the burn to the same intent.
 */
function pilot(b: Body, dash = false): Intent {
  const s = Math.hypot(b.vx, b.vy)
  if (s < 1) return dash ? DASH : NONE
  return { ax: b.vx / s, ay: b.vy / s, pull: false, dash }
}

interface FlybyOptions {
  offset?: number
  speed?: number
  distance?: number
  difficulty?: Difficulty
  botCount?: number
  /** gm override on the test well (default: the star's). */
  gm?: number
  wellKind?: "star" | "planet"
}

/** A world with one well at the origin and a body on a pass along +x from -distance. */
function flybyWorld(opts: FlybyOptions = {}): { w: World; well: Well; b: Body } {
  const w = controlledWorld({ difficulty: opts.difficulty ?? "normal", botCount: opts.botCount ?? 0 })
  const well = addWell(w, opts.wellKind ?? "star", 0, 0)
  if (opts.gm !== undefined) well.gm = opts.gm
  const b = w.bodies[0]
  b.x = -(opts.distance ?? 700)
  b.y = opts.offset ?? 200
  b.px = b.x
  b.py = b.y
  b.vx = opts.speed ?? 340
  b.vy = 0
  b.energy = CONFIG.energy.max
  return { w, well, b }
}

/** First step index at which the body's pass has crossed periapsis (disposable probe world). */
function periTick(opts: FlybyOptions = {}, maxSteps = 900): number {
  const { w, b } = flybyWorld(opts)
  for (let i = 0; i < maxSteps; i++) {
    step(w, { player: pilot(b) })
    if (b.assist.pass.stage === "out") return i
  }
  throw new Error("no periapsis inside the probe window")
}

/** Steps the pass has been open, and whether it ever opened. */
function passOpened(w: World, b: Body): boolean {
  return b.assist.pass.wellId !== ""
}

interface RunResult {
  w: World
  b: Body
  burns: OberthEvent[]
}

/** Replay the flyby, dashing on the given step indices only. Returns the world after `steps`. */
function runFlyby(opts: FlybyOptions, dashTicks: readonly number[], steps = 200): RunResult {
  const { w, b } = flybyWorld(opts)
  const burns: OberthEvent[] = []
  for (let i = 0; i < steps; i++) {
    const wantsDash = dashTicks.indexOf(i) >= 0 && b.dashCd === 0
    step(w, { player: pilot(b, wantsDash) })
    for (const e of eventsOf(w, "oberth")) burns.push(e)
  }
  return { w, b, burns }
}

function fakeBurn(over: Partial<BurnReady> = {}): BurnReady {
  return {
    well: addWell(controlledWorld({ botCount: 0 }), "star", 500, 500),
    tier: "burn",
    quality: 0.6,
    moving: false,
    speed: 400,
    energy: 14,
    ult: 0.1,
    impulse: 90,
    surge: 3,
    speedMul: 1.14,
    thrustMul: 1.07,
    ...over,
  }
}

describe("assist: what counts as a flyby", () => {
  it("opens a pass only while closing, then finds a real deep periapsis", () => {
    const { w, well, b } = flybyWorld()
    let opened = -1
    for (let i = 0; i < 600 && opened < 0; i++) {
      step(w, { player: pilot(b) })
      if (passOpened(w, b)) opened = i
    }
    expect(opened, "the pass opens on the way in").toBeGreaterThan(0)
    expect(b.assist.pass.wellId).toBe(well.id)
    for (let i = 0; i < 600 && b.assist.pass.stage === "in"; i++) step(w, { player: pilot(b) })
    expect(b.assist.pass.stage).toBe("out")
    expect(b.assist.pass.periAt).toBeGreaterThan(0)
    expect(b.assist.pass.periRelSpeed).toBeGreaterThan(CONFIG.assist.minRelSpeed)
    expect(b.assist.pass.periDist).toBeLessThan(well.radius * CONFIG.assist.periBand)
  })

  it("does not open a pass for a body already moving away from the well", () => {
    const { w, b } = flybyWorld({ distance: -500, speed: 300 })
    for (let i = 0; i < 180; i++) step(w, { player: b.dashCd === 0 ? DASH : NONE })
    expect(passOpened(w, b)).toBe(false)
    expect(eventsOf(w, "oberth")).toHaveLength(0)
  })
})

describe("assist: the timed dash window", () => {
  it("pays a graded burn for a dash at periapsis", () => {
    const peri = periTick()
    const r = runFlyby({}, [peri])
    expect(r.burns, "one burn").toHaveLength(1)
    const ev = r.burns[0]
    expect(ev.bodyId).toBe("player")
    expect(["graze", "burn", "oberth"]).toContain(ev.tier)
    expect(ev.quality).toBeGreaterThan(0)
    expect(ev.speed).toBeGreaterThan(CONFIG.assist.minRelSpeed)
    expect(ev.surge).toBeGreaterThan(0)
    expect(ev.speedMul).toBeGreaterThan(1)
    expect(r.b.assist.surge).toBeGreaterThan(0)
    expect(r.b.assist.surgeMul).toBeGreaterThan(1)
    expect(r.b.stats.slingshots).toBe(1)
    // The legacy slingshot must not double-pay for the same pass.
    expect(r.w.events.some((e) => e.type === "slingshot")).toBe(false)
  })

  it("ignores a dash a second before periapsis", () => {
    const early = periTick() - Math.ceil(1 / DT)
    const r = runFlyby({}, [early])
    expect(r.burns).toHaveLength(0)
    expect(r.b.assist.surge).toBe(0)
    expect(r.b.assist.surgeMul).toBe(1)
  })

  it("ignores a dash a second after periapsis", () => {
    const late = periTick() + Math.ceil(1 / DT)
    const r = runFlyby({}, [late])
    expect(r.burns).toHaveLength(0)
  })

  it("difficulty widens the window: 0.4 s late is easy-only", () => {
    const late = Math.round(0.4 / DT) // 24 steps
    const easy = runFlyby({ difficulty: "easy" }, [periTick({ difficulty: "easy" }) + late])
    const normal = runFlyby({ difficulty: "normal" }, [periTick({ difficulty: "normal" }) + late])
    const hard = runFlyby({ difficulty: "hard" }, [periTick({ difficulty: "hard" }) + late])
    expect(easy.burns).toHaveLength(1)
    expect(normal.burns).toHaveLength(0)
    expect(hard.burns).toHaveLength(0)
    expect(assistWindow(easy.b)).toBeGreaterThan(assistWindow(normal.b))
    expect(assistWindow(normal.b)).toBeGreaterThan(assistWindow(hard.b))
  })
})

describe("assist: a real flyby is required", () => {
  it("does not pay a distant pass through the band, even with a perfect dash", () => {
    // 400 u of impact parameter: the pass opens and reaches periapsis well outside the deep band.
    const opts: FlybyOptions = { offset: 400, speed: 340 }
    const probe = periTick(opts)
    const r = runFlyby(opts, [probe])
    expect(r.burns).toHaveLength(0)
    expect(r.b.assist.surge).toBe(0)
  })

  it("a dash with no well never pays", () => {
    const w = controlledWorld({ botCount: 0 })
    const b = w.bodies[0]
    for (let i = 0; i < 240; i++) step(w, { player: b.dashCd === 0 ? DASH : NONE })
    expect(eventsOf(w, "oberth")).toHaveLength(0)
    expect(b.assist.surge).toBe(0)
  })
})

describe("assist: anti-farming", () => {
  it("a body drifting inside the band cannot open a pass by dashing", () => {
    // Weak gravity and tangential motion: it stays inside the band without closing at 90 u/s.
    const w = controlledWorld({ botCount: 0 })
    const well = addWell(w, "star", 0, 0)
    well.gm = 2e4
    const b = w.bodies[0]
    b.x = 300
    b.y = 0
    b.px = b.x
    b.py = b.y
    b.vx = 40
    b.vy = 60
    for (let i = 0; i < 900 && b.alive; i++) step(w, { player: b.dashCd === 0 ? DASH : NONE })
    expect(passOpened(w, b)).toBe(false)
    expect(eventsOf(w, "oberth")).toHaveLength(0)
    expect(b.assist.surge).toBe(0)
  })

  it("an overlong hover inside the band is dropped without a reward", () => {
    const { w, b } = flybyWorld()
    for (let i = 0; i < 600 && !passOpened(w, b); i++) step(w, { player: pilot(b) })
    expect(passOpened(w, b)).toBe(true)
    const hold = Math.floor((CONFIG.assist.maxPass + 1) / DT)
    for (let i = 0; i < hold; i++) {
      b.vx = 0
      b.vy = 0
      b.x = 300
      b.y = 0
      b.px = b.x
      b.py = b.y
      step(w, { player: b.dashCd === 0 ? DASH : NONE })
    }
    expect(passOpened(w, b)).toBe(false)
    expect(eventsOf(w, "oberth")).toHaveLength(0)
    expect(b.assist.surge).toBe(0)
  })

  it("the same well is locked out for CONFIG.assist.sameWell seconds, then allowed again", () => {
    const peri = periTick()
    const first = runFlyby({}, [peri], peri + 120)
    expect(first.burns).toHaveLength(1)
    const wellId = first.burns[0].wellId
    const { w, b } = first
    expect(b.assist.lastWellId).toBe(wellId)
    expect(b.assist.lastWellAt).toBeGreaterThan(0)

    const flyAgain = (): number => {
      b.x = -700
      b.y = 200
      b.px = b.x
      b.py = b.y
      b.vx = 340
      b.vy = 0
      let burns = 0
      for (let i = 0; i < 400; i++) {
        step(w, { player: pilot(b, i === peri) })
        burns += eventsOf(w, "oberth").length
      }
      return burns
    }

    // The payout cooldown has expired by now, so only the same-well lock can block this pass.
    b.assist.cd = 0
    b.dashCd = 0
    expect(flyAgain(), "locked out").toBe(0)
    expect(passOpened(w, b)).toBe(false)
    expect(b.assist.lastWellId).toBe(wellId)

    // Park far away until the lock expires, then the same well pays again.
    b.x = 1500
    b.y = 0
    b.px = b.x
    b.py = b.y
    b.vx = 0
    b.vy = 0
    const parkSteps = Math.ceil((CONFIG.assist.sameWell + 1) / DT)
    for (let i = 0; i < parkSteps; i++) step(w, {})
    b.assist.cd = 0
    b.dashCd = 0
    expect(flyAgain(), "allowed after the lock").toBe(1)
  })

  it("the payout cooldown is set by a burn and decays to zero", () => {
    const peri = periTick()
    const r = runFlyby({}, [peri], peri + 10)
    expect(r.burns).toHaveLength(1)
    expect(r.b.assist.cd).toBeGreaterThan(0)
    expect(r.b.assist.cd).toBeLessThanOrEqual(CONFIG.assist.cooldown)
    const steps = Math.ceil(CONFIG.assist.cooldown / DT)
    for (let i = 0; i < steps; i++) tickAssist(r.b.assist, DT)
    expect(r.b.assist.cd).toBe(0)
  })
})

describe("assist: caps and recovery", () => {
  it("surges never stack past the hard caps", () => {
    const b = controlledWorld({ botCount: 0 }).bodies[0]
    grantSurge(b, fakeBurn({ speedMul: 2, thrustMul: 2, surge: 99 }))
    expect(b.assist.surgeMul).toBe(CONFIG.assist.maxSpeedMul)
    expect(b.assist.thrustMul).toBe(CONFIG.assist.maxThrustMul)
    grantSurge(b, fakeBurn({ speedMul: 1.02, thrustMul: 1.01, surge: 1 }))
    expect(b.assist.surgeMul).toBe(CONFIG.assist.maxSpeedMul)
    expect(b.assist.thrustMul).toBe(CONFIG.assist.maxThrustMul)
  })

  it("the surge expires back to neutral", () => {
    const b = controlledWorld({ botCount: 0 }).bodies[0]
    grantSurge(b, fakeBurn({ surge: 2, speedMul: 1.14, thrustMul: 1.07 }))
    expect(b.assist.surge).toBeGreaterThan(0)
    const steps = Math.ceil(2 / DT) + 1
    for (let i = 0; i < steps; i++) tickAssist(b.assist, DT)
    expect(b.assist.surge).toBe(0)
    expect(b.assist.surgeMul).toBe(1)
    expect(b.assist.thrustMul).toBe(1)
    expect(b.assist.surgeFull).toBe(0)
  })

  it("the burn raises the thrust speed ceiling only while the surge lasts", () => {
    const base = controlledWorld({ botCount: 0 })
    const b = base.bodies[0]
    b.vx = maxSpeed(b.mass) - 4
    b.vy = 0
    for (let i = 0; i < 90; i++) step(base, { player: { ax: 1, ay: 0, pull: false } })
    expect(Math.hypot(b.vx, b.vy)).toBeLessThanOrEqual(maxSpeed(b.mass) + 1e-6)

    const boosted = controlledWorld({ botCount: 0 })
    const c = boosted.bodies[0]
    c.vx = maxSpeed(c.mass) - 4
    c.vy = 0
    grantSurge(c, fakeBurn({ surge: 4, speedMul: 1.24, thrustMul: 1.1 }))
    for (let i = 0; i < 90; i++) step(boosted, { player: { ax: 1, ay: 0, pull: false } })
    const fast = Math.hypot(c.vx, c.vy)
    expect(fast).toBeGreaterThan(maxSpeed(c.mass) + 10)
    expect(fast).toBeLessThanOrEqual(maxSpeed(c.mass) * CONFIG.assist.maxSpeedMul + 1e-6)

    for (let i = 0; i < Math.ceil(4 / DT) + 2; i++) step(boosted, { player: { ax: 1, ay: 0, pull: false } })
    expect(c.assist.surge).toBe(0)
    expect(c.assist.surgeMul).toBe(1)
    expect(Math.hypot(c.vx, c.vy)).toBeLessThanOrEqual(maxSpeed(c.mass) + 1e-6)
  })
})

describe("assist: moving wells and bots", () => {
  it("a stationary body is carried through a real moving-well flyby", () => {
    const setup = (): { w: World; b: Body } => {
      const w = controlledWorld({ botCount: 0 })
      const well = addWell(w, "planet", 1000, 0)
      // The well itself does the moving; the body only drifts.
      well.gm = 1e5
      well.orbit = { cx: 0, cy: 0, r: 1000, w: 0.25, phase: -0.5 }
      const b = w.bodies[0]
      b.x = 1000
      b.y = 100
      b.px = b.x
      b.py = b.y
      b.vx = 0
      b.vy = 0
      return { w, b }
    }
    const probe = setup()
    let peri = -1
    for (let i = 0; i < 900 && peri < 0; i++) {
      step(probe.w, {})
      if (probe.b.assist.pass.stage === "out") peri = i
    }
    expect(peri, "a still body can be caught by a moving well").toBeGreaterThan(0)

    const { w, b } = setup()
    const burns: OberthEvent[] = []
    // Stop shortly after the burn: the surge is a short window, not a permanent state.
    for (let i = 0; i < peri + 40; i++) {
      step(w, { player: i === peri ? DASH : NONE })
      for (const e of eventsOf(w, "oberth")) burns.push(e)
    }
    expect(burns).toHaveLength(1)
    expect(burns[0].moving).toBe(true)
    expect(burns[0].speed).toBeGreaterThan(CONFIG.assist.minRelSpeed)
    expect(b.assist.surge).toBeGreaterThan(0)
  })

  it("bots earn a burn through the same seam (no player-only path)", () => {
    const opts: FlybyOptions = { botCount: 1 }
    const probeWorld = flybyWorld(opts)
    const bot = probeWorld.w.bodies[1]
    bot.x = -700
    bot.y = 200
    bot.px = bot.x
    bot.py = bot.y
    bot.vx = 340
    bot.vy = 0
    let peri = -1
    for (let i = 0; i < 600 && peri < 0; i++) {
      step(probeWorld.w, { "bot-1": pilot(bot) })
      if (bot.assist.pass.stage === "out") peri = i
    }
    expect(peri).toBeGreaterThan(0)

    const replay = flybyWorld(opts)
    const rb = replay.w.bodies[1]
    rb.x = -700
    rb.y = 200
    rb.px = rb.x
    rb.py = rb.y
    rb.vx = 340
    rb.vy = 0
    const ids: string[] = []
    for (let i = 0; i < 600; i++) {
      step(replay.w, { "bot-1": pilot(rb, i === peri) })
      for (const e of eventsOf(replay.w, "oberth")) ids.push(e.bodyId)
    }
    expect(ids).toEqual(["bot-1"])
  })

  it("exposes the pass and the window to the HUD", () => {
    const peri = periTick()
    const { w, well, b } = flybyWorld()
    let sawPass = false
    let sawWindow = false
    for (let i = 0; i < peri + 40; i++) {
      step(w, { player: pilot(b, i === peri) })
      const snap = hudSnapshot(w).assist
      if (snap.wellId === well.id && snap.stage !== "none") sawPass = true
      if (snap.window) sawWindow = true
    }
    expect(sawPass).toBe(true)
    expect(sawWindow).toBe(true)
    expect(hudSnapshot(w).assist.surge).toBeGreaterThan(0)
  })
})

describe("assist: determinism and the real arena", () => {
  it("two identical runs (dash included) are JSON-equal and consume no RNG", () => {
    const peri = periTick()
    const a = flybyWorld()
    const c = flybyWorld()
    // makeWell() numbers its wells from a module counter; the ID is not part of the physics.
    a.well.id = "flyby"
    c.well.id = "flyby"
    for (let i = 0; i < 400; i++) {
      const it = { player: pilot(a.b, i === peri) }
      step(a.w, it)
      step(c.w, it)
    }
    expect(JSON.stringify(a.w)).toBe(JSON.stringify(c.w))
    expect(a.w.rngState).toBe(c.w.rngState)
  })

  it("Vast: a scripted flyby of an orbiting well earns a burn (seeded evidence)", () => {
    const build = (): { w: World; well: Well; b: Body } => {
      const w = createWorld({ seed: 4242, difficulty: "normal", arena: "vast", botCount: 1 })
      w.phase = "playing"
      w.countdown = 0
      w.spawnCredit = { debris: -1e9, crystal: -1e9, comet: -1e9, pickup: -1e9 }
      w.nextCosmicIn = 1e9
      const well = w.wells.find((x) => x.orbit !== null && x.kind === "planet")!
      const b = w.bodies[0]
      // 160 u out from the planet, aimed straight through it: a short, fast approach.
      b.x = well.x
      b.y = well.y + 160
      b.px = b.x
      b.py = b.y
      b.vx = 0
      b.vy = -600
      b.energy = CONFIG.energy.max
      return { w, well, b }
    }
    const probe = build()
    let peri = -1
    for (let i = 0; i < 900 && peri < 0; i++) {
      step(probe.w, {})
      if (probe.b.assist.pass.stage === "out") peri = i
    }
    expect(peri, "the real arena offers a flyby").toBeGreaterThan(0)
    expect(probe.b.assist.pass.wellId).toBe(probe.well.id)

    const real = build()
    let got: OberthEvent | null = null
    for (let i = 0; i < 900 && !got; i++) {
      step(real.w, { player: i === peri ? DASH : NONE })
      const ev = eventsOf(real.w, "oberth")
      if (ev.length > 0) got = ev[0]
    }
    expect(got, "the Vast flyby pays").not.toBeNull()
    expect(got!.moving).toBe(true)
    expect(got!.bodyId).toBe("player")
    // eslint-disable-next-line no-console
    console.log(
      `vast flyby well=${got!.wellId} tier=${got!.tier} q=${got!.quality.toFixed(2)} rel=${Math.round(got!.speed)} surge=${got!.surge}s x${got!.speedMul.toFixed(2)}`,
    )
  })

  it("Vast: 20 s of bot-only play does not farm burns", () => {
    const w = createWorld({ seed: 99, difficulty: "hard", arena: "vast" })
    w.phase = "playing"
    w.countdown = 0
    w.nextCosmicIn = 1e9
    const burns: string[] = []
    for (let i = 0; i < Math.ceil(20 / DT); i++) {
      step(w, {})
      for (const e of eventsOf(w, "oberth")) burns.push(e.bodyId)
    }
    expect(burns.length).toBeLessThanOrEqual(2)
  })
})
