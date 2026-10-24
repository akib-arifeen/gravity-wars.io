// The in-arena activity feed: absorb / death / join / leave / respawn lines, and the prune rules.

import { describe, expect, it } from "vitest"
import { FEED_MAX, FEED_TTL, feedLines, mergeFeed, wellNoun, type FeedItem } from "../feed"
import { controlledWorld } from "./helpers"
import type { GameEvent } from "../types"

function names(world: ReturnType<typeof controlledWorld>): void {
  world.bodies[0].name = "You"
  world.bodies[1].name = "Vega"
  world.bodies[2].name = "Rigel"
}

describe("feed lines", () => {
  it("turns absorbs into readable lines and marks the player's own kills", () => {
    const world = controlledWorld({ botCount: 2 })
    names(world)
    const events: GameEvent[] = [
      { type: "absorb", eaterId: "player", victimId: "bot-1", mass: 10, x: 0, y: 0 },
      { type: "absorb", eaterId: "bot-1", victimId: "bot-2", mass: 12, x: 0, y: 0 },
    ]
    const { items, nextId } = feedLines(world, events, 1)
    expect(items).toHaveLength(2)
    expect(items[0].text).toBe("You absorbed Vega")
    expect(items[0].tone).toBe("you")
    expect(items[1].text).toBe("Vega absorbed Rigel")
    expect(items[1].tone).toBe("kill")
    expect(nextId).toBe(3)
  })

  it("tells the player when they were absorbed", () => {
    const world = controlledWorld({ botCount: 2 })
    names(world)
    const { items } = feedLines(world, [{ type: "absorb", eaterId: "bot-1", victimId: "player", mass: 10, x: 0, y: 0 }], 1)
    expect(items[0].text).toBe("Vega absorbed you")
    expect(items[0].tone).toBe("death")
  })

  it("turns well deaths into lines and skips absorber deaths (they are already line-covered)", () => {
    const world = controlledWorld({ botCount: 2 })
    names(world)
    const events: GameEvent[] = [
      { type: "death", bodyId: "bot-1", cause: { by: "blackhole" }, x: 0, y: 0 },
      { type: "death", bodyId: "bot-2", cause: { by: "body", killerId: "bot-1" }, x: 0, y: 0 },
      { type: "death", bodyId: "player", cause: { by: "star" }, x: 0, y: 0 },
    ]
    const { items } = feedLines(world, events, 1)
    expect(items).toHaveLength(2)
    expect(items[0].text).toBe(`Vega fell into ${wellNoun("blackhole")}`)
    expect(items[1].text).toBe("You fell into a star")
  })

  it("reports joins and leaves by name", () => {
    const world = controlledWorld({ botCount: 2 })
    names(world)
    const events: GameEvent[] = [
      { type: "join", bodyId: "bot-9", name: "Nova", skill: "hard", x: 0, y: 0 },
      { type: "leave", bodyId: "bot-2", x: 0, y: 0 },
      { type: "respawn", bodyId: "player", x: 0, y: 0 },
    ]
    const { items } = feedLines(world, events, 1)
    expect(items.map((i) => i.text)).toEqual(["Nova dropped into the field", "Rigel left the field", "You respawned"])
    expect(items[0].tone).toBe("join")
    expect(items[1].tone).toBe("leave")
  })

  it("ignores everything else", () => {
    const world = controlledWorld({ botCount: 1 })
    const { items, nextId } = feedLines(world, [{ type: "phase", phase: "playing" }], 7)
    expect(items).toHaveLength(0)
    expect(nextId).toBe(7)
  })
})

describe("feed merging", () => {
  const mk = (id: number, at: number): FeedItem => ({ id, text: `line ${id}`, tone: "event", at })

  it("drops lines older than the TTL", () => {
    const merged = mergeFeed([mk(1, 1)], [mk(2, 10)], 10)
    expect(merged.map((m) => m.id)).toEqual([2])
    expect(10 - 1).toBeGreaterThan(FEED_TTL)
  })

  it("keeps the newest lines up to the cap", () => {
    const current = [mk(1, 9), mk(2, 9.2)]
    const incoming = [mk(3, 9.4), mk(4, 9.6), mk(5, 9.8)]
    const merged = mergeFeed(current, incoming, 10)
    expect(merged).toHaveLength(FEED_MAX)
    expect(merged[merged.length - 1].id).toBe(5)
  })

  it("keeps recent lines", () => {
    const merged = mergeFeed([mk(1, 9.5)], [mk(2, 10)], 10)
    expect(merged).toHaveLength(2)
  })
})
