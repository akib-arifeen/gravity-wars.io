// Gravity assist ("Oberth burn"): what opens a pass, what grades it, what cannot farm it, and
// what the earned surge is allowed to do. All fixtures are deterministic (fixed step, no RNG in
// this path) and use the shared helpers.

import { describe, expect, it } from "vitest"
import {
  assistView,
  assistWindow,
  burnPromptVisible,
  dashAimedAtBurn,
  grantSurge,
  tickAssist,
  type BurnReady,
} from "../assist"
import { applyCampaignLevel, bossIntent, updateBoss } from "../boss"
import { botIntent, createBotBrain } from "../bots"
import { emptyProgress, levelById, unlockedAbilities } from "../campaign"
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

/** Centre distance at the closest approach of the body's current relative motion (u). */
function impactParameter(b: Body, w: Well): number {
  const rx = b.x - w.x
  const ry = b.y - w.y
  const vx = b.vx - w.vx
  const vy = b.vy - w.vy
  return Math.abs(rx * vy - ry * vx) / (Math.hypot(vx, vy) || 1)
}

interface RunResult {
  w: World
  b: Body
  burns: OberthEvent[]
  /** Legacy fast-pass events; a graded burn must never produce one. */
  slingshots: number
  /** True if this body recorded any periapsis at all during the run. */
  sawPeri: boolean
}

/** Replay the flyby, dashing on the given step indices only. Returns the world after `steps`. */
function runFlyby(opts: FlybyOptions, dashTicks: readonly number[], steps = 200): RunResult {
  const { w, b } = flybyWorld(opts)
  const burns: OberthEvent[] = []
  let slingshots = 0
  let sawPeri = false
  for (let i = 0; i < steps; i++) {
    const wantsDash = dashTicks.indexOf(i) >= 0 && b.dashCd === 0
    step(w, { player: pilot(b, wantsDash) })
    for (const e of eventsOf(w, "oberth")) burns.push(e)
    slingshots += eventsOf(w, "slingshot").length
    if (b.assist.pass.periAt >= 0) sawPeri = true
  }
  return { w, b, burns, slingshots, sawPeri }
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
  })

  it("counts a graded burn as an oberth, never as a legacy slingshot", () => {
    // stats.slingshots feeds the campaign's slingshot goals and the slingshot achievements, so a
    // burn must not touch it: the perk is suppressed for the same pass and the burn has its own
    // counter. Otherwise the new mechanic would make the old goals easier.
    const peri = periTick()
    const r = runFlyby({}, [peri])
    expect(r.burns).toHaveLength(1)
    expect(r.b.stats.oberths).toBe(1)
    expect(r.b.stats.slingshots).toBe(0)
    expect(r.slingshots).toBe(0)
    expect(r.w.events.some((e) => e.type === "slingshot")).toBe(false)
    expect(r.b.slingCd).toBeGreaterThan(0)
  })

  it("keeps a dash aimed at the burn out of the legacy slingshot count", () => {
    // The advertised frame is inbound, a few ticks before periapsis. The dash's own impulse lifts
    // the body past the legacy perk's speed threshold while it sits inside the perk's radius, so
    // without a guard the perk pays on the dash frame — before the periapsis is graded — and the
    // same flyby feeds the slingshot goals the burn is meant to keep out of.
    const peri = periTick()
    const r = runFlyby({}, [peri - 6])
    expect(r.burns).toHaveLength(1)
    expect(r.b.stats.oberths).toBe(1)
    expect(r.b.stats.slingshots).toBe(0)
    expect(r.slingshots).toBe(0)
  })

  it("still pays the legacy slingshot for a fast pass whose dash is not aimed at the burn", () => {
    // Thrust alone is capped at maxSpeed, so the perk only fires once something else lifts the
    // body past 1.15 * maxSpeed. A dash outside the burn window does that and is not the burn
    // input, so the classic fast-pass payout must survive.
    const peri = periTick()
    const r = runFlyby({}, [peri - Math.ceil(1 / DT)])
    expect(r.b.stats.slingshots).toBeGreaterThan(0)
    expect(r.b.stats.oberths).toBe(0)
    expect(r.burns).toHaveLength(0)
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

describe("assist: the advertised window is the difficulty-scaled one", () => {
  // The prompt must mean exactly one thing: dashing on it is the burn. The HUD advertises
  // assistWindow(body) = CONFIG.assist.window * difficulty.assistWindowMul, so the grader must use
  // that same window. Using the unscaled value pays the wrong reward at Easy's earliest advertised
  // frame (the legacy fast-pass perk instead of the burn) and, at Hard, suppresses the legacy perk
  // for a dash it then refuses to grade.

  it("Easy: a dash on the very first advertised frame is the burn, not the legacy perk", () => {
    const { w, b } = flybyWorld({ difficulty: "easy" })
    let first = -1
    let periIn = 0
    for (let i = 0; i < 400 && first < 0; i++) {
      const v = assistView(w, b)
      if (v.window) {
        first = i
        periIn = v.periIn ?? 0
      } else step(w, { player: pilot(b) })
    }
    expect(first, "Easy advertises a frame").toBeGreaterThanOrEqual(0)
    // The regression: this frame is inside Easy's window and outside the unscaled one.
    expect(periIn).toBeGreaterThan(CONFIG.assist.window)
    expect(periIn).toBeLessThanOrEqual(assistWindow(b))

    let burns = 0
    let slingshots = 0
    for (let i = 0; i < 400; i++) {
      step(w, { player: pilot(b, i === 0) })
      burns += eventsOf(w, "oberth").length
      slingshots += eventsOf(w, "slingshot").length
    }
    expect(burns).toBe(1)
    expect(b.stats.oberths).toBe(1)
    // A graded burn keeps the same flyby out of the legacy count; one reward, never two.
    expect(b.stats.slingshots).toBe(0)
    expect(slingshots).toBe(0)
  })

  it("Hard: an unscaled-window frame does not burn and still pays the legacy perk", () => {
    // Ticks 111-114 of this fixture put periIn at 0.30-0.31 s: inside CONFIG.assist.window (0.35)
    // but outside Hard's 0.2625, so Hard never advertises them and the dash is not a burn. The dash
    // is prograde and still fast and close enough for the legacy fast-pass perk, which must pay: a
    // dash that is not an eligible burn aim must not suppress it.
    for (const tick of [111, 112]) {
      const { w, b } = flybyWorld({ difficulty: "hard" })
      let advertised = false
      let burns = 0
      let slingshots = 0
      for (let i = 0; i <= tick; i++) {
        if (assistView(w, b).window) advertised = true
        step(w, { player: pilot(b, i === tick) })
        burns += eventsOf(w, "oberth").length
        slingshots += eventsOf(w, "slingshot").length
      }
      expect(advertised, `tick ${tick}: never advertised at Hard`).toBe(false)
      expect(b.assist.pass.dashPrograde, `tick ${tick}: the dash itself was prograde`).toBe(true)
      expect(dashAimedAtBurn(b), `tick ${tick}: not an eligible burn aim`).toBe(false)
      expect(burns, `tick ${tick}: no burn`).toBe(0)
      expect(b.stats.oberths).toBe(0)
      expect(b.assist.surge).toBe(0)
      expect(slingshots, `tick ${tick}: the legacy perk still pays`).toBe(1)
      expect(b.stats.slingshots).toBe(1)
    }
  })
})

describe("assist: only a prograde or tangential dash is a burn", () => {
  it("a retrograde dash on an advertised frame never burns and suppresses nothing", () => {
    // The prompt is explicit: it names the direction. A dash aimed against the motion is a pure
    // movement tool even in the window: it must not pay, and it must not deny the legacy perk.
    const { w, b } = flybyWorld()
    let first = -1
    for (let i = 0; i < 300 && first < 0; i++) {
      if (assistView(w, b).window) first = i
      else step(w, { player: pilot(b) })
    }
    expect(first, "the burn prompt is up").toBeGreaterThanOrEqual(0)
    expect(b.energy).toBeGreaterThanOrEqual(CONFIG.abilities.dash.cost)

    const s = Math.hypot(b.vx, b.vy)
    step(w, { player: { ax: -b.vx / s, ay: -b.vy / s, pull: false, dash: true } })
    expect(b.assist.pass.dashPrograde, "the dash is retrograde").toBe(false)
    expect(dashAimedAtBurn(b), "a retrograde dash is not a burn aim").toBe(false)
    expect(b.slingCd, "the legacy perk was not suppressed").toBe(0)

    let burns = 0
    for (let i = 0; i < 300; i++) {
      step(w, { player: pilot(b) })
      burns += eventsOf(w, "oberth").length
    }
    expect(burns).toBe(0)
    expect(b.stats.oberths).toBe(0)
    expect(b.assist.surge).toBe(0)
    expect(b.assist.surgeMul).toBe(1)
  })
})

describe("assist: a dash cannot manufacture the periapsis it is graded on", () => {
  // The review fixture: star at the origin, body at (-700, 200) at 340 u/s under prograde thrust.
  // Flown with no dash at all it crosses one real periapsis; that measurement is the baseline and
  // a dash is only ever judged against a periapsis the trajectory itself produced.
  it("establishes its own baseline periapsis without any dash", () => {
    const { w, well, b } = flybyWorld()
    let peri = -1
    for (let i = 0; i < 600 && peri < 0; i++) {
      step(w, { player: pilot(b) })
      if (b.assist.pass.stage === "out") peri = i
    }
    expect(peri, "the independent pass has a periapsis").toBeGreaterThan(0)
    expect(peri * DT).toBeGreaterThan(2.1)
    expect(peri * DT).toBeLessThan(2.4)
    expect(b.assist.pass.periDist).toBeGreaterThan(140)
    expect(b.assist.pass.periDist).toBeLessThan(190)
    expect(b.assist.pass.periDist).toBeLessThan(well.radius * CONFIG.assist.periBand)
    expect(b.assist.pass.periRelSpeed).toBeGreaterThan(CONFIG.assist.minRelSpeed)
    expect(b.stats.oberths).toBe(0)
    expect(b.assist.surge).toBe(0)
  })

  it("an outward (retrograde) dash on the approach pays nothing", () => {
    // Aiming away from the well while still approaching is retrograde, so it can never be a burn.
    // prevVr now holds the dash-free radial value, so the next step records the crossing the
    // dash-free motion really had instead of hiding it; grade() then rejects that crossing on
    // direction and timing. What has to stay true is the payoff: zero.
    const { w, well, b } = flybyWorld()
    const dashTick = Math.round(1.6 / DT)
    let burns = 0
    let retrograde = false
    for (let i = 0; i <= dashTick; i++) {
      if (i === dashTick) {
        const dx = b.x - well.x
        const dy = b.y - well.y
        const d = Math.hypot(dx, dy) || 1
        step(w, { player: { ax: dx / d, ay: dy / d, pull: false, dash: true } })
        retrograde = !b.assist.pass.dashPrograde
      } else {
        step(w, { player: pilot(b) })
      }
      burns += eventsOf(w, "oberth").length
    }
    // Let the pass run out: the outward impulse must not be graded as a periapsis at 253 u.
    for (let i = 0; i < 240; i++) {
      step(w, { player: pilot(b) })
      burns += eventsOf(w, "oberth").length
    }
    expect(retrograde, "the outward aim is retrograde on this approach").toBe(true)
    expect(burns).toBe(0)
    expect(b.assist.surge).toBe(0)
    expect(b.stats.oberths).toBe(0)
  })

  it("a slow radial fall is not rewarded through an outward (retrograde) dash", () => {
    // Inside the band, closing at only 100 u/s with a tangential component: a real (if shallow)
    // pass. The outward dash flips the radial sign on the spot, which used to be hidden from the
    // flip test; prevVr now records the dash-free crossing, so grade() sees it — and rejects it,
    // because the outward aim is retrograde. The reward must stay zero either way.
    const build = () => {
      const w = controlledWorld({ botCount: 0 })
      const well = addWell(w, "star", 0, 0)
      well.gm = 2e5
      const b = w.bodies[0]
      b.x = -300
      b.y = 0
      b.px = b.x
      b.py = b.y
      b.vx = 100
      b.vy = 200
      b.energy = CONFIG.energy.max
      return { w, well, b }
    }
    // Control: without the dash this pass really does cross periapsis.
    const control = build()
    let controlPeri = -1
    for (let i = 0; i < 200 && controlPeri < 0; i++) {
      step(control.w, {})
      if (control.b.assist.pass.stage === "out") controlPeri = i
    }
    expect(controlPeri, "the control pass has a real periapsis").toBeGreaterThan(0)

    const { w, well, b } = build()
    let opened = -1
    let burns = 0
    let retrograde = false
    for (let i = 0; i < 200; i++) {
      if (opened < 0 && b.assist.pass.wellId !== "") opened = i
      const dash = opened >= 0 && i === opened + 2
      let intent: Intent = NONE
      if (dash) {
        const dx = b.x - well.x
        const dy = b.y - well.y
        const d = Math.hypot(dx, dy) || 1
        intent = { ax: dx / d, ay: dy / d, pull: false, dash: true }
      }
      step(w, { player: intent })
      if (dash) retrograde = !b.assist.pass.dashPrograde
      burns += eventsOf(w, "oberth").length
    }
    expect(opened).toBeGreaterThanOrEqual(0)
    expect(retrograde, "the outward aim is retrograde on this fall").toBe(true)
    expect(burns).toBe(0)
    expect(b.stats.oberths).toBe(0)
    expect(b.assist.surge).toBe(0)
  })

  it("still pays a prograde dash shortly before the natural periapsis", () => {
    const early = periTick() - Math.round(0.2 / DT)
    const r = runFlyby({}, [early])
    expect(r.burns).toHaveLength(1)
    expect(r.b.stats.oberths).toBe(1)
  })

  it("still pays a prograde dash shortly after the natural periapsis", () => {
    const late = periTick() + Math.round(0.2 / DT)
    const r = runFlyby({}, [late])
    expect(r.burns).toHaveLength(1)
    expect(r.b.stats.oberths).toBe(1)
  })

  it("an outward-radial but prograde dash one genuine tick early still pays exactly once", () => {
    // prevVr must be the dash-free radial value the flip test used. On this frame the aim is
    // mostly outward (it flips the real radial velocity on the spot) but still prograde, so the
    // pass is a genuine, prompt-advertised burn: the crossing it is graded on happens on the next
    // step, from the dash-free sign stored here. Storing the post-impulse value instead would
    // leave prevVr positive, the next step could never see prevVr < 0, and this real flyby would
    // silently never pay.
    const { w: probe, well: probeWell, b: probeBody } = flybyWorld()
    let peri = -1
    for (let i = 0; i < 600 && peri < 0; i++) {
      step(probe, { player: pilot(probeBody) })
      if (probeBody.assist.pass.stage === "out") peri = i
    }
    expect(peri, "the reference pass has a periapsis").toBeGreaterThan(0)
    expect(probeWell.id).toBe(probeBody.assist.pass.wellId)

    const { w, well, b } = flybyWorld()
    const dashTick = peri - 8
    for (let i = 0; i < dashTick; i++) step(w, { player: pilot(b) })
    const view = assistView(w, b)
    expect(view.window, "the burn prompt is up on the dash frame").toBe(true)

    // Velocity direction plus half an outward radial unit: prograde (dot > 0) and clearly outward.
    const vs = Math.hypot(b.vx, b.vy)
    const dx = b.x - well.x
    const dy = b.y - well.y
    const d = Math.hypot(dx, dy)
    let ax = b.vx / vs + 0.5 * (dx / d)
    let ay = b.vy / vs + 0.5 * (dy / d)
    const an = Math.hypot(ax, ay)
    ax /= an
    ay /= an
    expect(ax * (b.vx - well.vx) + ay * (b.vy - well.vy), "the aim is prograde").toBeGreaterThan(0)

    step(w, { player: { ax, ay, pull: false, dash: true } })
    expect(b.assist.pass.dashPrograde, "the dash is prograde").toBe(true)
    // The dash's own outward part flipped the real radial velocity, so the crossing is recorded on
    // the next step from the dash-free sign kept in prevVr.
    let burns = eventsOf(w, "oberth").length
    for (let i = 0; i < 79; i++) {
      step(w, { player: pilot(b) })
      burns += eventsOf(w, "oberth").length
    }
    expect(burns, "exactly one burn").toBe(1)
    expect(b.stats.oberths).toBe(1)
    expect(b.assist.surge).toBeGreaterThan(0)
  })
})

describe("assist: a real flyby is required", () => {
  it("a dash with no well never pays", () => {
    const w = controlledWorld({ botCount: 0 })
    const b = w.bodies[0]
    for (let i = 0; i < 240; i++) step(w, { player: b.dashCd === 0 ? DASH : NONE })
    expect(eventsOf(w, "oberth")).toHaveLength(0)
    expect(b.assist.surge).toBe(0)
  })
})

describe("assist: the prompt only advertises payable passes", () => {
  const periBand = (w: Well): number => w.radius * CONFIG.assist.periBand

  /** A flyby at the given impact parameter, dashing on the first step after its periapsis. */
  function distantFlyby(offset: number) {
    const { w, well, b } = flybyWorld({ offset })
    let opened = -1
    let impact = 0
    let windowFrames = 0
    let peri = -1
    let periDist = 0
    let burns = 0
    for (let i = 0; i < 420; i++) {
      if (opened < 0 && b.assist.pass.wellId !== "") {
        opened = i
        impact = impactParameter(b, well)
      }
      if (assistView(w, b).window) windowFrames++
      step(w, { player: pilot(b, peri >= 0 && i === peri + 1) })
      burns += eventsOf(w, "oberth").length
      if (peri < 0 && b.assist.pass.stage === "out") {
        peri = i
        periDist = b.assist.pass.periDist
      }
    }
    return { well, b, opened, impact, windowFrames, peri, periDist, burns }
  }

  it("impact parameter 600: never a window, and a dash at that periapsis pays nothing", () => {
    const r = distantFlyby(600)
    expect(r.opened).toBeGreaterThanOrEqual(0)
    expect(r.impact).toBeGreaterThan(550)
    expect(r.impact).toBeGreaterThan(periBand(r.well))
    expect(r.peri, "the pass really has a periapsis").toBeGreaterThan(0)
    expect(r.periDist).toBeGreaterThan(periBand(r.well))
    expect(r.windowFrames, "a pass that cannot pay is never advertised").toBe(0)
    expect(r.burns).toBe(0)
    expect(r.b.stats.oberths).toBe(0)
  })

  it("a periapsis just outside the periBand is not advertised before or after it", () => {
    const r = distantFlyby(400)
    expect(r.impact).toBeGreaterThan(periBand(r.well))
    expect(r.peri).toBeGreaterThan(0)
    expect(r.periDist).toBeGreaterThan(periBand(r.well))
    expect(r.windowFrames).toBe(0)
    expect(r.burns).toBe(0)
  })

  it("a head-on plunge into the well is a collision, not an advertised pass", () => {
    const { w, well, b } = flybyWorld({ offset: 0 })
    expect(impactParameter(b, well)).toBeLessThan(well.radius + b.radius)
    let windowFrames = 0
    for (let i = 0; i < 240 && b.alive; i++) {
      if (assistView(w, b).window) windowFrames++
      step(w, { player: pilot(b) })
    }
    expect(windowFrames).toBe(0)
    expect(b.alive).toBe(false)
  })

  it("a payable pass is hidden while the payout cooldown or the same-well lock is on", () => {
    const find = (): { w: World; b: Body; found: boolean } => {
      const f = flybyWorld()
      let found = false
      for (let i = 0; i < 300 && !found; i++) {
        if (assistView(f.w, f.b).window) found = true
        else step(f.w, { player: pilot(f.b) })
      }
      return { w: f.w, b: f.b, found }
    }
    const payable = find()
    expect(payable.found).toBe(true)
    expect(assistView(payable.w, payable.b).window).toBe(true)

    const cooling = find()
    expect(cooling.found).toBe(true)
    cooling.b.assist.cd = 1
    expect(assistView(cooling.w, cooling.b).window).toBe(false)

    const locked = find()
    expect(locked.found).toBe(true)
    locked.b.assist.lastWellId = locked.b.assist.pass.wellId
    locked.b.assist.lastWellAt = locked.w.time
    expect(assistView(locked.w, locked.b).window).toBe(false)

    const paid = find()
    expect(paid.found).toBe(true)
    paid.b.assist.pass.paid = true
    expect(assistView(paid.w, paid.b).window).toBe(false)
  })

  it("dashing on the very first advertised frame always pays", () => {
    for (const offset of [100, 200, 240]) {
      const { w, b } = flybyWorld({ offset })
      let first = -1
      for (let i = 0; i < 300 && first < 0; i++) {
        if (assistView(w, b).window) first = i
        else step(w, { player: pilot(b) })
      }
      expect(first, `offset ${offset}: a payable pass is advertised`).toBeGreaterThanOrEqual(0)
      let burns = 0
      for (let i = 0; i < 400; i++) {
        step(w, { player: pilot(b, i === 0) })
        burns += eventsOf(w, "oberth").length
      }
      expect(burns, `offset ${offset}: the advertised dash paid`).toBe(1)
      expect(b.stats.oberths).toBe(1)
    }
  })
})

describe("assist: when the burn prompt may show", () => {
  const COST = CONFIG.abilities.dash.cost

  it("requires a payable window, a ready dash, enough energy and an unlocked ability", () => {
    expect(burnPromptVisible(true, 0, COST, false)).toBe(true)
    expect(burnPromptVisible(true, 0, CONFIG.energy.max, false)).toBe(true)
    expect(burnPromptVisible(false, 0, COST, false), "no payable window").toBe(false)
    expect(burnPromptVisible(true, 0.1, COST, false), "dash cooling down").toBe(false)
    expect(burnPromptVisible(true, 0, COST - 0.01, false), "cannot afford it").toBe(false)
    expect(burnPromptVisible(true, 0, COST, true), "ability locked").toBe(false)
  })

  it("is hidden for a campaign-locked dash", () => {
    // A fresh campaign has no stars, and dash unlocks with the first one.
    const locked = !unlockedAbilities(emptyProgress()).includes("dash")
    expect(locked).toBe(true)
    expect(burnPromptVisible(true, 0, CONFIG.energy.max, locked)).toBe(false)
  })

  it("is hidden when the pass is payable but the player cannot afford the dash", () => {
    const { w, b } = flybyWorld()
    let first = -1
    for (let i = 0; i < 300 && first < 0; i++) {
      if (hudSnapshot(w).assist.window) first = i
      else step(w, { player: pilot(b) })
    }
    expect(first).toBeGreaterThanOrEqual(0)
    b.energy = COST - 1
    const snap = hudSnapshot(w)
    expect(snap.assist.window).toBe(true)
    expect(burnPromptVisible(snap.assist.window, snap.dashCd, snap.energy, false)).toBe(false)
  })

  it("goes away the moment the dash is spent", () => {
    const { w, b } = flybyWorld()
    let first = -1
    for (let i = 0; i < 300 && first < 0; i++) {
      const snap = hudSnapshot(w)
      if (burnPromptVisible(snap.assist.window, snap.dashCd, snap.energy, false)) first = i
      else step(w, { player: pilot(b) })
    }
    expect(first).toBeGreaterThanOrEqual(0)
    step(w, { player: pilot(b, true) })
    const after = hudSnapshot(w)
    expect(after.dashCd).toBeGreaterThan(0)
    expect(burnPromptVisible(after.assist.window, after.dashCd, after.energy, false)).toBe(false)
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
  // The caps must be reachable: they sit at or above the best real tier, and the best real tier is
  // what a perfect pass grants. Asserting a synthetic 2x multiplier would test the clamp, not the
  // game, so this drives the actual top tier from CONFIG.
  const tiers = CONFIG.assist.tiers
  const top = tiers[tiers.length - 1]
  const weak = tiers[0]

  it("the configured caps are never below the best real tier", () => {
    expect(top.speedMul).toBeLessThanOrEqual(CONFIG.assist.maxSpeedMul)
    expect(top.thrustMul).toBeLessThanOrEqual(CONFIG.assist.maxThrustMul)
  })

  it("the best real tier is granted once, never compounded, and never downgraded", () => {
    const b = controlledWorld({ botCount: 0 }).bodies[0]
    grantSurge(b, fakeBurn({ speedMul: top.speedMul, thrustMul: top.thrustMul, surge: top.surge }))
    expect(b.assist.surge).toBe(top.surge)
    expect(b.assist.surgeMul).toBe(top.speedMul)
    expect(b.assist.thrustMul).toBe(top.thrustMul)

    grantSurge(b, fakeBurn({ speedMul: top.speedMul, thrustMul: top.thrustMul, surge: top.surge }))
    expect(b.assist.surge).toBe(top.surge)
    expect(b.assist.surgeMul).toBe(top.speedMul)
    expect(b.assist.thrustMul).toBe(top.thrustMul)

    grantSurge(b, fakeBurn({ speedMul: weak.speedMul, thrustMul: weak.thrustMul, surge: weak.surge }))
    expect(b.assist.surge).toBe(top.surge)
    expect(b.assist.surgeMul).toBe(top.speedMul)
    expect(b.assist.thrustMul).toBe(top.thrustMul)
  })

  it("a real graded burn stays inside the caps", () => {
    const peri = periTick()
    const r = runFlyby({}, [peri])
    expect(r.burns).toHaveLength(1)
    expect(r.b.assist.surgeMul).toBeLessThanOrEqual(CONFIG.assist.maxSpeedMul)
    expect(r.b.assist.thrustMul).toBeLessThanOrEqual(CONFIG.assist.maxThrustMul)
    expect(r.b.assist.surge).toBeLessThanOrEqual(top.surge)
    expect(Math.hypot(r.b.vx, r.b.vy)).toBeLessThanOrEqual(CONFIG.body.hardSpeedCap + 1e-6)
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
    let maxSurge = 0
    let maxSpeedMul = 1
    let maxThrustMul = 1
    let maxSpeed = 0
    for (let i = 0; i < 600; i++) {
      step(replay.w, { "bot-1": pilot(rb, i === peri) })
      for (const e of eventsOf(replay.w, "oberth")) ids.push(e.bodyId)
      maxSurge = Math.max(maxSurge, rb.assist.surge)
      maxSpeedMul = Math.max(maxSpeedMul, rb.assist.surgeMul)
      maxThrustMul = Math.max(maxThrustMul, rb.assist.thrustMul)
      maxSpeed = Math.max(maxSpeed, Math.hypot(rb.vx, rb.vy))
    }
    expect(ids).toEqual(["bot-1"])
    // The mechanic is shared, so the bot's reward is bounded exactly like the player's: one burn,
    // the best real tier at most, and never past the hard speed cap.
    const tiers = CONFIG.assist.tiers
    expect(maxSurge).toBeLessThanOrEqual(tiers[tiers.length - 1].surge)
    expect(maxSpeedMul).toBeLessThanOrEqual(CONFIG.assist.maxSpeedMul)
    expect(maxThrustMul).toBeLessThanOrEqual(CONFIG.assist.maxThrustMul)
    expect(maxSpeed).toBeLessThanOrEqual(CONFIG.body.hardSpeedCap + 1e-6)
    expect(rb.stats.slingshots).toBe(0)
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

describe("assist: the boss shares the mechanic without a runaway", () => {
  const LEVEL = "fall-4"

  function bossFlyby() {
    const level = levelById(LEVEL)!
    const world = createWorld({
      seed: level.seed,
      difficulty: level.difficulty,
      arena: level.arena,
      botCount: level.bots,
    })
    world.phase = "playing"
    world.countdown = 0
    world.timeLeft = 1e9
    const encounter = applyCampaignLevel(world, level)!
    const bossId = encounter.boss!.id
    const body = world.bodies.find((b) => b.id === bossId)!
    const star = world.wells.find((w) => w.kind === "star")!
    // A tangential pass: deep enough to pay, high enough to clear the star and the boss's own hull.
    body.x = star.x
    body.y = star.y + 300
    body.px = body.x
    body.py = body.y
    body.vx = -350
    body.vy = -100
    body.energy = CONFIG.energy.max
    return { world, bossId, body, star }
  }

  it("a boss body earns one capped burn through the same seam", () => {
    const { world, bossId, body, star } = bossFlyby()
    const tiers = CONFIG.assist.tiers
    let peri = -1
    let burns = 0
    let tier = ""
    let maxSurge = 0
    let maxSpeedMul = 1
    let maxThrustMul = 1
    let maxSpeed = 0
    let minDist = Infinity
    let slingshotsOnBurn = 0
    for (let i = 0; i < 400 && body.alive; i++) {
      minDist = Math.min(minDist, Math.hypot(body.x - star.x, body.y - star.y))
      if (peri < 0 && body.assist.pass.stage === "out") peri = i
      const intents: Record<string, Intent> = {}
      if (i === peri) {
        const s = Math.hypot(body.vx, body.vy) || 1
        intents[bossId] = { ax: body.vx / s, ay: body.vy / s, pull: false, dash: true }
      }
      step(world, intents)
      for (const e of eventsOf(world, "oberth")) {
        if (e.bodyId === bossId) {
          burns++
          tier = e.tier
          // The burn suppresses the legacy fast-pass perk on its own step.
          slingshotsOnBurn = eventsOf(world, "slingshot").filter((s) => s.bodyId === bossId).length
        }
      }
      maxSurge = Math.max(maxSurge, body.assist.surge)
      maxSpeedMul = Math.max(maxSpeedMul, body.assist.surgeMul)
      maxThrustMul = Math.max(maxThrustMul, body.assist.thrustMul)
      maxSpeed = Math.max(maxSpeed, Math.hypot(body.vx, body.vy))
    }
    expect(peri, "the boss really flies a pass").toBeGreaterThan(0)
    expect(minDist).toBeLessThan(star.radius * CONFIG.assist.periBand)
    expect(body.alive).toBe(true)
    expect(burns).toBe(1)
    expect(["graze", "burn", "oberth"]).toContain(tier)
    expect(maxSurge).toBeLessThanOrEqual(tiers[tiers.length - 1].surge)
    expect(maxSpeedMul).toBeLessThanOrEqual(CONFIG.assist.maxSpeedMul)
    expect(maxThrustMul).toBeLessThanOrEqual(CONFIG.assist.maxThrustMul)
    expect(maxSpeed).toBeLessThanOrEqual(CONFIG.body.hardSpeedCap + 1e-6)
    expect(body.stats.oberths).toBe(1)
    expect(slingshotsOnBurn, "a burn never pays a slingshot on the same step").toBe(0)
  })

  it("25 s of the seeded encounter never farms a burn or a surge", () => {
    const level = levelById(LEVEL)!
    const world = createWorld({
      seed: level.seed,
      difficulty: level.difficulty,
      arena: level.arena,
      botCount: level.bots,
    })
    world.phase = "playing"
    world.countdown = 0
    world.timeLeft = 1e9
    const encounter = applyCampaignLevel(world, level)!
    const boss = encounter.boss!
    const brain = createBotBrain("player", "hard", level.seed + 5)
    const intents = new Map<string, Intent>()
    let burns = 0
    let maxSpeedMul = 1
    let maxSpeed = 0
    for (let i = 0; i < Math.ceil(25 / DT) && world.phase === "playing"; i++) {
      intents.clear()
      const me = world.bodies[0]
      if (me.alive) intents.set(me.id, botIntent(world, brain))
      const bossBody = world.bodies.find((b) => b.id === boss.id)
      if (bossBody && !boss.defeated) intents.set(boss.id, bossIntent(world, boss))
      step(world, intents)
      updateBoss(world, encounter)
      for (const e of eventsOf(world, "oberth")) if (e.bodyId === boss.id) burns++
      if (bossBody) {
        maxSpeedMul = Math.max(maxSpeedMul, bossBody.assist.surgeMul)
        maxSpeed = Math.max(maxSpeed, Math.hypot(bossBody.vx, bossBody.vy))
      }
    }
    expect(burns).toBeLessThanOrEqual(1)
    expect(maxSpeedMul).toBeLessThanOrEqual(CONFIG.assist.maxSpeedMul)
    expect(maxSpeed).toBeLessThanOrEqual(CONFIG.body.hardSpeedCap + 1e-6)
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
    let slingshotsOnBurn = -1
    for (let i = 0; i < 900 && !got; i++) {
      step(real.w, { player: i === peri ? DASH : NONE })
      const ev = eventsOf(real.w, "oberth")
      if (ev.length > 0) {
        got = ev[0]
        slingshotsOnBurn = eventsOf(real.w, "slingshot").length
      }
    }
    expect(got, "the Vast flyby pays").not.toBeNull()
    expect(got!.moving).toBe(true)
    expect(got!.bodyId).toBe("player")
    expect(got!.quality).toBeGreaterThan(0)
    expect(got!.surge).toBeGreaterThan(0)
    expect(slingshotsOnBurn, "the burn itself never pays a slingshot").toBe(0)
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
