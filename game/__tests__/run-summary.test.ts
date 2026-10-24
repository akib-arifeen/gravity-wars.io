// What a finished run reports: the record it belongs to and the arena it names.

import { describe, expect, it } from "vitest"
import { recordsRoundBest, runArena } from "../run-summary"

describe("which runs count toward the Round bests", () => {
  it("counts Round and Endless rounds", () => {
    expect(recordsRoundBest("round")).toBe(true)
    expect(recordsRoundBest("endless")).toBe(true)
  })

  it("leaves campaign levels and the daily challenge to their own records", () => {
    expect(recordsRoundBest("campaign")).toBe(false)
    expect(recordsRoundBest("daily")).toBe(false)
  })
})

describe("the arena a finished run names", () => {
  const arenas = { round: "maw" as const, level: "binary" as const, daily: "nebula" as const }

  it("names the arena the round actually started with", () => {
    expect(runArena("round", arenas)).toBe("maw")
    expect(runArena("endless", arenas)).toBe("maw")
  })

  it("keeps the campaign level's arena and the day's arena", () => {
    expect(runArena("campaign", arenas)).toBe("binary")
    expect(runArena("daily", arenas)).toBe("nebula")
  })

  it("falls back to the round's arena when the other source is missing", () => {
    expect(runArena("campaign", { ...arenas, level: null })).toBe("maw")
    expect(runArena("daily", { ...arenas, daily: null })).toBe("maw")
  })
})
