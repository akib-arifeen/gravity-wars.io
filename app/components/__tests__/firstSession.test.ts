// The first-session increment: forgiving first-run defaults, copy that matches the engine
// (2:30 and the tuned goal), the plain-language burn prompt, the live speed readout and the single
// respawn tip. Everything here is pure or server-rendered, so no DOM is needed.

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CONFIG } from "@/game/config"
import { createWorld, hudSnapshot } from "@/game/engine"
import type { FeedView } from "@/game/feed"
import type { DeathCause } from "@/game/types"
import { burnPromptLabel } from "@/game/render"
import { startDefaults } from "@/app/startDefaults"
import { Hud } from "../Hud"
import { BURN_TIP, respawnTip } from "../hudView"
import { MODES, PauseScreen, ROUND_LENGTH, roundGoal } from "../Screens"

const noop = () => {}

function roundCopy(difficulty: "easy" | "normal" | "hard"): string {
  return MODES.find((m) => m.id === "round")!.copy(difficulty)
}

describe("first-run defaults", () => {
  it("starts a first run on Easy in the Classic arena", () => {
    expect(startDefaults({})).toEqual({ difficulty: "easy", arena: "classic" })
    expect(startDefaults({ difficulty: null, arena: null })).toEqual({ difficulty: "easy", arena: "classic" })
  })

  it("never overrides a returning player's own choices", () => {
    for (const difficulty of ["easy", "normal", "hard"] as const) {
      expect(startDefaults({ difficulty, arena: "binary" })).toEqual({ difficulty, arena: "binary" })
    }
    // "random" is a real choice, not a missing one.
    expect(startDefaults({ arena: "random" }).arena).toBe("random")
    expect(startDefaults({ arena: "vast" }).arena).toBe("vast")
  })

  it("falls back to the forgiving pair when a stored value is unreadable", () => {
    expect(startDefaults({ difficulty: "nightmare", arena: "lava" })).toEqual({ difficulty: "easy", arena: "classic" })
  })
})

describe("match copy matches the engine", () => {
  it("states the real 2:30 length and the goal for the chosen skill", () => {
    expect(ROUND_LENGTH).toBe("2:30")
    expect(CONFIG.round.duration).toBe(150)
    expect(roundCopy("easy")).toContain("2:30")
    expect(roundCopy("easy")).toContain(`${roundGoal("easy")} mass`)
    expect(roundCopy("normal")).toContain(`${roundGoal("normal")} mass`)
    expect(roundCopy("hard")).toContain(`${roundGoal("hard")} mass`)
  })

  it("never claims a three-minute match anywhere in the menu copy", () => {
    for (const m of MODES) {
      for (const d of ["easy", "normal", "hard"] as const) {
        expect(m.copy(d).toLowerCase()).not.toContain("3 minute")
        expect(m.copy(d).toLowerCase()).not.toContain("three minute")
      }
    }
  })

  it("tunes only Easy: Normal and Hard keep the old goal", () => {
    expect(roundGoal("easy")).toBe(90)
    expect(roundGoal("normal")).toBe(CONFIG.round.criticalMass)
    expect(roundGoal("hard")).toBe(CONFIG.round.criticalMass)
    expect(roundGoal("easy")).toBeLessThan(roundGoal("normal"))
  })

  it("teaches the burn in plain language, not 'prograde'", () => {
    expect(BURN_TIP).toBe("Fly close past a star, then DASH ALONG PATH for a speed boost.")
    expect(BURN_TIP).not.toMatch(/prograde/i)
    expect(burnPromptLabel(true)).toBe("DASH ALONG PATH")
    expect(burnPromptLabel(false)).toBe("DASH ALONG PATH  SHIFT")
    expect(burnPromptLabel(false).toLowerCase()).not.toContain("prograde")
  })
})

describe("pause help", () => {
  it("re-reads the controls and the burn instruction without a pointer query in the markup", () => {
    const markup = renderToStaticMarkup(
      createElement(PauseScreen, { onResume: noop, onRestart: noop, onQuit: noop }),
    )
    expect(markup).toContain(BURN_TIP)
    expect(markup).toContain("WASD or hold the mouse to thrust")
    expect(markup).toContain("Drag on the left to steer")
    expect(markup).toContain("Resume")
    expect(markup).toContain("Restart")
    expect(markup).toContain("Quit to menu")
    // Both lines ship and CSS picks one, so the server never guesses the pointer.
    expect(markup).not.toContain("(pointer: coarse)")
  })
})

function endlessHud(overrides: Partial<FeedView> = {}): FeedView {
  const world = createWorld({ seed: 3, difficulty: "easy", mode: "endless", cosmic: false })
  return { ...(hudSnapshot(world) as FeedView), ...overrides }
}

function hudMarkup(hud: FeedView, deathTip = ""): string {
  return renderToStaticMarkup(
    createElement(Hud, {
      hud,
      muted: false,
      onPause: noop,
      onToggleMute: noop,
      layout: "desktop" as const,
      onPress: noop,
      deathText: "Burned up in a star",
      deathTip,
    }),
  )
}

describe("HUD labels and readouts", () => {
  it("calls Endless mass MASS, not SCORE", () => {
    const markup = hudMarkup(endlessHud())
    expect(markup).toContain(">MASS<")
    expect(markup).not.toContain(">SCORE<")
  })

  it("shows the live speed and names a surge multiplier while one is paying", () => {
    const snap: FeedView = { ...endlessHud(), phase: "playing" }
    const still = hudMarkup({ ...snap, speed: 342.4, assist: { ...snap.assist, surge: 0, surgeMul: 1 } })
    expect(still).toContain("342 u/s")
    expect(still).not.toContain("×1.24")

    const surging = hudMarkup({ ...snap, speed: 342.4, assist: { ...snap.assist, surge: 2.1, surgeMul: 1.24 } })
    expect(surging).toContain("342 u/s · ×1.24")
  })

  it("hides the readout during the countdown, when nothing is moving yet", () => {
    const snap = endlessHud()
    expect(snap.phase).toBe("countdown")
    expect(hudMarkup({ ...snap, speed: 0 })).not.toContain("gw-hud-speed")
  })

  it("keeps the speed out of the polite live region", () => {
    const markup = hudMarkup({ ...endlessHud(), speed: 342 })
    const status = /<p class="gw-sr-only" role="status" aria-live="polite">([^<]*)<\/p>/.exec(markup)
    expect(status?.[1] ?? "").not.toContain("u/s")
  })

  it("adds one respawn tip when the round supplies it, and none otherwise", () => {
    const snap = endlessHud()
    const respawning: FeedView = { ...snap, endless: { ...snap.endless!, respawnIn: 3 } }
    expect(hudMarkup(respawning)).not.toContain("gw-death-tip")
    expect(hudMarkup(respawning, respawnTip({ by: "star", killerId: "star-1" } as DeathCause))).toContain("gw-death-tip")
  })
})
