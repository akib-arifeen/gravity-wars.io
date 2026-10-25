// Boss encounters: encounter construction, the telegraph/attack state machine, the Leviathan's
// split and the Twin Pulsars set piece. No DOM: a World plus the pure boss module.

import { describe, expect, it, vi } from "vitest"
import {
  BOSS_SPECS,
  applyCampaignLevel,
  bossAnnouncement,
  bossDefeated,
  bossHud,
  bossIntent,
  bossPhaseText,
  damageBoss,
  repulseDamageAgainst,
  updateBoss,
  type BossHud,
  type BossState,
  type EncounterState,
} from "../boss"
import { botIntent, createBotBrain } from "../bots"
import { CAMPAIGN_LEVELS, levelById } from "../campaign"
import { CONFIG } from "../config"
import { createWorld, step } from "../engine"
import type { Body, Intent, World } from "../types"

// The set pieces below simulate several minutes of fixed steps. They are not slow on their own, but
// a loaded machine can push one past the 5 s default, so this file asks for a realistic ceiling
// instead of the global default being raised for every quick test.
vi.setConfig({ testTimeout: 30000 })

const DT = CONFIG.dt

function level(id: string) {
  const l = levelById(id)
  if (!l) throw new Error(`missing level ${id}`)
  return l
}

/** A real arena with wells, a playing phase, and the level applied. */
function encounterWorld(id: string): { world: World; encounter: EncounterState; boss: BossState; bossBody: Body } {
  const l = level(id)
  const world = createWorld({ seed: l.seed, difficulty: l.difficulty, arena: l.arena, botCount: l.bots })
  world.phase = "playing"
  world.countdown = 0
  const encounter = applyCampaignLevel(world, l)!
  const boss = encounter.boss!
  const bossBody = world.bodies.find((b) => b.id === boss.id)!
  return { world, encounter, boss, bossBody }
}

function tickBoss(world: World, boss: BossState, n: number): void {
  for (let i = 0; i < n; i++) bossIntent(world, boss)
}

/** Call bossIntent until the phase changes, with a cap so a stuck machine fails loudly. */
function untilPhase(world: World, boss: BossState, phase: BossState["phase"], max = 1200): void {
  for (let i = 0; i < max; i++) {
    bossIntent(world, boss)
    if (boss.phase === phase) return
  }
  throw new Error(`boss never reached ${phase} (stuck in ${boss.phase})`)
}

/** Put the boss on the verge of its next special. */
function armSpecial(boss: BossState, special: "pull" | "ult" | "lunge"): void {
  boss.phase = "stalk"
  boss.special = null
  boss.t = 0
  boss.nextIn = 0
  boss.nextSpecial = special
}

describe("campaign encounters", () => {
  it("applies the level's time limit to every level, not just boss levels", () => {
    for (const l of CAMPAIGN_LEVELS) {
      const world = createWorld({ seed: l.seed, difficulty: l.difficulty, arena: l.arena, botCount: l.bots })
      applyCampaignLevel(world, l)
      expect(world.timeLeft).toBe(l.timeLimit)
    }
  })

  it("returns null for an ordinary level", () => {
    const world = createWorld({ seed: 1, difficulty: "easy" })
    expect(applyCampaignLevel(world, level("fall-1"))).toBeNull()
  })

  it("turns a bot into the boss, far from the player and clear of the arena's wells", () => {
    const { world, boss, bossBody } = encounterWorld("fall-4")
    expect(bossBody.id).toBe("boss")
    expect(bossBody.name).toBe(BOSS_SPECS.leviathan.name)
    expect(bossBody.mass).toBe(BOSS_SPECS.leviathan.mass)
    expect(bossBody.kind).toBe("bot")
    expect(bossBody.alive).toBe(true)
    expect(world.bodies.filter((b) => b.kind === "bot")).toHaveLength(1)
    expect(world.bodies.filter((b) => b.id === "boss")).toHaveLength(1)
    const player = world.bodies[0]
    expect(Math.hypot(bossBody.x - player.x, bossBody.y - player.y)).toBeGreaterThan(900)
    for (const w of world.wells) {
      const d = Math.hypot(bossBody.x - w.x, bossBody.y - w.y)
      expect(d).toBeGreaterThan(w.radius + 20)
    }
  })

  it("builds one boss per boss level, with the right kind", () => {
    const leviathan = encounterWorld("fall-4")
    expect(leviathan.boss.kind).toBe("leviathan")
    const voidKing = encounterWorld("fall-12")
    expect(voidKing.boss.kind).toBe("voidKing")
    expect(voidKing.boss.startingMass).toBe(BOSS_SPECS.voidKing.mass)
  })

  it("adds two pulsars with sweeping beams that cannot reach the spawn ring", () => {
    const l = level("fall-8")
    const world = createWorld({ seed: l.seed, difficulty: l.difficulty, arena: l.arena, botCount: l.bots })
    const before = world.wells.length
    const encounter = applyCampaignLevel(world, l)!
    expect(encounter.boss).toBeNull()
    expect(encounter.pulsars).toBe(2)
    expect(world.wells).toHaveLength(before + 2)
    for (const w of world.wells.filter((x) => x.id.startsWith("pulsar-twin"))) {
      expect(w.kind).toBe("pulsar")
      expect(w.lethal).toBe(true)
      expect(w.beam).not.toBeNull()
      expect(w.orbit).not.toBeNull()
      expect(w.orbit!.r + w.beam!.length).toBeLessThan(CONFIG.spawn.ringRadius + 40)
    }
  })

  it("is deterministic for a level", () => {
    const a = encounterWorld("fall-4")
    const b = encounterWorld("fall-4")
    expect(a.bossBody.x).toBe(b.bossBody.x)
    expect(a.world.wells.map((w) => `${w.id}:${w.x}`)).toEqual(b.world.wells.map((w) => `${w.id}:${w.x}`))
  })
})

describe("boss state machine", () => {
  it("sleeps through the opening, then waits out its grace period before the first telegraph", () => {
    const { world, boss } = encounterWorld("fall-4")
    const spec = BOSS_SPECS.leviathan
    expect(boss.phase).toBe("stalk")
    // Before the wake-up time the boss neither moves nor starts a special.
    for (let i = 0; i < 120; i++) {
      const intent = bossIntent(world, boss)
      expect(intent.ax).toBe(0)
      expect(intent.ay).toBe(0)
    }
    expect(boss.phase).toBe("stalk")
    world.time = spec.wakeAfter
    tickBoss(world, boss, Math.floor(spec.firstSpecialIn / DT) - 2)
    expect(boss.phase).toBe("stalk")
    tickBoss(world, boss, 6)
    expect(boss.phase).toBe("telegraph")
  })

  it("holds still during the telegraph and then pulls during the attack window", () => {
    const { world, boss } = encounterWorld("fall-4")
    world.time = BOSS_SPECS.leviathan.wakeAfter
    armSpecial(boss, "pull")
    expect(bossIntent(world, boss).pull).toBe(false)
    expect(boss.phase).toBe("telegraph")
    const warning = bossIntent(world, boss)
    expect(warning.ax).toBe(0)
    expect(warning.ay).toBe(0)
    expect(warning.pull).toBe(false)
    untilPhase(world, boss, "attack")
    expect(boss.phase).toBe("attack")
    const attack = bossIntent(world, boss)
    expect(attack.pull).toBe(true)
    expect(Math.hypot(attack.ax, attack.ay)).toBeGreaterThan(0)
    untilPhase(world, boss, "recover")
    expect(boss.phase).toBe("recover")
  })

  it("lunges with a single dash step on the alternate cycle", () => {
    const { world, boss } = encounterWorld("fall-4")
    world.time = BOSS_SPECS.leviathan.wakeAfter
    armSpecial(boss, "lunge")
    bossIntent(world, boss) // telegraph starts
    untilPhase(world, boss, "attack")
    const lunge = bossIntent(world, boss)
    expect(lunge.dash).toBe(true)
    expect(boss.phase).toBe("recover")
  })

  it("fires the Void King's collapse when the charge is ready", () => {
    const { world, boss, bossBody } = encounterWorld("fall-12")
    world.time = BOSS_SPECS.voidKing.wakeAfter
    bossBody.ult = 1
    armSpecial(boss, "ult")
    bossIntent(world, boss)
    expect(boss.special).toBe("ult")
    untilPhase(world, boss, "attack")
    const fire = bossIntent(world, boss)
    expect(fire.ult).toBe(true)
  })

  it("arms its own collapse when nothing has charged it", () => {
    const { world, boss, bossBody } = encounterWorld("fall-12")
    world.time = BOSS_SPECS.voidKing.wakeAfter
    bossBody.ult = 0
    armSpecial(boss, "ult")
    bossIntent(world, boss)
    expect(boss.special).toBe("ult")
    untilPhase(world, boss, "attack")
    const fire = bossIntent(world, boss)
    expect(fire.ult).toBe(true)
  })

  it("alternates between its specials", () => {
    const { world, boss } = encounterWorld("fall-4")
    world.time = BOSS_SPECS.leviathan.wakeAfter
    armSpecial(boss, "pull")
    bossIntent(world, boss)
    expect(boss.special).toBe("pull")
    boss.nextIn = 0
    boss.phase = "stalk"
    boss.t = 0
    bossIntent(world, boss)
    expect(boss.special).toBe("lunge")
  })

  it("stops driving a defeated boss", () => {
    const { world, boss, bossBody } = encounterWorld("fall-4")
    bossBody.alive = false
    const intent = bossIntent(world, boss)
    expect(boss.defeated).toBe(true)
    expect(intent.ax).toBe(0)
    expect(intent.ay).toBe(0)
    expect(intent.pull).toBe(false)
  })
})

// The Void King is the only other body in its arena, so nothing ever feeds it the charge its
// collapse needs. This plays the real level forward with the game's own hard brain flying the
// player: movement only, no repulses, no ultimates, so the boss is never damaged or fed and its
// ladder is the only thing under test.
describe("the Void King's signature ladder", () => {
  /** Play level 12 forward; report the specials it telegraphed, whether its collapse actually ran
   *  (the ult meter spent into an active ultimate, not just a relabelled telegraph), and how the
   *  boss itself ended. */
  function ladder(seconds: number): {
    specials: string[]
    collapseRan: boolean
    played: number
    deathCause: string
    bossAlive: boolean
  } {
    const l = level("fall-12")
    const world = createWorld({ seed: l.seed, difficulty: l.difficulty, arena: l.arena, botCount: l.bots })
    world.phase = "playing"
    world.countdown = 0
    const encounter = applyCampaignLevel(world, l)!
    const boss = encounter.boss!
    const brain = createBotBrain("player", "hard", l.seed + 97)
    const specials: string[] = []
    let collapseRan = false
    let deathCause = ""
    let lastPhase = boss.phase
    const intents = new Map<string, Intent>()
    for (let i = 0; i < Math.ceil(seconds / DT) && world.phase === "playing"; i++) {
      const me = world.bodies[0]
      const bossBody = world.bodies.find((b) => b.id === boss.id)
      intents.clear()
      if (me.alive) {
        const fly = botIntent(world, brain)
        intents.set(me.id, { ax: fly.ax, ay: fly.ay, pull: false })
      }
      if (bossBody && !boss.defeated) intents.set(boss.id, bossIntent(world, boss))
      step(world, intents)
      updateBoss(world, encounter)
      const body = world.bodies.find((b) => b.id === boss.id)
      if (boss.phase === "telegraph" && lastPhase !== "telegraph") specials.push(boss.special ?? "none")
      if (body && body.ultActive > 0) collapseRan = true
      for (const ev of world.events) if (ev.type === "death" && ev.bodyId === boss.id) deathCause = String(ev.cause.by)
      lastPhase = boss.phase
    }
    return {
      specials,
      collapseRan,
      played: world.time,
      deathCause,
      bossAlive: world.bodies.find((b) => b.id === boss.id)?.alive ?? false,
    }
  }

  it("reaches its collapse unaided, then keeps climbing the ladder", () => {
    const { specials, collapseRan, played } = ladder(70)
    // Guard: the encounter stayed live past the first two specials, so a short ladder below is a
    // boss failure and not a pilot death.
    expect(played).toBeGreaterThan(40)
    // Nothing in the arena can charge the boss; it must still reach its signature special.
    expect(specials).toContain("ult")
    // And the engine must actually run it, not merely relabel a lunge.
    expect(collapseRan).toBe(true)
    // The ladder advances past the collapse instead of one move repeating forever.
    const firstCollapse = specials.indexOf("ult")
    expect(specials.slice(firstCollapse + 1)).toContain("lunge")
  })

  it("holds position while its collapse drags the player in", () => {
    const { world, boss, bossBody } = encounterWorld("fall-12")
    const player = world.bodies[0]
    // Put both bodies on the same orbit in clear space: the maw's gravity then acts along the
    // radius, so the axis between them carries only what the boss does.
    let angle = 0
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 32) {
      const bx = Math.cos(a) * 1200
      const by = Math.sin(a) * 1200
      const px = bx - Math.sin(a) * 420
      const py = by + Math.cos(a) * 420
      if (world.wells.every((w) => Math.hypot(w.x - bx, w.y - by) > 420 && Math.hypot(w.x - px, w.y - py) > 420)) {
        angle = a
        break
      }
    }
    bossBody.x = Math.cos(angle) * 1200
    bossBody.y = Math.sin(angle) * 1200
    bossBody.vx = 0
    bossBody.vy = 0
    const px = bossBody.x - Math.sin(angle) * 420
    const py = bossBody.y + Math.cos(angle) * 420
    player.x = px
    player.y = py
    player.vx = 0
    player.vy = 0
    world.time = BOSS_SPECS.voidKing.wakeAfter
    armSpecial(boss, "ult")
    const intents = new Map<string, Intent>()
    intents.set(player.id, { ax: 0, ay: 0, pull: false })
    // Telegraph, then measure the first second of the channel.
    for (let i = 0; i < 200 && boss.phase !== "attack" && world.phase === "playing"; i++) {
      intents.set(boss.id, bossIntent(world, boss))
      step(world, intents)
    }
    expect(boss.phase).toBe("attack")
    expect(player.alive).toBe(true)
    const axis = Math.hypot(player.x - bossBody.x, player.y - bossBody.y)
    const ux = (player.x - bossBody.x) / axis
    const uy = (player.y - bossBody.y) / axis
    const bossFrom = { x: bossBody.x, y: bossBody.y }
    for (let i = 0; i < Math.round(1 / DT) && world.phase === "playing"; i++) {
      intents.set(boss.id, bossIntent(world, boss))
      step(world, intents)
    }
    expect(bossBody.ultActive).toBeGreaterThan(0)
    expect(bossBody.pulling).toBe(true)
    const bossAlong = (bossBody.x - bossFrom.x) * ux + (bossBody.y - bossFrom.y) * uy
    const playerAlong = (player.x - px) * ux + (player.y - py) * uy
    // The boss channels: no thrust along the line to the player.
    expect(Math.abs(bossAlong)).toBeLessThan(12)
    // The collapse still bites: the player is dragged toward the boss.
    expect(playerAlong).toBeLessThan(-30)
  })

  it("channels its collapse instead of flying itself into the maw", () => {
    const { specials, played, deathCause, bossAlive } = ladder(70)
    // The maw's black hole stays lethal, and nothing here steers the boss into it.
    expect(deathCause).not.toBe("blackhole")
    expect(bossAlive).toBe(true)
    // Losing the boss to its own attack is what ended the encounter above, so the ladder has to
    // keep going for the full window here.
    expect(played).toBeGreaterThan(69)
    // The signature still alternates after the second collapse: the fix must not trade one
    // unreachable move for another.
    const secondCollapse = specials.indexOf("ult", specials.indexOf("ult") + 1)
    expect(secondCollapse).toBeGreaterThan(0)
    expect(specials.slice(secondCollapse + 1)).toContain("lunge")
  })
})

describe("the Leviathan splits", () => {
  it("splits once when wounded, shrinking the core and adding fragments", () => {
    const { world, encounter, boss, bossBody } = encounterWorld("fall-4")
    bossBody.mass = boss.startingMass * 0.59
    const before = world.bodies.length
    const events = updateBoss(world, encounter)
    expect(events).toEqual([{ type: "split", fragments: 2 }])
    expect(world.bodies).toHaveLength(before + 2)
    expect(boss.splitDone).toBe(true)
    expect(bossBody.mass).toBeLessThan(boss.startingMass * 0.3)
    const fragments = world.bodies.filter((b) => b.id.startsWith("boss-frag"))
    expect(fragments).toHaveLength(2)
    for (const f of fragments) {
      expect(f.kind).toBe("bot")
      expect(f.alive).toBe(true)
      expect(f.mass).toBeGreaterThan(0)
      expect(f.name).toContain("fragment")
    }
    // The fragments spawn inside the arena.
    for (const f of fragments) expect(Math.hypot(f.x, f.y)).toBeLessThan(world.arenaRadius)
    expect(updateBoss(world, encounter)).toEqual([])
  })

  it("does not split the Void King", () => {
    const { world, encounter, bossBody } = encounterWorld("fall-12")
    bossBody.mass = 10
    expect(updateBoss(world, encounter)).toEqual([])
  })
})

describe("boss balance rules", () => {
  it("caps its growth so it stays a reachable meal", () => {
    const { world, encounter, boss, bossBody } = encounterWorld("fall-4")
    bossBody.mass = boss.startingMass * 3
    updateBoss(world, encounter)
    expect(bossBody.mass).toBeCloseTo(boss.startingMass * BOSS_SPECS.leviathan.growthCap, 5)
    expect(bossBody.radius).toBeCloseTo(4 * Math.sqrt(bossBody.mass), 5)
  })

  it("takes repulse damage down to the split threshold, then to the post-split floor", () => {
    const { world, encounter, boss, bossBody } = encounterWorld("fall-4")
    const hit = repulseDamageAgainst(boss)
    expect(hit).toBeGreaterThan(0)
    const before = bossBody.mass
    const lost = damageBoss(world, encounter, hit)
    expect(lost).toBeCloseTo(hit, 5)
    expect(bossBody.mass).toBeCloseTo(before - hit, 5)
    // Pre-split the boss cannot be chipped below 60% of its starting mass.
    for (let i = 0; i < 20; i++) damageBoss(world, encounter, hit)
    expect(bossBody.mass).toBeCloseTo(boss.startingMass * 0.6, 5)
    // Splitting happens on the next maintenance pass.
    updateBoss(world, encounter)
    expect(boss.splitDone).toBe(true)
    // The split leaves the core below the post-split floor, so a repulse cannot take more from it
    // and must not push it back up.
    const core = bossBody.mass
    expect(core).toBeLessThan(boss.startingMass * 0.25)
    for (let i = 0; i < 20; i++) expect(damageBoss(world, encounter, hit)).toBe(0)
    expect(bossBody.mass).toBe(core)
    // Above the floor the core is chipped down to a quarter of the starting mass.
    bossBody.mass = boss.startingMass * 0.5
    for (let i = 0; i < 20; i++) damageBoss(world, encounter, hit)
    expect(bossBody.mass).toBeCloseTo(boss.startingMass * 0.25, 5)
  })

  it("never heals the split core with a post-split hit", () => {
    const { world, encounter, boss, bossBody } = encounterWorld("fall-4")
    const hit = repulseDamageAgainst(boss)
    for (let i = 0; i < 20; i++) damageBoss(world, encounter, hit)
    updateBoss(world, encounter)
    expect(boss.splitDone).toBe(true)
    const core = bossBody.mass
    const taken = boss.damageTaken
    for (let i = 0; i < 5; i++) {
      const lost = damageBoss(world, encounter, hit)
      expect(lost).toBeGreaterThanOrEqual(0)
      expect(lost).toBe(0)
      expect(bossBody.mass).toBe(core)
      expect(boss.damageTaken).toBe(taken)
    }
    // Above the floor the core takes damage again.
    bossBody.mass = boss.startingMass * 0.5
    expect(damageBoss(world, encounter, hit)).toBeCloseTo(hit, 5)
    expect(bossBody.mass).toBeCloseTo(boss.startingMass * 0.5 - hit, 5)
  })

  it("conserves mass when the Leviathan splits", () => {
    const { world, encounter, boss, bossBody } = encounterWorld("fall-4")
    const hit = repulseDamageAgainst(boss)
    for (let i = 0; i < 20; i++) damageBoss(world, encounter, hit)
    const beforeSplit = bossBody.mass
    updateBoss(world, encounter)
    expect(boss.splitDone).toBe(true)
    const fragments = world.bodies.filter((b) => b.id.startsWith("boss-frag"))
    expect(fragments).toHaveLength(2)
    // The core gives the fragments exactly what it loses; nothing is created.
    const total = fragments.reduce((sum, f) => sum + f.mass, bossBody.mass)
    expect(total).toBeCloseTo(beforeSplit, 5)
    // The only floor is the normal body minimum.
    expect(bossBody.mass).toBeGreaterThanOrEqual(CONFIG.body.startMass)
    for (const f of fragments) expect(f.mass).toBeGreaterThanOrEqual(CONFIG.body.startMass)
  })

  it("ignores damage when there is no encounter", () => {
    const { world } = encounterWorld("fall-4")
    expect(damageBoss(world, null, 10)).toBe(0)
  })
})

describe("boss HUD and defeat", () => {
  it("reports health, phase and the special", () => {
    const { world, boss, bossBody } = encounterWorld("fall-4")
    let hud = bossHud(world, boss)!
    expect(hud.name).toBe(BOSS_SPECS.leviathan.name)
    expect(hud.healthPct).toBeCloseTo(1, 5)
    expect(hud.phase).toBe("stalk")
    expect(hud.special).toBeNull()
    bossBody.mass = boss.startingMass * 0.5
    hud = bossHud(world, boss)!
    expect(hud.healthPct).toBeCloseTo(0.5, 5)
    expect(hud.mass).toBe(bossBody.mass)
  })

  it("reports a dead boss and detects defeat", () => {
    const { world, encounter, boss, bossBody } = encounterWorld("fall-4")
    bossBody.alive = false
    expect(bossHud(world, boss)).toBeNull()
    expect(updateBoss(world, encounter)).toEqual([{ type: "defeated" }])
    expect(bossDefeated(world, encounter)).toBe(true)
    expect(bossDefeated(world, null)).toBe(false)
  })
})

describe("boss HUD text and announcements", () => {
  function hud(over: Partial<BossHud> = {}): BossHud {
    return {
      name: BOSS_SPECS.leviathan.name,
      kind: "leviathan",
      healthPct: 1,
      mass: BOSS_SPECS.leviathan.mass,
      phase: "stalk",
      special: null,
      t: 0,
      total: 1,
      splitDone: false,
      ...over,
    }
  }

  it("names the visible phase for every state", () => {
    expect(bossPhaseText(hud())).toBe("HUNTING")
    expect(bossPhaseText(hud({ phase: "telegraph", special: "pull" }))).toBe("GRAVITY MAW INCOMING")
    expect(bossPhaseText(hud({ phase: "attack", special: "pull" }))).toBe("GRAVITY MAW ACTIVE")
    expect(bossPhaseText(hud({ phase: "attack", special: "ult" }))).toBe("COLLAPSE ACTIVE")
    expect(bossPhaseText(hud({ phase: "attack", special: "lunge" }))).toBe("LUNGE")
    expect(bossPhaseText(hud({ phase: "recover", splitDone: true }))).toBe("WOUNDED")
  })

  it("keeps the announcement stable while health, mass and timers update", () => {
    // The HUD publishes about four times a second; only a state change may change the text, or a
    // live region would read the fight aloud continuously.
    const texts = new Set<string>()
    for (let i = 0; i < 40; i++) {
      texts.add(bossAnnouncement(hud({ healthPct: 1 - i * 0.02, mass: 55 - i, t: i * 0.25 })))
    }
    expect(texts.size).toBe(1)
  })

  it("announces telegraphs, attacks and the wound once each", () => {
    expect(bossAnnouncement(hud())).toBe("The Leviathan is hunting you.")
    expect(bossAnnouncement(hud({ phase: "telegraph", special: "pull" }))).toBe(
      "The Leviathan: gravity maw incoming.",
    )
    expect(bossAnnouncement(hud({ phase: "attack", special: "pull" }))).toBe("The Leviathan: gravity maw active.")
    expect(bossAnnouncement(hud({ phase: "recover", splitDone: true }))).toBe("The Leviathan is wounded.")
    expect(bossAnnouncement(hud({ phase: "stalk", splitDone: true }))).toBe("The Leviathan is wounded.")
  })
})
