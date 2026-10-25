// Phone HUD policy: what the in-round HUD keeps and how the touch leaderboard opens.
// Pure, so it runs without a DOM or a browser.

import { describe, expect, it } from "vitest"
import type { LeaderboardEntry } from "@/game/types"
import {
  BURN_TIP,
  centreHud,
  dashName,
  dismissesLeaderboard,
  formatClock,
  leaderboardRows,
  rankLine,
  rankPill,
  rankPillLabel,
  respawnTip,
  firstDeathTip,
  speedCapText,
  speedLine,
  speedValue,
  ultHintDue,
  ultHintNotice,
  ULT_HINT_MS,
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
    expect(dashName(base, true)).toBe("Dash, DASH ALONG PATH (prograde burn window open)")
    expect(dashName(base, false)).toBe(base)
  })

  it("leads with the words on screen and keeps the technical name as the trailing detail", () => {
    const spoken = dashName("Dash (Shift)", true)
    expect(spoken.indexOf("DASH ALONG PATH")).toBeLessThan(spoken.indexOf("prograde"))
    // The cue is the only channel allowed to say "prograde"; the visible tip never does.
    expect(BURN_TIP).not.toMatch(/prograde/i)
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

describe("live speed readout", () => {
  it("labels the number SPEED and shows it in whole u/s", () => {
    expect(speedLine(342.4, 0, 1)).toBe("SPEED 342 u/s")
    expect(speedLine(0, 0, 1)).toBe("SPEED 0 u/s")
  })

  it("shows the surge multiplier as a cap, only while a surge pays", () => {
    expect(speedLine(342.4, 2.1, 1.24)).toBe("SPEED 342 u/s · ×1.24 cap")
    // A surge with no speed multiplier is not a multiplier.
    expect(speedLine(120, 1.5, 1)).toBe("SPEED 120 u/s")
  })

  it("splits into the value and the ceiling the HUD can trim separately", () => {
    expect(speedValue(342.4)).toBe("342 u/s")
    expect(speedCapText(2.1, 1.24)).toBe(" · ×1.24 cap")
    expect(speedCapText(0, 1.24)).toBe("")
    expect(speedCapText(2.1, 1)).toBe("")
    // The whole line is still exactly the parts, so the accessible copy cannot drift.
    expect(`SPEED ${speedValue(342.4)}${speedCapText(2.1, 1.24)}`).toBe(speedLine(342.4, 2.1, 1.24))
  })

  it("adds the solar-current sail's own ceiling only while it is meaningful", () => {
    expect(speedCapText(0, 1, 0)).toBe("")
    expect(speedCapText(0, 1, 1)).toBe(" · current ×1.18")
    expect(speedCapText(0, 1, 0.5)).toBe(" · current ×1.09")
    // Too small to round to a real multiplier: no suffix rather than "×1.00".
    expect(speedCapText(0, 1, 0.02)).toBe("")
    // Both ceilings are named, in the order the player earned them.
    expect(speedCapText(2.1, 1.24, 1)).toBe(" · ×1.24 cap · current ×1.18")
    expect(speedCapText(0, 1, 2)).toBe(" · current ×1.18")
    expect(speedCapText(0, 1, -1)).toBe("")
    // The whole line is still exactly the parts, including the sail.
    expect(`SPEED ${speedValue(342.4)}${speedCapText(2.1, 1.24, 1)}`).toBe(speedLine(342.4, 2.1, 1.24, 1))
    expect(speedLine(342.4, 0, 1, 1)).toBe("SPEED 342 u/s · current ×1.18")
  })

  it("never implies the reading is well-relative or a measured ratio", () => {
    const line = speedLine(342.4, 2.1, 1.24)
    expect(line).not.toMatch(/prograde|relative|orbit|×1\.24x|faster/i)
    expect(line).not.toMatch(/\d+x/)
  })

  it("keeps the rounded value honest and never negative", () => {
    expect(speedLine(-8, 0, 1)).toBe("SPEED 0 u/s")
    expect(speedLine(129.6, 0, 1)).toBe("SPEED 130 u/s")
  })
})

describe("unready Singularity feedback", () => {
  it("answers a press only while the charge is short of full", () => {
    expect(ultHintDue(true, 0.42, 10_000, -1e9)).toBe(true)
    expect(ultHintDue(true, 1, 10_000, -1e9)).toBe(false)
    expect(ultHintDue(false, 0.4, 10_000, -1e9)).toBe(false)
  })

  it("rate-limits a mash to one answer per gap", () => {
    expect(ULT_HINT_MS).toBe(4000)
    expect(ultHintDue(true, 0.4, 10_000, 9_000)).toBe(false)
    expect(ultHintDue(true, 0.4, 14_000, 10_000)).toBe(true)
  })
})

describe("the unready Singularity answer", () => {
  it("states the charge it is short of and how to fill it", () => {
    expect(ultHintNotice(0.42)).toEqual({
      kicker: "Singularity",
      name: "42% charged",
      description: "Absorb mass to fill the charge. Ready at 100%.",
    })
    expect(ultHintNotice(0.995).name).toBe("100% charged")
  })
})

describe("the one respawn tip", () => {
  const cause = (by: "star" | "blackhole" | "body" | "pulsar" | "whitedwarf" | "neutronstar") => ({
    by,
    killerId: "bot-1",
  })

  it("names the plain-language burn in every variant and stays one line", () => {
    for (const by of ["star", "blackhole", "body", "pulsar", "whitedwarf", "neutronstar"] as const) {
      const tip = respawnTip(cause(by) as never)
      expect(tip).toContain(BURN_TIP)
      expect(tip.length).toBeLessThan(160)
      expect(tip).not.toContain("prograde")
    }
  })

  it("matches the advice to what killed the player", () => {
    expect(respawnTip(cause("star") as never)).toMatch(/surface is fatal/)
    expect(respawnTip(cause("blackhole") as never)).toMatch(/Nothing escapes/)
    expect(respawnTip(cause("body") as never)).toMatch(/ringed in red/)
    expect(respawnTip(cause("pulsar") as never)).toMatch(/beams/)
  })

  it("teaches on the first death of a round only", () => {
    expect(firstDeathTip(0, cause("star") as never)).toBe(respawnTip(cause("star") as never))
    expect(firstDeathTip(1, cause("star") as never)).toBe("")
    expect(firstDeathTip(7, cause("blackhole") as never)).toBe("")
  })
})
