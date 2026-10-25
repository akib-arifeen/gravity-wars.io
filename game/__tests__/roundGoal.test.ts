// Is the Round goal attainable at newcomer pace? The reference is the game's own low-skill
// profile: the Easy bot brain flying the player's body in an Easy world. The measurement runs the
// engine with no critical-mass race (criticalMass = 1e9) so the goal cannot truncate the number it
// is being compared against, and it is seeded, so the baseline is reproducible.
//
// Simulated skill, not human difficulty: this shows the goal is reachable and not free. It says
// nothing about how a person feels playing.

import { describe, expect, it } from "vitest"
import { botIntent, createBotBrain } from "../bots"
import { CONFIG } from "../config"
import { createWorld, step } from "../engine"
import type { Difficulty, Intent } from "../types"
import { DT } from "./helpers"

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

/** Peak mass the Easy profile reaches in one seeded 150 s round, with no goal to end it early. */
function lowSkillPeak(seed: number, difficulty: Difficulty = "easy"): number {
  const world = createWorld({ seed, difficulty, arena: "classic", criticalMass: 1e9 })
  const brain = createBotBrain("player", "easy", seed + 101)
  const cap = Math.ceil((CONFIG.round.countdown + CONFIG.round.duration) / DT) + 10
  let peak = world.bodies[0].mass
  for (let steps = 0; world.phase !== "over" && steps < cap; steps++) {
    const intents: Record<string, Intent> = {}
    if (world.bodies[0].alive) intents.player = botIntent(world, brain)
    step(world, intents)
    if (world.bodies[0].alive) peak = Math.max(peak, world.bodies[0].mass)
  }
  return Math.round(peak)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

describe("the Round goal at newcomer pace", () => {
  const peaks = SEEDS.map((s) => lowSkillPeak(s))
  const goal = CONFIG.round.criticalMassByDifficulty.easy

  it("is reachable by the low-skill reference, so the round can be won", () => {
    expect(peaks.filter((p) => p >= goal).length).toBeGreaterThan(0)
  })

  it("is not free: the median run falls short and some seeds never get there", () => {
    expect(median(peaks)).toBeLessThan(goal)
    expect(peaks.filter((p) => p >= goal).length).toBeLessThan(peaks.length)
  })

  it("is meaningfully more attainable than the old 130", () => {
    const before = peaks.filter((p) => p >= CONFIG.round.criticalMass).length
    const after = peaks.filter((p) => p >= goal).length
    expect(before).toBe(0)
    expect(after).toBeGreaterThan(before)
    expect(after / SEEDS.length).toBeLessThanOrEqual(0.75)
  })

  it("does not touch Normal or Hard", () => {
    expect(CONFIG.round.criticalMassByDifficulty.normal).toBe(CONFIG.round.criticalMass)
    expect(CONFIG.round.criticalMassByDifficulty.hard).toBe(CONFIG.round.criticalMass)
  })

  it("is the value the engine actually plays to", () => {
    const world = createWorld({ seed: 4, difficulty: "easy", criticalMass: CONFIG.round.criticalMassByDifficulty.easy })
    expect(world.roundCriticalMass).toBe(goal)
    // Campaign levels set their own, larger number; the default stays CONFIG.round.criticalMass.
    expect(createWorld({ seed: 4, difficulty: "easy" }).roundCriticalMass).toBe(CONFIG.round.criticalMass)
  })

  it("is deterministic: the same seed measures the same peak twice", () => {
    expect(lowSkillPeak(7)).toBe(lowSkillPeak(7))
  })
})
