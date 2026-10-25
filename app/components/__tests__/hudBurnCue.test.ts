// The burn window has exactly one accessible channel: the dash control's name. It must not also
// be spoken by the polite status region, which carries the boss line and must not change with a
// 0.35 s window (that would announce it late, twice, or over the boss).

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { bossAnnouncement, type BossHud } from "@/game/boss"
import { createWorld, hudSnapshot } from "@/game/engine"
import type { FeedView } from "@/game/feed"
import type { InputController } from "@/game/input"
import { Hud } from "../Hud"
import { TouchControls } from "../TouchControls"

const noop = () => {}

const BOSS: BossHud = {
  name: "The Devourer",
  kind: "leviathan",
  healthPct: 0.6,
  mass: 400,
  phase: "telegraph",
  special: "pull",
  t: 0.2,
  total: 1.2,
  splitDone: false,
}

/** A real snapshot with only the advertised window switched, so every other HUD gate is honest. */
function view(window: boolean): FeedView {
  const world = createWorld({ seed: 7, difficulty: "normal", botCount: 0, cosmic: false })
  const snap = hudSnapshot(world)
  return { ...snap, assist: { ...snap.assist, window } }
}

function hudMarkup(window: boolean, boss: BossHud | null = null): string {
  return renderToStaticMarkup(
    createElement(Hud, {
      hud: view(window),
      muted: false,
      onPause: noop,
      onToggleMute: noop,
      layout: "desktop" as const,
      onPress: noop,
      boss,
    }),
  )
}

/** The one polite status paragraph, captured by its own text only. */
function statusText(markup: string): string | null {
  const m = /<p class="gw-sr-only" role="status" aria-live="polite">([^<]*)<\/p>/.exec(markup)
  return m ? m[1] : null
}

describe("the burn window's accessible channel", () => {
  it("changes the dash control's name and glow, and never speaks a live burn message", () => {
    const closed = hudMarkup(false)
    const open = hudMarkup(true)

    expect(closed).toContain('aria-label="Dash (Shift)"')
    expect(open).toContain('aria-label="Dash (Shift), prograde burn window open"')
    expect(closed).not.toContain('data-burn="1"')
    expect(open).toContain('data-burn="1"')

    const status = statusText(open)
    expect(status, "the polite status paragraph is still rendered").not.toBeNull()
    expect(status!.toLowerCase()).not.toContain("burn")
    expect(status!).not.toContain("Prograde")
    expect(open.replace(/aria-label="Dash[^"]*"/, "")).not.toContain("prograde burn window open")
  })

  it("leaves the boss line exactly as it was, whatever the burn state", () => {
    const closed = hudMarkup(false, BOSS)
    const open = hudMarkup(true, BOSS)

    expect(statusText(closed)).toBe(bossAnnouncement(BOSS))
    expect(statusText(open)).toBe(bossAnnouncement(BOSS))
    expect(closed).not.toContain('data-burn="1"')
    expect(open).toContain('data-burn="1"')
  })

  it("gives the touch Dash button the same single-channel cue", () => {
    const input = { setVirtual: noop, press: noop } as unknown as InputController
    const closed = renderToStaticMarkup(
      createElement(TouchControls, { input, hud: view(false) }),
    )
    const open = renderToStaticMarkup(createElement(TouchControls, { input, hud: view(true) }))

    expect(closed).toContain('aria-label="Dash"')
    expect(open).toContain('aria-label="Dash, prograde burn window open"')
    expect(closed).not.toContain('data-burn="1"')
    expect(open).toContain('data-burn="1"')
  })
})
