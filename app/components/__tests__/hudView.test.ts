// Phone HUD policy: what the in-round HUD keeps and how the touch leaderboard opens.
// Pure, so it runs without a DOM or a browser.

import { describe, expect, it } from "vitest"
import type { LeaderboardEntry } from "@/game/types"
import {
  centreHud,
  dashName,
  dismissesLeaderboard,
  formatClock,
  leaderboardRows,
  rankLine,
  rankPill,
  rankPillLabel,
} from "../hudView"

const ROWS: LeaderboardEntry[] = [
  { id: "nova", name: "Nova", color: "#fff", mass: 120, isPlayer: false, rank: 1 },
  { id: "lyra", name: "Lyra", color: "#fff", mass: 90, isPlayer: false, rank: 2 },
  { id: "vega", name: "Vega", color: "#fff", mass: 60, isPlayer: false, rank: 3 },
  { id: "player", name: "You", color: "#5ef2ff", mass: 40, isPlayer: true, rank: 4 },
  { id: "orion", name: "Orion", color: "#fff", mass: 25, isPlayer: false, rank: 5 },
  { id: "draco", name: "Draco", color: "#fff", mass: 10, isPlayer: false, rank: 6 },
]

const CENTRE = { timeLeft: 150, rank: 4, alive: 11, arenaName: "The Vast", campaign: null }

describe("formatClock", () => {
  it("pads the seconds and rounds up, so a sliver of time never reads 0:00", () => {
    expect(formatClock(150)).toBe("2:30")
    expect(formatClock(7.2)).toBe("0:08")
    expect(formatClock(0)).toBe("0:00")
    expect(formatClock(-3)).toBe("0:00")
  })
})

describe("rank pill", () => {
  it("shows the rank as a fraction, or Out once eliminated", () => {
    expect(rankPill(4, 11)).toBe("#4 / 11")
    expect(rankPill(0, 11)).toBe("Out")
  })

  it("gives the pill an accessible name that spells the rank out", () => {
    expect(rankPillLabel(4, 11)).toBe("Leaderboard, rank 4 of 11")
    expect(rankPillLabel(0, 11)).toBe("Leaderboard, eliminated")
  })

  it("keeps the standings line for the round clock at every width", () => {
    expect(rankLine(4, 11)).toBe("Rank 4 / 11")
    expect(rankLine(0, 11)).toBe("Eliminated")
  })
})

describe("leaderboardRows", () => {
  it("is behind the pill on touch: top three plus the player while closed", () => {
    expect(leaderboardRows(ROWS, { touch: true, open: false }).map((r) => r.name)).toEqual(["Nova", "Lyra", "Vega", "You"])
  })

  it("does not repeat the player when they already sit in the top three", () => {
    const rows = leaderboardRows(ROWS, { touch: true, open: false }).map((r) => r.name)
    expect(rows.filter((n) => n === "You")).toHaveLength(1)
    const leading = leaderboardRows([{ ...ROWS[3], rank: 1 }], { touch: true, open: false })
    expect(leading).toHaveLength(1)
  })

  it("shows the whole board once opened, and always on the wide layout", () => {
    expect(leaderboardRows(ROWS, { touch: true, open: true })).toHaveLength(6)
    expect(leaderboardRows(ROWS, { touch: false, open: false })).toHaveLength(6)
  })
})

describe("dismissesLeaderboard", () => {
  it("closes an open board on Escape only", () => {
    expect(dismissesLeaderboard("Escape", true)).toBe(true)
    expect(dismissesLeaderboard("Escape", false)).toBe(false)
    expect(dismissesLeaderboard("Enter", true)).toBe(false)
  })
})

describe("dashName", () => {
  it("leaves the control's name alone when no burn is payable", () => {
    expect(dashName("Dash (Shift)", false)).toBe("Dash (Shift)")
  })

  it("adds the burn cue while the window is open and takes it back exactly when it closes", () => {
    const base = "Dash"
    expect(dashName(base, true)).toBe("Dash, prograde burn window open")
    expect(dashName(base, false)).toBe(base)
  })
})

describe("centreHud", () => {
  it("keeps the mode label, arena and standings on desktop Endless", () => {
    expect(centreHud("endless", "desktop", CENTRE)).toEqual({
      tag: "ENDLESS",
      arena: "The Vast",
      timer: null,
      rank: "Rank 4 / 11",
      goal: null,
    })
  })

  it("leaves a phone Endless to the rank pill: no duplicate label, arena or standings", () => {
    expect(centreHud("endless", "touch", CENTRE)).toEqual({
      tag: null,
      arena: null,
      timer: null,
      rank: null,
      goal: null,
    })
  })

  it("keeps the clock and standings in a Round", () => {
    const c = centreHud("round", "touch", CENTRE)
    expect(c.timer).toBe("2:30")
    expect(c.rank).toBe("Rank 4 / 11")
    expect(c.tag).toBeNull()
    expect(c.goal).toBeNull()
  })

  it("shortens the campaign tag on a phone but keeps the objective", () => {
    const campaign = { index: 2, total: 12, name: "First Orbit", goalLine: "Reach 45 mass" }
    const phone = centreHud("campaign", "touch", { ...CENTRE, campaign })
    expect(phone.tag).toBe("LEVEL 2 / 12")
    expect(phone.goal).toBe("Reach 45 mass")
    expect(phone.timer).toBe("2:30")
    expect(phone.rank).toBeNull()

    const desktop = centreHud("campaign", "desktop", { ...CENTRE, campaign })
    expect(desktop.tag).toBe("LEVEL 2 / 12 · FIRST ORBIT")
    expect(desktop.goal).toBe("Reach 45 mass")
  })
})
