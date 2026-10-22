// Phase A engine mechanics, written from the contract only (types.ts, config.ts and the doc
// comments of engine.ts / cosmic.ts). Each describe is one area; comments cite the contract
// sentence being checked. Tunables come from CONFIG by name.

import { describe, expect, it } from "vitest"
import { CONFIG } from "../config"
import {
  absorbRatio,
  canAbsorb,
  cloneWorld,
  createWorld,
  hudSnapshot,
  maxSpeed,
  pullRadius,
  radiusForMass,
  repulseRadius,
  step,
  thrustAccel,
} from "../engine"
import type { CosmicEvent, DeathCause, Intent, LethalWellKind, PowerUpKind, WellKind, World } from "../types"
import {
  DT,
  addWell,
  addZone,
  armed,
  controlledWorld,
  credit,
  endlessWorld,
  dist,
  eventsOf,
  expectClose,
  intent,
  makeDebris,
  makePickup,
  makeWell,
  placeBody,
  setMass,
  snapshot,
  stepN,
} from "./helpers"

const DRAG = Math.exp(-CONFIG.body.drag * DT)
const DEBRIS_DRAG = Math.exp(-CONFIG.debris.drag * DT)
const COMET_DRAG = Math.exp(-CONFIG.comets.drag * DT)
const AB = CONFIG.abilities
const PLAYER_MASS = CONFIG.body.startMass

function press(extra: Partial<Intent>): Intent {
  return { ax: 0, ay: 0, pull: false, ...extra }
}

/** After the thrust-speed rule of step 3f, for thrust parallel to the incoming velocity. */
function capAligned(vNo: number, aTdt: number, ms: number): number {
  const vNew = vNo + aTdt
  if (vNew > ms && vNew > vNo) return Math.max(ms, vNo)
  return vNew
}

function oneEvent<T extends World["events"][number]["type"]>(w: World, type: T) {
  const evs = eventsOf(w, type)
  expect(evs, `expected exactly one ${type} event`).toHaveLength(1)
  return evs[0]
}

// ---------------------------------------------------------------------------------------------
describe("createWorld: Phase A fields", () => {
  it("bodies start with every ability timer, charge and power-up at zero and lastHitBy empty", () => {
    // Contract (createWorld step 2): "all timers/cooldowns/ult 0, power all 0, lastHitBy "", lastHitAt -1e9".
    const w = createWorld({ seed: 3, difficulty: "normal" })
    for (const b of w.bodies) {
      expect(b.dashCd).toBe(0)
      expect(b.repulseCd).toBe(0)
      expect(b.ult).toBe(0)
      expect(b.ultActive).toBe(0)
      expect(b.slingCd).toBe(0)
      expect(b.power).toEqual({ overdrive: 0, magnet: 0, phase: 0 })
      expect(b.lastHitBy).toBe("")
      expect(b.lastHitAt).toBe(-1e9)
      expect(b.idleTime).toBe(0)
    }
  })

  it("world-level Phase A state: arena, pickups, zones, cosmic schedule, spawn credit", () => {
    // Contract (createWorld step 4): "pickups = [], cosmic = null, nextCosmicId = 1, spawnCredit all 0,
    // nextCosmicIn = a draw in CONFIG.cosmic.firstIn (or 1e9 when opts.cosmic === false)".
    const w = createWorld({ seed: 3, difficulty: "normal" })
    expect(w.arena).toBe("classic")
    expect(w.arenaBase).toBe(CONFIG.arena.radius)
    expect(w.arenaRadius).toBe(w.arenaBase)
    expect(w.pickups).toEqual([])
    expect(w.cosmic).toBeNull()
    expect(w.nextCosmicId).toBe(1)
    expect(w.spawnCredit).toEqual({ debris: 0, crystal: 0, comet: 0, pickup: 0 })
    expect(w.nextCosmicIn).toBeGreaterThanOrEqual(CONFIG.cosmic.firstIn[0])
    expect(w.nextCosmicIn).toBeLessThanOrEqual(CONFIG.cosmic.firstIn[1])
    expect(createWorld({ seed: 3, difficulty: "normal", cosmic: false }).nextCosmicIn).toBe(1e9)
    expect(w.debrisField.ringShare).toBe(0)
  })

  it("classic stays the default arena: an explicit arena: 'classic' is JSON-identical", () => {
    const a = createWorld({ seed: 12, difficulty: "hard" })
    const b = createWorld({ seed: 12, difficulty: "hard", arena: "classic" })
    expect(snapshot(a)).toBe(snapshot(b))
  })

  it("classic wells carry every Well field (fixed, lethal, no orbit or beam)", () => {
    const w = createWorld({ seed: 5, difficulty: "normal" })
    for (const well of w.wells) {
      expect(well.vx).toBe(0)
      expect(well.vy).toBe(0)
      expect(well.lethal).toBe(true)
      expect(well.orbit).toBeNull()
      expect(well.beam).toBeNull()
    }
    const star = w.wells.find((x) => x.kind === "star")!
    expect(star.chargeRate).toBe(CONFIG.well.starChargeRate)
    const hole = w.wells.find((x) => x.kind === "blackhole")!
    expect(hole.chargeRate).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("Dash", () => {
  function dashWorld(v: [number, number] = [0, 0]) {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0, v[0], v[1])
    armed(w)
    return w
  }

  it("kicks along the thrust direction and may exceed maxSpeed", () => {
    // "direction u = a/|a| ... impulse = u * dash.impulse (added in 3f)"; thrust cannot push past
    // maxSpeed but the impulse is part of vNo, so the dash can.
    const w = dashWorld()
    step(w, { player: press({ ax: 1, dash: true }) })
    const ms = maxSpeed(PLAYER_MASS)
    const expected = capAligned(AB.dash.impulse, thrustAccel(PLAYER_MASS) * DT, ms) * DRAG
    expectClose(w.bodies[0].vx, Math.min(expected, CONFIG.body.hardSpeedCap), 1e-9, "vx")
    expectClose(w.bodies[0].vy, 0, 1e-9, "vy")
    expect(w.bodies[0].vx).toBeGreaterThan(ms * DRAG)
  })

  it("follows an arbitrary thrust direction (unit vector of the clamped intent)", () => {
    const w = dashWorld()
    step(w, { player: press({ ax: 3, ay: 4, dash: true }) })
    const b = w.bodies[0]
    expectClose(b.vx / b.vy, 0.75, 1e-9, "direction ratio")
    expect(b.vx).toBeGreaterThan(0)
  })

  it("coasting: dashes along the current velocity", () => {
    // "else v/|v| if |v| >= 1e-6".
    const w = dashWorld([0, -100])
    step(w, { player: press({ dash: true }) })
    const b = w.bodies[0]
    expectClose(b.vx, 0, 1e-9, "vx")
    expectClose(b.vy, -Math.min((100 + AB.dash.impulse) * DRAG, CONFIG.body.hardSpeedCap), 1e-9, "vy")
  })

  it("at rest with no thrust: no dash, no cost, no cooldown, no event", () => {
    // "else no dash (and no cost)".
    const w = dashWorld()
    w.bodies[0].energy = 50
    step(w, { player: press({ dash: true }) })
    const b = w.bodies[0]
    expect(b.vx).toBe(0)
    expect(b.vy).toBe(0)
    expect(b.dashCd).toBe(0)
    expect(b.stats.dashes).toBe(0)
    expectClose(b.energy, 50 + CONFIG.energy.regen * DT, 1e-9, "energy")
    expect(eventsOf(w, "dash")).toHaveLength(0)
  })

  it("costs energy, starts the cooldown, counts the stat and emits a dash event with the direction", () => {
    const w = dashWorld([100, 0])
    w.bodies[0].energy = 50
    step(w, { player: press({ dash: true }) })
    const b = w.bodies[0]
    expectClose(b.energy, 50 - AB.dash.cost + CONFIG.energy.regen * DT, 1e-9, "energy")
    expect(b.dashCd).toBe(AB.dash.cooldown)
    expect(b.stats.dashes).toBe(1)
    const ev = oneEvent(w, "dash")
    expect(ev.bodyId).toBe("player")
    expectClose(ev.dx, 1, 1e-9)
    expectClose(ev.dy, 0, 1e-9)
  })

  it("is ignored while on cooldown, and works again once the cooldown has run out", () => {
    const w = dashWorld([100, 0])
    step(w, { player: press({ dash: true }) })
    const vAfter = w.bodies[0].vx
    w.bodies[0].energy = CONFIG.energy.max
    step(w, { player: press({ dash: true }) })
    expect(w.bodies[0].stats.dashes).toBe(1)
    expect(w.bodies[0].vx).toBeLessThan(vAfter)
    expect(eventsOf(w, "dash")).toHaveLength(0)
    stepN(w, Math.ceil(AB.dash.cooldown / DT) + 2)
    expect(w.bodies[0].dashCd).toBe(0)
    w.bodies[0].energy = CONFIG.energy.max
    step(w, { player: press({ dash: true }) })
    expect(w.bodies[0].stats.dashes).toBe(2)
  })

  it("needs energy >= cost: below it nothing happens", () => {
    const w = dashWorld([100, 0])
    w.bodies[0].energy = AB.dash.cost - 1
    step(w, { player: press({ dash: true }) })
    expect(w.bodies[0].stats.dashes).toBe(0)
    expect(w.bodies[0].dashCd).toBe(0)
    expectClose(w.bodies[0].vx, 100 * DRAG, 1e-9)
  })

  it("never beats hardSpeedCap", () => {
    // "Clamp |v| to hardSpeedCap" in 3f.
    const w = dashWorld([CONFIG.body.hardSpeedCap * 0.9, 0])
    step(w, { player: press({ dash: true }) })
    const speed = Math.hypot(w.bodies[0].vx, w.bodies[0].vy)
    expect(speed).toBeLessThanOrEqual(CONFIG.body.hardSpeedCap + 1e-9)
    expect(speed).toBeGreaterThan(CONFIG.body.hardSpeedCap * 0.99)
  })

  it("dead bodies cannot dash and a body that does not press dash does not dash", () => {
    const w = dashWorld([100, 0])
    step(w, {})
    expect(w.bodies[0].stats.dashes).toBe(0)
    const d = controlledWorld({ botCount: 2 })
    placeBody(d, 1, 0, 0, 50, 0)
    d.bodies[1].alive = false
    step(d, { "bot-1": press({ dash: true }) })
    expect(d.bodies[1].stats.dashes).toBe(0)
  })

  it("topSpeed tracks the highest speed reached", () => {
    const w = dashWorld([100, 0])
    step(w, { player: press({ dash: true }) })
    const peak = Math.hypot(w.bodies[0].vx, w.bodies[0].vy)
    expectClose(w.bodies[0].stats.topSpeed, peak, 1e-9, "topSpeed")
    stepN(w, 30)
    expectClose(w.bodies[0].stats.topSpeed, peak, 1e-9, "topSpeed is a maximum")
  })
})

// ---------------------------------------------------------------------------------------------
describe("Repulse", () => {
  function repWorld(qMass: number = PLAYER_MASS, bMass: number = PLAYER_MASS) {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[0], qMass)
    setMass(w.bodies[1], bMass)
    placeBody(w, 0, 0, 0)
    armed(w)
    return w
  }

  it("repulseRadius = radius + body.radius * radiusPerR", () => {
    const w = repWorld()
    for (const m of [10, 40, 120]) {
      setMass(w.bodies[0], m)
      expectClose(repulseRadius(w.bodies[0]), AB.repulse.radius + w.bodies[0].radius * AB.repulse.radiusPerR, 1e-9)
    }
  })

  it("debris inside the radius gets debrisImpulse * (1 - d/Rr) away from the repulser; debris outside is untouched", () => {
    const w = repWorld()
    const Rr = repulseRadius(w.bodies[0])
    const d = 100
    const near = makeDebris(w, "dust", d, 0)
    const out = makeDebris(w, "dust", 0, Rr + 80)
    step(w, { player: press({ repulse: true }) })
    expectClose(near.vx, AB.repulse.debrisImpulse * (1 - d / Rr) * DEBRIS_DRAG, 1e-9, "near debris vx")
    expectClose(near.vy, 0, 1e-9)
    expect(out.vx).toBe(0)
    expect(out.vy).toBe(0)
  })

  it("pushes along the line from the repulser (any direction)", () => {
    const w = repWorld()
    const a = 2.2
    const d = makeDebris(w, "dust", Math.cos(a) * 120, Math.sin(a) * 120)
    step(w, { player: press({ repulse: true }) })
    expectClose(Math.atan2(d.vy, d.vx), a, 1e-9, "direction")
  })

  it("bodies get impulse * (1 - d/Rr) * min(1.6, 2 mQ/(mQ + mB)) and are marked as hit", () => {
    for (const [mQ, mB] of [
      [10, 10],
      [30, 10],
      [100, 10],
      [10, 30],
    ]) {
      const w = repWorld(mQ, mB)
      const Rr = repulseRadius(w.bodies[0])
      const d = 150
      placeBody(w, 1, 0, d)
      step(w, { player: press({ repulse: true }) })
      const factor = Math.min(1.6, (2 * mQ) / (mQ + mB))
      const expected = AB.repulse.impulse * (1 - d / Rr) * factor
      expectClose(w.bodies[1].vy, expected, 1e-9, `vy for masses ${mQ}/${mB}`)
      expectClose(w.bodies[1].vx, 0, 1e-9)
      expect(w.bodies[1].lastHitBy).toBe("player")
      expectClose(w.bodies[1].lastHitAt, w.time, 1e-12, "lastHitAt")
      expect(w.bodies[0].lastHitBy).toBe("")
    }
  })

  it("a body outside the radius is not pushed or marked; the repulser feels nothing itself", () => {
    const w = repWorld()
    const Rr = repulseRadius(w.bodies[0])
    placeBody(w, 1, Rr + 100, 0)
    step(w, { player: press({ repulse: true }) })
    expect(w.bodies[1].vx).toBe(0)
    expect(w.bodies[1].lastHitBy).toBe("")
    expect(w.bodies[0].vx).toBe(0)
    expect(w.bodies[0].vy).toBe(0)
  })

  it("dead bodies are not pushed or marked", () => {
    const w = repWorld()
    placeBody(w, 1, 0, 150)
    w.bodies[1].alive = false
    step(w, { player: press({ repulse: true }) })
    expect(w.bodies[1].vy).toBe(0)
    expect(w.bodies[1].lastHitBy).toBe("")
  })

  it("costs energy, starts the cooldown, counts the stat, and the event carries repulseRadius", () => {
    const w = repWorld()
    w.bodies[0].energy = 50
    step(w, { player: press({ repulse: true }) })
    const b = w.bodies[0]
    expectClose(b.energy, 50 - AB.repulse.cost + CONFIG.energy.regen * DT, 1e-9, "energy")
    expect(b.repulseCd).toBe(AB.repulse.cooldown)
    expect(b.stats.repulses).toBe(1)
    const ev = oneEvent(w, "repulse")
    expect(ev.bodyId).toBe("player")
    expectClose(ev.r, repulseRadius(b), 1e-9, "event r")
  })

  it("is ignored on cooldown or without enough energy", () => {
    const w = repWorld()
    step(w, { player: press({ repulse: true }) })
    w.bodies[0].energy = CONFIG.energy.max
    step(w, { player: press({ repulse: true }) })
    expect(w.bodies[0].stats.repulses).toBe(1)
    expect(eventsOf(w, "repulse")).toHaveLength(0)
    const low = repWorld()
    low.bodies[0].energy = AB.repulse.cost - 1
    step(low, { player: press({ repulse: true }) })
    expect(low.bodies[0].stats.repulses).toBe(0)
    expect(low.bodies[0].repulseCd).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("Assist", () => {
  function assistWorld() {
    const w = controlledWorld({ botCount: 2 })
    armed(w)
    placeBody(w, 0, -500, 0)
    return w
  }

  it("a rival that dies in a lethal well within assistWindow after a repulse hit credits the repulser", () => {
    // Step 7: "assistId = lastHitBy, increment the assister's stats.assists and emit {type:"assist"}
    // after the death event".
    const w = assistWorld()
    const hole = addWell(w, "blackhole", 0, 0)
    placeBody(w, 1, 0, 0)
    w.bodies[1].lastHitBy = "player"
    w.bodies[1].lastHitAt = w.time - (AB.assistWindow - 0.5)
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
    const death = oneEvent(w, "death")
    expect(death.cause).toEqual({ by: "blackhole", assistId: "player" })
    expect(w.bodies[0].stats.assists).toBe(1)
    const idxDeath = w.events.findIndex((e) => e.type === "death")
    const idxAssist = w.events.findIndex((e) => e.type === "assist")
    expect(idxAssist).toBeGreaterThan(idxDeath)
    expect(w.events[idxAssist]).toEqual({ type: "assist", bodyId: "player", victimId: "bot-1" })
    expect(hole.kind).toBe("blackhole")
  })

  it("a real repulse that shoves a rival into a well gives the assist", () => {
    const w = assistWorld()
    placeBody(w, 0, 0, 0)
    const hole = addWell(w, "blackhole", 150, 0)
    // The rival sits inside the hole's kill distance in the very step it is shoved.
    placeBody(w, 1, hole.x + 10, 0)
    step(w, { player: press({ repulse: true }) })
    expect(w.bodies[1].alive).toBe(false)
    expect(eventsOf(w, "death")[0].cause).toEqual({ by: "blackhole", assistId: "player" })
    expect(w.bodies[0].stats.assists).toBe(1)
  })

  it("outside the window there is no assist", () => {
    const w = assistWorld()
    addWell(w, "star", 0, 0)
    placeBody(w, 1, 0, 0)
    w.bodies[1].lastHitBy = "player"
    w.bodies[1].lastHitAt = w.time - (AB.assistWindow + 0.5)
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
    const cause = oneEvent(w, "death").cause as DeathCause
    expect(cause).toEqual({ by: "star" })
    expect(eventsOf(w, "assist")).toHaveLength(0)
    expect(w.bodies[0].stats.assists).toBe(0)
  })

  it("never hit: plain well death, no assist", () => {
    const w = assistWorld()
    addWell(w, "star", 0, 0)
    placeBody(w, 1, 0, 0)
    step(w, {})
    expect(eventsOf(w, "death")[0].cause).toEqual({ by: "star" })
    expect(eventsOf(w, "assist")).toHaveLength(0)
  })

  it("a rival killed by another body is not an assist", () => {
    const w = assistWorld()
    setMass(w.bodies[2], 40)
    setMass(w.bodies[1], 10)
    placeBody(w, 2, 0, 0)
    placeBody(w, 1, 2, 0)
    w.bodies[1].lastHitBy = "player"
    w.bodies[1].lastHitAt = w.time
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
    expect(eventsOf(w, "death")[0].cause).toEqual({ by: "body", killerId: "bot-2" })
    expect(eventsOf(w, "assist")).toHaveLength(0)
  })

  it("when the player is the one who dies after a bot's repulse, the death cause names the assister", () => {
    const w = assistWorld()
    addWell(w, "blackhole", 0, 0)
    placeBody(w, 0, 0, 0)
    w.bodies[0].lastHitBy = "bot-1"
    w.bodies[0].lastHitAt = w.time
    step(w, {})
    expect(w.result?.reason).toBe("playerDied")
    expect(w.result?.playerCause).toEqual({ by: "blackhole", assistId: "bot-1" })
    expect(w.bodies[1].stats.assists).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
describe("Singularity", () => {
  function ultWorld() {
    const w = controlledWorld({ botCount: 2 })
    placeBody(w, 0, 0, 0)
    armed(w)
    return w
  }

  it("charge from absorbing a rival: victim.mass / chargeMass", () => {
    const w = ultWorld()
    setMass(w.bodies[0], 30)
    setMass(w.bodies[1], 10)
    placeBody(w, 1, 2, 0)
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
    expectClose(w.bodies[0].ult, 10 / AB.ult.chargeMass, 1e-9, "ult")
  })

  it("charge from debris: debris.mass * debrisShare / chargeMass; clamps at 1", () => {
    const w = ultWorld()
    makeDebris(w, "dust", 0, 0, 3)
    step(w, {})
    expectClose(w.bodies[0].ult, (3 * AB.ult.debrisShare) / AB.ult.chargeMass, 1e-9, "ult")
    const full = ultWorld()
    full.bodies[0].ult = 0.999
    makeDebris(full, "rock", 0, 0, 30)
    step(full, {})
    expect(full.bodies[0].ult).toBe(1)
  })

  it("ultReady fires once when charge reaches 1 from below, not again at 1", () => {
    const w = ultWorld()
    w.bodies[0].ult = 1 - 1e-4
    makeDebris(w, "dust", 0, 0, 2)
    step(w, {})
    expect(w.bodies[0].ult).toBe(1)
    expect(oneEvent(w, "ultReady").bodyId).toBe("player")
    makeDebris(w, "dust", 0, 0, 2)
    step(w, {})
    expect(eventsOf(w, "ultReady")).toHaveLength(0)
  })

  it("charge from a slingshot and from an anomaly zone", () => {
    const w = ultWorld()
    const zone = addZone(w, "anomaly", 0, 0, 200, CONFIG.zones.anomalyUlt)
    w.bodies[0].energy = 50
    step(w, {})
    expectClose(w.bodies[0].ult, zone.strength * DT, 1e-12, "ult from anomaly")
    expectClose(w.bodies[0].energy, 50 + (CONFIG.energy.regen + CONFIG.zones.anomalyEnergy) * DT, 1e-9, "energy from anomaly")
    const out = ultWorld()
    addZone(out, "anomaly", 600, 0, 100, CONFIG.zones.anomalyUlt)
    step(out, {})
    expect(out.bodies[0].ult).toBe(0)
  })

  it("activation: needs ult >= 1; consumes the charge; starts the timer; stat and event", () => {
    const w = ultWorld()
    w.bodies[0].ult = 1
    step(w, { player: press({ ult: true }) })
    const b = w.bodies[0]
    expect(b.ultActive).toBe(AB.ult.duration)
    expect(b.ult).toBe(0)
    expect(b.stats.ults).toBe(1)
    expect(oneEvent(w, "ultStart").bodyId).toBe("player")

    const early = ultWorld()
    early.bodies[0].ult = 0.99
    step(early, { player: press({ ult: true }) })
    expect(early.bodies[0].ultActive).toBe(0)
    expect(early.bodies[0].ult).toBe(0.99)
    expect(eventsOf(early, "ultStart")).toHaveLength(0)
  })

  it("cannot be re-activated while active", () => {
    const w = ultWorld()
    w.bodies[0].ult = 1
    step(w, { player: press({ ult: true }) })
    w.bodies[0].ult = 1
    step(w, { player: press({ ult: true }) })
    expect(w.bodies[0].stats.ults).toBe(1)
    expect(w.bodies[0].ult).toBe(1)
    expect(eventsOf(w, "ultStart")).toHaveLength(0)
  })

  it("ends after its duration with exactly one ultEnd", () => {
    const w = ultWorld()
    w.bodies[0].ult = 1
    step(w, { player: press({ ult: true }) })
    let ends = 0
    let steps = 0
    while (w.bodies[0].ultActive > 0 && steps < 1000) {
      step(w, {})
      steps++
      ends += eventsOf(w, "ultEnd").length
    }
    expect(ends).toBe(1)
    expect(w.bodies[0].ultActive).toBe(0)
    expect(Math.abs(steps - AB.ult.duration / DT)).toBeLessThanOrEqual(2)
    stepN(w, 5)
    expect(eventsOf(w, "ultEnd")).toHaveLength(0)
  })

  it("pullRadius multipliers: magnet radiusMul, Singularity pullRadiusMul, both together", () => {
    // pullRadius: "multiplied by CONFIG.powerups.magnet.radiusMul while a magnet is active and by
    // CONFIG.abilities.ult.pullRadiusMul while the Singularity is active".
    const w = ultWorld()
    const b = w.bodies[0]
    const base = CONFIG.pull.baseRadius + b.radius * CONFIG.pull.radiusPerR
    expectClose(pullRadius(b), base, 1e-9, "plain")
    b.power.magnet = 5
    expectClose(pullRadius(b), base * CONFIG.powerups.magnet.radiusMul, 1e-9, "magnet")
    b.power.magnet = 0
    b.ultActive = 2
    expectClose(pullRadius(b), base * AB.ult.pullRadiusMul, 1e-9, "ult")
    b.power.magnet = 5
    expectClose(pullRadius(b), base * AB.ult.pullRadiusMul * CONFIG.powerups.magnet.radiusMul, 1e-9, "both")
  })

  it("while active: pull accel multiplier, pull costs no energy", () => {
    const w = ultWorld()
    const b = w.bodies[0]
    b.ultActive = 3
    b.energy = 50
    const R = pullRadius(b)
    const d = 200
    expect(d).toBeLessThan(R)
    const debris = makeDebris(w, "dust", d, 0)
    step(w, { player: press({ pull: true }) })
    // ultActive decrements first, but is still > 0 here.
    const k = AB.ult.pullAccelMul
    const R2 = pullRadius(w.bodies[0])
    expectClose(debris.vx, -CONFIG.pull.debrisAccel * k * (1 - d / R2) * DT * DEBRIS_DRAG, 1e-9, "debris vx")
    expectClose(w.bodies[0].energy, 50 + CONFIG.energy.regen * DT, 1e-9, "no pull cost under the Singularity")
    expect(w.bodies[0].pulling).toBe(true)
  })

  it("while inactive: pulling still costs pullCost", () => {
    const w = ultWorld()
    w.bodies[0].energy = 50
    step(w, { player: press({ pull: true }) })
    expectClose(w.bodies[0].energy, 50 + (CONFIG.energy.regen - CONFIG.energy.pullCost) * DT, 1e-9)
  })

  it("absorb ratio drops to ult.absorbRatio: absorbRatio() and canAbsorb honour it", () => {
    const w = ultWorld()
    const [a, b] = w.bodies
    setMass(a, 10)
    setMass(b, 10)
    expect(absorbRatio(a)).toBe(CONFIG.absorb.ratio)
    expect(canAbsorb(a, b)).toBe(false)
    a.ultActive = 2
    expect(absorbRatio(a)).toBe(AB.ult.absorbRatio)
    expect(canAbsorb(a, b)).toBe(AB.ult.absorbRatio <= 1)
    expect(canAbsorb(b, a)).toBe(false)
  })

  it("equal masses cannot absorb each other, even under the Singularity", () => {
    // Needs ult.absorbRatio > 1 (the config says so: "the absorb ratio drops to absorbRatio", still above parity).
    expect(AB.ult.absorbRatio).toBeGreaterThan(1)
    const w = ultWorld()
    setMass(w.bodies[0], PLAYER_MASS)
    setMass(w.bodies[1], PLAYER_MASS)
    placeBody(w, 1, 2, 0)
    w.bodies[0].ultActive = 3
    w.bodies[1].ultActive = 3
    expect(canAbsorb(w.bodies[0], w.bodies[1])).toBe(false)
    expect(canAbsorb(w.bodies[1], w.bodies[0])).toBe(false)
    step(w, {})
    expect(w.bodies[0].alive).toBe(true)
    expect(w.bodies[1].alive).toBe(true)
    expect(eventsOf(w, "absorb")).toHaveLength(0)
    // Just under the Singularity ratio also fails.
    const near = ultWorld()
    setMass(near.bodies[0], PLAYER_MASS * AB.ult.absorbRatio * 0.995)
    setMass(near.bodies[1], PLAYER_MASS)
    placeBody(near, 1, 2, 0)
    near.bodies[0].ultActive = 3
    step(near, {})
    expect(near.bodies[1].alive).toBe(true)
  })

  it("a Singularity body absorbs a rival it is just past ult.absorbRatio heavier than; without it, it cannot", () => {
    // Masses derive from CONFIG: heavy enough for the Singularity ratio, too light for the normal one.
    expect(AB.ult.absorbRatio).toBeLessThan(CONFIG.absorb.ratio)
    const build = (active: boolean) => {
      const w = ultWorld()
      setMass(w.bodies[0], PLAYER_MASS * AB.ult.absorbRatio * 1.001)
      setMass(w.bodies[1], 10)
      placeBody(w, 1, 2, 0)
      if (active) w.bodies[0].ultActive = 3
      step(w, {})
      return w
    }
    const on = build(true)
    expect(on.bodies[1].alive).toBe(false)
    const off = build(false)
    expect(off.bodies[1].alive).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
describe("Slingshot", () => {
  const band = (well: { radius: number }) => CONFIG.slingshot.band * well.radius + 60

  function sling(opts: { d?: number; speedMul?: number; slingCd?: number } = {}) {
    const w = controlledWorld({ botCount: 1 })
    const hole = addWell(w, "blackhole", 0, 0)
    const d = opts.d ?? 150
    expect(d).toBeLessThan(band(hole))
    const speed = maxSpeed(PLAYER_MASS) * (opts.speedMul ?? 1.6)
    placeBody(w, 0, d, 0, 0, speed)
    w.bodies[0].energy = 50
    w.bodies[0].slingCd = opts.slingCd ?? 0
    return { w, hole }
  }

  it("fast pass inside the band: energy, Singularity charge, cooldown, stat and event", () => {
    const { w } = sling()
    step(w, {})
    const b = w.bodies[0]
    expectClose(b.energy, 50 + CONFIG.energy.regen * DT + CONFIG.slingshot.energy, 1e-9, "energy")
    expectClose(b.ult, CONFIG.slingshot.ult, 1e-9, "ult")
    expect(b.slingCd).toBe(CONFIG.slingshot.cooldown)
    expect(b.stats.slingshots).toBe(1)
    const ev = oneEvent(w, "slingshot")
    expect(ev.bodyId).toBe("player")
    expectClose(ev.speed, Math.hypot(b.vx, b.vy), 1e-9, "event speed")
  })

  it("no reward below minSpeedMul * maxSpeed", () => {
    const { w } = sling({ speedMul: 0.9 })
    step(w, {})
    expect(w.bodies[0].stats.slingshots).toBe(0)
    expect(w.bodies[0].slingCd).toBe(0)
    expect(eventsOf(w, "slingshot")).toHaveLength(0)
  })

  it("no reward outside band * radius + 60", () => {
    const hole = makeWell("blackhole", 0, 0)
    const { w } = sling({ d: 150 })
    placeBody(w, 0, band(hole) + 40, 0, 0, maxSpeed(PLAYER_MASS) * 1.6)
    step(w, {})
    expect(w.bodies[0].stats.slingshots).toBe(0)
  })

  it("no reward while slingCd > 0, and not again right after one", () => {
    const { w } = sling({ slingCd: 1 })
    step(w, {})
    expect(w.bodies[0].stats.slingshots).toBe(0)
    const again = sling()
    step(again.w, {})
    expect(again.w.bodies[0].stats.slingshots).toBe(1)
    placeBody(again.w, 0, 150, 0, 0, maxSpeed(PLAYER_MASS) * 1.6)
    step(again.w, {})
    expect(again.w.bodies[0].stats.slingshots).toBe(1)
    expect(eventsOf(again.w, "slingshot")).toHaveLength(0)
  })

  it("energy reward is clamped to max", () => {
    const { w } = sling()
    w.bodies[0].energy = CONFIG.energy.max - 1
    step(w, {})
    expect(w.bodies[0].energy).toBe(CONFIG.energy.max)
  })

  it("works near any well kind (e.g. a white dwarf), measured from its own radius", () => {
    const w = controlledWorld({ botCount: 1 })
    const dwarf = addWell(w, "whitedwarf", 0, 0)
    const d = band(dwarf) - 15
    placeBody(w, 0, d, 0, 0, maxSpeed(PLAYER_MASS) * 1.6)
    step(w, {})
    expect(w.bodies[0].stats.slingshots).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
describe("Power-ups", () => {
  function pickupWorld(kind: PowerUpKind) {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    const p = makePickup(w, kind, 0, 0)
    return { w, p }
  }

  it("collecting removes the pickup, counts the stat and emits a pickup event", () => {
    const { w, p } = pickupWorld("overdrive")
    step(w, {})
    expect(w.pickups.find((x) => x.id === p.id)).toBeUndefined()
    expect(w.bodies[0].stats.pickups).toBe(1)
    const ev = oneEvent(w, "pickup")
    expect(ev).toMatchObject({ bodyId: "player", kind: "overdrive" })
  })

  it("is collected inside body.radius + powerups.radius and not outside it", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    const r = w.bodies[0].radius + CONFIG.powerups.radius
    makePickup(w, "magnet", r - 1, 0)
    makePickup(w, "phase", 0, r + 1)
    step(w, {})
    expect(w.pickups.map((x) => x.kind)).toEqual(["phase"])
  })

  it("overdrive: timer set, regen multiplied", () => {
    const { w } = pickupWorld("overdrive")
    step(w, {})
    expect(w.bodies[0].power.overdrive).toBe(CONFIG.powerups.overdrive.duration)
    w.bodies[0].energy = 50
    step(w, {})
    expectClose(w.bodies[0].energy, 50 + CONFIG.energy.regen * CONFIG.powerups.overdrive.regenMul * DT, 1e-9, "energy")
    expectClose(w.bodies[0].power.overdrive, CONFIG.powerups.overdrive.duration - DT, 1e-9, "timer counts down")
  })

  it("magnet: timer set, pull radius multiplied and reaching further debris", () => {
    const { w } = pickupWorld("magnet")
    step(w, {})
    const b = w.bodies[0]
    expect(b.power.magnet).toBe(CONFIG.powerups.magnet.duration)
    const plain = CONFIG.pull.baseRadius + b.radius * CONFIG.pull.radiusPerR
    expectClose(pullRadius(b), plain * CONFIG.powerups.magnet.radiusMul, 1e-9)
    const d = makeDebris(w, "dust", plain + 30, 0)
    step(w, { player: press({ pull: true }) })
    expect(d.vx).toBeLessThan(0)
  })

  it("bulk: instant mass, radius follows, no timer", () => {
    const { w } = pickupWorld("bulk")
    step(w, {})
    const b = w.bodies[0]
    expectClose(b.mass, PLAYER_MASS + CONFIG.powerups.bulk.mass, 1e-9, "mass")
    expectClose(b.radius, radiusForMass(b.mass), 1e-12)
    expect(b.power).toEqual({ overdrive: 0, magnet: 0, phase: 0 })
  })

  it("phase: timer set; a phased body survives a lethal well, an unphased one does not", () => {
    const { w } = pickupWorld("phase")
    step(w, {})
    expect(w.bodies[0].power.phase).toBe(CONFIG.powerups.phase.duration)
    addWell(w, "star", 0, 0)
    step(w, {})
    expect(w.bodies[0].alive).toBe(true)

    const plain = controlledWorld({ botCount: 1 })
    placeBody(plain, 0, 0, 0)
    addWell(plain, "star", 0, 0)
    step(plain, {})
    expect(plain.bodies[0].alive).toBe(false)
  })

  it("phase expires: after its duration the same well kills again", () => {
    const w = controlledWorld({ botCount: 2 })
    placeBody(w, 1, 0, 0)
    w.bodies[1].power.phase = 3 * DT
    addWell(w, "blackhole", 0, 0)
    stepN(w, 2)
    expect(w.bodies[1].alive).toBe(true)
    stepN(w, 3)
    expect(w.bodies[1].alive).toBe(false)
  })

  it("phase also protects against the enlarged solar flare kill radius", () => {
    const make = (phase: number, stage: "warning" | "active") => {
      const w = controlledWorld({ botCount: 2 })
      const star = addWell(w, "star", 0, 0)
      const flare: CosmicEvent = {
        id: 1,
        kind: "solarFlare",
        stage,
        t: 0,
        warning: CONFIG.cosmic.solarFlare.warning,
        duration: CONFIG.cosmic.solarFlare.duration,
        x: star.x,
        y: star.y,
        r: star.radius * CONFIG.cosmic.solarFlare.radiusMul,
        targetId: star.id,
      }
      w.cosmic = flare
      const b = w.bodies[1]
      // Outside the normal kill distance, inside the flare's.
      const plainKill = star.radius + b.radius * CONFIG.well.killOverlap
      const flareKill = star.radius * CONFIG.cosmic.solarFlare.radiusMul + b.radius * CONFIG.well.killOverlap
      placeBody(w, 1, (plainKill + flareKill) / 2, 0)
      b.power.phase = phase
      step(w, {})
      return w
    }
    expect(make(0, "active").bodies[1].alive).toBe(false)
    expect(make(5, "active").bodies[1].alive).toBe(true)
    expect(make(0, "warning").bodies[1].alive).toBe(true)
  })

  it("re-collecting the same kind refreshes the timer to its full duration", () => {
    const { w } = pickupWorld("overdrive")
    step(w, {})
    stepN(w, 60)
    expect(w.bodies[0].power.overdrive).toBeLessThan(CONFIG.powerups.overdrive.duration - 0.9)
    makePickup(w, "overdrive", w.bodies[0].x, w.bodies[0].y)
    step(w, {})
    expect(w.bodies[0].power.overdrive).toBe(CONFIG.powerups.overdrive.duration)
    expect(w.bodies[0].stats.pickups).toBe(2)
  })

  it("an uncollected pickup fades silently after its ttl", () => {
    const w = controlledWorld({ botCount: 1 })
    makePickup(w, "bulk", 700, 700, 1.5 * DT)
    step(w, {})
    expect(w.pickups).toHaveLength(1)
    expectClose(w.pickups[0].ttl, 0.5 * DT, 1e-12)
    step(w, {})
    expect(w.pickups).toHaveLength(0)
    expect(eventsOf(w, "pickup")).toHaveLength(0)
  })

  it("spawning: capped at powerups.max, ids from nextDebrisId, ttl set, placement rules", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const w = controlledWorld({ seed, botCount: 2 })
      const star = addWell(w, "star", 500, 0)
      const hole = addWell(w, "blackhole", 0, -600)
      const startId = w.nextDebrisId
      w.spawnCredit = credit({ pickup: 100 })
      step(w, {})
      expect(w.pickups, `seed ${seed}`).toHaveLength(CONFIG.powerups.max)
      expect(w.spawnCredit.pickup).toBeLessThanOrEqual(1 + 1e-9)
      expect(new Set(w.pickups.map((p) => p.id)).size).toBe(w.pickups.length)
      expect(w.nextDebrisId).toBe(startId + w.pickups.length)
      const kinds: PowerUpKind[] = ["overdrive", "magnet", "phase", "bulk"]
      for (const p of w.pickups) {
        expect(p.id).toBeGreaterThanOrEqual(startId)
        expect(p.id).toBeLessThan(w.nextDebrisId)
        expect(p.ttl).toBe(CONFIG.powerups.ttl)
        expect(kinds).toContain(p.kind)
        expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(w.arenaRadius - 200 + 1e-9)
        for (const b of w.bodies) expect(dist(p, b), `seed ${seed} vs ${b.id}`).toBeGreaterThanOrEqual(250 - 1e-9)
        for (const well of [star, hole]) {
          expect(dist(p, well), `seed ${seed} vs ${well.kind}`).toBeGreaterThanOrEqual(
            Math.max(well.chargeRadius, well.radius) + 60 - 1e-9,
          )
        }
      }
    }
  })

  it("spawning does nothing at the cap, and one credit makes one pickup", () => {
    const w = controlledWorld({ botCount: 1 })
    makePickup(w, "bulk", 700, 700)
    makePickup(w, "bulk", -700, 700)
    w.spawnCredit = credit({ pickup: 5 })
    step(w, {})
    expect(w.pickups).toHaveLength(CONFIG.powerups.max)
    expect(w.spawnCredit.pickup).toBeLessThanOrEqual(1 + 1e-9)
    const one = controlledWorld({ botCount: 1 })
    one.spawnCredit = credit({ pickup: 1 })
    step(one, {})
    expect(one.pickups).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------
describe("Comets", () => {
  it("spawn at the edge aimed inward, with speed and mass in range, capped at comets.max", () => {
    const w = controlledWorld({ botCount: 1 })
    const startId = w.nextDebrisId
    w.spawnCredit = credit({ comet: 100 })
    step(w, {})
    const comets = w.debris.filter((d) => d.kind === "comet")
    expect(comets).toHaveLength(CONFIG.comets.max)
    expect(w.spawnCredit.comet).toBeLessThanOrEqual(1 + 1e-9)
    for (const c of comets) {
      expect(c.id).toBeGreaterThanOrEqual(startId)
      expectClose(Math.hypot(c.x, c.y), w.arenaRadius - 40, 1e-6, "spawn radius")
      const speed = Math.hypot(c.vx, c.vy)
      expect(speed).toBeGreaterThanOrEqual(CONFIG.comets.speed[0] - 1e-9)
      expect(speed).toBeLessThanOrEqual(CONFIG.comets.speed[1] + 1e-9)
      expect(c.mass).toBeGreaterThanOrEqual(CONFIG.comets.mass[0] - 1e-9)
      expect(c.mass).toBeLessThanOrEqual(CONFIG.comets.mass[1] + 1e-9)
      expectClose(c.radius, radiusForMass(c.mass), 1e-12)
      // Aimed at a point within 600 of the centre: inbound, and the line passes within 600.
      expect(c.x * c.vx + c.y * c.vy).toBeLessThan(0)
      const miss = Math.abs(c.x * c.vy - c.y * c.vx) / speed
      expect(miss).toBeLessThanOrEqual(600 + 1e-6)
    }
  })

  it("no spawning at the cap, and only live comets count towards it", () => {
    const w = controlledWorld({ botCount: 1 })
    for (let i = 0; i < CONFIG.comets.max; i++) makeDebris(w, "comet", 900 + i * 50, 900, 7)
    makeDebris(w, "dust", 0, 900)
    w.spawnCredit = credit({ comet: 10 })
    step(w, {})
    expect(w.debris.filter((d) => d.kind === "comet")).toHaveLength(CONFIG.comets.max)
    const none = controlledWorld({ botCount: 1 })
    for (let i = 0; i < 50; i++) makeDebris(none, "dust", 900 + i, -900)
    none.spawnCredit = credit({ comet: 1 })
    step(none, {})
    expect(none.debris.filter((d) => d.kind === "comet")).toHaveLength(1)
  })

  it("spawn credit accumulates at comets.spawnRate per second", () => {
    const w = controlledWorld({ botCount: 1 })
    w.spawnCredit = credit({ comet: 0 })
    step(w, {})
    expectClose(w.spawnCredit.comet, CONFIG.comets.spawnRate * DT, 1e-12)
  })

  it("coast with comets.drag, far less than dust", () => {
    const w = controlledWorld({ botCount: 1 })
    const comet = makeDebris(w, "comet", 700, 700, 8)
    const dust = makeDebris(w, "dust", -700, 700)
    comet.vx = 400
    dust.vx = 400
    step(w, {})
    expectClose(comet.vx, 400 * COMET_DRAG, 1e-9, "comet vx")
    expectClose(dust.vx, 400 * DEBRIS_DRAG, 1e-9, "dust vx")
    expect(CONFIG.comets.drag).toBeLessThan(CONFIG.debris.drag)
  })

  it("are eaten as comets: stats.comets, mass, eat event, Singularity charge; not debrisEaten", () => {
    const w = controlledWorld({ botCount: 1 })
    placeBody(w, 0, 0, 0)
    makeDebris(w, "comet", 0, 0, 8)
    step(w, {})
    const b = w.bodies[0]
    expect(b.stats.comets).toBe(1)
    expect(b.stats.debrisEaten).toBe(0)
    expect(b.stats.crystals).toBe(0)
    expectClose(b.mass, PLAYER_MASS + 8, 1e-9)
    expect(oneEvent(w, "eat").kind).toBe("comet")
    expectClose(b.ult, (8 * AB.ult.debrisShare) / AB.ult.chargeMass, 1e-9, "ult")
  })
})

// ---------------------------------------------------------------------------------------------
describe("Wells (Phase A kinds)", () => {
  const LETHAL: LethalWellKind[] = ["star", "blackhole", "whitedwarf", "neutronstar", "pulsar"]

  for (const kind of LETHAL) {
    it(`${kind}: contact kills with cause.by = "${kind}"`, () => {
      const w = controlledWorld({ botCount: 2 })
      addWell(w, kind, 0, 0)
      placeBody(w, 1, 0, 0)
      step(w, {})
      expect(w.bodies[1].alive).toBe(false)
      expect(oneEvent(w, "death").cause).toEqual({ by: kind })
    })

    it(`${kind}: kills inside radius + body.radius * killOverlap, spares outside`, () => {
      const w = controlledWorld({ botCount: 2 })
      const well = addWell(w, kind, 0, 0)
      const r = w.bodies[1].radius
      const kill = well.radius + r * CONFIG.well.killOverlap
      placeBody(w, 1, kill - 1, 0)
      placeBody(w, 0, 0, kill + 12)
      step(w, {})
      expect(w.bodies[1].alive).toBe(false)
      expect(w.bodies[0].alive).toBe(true)
    })
  }

  it("the lethal flag matches the kind", () => {
    for (const kind of ["star", "blackhole", "whitedwarf", "neutronstar", "pulsar", "planet", "station"] as WellKind[]) {
      expect(makeWell(kind, 0, 0).lethal).toBe(kind !== "planet" && kind !== "station")
    }
  })

  describe("solid wells (planet, station)", () => {
    it("push a body out to the surface, bounce it with solidRestitution and emit solidHit above 40 u/s", () => {
      // Step 7: "d = well.radius + radius; vrel = (v - wv)·n; if vrel < 0: v -= (1 + solidRestitution)
      // * vrel * n and, when -vrel > 40, emit solidHit, impulse = -(1 + solidRestitution) * vrel * mass".
      const w = controlledWorld({ botCount: 1 })
      const station = addWell(w, "station", 0, 0)
      const r = w.bodies[0].radius
      placeBody(w, 0, station.radius + r + 1, 0, -200, 0)
      step(w, {})
      const b = w.bodies[0]
      expect(b.alive).toBe(true)
      expectClose(dist(b, station), station.radius + r, 1e-9, "surface distance")
      const vrel = -200 * DRAG
      expectClose(b.vx, -CONFIG.solidRestitution * vrel, 1e-9, "vx after bounce")
      const ev = oneEvent(w, "solidHit")
      expect(ev.bodyId).toBe("player")
      expect(ev.wellId).toBe(station.id)
      expectClose(ev.impulse, -(1 + CONFIG.solidRestitution) * vrel * b.mass, 1e-6, "impulse")
    })

    it("a gentle touch (<= 40 u/s) bounces without a solidHit event", () => {
      const w = controlledWorld({ botCount: 1 })
      const station = addWell(w, "station", 0, 0)
      const r = w.bodies[0].radius
      placeBody(w, 0, station.radius + r + 0.1, 0, -20, 0)
      step(w, {})
      expect(eventsOf(w, "solidHit")).toHaveLength(0)
      expectClose(w.bodies[0].vx, CONFIG.solidRestitution * 20 * DRAG, 1e-9)
    })

    it("a body moving away is pushed out but keeps its velocity", () => {
      const w = controlledWorld({ botCount: 1 })
      const station = addWell(w, "station", 0, 0)
      const r = w.bodies[0].radius
      placeBody(w, 0, station.radius + r - 5, 0, 30, 0)
      step(w, {})
      expectClose(dist(w.bodies[0], station), station.radius + r, 1e-9)
      expectClose(w.bodies[0].vx, 30 * DRAG, 1e-9)
      expect(eventsOf(w, "solidHit")).toHaveLength(0)
    })

    it("never kill, even from dead centre (pushed out along +x), and planets pull with gravity", () => {
      for (const kind of ["planet", "station"] as const) {
        const w = controlledWorld({ botCount: 1 })
        const well = addWell(w, kind, 0, 0)
        placeBody(w, 0, 0, 0)
        step(w, {})
        expect(w.bodies[0].alive, kind).toBe(true)
        expectClose(w.bodies[0].x, well.radius + w.bodies[0].radius, 1e-9, `${kind} x`)
        expect(eventsOf(w, "death")).toHaveLength(0)
      }
      const g = controlledWorld({ botCount: 1 })
      const planet = addWell(g, "planet", 400, 0)
      placeBody(g, 0, 0, 0)
      step(g, {})
      expectClose(g.bodies[0].vx, (planet.gm / (400 * 400 + CONFIG.well.soft ** 2)) * DT * DRAG, 1e-9, "planet gravity")
    })

    it("stations have no gravity (gm 0) but recharge energy in their band", () => {
      const w = controlledWorld({ botCount: 1 })
      const station = addWell(w, "station", 0, 0)
      placeBody(w, 0, station.radius + 60, 0)
      w.bodies[0].energy = 50
      step(w, {})
      expect(w.bodies[0].vx).toBe(0)
      expect(w.bodies[0].charging).toBe(true)
      const frac = 1 - 60 / (station.chargeRadius - station.radius)
      expectClose(
        w.bodies[0].energy,
        50 + (CONFIG.energy.regen + station.chargeRate * frac) * DT,
        1e-9,
        "station charging uses its own chargeRate",
      )
    })
  })

  describe("orbiting wells", () => {
    it("follow position = centre + r(cos θ, sin θ) and velocity = r w (-sin θ, cos θ), θ = phase + w * time", () => {
      const w = controlledWorld({ botCount: 1 })
      const planet = addWell(w, "planet", 0, 0)
      planet.orbit = { cx: 100, cy: -50, r: 300, w: 0.7, phase: 1.1 }
      for (let i = 0; i < 6; i++) {
        step(w, {})
        const th = 1.1 + 0.7 * w.time
        expectClose(planet.x, 100 + 300 * Math.cos(th), 1e-9, `x at step ${i}`)
        expectClose(planet.y, -50 + 300 * Math.sin(th), 1e-9, `y at step ${i}`)
        expectClose(planet.vx, -300 * 0.7 * Math.sin(th), 1e-9, `vx at step ${i}`)
        expectClose(planet.vy, 300 * 0.7 * Math.cos(th), 1e-9, `vy at step ${i}`)
      }
    })

    it("a negative angular speed runs the other way", () => {
      const w = controlledWorld({ botCount: 1 })
      const star = addWell(w, "star", 0, 0)
      star.orbit = { cx: 0, cy: 0, r: 420, w: -(2 * Math.PI) / 70, phase: 0.4 }
      stepN(w, 120)
      const th = 0.4 - ((2 * Math.PI) / 70) * w.time
      expectClose(star.x, 420 * Math.cos(th), 1e-9)
      expectClose(star.y, 420 * Math.sin(th), 1e-9)
    })

    it("gravity uses the well's current position", () => {
      const w = controlledWorld({ botCount: 1 })
      const star = addWell(w, "blackhole", 0, 0)
      star.orbit = { cx: 0, cy: 0, r: 500, w: 0, phase: Math.PI / 2 }
      placeBody(w, 0, 0, 0)
      step(w, {})
      expectClose(star.y, 500, 1e-9)
      expectClose(w.bodies[0].vy, (star.gm / (500 * 500 + CONFIG.well.soft ** 2)) * DT * DRAG, 1e-9)
    })
  })

  describe("pulsar beams", () => {
    function beamWorld(phase = 0, bw = 0) {
      const w = controlledWorld({ botCount: 1 })
      const pulsar = addWell(w, "pulsar", 0, 0)
      pulsar.beam = {
        w: bw,
        phase,
        halfWidth: CONFIG.pulsarBeam.halfWidth,
        length: CONFIG.pulsarBeam.length,
        accel: CONFIG.pulsarBeam.accel,
      }
      return { w, pulsar }
    }
    const grav = (gm: number, d: number) => gm / (d * d + CONFIG.well.soft ** 2)

    it("pushes a body inside the cone outward, falling off linearly with distance", () => {
      const { w, pulsar } = beamWorld()
      const d = 400
      placeBody(w, 0, d, 0)
      step(w, {})
      const beam = CONFIG.pulsarBeam.accel * (1 - d / CONFIG.pulsarBeam.length)
      expectClose(w.bodies[0].vx, (-grav(pulsar.gm, d) + beam) * DT * DRAG, 1e-9, "vx")
    })

    it("the second (opposite) beam works too", () => {
      const { w, pulsar } = beamWorld()
      const d = 400
      placeBody(w, 0, -d, 0)
      step(w, {})
      const beam = CONFIG.pulsarBeam.accel * (1 - d / CONFIG.pulsarBeam.length)
      expectClose(w.bodies[0].vx, (grav(pulsar.gm, d) - beam) * DT * DRAG, 1e-9, "vx")
    })

    it("no push outside the cone (perpendicular, or just beyond the half-width)", () => {
      const { w, pulsar } = beamWorld()
      placeBody(w, 0, 0, 400)
      step(w, {})
      expectClose(w.bodies[0].vy, -grav(pulsar.gm, 400) * DT * DRAG, 1e-9, "perpendicular")
      const edge = beamWorld()
      const a = CONFIG.pulsarBeam.halfWidth * 1.15
      placeBody(edge.w, 0, Math.cos(a) * 400, Math.sin(a) * 400)
      step(edge.w, {})
      const b = edge.w.bodies[0]
      expectClose(Math.hypot(b.vx, b.vy), grav(edge.pulsar.gm, 400) * DT * DRAG, 1e-9, "just outside the cone")
    })

    it("pushes just inside the half-width", () => {
      const { w, pulsar } = beamWorld()
      const a = CONFIG.pulsarBeam.halfWidth * 0.85
      placeBody(w, 0, Math.cos(a) * 400, Math.sin(a) * 400)
      step(w, {})
      const b = w.bodies[0]
      const beam = CONFIG.pulsarBeam.accel * (1 - 400 / CONFIG.pulsarBeam.length)
      expectClose(Math.hypot(b.vx, b.vy), Math.abs(beam - grav(pulsar.gm, 400)) * DT * DRAG, 1e-9)
    })

    it("no push beyond the beam length", () => {
      const { w, pulsar } = beamWorld()
      const d = CONFIG.pulsarBeam.length + 60
      placeBody(w, 0, d, 0)
      step(w, {})
      expectClose(w.bodies[0].vx, -grav(pulsar.gm, d) * DT * DRAG, 1e-9)
    })

    it("rotates: θ = phase + w * time (time after this step's increment)", () => {
      const bw = CONFIG.pulsarBeam.w
      const { w, pulsar } = beamWorld(-bw * DT, bw)
      const d = 400
      placeBody(w, 0, d, 0)
      step(w, {})
      const beam = CONFIG.pulsarBeam.accel * (1 - d / CONFIG.pulsarBeam.length)
      expectClose(w.bodies[0].vx, (-grav(pulsar.gm, d) + beam) * DT * DRAG, 1e-9, "vx")
    })
  })

  describe("gravity storm (gmScale)", () => {
    function storm(stage: "warning" | "active") {
      const w = controlledWorld({ botCount: 1 })
      const star = addWell(w, "star", 600, 0)
      placeBody(w, 0, 0, 0)
      const d = makeDebris(w, "dust", 0, 600)
      w.cosmic = {
        id: 1,
        kind: "gravityStorm",
        stage,
        t: 0,
        warning: CONFIG.cosmic.gravityStorm.warning,
        duration: CONFIG.cosmic.gravityStorm.duration,
        x: 0,
        y: 0,
        r: w.arenaRadius,
        targetId: "",
      }
      return { w, star, d }
    }
    const g = (gm: number, dd: number) => gm / (dd * dd + CONFIG.well.soft ** 2)

    it("scales every well's gm by gmMul while active, for bodies and debris", () => {
      const { w, star, d } = storm("active")
      step(w, {})
      expectClose(w.bodies[0].vx, CONFIG.cosmic.gravityStorm.gmMul * g(star.gm, 600) * DT * DRAG, 1e-9, "body vx")
      const dd = Math.hypot(600, 600)
      const accel = CONFIG.cosmic.gravityStorm.gmMul * g(star.gm, dd) * DT * DEBRIS_DRAG
      expectClose(d.vx, accel * (600 / dd), 1e-9, "debris vx")
      expectClose(d.vy, -accel * (600 / dd), 1e-9, "debris vy")
    })

    it("does not scale during the warning stage", () => {
      const { w, star } = storm("warning")
      step(w, {})
      expectClose(w.bodies[0].vx, g(star.gm, 600) * DT * DRAG, 1e-9, "body vx")
    })
  })
})

// ---------------------------------------------------------------------------------------------
describe("Zones", () => {
  it("nebula multiplies drag by its strength inside, for bodies and debris", () => {
    const w = controlledWorld({ botCount: 1 })
    addZone(w, "nebula", 0, 0, 300, 3)
    placeBody(w, 0, 0, 0, 100, 0)
    const inDebris = makeDebris(w, "dust", 50, 50)
    const outDebris = makeDebris(w, "dust", 800, 800)
    inDebris.vx = 50
    outDebris.vx = 50
    step(w, {})
    expectClose(w.bodies[0].vx, 100 * Math.exp(-CONFIG.body.drag * 3 * DT), 1e-9, "body vx")
    expectClose(inDebris.vx, 50 * Math.exp(-CONFIG.debris.drag * 3 * DT), 1e-9, "debris in nebula")
    expectClose(outDebris.vx, 50 * DEBRIS_DRAG, 1e-9, "debris outside")
  })

  it("overlapping nebulae multiply", () => {
    const w = controlledWorld({ botCount: 1 })
    addZone(w, "nebula", 0, 0, 300, 2)
    addZone(w, "nebula", 0, 0, 300, 3)
    placeBody(w, 0, 0, 0, 100, 0)
    step(w, {})
    expectClose(w.bodies[0].vx, 100 * Math.exp(-CONFIG.body.drag * 6 * DT), 1e-9)
  })

  it("a body outside a nebula has plain drag", () => {
    const w = controlledWorld({ botCount: 1 })
    addZone(w, "nebula", 800, 0, 100, 3)
    placeBody(w, 0, 0, 0, 100, 0)
    step(w, {})
    expectClose(w.bodies[0].vx, 100 * DRAG, 1e-9)
  })

  it("repulsor pushes away from its centre by strength * (1 - d/r), nothing outside, no NaN at the centre", () => {
    const w = controlledWorld({ botCount: 2 })
    const z = addZone(w, "repulsor", 0, 0, 220, CONFIG.zones.repulsorAccel)
    placeBody(w, 0, 100, 0)
    placeBody(w, 1, 0, 400)
    step(w, {})
    expectClose(w.bodies[0].vx, CONFIG.zones.repulsorAccel * (1 - 100 / z.r) * DT * DRAG, 1e-9, "inside")
    expect(w.bodies[1].vy).toBe(0)
    const c = controlledWorld({ botCount: 1 })
    addZone(c, "repulsor", 0, 0, 220, CONFIG.zones.repulsorAccel)
    placeBody(c, 0, 0, 0)
    step(c, {})
    expect(Number.isFinite(c.bodies[0].x) && Number.isFinite(c.bodies[0].vx)).toBe(true)
    expect(c.bodies[0].vx).toBe(0)
  })

  it("anomaly: energy +anomalyEnergy/s and charge +strength/s inside, clamped, nothing outside", () => {
    const w = controlledWorld({ botCount: 1 })
    const z = addZone(w, "anomaly", 0, 0, 200, CONFIG.zones.anomalyUlt)
    placeBody(w, 0, 0, 0)
    w.bodies[0].energy = 40
    w.bodies[0].ult = 0.5
    step(w, {})
    expectClose(w.bodies[0].energy, 40 + (CONFIG.energy.regen + CONFIG.zones.anomalyEnergy) * DT, 1e-9, "energy")
    expectClose(w.bodies[0].ult, 0.5 + z.strength * DT, 1e-12, "ult")
    w.bodies[0].ult = 1 - 1e-6
    step(w, {})
    expect(w.bodies[0].ult).toBe(1)
  })

  it("zones drift by their velocity each step", () => {
    const w = controlledWorld({ botCount: 1 })
    const z = addZone(w, "nebula", 100, 200, 100, 3, 60, -30)
    step(w, {})
    expectClose(z.x, 100 + 60 * DT, 1e-12)
    expectClose(z.y, 200 - 30 * DT, 1e-12)
  })

  it("a drifting zone reflects its radial velocity off the arena wall", () => {
    const w = controlledWorld({ botCount: 1 })
    const r = 300
    const z = addZone(w, "nebula", w.arenaRadius - r - 0.1, 0, r, 3, 60, 10)
    step(w, {})
    expect(z.vx).toBeLessThan(0)
    // v -= 2 (v·n) n preserves the speed and flips the radial component (n is the centre direction).
    expectClose(Math.hypot(z.vx, z.vy), Math.hypot(60, 10), 1e-9, "speed preserved")
    expect(z.vx).toBeLessThan(0)
    expectClose(z.vy, 10, 0.05, "tangential component kept")
  })
})

// ---------------------------------------------------------------------------------------------
describe("Escalation", () => {
  const last = CONFIG.escalation.last
  const radiusAt = (base: number, timeLeft: number) => base * (1 - (1 - CONFIG.escalation.shrinkTo) * (1 - timeLeft / last))

  it("does nothing before the last `last` seconds", () => {
    const w = controlledWorld({ botCount: 1 })
    w.timeLeft = last + 2
    stepN(w, 10)
    expect(w.arenaRadius).toBe(w.arenaBase)
    expect(eventsOf(w, "escalation")).toHaveLength(0)
  })

  it("closes the wall by the documented formula and emits the event exactly once", () => {
    const w = controlledWorld({ botCount: 1 })
    w.timeLeft = last + 0.5 * DT
    let events = 0
    for (let i = 0; i < 90; i++) {
      step(w, {})
      events += eventsOf(w, "escalation").length
      expectClose(w.arenaRadius, radiusAt(w.arenaBase, w.timeLeft), 1e-9, `arenaRadius at step ${i}`)
    }
    expect(events).toBe(1)
    expect(w.arenaRadius).toBeLessThan(w.arenaBase)
  })

  it("the event reports the new arenaRadius, on the first step it applies", () => {
    const w = controlledWorld({ botCount: 1 })
    w.timeLeft = last + 0.5 * DT
    step(w, {})
    const ev = oneEvent(w, "escalation")
    expectClose(ev.arenaRadius, w.arenaRadius, 1e-9)
    step(w, {})
    expect(eventsOf(w, "escalation")).toHaveLength(0)
  })

  it("ends at shrinkTo * arenaBase when time runs out", () => {
    const w = controlledWorld({ botCount: 1 })
    w.timeLeft = DT / 2
    step(w, {})
    expectClose(w.arenaRadius, w.arenaBase * CONFIG.escalation.shrinkTo, 1e-9)
  })

  it("the closing wall pushes in a body that is outside it", () => {
    const w = controlledWorld({ botCount: 1 })
    w.timeLeft = DT / 2
    const edge = w.arenaBase * CONFIG.escalation.shrinkTo
    placeBody(w, 0, edge + 60, 0)
    step(w, {})
    expect(w.bodies[0].vx).toBeLessThan(0)
  })

  it("hud reports escalating once the wall has started to close", () => {
    const w = controlledWorld({ botCount: 1 })
    expect(hudSnapshot(w).escalating).toBe(false)
    w.timeLeft = last
    step(w, {})
    expect(hudSnapshot(w).escalating).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
describe("hudSnapshot: Phase A fields", () => {
  it("mirrors abilities, charge, power-ups, arena", () => {
    const w = controlledWorld({ botCount: 2, arena: "belt" })
    const p = w.bodies[0]
    p.dashCd = 1.1
    p.repulseCd = 2.2
    p.ult = 0.4
    p.ultActive = 3.3
    p.power = { overdrive: 1, magnet: 2, phase: 3 }
    const h = hudSnapshot(w)
    expect(h.dashCd).toBe(1.1)
    expect(h.dashMax).toBe(AB.dash.cooldown)
    expect(h.repulseCd).toBe(2.2)
    expect(h.repulseMax).toBe(AB.repulse.cooldown)
    expect(h.ult).toBe(0.4)
    expect(h.ultActive).toBe(3.3)
    expect(h.power).toEqual({ overdrive: 1, magnet: 2, phase: 3 })
    expect(h.arena).toBe("belt")
    expect(h.escalating).toBe(false)
    expect(h.cosmic).toBeNull()
  })

  it("cosmic: kind, stage and secondsLeft = (warning or duration) - t", () => {
    const w = controlledWorld({ botCount: 1 })
    const ev: CosmicEvent = {
      id: 1,
      kind: "meteorShower",
      stage: "warning",
      t: 0.5,
      warning: 2,
      duration: 9,
      x: 0,
      y: 0,
      r: 380,
      targetId: "",
    }
    w.cosmic = ev
    expect(hudSnapshot(w).cosmic).toEqual({ kind: "meteorShower", stage: "warning", secondsLeft: 1.5 })
    ev.stage = "active"
    ev.t = 4
    expect(hudSnapshot(w).cosmic).toEqual({ kind: "meteorShower", stage: "active", secondsLeft: 5 })
  })

  it("is a copy: mutating the snapshot's power does not change the player", () => {
    const w = controlledWorld({ botCount: 1 })
    const h = hudSnapshot(w)
    h.power.phase = 99
    expect(w.bodies[0].power.phase).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("determinism across arenas", { timeout: 60000 }, () => {
  const ARENAS_UNDER_TEST = ["classic", "binary", "maw", "nebula", "belt"] as const
  const scripted = (tick: number, index: number): Intent => ({
    ax: Math.cos(tick * 0.031 + index * 1.7),
    ay: Math.sin(tick * 0.027 + index * 0.9),
    pull: Math.floor(tick / 45 + index) % 3 === 0,
    dash: tick % (97 + index) === 0,
    repulse: tick % (131 + index) === 0,
    ult: tick % (211 + index) === 0,
  })
  function run(w: World, from: number, to: number) {
    for (let t = from; t < to; t++) {
      const intents: Record<string, Intent> = {}
      w.bodies.forEach((b, i) => {
        intents[b.id] = scripted(t, i)
      })
      step(w, intents)
    }
  }

  for (const arena of ARENAS_UNDER_TEST) {
    it(`${arena}: same seed + arena + scripted intents (with ability flags) for 600 playing steps are JSON-equal`, () => {
      const a = createWorld({ seed: 77, difficulty: "normal", arena })
      const b = createWorld({ seed: 77, difficulty: "normal", arena })
      expect(snapshot(a)).toBe(snapshot(b))
      run(a, 0, 181 + 600)
      run(b, 0, 181 + 600)
      expect(snapshot(a)).toBe(snapshot(b))
      expect(snapshot(a)).not.toBe(snapshot(createWorld({ seed: 77, difficulty: "normal", arena })))
    })
  }

  it("cloneWorld keeps every Phase A field independent and continues identically", () => {
    const a = createWorld({ seed: 31, difficulty: "normal", arena: "nebula" })
    run(a, 0, 400)
    const c = cloneWorld(a)
    run(a, 400, 700)
    run(c, 400, 700)
    expect(snapshot(c)).toBe(snapshot(a))
    const d = cloneWorld(a)
    const before = snapshot(a)
    d.zones.forEach((z) => (z.x += 1))
    d.bodies[0].power.phase = 9
    d.pickups.push({ id: 999999, kind: "bulk", x: 0, y: 0, ttl: 1 })
    d.wells.forEach((wl) => {
      if (wl.orbit) wl.orbit.phase += 1
    })
    expect(snapshot(a)).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
describe("Leaving play ends the Singularity and power-ups", () => {
  // Contract (step() "Leaving play"): whenever a body stops being alive in a step (well death in 7,
  // absorbed in 9, rotation leave in 12E e), if ultActive > 0 emit ultEnd for it first; then
  // ultActive = 0 and every power timer = 0.
  const loaded = (b: World["bodies"][number], phase = 0) => {
    b.ultActive = 3
    b.power = { overdrive: 4, magnet: 5, phase }
  }
  const idx = (w: World, type: string, bodyId?: string) =>
    w.events.findIndex((e) => e.type === type && (bodyId === undefined || (e as { bodyId?: string }).bodyId === bodyId))

  it("dying in a lethal well: ultEnd before the death, then ultActive and every power timer are 0", () => {
    const w = controlledWorld({ botCount: 2 })
    addWell(w, "star", 0, 0)
    placeBody(w, 1, 0, 0)
    loaded(w.bodies[1])
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
    const ends = eventsOf(w, "ultEnd").filter((e) => e.bodyId === "bot-1")
    expect(ends).toHaveLength(1)
    expect(idx(w, "ultEnd", "bot-1")).toBeLessThan(idx(w, "death", "bot-1"))
    expect(w.bodies[1].ultActive).toBe(0)
    expect(w.bodies[1].power).toEqual({ overdrive: 0, magnet: 0, phase: 0 })
  })

  it("the player dying in a well does the same", () => {
    const w = controlledWorld({ botCount: 2 })
    addWell(w, "blackhole", 0, 0)
    placeBody(w, 0, 0, 0)
    loaded(w.bodies[0])
    step(w, {})
    expect(w.bodies[0].alive).toBe(false)
    expect(eventsOf(w, "ultEnd").filter((e) => e.bodyId === "player")).toHaveLength(1)
    expect(w.bodies[0].ultActive).toBe(0)
    expect(w.bodies[0].power).toEqual({ overdrive: 0, magnet: 0, phase: 0 })
  })

  it("being absorbed: ultEnd before the death, state cleared; the absorber keeps its own Singularity", () => {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[0], 30)
    setMass(w.bodies[1], 10)
    placeBody(w, 0, 0, 0)
    placeBody(w, 1, 2, 0)
    loaded(w.bodies[1])
    w.bodies[0].ultActive = 3
    w.bodies[0].power.magnet = 5
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
    expect(eventsOf(w, "ultEnd").map((e) => e.bodyId)).toEqual(["bot-1"])
    expect(idx(w, "ultEnd", "bot-1")).toBeLessThan(idx(w, "death", "bot-1"))
    expect(w.bodies[1].ultActive).toBe(0)
    expect(w.bodies[1].power).toEqual({ overdrive: 0, magnet: 0, phase: 0 })
    expect(w.bodies[0].alive).toBe(true)
    expect(w.bodies[0].ultActive).toBeGreaterThan(0)
    expect(w.bodies[0].power.magnet).toBeGreaterThan(0)
  })

  it("an endless rotation leave: ultEnd before the leave event, state cleared, no death event", () => {
    const w = endlessWorld({ botCount: 4, seed: 6 })
    placeBody(w, 0, 0, 0)
    for (const b of w.bodies.slice(1)) loaded(b)
    w.endless!.rotateIn = DT / 2
    step(w, {})
    const leaves = eventsOf(w, "leave")
    expect(leaves).toHaveLength(1)
    const id = leaves[0].bodyId
    expect(eventsOf(w, "ultEnd").filter((e) => e.bodyId === id)).toHaveLength(1)
    expect(idx(w, "ultEnd", id)).toBeLessThan(idx(w, "leave", id))
    const gone = w.bodies.find((b) => b.id === id)!
    expect(gone.alive).toBe(false)
    expect(gone.ultActive).toBe(0)
    expect(gone.power).toEqual({ overdrive: 0, magnet: 0, phase: 0 })
    expect(eventsOf(w, "death")).toHaveLength(0)
    for (const b of w.bodies.slice(1)) if (b.id !== id) expect(b.ultActive).toBeGreaterThan(0)
  })

  it("a body without an active Singularity emits no ultEnd when it leaves play, but its power timers are still cleared", () => {
    const w = controlledWorld({ botCount: 2 })
    addWell(w, "star", 0, 0)
    placeBody(w, 1, 0, 0)
    w.bodies[1].power = { overdrive: 4, magnet: 5, phase: 0 }
    step(w, {})
    expect(eventsOf(w, "ultEnd")).toHaveLength(0)
    expect(w.bodies[1].power).toEqual({ overdrive: 0, magnet: 0, phase: 0 })
  })

  it("a Singularity that runs out in the same step as the death gives exactly one ultEnd", () => {
    const w = controlledWorld({ botCount: 2 })
    addWell(w, "star", 0, 0)
    placeBody(w, 1, 0, 0)
    w.bodies[1].ultActive = DT / 2
    step(w, {})
    expect(w.bodies[1].alive).toBe(false)
    expect(eventsOf(w, "ultEnd").filter((e) => e.bodyId === "bot-1")).toHaveLength(1)
    expect(w.bodies[1].ultActive).toBe(0)
  })

  it("later steps do not emit anything more for the corpse", () => {
    const w = controlledWorld({ botCount: 2 })
    addWell(w, "star", 0, 0)
    placeBody(w, 1, 0, 0)
    loaded(w.bodies[1])
    step(w, {})
    for (let i = 0; i < 10; i++) {
      step(w, {})
      expect(eventsOf(w, "ultEnd")).toHaveLength(0)
    }
    expect(w.bodies[1].ultActive).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("Meteor shower spawning", () => {
  const cfg = CONFIG.cosmic.meteorShower

  function shower(overrides: Partial<CosmicEvent> = {}) {
    const w = controlledWorld({ botCount: 1 })
    const ev: CosmicEvent = {
      id: 1,
      kind: "meteorShower",
      stage: "warning",
      t: 0,
      warning: cfg.warning,
      duration: cfg.duration,
      x: 200,
      y: -300,
      r: cfg.radius,
      targetId: "",
      ...overrides,
    }
    w.cosmic = ev
    return { w, ev }
  }

  it("a full shower spawns exactly floor(duration * rate) rocks, the final step's included, none before it is active", () => {
    const { w, ev } = shower()
    const startId = w.nextDebrisId
    let guard = 0
    let spawnedBeforeActive = 0
    while (w.cosmic && guard++ < 5000) {
      const stage = w.cosmic.stage
      const idBefore = w.nextDebrisId
      step(w, {})
      if (stage === "warning") spawnedBeforeActive += w.nextDebrisId - idBefore
    }
    expect(w.cosmic).toBeNull()
    expect(spawnedBeforeActive).toBe(0)
    expect(w.nextDebrisId - startId).toBe(Math.floor(cfg.duration * cfg.rate))
    expect(ev.kind).toBe("meteorShower")
  })

  it("the last step's meteors still land when the shower ends on it", () => {
    // Choose a duration so that the final step crosses a whole-rock boundary.
    const duration = 5 / cfg.rate - 0.3 * DT
    const { w } = shower({ stage: "active", warning: 0, duration })
    let lastCount = -1
    let steps = 0
    let tBefore = 0
    let expectedLast = -1
    let total = 0
    while (w.cosmic && steps < 5000) {
      const idBefore = w.nextDebrisId
      tBefore = w.cosmic.t
      step(w, {})
      steps++
      const spawned = w.nextDebrisId - idBefore
      total += spawned
      if (!w.cosmic) {
        lastCount = spawned
        expectedLast = Math.floor((tBefore + DT) * cfg.rate) - Math.floor(tBefore * cfg.rate)
      }
    }
    expect(w.cosmic).toBeNull()
    expect(expectedLast).toBeGreaterThanOrEqual(1)
    expect(lastCount).toBe(expectedLast)
    expect(total).toBe(Math.floor(steps * DT * cfg.rate + 1e-9))
  })

  it("every meteor is a rock inside the shower's circle with each velocity component within +/- 80", () => {
    const { w, ev } = shower({ stage: "active", warning: 0 })
    let seen = 0
    for (let i = 0; i < 200 && w.cosmic; i++) {
      const idBefore = w.nextDebrisId
      step(w, {})
      for (const d of w.debris.filter((x) => x.id >= idBefore)) {
        seen++
        expect(d.kind).toBe("rock")
        expect(d.mass).toBeGreaterThanOrEqual(CONFIG.debris.rockMass[0] - 1e-9)
        expect(d.mass).toBeLessThanOrEqual(CONFIG.debris.rockMass[1] + 1e-9)
        expect(Math.hypot(d.x - ev.x, d.y - ev.y)).toBeLessThanOrEqual(ev.r + 1e-9)
        expect(Math.abs(d.vx)).toBeLessThanOrEqual(80 + 1e-9)
        expect(Math.abs(d.vy)).toBeLessThanOrEqual(80 + 1e-9)
      }
    }
    expect(seen).toBeGreaterThan(10)
  })

  it("meteors are not counted against debris.target", () => {
    const { w } = shower({ stage: "active", warning: 0 })
    for (let i = 0; i < CONFIG.debris.target; i++) makeDebris(w, "dust", 900 + (i % 50), -900 + Math.floor(i / 50) * 3, 1)
    const before = w.debris.length
    stepN(w, 120)
    expect(w.debris.length).toBeGreaterThan(before)
  })
})
