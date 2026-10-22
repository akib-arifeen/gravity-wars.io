// Cosmic events, written from the contract: the doc comments of cosmic.ts plus types.ts and
// config.ts. updateCosmic is driven directly (as step() does, once per playing step).

import { describe, expect, it } from "vitest"
import { ARENA_IDS } from "../arenas"
import { CONFIG } from "../config"
import { COSMIC_INFO, COSMIC_KINDS, gmScale, lethalRadius, updateCosmic } from "../cosmic"
import type { ArenaId, CosmicKind, GameEvent, World } from "../types"
import { createWorld } from "../engine"
import { DT, addWell, addZone, controlledWorld, dist, makeWell } from "./helpers"

type CosmicGameEvent = Extract<GameEvent, { type: "cosmic" }>

/** Advance one call and return the cosmic events it pushed (the engine clears world.events per step). */
function tick(w: World): { meteors: number; events: CosmicGameEvent[] } {
  w.events = []
  const meteors = updateCosmic(w)
  return { meteors, events: w.events.filter((e): e is CosmicGameEvent => e.type === "cosmic") }
}

/** A real arena world (wells, wormholes and zones as built) whose next cosmic event starts on the very next call. */
function armedWorld(seed: number, arena: ArenaId = "classic"): World {
  const w = createWorld({ seed, difficulty: "normal", botCount: 1, arena, cosmic: false })
  w.phase = "playing"
  w.countdown = 0
  w.nextCosmicIn = DT / 2
  return w
}

/** Find a seed whose first event is `kind`; returns the world right after the starting call. */
function findEvent(kind: CosmicKind, arena?: ArenaId): { w: World; start: CosmicGameEvent[] } {
  for (let seed = 1; seed <= 800; seed++) {
    const w = armedWorld(seed, arena)
    const { events } = tick(w)
    if (w.cosmic?.kind === kind) return { w, start: events }
  }
  throw new Error(`no seed starts a ${kind}`)
}

/** All kinds started across many seeds on an arena. */
function kindsSeen(arena: ArenaId, seeds = 400): Set<CosmicKind> {
  const seen = new Set<CosmicKind>()
  for (let seed = 1; seed <= seeds; seed++) {
    const w = armedWorld(seed, arena)
    tick(w)
    if (w.cosmic) seen.add(w.cosmic.kind)
  }
  return seen
}

const KINDS = [...COSMIC_KINDS]

describe("registry", () => {
  it("lists the six kinds with announcer copy (no emoji)", () => {
    expect(KINDS.sort()).toEqual(["gravityStorm", "meteorShower", "nebulaDrift", "quantumAnomaly", "solarFlare", "wormholeStorm"].sort())
    for (const k of COSMIC_KINDS) {
      expect(COSMIC_INFO[k].title.length).toBeGreaterThan(0)
      expect(COSMIC_INFO[k].active.length).toBeGreaterThan(0)
      if (CONFIG.cosmic[k].warning > 0) expect(COSMIC_INFO[k].warning.length).toBeGreaterThan(0)
      expect(/\p{Extended_Pictographic}/u.test(Object.values(COSMIC_INFO[k]).join(" "))).toBe(false)
    }
  })
})

describe("scheduling", () => {
  it("nothing starts while nextCosmicIn is above zero; it counts down by dt per call", () => {
    const w = controlledWorld({ botCount: 1 })
    w.nextCosmicIn = 1
    for (let i = 0; i < 30; i++) {
      const { events } = tick(w)
      expect(events).toHaveLength(0)
    }
    expect(w.cosmic).toBeNull()
    expect(w.nextCosmicIn).toBeCloseTo(1 - 30 * DT, 9)
  })

  it("the disabled schedule (1e9) never fires", () => {
    const w = controlledWorld({ botCount: 1 })
    for (let i = 0; i < 2000; i++) tick(w)
    expect(w.cosmic).toBeNull()
    expect(w.nextCosmicIn).toBeGreaterThan(1e8)
  })

  it("starts when the countdown reaches 0, with the next id", () => {
    const { w, start } = findEvent("meteorShower")
    expect(w.cosmic!.id).toBe(1)
    expect(w.nextCosmicId).toBe(2)
    expect(start).toHaveLength(1)
  })

  it("every kind is reachable on classic (uniform over the valid kinds)", () => {
    expect(kindsSeen("classic").size).toBe(6)
  })

  it("only valid kinds: no solar flare without a star, no wormhole storm without wormholes", () => {
    const maw = kindsSeen("maw")
    expect(maw.has("solarFlare")).toBe(false)
    expect(maw.has("wormholeStorm")).toBe(true)
    expect(maw.size).toBe(5)
    const nebula = kindsSeen("nebula")
    expect(nebula.has("wormholeStorm")).toBe(false)
    expect(nebula.has("solarFlare")).toBe(true)
    expect(nebula.size).toBe(5)
    for (const arena of ARENA_IDS) {
      const seen = kindsSeen(arena, 150)
      const w = armedWorld(1, arena)
      if (w.wells.every((x) => x.kind !== "star")) expect(seen.has("solarFlare"), arena).toBe(false)
      if (w.wormholes.length === 0) expect(seen.has("wormholeStorm"), arena).toBe(false)
    }
  })

  it("a world with no stars at all never flares; with no wormholes never storms them", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const w = armedWorld(seed)
      w.wells = []
      w.wormholes = []
      tick(w)
      expect(["solarFlare", "wormholeStorm"]).not.toContain(w.cosmic?.kind)
    }
  })
})

describe("stages and timing", () => {
  for (const kind of COSMIC_KINDS) {
    it(`${kind}: warning (if any) -> active -> end with the documented durations and events`, () => {
      const cfg = CONFIG.cosmic[kind]
      const { w, start } = findEvent(kind)
      const ev = w.cosmic!
      expect(ev.warning).toBe(cfg.warning)
      expect(ev.duration).toBe(cfg.duration)
      expect(ev.t).toBeLessThanOrEqual(DT + 1e-12)
      expect(ev.stage).toBe(cfg.warning > 0 ? "warning" : "active")
      expect(start.map((e) => e.stage)).toEqual([cfg.warning > 0 ? "warning" : "start"])
      expect(start[0].kind).toBe(kind)

      const stages: string[] = start.map((e) => e.stage)
      let warningCalls = 0
      let activeCalls = 0
      let ended = false
      for (let i = 0; i < 4000 && !ended; i++) {
        const before = w.cosmic!.stage
        const { events } = tick(w)
        for (const e of events) stages.push(e.stage)
        if (before === "warning") warningCalls++
        else activeCalls++
        ended = w.cosmic === null
      }
      expect(ended).toBe(true)
      expect(stages).toEqual(cfg.warning > 0 ? ["warning", "start", "end"] : ["start", "end"])
      if (cfg.warning > 0) expect(Math.abs(warningCalls - cfg.warning / DT)).toBeLessThanOrEqual(2)
      expect(Math.abs(activeCalls - cfg.duration / DT)).toBeLessThanOrEqual(3)
      expect(w.nextCosmicIn).toBeGreaterThanOrEqual(CONFIG.cosmic.gap[0])
      expect(w.nextCosmicIn).toBeLessThanOrEqual(CONFIG.cosmic.gap[1])
    })
  }

  it("t counts seconds in the current stage and resets on the switch to active", () => {
    const { w } = findEvent("solarFlare")
    let last = w.cosmic!.t
    let switched = false
    for (let i = 0; i < 4000 && w.cosmic && !switched; i++) {
      tick(w)
      if (!w.cosmic) break
      if (w.cosmic.stage === "active") {
        switched = true
        expect(w.cosmic.t).toBeLessThanOrEqual(DT + 1e-9)
      } else {
        expect(w.cosmic.t).toBeCloseTo(last + DT, 9)
        last = w.cosmic.t
      }
    }
    expect(switched).toBe(true)
  })

  it("one event at a time over a long run: well-formed warning/start/end sequences with gaps in range", () => {
    const w = armedWorld(5)
    w.nextCosmicIn = 1
    const log: { call: number; e: CosmicGameEvent }[] = []
    const ids = new Set<number>()
    let open: { kind: CosmicKind; stage: string } | null = null
    let lastEnd = -1
    let nextStartGap = -1
    for (let call = 0; call < 36000; call++) {
      const { events } = tick(w)
      for (const e of events) {
        log.push({ call, e })
        if (e.stage === "warning" || (e.stage === "start" && open === null)) {
          expect(open, `call ${call}: an event started while another was open`).toBeNull()
          open = { kind: e.kind, stage: e.stage }
          if (lastEnd >= 0) nextStartGap = (call - lastEnd) * DT
          if (lastEnd >= 0) {
            expect(nextStartGap).toBeGreaterThanOrEqual(CONFIG.cosmic.gap[0] - 0.1)
            expect(nextStartGap).toBeLessThanOrEqual(CONFIG.cosmic.gap[1] + 0.1)
          }
          ids.add(w.cosmic!.id)
        } else if (e.stage === "start") {
          expect(open?.stage).toBe("warning")
          expect(open?.kind).toBe(e.kind)
          if (open) open.stage = "start"
        } else {
          expect(open?.kind).toBe(e.kind)
          open = null
          lastEnd = call
        }
      }
      if (open) expect(w.cosmic, `call ${call}`).not.toBeNull()
      else expect(w.cosmic, `call ${call}`).toBeNull()
    }
    expect(ids.size).toBeGreaterThanOrEqual(8)
    expect([...ids]).toEqual([...ids].sort((a, b) => a - b))
  })

  it("escalation: while timeLeft <= escalation.last the gap after an event is halved", () => {
    for (const [timeLeft, mul] of [
      [CONFIG.escalation.last - 5, 0.5],
      [CONFIG.round.duration, 1],
    ] as const) {
      const { w } = findEvent("nebulaDrift")
      w.timeLeft = timeLeft
      let guard = 0
      while (w.cosmic && guard++ < 4000) tick(w)
      expect(w.cosmic).toBeNull()
      expect(w.nextCosmicIn).toBeGreaterThanOrEqual(CONFIG.cosmic.gap[0] * mul - 1e-9)
      expect(w.nextCosmicIn).toBeLessThanOrEqual(CONFIG.cosmic.gap[1] * mul + 1e-9)
    }
  })
})

describe("placement and effects", () => {
  it("meteorShower: centre 300..arenaRadius-500 from the origin, radius from CONFIG", () => {
    let seen = 0
    for (let seed = 1; seed <= 400 && seen < 12; seed++) {
      const w = armedWorld(seed)
      tick(w)
      if (w.cosmic?.kind !== "meteorShower") continue
      seen++
      const ev = w.cosmic
      const d = Math.hypot(ev.x, ev.y)
      expect(d).toBeGreaterThanOrEqual(300 - 1e-9)
      expect(d).toBeLessThanOrEqual(w.arenaRadius - 500 + 1e-9)
      expect(ev.r).toBe(CONFIG.cosmic.meteorShower.radius)
      expect(ev.targetId).toBe("")
    }
    expect(seen).toBeGreaterThan(5)
  })

  it("solarFlare: targets a random star, at its position, radius star.radius * radiusMul", () => {
    const targets = new Set<string>()
    let seen = 0
    for (let seed = 1; seed <= 400; seed++) {
      const w = armedWorld(seed)
      tick(w)
      if (w.cosmic?.kind !== "solarFlare") continue
      seen++
      const ev = w.cosmic
      const star = w.wells.find((x) => x.id === ev.targetId)
      expect(star, `seed ${seed}`).toBeDefined()
      expect(star!.kind).toBe("star")
      expect(ev.x).toBe(star!.x)
      expect(ev.y).toBe(star!.y)
      expect(ev.r).toBeCloseTo(star!.radius * CONFIG.cosmic.solarFlare.radiusMul, 9)
      targets.add(ev.targetId)
    }
    expect(seen).toBeGreaterThan(20)
    expect(targets.size).toBeGreaterThan(1)
  })

  it("gravityStorm and wormholeStorm: centred on the origin, radius = arenaRadius", () => {
    for (const kind of ["gravityStorm", "wormholeStorm"] as const) {
      const { w } = findEvent(kind)
      expect(w.cosmic!.x).toBe(0)
      expect(w.cosmic!.y).toBe(0)
      expect(w.cosmic!.r).toBe(w.arenaRadius)
      expect(w.cosmic!.targetId).toBe("")
    }
  })

  it("nebulaDrift: adds a nebula zone tied to the event id, drifting inward at cfg.speed from the wall", () => {
    let seen = 0
    for (let seed = 1; seed <= 400 && seen < 10; seed++) {
      const w = armedWorld(seed)
      tick(w)
      if (w.cosmic?.kind !== "nebulaDrift") continue
      seen++
      const ev = w.cosmic
      const zone = w.zones.find((z) => z.eventId === ev.id)
      expect(zone, `seed ${seed}`).toBeDefined()
      expect(zone!.kind).toBe("nebula")
      expect(zone!.strength).toBe(CONFIG.cosmic.nebulaDrift.drag)
      expect(zone!.r).toBe(CONFIG.cosmic.nebulaDrift.radius)
      expect(ev.r).toBe(CONFIG.cosmic.nebulaDrift.radius)
      expect(Math.hypot(zone!.vx, zone!.vy)).toBeCloseTo(CONFIG.cosmic.nebulaDrift.speed, 9)
      // "start just inside the wall ... moving toward the opposite side".
      expect(Math.hypot(zone!.x, zone!.y)).toBeLessThanOrEqual(w.arenaRadius + 1e-9)
      expect(Math.hypot(zone!.x, zone!.y)).toBeGreaterThanOrEqual(w.arenaRadius - 2 * zone!.r)
      expect(zone!.x * zone!.vx + zone!.y * zone!.vy).toBeLessThan(0)
      expect(w.cosmic!.stage).toBe("active")
    }
    expect(seen).toBeGreaterThan(5)
  })

  it("quantumAnomaly: anomaly zone at r 300..1200, at least 400 from every lethal well", () => {
    let seen = 0
    for (const arena of ["classic", "binary", "maw", "belt"] as const) {
      for (let seed = 1; seed <= 150 && seen < 80; seed++) {
        const w = armedWorld(seed, arena)
        tick(w)
        if (w.cosmic?.kind !== "quantumAnomaly") continue
        seen++
        const ev = w.cosmic
        const zone = w.zones.find((z) => z.eventId === ev.id)
        expect(zone, `${arena} seed ${seed}`).toBeDefined()
        expect(zone!.kind).toBe("anomaly")
        expect(zone!.strength).toBe(CONFIG.zones.anomalyUlt)
        expect(zone!.r).toBe(CONFIG.cosmic.quantumAnomaly.radius)
        const d = Math.hypot(zone!.x, zone!.y)
        expect(d).toBeGreaterThanOrEqual(300 - 1e-9)
        expect(d).toBeLessThanOrEqual(1200 + 1e-9)
        for (const well of w.wells) {
          if (well.lethal) expect(dist(zone!, well), `${arena} seed ${seed} vs ${well.id}`).toBeGreaterThanOrEqual(400 - 1e-9)
        }
      }
    }
    expect(seen).toBeGreaterThan(10)
  })

  it("zones created by an event are removed when it ends; other zones stay", () => {
    for (const kind of ["nebulaDrift", "quantumAnomaly"] as const) {
      const { w } = findEvent(kind)
      const keeper = addZone(w, "nebula", 0, 0, 100, 2)
      expect(w.zones.filter((z) => z.eventId !== null)).toHaveLength(1)
      let guard = 0
      while (w.cosmic && guard++ < 4000) tick(w)
      expect(w.cosmic).toBeNull()
      expect(w.zones.filter((z) => z.eventId !== null)).toHaveLength(0)
      expect(w.zones).toContain(keeper)
    }
  })

  it("meteorShower: returns floor(tAfter * rate) - floor(tBefore * rate) while active, 0 otherwise", () => {
    const { w } = findEvent("meteorShower")
    let total = 0
    let activeSteps = 0
    for (let i = 0; i < 4000 && w.cosmic; i++) {
      const stageBefore = w.cosmic.stage
      const tBefore = w.cosmic.t
      const { meteors } = tick(w)
      if (stageBefore === "warning") {
        expect(meteors).toBe(0)
        continue
      }
      activeSteps++
      const tAfter = w.cosmic ? w.cosmic.t : tBefore + DT
      expect(meteors, `active step ${activeSteps}`).toBe(Math.floor(tAfter * CONFIG.cosmic.meteorShower.rate) - Math.floor(tBefore * CONFIG.cosmic.meteorShower.rate))
      total += meteors
    }
    expect(total).toBeGreaterThanOrEqual(Math.floor(CONFIG.cosmic.meteorShower.duration * CONFIG.cosmic.meteorShower.rate) - 1)
    expect(total).toBeLessThanOrEqual(Math.ceil(CONFIG.cosmic.meteorShower.duration * CONFIG.cosmic.meteorShower.rate) + 1)
  })

  it("other kinds never request meteors", () => {
    for (const kind of ["solarFlare", "gravityStorm", "wormholeStorm", "nebulaDrift", "quantumAnomaly"] as const) {
      const { w } = findEvent(kind)
      let sum = 0
      for (let i = 0; i < 4000 && w.cosmic; i++) sum += tick(w).meteors
      expect(sum, kind).toBe(0)
    }
  })

  it("wormholeStorm: re-places the pair every cfg.every seconds of ACTIVE time, keeping ids", () => {
    const { w } = findEvent("wormholeStorm")
    const sig = () => w.wormholes.map((x) => `${x.x.toFixed(4)},${x.y.toFixed(4)}`).join("|")
    let last = sig()
    let moves = 0
    let warningMoves = 0
    for (let i = 0; i < 4000 && w.cosmic; i++) {
      const stage = w.cosmic.stage
      tick(w)
      expect(w.wormholes.map((x) => x.id)).toEqual(["wh-a", "wh-b"])
      const now = sig()
      if (now !== last) {
        if (stage === "warning") warningMoves++
        else moves++
        last = now
      }
    }
    expect(warningMoves).toBe(0)
    const expected = CONFIG.cosmic.wormholeStorm.duration / CONFIG.cosmic.wormholeStorm.every
    expect(moves).toBeGreaterThanOrEqual(Math.floor(expected) - 1)
    expect(moves).toBeLessThanOrEqual(Math.ceil(expected) + 1)
  })
})

describe("gmScale and lethalRadius", () => {
  it("gmScale is 1 without a storm, during its warning, and after it; gmMul only while active", () => {
    const { w } = findEvent("gravityStorm")
    expect(w.cosmic!.stage).toBe("warning")
    expect(gmScale(w)).toBe(1)
    let sawActive = false
    for (let i = 0; i < 4000 && w.cosmic; i++) {
      tick(w)
      if (!w.cosmic) break
      if (w.cosmic.stage === "active") {
        sawActive = true
        expect(gmScale(w)).toBe(CONFIG.cosmic.gravityStorm.gmMul)
      } else {
        expect(gmScale(w)).toBe(1)
      }
    }
    expect(sawActive).toBe(true)
    expect(gmScale(w)).toBe(1)
  })

  it("other events never change gmScale", () => {
    for (const kind of ["meteorShower", "solarFlare", "wormholeStorm", "nebulaDrift", "quantumAnomaly"] as const) {
      const { w } = findEvent(kind)
      for (let i = 0; i < 4000 && w.cosmic; i++) {
        tick(w)
        expect(gmScale(w), kind).toBe(1)
      }
    }
  })

  it("lethalRadius = radius, except radius * radiusMul for the flaring star while the flare is ACTIVE", () => {
    const { w } = findEvent("solarFlare")
    const target = w.wells.find((x) => x.id === w.cosmic!.targetId)!
    const others = w.wells.filter((x) => x.id !== target.id)
    expect(w.cosmic!.stage).toBe("warning")
    expect(lethalRadius(w, target)).toBe(target.radius)
    let sawActive = false
    for (let i = 0; i < 4000 && w.cosmic; i++) {
      tick(w)
      if (!w.cosmic) break
      if (w.cosmic.stage === "active") {
        sawActive = true
        expect(lethalRadius(w, target)).toBeCloseTo(target.radius * CONFIG.cosmic.solarFlare.radiusMul, 9)
      } else {
        expect(lethalRadius(w, target)).toBe(target.radius)
      }
      for (const o of others) expect(lethalRadius(w, o)).toBe(o.radius)
    }
    expect(sawActive).toBe(true)
    expect(lethalRadius(w, target)).toBe(target.radius)
  })

  it("lethalRadius is just the radius with no event, and for solid wells", () => {
    const w = controlledWorld({ botCount: 1 })
    const star = addWell(w, "star", 0, 0)
    expect(lethalRadius(w, star)).toBe(star.radius)
    const planet = makeWell("planet", 400, 0)
    expect(lethalRadius(w, planet)).toBe(planet.radius)
  })
})
