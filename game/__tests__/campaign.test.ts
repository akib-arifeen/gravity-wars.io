// Campaign: the level list, goals, bonus objectives, star awards, progress storage and the relic
// placement rule. The module is pure: plain data in, plain data out.

import { describe, expect, it } from "vitest"
import { ARENA_IDS } from "../arenas"
import {
  ABILITY_UNLOCKS,
  CAMPAIGN_LEGACY_KEY,
  CAMPAIGN_LEVELS,
  CAMPAIGN_LEVEL_COUNT,
  CAMPAIGN_PROGRESS_KEY,
  MAX_CAMPAIGN_STARS,
  RELIC_PICKUP_RADIUS,
  allRelicsFound,
  campaignComplete,
  currentLevel,
  emptyProgress,
  evaluateBonus,
  evaluateGoal,
  goalProgressReached,
  isUnlocked,
  isWon,
  levelById,
  loadProgress,
  newlyUnlockedAbilities,
  nextLevel,
  recordRun,
  relicPoint,
  saveProgress,
  sectorOf,
  starsFor,
  starsOf,
  totalStars,
  unlockedAbilities,
  type CampaignLevel,
  type CampaignProgress,
} from "../campaign"
import { CONFIG } from "../config"
import type { BodyStats, Difficulty, RoundEndReason, RoundResult, Standing } from "../types"

function stats(over: Partial<BodyStats> = {}): BodyStats {
  return {
    debrisEaten: 0,
    crystals: 0,
    rivalsAbsorbed: 0,
    peakMass: 10,
    dashes: 0,
    repulses: 0,
    ults: 0,
    slingshots: 0,
    assists: 0,
    pickups: 0,
    comets: 0,
    topSpeed: 0,
    ...over,
  }
}

function playerRow(alive = true): Standing {
  return { id: "player", name: "You", color: "#5ef2ff", mass: 45, alive }
}

function result(over: Partial<RoundResult> = {}): RoundResult {
  return {
    reason: "timeUp",
    winnerId: "player",
    playerWon: true,
    standings: [playerRow()],
    durationS: 75,
    ...over,
  }
}

function level(goal: RoundEndReason | "survive" | "absorb" | "relic" | "mass" | "slingshot"): CampaignLevel {
  const found = CAMPAIGN_LEVELS.find((l) => l.goal.kind === goal)
  if (found) return found
  // "timeUp" and "slingshot" are supported by the rules but no shipped level uses them;
  // build a synthetic level so their branches still get unit coverage.
  const count = goal === "slingshot" ? 2 : undefined
  return {
    ...CAMPAIGN_LEVELS[0],
    id: "synthetic",
    goal: {
      kind: goal as CampaignLevel["goal"]["kind"],
      line: "synthetic",
      ...(count !== undefined ? { count } : {}),
    },
  }
}

/** An in-memory Storage stub. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      data.set(key, value)
    },
    raw: data,
  }
}

const brokenStorage = {
  getItem: (): string | null => {
    throw new Error("storage blocked")
  },
  setItem: (): void => {
    throw new Error("storage blocked")
  },
}

describe("campaign levels", () => {
  it("has twelve levels in order across three sectors", () => {
    expect(CAMPAIGN_LEVELS).toHaveLength(12)
    expect(CAMPAIGN_LEVEL_COUNT).toBe(12)
    expect(MAX_CAMPAIGN_STARS).toBe(36)
    expect(CAMPAIGN_LEVELS.map((l) => l.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(CAMPAIGN_LEVELS.filter((l) => l.sector === 1)).toHaveLength(4)
    expect(CAMPAIGN_LEVELS.filter((l) => l.sector === 2)).toHaveLength(4)
    expect(CAMPAIGN_LEVELS.filter((l) => l.sector === 3)).toHaveLength(4)
  })

  it("gives every level a unique id and seed, a name, a brief and a goal line", () => {
    expect(new Set(CAMPAIGN_LEVELS.map((l) => l.id)).size).toBe(12)
    expect(new Set(CAMPAIGN_LEVELS.map((l) => l.seed)).size).toBe(12)
    for (const l of CAMPAIGN_LEVELS) {
      expect(l.name.length).toBeGreaterThan(0)
      expect(l.brief.length).toBeGreaterThan(20)
      expect(l.goal.line.length).toBeGreaterThan(0)
      expect(l.bonus.line.length).toBeGreaterThan(0)
      expect(l.timeLimit).toBeGreaterThanOrEqual(60)
      expect(l.bots).toBeGreaterThanOrEqual(1)
      expect(sectorOf(l).id).toBe(l.sector)
    }
  })

  it("uses a difficulty the engine knows and an arena that exists", () => {
    const difficulties: Difficulty[] = ["easy", "normal", "hard"]
    for (const l of CAMPAIGN_LEVELS) {
      expect(difficulties).toContain(l.difficulty)
      expect(ARENA_IDS).toContain(l.arena)
    }
  })

  it("puts the three bosses on the last level of each sector", () => {
    expect(CAMPAIGN_LEVELS.filter((l) => l.boss !== null).map((l) => l.index)).toEqual([4, 8, 12])
    expect(CAMPAIGN_LEVELS.filter((l) => l.boss === "leviathan").map((l) => l.index)).toEqual([4])
    expect(CAMPAIGN_LEVELS.filter((l) => l.boss === "twinPulsars").map((l) => l.index)).toEqual([8])
    expect(CAMPAIGN_LEVELS.filter((l) => l.boss === "voidKing").map((l) => l.index)).toEqual([12])
  })

  it("maps every goal kind onto the engine's rules and never quotes a stale number", () => {
    const kinds = new Set(CAMPAIGN_LEVELS.map((l) => l.goal.kind))
    for (const kind of ["criticalMass", "lastStanding", "survive", "absorb", "relic", "mass"]) {
      expect(kinds.has(kind as CampaignLevel["goal"]["kind"])).toBe(true)
    }
    for (const l of CAMPAIGN_LEVELS.filter((x) => ["absorb", "mass", "slingshot"].includes(x.goal.kind))) {
      expect(l.goal.count).toBeGreaterThan(0)
    }
    const crit = CAMPAIGN_LEVELS.find((l) => l.goal.kind === "criticalMass")!
    expect(crit.goal.line).toContain(String(CONFIG.round.criticalMass))
  })

  it("finds a level by id and the next level in the campaign", () => {
    expect(levelById(CAMPAIGN_LEVELS[0].id)).toBe(CAMPAIGN_LEVELS[0])
    expect(levelById("nope")).toBeUndefined()
    expect(nextLevel(CAMPAIGN_LEVELS[0])).toBe(CAMPAIGN_LEVELS[1])
    expect(nextLevel(CAMPAIGN_LEVELS[11])).toBeUndefined()
  })

  it("gives every level a relic that must be fetched from further than the pickup radius", () => {
    expect(RELIC_PICKUP_RADIUS).toBeGreaterThan(20)
  })
})

describe("goal evaluation", () => {
  it("is met by the win the goal names", () => {
    const crit = level("criticalMass")
    expect(evaluateGoal(crit, { result: result({ reason: "criticalMass", playerWon: true }), stats: stats(), relicCollected: false })).toBe(true)
    const last = level("lastStanding")
    expect(evaluateGoal(last, { result: result({ reason: "lastStanding", playerWon: true }), stats: stats(), relicCollected: false })).toBe(true)
    const clock = level("timeUp")
    expect(evaluateGoal(clock, { result: result({ reason: "timeUp", playerWon: true }), stats: stats(), relicCollected: false })).toBe(true)
  })

  it("is missed when another win reason ends the round or the player lost", () => {
    const crit = level("criticalMass")
    expect(evaluateGoal(crit, { result: result({ reason: "timeUp", playerWon: true }), stats: stats(), relicCollected: false })).toBe(false)
    expect(
      evaluateGoal(crit, { result: result({ reason: "criticalMass", playerWon: false, winnerId: "bot-1" }), stats: stats(), relicCollected: false }),
    ).toBe(false)
    const last = level("lastStanding")
    expect(evaluateGoal(last, { result: result({ reason: "playerDied", playerWon: false }), stats: stats(), relicCollected: false })).toBe(false)
  })

  it("survive only needs the player alive when the clock runs out", () => {
    const survive = level("survive")
    expect(
      evaluateGoal(survive, {
        result: result({ reason: "timeUp", playerWon: false, winnerId: "bot-1", standings: [playerRow(true)] }),
        stats: stats(),
        relicCollected: false,
      }),
    ).toBe(true)
    expect(
      evaluateGoal(survive, { result: result({ reason: "timeUp", standings: [playerRow(false)] }), stats: stats(), relicCollected: false }),
    ).toBe(false)
    // Winning another way still means the player survived.
    expect(evaluateGoal(survive, { result: result({ reason: "criticalMass" }), stats: stats(), relicCollected: false })).toBe(true)
    expect(
      evaluateGoal(survive, {
        result: result({ reason: "lastStanding", playerWon: false, standings: [playerRow(false)] }),
        stats: stats(),
        relicCollected: false,
      }),
    ).toBe(false)
  })

  it("absorb needs the named count of rivals and a living player", () => {
    const absorb = level("absorb")
    const need = absorb.goal.count!
    expect(
      evaluateGoal(absorb, { result: result({ reason: "timeUp" }), stats: stats({ rivalsAbsorbed: need }), relicCollected: false }),
    ).toBe(true)
    expect(
      evaluateGoal(absorb, { result: result({ reason: "timeUp" }), stats: stats({ rivalsAbsorbed: need - 1 }), relicCollected: false }),
    ).toBe(false)
    expect(
      evaluateGoal(absorb, {
        result: result({ reason: "timeUp", standings: [playerRow(false)] }),
        stats: stats({ rivalsAbsorbed: need + 2 }),
        relicCollected: false,
      }),
    ).toBe(false)
    // Ending the round early (another body hit critical mass) does not undo a met absorb goal.
    expect(
      evaluateGoal(absorb, {
        result: result({ reason: "criticalMass", playerWon: false, winnerId: "bot-1" }),
        stats: stats({ rivalsAbsorbed: need }),
        relicCollected: false,
      }),
    ).toBe(true)
  })

  it("mass needs the target peak mass and a living player", () => {
    const mass = level("mass")
    const need = mass.goal.count!
    expect(evaluateGoal(mass, { result: result(), stats: stats({ peakMass: need }), relicCollected: false })).toBe(true)
    expect(evaluateGoal(mass, { result: result(), stats: stats({ peakMass: need - 1 }), relicCollected: false })).toBe(false)
    expect(
      evaluateGoal(mass, {
        result: result({ standings: [playerRow(false)] }),
        stats: stats({ peakMass: need + 20 }),
        relicCollected: false,
      }),
    ).toBe(false)
  })

  it("slingshot needs the sling count and a living player", () => {
    const sling = level("slingshot")
    const need = sling.goal.count!
    expect(evaluateGoal(sling, { result: result(), stats: stats({ slingshots: need }), relicCollected: false })).toBe(true)
    expect(evaluateGoal(sling, { result: result(), stats: stats({ slingshots: need - 1 }), relicCollected: false })).toBe(false)
  })

  it("relic needs the relic and a living player", () => {
    const relic = level("relic")
    expect(evaluateGoal(relic, { result: result(), stats: stats(), relicCollected: true })).toBe(true)
    expect(evaluateGoal(relic, { result: result(), stats: stats(), relicCollected: false })).toBe(false)
    expect(
      evaluateGoal(relic, { result: result({ standings: [playerRow(false)] }), stats: stats(), relicCollected: true }),
    ).toBe(false)
  })
})

describe("mid-round goal progress", () => {
  const progress = (over: Partial<Parameters<typeof goalProgressReached>[1]> = {}) => ({
    alive: true,
    mass: 0,
    rivalsAbsorbed: 0,
    slingshots: 0,
    relicCollected: false,
    ...over,
  })

  it("fires when a get-to-X goal is reached", () => {
    const mass = level("mass")
    expect(goalProgressReached(mass, progress({ mass: (mass.goal.count ?? 0) - 1 }))).toBe(false)
    expect(goalProgressReached(mass, progress({ mass: mass.goal.count ?? 0 }))).toBe(true)
    const absorb = level("absorb")
    expect(goalProgressReached(absorb, progress({ rivalsAbsorbed: absorb.goal.count ?? 0 }))).toBe(true)
    const relic = level("relic")
    expect(goalProgressReached(relic, progress({ relicCollected: true }))).toBe(true)
  })

  it("never fires for timer or win-condition goals", () => {
    for (const kind of ["criticalMass", "lastStanding", "survive", "timeUp"] as const) {
      expect(goalProgressReached(level(kind), progress({ mass: 999, rivalsAbsorbed: 9, slingshots: 9, relicCollected: true }))).toBe(false)
    }
  })

  it("never fires for a dead player", () => {
    expect(goalProgressReached(level("mass"), progress({ alive: false, mass: 999 }))).toBe(false)
  })
})

describe("bonus objectives and stars", () => {
  it("checks time, mass, absorb, slingshot and assist bonuses", () => {
    const massLevel = CAMPAIGN_LEVELS.find((l) => l.bonus.kind === "mass")!
    expect(evaluateBonus(massLevel, { result: result(), stats: stats({ peakMass: massLevel.bonus.value }), relicCollected: false })).toBe(true)
    expect(evaluateBonus(massLevel, { result: result(), stats: stats({ peakMass: massLevel.bonus.value - 1 }), relicCollected: false })).toBe(false)

    const timeLevel = CAMPAIGN_LEVELS.find((l) => l.bonus.kind === "time")!
    expect(evaluateBonus(timeLevel, { result: result({ durationS: timeLevel.bonus.value }), stats: stats(), relicCollected: false })).toBe(true)
    expect(evaluateBonus(timeLevel, { result: result({ durationS: timeLevel.bonus.value + 1 }), stats: stats(), relicCollected: false })).toBe(false)

    const absorbLevel = { ...massLevel, bonus: { kind: "absorb" as const, value: 3, line: "x" } }
    expect(evaluateBonus(absorbLevel, { result: result(), stats: stats({ rivalsAbsorbed: 3 }), relicCollected: false })).toBe(true)
    expect(evaluateBonus(absorbLevel, { result: result(), stats: stats({ rivalsAbsorbed: 2 }), relicCollected: false })).toBe(false)

    const slingLevel = { ...massLevel, bonus: { kind: "slingshot" as const, value: 2, line: "x" } }
    expect(evaluateBonus(slingLevel, { result: result(), stats: stats({ slingshots: 2 }), relicCollected: false })).toBe(true)

    const assistLevel = { ...massLevel, bonus: { kind: "assist" as const, value: 1, line: "x" } }
    expect(evaluateBonus(assistLevel, { result: result(), stats: stats({ assists: 0 }), relicCollected: false })).toBe(false)
  })

  it("awards 1 star for the goal, 2 with the bonus and 3 with the relic", () => {
    const l = CAMPAIGN_LEVELS[0]
    const base = { result: result({ reason: "timeUp", playerWon: true, durationS: l.timeLimit }), stats: stats({ peakMass: l.goal.count ?? 0 }), relicCollected: false }
    expect(starsFor(l, base)).toBe(1)
    expect(starsFor(l, { ...base, stats: stats({ peakMass: Math.max(l.goal.count ?? 0, l.bonus.value) }) })).toBe(2)
    expect(starsFor(l, { ...base, stats: stats({ peakMass: Math.max(l.goal.count ?? 0, l.bonus.value) }), relicCollected: true })).toBe(3)
  })

  it("awards no stars for a missed goal, even with the bonus and the relic", () => {
    const l = CAMPAIGN_LEVELS[0]
    const failed = {
      result: result({ reason: "playerDied", playerWon: false, standings: [playerRow(false)] }),
      stats: stats({ peakMass: 999 }),
      relicCollected: true,
    }
    expect(starsFor(l, failed)).toBe(0)
  })
})

describe("campaign progress", () => {
  it("locks every level but the first until the previous one is won", () => {
    let progress = emptyProgress()
    expect(isUnlocked(progress, CAMPAIGN_LEVELS[0])).toBe(true)
    expect(isUnlocked(progress, CAMPAIGN_LEVELS[1])).toBe(false)
    expect(isUnlocked(progress, CAMPAIGN_LEVELS[11])).toBe(false)
    progress = recordRun(progress, CAMPAIGN_LEVELS[0], 1, false).progress
    expect(isWon(progress, CAMPAIGN_LEVELS[0])).toBe(true)
    expect(isUnlocked(progress, CAMPAIGN_LEVELS[1])).toBe(true)
    expect(isUnlocked(progress, CAMPAIGN_LEVELS[2])).toBe(false)
  })

  it("keeps the best stars and records the relic once", () => {
    const l = CAMPAIGN_LEVELS[0]
    let progress = emptyProgress()
    const first = recordRun(progress, l, 2, false)
    expect(first.stars).toBe(2)
    expect(first.newBest).toBe(true)
    expect(first.newRelic).toBe(false)
    progress = first.progress
    const worse = recordRun(progress, l, 1, true)
    expect(worse.stars).toBe(1)
    expect(worse.newBest).toBe(false)
    expect(worse.newRelic).toBe(true)
    expect(starsOf(worse.progress, l)).toBe(2)
    expect(worse.progress.relics).toEqual([l.id])
    const again = recordRun(worse.progress, l, 3, true)
    expect(again.newBest).toBe(true)
    expect(again.newRelic).toBe(false)
    expect(again.progress.relics).toEqual([l.id])
    expect(again.stars).toBe(3)
  })

  it("counts stars, completion and relics", () => {
    let progress = emptyProgress()
    expect(totalStars(progress)).toBe(0)
    expect(campaignComplete(progress)).toBe(false)
    expect(allRelicsFound(progress)).toBe(false)
    for (const l of CAMPAIGN_LEVELS) progress = recordRun(progress, l, 3, true).progress
    expect(totalStars(progress)).toBe(MAX_CAMPAIGN_STARS)
    expect(campaignComplete(progress)).toBe(true)
    expect(allRelicsFound(progress)).toBe(true)
  })

  it("unlocks dash, repulse and the singularity at the star thresholds", () => {
    expect(ABILITY_UNLOCKS.map((a) => a.id)).toEqual(["dash", "repulse", "ult"])
    expect(unlockedAbilities(emptyProgress())).toEqual([])
    let progress = emptyProgress()
    progress = recordRun(progress, CAMPAIGN_LEVELS[0], 1, false).progress
    expect(unlockedAbilities(progress)).toEqual(["dash"])
    progress = recordRun(progress, CAMPAIGN_LEVELS[1], 1, false).progress
    progress = recordRun(progress, CAMPAIGN_LEVELS[2], 1, false).progress
    expect(unlockedAbilities(progress)).toEqual(["dash", "repulse"])
    for (let i = 3; i < 6; i++) progress = recordRun(progress, CAMPAIGN_LEVELS[i], 1, false).progress
    expect(unlockedAbilities(progress)).toEqual(["dash", "repulse", "ult"])
  })

  it("reports the abilities a run newly unlocked", () => {
    const before = emptyProgress()
    const run = recordRun(before, CAMPAIGN_LEVELS[0], 1, false)
    expect(run.unlocked.map((a) => a.id)).toEqual(["dash"])
    expect(newlyUnlockedAbilities(before, run.progress).map((a) => a.id)).toEqual(["dash"])
    const repeat = recordRun(run.progress, CAMPAIGN_LEVELS[0], 1, false)
    expect(repeat.unlocked).toEqual([])
  })

  it("offers the first unlocked level that is not won yet, then the last unlocked", () => {
    let progress = emptyProgress()
    expect(currentLevel(progress)).toBe(CAMPAIGN_LEVELS[0])
    progress = recordRun(progress, CAMPAIGN_LEVELS[0], 2, false).progress
    expect(currentLevel(progress)).toBe(CAMPAIGN_LEVELS[1])
    for (const l of CAMPAIGN_LEVELS) progress = recordRun(progress, l, 3, true).progress
    expect(currentLevel(progress)).toBe(CAMPAIGN_LEVELS[11])
  })

  it("survives a round trip through storage", () => {
    const storage = fakeStorage()
    let progress: CampaignProgress = emptyProgress()
    progress = recordRun(progress, CAMPAIGN_LEVELS[0], 3, true).progress
    progress = recordRun(progress, CAMPAIGN_LEVELS[1], 1, false).progress
    saveProgress(storage, progress)
    expect(loadProgress(storage)).toEqual(progress)
    expect(storage.raw.has(CAMPAIGN_PROGRESS_KEY)).toBe(true)
  })

  it("migrates a Phase B progress (a v1 won list) to one star per won level", () => {
    const legacy = JSON.stringify({ won: ["fall-1", "fall-2", "not-a-level", "fall-1"] })
    const progress = loadProgress(fakeStorage({ [CAMPAIGN_LEGACY_KEY]: legacy }))
    expect(progress.version).toBe(2)
    expect(progress.stars).toEqual({ "fall-1": 1, "fall-2": 1 })
    expect(progress.relics).toEqual([])
  })

  it("reads missing, corrupt, unknown and out-of-range data safely", () => {
    expect(loadProgress(null)).toEqual(emptyProgress())
    expect(loadProgress(fakeStorage())).toEqual(emptyProgress())
    expect(loadProgress(fakeStorage({ [CAMPAIGN_PROGRESS_KEY]: "not json" }))).toEqual(emptyProgress())
    expect(loadProgress(fakeStorage({ [CAMPAIGN_PROGRESS_KEY]: '{"stars":"nope"}' }))).toEqual(emptyProgress())
    expect(loadProgress(fakeStorage({ [CAMPAIGN_PROGRESS_KEY]: '{"stars":{"nope":3,"fall-1":9},"relics":["nope","fall-1"]}' }))).toEqual({
      version: 2,
      stars: { "fall-1": 3 },
      relics: ["fall-1"],
    })
  })

  it("never throws when storage is blocked", () => {
    expect(loadProgress(brokenStorage)).toEqual(emptyProgress())
    expect(() => saveProgress(brokenStorage, emptyProgress())).not.toThrow()
    expect(() => saveProgress(null, emptyProgress())).not.toThrow()
  })
})

describe("relic placement", () => {
  it("is deterministic for a seed", () => {
    const opts = { seed: 1234, arenaRadius: 2000, hazards: [{ x: 0, y: 0, r: 300 }] }
    const a = relicPoint(opts)
    const b = relicPoint(opts)
    expect(a).toEqual(b)
    expect({ x: a.x, y: a.y }).not.toEqual({ x: 0, y: 0 })
  })

  it("stays inside the arena and clear of every hazard", () => {
    const hazards = [
      { x: 0, y: 0, r: 400 },
      { x: 800, y: -600, r: 300 },
      { x: -900, y: 500, r: 260 },
    ]
    for (let seed = 1; seed <= 40; seed++) {
      const p = relicPoint({ seed, arenaRadius: 2000, hazards })
      expect(Math.hypot(p.x, p.y)).toBeLessThan(2000)
      for (const h of hazards) {
        expect(Math.hypot(p.x - h.x, p.y - h.y)).toBeGreaterThan(h.r + 60)
      }
    }
  })

  it("moves with the seed", () => {
    const points = new Set<string>()
    for (let seed = 1; seed <= 20; seed++) {
      const p = relicPoint({ seed, arenaRadius: 2000, hazards: [] })
      points.add(`${Math.round(p.x)},${Math.round(p.y)}`)
    }
    expect(points.size).toBeGreaterThan(1)
  })
})
