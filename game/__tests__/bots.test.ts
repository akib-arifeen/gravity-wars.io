// Bot tests, written from the contract only: the exported signatures and doc comments of
// bots.ts and engine.ts, plus types.ts and config.ts. Tunables come from CONFIG by name.

import { describe, expect, it } from "vitest"
import { botIntent, createBotBrain } from "../bots"
import { CONFIG } from "../config"
import { createWorld, radiusForMass, step } from "../engine"
import type { Difficulty, Intent, World } from "../types"
import {
  DT,
  addWell,
  controlledWorld,
  decisionIntents,
  expectClose,
  makeDebris,
  placeBody,
  setMass,
  snapshot,
} from "./helpers"

const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"]
const ZERO: Intent = { ax: 0, ay: 0, pull: false }

/** A real world stepped through its countdown so phase is "playing". */
function startedWorld(difficulty: Difficulty, seed: number, botCount?: number): World {
  const w = createWorld({ seed, difficulty, botCount })
  let guard = 0
  while (w.phase === "countdown" && guard++ < 500) step(w, {})
  return w
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v)
  }
  return o
}

/** Two equal-mass bodies, bot-1 (index 1) and the player (index 0), no wells, debris or wormholes. */
function duel(botMass: number, rivalMass: number, botPos: [number, number], rivalPos: [number, number]) {
  const w = controlledWorld({ botCount: 1 })
  setMass(w.bodies[1], botMass)
  setMass(w.bodies[0], rivalMass)
  placeBody(w, 1, botPos[0], botPos[1])
  placeBody(w, 0, rivalPos[0], rivalPos[1])
  return w
}

// ---------------------------------------------------------------------------------------------
describe("1. createBotBrain", () => {
  it("is deterministic for the same arguments", () => {
    for (const difficulty of DIFFICULTIES) {
      const a = createBotBrain("bot-3", difficulty, 42)
      const b = createBotBrain("bot-3", difficulty, 42)
      expect(a).toEqual(b)
      expect(a.bodyId).toBe("bot-3")
      expect(a.difficulty).toBe(difficulty)
    }
  })

  it("thinkIn starts in [0, reaction]; seeds and ids give different brains", () => {
    for (const difficulty of DIFFICULTIES) {
      const reaction = CONFIG.difficulty[difficulty].reaction
      const seen = new Set<number>()
      for (let seed = 1; seed <= 30; seed++) {
        const t = createBotBrain("bot-1", difficulty, seed).thinkIn
        expect(t).toBeGreaterThanOrEqual(0)
        expect(t).toBeLessThanOrEqual(reaction)
        seen.add(t)
      }
      expect(seen.size, `${difficulty} thinkIn should vary with the seed`).toBeGreaterThan(5)
    }
    const a = createBotBrain("bot-1", "normal", 7)
    const b = createBotBrain("bot-2", "normal", 7)
    expect(a.rngState === b.rngState && a.thinkIn === b.thinkIn).toBe(false)
  })

  it("starts with a coasting intent and a valid rng state", () => {
    const b = createBotBrain("bot-1", "hard", 5)
    expect(b.current).toEqual(ZERO)
    expect(Number.isInteger(b.rngState)).toBe(true)
    expect(b.rngState).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("2. zero intent when it cannot act", () => {
  it("during the countdown", () => {
    const w = createWorld({ seed: 3, difficulty: "normal" })
    expect(w.phase).toBe("countdown")
    const brain = createBotBrain("bot-1", "normal", 3)
    for (let i = 0; i < 100; i++) expect(botIntent(w, brain)).toEqual(ZERO)
  })

  it("for a dead body", () => {
    const w = startedWorld("hard", 3)
    w.bodies[1].alive = false
    const brain = createBotBrain("bot-1", "hard", 3)
    for (let i = 0; i < 100; i++) expect(botIntent(w, brain)).toEqual(ZERO)
  })

  it("for an unknown id", () => {
    const w = startedWorld("hard", 3)
    const brain = createBotBrain("ghost", "hard", 3)
    for (let i = 0; i < 100; i++) expect(botIntent(w, brain)).toEqual(ZERO)
  })

  it("after the round is over", () => {
    const w = startedWorld("normal", 3)
    w.phase = "over"
    const brain = createBotBrain("bot-1", "normal", 3)
    for (let i = 0; i < 50; i++) expect(botIntent(w, brain)).toEqual(ZERO)
  })

  it("acts again as soon as the world is playing", () => {
    const w = startedWorld("hard", 4)
    const brain = createBotBrain("bot-1", "hard", 4)
    let moved = false
    for (let i = 0; i < 120 && !moved; i++) {
      const it = botIntent(w, brain)
      moved = Math.hypot(it.ax, it.ay) > 0
    }
    expect(moved).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
describe("3. botIntent never mutates the world", () => {
  it("a deep-frozen playing world survives 300 calls per bot without a write attempt", () => {
    for (const difficulty of DIFFICULTIES) {
      const w = startedWorld(difficulty, 8)
      const before = snapshot(w)
      deepFreeze(w)
      const brains = w.bodies.map((b) => createBotBrain(b.id, difficulty, 8))
      for (let i = 0; i < 300; i++) brains.forEach((brain) => botIntent(w, brain))
      expect(snapshot(w)).toBe(before)
    }
  })

  it("JSON before/after is identical across 300 interleaved calls and steps", () => {
    const w = startedWorld("normal", 11, 3)
    const brains = w.bodies.map((b) => createBotBrain(b.id, "normal", 11))
    for (let i = 0; i < 300; i++) {
      const before = snapshot(w)
      const intents: Record<string, Intent> = {}
      w.bodies.forEach((b, k) => {
        intents[b.id] = botIntent(w, brains[k])
      })
      expect(snapshot(w), `step ${i}`).toBe(before)
      step(w, intents)
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe("4. a 20 s run on each difficulty", () => {
  for (const difficulty of DIFFICULTIES) {
    it(`${difficulty}: intents are finite, within thrustScale, and pull only if usesPull`, () => {
      const profile = CONFIG.difficulty[difficulty]
      const w = createWorld({ seed: 31, difficulty })
      const brains = w.bodies.map((b) => createBotBrain(b.id, difficulty, 31))
      const steps = Math.ceil((CONFIG.round.countdown + 20) / DT)
      let nonZero = 0
      let pulls = 0
      for (let i = 0; i < steps && w.phase !== "over"; i++) {
        const intents: Record<string, Intent> = {}
        w.bodies.forEach((b, k) => {
          if (!b.alive) return
          const it = botIntent(w, brains[k])
          expect(Number.isFinite(it.ax) && Number.isFinite(it.ay), `${b.id} step ${i}`).toBe(true)
          expect(Math.hypot(it.ax, it.ay), `${b.id} step ${i}`).toBeLessThanOrEqual(profile.thrustScale + 1e-9)
          if (!profile.usesPull) expect(it.pull, `${b.id} step ${i}`).toBe(false)
          if (Math.hypot(it.ax, it.ay) > 0) nonZero++
          if (it.pull) pulls++
          intents[b.id] = it
        })
        step(w, intents)
      }
      expect(nonZero, "bots should actually thrust").toBeGreaterThan(100)
      if (!profile.usesPull) expect(pulls).toBe(0)
    }, 20000)
  }

  it("bots keep making progress: after 20 s of play the average living bot is heavier than it started", () => {
    const w = createWorld({ seed: 5, difficulty: "normal" })
    const start = w.bodies.map((b) => b.mass)
    const brains = w.bodies.map((b) => createBotBrain(b.id, "normal", 5))
    for (let i = 0; i < Math.ceil((CONFIG.round.countdown + 20) / DT) && w.phase !== "over"; i++) {
      const intents: Record<string, Intent> = {}
      w.bodies.forEach((b, k) => {
        if (b.alive) intents[b.id] = botIntent(w, brains[k])
      })
      step(w, intents)
    }
    const living = w.bodies.map((b, i) => ({ b, i })).filter(({ b }) => b.alive)
    expect(living.length).toBeGreaterThan(0)
    const grew = living.filter(({ b, i }) => b.mass > start[i]).length
    expect(grew).toBeGreaterThan(0)
  }, 20000)
})

// ---------------------------------------------------------------------------------------------
describe("5. reaction time is real", () => {
  for (const difficulty of DIFFICULTIES) {
    it(`${difficulty}: the intent repeats unchanged between decisions and decisions are ~reaction apart`, () => {
      const reaction = CONFIG.difficulty[difficulty].reaction
      const w = startedWorld(difficulty, 6)
      const brain = createBotBrain("bot-1", difficulty, 6)
      let last: Intent = { ...brain.current }
      let decisions = 0
      const calls = Math.round(10 / DT)
      for (let i = 0; i < calls; i++) {
        const before = brain.thinkIn
        const result = botIntent(w, brain)
        const redecided = brain.thinkIn > before - DT + 1e-9
        if (redecided) {
          decisions++
          expect(before - DT, `call ${i}: decides only when thinkIn has run out`).toBeLessThanOrEqual(1e-9)
          expectClose(brain.thinkIn, before - DT + reaction, 1e-9, "thinkIn is topped up by the reaction time")
        } else {
          expectClose(brain.thinkIn, before - DT, 1e-9, "thinkIn counts down by dt")
          expect(result, `call ${i}: held intent`).toEqual(last)
        }
        last = result
      }
      expect(Math.abs(decisions - 10 / reaction)).toBeLessThanOrEqual(2)
    })
  }
})

// ---------------------------------------------------------------------------------------------
describe("6. flee", () => {
  for (const difficulty of DIFFICULTIES) {
    it(`${difficulty}: a mass-10 bot runs from a mass-40 rival 150 u to its right`, () => {
      const w = duel(10, 40, [0, 0], [150, 0])
      const brain = createBotBrain("bot-1", difficulty, 2)
      const decisions = decisionIntents(w, brain, 4)
      expect(decisions).toHaveLength(4)
      for (const it of decisions) expect(it.ax, JSON.stringify(it)).toBeLessThan(0)
    })
  }

  it("fleeing works in the other direction too (rival to the left, above)", () => {
    const w = duel(10, 40, [0, 0], [-100, -100])
    const brain = createBotBrain("bot-1", "hard", 3)
    for (const it of decisionIntents(w, brain, 3)) {
      expect(it.ax + it.ay).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe("7. hunt", () => {
  for (const difficulty of ["normal", "hard"] as const) {
    it(`${difficulty}: a mass-40 bot goes after a mass-10 rival 300 u to its right (the player is valid prey)`, () => {
      const w = duel(40, 10, [0, 0], [300, 0])
      w.time = CONFIG.difficulty[difficulty].huntGrace
      expect(w.bodies[0].id).toBe("player")
      const brain = createBotBrain("bot-1", difficulty, 2)
      const decisions = decisionIntents(w, brain, 4)
      expect(decisions).toHaveLength(4)
      for (const it of decisions) expect(it.ax, JSON.stringify(it)).toBeGreaterThan(0)
    })
  }

  it("hard: aims ahead of prey that is moving sideways (aimLead = 1)", () => {
    const w = duel(40, 10, [0, 0], [300, 0])
    w.bodies[0].vy = 200
    w.time = CONFIG.difficulty.hard.huntGrace
    const brain = createBotBrain("bot-1", "hard", 9)
    const decisions = decisionIntents(w, brain, 4)
    for (const it of decisions) {
      expect(it.ax, JSON.stringify(it)).toBeGreaterThan(0)
      expect(it.ay, JSON.stringify(it)).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe("7b. huntGrace: no hunting or pulling at prey in the opening seconds", () => {
  for (const difficulty of ["normal", "hard"] as const) {
    const grace = CONFIG.difficulty[difficulty].huntGrace

    it(`${difficulty}: before huntGrace (${grace}s) the bot does not steer at nearby prey or pull for it`, () => {
      for (const time of [0, grace * 0.5, grace - 0.5]) {
        const w = duel(40, 10, [0, 0], [120, 0])
        w.time = time
        w.bodies[1].energy = CONFIG.energy.max
        const brain = createBotBrain("bot-1", difficulty, 3)
        const decisions = decisionIntents(w, brain, 5)
        expect(decisions).toHaveLength(5)
        for (const it of decisions) {
          expect(it.pull, `time ${time}: ${JSON.stringify(it)}`).toBe(false)
          // The only thing in the world is the prey, so any hunting would show up as thrust towards +x.
          expect(it.ax, `time ${time}: ${JSON.stringify(it)}`).toBeLessThanOrEqual(1e-9)
        }
      }
    })

    it(`${difficulty}: at huntGrace the same bot hunts and pulls`, () => {
      for (const time of [grace, grace + 5]) {
        const w = duel(40, 10, [0, 0], [120, 0])
        w.time = time
        w.bodies[1].energy = CONFIG.energy.max
        const brain = createBotBrain("bot-1", difficulty, 3)
        for (const it of decisionIntents(w, brain, 4)) {
          expect(it.ax, `time ${time}: ${JSON.stringify(it)}`).toBeGreaterThan(0)
          expect(it.pull, `time ${time}: ${JSON.stringify(it)}`).toBe(true)
        }
      }
    })
  }

  for (const difficulty of DIFFICULTIES) {
    it(`${difficulty}: before huntGrace debris is still grazed`, () => {
      const w = duel(40, 10, [0, 0], [300, 0])
      w.time = 0
      for (const [ox, oy] of [[-20, 0], [0, 20], [20, 0], [0, -20], [10, 10], [-10, -10]]) makeDebris(w, "dust", -200 + ox, oy, 1)
      const brain = createBotBrain("bot-1", difficulty, 5)
      for (const it of decisionIntents(w, brain, 4)) expect(it.ax, JSON.stringify(it)).toBeLessThan(0)
    })
  }
})

// ---------------------------------------------------------------------------------------------
describe("8. survive", () => {
  for (const kind of ["star", "blackhole"] as const) {
    for (const difficulty of DIFFICULTIES) {
      it(`${difficulty}: just outside a ${kind}'s kill distance the intent points away from it`, () => {
        const w = duel(CONFIG.body.startMass, CONFIG.body.startMass, [0, 0], [0, 1700])
        const well = addWell(w, kind, 0, 0)
        const bot = w.bodies[1]
        placeBody(w, 1, well.radius + bot.radius * CONFIG.well.killOverlap + 10, 0)
        const brain = createBotBrain("bot-1", difficulty, 4)
        const decisions = decisionIntents(w, brain, 4)
        expect(decisions).toHaveLength(4)
        for (const it of decisions) {
          const dot = it.ax * (bot.x - well.x) + it.ay * (bot.y - well.y)
          expect(dot, JSON.stringify(it)).toBeGreaterThan(0)
        }
      })
    }
  }

  for (const difficulty of DIFFICULTIES) {
    it(`${difficulty}: never aims straight through a star to reach debris behind it`, () => {
      const w = duel(CONFIG.body.startMass, CONFIG.body.startMass, [-300, 0], [0, 1700])
      const star = addWell(w, "star", 0, 0)
      for (const [ox, oy] of [
        [0, 0],
        [15, 10],
        [-12, 18],
        [20, -15],
        [-18, -12],
        [5, 25],
      ]) {
        makeDebris(w, "dust", 300 + ox, oy, 1)
      }
      const bot = w.bodies[1]
      const brain = createBotBrain("bot-1", difficulty, 12)
      for (const it of decisionIntents(w, brain, 4)) {
        const len = Math.hypot(it.ax, it.ay)
        if (len < 1e-9) continue
        const ux = it.ax / len
        const uy = it.ay / len
        const toStar = { x: star.x - bot.x, y: star.y - bot.y }
        const along = toStar.x * ux + toStar.y * uy
        const miss = Math.abs(toStar.x * uy - toStar.y * ux)
        if (along > 0) {
          expect(miss, `aim ${JSON.stringify(it)} passes ${miss.toFixed(1)} u from the star centre`).toBeGreaterThanOrEqual(
            star.radius,
          )
        }
      }
    })
  }
})

// ---------------------------------------------------------------------------------------------
describe("9. graze", () => {
  const cluster: [number, number][] = [
    [-20, 0],
    [0, 20],
    [20, 0],
    [0, -20],
    [10, 10],
    [-10, -10],
  ]
  for (const difficulty of DIFFICULTIES) {
    it(`${difficulty}: with only a debris cluster around (-200, 0) the bot heads left`, () => {
      const w = duel(CONFIG.body.startMass, CONFIG.body.startMass, [0, 0], [0, 1700])
      for (const [ox, oy] of cluster) makeDebris(w, "dust", -200 + ox, oy, 1)
      const brain = createBotBrain("bot-1", difficulty, 5)
      const decisions = decisionIntents(w, brain, 4)
      expect(decisions).toHaveLength(4)
      for (const it of decisions) expect(it.ax, JSON.stringify(it)).toBeLessThan(0)
    })
  }

  it("prefers a big nearby cluster to a lone far piece", () => {
    const w = duel(CONFIG.body.startMass, CONFIG.body.startMass, [0, 0], [0, 1700])
    for (const [ox, oy] of cluster) makeDebris(w, "dust", 150 + ox, oy, 1)
    makeDebris(w, "dust", -600, 0, 1)
    const brain = createBotBrain("bot-1", "hard", 5)
    for (const it of decisionIntents(w, brain, 4)) expect(it.ax, JSON.stringify(it)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("10. arena wall and pull", () => {
  for (const difficulty of DIFFICULTIES) {
    it(`${difficulty}: a bot at the wall does not push outward`, () => {
      const a = 2.3
      const r = CONFIG.arena.radius - 30
      const w = duel(CONFIG.body.startMass, CONFIG.body.startMass, [Math.cos(a) * r, Math.sin(a) * r], [-300, 0])
      w.bodies[1].vx = Math.cos(a) * 150
      w.bodies[1].vy = Math.sin(a) * 150
      const brain = createBotBrain("bot-1", difficulty, 8)
      for (const it of decisionIntents(w, brain, 4)) {
        const outward = it.ax * Math.cos(a) + it.ay * Math.sin(a)
        expect(outward, JSON.stringify(it)).toBeLessThanOrEqual(1e-9)
      }
    })
  }

  for (const difficulty of ["normal", "hard"] as const) {
    it(`${difficulty}: pulls when prey is inside pullRadius and energy is high, not when energy is low`, () => {
      const w = duel(40, 10, [0, 0], [120, 0])
      w.time = CONFIG.difficulty[difficulty].huntGrace
      expect(120).toBeLessThan(CONFIG.pull.baseRadius + radiusForMass(40) * CONFIG.pull.radiusPerR)
      w.bodies[1].energy = CONFIG.energy.max
      const brain = createBotBrain("bot-1", difficulty, 3)
      for (const it of decisionIntents(w, brain, 4)) expect(it.pull, JSON.stringify(it)).toBe(true)

      const low = duel(40, 10, [0, 0], [120, 0])
      low.time = CONFIG.difficulty[difficulty].huntGrace
      low.bodies[1].energy = CONFIG.energy.lowThreshold * 0.5
      const lowBrain = createBotBrain("bot-1", difficulty, 3)
      for (const it of decisionIntents(low, lowBrain, 4)) expect(it.pull, JSON.stringify(it)).toBe(false)
    })

    it(`${difficulty}: pulls on a dense debris patch inside pullRadius when energy is high`, () => {
      const w = duel(CONFIG.body.startMass, CONFIG.body.startMass, [0, 0], [0, 1700])
      w.bodies[1].energy = CONFIG.energy.max
      for (let i = 0; i < 12; i++) {
        const a = (Math.PI * 2 * i) / 12
        makeDebris(w, "dust", -90 + Math.cos(a) * 25, Math.sin(a) * 25, 1)
      }
      const brain = createBotBrain("bot-1", difficulty, 3)
      for (const it of decisionIntents(w, brain, 4)) expect(it.pull, JSON.stringify(it)).toBe(true)
    })
  }

  it("easy never pulls even when prey is right next to it", () => {
    const w = duel(40, 10, [0, 0], [60, 0])
    const brain = createBotBrain("bot-1", "easy", 3)
    for (const it of decisionIntents(w, brain, 6)) expect(it.pull).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe("11. hunting restraint and survival priority", () => {
  /** True if a thrust along `it` from `from` passes within `clearance` of the well centre. */
  function headsPast(it: Intent, from: { x: number; y: number }, well: { x: number; y: number }, clearance: number) {
    const len = Math.hypot(it.ax, it.ay)
    if (len < 1e-9) return false
    const ux = it.ax / len
    const uy = it.ay / len
    const tx = well.x - from.x
    const ty = well.y - from.y
    return tx * ux + ty * uy > 0 && Math.abs(tx * uy - ty * ux) < clearance
  }

  for (const difficulty of ["normal", "hard"] as const) {
    const grace = CONFIG.difficulty[difficulty].huntGrace

    it(`${difficulty}: a shielded rival is not hunted; the same rival without a shield is`, () => {
      const shielded = duel(40, 10, [0, 0], [300, 0])
      shielded.time = grace
      shielded.bodies[0].shield = 1
      const brain = createBotBrain("bot-1", difficulty, 3)
      for (const it of decisionIntents(shielded, brain, 4)) expect(it.ax, JSON.stringify(it)).toBeLessThanOrEqual(1e-9)

      const open = duel(40, 10, [0, 0], [300, 0])
      open.time = grace
      const brain2 = createBotBrain("bot-1", difficulty, 3)
      for (const it of decisionIntents(open, brain2, 4)) expect(it.ax, JSON.stringify(it)).toBeGreaterThan(0)
    })
  }

  for (const difficulty of DIFFICULTIES) {
    const grace = CONFIG.difficulty[difficulty].huntGrace

    it(`${difficulty}: prey whose line passes close to a well is not targeted`, () => {
      const w = duel(40, 10, [-400, 0], [400, 0])
      w.time = grace
      const star = addWell(w, "star", 0, 70)
      const clearance = star.radius + 40
      const bot = w.bodies[1]
      const brain = createBotBrain("bot-1", difficulty, 6)
      for (const it of decisionIntents(w, brain, 4)) {
        expect(headsPast(it, bot, star, clearance), `aim ${JSON.stringify(it)} grazes the star`).toBe(false)
      }
    })

    it(`${difficulty}: debris whose line passes close to a well is not targeted`, () => {
      const w = duel(CONFIG.body.startMass, CONFIG.body.startMass, [-400, 0], [0, 1700])
      const star = addWell(w, "star", 0, 70)
      const clearance = star.radius + 40
      for (const [ox, oy] of [[-20, 0], [0, 20], [20, 0], [0, -20], [10, 10], [-10, -10]]) makeDebris(w, "dust", 400 + ox, oy, 1)
      const bot = w.bodies[1]
      const brain = createBotBrain("bot-1", difficulty, 6)
      for (const it of decisionIntents(w, brain, 4)) {
        expect(headsPast(it, bot, star, clearance), `aim ${JSON.stringify(it)} grazes the star`).toBe(false)
      }
    })

    it(`${difficulty}: survival beats hunting: near a well's kill distance the bot moves away, not at its prey`, () => {
      const w = duel(40, 10, [0, 0], [-200, 0])
      w.time = grace
      const star = addWell(w, "star", 0, 0)
      const bot = w.bodies[1]
      placeBody(w, 1, star.radius + bot.radius * CONFIG.well.killOverlap + 10, 0)
      const brain = createBotBrain("bot-1", difficulty, 4)
      const decisions = decisionIntents(w, brain, 4)
      expect(decisions).toHaveLength(4)
      for (const it of decisions) {
        expect(it.ax * (bot.x - star.x) + it.ay * (bot.y - star.y), JSON.stringify(it)).toBeGreaterThan(0)
      }
    })
  }
})
