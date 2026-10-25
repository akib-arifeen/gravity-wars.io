// The menu is server-rendered and then hydrated. A coarse pointer cannot be evaluated on the
// server, so the menu's first client render must not depend on matchMedia: choosing the touch
// control line during render mismatched the server's text and threw React hydration error #418.

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CAMPAIGN_LEVELS, emptyProgress } from "@/game/campaign"
import { MenuScreen } from "../Screens"

const noop = () => {}

const DESKTOP_CONTROLS =
  "WASD or hold the mouse to thrust · Space or right-click to pull · Shift dash · E repulse · Q Singularity · Esc pauses"
const TOUCH_CONTROLS = "Drag on the left to steer · hold PULL · tap DASH, REPULSE and ULT"

function menu(layout: "desktop" | "touch") {
  return createElement(MenuScreen, {
    difficulty: "normal" as const,
    onDifficulty: noop,
    onPlay: noop,
    muted: false,
    onToggleMute: noop,
    layout,
    arena: "random" as const,
    onArena: noop,
    onStats: noop,
    mode: "endless" as const,
    onMode: noop,
    endlessBest: 0,
    campaignLevel: CAMPAIGN_LEVELS[0],
    onCampaignLevel: noop,
    campaignProgress: emptyProgress(),
    daily: null,
  })
}

describe("menu hydration", () => {
  it("renders the same markup when the client reports a coarse pointer", () => {
    const serverMarkup = renderToStaticMarkup(menu("desktop"))
    Object.defineProperty(globalThis, "window", {
      value: { matchMedia: (q: string) => ({ matches: q === "(pointer: coarse)" }) },
      configurable: true,
    })
    try {
      expect(renderToStaticMarkup(menu("desktop"))).toBe(serverMarkup)
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  it("ships both instruction lines for CSS to choose between", () => {
    const markup = renderToStaticMarkup(menu("desktop"))
    expect(markup).toContain(DESKTOP_CONTROLS)
    expect(markup).toContain(TOUCH_CONTROLS)
    expect(markup).not.toContain('data-touch="1"')
  })

  it("marks a touch layout without dropping either line", () => {
    const markup = renderToStaticMarkup(menu("touch"))
    expect(markup).toContain('data-touch="1"')
    expect(markup).toContain(DESKTOP_CONTROLS)
    expect(markup).toContain(TOUCH_CONTROLS)
  })
})
