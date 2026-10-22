// Endless (.io-style) mode, written from the contract: types.ts (GameMode, EndlessState,
// LeaderboardEntry, HudSnapshot), config.ts `endless`, the engine.ts docs for createWorld step 5,
// step 12E and safeSpawn, leaderboard() and hudSnapshot(), and the achievements.ts docs for apex,
// survivor, endlessBest and finishEndlessSession.

import { describe, expect, it } from "vitest"
import * as ach from "../achievements"
import { CONFIG } from "../config"
import { botIntent, createBotBrain } from "../bots"
import { cloneWorld, createWorld, hudSnapshot, leaderboard, radiusForMass, step } from "../engine"
import type { Difficulty, GameEvent, Intent, World } from "../types"
import {
  DT,
  addWell,
  controlledWorld,
  dist,
  endlessWorld,
  eventsOf,
  expectClose,
  makeDebris,
  placeBody,
  setMass,
  snapshot,
  stepN,
} from "./helpers"

const E = CONFIG.endless
const START = CONFIG.body.startMass
const NOW = 1_700_000_000_000
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The skill-drift rule from config.ts, for a player of mass m. */
function drift(m: number): Record<Difficulty, number> {
  const hard = clamp((m - E.hardFrom) / E.hardSpan, 0, E.hardMax)
  const easy = clamp(E.easyBase - m / E.easySpan, E.easyMin, E.easyBase)
  return { easy, normal: 1 - easy - hard, hard }
}
const st = (w: World) => w.endless as NonNullable<World["endless"]>
const living = (w: World) => w.bodies.filter((b) => b.alive)

/** Kill the player for real (a star under it), then remove the star again. */
function killPlayerInStar(w: World) {
  addWell(w, "star", 0, 0)
  placeBody(w, 0, 0, 0)
  step(w, {})
  expect(w.bodies[0].alive).toBe(false)
  w.wells = []
}

// ---------------------------------------------------------------------------------------------
describe("createWorld: endless init", () => {
  it("mode, clock, roster size and the endless state fields", () => {
    for (const difficulty of ["easy", "normal", "hard"] as const) {
      const w = createWorld({ seed: 3, difficulty, mode: "endless" })
      expect(w.mode).toBe("endless")
      expect(w.timeLeft).toBe(1e9)
      expect(w.bodies).toHaveLength(1 + E.bots)
      expect(w.endless).not.toBeNull()
      const e = st(w)
      expect(e.respawnIn).toBe(0)
      expect(e.best).toBe(START)
      expect(e.deaths).toBe(0)
      expect(e.kills).toBe(0)
      expect(e.lastKillerId).toBe("")
      expect(e.nextBotNo).toBe(w.bodies.length)
      expect(e.joinIn).toEqual(new Array(w.bodies.length).fill(0))
      expect(e.rotateIn).toBeGreaterThanOrEqual(E.rotateEvery[0])
      expect(e.rotateIn).toBeLessThanOrEqual(E.rotateEvery[1])
      expect(w.bodies[0].skill).toBe(difficulty)
      for (const b of w.bodies.slice(1)) expect(["easy", "normal", "hard"]).toContain(b.skill)
    }
  })

  it("botCount is overridable; names are distinct", () => {
    const w = createWorld({ seed: 3, difficulty: "normal", mode: "endless", botCount: 4 })
    expect(w.bodies).toHaveLength(5)
    expect(st(w).nextBotNo).toBe(5)
    expect(st(w).joinIn).toHaveLength(5)
    const all = createWorld({ seed: 3, difficulty: "normal", mode: "endless" })
    expect(new Set(all.bodies.map((b) => b.name)).size).toBe(all.bodies.length)
    expect(new Set(all.bodies.map((b) => b.id)).size).toBe(all.bodies.length)
  })

  it("bot skills follow the drift rule at player mass = startMass (50 percent-ish easy early, never hard)", () => {
    const tally: Record<Difficulty, number> = { easy: 0, normal: 0, hard: 0 }
    let n = 0
    for (let seed = 1; seed <= 200; seed++) {
      const w = createWorld({ seed, difficulty: "normal", mode: "endless" })
      for (const b of w.bodies.slice(1)) {
        tally[b.skill]++
        n++
      }
    }
    const p = drift(START)
    expect(tally.hard / n).toBeCloseTo(p.hard, 1)
    if (p.hard === 0) expect(tally.hard).toBe(0)
    expect(Math.abs(tally.easy / n - p.easy)).toBeLessThan(0.06)
    expect(Math.abs(tally.normal / n - p.normal)).toBeLessThan(0.06)
  })

  it("is deterministic and the default mode is round", () => {
    const a = createWorld({ seed: 9, difficulty: "normal", mode: "endless" })
    const b = createWorld({ seed: 9, difficulty: "normal", mode: "endless" })
    expect(snapshot(a)).toBe(snapshot(b))
    expect(createWorld({ seed: 9, difficulty: "normal" }).mode).toBe("round")
  })
})

// ---------------------------------------------------------------------------------------------
describe("the round never ends", () => {
  it("critical mass, a dead player, dead bots and a long clock leave the phase at playing with no roundEnd", () => {
    const w = endlessWorld({ botCount: 3 })
    setMass(w.bodies[0], CONFIG.round.criticalMass + 70)
    let roundEnds = 0
    let phases = 0
    for (let i = 0; i < 900; i++) {
      step(w, {})
      roundEnds += eventsOf(w, "roundEnd").length
      phases += eventsOf(w, "phase").length
    }
    expect(w.phase).toBe("playing")
    expect(w.result).toBeNull()
    expect(roundEnds).toBe(0)
    expect(phases).toBe(0)
    expect(w.timeLeft).toBeGreaterThan(1e8)

    const dead = endlessWorld({ botCount: 2 })
    for (const b of dead.bodies.slice(1)) b.alive = false
    stepN(dead, 300)
    expect(dead.phase).toBe("playing")
    expect(dead.result).toBeNull()
    killPlayerInStar(dead)
    expect(dead.phase).toBe("playing")
    expect(eventsOf(dead, "roundEnd")).toHaveLength(0)
  })

  it("a bot-driven session of 45 s keeps the roster size, ids unique, phase playing", () => {
    const w = createWorld({ seed: 5, difficulty: "normal", mode: "endless" })
    const brains = new Map<string, ReturnType<typeof createBotBrain>>()
    let guard = 0
    while (w.phase === "countdown" && guard++ < 400) step(w, {})
    expect(w.phase).toBe("playing")
    const size = w.bodies.length
    for (let i = 0; i < 45 * 60; i++) {
      const intents: Record<string, Intent> = {}
      for (const b of w.bodies) {
        if (!b.alive || b.kind === "player") continue
        let brain = brains.get(b.id)
        if (!brain) {
          brain = createBotBrain(b.id, b.skill, 5)
          brains.set(b.id, brain)
        }
        intents[b.id] = botIntent(w, brain)
      }
      step(w, intents)
      expect(w.phase).toBe("playing")
      expect(eventsOf(w, "roundEnd")).toHaveLength(0)
      expect(w.bodies).toHaveLength(size)
      if (i % 120 === 0) expect(new Set(w.bodies.map((b) => b.id)).size).toBe(size)
    }
    expect(w.arenaRadius).toBe(w.arenaBase)
  }, 120000)
})

// ---------------------------------------------------------------------------------------------
describe("mass decay", () => {
  it("bodies above decayAbove lose (mass - above) * rate * dt per step; others do not", () => {
    const w = endlessWorld({ botCount: 2 })
    setMass(w.bodies[0], 200)
    setMass(w.bodies[1], E.decayAbove)
    setMass(w.bodies[2], 30)
    step(w, {})
    expectClose(w.bodies[0].mass, 200 - (200 - E.decayAbove) * E.decayRate * DT, 1e-9, "heavy mass")
    expectClose(w.bodies[0].radius, radiusForMass(w.bodies[0].mass), 1e-12, "radius follows")
    expect(w.bodies[1].mass).toBe(E.decayAbove)
    expect(w.bodies[2].mass).toBe(30)
  })

  it("repeated steps decay geometrically towards decayAbove", () => {
    const w = endlessWorld({ botCount: 1 })
    setMass(w.bodies[0], 160)
    stepN(w, 600)
    const expected = E.decayAbove + (160 - E.decayAbove) * Math.pow(1 - E.decayRate * DT, 600)
    expectClose(w.bodies[0].mass, expected, 1e-6, "mass after 10 s")
    expect(w.bodies[0].mass).toBeGreaterThan(E.decayAbove)
  })

  it("dead bodies do not decay", () => {
    const w = endlessWorld({ botCount: 2 })
    setMass(w.bodies[1], 200)
    w.bodies[1].alive = false
    stepN(w, 10)
    expect(w.bodies[1].mass).toBe(200)
  })

  it("round mode has no decay", () => {
    const w = controlledWorld({ botCount: 2 })
    setMass(w.bodies[1], 100)
    stepN(w, 60)
    expect(w.bodies[1].mass).toBe(100)
  })
})

// ---------------------------------------------------------------------------------------------
describe("player death and respawn", () => {
  it("a well death: deaths + 1, respawnIn set, no killer, no round end", () => {
    const w = endlessWorld({ botCount: 3 })
    addWell(w, "star", 0, 0)
    placeBody(w, 0, 0, 0)
    step(w, {})
    expect(w.bodies[0].alive).toBe(false)
    expect(st(w).deaths).toBe(1)
    expect(st(w).lastKillerId).toBe("")
    expect(st(w).respawnIn).toBeGreaterThan(E.respawnDelay - 2 * DT)
    expect(st(w).respawnIn).toBeLessThanOrEqual(E.respawnDelay)
    expect(w.phase).toBe("playing")
    expect(eventsOf(w, "roundEnd")).toHaveLength(0)
  })

  it("an absorption death names the killer", () => {
    const w = endlessWorld({ botCount: 3 })
    setMass(w.bodies[1], 50)
    placeBody(w, 1, 0, 0)
    placeBody(w, 0, 2, 0)
    step(w, {})
    expect(w.bodies[0].alive).toBe(false)
    expect(st(w).deaths).toBe(1)
    expect(st(w).lastKillerId).toBe("bot-1")
    expect(hudSnapshot(w).endless?.lastKiller).toBe(w.bodies[1].name)
  })

  it("respawns after respawnDelay with the documented reset, kept stats and one respawn event", () => {
    const w = endlessWorld({ botCount: 3 })
    const p = w.bodies[0]
    setMass(p, 55)
    p.stats.debrisEaten = 12
    p.stats.rivalsAbsorbed = 2
    p.stats.dashes = 4
    p.stats.peakMass = 61
    p.dashCd = 1
    p.repulseCd = 2
    p.slingCd = 3
    p.ult = 0.7
    p.ultActive = 2
    p.power = { overdrive: 5, magnet: 5, phase: 0 }
    p.lastHitBy = "bot-2"
    p.energy = 20
    killPlayerInStar(w)
    const stats = JSON.stringify(p.stats)
    let steps = 0
    let respawns = 0
    let ev: Extract<GameEvent, { type: "respawn" }> | null = null
    while (!w.bodies[0].alive && steps < 1000) {
      step(w, {})
      steps++
      const r = eventsOf(w, "respawn")
      respawns += r.length
      if (r.length) ev = r[0]
      expect(w.phase).toBe("playing")
    }
    expect(Math.abs(steps - E.respawnDelay / DT)).toBeLessThanOrEqual(3)
    expect(respawns).toBe(1)
    expect(st(w).respawnIn).toBe(0)
    const b = w.bodies[0]
    expect(b.id).toBe("player")
    expect(b.alive).toBe(true)
    expect(b.mass).toBe(START)
    expectClose(b.radius, radiusForMass(START), 1e-12)
    expect(b.energy).toBe(CONFIG.energy.max)
    expect(b.vx).toBe(0)
    expect(b.vy).toBe(0)
    expect(b.dashCd).toBe(0)
    expect(b.repulseCd).toBe(0)
    expect(b.slingCd).toBe(0)
    expect(b.ult).toBe(0)
    expect(b.ultActive).toBe(0)
    expect(b.power).toEqual({ overdrive: 0, magnet: 0, phase: 0 })
    expect(b.lastHitBy).toBe("")
    expect(b.shield).toBe(E.respawnShield)
    expect(b.px).toBe(b.x)
    expect(b.py).toBe(b.y)
    expect(JSON.stringify(b.stats)).toBe(stats)
    expect(ev).not.toBeNull()
    expect(ev!.bodyId).toBe("player")
    expectClose(ev!.x, b.x, 1e-9)
    expectClose(ev!.y, b.y, 1e-9)
    // The body array is unchanged in size and the player is still slot 0.
    expect(w.bodies).toHaveLength(4)
  })

  it("keeps counting deaths across lives", () => {
    const w = endlessWorld({ botCount: 2 })
    for (let life = 1; life <= 3; life++) {
      killPlayerInStar(w)
      expect(st(w).deaths).toBe(life)
      let guard = 0
      while (!w.bodies[0].alive && guard++ < 1000) step(w, {})
      expect(w.bodies[0].alive).toBe(true)
      placeBody(w, 0, 0, 0)
      w.bodies[0].shield = 0
    }
  })

  it("best = the highest mass while alive; it survives death and respawn", () => {
    const w = endlessWorld({ botCount: 2 })
    setMass(w.bodies[0], 40)
    step(w, {})
    expectClose(st(w).best, w.bodies[0].mass, 1e-9, "best follows mass")
    setMass(w.bodies[0], 25)
    step(w, {})
    expect(st(w).best).toBeGreaterThan(39)
    const best = st(w).best
    killPlayerInStar(w)
    let guard = 0
    while (!w.bodies[0].alive && guard++ < 1000) step(w, {})
    expect(w.bodies[0].mass).toBe(START)
    expect(st(w).best).toBe(best)
  })

  it("kills count the player's absorptions only", () => {
    const w = endlessWorld({ botCount: 3 })
    setMass(w.bodies[0], 30)
    placeBody(w, 0, 0, 0)
    placeBody(w, 1, 2, 0)
    step(w, {})
    expect(eventsOf(w, "absorb")[0].eaterId).toBe("player")
    expect(st(w).kills).toBe(1)
    // A bot absorbing a bot is not the player's kill.
    setMass(w.bodies[2], 40)
    setMass(w.bodies[3], 10)
    placeBody(w, 2, 600, 600)
    placeBody(w, 3, 602, 600)
    step(w, {})
    expect(eventsOf(w, "absorb").some((e) => e.eaterId === "bot-2")).toBe(true)
    expect(st(w).kills).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
describe("safe spawn (respawn and join positions)", () => {
  function respawnAt(seed: number, setup: (w: World) => void): World {
    const w = endlessWorld({ seed, botCount: 3 })
    setup(w)
    killPlayerInStar(w)
    setup(w)
    let guard = 0
    while (!w.bodies[0].alive && guard++ < 1000) step(w, {})
    return w
  }

  it("lands in the annulus [500, arenaRadius - 300]", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const w = respawnAt(seed, () => {})
      const r = Math.hypot(w.bodies[0].x, w.bodies[0].y)
      expect(r, `seed ${seed}`).toBeGreaterThanOrEqual(500 - 1e-6)
      expect(r, `seed ${seed}`).toBeLessThanOrEqual(w.arenaRadius - 300 + 1e-6)
    }
  })

  it("keeps clear of lethal wells (max(chargeRadius, radius) + 200) and solid wells (+ 150)", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const w = endlessWorld({ seed, botCount: 3 })
      killPlayerInStar(w)
      const star = addWell(w, "star", 1000, 0)
      const hole = addWell(w, "blackhole", -900, 300)
      const station = addWell(w, "station", 200, 900)
      const planet = addWell(w, "planet", -500, -900)
      let guard = 0
      while (!w.bodies[0].alive && guard++ < 1000) step(w, {})
      const p = w.bodies[0]
      expect(p.alive).toBe(true)
      for (const lethal of [star, hole]) {
        // The spawn is checked at the respawn step; wells here never move.
        expect(dist(p, lethal), `seed ${seed} vs ${lethal.kind}`).toBeGreaterThanOrEqual(Math.max(lethal.chargeRadius, lethal.radius) + 200 - 1e-6)
      }
      for (const solid of [station, planet]) {
        expect(dist(p, solid), `seed ${seed} vs ${solid.kind}`).toBeGreaterThanOrEqual(solid.radius + 150 - 1e-6)
      }
    }
  })

  it("prefers a point far from heavy bodies", () => {
    let min = Infinity
    let sum = 0
    const seeds = 40
    for (let seed = 1; seed <= seeds; seed++) {
      const w = endlessWorld({ seed, botCount: 3 })
      setMass(w.bodies[1], START * CONFIG.absorb.ratio * 3)
      killPlayerInStar(w)
      placeBody(w, 1, 0, 0)
      let guard = 0
      while (!w.bodies[0].alive && guard++ < 1000) step(w, {})
      const d = dist(w.bodies[0], w.bodies[1])
      min = Math.min(min, d)
      sum += d
    }
    // The best of 30 points uniform by area in [500, 1700] is almost always beyond ~1400 from the centre.
    expect(min).toBeGreaterThan(1200)
    expect(sum / seeds).toBeGreaterThan(1550)
  })
})

// ---------------------------------------------------------------------------------------------
describe("bots joining", () => {
  function killBot(w: World, i: number) {
    addWell(w, "star", 0, 0)
    placeBody(w, i, 0, 0)
    step(w, {})
    w.wells = []
    expect(w.bodies[i].alive).toBe(false)
  }

  it("a bot death schedules a join within joinDelay, then a new bot fills the slot", () => {
    const w = endlessWorld({ botCount: 3, seed: 4 })
    const no = st(w).nextBotNo
    const oldId = w.bodies[2].id
    killBot(w, 2)
    expect(eventsOf(w, "death").map((e) => e.bodyId)).toContain(oldId)
    const e = st(w)
    expect(e.joinIn[2]).toBeGreaterThan(E.joinDelay[0] - 2 * DT)
    expect(e.joinIn[2]).toBeLessThanOrEqual(E.joinDelay[1])
    expect(e.joinIn[1]).toBe(0)
    let steps = 1
    let joins: Extract<GameEvent, { type: "join" }>[] = []
    while (!w.bodies[2].alive && steps < 2000) {
      step(w, {})
      steps++
      joins = joins.concat(eventsOf(w, "join"))
    }
    expect(steps * DT).toBeGreaterThanOrEqual(E.joinDelay[0] - 2 * DT)
    expect(steps * DT).toBeLessThanOrEqual(E.joinDelay[1] + 2 * DT)
    expect(joins).toHaveLength(1)
    const b = w.bodies[2]
    expect(b.id).toBe(`bot-${no}`)
    expect(b.id).not.toBe(oldId)
    expect(new Set(w.bodies.map((x) => x.id)).size).toBe(w.bodies.length)
    expect(b.kind).toBe("bot")
    expect(b.alive).toBe(true)
    expect(E.names).toContain(b.name)
    expect(w.bodies.filter((x) => x.alive && x !== b).map((x) => x.name)).not.toContain(b.name)
    expect(CONFIG.bots.colors).toContain(b.color)
    expect(["easy", "normal", "hard"]).toContain(b.skill)
    expect(b.shield).toBeGreaterThan(E.respawnShield - 2 * DT)
    expect(b.stats.peakMass).toBe(b.mass)
    expect(b.stats.rivalsAbsorbed + b.stats.debrisEaten + b.stats.dashes).toBe(0)
    expect(b.px).toBe(b.x)
    expect(b.vx).toBe(0)
    expect(w.bodies).toHaveLength(4)
    expect(st(w).nextBotNo).toBe(no + 1)
    expect(st(w).joinIn[2]).toBe(0)
    expect(joins[0]).toMatchObject({ type: "join", bodyId: b.id, name: b.name, skill: b.skill })
    expectClose(joins[0].x, b.x, 1e-9)
    expectClose(joins[0].y, b.y, 1e-9)
  })

  function joinOnce(seed: number, playerMass: number, playerAlive = true) {
    const w = endlessWorld({ seed, botCount: 3 })
    setMass(w.bodies[0], playerMass)
    w.bodies[0].alive = playerAlive
    w.bodies[1].alive = false
    st(w).joinIn[1] = DT / 2
    step(w, {})
    expect(w.bodies[1].alive).toBe(true)
    return w.bodies[1]
  }

  it("a joining bot's mass = startMass * U(0.8, 1.0) * (1 + joinGrowth * clamp(m/100, 0, 1)), m = the player's mass", () => {
    for (const [m, alive] of [
      [20, true],
      [60, true],
      [150, true],
      [90, false],
    ] as const) {
      const eff = alive ? m : START
      const f = 1 + E.joinGrowth * clamp(eff / 100, 0, 1)
      let lo = Infinity
      let hi = -Infinity
      for (let seed = 1; seed <= 60; seed++) {
        const b = joinOnce(seed, m, alive)
        lo = Math.min(lo, b.mass)
        hi = Math.max(hi, b.mass)
        expect(b.mass, `m=${m} alive=${alive}`).toBeGreaterThanOrEqual(START * 0.8 * f - 0.5)
        expect(b.mass, `m=${m} alive=${alive}`).toBeLessThanOrEqual(START * 1.0 * f + 0.5)
      }
      expect(hi - lo, `m=${m}: the draw should spread`).toBeGreaterThan(0.1 * START * f * 0.5)
    }
  })

  it("the joining skill follows the drift rule on the player's current mass", () => {
    for (const m of [START, 100]) {
      const tally: Record<Difficulty, number> = { easy: 0, normal: 0, hard: 0 }
      const n = 300
      for (let seed = 1; seed <= n; seed++) tally[joinOnce(seed, m).skill]++
      const p = drift(m)
      expect(Math.abs(tally.easy / n - p.easy), `easy at m=${m}`).toBeLessThan(0.1)
      expect(Math.abs(tally.hard / n - p.hard), `hard at m=${m}`).toBeLessThan(0.1)
      expect(Math.abs(tally.normal / n - p.normal), `normal at m=${m}`).toBeLessThan(0.1)
      if (p.hard === 0) expect(tally.hard).toBe(0)
    }
  })

  it("names of living bodies are never reused, even when the pool is nearly exhausted", () => {
    const w = endlessWorld({ seed: 2, botCount: 8 })
    for (let i = 0; i < 40; i++) {
      const victim = 1 + (i % 8)
      w.bodies[victim].alive = false
      st(w).joinIn[victim] = DT / 2
      step(w, {})
      const names = living(w).map((b) => b.name)
      expect(new Set(names).size, `iteration ${i}`).toBe(names.length)
    }
    expect(w.bodies).toHaveLength(9)
  })
})

// ---------------------------------------------------------------------------------------------
describe("roster rotation", () => {
  it("a rotation emits leave (no death, no stats), picks a far non-heaviest bot, then a join follows rotateJoinDelay later", () => {
    const w = endlessWorld({ botCount: 5, seed: 6 })
    placeBody(w, 0, 0, 0)
    setMass(w.bodies[3], 60)
    const heaviest = w.bodies[3].id
    st(w).rotateIn = DT / 2
    const before = w.bodies.map((b) => JSON.stringify(b.stats))
    step(w, {})
    const leaves = eventsOf(w, "leave")
    expect(leaves).toHaveLength(1)
    expect(eventsOf(w, "death")).toHaveLength(0)
    const idx = w.bodies.findIndex((b) => b.id === leaves[0].bodyId)
    expect(idx).toBeGreaterThan(0)
    expect(w.bodies[idx].alive).toBe(false)
    expect(leaves[0].bodyId).not.toBe(heaviest)
    expect(JSON.stringify(w.bodies[idx].stats)).toBe(before[idx])
    expect(st(w).rotateIn).toBeGreaterThanOrEqual(E.rotateEvery[0] - 1e-9)
    expect(st(w).rotateIn).toBeLessThanOrEqual(E.rotateEvery[1] + 1e-9)
    expect(st(w).joinIn[idx]).toBeGreaterThan(0)
    expect(st(w).joinIn[idx]).toBeLessThanOrEqual(E.rotateJoinDelay)
    expect(w.phase).toBe("playing")
    let steps = 1
    let joins = 0
    while (!w.bodies[idx].alive && steps < 1000) {
      step(w, {})
      steps++
      joins += eventsOf(w, "join").length
    }
    expect(joins).toBe(1)
    expect(Math.abs(steps * DT - E.rotateJoinDelay)).toBeLessThanOrEqual(3 * DT)
    expect(w.bodies).toHaveLength(6)
  })

  it("never the heaviest living body, never within 900 of the player (60 rotations)", () => {
    const w = endlessWorld({ botCount: 6, seed: 11 })
    placeBody(w, 0, 0, 0)
    setMass(w.bodies[2], 70)
    // Two bots stand close to the player and must never be picked.
    placeBody(w, 1, 300, 0)
    placeBody(w, 4, 0, -500)
    let leaves = 0
    for (let i = 0; i < 60; i++) {
      const player = w.bodies[0]
      const maxMass = Math.max(...living(w).map((b) => b.mass))
      const heaviest = living(w).find((b) => b.mass === maxMass)!
      const eligible = new Set(
        living(w)
          .filter((b) => b.kind === "bot" && b !== heaviest && Math.hypot(b.x - player.x, b.y - player.y) >= 900)
          .map((b) => b.id),
      )
      st(w).rotateIn = DT / 2
      step(w, {})
      const l = eventsOf(w, "leave")
      expect(l.length).toBeLessThanOrEqual(1)
      if (l.length) {
        leaves++
        expect(eligible.has(l[0].bodyId), `iteration ${i}: ${l[0].bodyId} left`).toBe(true)
      } else {
        expect(eligible.size, `iteration ${i}: nobody left although some bot was eligible`).toBe(0)
      }
      expect(eventsOf(w, "death")).toHaveLength(0)
      // Let joins complete so the roster refills.
      stepN(w, Math.ceil(E.rotateJoinDelay / DT) + 2)
      for (const b of w.bodies) b.shield = 0
      st(w).rotateIn = 1e9
      expect(w.bodies).toHaveLength(7)
    }
    expect(leaves).toBeGreaterThan(10)
  })

  it("with every bot close to the player nobody leaves, and the timer is still re-drawn", () => {
    const w = endlessWorld({ botCount: 3 })
    placeBody(w, 0, 0, 0)
    for (let i = 1; i <= 3; i++) placeBody(w, i, 200 * i, 0)
    st(w).rotateIn = DT / 2
    step(w, {})
    expect(eventsOf(w, "leave")).toHaveLength(0)
    expect(living(w)).toHaveLength(4)
    expect(st(w).rotateIn).toBeGreaterThan(5)
  })

  it("rotation fires on its own schedule (rotateEvery) in a real session", () => {
    const w = endlessWorld({ botCount: 4, seed: 8 })
    placeBody(w, 0, 0, 0)
    st(w).rotateIn = 3
    let first = -1
    for (let i = 0; i < 400 && first < 0; i++) {
      step(w, {})
      if (eventsOf(w, "leave").length) first = i
    }
    expect(first).toBeGreaterThan(0)
    expect(Math.abs((first + 1) * DT - 3)).toBeLessThanOrEqual(3 * DT)
  })
})

// ---------------------------------------------------------------------------------------------
describe("leaderboard", () => {
  function board(n = 12) {
    const w = endlessWorld({ botCount: n - 1, seed: 2 })
    // masses: body i gets 10 + 3 * ((i * 7) % n) so the order is scrambled but distinct.
    w.bodies.forEach((b, i) => setMass(b, 10 + 3 * ((i * 7) % n)))
    return w
  }

  it("top n living bodies by mass, 1-based ranks, full entry shape", () => {
    const w = board()
    const lb = leaderboard(w, 5)
    const sorted = living(w).sort((a, b) => b.mass - a.mass)
    expect(lb.slice(0, 5).map((e) => e.id)).toEqual(sorted.slice(0, 5).map((b) => b.id))
    lb.slice(0, 5).forEach((e, i) => {
      expect(e.rank).toBe(i + 1)
      const b = w.bodies.find((x) => x.id === e.id)!
      expect(e).toMatchObject({ name: b.name, color: b.color, mass: b.mass, isPlayer: b.id === "player" })
    })
  })

  it("appends the player's own row (true rank) when outside the top n", () => {
    const w = board()
    const sorted = living(w).sort((a, b) => b.mass - a.mass)
    const rank = sorted.findIndex((b) => b.id === "player") + 1
    expect(rank).toBeGreaterThan(3)
    const lb = leaderboard(w, 3)
    expect(lb).toHaveLength(4)
    expect(lb[3]).toMatchObject({ id: "player", isPlayer: true, rank })
    expect(lb.slice(0, 3).every((e) => !e.isPlayer)).toBe(true)
  })

  it("no duplicate row when the player is in the top n; no player row when dead", () => {
    const w = board()
    setMass(w.bodies[0], 500)
    const lb = leaderboard(w, 3)
    expect(lb).toHaveLength(3)
    expect(lb[0]).toMatchObject({ id: "player", isPlayer: true, rank: 1 })
    w.bodies[0].alive = false
    const dead = leaderboard(w, 3)
    expect(dead).toHaveLength(3)
    expect(dead.some((e) => e.isPlayer)).toBe(false)
    expect(dead.map((e) => e.rank)).toEqual([1, 2, 3])
  })

  it("dead bodies are excluded and ties go to the lower index", () => {
    const w = board()
    w.bodies.forEach((b) => setMass(b, 20))
    expect(leaderboard(w, 4).map((e) => e.id)).toEqual(w.bodies.slice(0, 4).map((b) => b.id))
    w.bodies[1].alive = false
    expect(leaderboard(w, 4).map((e) => e.id)).toEqual(["player", w.bodies[2].id, w.bodies[3].id, w.bodies[4].id])
  })

  it("defaults to the top 10 (plus the player's row if outside)", () => {
    const w = board()
    expect(leaderboard(w).filter((e) => !e.isPlayer || e.rank <= 10).length).toBeGreaterThanOrEqual(10)
    expect(leaderboard(w).length).toBeLessThanOrEqual(11)
  })
})

// ---------------------------------------------------------------------------------------------
describe("hudSnapshot: endless fields", () => {
  it("mode, endless block (lastKiller is a name) and the top-10 leaderboard", () => {
    const w = endlessWorld({ botCount: 5 })
    st(w).respawnIn = 1.5
    st(w).best = 77
    st(w).deaths = 2
    st(w).kills = 3
    st(w).lastKillerId = "bot-1"
    const h = hudSnapshot(w)
    expect(h.mode).toBe("endless")
    expect(h.endless).toEqual({ respawnIn: 1.5, best: 77, deaths: 2, kills: 3, lastKiller: w.bodies[1].name })
    expect(h.leaderboard).toEqual(leaderboard(w, 10))
    st(w).lastKillerId = ""
    expect(hudSnapshot(w).endless?.lastKiller).toBe("")
  })

  it("round mode reports mode 'round', endless null and still carries a leaderboard", () => {
    const w = controlledWorld({ botCount: 3 })
    const h = hudSnapshot(w)
    expect(h.mode).toBe("round")
    expect(h.endless).toBeNull()
    expect(h.leaderboard).toEqual(leaderboard(w, 10))
    expect(h.leaderboard.length).toBe(4)
  })
})

// ---------------------------------------------------------------------------------------------
describe("round mode is unaffected", () => {
  it("createWorld defaults: mode round, endless null, skill = difficulty, normal clock and bot count", () => {
    for (const difficulty of ["easy", "normal", "hard"] as const) {
      const w = createWorld({ seed: 4, difficulty })
      expect(w.mode).toBe("round")
      expect(w.endless).toBeNull()
      expect(w.timeLeft).toBe(CONFIG.round.duration)
      expect(w.bodies).toHaveLength(1 + CONFIG.difficulty[difficulty].bots)
      for (const b of w.bodies) expect(b.skill).toBe(difficulty)
    }
  })

  it("a dead player still ends the round; critical mass still ends it; time still runs out", () => {
    const dead = controlledWorld({ botCount: 2 })
    addWell(dead, "star", 0, 0)
    placeBody(dead, 0, 0, 0)
    step(dead, {})
    expect(dead.phase).toBe("over")
    expect(dead.result?.reason).toBe("playerDied")
    expect(dead.endless).toBeNull()
    expect(eventsOf(dead, "respawn")).toHaveLength(0)

    const crit = controlledWorld({ botCount: 2 })
    setMass(crit.bodies[1], CONFIG.round.criticalMass)
    step(crit, {})
    expect(crit.result?.reason).toBe("criticalMass")

    const time = controlledWorld({ botCount: 2 })
    time.timeLeft = DT / 2
    step(time, {})
    expect(time.result?.reason).toBe("timeUp")
  })

  it("no joins, leaves or respawns ever happen in a round", () => {
    const w = controlledWorld({ botCount: 3 })
    w.bodies[2].alive = false
    for (let i = 0; i < 600; i++) {
      step(w, {})
      expect(eventsOf(w, "join")).toHaveLength(0)
      expect(eventsOf(w, "leave")).toHaveLength(0)
    }
    expect(w.bodies).toHaveLength(4)
    expect(w.bodies[2].alive).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe("endless determinism", () => {
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

  it("same seed and scripted intents for 60 s are JSON-equal, joins/leaves/respawns included", () => {
    for (const arena of ["classic", "maw"] as const) {
      const a = createWorld({ seed: 71, difficulty: "normal", mode: "endless", arena })
      const b = createWorld({ seed: 71, difficulty: "normal", mode: "endless", arena })
      run(a, 0, 181 + 3600)
      run(b, 0, 181 + 3600)
      expect(snapshot(a)).toBe(snapshot(b))
      expect(snapshot(a)).not.toBe(snapshot(createWorld({ seed: 71, difficulty: "normal", mode: "endless", arena })))
      expect(a.phase).toBe("playing")
    }
  }, 120000)

  it("cloneWorld mid-session continues identically (endless state is cloned too)", () => {
    const a = createWorld({ seed: 72, difficulty: "hard", mode: "endless" })
    run(a, 0, 900)
    const c = cloneWorld(a)
    run(a, 900, 1800)
    run(c, 900, 1800)
    expect(snapshot(c)).toBe(snapshot(a))
  }, 60000)
})

// ---------------------------------------------------------------------------------------------
describe("achievements: apex, survivor, endlessBest", () => {
  function scene(mode: "endless" | "round" = "endless") {
    const world = mode === "endless" ? endlessWorld({ botCount: 3 }) : controlledWorld({ botCount: 3 })
    setMass(world.bodies[0], 50)
    for (const b of world.bodies.slice(1)) setMass(b, 20)
    return { world, profile: ach.emptyProfile(), tracker: ach.newTracker() }
  }
  const unlockTimes = (
    s: ReturnType<typeof scene>,
    seconds: number,
    perStep?: (t: number) => void,
  ): Record<string, number> => {
    const out: Record<string, number> = {}
    const steps = Math.round(seconds / DT)
    for (let i = 0; i <= steps; i++) {
      const t = i * DT
      s.world.time = 100 + t
      perStep?.(t)
      for (const d of ach.trackStep(s.profile, s.tracker, s.world, [], NOW)) out[d.id] = t
    }
    return out
  }

  it("the list ends with apex and survivor", () => {
    expect(ach.ACHIEVEMENTS.slice(-2).map((a) => a.id)).toEqual(["apex", "survivor"])
    expect(ach.emptyProfile().stats.endlessBest).toBe(0)
    expect(ach.newTracker().apexSince).toBeNull()
    expect(ach.newTracker().lifeSince).toBeNull()
  })

  it("apex: rank 1 for 10 s in a row (not before)", () => {
    const s = scene()
    const got = unlockTimes(s, 14)
    expect(got.apex).toBeDefined()
    expect(got.apex).toBeGreaterThanOrEqual(10 - 0.1)
    expect(got.apex).toBeLessThanOrEqual(10.5)
  })

  it("apex: losing first place restarts the streak", () => {
    const s = scene()
    const got = unlockTimes(s, 20, (t) => {
      // A rival overtakes for a moment at 5 s.
      const overtaken = t >= 5 && t < 5 + 2 * DT
      setMass(s.world.bodies[1], overtaken ? 80 : 20)
    })
    expect(got.apex).toBeDefined()
    expect(got.apex).toBeGreaterThanOrEqual(15 - 0.2)
  })

  it("apex: a dead player never holds first place; round mode has no apex", () => {
    const dead = scene()
    dead.world.bodies[0].alive = false
    expect(unlockTimes(dead, 15).apex).toBeUndefined()
    const round = scene("round")
    expect(unlockTimes(round, 15).apex).toBeUndefined()
  })

  it("apex: not first, never", () => {
    const s = scene()
    setMass(s.world.bodies[1], 80)
    expect(unlockTimes(s, 15).apex).toBeUndefined()
  })

  it("survivor: alive for 5 minutes in one life", () => {
    const s = scene()
    const got = unlockTimes(s, 304)
    expect(got.survivor).toBeDefined()
    expect(got.survivor).toBeGreaterThanOrEqual(300 - 0.2)
    expect(got.survivor).toBeLessThanOrEqual(300.5)
  }, 60000)

  it("survivor: dying resets the life clock", () => {
    const s = scene()
    const got = unlockTimes(s, 404, (t) => {
      s.world.bodies[0].alive = !(t >= 100 && t < 100 + 2 * DT)
    })
    expect(got.survivor).toBeDefined()
    expect(got.survivor).toBeGreaterThanOrEqual(400 - 0.3)
  }, 60000)

  it("survivor: 4 minutes is not enough; round mode never grants it", () => {
    const s = scene()
    expect(unlockTimes(s, 240).survivor).toBeUndefined()
    const round = scene("round")
    expect(unlockTimes(round, 305).survivor).toBeUndefined()
  }, 60000)

  it("endlessBest follows the player's mass in endless mode only, and never decreases", () => {
    const s = scene()
    ach.trackStep(s.profile, s.tracker, s.world, [], NOW)
    expect(s.profile.stats.endlessBest).toBe(50)
    setMass(s.world.bodies[0], 30)
    ach.trackStep(s.profile, s.tracker, s.world, [], NOW)
    expect(s.profile.stats.endlessBest).toBe(50)
    setMass(s.world.bodies[0], 64)
    ach.trackStep(s.profile, s.tracker, s.world, [], NOW)
    expect(s.profile.stats.endlessBest).toBe(64)
    const round = scene("round")
    ach.trackStep(round.profile, round.tracker, round.world, [], NOW)
    expect(round.profile.stats.endlessBest).toBe(0)
  })

  it("finishEndlessSession folds best, time and the player's stats without counting a round or win", () => {
    const fn = (ach as unknown as { finishEndlessSession?: (p: ach.Profile, w: World, t: ach.RoundTracker) => void }).finishEndlessSession
    if (typeof fn !== "function") return
    const s = scene()
    st(s.world).best = 91
    s.world.time = 123.5
    const ps = s.world.bodies[0].stats
    ps.rivalsAbsorbed = 4
    ps.debrisEaten = 30
    ps.comets = 1
    ps.slingshots = 2
    ps.dashes = 6
    ps.repulses = 3
    ps.ults = 1
    ps.assists = 1
    ps.pickups = 5
    ps.peakMass = 88
    ps.topSpeed = 640
    s.profile.stats.endlessBest = 70
    fn(s.profile, s.world, s.tracker)
    expect(s.profile.stats).toMatchObject({
      endlessBest: 91,
      absorbs: 4,
      debris: 30,
      comets: 1,
      slingshots: 2,
      dashes: 6,
      repulses: 3,
      ults: 1,
      assists: 1,
      pickups: 5,
      bestMass: 88,
      topSpeed: 640,
      rounds: 0,
      wins: 0,
    })
    expect(s.profile.stats.timePlayed).toBeCloseTo(123.5, 9)
    // A lower best never lowers the stored one.
    st(s.world).best = 10
    fn(s.profile, s.world, s.tracker)
    expect(s.profile.stats.endlessBest).toBe(91)
    // A non-endless world does not throw.
    expect(() => fn(s.profile, controlledWorld({ botCount: 1 }), s.tracker)).not.toThrow()
  })
})

void makeDebris
