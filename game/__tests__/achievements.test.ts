// Achievements and lifetime stats, written from the contract: the doc comments of
// achievements.ts (the 21 conditions, trackStep / finishRound / loadProfile / saveProfile) plus
// types.ts and config.ts. Worlds and event lists are built by hand; nothing here steps the engine.

import { describe, expect, it } from "vitest"
import { ARENA_IDS } from "../arenas"
import {
  ACHIEVEMENTS,
  PROFILE_KEY,
  emptyProfile,
  finishRound,
  loadProfile,
  newTracker,
  saveProfile,
  trackStep,
} from "../achievements"
import type { AchievementDef, Profile, RoundTracker } from "../achievements"
import { CONFIG } from "../config"
import type { ArenaId, CosmicEvent, Difficulty, GameEvent, PowerUpKind, RoundEndReason, RoundResult, World } from "../types"
import { DT, addWell, controlledWorld, placeBody } from "./helpers"

const NOW = 1_700_000_000_000
const ids = (defs: readonly AchievementDef[]) => defs.map((d) => d.id)
const order = (id: string) => ACHIEVEMENTS.findIndex((a) => a.id === id)

function setup(opts: { difficulty?: Difficulty; arena?: ArenaId } = {}) {
  const world = controlledWorld({ botCount: 2, difficulty: opts.difficulty ?? "normal", arena: opts.arena })
  return { profile: emptyProfile(), tracker: newTracker(), world }
}

const absorb = (eater = "player", victim = "bot-1"): GameEvent => ({ type: "absorb", eaterId: eater, victimId: victim, mass: 8, x: 0, y: 0 })
const eat = (kind: "dust" | "comet", bodyId = "player"): GameEvent => ({ type: "eat", bodyId, kind, mass: 1, x: 0, y: 0 })
const pickup = (kind: PowerUpKind, bodyId = "player"): GameEvent => ({ type: "pickup", bodyId, kind, x: 0, y: 0 })

function result(world: World, reason: RoundEndReason, playerWon: boolean, durationS = 100): RoundResult {
  return {
    reason,
    winnerId: playerWon ? "player" : "bot-1",
    playerWon,
    standings: world.bodies.map((b) => ({ id: b.id, name: b.name, color: b.color, mass: b.mass, alive: b.alive })),
    durationS,
  }
}

// ---------------------------------------------------------------------------------------------
describe("the achievement list", () => {
  it("has the 23 documented ids in display order, each with a name and description", () => {
    expect(ids(ACHIEVEMENTS)).toEqual([
      "first_contact",
      "slingshot",
      "escape_velocity",
      "gravity_assist",
      "event_horizon",
      "hungry_void",
      "comet_chaser",
      "power_hungry",
      "phase_diver",
      "sunburn",
      "cadet",
      "pilot",
      "ace",
      "critical",
      "last_light",
      "grazer",
      "hands_off",
      "hat_trick",
      "cartographer",
      "conqueror",
      "veteran",
      "apex",
      "survivor",
    ])
    for (const a of ACHIEVEMENTS) {
      expect(a.name.length).toBeGreaterThan(0)
      expect(a.description.length).toBeGreaterThan(0)
      expect(/\p{Extended_Pictographic}/u.test(a.name + a.description)).toBe(false)
    }
  })

  it("emptyProfile is version 1 with zeroed stats and no achievements; newTracker is blank", () => {
    const p = emptyProfile()
    expect(p.version).toBe(1)
    expect(p.achievements).toEqual({})
    expect(p.stats.rounds).toBe(0)
    expect(p.stats.winsByDifficulty).toEqual({ easy: 0, normal: 0, hard: 0 })
    for (const a of ARENA_IDS) {
      expect(p.stats.arenaRounds[a]).toBe(0)
      expect(p.stats.arenaWins[a]).toBe(0)
    }
    expect(p.stats.pickupKinds).toEqual({ overdrive: false, magnet: false, phase: false, bulk: false })
    expect(emptyProfile()).not.toBe(p)
    const t = newTracker()
    expect(t.absorbs).toBe(0)
    expect(t.pulled).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe("trackStep: mid-round achievements", () => {
  it("first_contact: the player absorbs a rival (not when a bot absorbs)", () => {
    const a = setup()
    expect(ids(trackStep(a.profile, a.tracker, a.world, [absorb("bot-1", "bot-2")], NOW))).toEqual([])
    expect(ids(trackStep(a.profile, a.tracker, a.world, [absorb()], NOW))).toEqual(["first_contact"])
    expect(a.profile.achievements.first_contact).toBe(NOW)
  })

  it("slingshot: the player earns a slingshot", () => {
    const a = setup()
    const sling = (bodyId: string): GameEvent => ({ type: "slingshot", bodyId, speed: 500, x: 0, y: 0 })
    expect(ids(trackStep(a.profile, a.tracker, a.world, [sling("bot-1")], NOW))).toEqual([])
    expect(ids(trackStep(a.profile, a.tracker, a.world, [sling("player")], NOW))).toEqual(["slingshot"])
  })

  it("escape_velocity: player speed strictly above 600", () => {
    const a = setup()
    placeBody(a.world, 0, 0, 0, 600, 0)
    expect(ids(trackStep(a.profile, a.tracker, a.world, [], NOW))).toEqual([])
    placeBody(a.world, 1, 500, 0, 900, 0)
    expect(ids(trackStep(a.profile, a.tracker, a.world, [], NOW))).toEqual([])
    placeBody(a.world, 0, 0, 0, 360, 481)
    expect(ids(trackStep(a.profile, a.tracker, a.world, [], NOW))).toEqual(["escape_velocity"])
  })

  it("gravity_assist: the player gets an assist event", () => {
    const a = setup()
    const assist = (bodyId: string): GameEvent => ({ type: "assist", bodyId, victimId: "bot-2" })
    expect(ids(trackStep(a.profile, a.tracker, a.world, [assist("bot-1")], NOW))).toEqual([])
    expect(ids(trackStep(a.profile, a.tracker, a.world, [assist("player")], NOW))).toEqual(["gravity_assist"])
  })

  it("event_horizon: the player activates the Singularity", () => {
    const a = setup()
    const start = (bodyId: string): GameEvent => ({ type: "ultStart", bodyId, x: 0, y: 0 })
    expect(ids(trackStep(a.profile, a.tracker, a.world, [start("bot-1")], NOW))).toEqual([])
    expect(ids(trackStep(a.profile, a.tracker, a.world, [start("player")], NOW))).toEqual(["event_horizon"])
  })

  it("hungry_void: absorbing while the player's Singularity is active (first_contact comes with it, in list order)", () => {
    const a = setup()
    expect(ids(trackStep(a.profile, a.tracker, a.world, [absorb()], NOW))).toEqual(["first_contact"])
    a.world.bodies[0].ultActive = 2
    expect(ids(trackStep(a.profile, a.tracker, a.world, [absorb()], NOW))).toEqual(["hungry_void"])
    const b = setup()
    b.world.bodies[0].ultActive = 2
    const got = ids(trackStep(b.profile, b.tracker, b.world, [absorb()], NOW))
    expect(got).toEqual(["first_contact", "hungry_void"])
  })

  it("comet_chaser: the player eats a comet (dust does not count, nor does a bot)", () => {
    const a = setup()
    expect(ids(trackStep(a.profile, a.tracker, a.world, [eat("dust"), eat("comet", "bot-1")], NOW))).toEqual([])
    expect(ids(trackStep(a.profile, a.tracker, a.world, [eat("comet")], NOW))).toEqual(["comet_chaser"])
  })

  it("power_hungry: every kind of power-up, lifetime (across rounds)", () => {
    const a = setup()
    const kinds: PowerUpKind[] = ["overdrive", "magnet", "phase", "bulk"]
    for (const k of kinds.slice(0, 3)) expect(ids(trackStep(a.profile, a.tracker, a.world, [pickup(k)], NOW))).toEqual([])
    expect(ids(trackStep(a.profile, a.tracker, a.world, [pickup("magnet")], NOW))).toEqual([])
    expect(ids(trackStep(a.profile, a.tracker, a.world, [pickup("bulk")], NOW))).toEqual(["power_hungry"])
    expect(a.profile.stats.pickupKinds).toEqual({ overdrive: true, magnet: true, phase: true, bulk: true })

    // A later round (fresh tracker) completes the set.
    const b = setup()
    b.profile.stats.pickupKinds = { overdrive: true, magnet: true, phase: true, bulk: false }
    expect(ids(trackStep(b.profile, b.tracker, b.world, [pickup("bulk")], NOW))).toEqual(["power_hungry"])
    // A bot's pickup does not count.
    const c = setup()
    c.profile.stats.pickupKinds = { overdrive: true, magnet: true, phase: true, bulk: false }
    expect(ids(trackStep(c.profile, c.tracker, c.world, [pickup("bulk", "bot-1")], NOW))).toEqual([])
  })

  it("hat_trick: three absorbs by the player in one round", () => {
    const a = setup()
    expect(ids(trackStep(a.profile, a.tracker, a.world, [absorb()], NOW))).toEqual(["first_contact"])
    expect(ids(trackStep(a.profile, a.tracker, a.world, [absorb("player", "bot-2")], NOW))).toEqual([])
    expect(ids(trackStep(a.profile, a.tracker, a.world, [absorb()], NOW))).toEqual(["hat_trick"])
    // A new round starts counting again.
    const b = setup()
    b.profile = a.profile
    expect(ids(trackStep(b.profile, b.tracker, b.world, [absorb(), absorb()], NOW + 1))).toEqual([])
  })

  it("hat_trick can complete inside one step's event list", () => {
    const a = setup()
    expect(ids(trackStep(a.profile, a.tracker, a.world, [absorb(), absorb(), absorb()], NOW))).toEqual(["first_contact", "hat_trick"])
  })

  describe("phase_diver", () => {
    function dive(opts: { phase: number; dieAt?: number; seconds?: number }) {
      const a = setup()
      const star = addWell(a.world, "star", 0, 0)
      placeBody(a.world, 0, 0, 0)
      a.world.bodies[0].power.phase = opts.phase
      a.world.time = 10
      const unlocked: { at: number; defs: string[] }[] = []
      const steps = Math.round((opts.seconds ?? 3) / DT)
      for (let i = 0; i < steps; i++) {
        a.world.time = 10 + i * DT
        if (opts.dieAt !== undefined && a.world.time - 10 >= opts.dieAt) a.world.bodies[0].alive = false
        const got = trackStep(a.profile, a.tracker, a.world, [], NOW)
        if (got.length) unlocked.push({ at: a.world.time - 10, defs: ids(got) })
      }
      return { a, star, unlocked }
    }

    it("unlocks after surviving 2 s inside a lethal well's kill distance with Phase active, not before", () => {
      const { unlocked } = dive({ phase: 20 })
      expect(unlocked).toHaveLength(1)
      expect(unlocked[0].defs).toEqual(["phase_diver"])
      expect(unlocked[0].at).toBeGreaterThanOrEqual(2 - 2 * DT)
      expect(unlocked[0].at).toBeLessThanOrEqual(2.5)
    })

    it("does not unlock without Phase", () => {
      expect(dive({ phase: 0 }).unlocked).toEqual([])
    })

    it("does not unlock if the player is dead before the 2 s are up", () => {
      expect(dive({ phase: 20, dieAt: 1 }).unlocked).toEqual([])
    })

    it("does not unlock when merely near the well (outside its kill distance)", () => {
      const a = setup()
      const star = addWell(a.world, "star", 0, 0)
      a.world.bodies[0].power.phase = 20
      placeBody(a.world, 0, star.radius + a.world.bodies[0].radius + 200, 0)
      for (let i = 0; i < 240; i++) {
        a.world.time = 10 + i * DT
        expect(trackStep(a.profile, a.tracker, a.world, [], NOW)).toEqual([])
      }
    })
  })

  describe("sunburn", () => {
    function flareScene(distanceFromEdge: number, stage: "active" | "warning", alive = true) {
      const a = setup()
      const star = addWell(a.world, "star", 0, 0)
      const flareR = star.radius * CONFIG.cosmic.solarFlare.radiusMul
      const ev: CosmicEvent = {
        id: 1,
        kind: "solarFlare",
        stage,
        t: 0,
        warning: CONFIG.cosmic.solarFlare.warning,
        duration: CONFIG.cosmic.solarFlare.duration,
        x: star.x,
        y: star.y,
        r: flareR,
        targetId: star.id,
      }
      a.world.cosmic = ev
      placeBody(a.world, 0, flareR + distanceFromEdge, 0)
      a.world.bodies[0].alive = alive
      const unlocked: string[] = []
      const total = Math.round((CONFIG.cosmic.solarFlare.duration + 0.5) / DT)
      for (let i = 0; i < total; i++) {
        a.world.time = 20 + i * DT
        ev.t = i * DT
        unlocked.push(...ids(trackStep(a.profile, a.tracker, a.world, [], NOW)))
      }
      // The flare ends: the world has no event any more and the step's events carry the "end" notice
      // (the shell feeds every step's events, so this is what a real round delivers).
      a.world.cosmic = null
      const endEvent: GameEvent = { type: "cosmic", kind: "solarFlare", stage: "end", x: star.x, y: star.y, r: flareR, targetId: star.id }
      unlocked.push(...ids(trackStep(a.profile, a.tracker, a.world, [endEvent], NOW)))
      return unlocked
    }

    it("surviving within 150 u of an active flare's edge unlocks it", () => {
      expect(flareScene(100, "active")).toEqual(["sunburn"])
    })

    it("does not unlock far from the flare, during the warning only, or when dead", () => {
      expect(flareScene(400, "active")).toEqual([])
      expect(flareScene(100, "warning")).toEqual([])
      expect(flareScene(100, "active", false)).toEqual([])
    })
  })

  it("never unlocks the same id twice and keeps the first timestamp", () => {
    const a = setup()
    expect(ids(trackStep(a.profile, a.tracker, a.world, [absorb()], NOW))).toEqual(["first_contact"])
    expect(ids(trackStep(a.profile, a.tracker, a.world, [absorb()], NOW + 5))).toEqual([])
    expect(a.profile.achievements.first_contact).toBe(NOW)
  })

  it("returns newly unlocked defs in ACHIEVEMENTS order, as full defs", () => {
    const a = setup()
    a.world.bodies[0].ultActive = 2
    placeBody(a.world, 0, 0, 0, 700, 0)
    const got = trackStep(
      a.profile,
      a.tracker,
      a.world,
      [eat("comet"), absorb(), { type: "ultStart", bodyId: "player", x: 0, y: 0 }, { type: "slingshot", bodyId: "player", speed: 500, x: 0, y: 0 }],
      NOW,
    )
    expect(ids(got)).toEqual(["first_contact", "slingshot", "escape_velocity", "event_horizon", "hungry_void", "comet_chaser"])
    const idx = ids(got).map(order)
    expect(idx).toEqual([...idx].sort((x, y) => x - y))
    expect(got[0]).toEqual(ACHIEVEMENTS[0])
    for (const d of got) expect(a.profile.achievements[d.id]).toBe(NOW)
  })

  it("win and round-count achievements never unlock mid-round", () => {
    const a = setup()
    a.profile.stats.rounds = 100
    a.profile.stats.arenaRounds = { classic: 5, binary: 5, maw: 5, nebula: 5, belt: 5, vast: 5 }
    a.profile.stats.arenaWins = { classic: 5, binary: 5, maw: 5, nebula: 5, belt: 5, vast: 5 }
    a.profile.stats.winsByDifficulty = { easy: 5, normal: 5, hard: 5 }
    const got = trackStep(a.profile, a.tracker, a.world, [], NOW)
    expect(got).toEqual([])
    for (const id of ["cadet", "pilot", "ace", "critical", "last_light", "grazer", "hands_off", "cartographer", "conqueror", "veteran"]) {
      expect(a.profile.achievements[id], id).toBeUndefined()
    }
  })

  it("records that the player pulled, for hands_off", () => {
    const a = setup()
    a.world.bodies[0].pulling = true
    trackStep(a.profile, a.tracker, a.world, [], NOW)
    expect(a.tracker.pulled).toBe(true)
    const b = setup()
    b.world.bodies[1].pulling = true
    trackStep(b.profile, b.tracker, b.world, [], NOW)
    expect(b.tracker.pulled).toBe(false)
  })

  it("does not change round-level counters", () => {
    const a = setup()
    trackStep(a.profile, a.tracker, a.world, [absorb(), eat("comet")], NOW)
    expect(a.profile.stats.rounds).toBe(0)
    expect(a.profile.stats.wins).toBe(0)
    expect(a.profile.stats.timePlayed).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("finishRound: round-end achievements", () => {
  function finish(opts: {
    difficulty?: Difficulty
    arena?: ArenaId
    won: boolean
    reason?: RoundEndReason
    profile?: Profile
    tracker?: RoundTracker
    absorbed?: number
    pulled?: boolean
  }) {
    const a = setup({ difficulty: opts.difficulty, arena: opts.arena })
    const profile = opts.profile ?? a.profile
    const tracker = opts.tracker ?? a.tracker
    a.world.bodies[0].stats.rivalsAbsorbed = opts.absorbed ?? 0
    tracker.absorbs = opts.absorbed ?? 0
    tracker.pulled = opts.pulled ?? false
    const defs = finishRound(profile, tracker, a.world, result(a.world, opts.reason ?? "timeUp", opts.won), NOW)
    return { defs: ids(defs), profile, world: a.world }
  }

  it("cadet / pilot / ace: a win on Easy / Normal / Hard", () => {
    expect(finish({ difficulty: "easy", won: true, absorbed: 1, pulled: true }).defs).toEqual(["cadet"])
    expect(finish({ difficulty: "normal", won: true, absorbed: 1, pulled: true }).defs).toEqual(["pilot"])
    expect(finish({ difficulty: "hard", won: true, absorbed: 1, pulled: true }).defs).toEqual(["ace"])
  })

  it("a loss unlocks none of the win achievements", () => {
    const r = finish({ difficulty: "easy", won: false, reason: "playerDied" })
    expect(r.defs).toEqual([])
    expect(r.profile.stats.wins).toBe(0)
  })

  it("critical: win by criticalMass; last_light: win as last body standing; a timeUp win is neither", () => {
    expect(finish({ won: true, reason: "criticalMass", absorbed: 1, pulled: true }).defs).toEqual(["pilot", "critical"])
    expect(finish({ won: true, reason: "lastStanding", absorbed: 1, pulled: true }).defs).toEqual(["pilot", "last_light"])
    expect(finish({ won: true, reason: "timeUp", absorbed: 1, pulled: true }).defs).toEqual(["pilot"])
    expect(finish({ won: false, reason: "criticalMass", absorbed: 1, pulled: true }).defs).toEqual([])
  })

  it("grazer: a win without absorbing a rival", () => {
    expect(finish({ won: true, absorbed: 0, pulled: true }).defs).toEqual(["pilot", "grazer"])
    expect(finish({ won: true, absorbed: 1, pulled: true }).defs).not.toContain("grazer")
  })

  it("hands_off: a win without ever pulling", () => {
    expect(finish({ won: true, absorbed: 1, pulled: false }).defs).toEqual(["pilot", "hands_off"])
    expect(finish({ won: true, absorbed: 1, pulled: true }).defs).not.toContain("hands_off")
  })

  it("all the win achievements at once come back in list order", () => {
    const r = finish({ difficulty: "hard", won: true, reason: "criticalMass", absorbed: 0, pulled: false })
    expect(r.defs).toEqual(["ace", "critical", "grazer", "hands_off"])
    const idx = r.defs.map(order)
    expect(idx).toEqual([...idx].sort((x, y) => x - y))
  })

  it("cartographer: a round in every arena (lifetime); only the last missing arena completes it", () => {
    const profile = emptyProfile()
    const played: ArenaId[] = ["classic", "binary", "maw", "nebula", "belt"]
    for (const arena of played) {
      expect(finish({ arena, won: false, profile }).defs, arena).not.toContain("cartographer")
    }
    expect(finish({ arena: "classic", won: false, profile }).defs).not.toContain("cartographer")
    expect(finish({ arena: "vast", won: false, profile }).defs).toContain("cartographer")
    expect(finish({ arena: "vast", won: false, profile }).defs).not.toContain("cartographer")
  })

  it("conqueror: a win in every arena (losses do not count)", () => {
    const profile = emptyProfile()
    for (const arena of ["classic", "binary", "maw", "nebula", "belt"] as ArenaId[]) {
      expect(finish({ arena, won: true, profile, absorbed: 1, pulled: true }).defs, arena).not.toContain("conqueror")
    }
    expect(finish({ arena: "vast", won: false, profile }).defs).not.toContain("conqueror")
    expect(finish({ arena: "vast", won: true, profile, absorbed: 1, pulled: true }).defs).toContain("conqueror")
  })

  it("veteran: the 25th round", () => {
    const profile = emptyProfile()
    profile.stats.rounds = 23
    expect(finish({ won: false, profile }).defs).not.toContain("veteran")
    expect(profile.stats.rounds).toBe(24)
    expect(finish({ won: false, profile }).defs).toContain("veteran")
    expect(profile.stats.rounds).toBe(25)
    expect(finish({ won: false, profile }).defs).not.toContain("veteran")
  })

  it("never re-unlocks and keeps the first timestamp", () => {
    const profile = emptyProfile()
    finish({ difficulty: "easy", won: true, profile, absorbed: 1, pulled: true })
    expect(profile.achievements.cadet).toBe(NOW)
    const again = ids(finishRound(profile, newTracker(), setup({ difficulty: "easy" }).world, { ...result(setup().world, "timeUp", true) }, NOW + 99))
    expect(again).not.toContain("cadet")
    expect(profile.achievements.cadet).toBe(NOW)
  })

  it("folds the round into the lifetime stats", () => {
    const profile = emptyProfile()
    const a = setup({ difficulty: "hard", arena: "belt" })
    const s = a.world.bodies[0].stats
    s.debrisEaten = 40
    s.rivalsAbsorbed = 2
    s.comets = 2
    s.slingshots = 3
    s.oberths = 2
    s.dashes = 5
    s.repulses = 4
    s.ults = 1
    s.assists = 2
    s.pickups = 6
    s.peakMass = 77
    s.topSpeed = 555
    a.tracker.absorbs = 2
    finishRound(profile, a.tracker, a.world, result(a.world, "timeUp", true, 120.5), NOW)
    expect(profile.stats).toMatchObject({
      rounds: 1,
      wins: 1,
      absorbs: 2,
      debris: 40,
      comets: 2,
      slingshots: 3,
      oberths: 2,
      dashes: 5,
      repulses: 4,
      ults: 1,
      assists: 2,
      pickups: 6,
      bestMass: 77,
      topSpeed: 555,
    })
    expect(profile.stats.timePlayed).toBeCloseTo(120.5, 9)
    expect(profile.stats.winsByDifficulty).toEqual({ easy: 0, normal: 0, hard: 1 })
    expect(profile.stats.arenaRounds).toEqual({ classic: 0, binary: 0, maw: 0, nebula: 0, belt: 1, vast: 0 })
    expect(profile.stats.arenaWins).toEqual({ classic: 0, binary: 0, maw: 0, nebula: 0, belt: 1, vast: 0 })

    // A second, lost round on another arena: counters add, bests keep their maximum.
    const b = setup({ difficulty: "easy", arena: "maw" })
    b.world.bodies[0].stats.peakMass = 30
    b.world.bodies[0].stats.topSpeed = 700
    b.world.bodies[0].stats.dashes = 1
    finishRound(profile, b.tracker, b.world, result(b.world, "playerDied", false, 30), NOW + 1)
    expect(profile.stats.rounds).toBe(2)
    expect(profile.stats.wins).toBe(1)
    expect(profile.stats.dashes).toBe(6)
    expect(profile.stats.bestMass).toBe(77)
    expect(profile.stats.topSpeed).toBe(700)
    expect(profile.stats.timePlayed).toBeCloseTo(150.5, 9)
    expect(profile.stats.arenaRounds.maw).toBe(1)
    expect(profile.stats.arenaWins.maw).toBe(0)
    expect(profile.stats.winsByDifficulty.easy).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe("loadProfile / saveProfile", () => {
  const store = (initial: string | null = null) => {
    let value = initial
    return {
      getItem: (k: string) => (k === PROFILE_KEY ? value : "WRONG KEY"),
      setItem: (k: string, v: string) => {
        if (k === PROFILE_KEY) value = v
      },
      read: () => value,
    }
  }

  it("uses the documented storage key", () => {
    expect(PROFILE_KEY).toBe("gw:profile:v1")
  })

  it("null storage, missing data, a throwing storage, corrupt JSON all give an empty profile", () => {
    expect(loadProfile(null)).toEqual(emptyProfile())
    expect(loadProfile(store(null))).toEqual(emptyProfile())
    expect(loadProfile({ getItem: () => { throw new Error("denied") } })).toEqual(emptyProfile())
    expect(loadProfile(store("{not json"))).toEqual(emptyProfile())
    expect(loadProfile(store(""))).toEqual(emptyProfile())
    expect(loadProfile(store("42"))).toEqual(emptyProfile())
    expect(loadProfile(store("null"))).toEqual(emptyProfile())
    expect(loadProfile(store("[1,2,3]"))).toEqual(emptyProfile())
  })

  it("a wrong version never throws and yields a well-formed version-1 profile", () => {
    const p = loadProfile(store(JSON.stringify({ version: 2, stats: { rounds: 5 }, achievements: { ace: 1 } })))
    expect(p.version).toBe(1)
    for (const v of Object.values(p.stats)) {
      if (typeof v === "number") expect(Number.isFinite(v)).toBe(true)
    }
    expect(typeof p.achievements).toBe("object")
  })

  it("keeps the valid fields of a partial profile and fills the rest with defaults", () => {
    const raw = { version: 1, stats: { rounds: 7, wins: 3, bestMass: 88 }, achievements: { ace: 123, cadet: 456 } }
    const p = loadProfile(store(JSON.stringify(raw)))
    expect(p.stats.rounds).toBe(7)
    expect(p.stats.wins).toBe(3)
    expect(p.stats.bestMass).toBe(88)
    expect(p.stats.debris).toBe(0)
    expect(p.stats.winsByDifficulty).toEqual({ easy: 0, normal: 0, hard: 0 })
    expect(p.stats.pickupKinds).toEqual({ overdrive: false, magnet: false, phase: false, bulk: false })
    expect(p.achievements).toEqual({ ace: 123, cadet: 456 })
  })

  it("ignores fields of the wrong type", () => {
    const raw = { version: 1, stats: { rounds: "lots", wins: null, absorbs: 4 }, achievements: { ace: "yesterday", cadet: 9 } }
    const p = loadProfile(store(JSON.stringify(raw)))
    expect(p.stats.rounds).toBe(0)
    expect(p.stats.wins).toBe(0)
    expect(p.stats.absorbs).toBe(4)
    expect(p.achievements.cadet).toBe(9)
    expect(p.achievements.ace).toBeUndefined()
  })

  it("saveProfile writes JSON under the key and load round-trips it", () => {
    const profile = emptyProfile()
    profile.stats.rounds = 12
    profile.stats.arenaWins.maw = 2
    profile.stats.pickupKinds.phase = true
    profile.stats.timePlayed = 987.5
    profile.achievements = { ace: NOW, veteran: NOW + 5 }
    const s = store()
    saveProfile(s, profile)
    expect(s.read()).not.toBeNull()
    expect(JSON.parse(s.read()!).version).toBe(1)
    expect(loadProfile(s)).toEqual(profile)
  })

  it("saveProfile never throws (null storage, throwing setItem)", () => {
    expect(() => saveProfile(null, emptyProfile())).not.toThrow()
    expect(() =>
      saveProfile(
        {
          setItem: () => {
            throw new Error("quota")
          },
        },
        emptyProfile(),
      ),
    ).not.toThrow()
  })
})
