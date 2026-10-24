// Share cards: the text builder for every mode, plus the browser-free guarantees (URL, no
// undefined/NaN text, no empty cards).

import { describe, expect, it } from "vitest"
import { CAMPAIGN_LEVELS, levelById } from "../campaign"
import { GAME_URL, shareCard } from "../share"
import type { BodyStats, RoundResult } from "../types"

function stats(over: Partial<BodyStats> = {}): BodyStats {
  return {
    debrisEaten: 0,
    crystals: 0,
    rivalsAbsorbed: 0,
    peakMass: 82.4,
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

function result(over: Partial<RoundResult> = {}): RoundResult {
  return {
    reason: "timeUp",
    winnerId: "player",
    playerWon: true,
    standings: [],
    durationS: 150,
    ...over,
  }
}

function expectClean(text: string): void {
  expect(text).toContain(GAME_URL)
  expect(text).not.toContain("undefined")
  expect(text).not.toContain("NaN")
  expect(text.length).toBeGreaterThan(40)
}

describe("share cards", () => {
  it("builds a round card for a win and a loss", () => {
    const win = shareCard({ kind: "round", result: result({ reason: "criticalMass" }), stats: stats(), arenaName: "Nebula Field", difficulty: "hard" })
    expectClean(win.text)
    expect(win.text).toContain("Nebula Field")
    expect(win.text).toContain("Hard")
    expect(win.text).toContain("won")
    expect(win.title.length).toBeGreaterThan(0)

    const loss = shareCard({ kind: "round", result: result({ playerWon: false, reason: "playerDied" }), stats: stats(), arenaName: "The Maw", difficulty: "normal" })
    expectClean(loss.text)
    expect(loss.text).toContain("fell")
  })

  it("names a campaign level, its stars, bonus and relic", () => {
    const level = levelById("fall-4")!
    const card = shareCard({
      kind: "campaign",
      level,
      goalMet: true,
      stars: 3,
      bonusMet: true,
      relicFound: true,
      peakMass: 64,
    })
    expectClean(card.text)
    expect(card.text).toContain("The Long Fall")
    expect(card.text).toContain(level.name)
    expect(card.text).toContain("3/3 stars")
    expect(card.text).toContain("bonus")
    expect(card.text).toContain("relic found")
    expect(card.text).toContain("goal met")
  })

  it("builds a partial campaign card without dangling separators", () => {
    const card = shareCard({
      kind: "campaign",
      level: CAMPAIGN_LEVELS[0],
      goalMet: false,
      stars: 0,
      bonusMet: false,
      relicFound: false,
      peakMass: 12,
    })
    expectClean(card.text)
    expect(card.text).toContain("goal missed")
    expect(card.text).not.toContain(", .")
  })

  it("builds a daily card with the streak and best", () => {
    const card = shareCard({ kind: "daily", key: "2026-10-24", score: 84, best: 84, streak: 3, arenaName: "Binary" })
    expectClean(card.text)
    expect(card.text).toContain("2026-10-24")
    expect(card.text).toContain("Binary")
    expect(card.text).toContain("personal best")
    expect(card.text).toContain("3-day streak")
  })

  it("builds an endless card", () => {
    const card = shareCard({ kind: "endless", best: 143, kills: 12, deaths: 4 })
    expectClean(card.text)
    expect(card.text).toContain("143")
    expect(card.text).toContain("never sleeps")
  })

  it("uses the live game URL", () => {
    expect(GAME_URL.startsWith("https://")).toBe(true)
  })
})
