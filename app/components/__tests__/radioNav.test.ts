// Roving-tabindex keyboard model for the menu's role="radio" groups. Pure: no DOM.

import { describe, expect, it } from "vitest"
import { radioTabStop, radioTarget } from "../radioNav"

describe("radioTarget", () => {
  it("moves right and down to the next radio, wrapping at the end", () => {
    expect(radioTarget("ArrowRight", 0, 4)).toBe(1)
    expect(radioTarget("ArrowRight", 3, 4)).toBe(0)
    expect(radioTarget("ArrowDown", 1, 4)).toBe(2)
  })

  it("moves left and up to the previous radio, wrapping at the start", () => {
    expect(radioTarget("ArrowLeft", 2, 4)).toBe(1)
    expect(radioTarget("ArrowLeft", 0, 4)).toBe(3)
    expect(radioTarget("ArrowUp", 1, 4)).toBe(0)
  })

  it("jumps to the ends with Home and End", () => {
    expect(radioTarget("Home", 2, 4)).toBe(0)
    expect(radioTarget("End", 1, 4)).toBe(3)
  })

  it("skips disabled radios in both directions", () => {
    const disabled = (i: number) => i === 1 || i === 2
    expect(radioTarget("ArrowRight", 0, 4, disabled)).toBe(3)
    expect(radioTarget("ArrowLeft", 3, 4, disabled)).toBe(0)
    expect(radioTarget("Home", 3, 4, disabled)).toBe(0)
    expect(radioTarget("End", 0, 4, disabled)).toBe(3)
  })

  it("returns null for keys that are not group navigation", () => {
    expect(radioTarget("Tab", 0, 4)).toBeNull()
    expect(radioTarget("Enter", 0, 4)).toBeNull()
    expect(radioTarget("a", 0, 4)).toBeNull()
  })

  it("returns null when every radio is disabled", () => {
    expect(radioTarget("ArrowRight", 0, 3, () => true)).toBeNull()
  })

  it("moves to the first/last enabled radio when nothing is selected", () => {
    expect(radioTarget("ArrowRight", -1, 3)).toBe(0)
    expect(radioTarget("ArrowLeft", -1, 3)).toBe(2)
  })
})

describe("radioTabStop", () => {
  it("is the checked radio when it can be focused", () => {
    expect(radioTabStop(2, 4)).toBe(2)
  })

  it("falls back to the first enabled radio when the checked one is disabled", () => {
    expect(radioTabStop(1, 4, (i) => i === 1)).toBe(0)
  })

  it("is -1 when the group has nothing focusable", () => {
    expect(radioTabStop(0, 3, () => true)).toBe(-1)
  })
})
