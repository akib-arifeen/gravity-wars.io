// The Vast: a deliberately much larger arena with a huge but low-density central star, a wide
// asteroid belt, outer remnant wells, four local zones, and navigation aids that keep the field
// readable. These tests pin the invariants that make the scale work rather than just look big.

import { describe, expect, it } from "vitest"
import { ARENAS, ARENA_IDS, placeWormholePair } from "../arenas"
import { botIntent, createBotBrain, type BotBrain } from "../bots"
import { CONFIG } from "../config"
import { createWorld, step } from "../engine"
import { arenaScale, cameraZoomScale, frameEdgeMarker, indicatorRange } from "../framing"
import type { Body, World } from "../types"
import { DT, snapshot } from "./helpers"

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1)
const V = CONFIG.vast
const CLASSIC_G = (d: number) => CONFIG.well.starGm / (d * d + CONFIG.well.soft * CONFIG.well.soft)
const VAST_G = (d: number) => V.starGm / (d * d + CONFIG.well.soft * CONFIG.well.soft)

function make(seed: number, difficulty: "easy" | "normal" | "hard" = "normal", botCount?: number, mode?: "round" | "endless"): World {
  const opts: Parameters<typeof createWorld>[0] = { seed, difficulty, arena: "vast", cosmic: false }
  if (botCount !== undefined) opts.botCount = botCount
  if (mode !== undefined) opts.mode = mode
  return createWorld(opts)
}

const ofKind = (w: World, kind: string) => w.wells.filter((x) => x.kind === kind)
const polar = (v: { x: number; y: number }) => Math.hypot(v.x, v.y)

function drive(world: World, brains: BotBrain[], seconds: number): Map<string, number> {
  const intents = new Map<string, ReturnType<typeof botIntent>>()
  const paths = new Map<string, number>()
  const prev = new Map<string, { x: number; y: number }>()
  for (const b of world.bodies) prev.set(b.id, { x: b.x, y: b.y })
  const steps = Math.round(seconds / DT)
  for (let i = 0; i < steps; i++) {
    intents.clear()
    for (const b of brains) intents.set(b.bodyId, botIntent(world, b))
    step(world, intents)
    for (const b of world.bodies) {
      const p = prev.get(b.id)!
      paths.set(b.id, (paths.get(b.id) ?? 0) + Math.hypot(b.x - p.x, b.y - p.y))
      p.x = b.x
      p.y = b.y
    }
    if (world.phase === "over") break
  }
  return paths
}

describe("vast: registry and scale", () => {
  it("is a sixth arena with a menu entry, and its playable area is more than five times classic's", () => {
    expect([...ARENA_IDS]).toEqual(["classic", "binary", "maw", "nebula", "belt", "vast"])
    expect(ARENAS.vast.name.length).toBeGreaterThan(0)
    expect(ARENAS.vast.blurb.length).toBeGreaterThan(0)
    const area = (r: number) => Math.PI * r * r
    expect(area(V.arenaRadius) / area(CONFIG.arena.radius)).toBeGreaterThan(5.5)
    expect(V.spawnRing / CONFIG.spawn.ringRadius).toBeGreaterThan(1.6)
  })

  it("builds the same world for one seed and a different one for another", () => {
    expect(snapshot(make(4))).toBe(snapshot(make(4)))
    expect(snapshot(make(4))).not.toBe(snapshot(make(5)))
  })
})

describe("vast: celestial bodies", () => {
  it("has one giant star at the centre, huge in radius but deliberately gentle in gravity", () => {
    for (const seed of SEEDS) {
      const w = make(seed)
      expect(w.arenaBase).toBe(V.arenaRadius)
      expect(w.arenaRadius).toBe(V.arenaRadius)
      const stars = ofKind(w, "star")
      expect(stars, `seed ${seed}`).toHaveLength(1)
      const s = stars[0]
      expect(polar(s), `seed ${seed}`).toBeLessThan(1e-9)
      expect(s.radius).toBe(V.starRadius)
      expect(s.radius).toBeGreaterThan(CONFIG.well.starRadius * 5)
      expect(s.gm).toBe(V.starGm)
      expect(s.chargeRadius).toBe(V.starChargeRadius)
      expect(s.lethal).toBe(true)
      // Bigger, but not a stronger pull: surface and spawn-ring gravity are both below classic.
      expect(VAST_G(s.radius)).toBeLessThan(CLASSIC_G(CONFIG.well.starRadius) * 0.2)
      expect(VAST_G(V.spawnRing)).toBeLessThan(CLASSIC_G(CONFIG.spawn.ringRadius) * 0.6)
    }
  })

  it("puts two solid planets in the belt and two compact remnants on the outer reach", () => {
    for (const seed of SEEDS) {
      const w = make(seed)
      const planets = ofKind(w, "planet")
      expect(planets, `seed ${seed}`).toHaveLength(2)
      expect(planets[0].orbit!.r).toBe(V.planetInnerOrbit)
      expect(planets[1].orbit!.r).toBe(V.planetOuterOrbit)
      for (const p of planets) {
        expect(p.lethal).toBe(false)
        expect(p.orbit).not.toBeNull()
      }
      expect(Math.sign(planets[0].orbit!.w)).toBe(1)
      expect(Math.sign(planets[1].orbit!.w)).toBe(-1)
      const remnants = ofKind(w, "whitedwarf")
      expect(remnants, `seed ${seed}`).toHaveLength(2)
      for (const r of remnants) {
        expect(polar(r)).toBeCloseTo(V.remnantOrbit, 9)
        expect(r.lethal).toBe(true)
        expect(r.orbit).toBeNull()
      }
      expect(remnants[0].x + remnants[1].x).toBeCloseTo(0, 9)
      expect(remnants[0].y + remnants[1].y).toBeCloseTo(0, 9)
    }
  })

  it("spawns bodies just outside the belt, clear of every lethal surface and charge band", () => {
    // Clusters sit on the ring tangent, so the furthest a body can drift from the ring is the
    // half-length of a full group.
    const halfGroup = V.spawnGroup.gap * ((V.spawnGroup.size - 1) / 2)
    const furthest = Math.hypot(V.spawnRing, halfGroup)
    for (const seed of SEEDS) {
      const w = make(seed)
      expect(w.bodies).toHaveLength(1 + CONFIG.difficulty.normal.bots)
      for (const b of w.bodies) {
        expect(polar(b), `seed ${seed} ${b.id}`).toBeGreaterThanOrEqual(V.spawnRing - 1)
        expect(polar(b), `seed ${seed} ${b.id}`).toBeLessThanOrEqual(furthest + 1)
        expect(polar(b)).toBeLessThan(w.arenaRadius - 1200)
        for (const well of w.wells) {
          if (!well.lethal) continue
          expect(Math.hypot(b.x - well.x, b.y - well.y), `${seed} ${b.id} vs ${well.id}`).toBeGreaterThan(
            well.radius + b.radius,
          )
        }
      }
      // A spawn ring that overlaps a charge band would force bodies to start inside the star's pull.
      expect(V.spawnRing - w.wells[0].chargeRadius).toBeGreaterThan(120)
    }
  })

  it("opens with rivals inside hunt range, without overlapping", () => {
    for (const seed of SEEDS) {
      const w = make(seed)
      const sense = arenaScale(w.arenaBase)
      const hunt = (500 + 400 * CONFIG.difficulty.normal.aggression) * sense
      for (const b of w.bodies) {
        let nearest = Infinity
        for (const other of w.bodies) {
          if (other === b) continue
          const d = Math.hypot(b.x - other.x, b.y - other.y)
          nearest = Math.min(nearest, d)
          expect(d, `seed ${seed} ${b.id} overlaps ${other.id}`).toBeGreaterThan(2 * (b.radius + other.radius))
        }
        // Evenly spread over this ring, the roster opened 1859 u apart — outside every hunt range.
        expect(nearest, `seed ${seed} ${b.id} nearest rival`).toBeLessThanOrEqual(V.spawnGroup.gap + 1)
        expect(nearest, `seed ${seed} ${b.id} nearest rival`).toBeLessThan(hunt)
      }
    }
  })

  it("keeps the wormhole pair inside the middle field and clear of the giant star on every re-placement", () => {
    for (const seed of SEEDS) {
      const w = make(seed)
      expect(w.wormholes.map((h) => h.id)).toEqual(["wh-a", "wh-b"])
      for (let k = 0; k < 4; k++) {
        if (k > 0) placeWormholePair(w)
        for (const wh of w.wormholes) {
          expect(polar(wh), `seed ${seed}`).toBeGreaterThanOrEqual(V.wormholeOrbit[0] - 1e-9)
          expect(polar(wh), `seed ${seed}`).toBeLessThanOrEqual(V.wormholeOrbit[1] + 1e-9)
          expect(polar(wh), `seed ${seed}`).toBeGreaterThan(ofKind(w, "star")[0].radius + 200)
        }
        expect(Math.hypot(w.wormholes[0].x - w.wormholes[1].x, w.wormholes[0].y - w.wormholes[1].y)).toBeGreaterThanOrEqual(
          CONFIG.wormhole.minSeparation - 1e-9,
        )
      }
    }
  })

  it("lays out one dust lane, one quantum anomaly and two repulsor fields, all clear of the spawn ring", () => {
    const seen = new Set<string>()
    for (const seed of SEEDS) {
      const w = make(seed)
      expect(w.zones.map((z) => z.id)).toEqual(["zone-1", "zone-2", "zone-3", "zone-4"])
      const kinds = w.zones.map((z) => z.kind).sort()
      expect(kinds).toEqual(["anomaly", "nebula", "repulsor", "repulsor"])
      for (const z of w.zones) {
        seen.add(z.kind)
        expect(Math.abs(polar(z)), `seed ${seed} ${z.id}`).toBeGreaterThan(0)
        // Zones may sit inside or outside the ring band, but never on top of a spawn point.
        expect(Math.abs(polar(z) - V.spawnRing), `seed ${seed} ${z.id} vs spawn ring`).toBeGreaterThan(z.r + 120)
        for (const well of w.wells) {
          expect(Math.hypot(z.x - well.x, z.y - well.y), `seed ${seed} ${z.id} vs ${well.id}`).toBeGreaterThan(
            z.r + Math.max(well.radius, well.chargeRadius) + 80 - 1e-6,
          )
        }
      }
      const nebula = w.zones.find((z) => z.kind === "nebula")!
      expect(nebula.r).toBe(V.dustLane.radius)
      expect(nebula.strength).toBe(V.dustLane.drag)
    }
    expect(seen.size).toBe(3)
  })
})

describe("vast: playable density and round pacing", () => {
  it("scales the debris budget with the arena so the belt is not empty", () => {
    const w = make(1)
    const dr = w.debris.filter((d) => d.kind !== "crystal")
    expect(dr).toHaveLength(Math.round(CONFIG.debris.target * V.debrisMul))
    expect(w.debris.filter((d) => d.kind === "crystal")).toHaveLength(
      Math.round(CONFIG.crystal.target * V.crystalMul),
    )
    const inRing = dr.filter((d) => {
      const r = polar(d)
      return r >= w.debrisField.ringInner && r <= w.debrisField.ringOuter
    }).length
    expect(inRing / dr.length).toBeGreaterThan(0.6)
  })

  it("gives the round more time than classic so the extra distance is not a trap", () => {
    expect(make(1).timeLeft).toBeCloseTo(CONFIG.round.duration * V.roundMul, 9)
  })
})

describe("vast: bots spawn, navigate and feed", () => {
  it("every bot leaves its spawn point, survives the opening and eats debris", () => {
    for (const seed of [1, 2, 3]) {
      const w = make(seed)
      const brains = w.bodies.map((b, i) => createBotBrain(b.id, i === 0 ? "hard" : "normal", seed + i))
      const paths = drive(w, brains, 24)
      expect(w.phase, `seed ${seed}`).toBe("playing")
      w.bodies.forEach((b) => {
        // Net displacement would fail a bot that loops back after feeding; path length is the
        // movement invariant that matters, and it is measured on the real fixed-step simulation.
        expect(b.alive, `seed ${seed} ${b.id} died in the opening`).toBe(true)
        expect(paths.get(b.id) ?? 0, `seed ${seed} ${b.id} movement`).toBeGreaterThan(1200)
      })
      const eaten = w.bodies.reduce((n, b) => n + b.stats.debrisEaten, 0)
      expect(eaten, `seed ${seed} debris eaten`).toBeGreaterThan(25)
    }
  }, 20_000)

  it("meets a rival within seconds of the start and gets an early absorb", () => {
    const contacts: number[] = []
    let seedWithAbsorb = 0
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const w = make(seed, "normal", undefined, "endless")
      w.phase = "playing"
      w.countdown = 0
      // Same brains GameView builds: the player is piloted by a hard bot, rivals by their skill.
      const brains = new Map<string, BotBrain>()
      w.bodies.forEach((b, i) => {
        brains.set(b.id, createBotBrain(b.id, b.id === "player" ? "hard" : b.skill, seed + i * 7919))
      })
      const player = w.bodies[0]
      const intents = new Map<string, ReturnType<typeof botIntent>>()
      let contact: number | null = null
      let absorbs = 0
      for (let i = 0; i < Math.round(30 / DT); i++) {
        intents.clear()
        for (const b of w.bodies) {
          const brain = brains.get(b.id)
          if (b.alive && brain) intents.set(b.id, botIntent(w, brain))
        }
        step(w, intents)
        const t = i * DT
        for (const ev of w.events) if (ev.type === "absorb") absorbs++
        if (contact === null && player.alive) {
          for (const b of w.bodies) {
            if (b === player || !b.alive) continue
            if (Math.hypot(b.x - player.x, b.y - player.y) < 450) {
              contact = t
              break
            }
          }
        }
      }
      expect(w.phase, `seed ${seed}`).toBe("playing")
      // Encounters must not become spawn kills: the player still has to be alive to react.
      expect(player.alive, `seed ${seed} player died in the opening`).toBe(true)
      expect(contact, `seed ${seed} never came within 450 u of a rival`).not.toBeNull()
      contacts.push(contact!)
      if (absorbs > 0) seedWithAbsorb++
    }
    // Measured on this revision over seeds 1-6: 1 s .. 12 s. Evenly spread spawns never met.
    expect(Math.max(...contacts)).toBeLessThan(20)
    // Measured 2 of 6 seeds; before clustered spawns no seed absorbed at all inside 30 s.
    expect(seedWithAbsorb).toBeGreaterThanOrEqual(2)
  }, 30_000)

  it("sees food further away than in classic, matching the larger field", () => {
    expect(arenaScale(V.arenaRadius)).toBeGreaterThan(1.4)
    expect(arenaScale(CONFIG.arena.radius)).toBe(1)
    // A lone bot with one piece of debris 850 u to its left heads left on the Vast; classic's
    // 600 u graze radius would not see it.
    const w = make(1, "hard", 0)
    w.phase = "playing"
    w.countdown = 0
    w.bodies.push({ ...JSON.parse(JSON.stringify(w.bodies[0])), id: "bot-1", kind: "bot", name: "Rigel", x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0 } as Body)
    const bot = w.bodies[1]
    bot.x = 0
    bot.y = 0
    bot.px = 0
    bot.py = 0
    w.wells = []
    w.zones = []
    w.debris = [
      {
        id: 1,
        kind: "dust",
        x: -850,
        y: 0,
        vx: 0,
        vy: 0,
        px: -850,
        py: 0,
        mass: 2,
        radius: 4,
      },
    ]
    const brain = createBotBrain("bot-1", "hard", 99)
    brain.thinkIn = 0
    const it = botIntent(w, brain)
    expect(it.ax).toBeLessThan(-0.2)
  })
})

describe("vast: safe respawns", () => {
  it("never respawns the player inside the giant star's kill radius", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const w = make(seed, "normal", undefined, "endless")
      w.phase = "playing"
      w.countdown = 0
      const player = w.bodies[0]
      player.alive = false
      w.endless!.respawnIn = DT / 2
      const star = ofKind(w, "star")[0]
      step(w, {})
      expect(player.alive, `seed ${seed}`).toBe(true)
      const d = Math.hypot(player.x - star.x, player.y - star.y)
      expect(d, `seed ${seed} respawn distance`).toBeGreaterThan(star.radius + player.radius * 0.5 + 100)
      expect(polar(player)).toBeLessThanOrEqual(w.arenaRadius - 300 + 1e-6)
    }
  })
})

describe("vast: camera and off-screen guidance", () => {
  it("scales the camera out for the larger arena without shrinking bodies below readability", () => {
    expect(cameraZoomScale(CONFIG.arena.radius)).toBe(1)
    expect(cameraZoomScale(V.arenaRadius)).toBeLessThan(0.85)
    expect(cameraZoomScale(V.arenaRadius)).toBeGreaterThanOrEqual(0.75)
    const bodyRadius = 4 * Math.sqrt(CONFIG.body.startMass)
    for (const [w, h] of [
      [1440, 900],
      [390, 844],
    ]) {
      const base = Math.sqrt(w * h) / (1000 + bodyRadius * 8)
      const px = 2 * bodyRadius * base * cameraZoomScale(V.arenaRadius)
      expect(px, `${w}x${h} body diameter`).toBeGreaterThan(9)
    }
  })

  it("widens the rival indicator range to cover the whole larger arena", () => {
    expect(indicatorRange(CONFIG.arena.radius)).toBe(1600)
    expect(indicatorRange(V.arenaRadius)).toBeGreaterThan(V.arenaRadius)
    expect(indicatorRange(V.arenaRadius)).toBeLessThan(V.arenaRadius * 1.2)
  })

  it("places a core marker on the frame edge when the giant star is off screen, and nowhere when it is visible", () => {
    const onScreen = frameEdgeMarker(0, 0, 0, 0, 0.8, 1440, 900)
    expect(onScreen).toBeNull()
    const far = frameEdgeMarker(0, 0, -2400, 0, 0.8, 1440, 900)
    expect(far).not.toBeNull()
    expect(far!.distance).toBeCloseTo(2400, 6)
    expect(far!.x).toBeGreaterThan(1400)
    expect(Math.abs(far!.y - 450)).toBeLessThan(1e-6)
    const up = frameEdgeMarker(0, 0, 0, 2400, 0.8, 1440, 900)
    expect(up!.y).toBeLessThan(20)
  })
})
