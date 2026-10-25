// The first-session increment: history-aware defaults, copy that matches the engine's clocks and
// goal, the plain-language burn prompt, the live speed readout and the single respawn tip.
// Everything here is pure or server-rendered, so no DOM is needed.

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CAMPAIGN_LEVELS, emptyProgress } from "@/game/campaign"
import { CONFIG } from "@/game/config"
import { dailyChallenge, type DailyConfig } from "@/game/daily"
import { createWorld, hudSnapshot } from "@/game/engine"
import type { FeedView } from "@/game/feed"
import type { DeathCause } from "@/game/types"
import { burnPromptLabel } from "@/game/render"
import {
  ARENA_KEY,
  DIFFICULTY_KEY,
  hasPlayHistory,
  HISTORY_KEYS,
  startDefaults,
} from "@/app/startDefaults"
import { Hud } from "../Hud"
import { BURN_TIP, respawnTip } from "../hudView"
import { ARENA_CHOICES, MenuScreen, matchLengthText, MODES, PauseScreen, roundLengthText, type MenuMode } from "../Screens"

const noop = () => {}

const roundCtx = (arena: "classic" | "vast" | "random") => ({ difficulty: "easy" as const, arena, dailyArena: null })
const copy = (id: MenuMode, arena: "classic" | "vast" | "random" = "classic") => MODES.find((m) => m.id === id)!.copy(roundCtx(arena))

describe("first-run defaults", () => {
  it("starts a genuinely new player on Easy in the Classic arena", () => {
    expect(startDefaults({})).toEqual({ difficulty: "easy", arena: "classic" })
    expect(startDefaults({ difficulty: null, arena: null, hasHistory: false })).toEqual({
      difficulty: "easy",
      arena: "classic",
    })
  })

  it("does not treat a missing gw:difficulty as a newcomer: history alone means returning", () => {
    // A player who has played has a best score and a profile, whether or not an older build ever
    // stored a skill. They keep a real skill and an arena that is not pinned to the first-run one.
    expect(startDefaults({ hasHistory: true })).toEqual({ difficulty: "normal", arena: "random" })
    expect(startDefaults({ difficulty: null, hasHistory: true }).difficulty).toBe("normal")
  })

  it("never overrides a stored choice, history or no history", () => {
    for (const hasHistory of [false, true]) {
      for (const difficulty of ["easy", "normal", "hard"] as const) {
        expect(startDefaults({ difficulty, arena: "binary", hasHistory })).toEqual({ difficulty, arena: "binary" })
      }
      // "random" is a real choice, not a missing one.
      expect(startDefaults({ arena: "random", hasHistory }).arena).toBe("random")
      expect(startDefaults({ arena: "vast", hasHistory }).arena).toBe("vast")
    }
  })

  it("does not count a menu tab click as play history", () => {
    // A first-time visitor who taps Round and leaves has stored a mode and nothing else.
    const store = new Map([["gw:mode", "round"]])
    const read = (k: string) => store.get(k) ?? null
    expect(hasPlayHistory(read)).toBe(false)
    expect(startDefaults({ hasHistory: hasPlayHistory(read) })).toEqual({ difficulty: "easy", arena: "classic" })
    expect(HISTORY_KEYS).not.toContain("gw:mode")

    // Real play does: one saved best is enough, and the stored mode still comes back separately.
    store.set("gw:best:v1", JSON.stringify({ easy: { wins: 1, bestMass: 90 } }))
    expect(hasPlayHistory(read)).toBe(true)
    expect(startDefaults({ hasHistory: hasPlayHistory(read) })).toEqual({ difficulty: "normal", arena: "random" })
    expect(store.get("gw:mode")).toBe("round")
  })

  it("reads history from the record keys a played browser writes, and from no choice key", () => {
    for (const key of ["gw:best:v1", "gw:profile:v1", "gw:daily:v1", "gw:campaign:v2"]) {
      expect(hasPlayHistory((k) => (k === key ? "1" : null)), key).toBe(true)
    }
    // A stored skill or arena is a menu choice, not proof of play; the mode tab least of all.
    for (const key of [DIFFICULTY_KEY, ARENA_KEY, "gw:mode"]) {
      expect(hasPlayHistory((k) => (k === key ? "1" : null)), key).toBe(false)
    }
    expect(hasPlayHistory(() => null)).toBe(false)
  })

  it("treats an unreadable stored value as absent, not as a choice", () => {
    expect(startDefaults({ difficulty: "nightmare", arena: "lava" })).toEqual({ difficulty: "easy", arena: "classic" })
    expect(startDefaults({ difficulty: "nightmare", arena: "lava", hasHistory: true })).toEqual({
      difficulty: "normal",
      arena: "random",
    })
  })
})

describe("match copy matches the engine", () => {
  it("states each arena's real clock from the config", () => {
    expect(CONFIG.round.duration).toBe(150)
    expect(roundLengthText("classic")).toBe("2:30")
    expect(roundLengthText("vast")).toBe("3:30")
    // The Vast runs 1.4x as long; the copy follows the config, not a hard-coded number.
    expect(CONFIG.round.duration * CONFIG.vast.roundMul).toBe(CONFIG.vast.roundMul * 150)
    expect(roundLengthText("vast")).toBe(
      `${Math.floor((CONFIG.round.duration * CONFIG.vast.roundMul) / 60)}:${String(Math.round((CONFIG.round.duration * CONFIG.vast.roundMul) % 60)).padStart(2, "0")}`,
    )
  })

  it("names both possible clocks for Random instead of guessing the arena", () => {
    // The bare clock list, for copy that supplies its own noun.
    expect(roundLengthText("random")).toBe("2:30, or 3:30 in The Vast")
    // The Round sentence needs a subject of its own, or it reads "… in The Vast match."
    expect(matchLengthText("random")).toBe("A 2:30 match, or 3:30 in The Vast")
    expect(matchLengthText("classic")).toBe("2:30 match")
    expect(matchLengthText("vast")).toBe("3:30 match")
    expect(ARENA_CHOICES).toContain("random")
  })

  it("writes the whole Random Round sentence grammatically", () => {
    expect(copy("round", "random")).toBe(
      "A 2:30 match, or 3:30 in The Vast. Reach 130 mass or be the last one left.",
    )
    expect(copy("round", "classic")).toBe("2:30 match. Reach 130 mass or be the last one left.")
    expect(copy("round", "vast")).toBe("3:30 match. Reach 130 mass or be the last one left.")
    // Nothing dangles a noun after the arena name.
    for (const arena of ["classic", "vast", "random"] as const) {
      expect(copy("round", arena)).not.toMatch(/The Vast match|Vast\.? match\./i)
      expect(copy("round", arena)).not.toMatch(/\bmatch\.\s*match\b/i)
    }
  })

  it("never puts a universal 2:30 on a Vast round", () => {
    const vast = copy("round", "vast")
    expect(vast).toContain("3:30")
    expect(vast).not.toContain("2:30")
  })

  it("states the one goal, the same on every starting skill", () => {
    for (const d of ["easy", "normal", "hard"] as const) {
      expect(MODES.find((m) => m.id === "round")!.copy({ difficulty: d, arena: "classic", dailyArena: null })).toContain(
        `${CONFIG.round.criticalMass} mass`,
      )
    }
    expect(CONFIG.round.criticalMass).toBe(130)
  })

  it("states the daily arena's clock once the day is known", () => {
    const config: DailyConfig = { ...dailyChallenge(new Date("2026-03-04T00:00:00Z")), arena: "vast" }
    const known = MODES.find((m) => m.id === "daily")!.copy({ difficulty: "normal", arena: "classic", dailyArena: config.arena })
    expect(known).toContain("3:30")
    // Before the client resolves the day, the line must not invent a clock.
    expect(copy("daily")).not.toMatch(/\d:\d\d/)
  })

  it("never claims a three-minute match anywhere in the menu copy", () => {
    for (const m of MODES) {
      for (const arena of ["classic", "vast", "random"] as const) {
        expect(m.copy(roundCtx(arena)).toLowerCase()).not.toContain("3 minute")
        expect(m.copy(roundCtx(arena)).toLowerCase()).not.toContain("three minute")
      }
    }
  })

  it("teaches the burn in plain language, not 'prograde'", () => {
    expect(BURN_TIP).toBe("Fly close past a star, then DASH ALONG PATH for a speed boost.")
    expect(BURN_TIP).not.toMatch(/prograde/i)
    expect(burnPromptLabel(true)).toBe("DASH ALONG PATH")
    expect(burnPromptLabel(false)).toBe("DASH ALONG PATH  SHIFT")
    expect(burnPromptLabel(false).toLowerCase()).not.toContain("prograde")
  })
})

const DESKTOP_CONTROLS =
  "WASD or hold the mouse to thrust · Space or right-click to pull · Shift = DASH ALONG PATH · E repulse · Q Singularity · Esc pauses"
const TOUCH_CONTROLS = "Drag on the left to steer · hold PULL · tap the glowing DASH, REPULSE and ULT"

function menu(mode: MenuMode, arena: "classic" | "vast" | "random", layout: "desktop" | "touch") {
  return createElement(MenuScreen, {
    difficulty: "normal" as const,
    onDifficulty: noop,
    onPlay: noop,
    muted: false,
    onToggleMute: noop,
    layout,
    arena,
    onArena: noop,
    onStats: noop,
    mode,
    onMode: noop,
    endlessBest: 0,
    campaignLevel: CAMPAIGN_LEVELS[0],
    onCampaignLevel: noop,
    campaignProgress: emptyProgress(),
    daily: null,
  })
}

describe("what the rendered menu says", () => {
  it("uses the selected arena's clock and the configured goal in the Round panel", () => {
    const vast = renderToStaticMarkup(menu("round", "vast", "desktop"))
    expect(vast).toContain("3:30 match")
    expect(vast).toContain(`Reach ${CONFIG.round.criticalMass} mass`)
    expect(vast).not.toContain("2:30 match")

    const random = renderToStaticMarkup(menu("round", "random", "desktop"))
    expect(random).toContain("A 2:30 match, or 3:30 in The Vast. Reach 130 mass or be the last one left.")
  })

  it("gives the daily panel a real clock only from what it knows", () => {
    const today = renderToStaticMarkup(menu("daily", "classic", "desktop"))
    // No daily config yet: the how-line states both possible lengths rather than one guess.
    expect(today).toContain("One round, 2:30 (3:30 in The Vast)")
  })
})

describe("pause help", () => {
  it("re-reads the controls and the burn instruction without a pointer query in the markup", () => {
    const markup = renderToStaticMarkup(
      createElement(PauseScreen, { onResume: noop, onRestart: noop, onQuit: noop, layout: "desktop" as const }),
    )
    expect(markup).toContain(BURN_TIP)
    expect(markup).toContain(DESKTOP_CONTROLS)
    expect(markup).toContain(TOUCH_CONTROLS)
    expect(markup).toContain("Resume")
    expect(markup).toContain("Restart")
    expect(markup).toContain("Quit to menu")
    // Both lines ship and CSS picks one, so the server never guesses the pointer.
    expect(markup).not.toContain("(pointer: coarse)")
    expect(markup).not.toContain('data-touch="1"')
  })

  it("marks a touch device from the same layout source the menu uses", () => {
    const paused = renderToStaticMarkup(
      createElement(PauseScreen, { onResume: noop, onRestart: noop, onQuit: noop, layout: "touch" as const }),
    )
    expect(paused).toContain('data-touch="1"')
    // A hybrid device that has touched the screen sees the touch line on both screens.
    expect(renderToStaticMarkup(menu("round", "classic", "touch"))).toContain('data-touch="1"')
    expect(paused).toContain(TOUCH_CONTROLS)
    expect(paused).toContain(BURN_TIP)
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

  it("shows the live speed and names a surge ceiling while one is paying", () => {
    const snap: FeedView = { ...endlessHud(), phase: "playing" }
    const still = hudMarkup({ ...snap, speed: 342.4, assist: { ...snap.assist, surge: 0, surgeMul: 1 } })
    expect(still).toContain("SPEED 342 u/s")
    expect(still).not.toContain("×1.24")

    const surging = hudMarkup({ ...snap, speed: 342.4, assist: { ...snap.assist, surge: 2.1, surgeMul: 1.24 } })
    // The whole line stays in the DOM for assistive tech; the visible parts can be trimmed by width.
    expect(surging).toContain("SPEED 342 u/s · ×1.24 cap")
    expect(surging).toContain("gw-speed-prefix")
    expect(surging).toContain("gw-speed-cap")
    expect(surging).toMatch(/<span class="gw-sr-only">SPEED 342 u\/s · ×1\.24 cap<\/span>/)
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
