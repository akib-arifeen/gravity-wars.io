// The in-arena activity feed: absorbs, well deaths, bots dropping in and leaving, respawns. It is
// what makes an .io arena feel alive -- the world keeps happening whether or not you are in it.
//
// Pure: reads a world and one step's events, returns plain data for the HUD. No DOM.

import type { GameEvent, HudSnapshot, World } from "./types"

export type FeedTone = "you" | "kill" | "death" | "join" | "leave" | "event"

export interface FeedItem {
  /** Monotonic id, stable across renders. */
  id: number
  text: string
  tone: FeedTone
  /** World time (s) when the line was made; mergeFeed prunes by it. */
  at: number
}

/** How many lines the HUD keeps. */
export const FEED_MAX = 5

/** Seconds a line stays before it fades out. */
export const FEED_TTL = 6

/**
 * Turn one step's events into feed lines and the next free id. Only lines a player would care
 * about are produced (absorbs, deaths, joins/leaves, respawns); every other event is ignored.
 * Returns the new lines in event order plus the id counter to pass to the next call.
 */
export function feedLines(world: World, events: readonly GameEvent[], nextId: number): { items: FeedItem[]; nextId: number } {
  const nameOf = (id: string): string => {
    for (const b of world.bodies) if (b.id === id) return b.name
    return id === "player" ? "You" : "a rival"
  }
  const items: FeedItem[] = []
  const push = (text: string, tone: FeedTone) => {
    items.push({ id: nextId++, text, tone, at: world.time })
  }
  for (const ev of events) {
    switch (ev.type) {
      case "absorb": {
        const eater = ev.eaterId === "player" ? "You" : nameOf(ev.eaterId)
        const victim = ev.victimId === "player" ? "you" : nameOf(ev.victimId)
        if (ev.victimId === "player") push(`${nameOf(ev.eaterId)} absorbed you`, "death")
        else if (ev.eaterId === "player") push(`You absorbed ${victim}`, "you")
        else push(`${eater} absorbed ${victim}`, "kill")
        break
      }
      case "death": {
        if (ev.cause.by === "body") break // covered by the absorb event above
        if (ev.bodyId === "player") {
          push(`You fell into ${wellNoun(ev.cause.by)}`, "death")
        } else {
          push(`${nameOf(ev.bodyId)} fell into ${wellNoun(ev.cause.by)}`, "death")
        }
        break
      }
      case "assist":
        if (ev.victimId !== "player") push(`${nameOf(ev.bodyId)} set up ${nameOf(ev.victimId)}`, "event")
        break
      case "respawn":
        if (ev.bodyId === "player") push("You respawned", "you")
        break
      case "join":
        if (ev.bodyId !== "player") push(`${ev.name} dropped into the field`, "join")
        break
      case "leave":
        push(`${nameOf(ev.bodyId)} left the field`, "leave")
        break
      default:
        break
    }
  }
  return { items, nextId }
}

/**
 * Merge new lines into the current feed and prune it: drop lines older than FEED_TTL (world
 * seconds) and keep the newest FEED_MAX. Pure.
 */
export function mergeFeed(current: readonly FeedItem[], incoming: readonly FeedItem[], now: number): FeedItem[] {
  const merged = current.concat(incoming)
  const cutoff = now - FEED_TTL
  const fresh = merged.filter((f) => f.at >= cutoff)
  return fresh.length > FEED_MAX ? fresh.slice(fresh.length - FEED_MAX) : fresh
}

/** Noun phrase for a lethal well death, shared with the respawn overlay copy. */
export function wellNoun(kind: "star" | "blackhole" | "whitedwarf" | "neutronstar" | "pulsar"): string {
  switch (kind) {
    case "star":
      return "a star"
    case "blackhole":
      return "the black hole"
    case "whitedwarf":
      return "a white dwarf"
    case "neutronstar":
      return "a neutron star"
    case "pulsar":
      return "a pulsar beam"
  }
}

/** The HUD snapshot plus the live activity feed (the shell type the GameView pushes to the HUD). */
export interface FeedView extends HudSnapshot {
  feed?: FeedItem[]
}

/** Kept so the tone type is stable for the HUD. */
export const FEED_TONES: readonly FeedTone[] = ["you", "kill", "death", "join", "leave", "event"]
