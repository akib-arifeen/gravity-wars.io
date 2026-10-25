// Is the Round goal attainable at newcomer pace? The reference is the game's own low-skill
// profile: the Easy bot brain flying the player's body in an Easy world.
//
// The harness drives the round exactly as GameView does — a bot brain per rival on that body's own
// seed, the player on its own, every living body given an intent every step — because an earlier
// version of this file left the rivals idle, which made the player the only body that grew and
// produced numbers that were simply wrong. The baseline runs with no critical-mass race
// (criticalMass = 1e9) so the goal cannot truncate the number it is compared against. Every run is
// seeded, so the measurements are reproducible.
//
// Simulated skill, not human difficulty: this shows the goal is reachable and not free. It says
// nothing about how a person feels playing.

import { describe, expect, it } from "vitest"
import { roundCriticalMass } from "@/app/roundSetup"
import { botIntent, createBotBrain, type BotBrain } from "../bots"
import { CAMPAIGN_LEVELS } from "../campaign"
import { CONFIG } from "../config"
import { createWorld, step } from "../engine"
import type { Difficulty, GameMode, Intent, World } from "../types"
import { DT } from "./helpers"

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
/** GameView gives each rival a brain seeded on its body index; the player's own brain is seed + 1. */
const BOT_SEED_STRIDE = 7919
const PLAYER_SEED_OFFSET = 1
const NO_RACE = 1e9
/** 12 seeded 150 s rounds take a few seconds each; the default 5 s test timeout is too short. */
const SLOW = 30000

/** One full round, driven like GameView: every living body gets an intent every step. */
function playRound(seed: number, criticalMass: number): World {
  const world = createWorld({ seed, difficulty: "easy", arena: "classic", criticalMass, botCount: 3, mode: "round" })
  const brains = new Map<string, BotBrain>()
  world.bodies.forEach((b, i) => {
    if (b.kind === "bot") brains.set(b.id, createBotBrain(b.id, b.skill ?? "easy", seed + i * BOT_SEED_STRIDE))
  })
  const playerBrain = createBotBrain("player", "easy", seed + PLAYER_SEED_OFFSET)
  const cap = Math.ceil((CONFIG.round.countdown + world.timeLeft) / DT) + 10
  for (let n = 0; world.phase !== "over" && n < cap; n++) {
    const intents: Record<string, Intent> = {}
    if (world.bodies[0].alive) intents.player = botIntent(world, playerBrain)
    for (const b of world.bodies) {
      if (b.kind !== "bot" || !b.alive) continue
      intents[b.id] = botIntent(world, brains.get(b.id)!)
    }
    step(world, intents)
  }
  return world
}

interface Run {
  peak: number
  reason: string
  won: boolean
  seconds: number
}

function play(seed: number, criticalMass: number): Run {
  const w = playRound(seed, criticalMass)
  return {
    peak: Math.round(w.bodies[0].stats.peakMass),
    reason: w.result?.reason ?? "none",
    won: w.result?.playerWon === true,
    seconds: w.result?.durationS ?? 0,
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

describe("the Round goal at newcomer pace", () => {
  it(
    "the no-race baseline ends on the clock (not on mass or a wipeout) and peaks near the goal",
    () => {
      const runs = SEEDS.map((s) => play(s, NO_RACE))
      const peaks = runs.map((r) => r.peak)
      const byReason = (reason: string) => runs.filter((r) => r.reason === reason).length

      // The old harness's rivals were idle, so the player out-grew the field and every round ended
      // one way. With rivals flying, a round mostly runs the full clock.
      expect(byReason("lastStanding")).toBe(0)
      expect(byReason("criticalMass")).toBe(0)
      expect(byReason("timeUp")).toBeGreaterThanOrEqual(8)
      expect(byReason("timeUp") + byReason("playerDied")).toBe(SEEDS.length)

      // Measured: 92-194, median 131 — the goal sits at the reference's median, so half its runs
      // reach it and half do not.
      expect(median(peaks)).toBeGreaterThanOrEqual(125)
      expect(median(peaks)).toBeLessThanOrEqual(140)
      expect(peaks.filter((p) => p >= CONFIG.round.criticalMass).length).toBeGreaterThanOrEqual(4)
      expect(peaks.filter((p) => p >= CONFIG.round.criticalMass).length).toBeLessThan(SEEDS.length)
    },
    SLOW,
  )

  it(
    "a 90 goal makes every round a short mass sprint without winning more often",
    () => {
      const runs = SEEDS.map((s) => play(s, 90))
      expect(runs.filter((r) => r.reason === "criticalMass").length).toBe(SEEDS.length)
      expect(median(runs.map((r) => r.seconds))).toBeLessThanOrEqual(100)
    },
    SLOW,
  )

  it(
    "the shipped goal is winnable and keeps some rounds going the distance",
    () => {
      const runs = SEEDS.map((s) => play(s, CONFIG.round.criticalMass))
      const seconds = median(runs.map((r) => r.seconds))
      const short = SEEDS.map((s) => play(s, 90))
      expect(runs.filter((r) => r.won).length).toBeGreaterThanOrEqual(2)
      // At 130 some rounds still reach the clock or end with the reference's death; at 90 none do.
      expect(runs.filter((r) => r.reason !== "criticalMass").length).toBeGreaterThan(0)
      expect(seconds).toBeGreaterThan(median(short.map((r) => r.seconds)))
    },
    SLOW,
  )

  it("is deterministic: the same seed measures the same round twice", () => {
    expect(play(7, CONFIG.round.criticalMass)).toEqual(play(7, CONFIG.round.criticalMass))
  })
})

describe("which rounds play to the critical-mass goal", () => {
  const world = (opts: { difficulty?: Difficulty; mode?: GameMode; criticalMass?: number }) =>
    createWorld({ seed: 4, difficulty: opts.difficulty ?? "easy", mode: opts.mode ?? "round", criticalMass: opts.criticalMass })

  it("gives Round the one documented goal on every starting skill", () => {
    for (const difficulty of ["easy", "normal", "hard"] as const) {
      const w = createWorld({ seed: 4, difficulty, mode: "round" })
      expect(w.roundCriticalMass, difficulty).toBe(CONFIG.round.criticalMass)
      expect(w.roundCriticalMass, difficulty).toBe(130)
    }
  })

  it("leaves Endless on the same number, unused, because Endless has no race", () => {
    expect(world({ mode: "endless" }).roundCriticalMass).toBe(CONFIG.round.criticalMass)
  })

  it("keeps the race on the campaign's critical-mass level and turns it off elsewhere", () => {
    const crit = CAMPAIGN_LEVELS.find((l) => l.goal.kind === "criticalMass")!
    const other = CAMPAIGN_LEVELS.find((l) => l.goal.kind !== "criticalMass")!
    expect(crit).toBeDefined()
    expect(other).toBeDefined()

    expect(world({ criticalMass: roundCriticalMass(crit) }).roundCriticalMass).toBe(CONFIG.round.criticalMass)
    // Out of reach: the level's own goal and clock decide when it ends.
    const off = world({ criticalMass: roundCriticalMass(other) })
    expect(off.roundCriticalMass).toBeGreaterThan(1e6)
    // GameView passes the same helper for a plain Round, which keeps the race.
    expect(roundCriticalMass(null)).toBe(CONFIG.round.criticalMass)
  })
})
