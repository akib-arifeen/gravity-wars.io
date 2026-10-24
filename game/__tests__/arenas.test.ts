// Arena presets, written from the contract: the doc comments in arenas.ts (layouts, ids, spawn
// ring, debris field) plus types.ts / config.ts. Tunables come from CONFIG by name; the arena
// geometry numbers (420, 1150, 2.4x hole, ...) are the ones the doc comment states.

import { describe, expect, it } from "vitest"
import { ARENAS, ARENA_IDS, buildArena, placeWormholePair, randomArena } from "../arenas"
import { CONFIG } from "../config"
import { createWorld } from "../engine"
import type { ArenaId, Well, WellKind, World } from "../types"
import { TWO_PI, angularGap, controlledWorld, dist, expectClose, snapshot } from "./helpers"

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1)

const BASE: Record<ArenaId, number> = {
  classic: CONFIG.arena.radius,
  binary: 2000,
  maw: 2100,
  nebula: 2000,
  belt: 2000,
  vast: CONFIG.vast.arenaRadius,
}
const RING: Record<ArenaId, number> = {
  classic: CONFIG.spawn.ringRadius,
  binary: 1600,
  maw: 1650,
  nebula: 1550,
  belt: 1600,
  vast: CONFIG.vast.spawnRing,
}
const WORMHOLES: Record<ArenaId, boolean> = { classic: true, binary: true, maw: true, nebula: false, belt: true, vast: true }
const COUNTS: Record<ArenaId, Partial<Record<WellKind, number>>> = {
  classic: { star: CONFIG.well.starCount, blackhole: 1 },
  binary: { star: 2, neutronstar: 1 },
  maw: { blackhole: 1, whitedwarf: 2, station: 2 },
  nebula: { star: 1, blackhole: 1, pulsar: 1 },
  belt: { star: 1, planet: 2, station: 1 },
  vast: { star: 1, planet: 2, whitedwarf: 2 },
}
const FIELD: Record<ArenaId, { ringShare: number; ringInner?: number; ringOuter?: number }> = {
  classic: { ringShare: 0 },
  binary: { ringShare: 0 },
  maw: { ringShare: 0.4, ringInner: 600, ringOuter: 1000 },
  nebula: { ringShare: 0 },
  belt: { ringShare: 0.65, ringInner: 850, ringOuter: 1150 },
  vast: { ringShare: CONFIG.vast.beltShare, ringInner: CONFIG.vast.beltInner, ringOuter: CONFIG.vast.beltOuter },
}
/** The Vast spawns more debris by design (CONFIG.vast.debrisMul / crystalMul). */
const budget = (arena: ArenaId, base: number, mul: number) => Math.round(base * (arena === "vast" ? mul : 1))

function make(arena: ArenaId, seed: number, difficulty: "easy" | "normal" | "hard" = "normal"): World {
  return createWorld({ seed, difficulty, arena, cosmic: false })
}
const ofKind = (w: World, kind: WellKind) => w.wells.filter((x) => x.kind === kind)
const polar = (v: { x: number; y: number }) => Math.hypot(v.x, v.y)

/** Whether a circle (centre distance d from the origin, extent e) overlaps the annulus ring ± 120. */
function overlapsRing(d: number, e: number, ring: number) {
  return d + e > ring - 120 && d - e < ring + 120
}

describe("arena registry", () => {
  it("ARENA_IDS lists the six arenas, classic first, and ARENAS describes each one", () => {
    expect([...ARENA_IDS]).toEqual(["classic", "binary", "maw", "nebula", "belt", "vast"])
    for (const id of ARENA_IDS) {
      expect(ARENAS[id].id).toBe(id)
      expect(ARENAS[id].name.length).toBeGreaterThan(0)
      expect(ARENAS[id].blurb.length).toBeGreaterThan(0)
      // "no emoji"
      expect(/\p{Extended_Pictographic}/u.test(ARENAS[id].name + ARENAS[id].blurb)).toBe(false)
    }
  })

  it("randomArena returns valid ids from the world's rng, deterministically, and covers every arena", () => {
    const seen = new Set<ArenaId>()
    const w = controlledWorld({ botCount: 1 })
    const state0 = w.rngState
    for (let i = 0; i < 200; i++) {
      const id = randomArena(w)
      expect(ARENA_IDS).toContain(id)
      seen.add(id)
    }
    expect(w.rngState).not.toBe(state0)
    expect(seen.size).toBe(ARENA_IDS.length)
    const a = controlledWorld({ botCount: 1, seed: 9 })
    const b = controlledWorld({ botCount: 1, seed: 9 })
    expect([randomArena(a), randomArena(a), randomArena(a)]).toEqual([randomArena(b), randomArena(b), randomArena(b)])
  })
})

for (const arena of ARENA_IDS) {
  describe(`arena: ${arena}`, () => {
    it("base radius, spawn ring, debris field and well/zone/wormhole inventory (50 seeds)", () => {
      for (const seed of SEEDS) {
        const w = make(arena, seed)
        const label = `${arena} seed ${seed}`
        expect(w.arena, label).toBe(arena)
        expect(w.arenaBase, label).toBe(BASE[arena])
        expect(w.arenaRadius, label).toBe(BASE[arena])
        for (const b of w.bodies) expectClose(polar(b), RING[arena], 1e-6, `${label} ${b.id} ring distance`)
        expect(w.debrisField.ringShare, label).toBe(FIELD[arena].ringShare)
        if (FIELD[arena].ringShare > 0) {
          expect(w.debrisField.ringInner, label).toBe(FIELD[arena].ringInner)
          expect(w.debrisField.ringOuter, label).toBe(FIELD[arena].ringOuter)
        }
        const kinds = Object.keys(COUNTS[arena]) as WellKind[]
        for (const kind of kinds) expect(ofKind(w, kind), `${label} ${kind}`).toHaveLength(COUNTS[arena][kind]!)
        expect(w.wells, label).toHaveLength(kinds.reduce((n, k) => n + COUNTS[arena][k]!, 0))
        if (WORMHOLES[arena]) {
          expect(w.wormholes.map((x) => x.id), label).toEqual(["wh-a", "wh-b"])
          expect(w.wormholes[0].linkId).toBe("wh-b")
          expect(w.wormholes[1].linkId).toBe("wh-a")
          for (const wh of w.wormholes) expect(wh.radius).toBe(CONFIG.wormhole.radius)
        } else {
          expect(w.wormholes, label).toHaveLength(0)
        }
      }
    })

    it("every well has every field, with the per-kind CONFIG values and consistent ids (50 seeds)", () => {
      for (const seed of SEEDS) {
        const w = make(arena, seed)
        const perKind = new Map<WellKind, number>()
        for (const well of w.wells) {
          const label = `${arena} seed ${seed} ${well.id}`
          for (const f of ["x", "y", "vx", "vy", "gm", "radius", "chargeRadius", "chargeRate"] as const) {
            expect(Number.isFinite(well[f]), `${label}.${f}`).toBe(true)
          }
          expect(typeof well.lethal, label).toBe("boolean")
          expect(well.orbit === null || typeof well.orbit === "object", label).toBe(true)
          expect(well.beam === null || typeof well.beam === "object", label).toBe(true)
          const n = (perKind.get(well.kind) ?? 0) + 1
          perKind.set(well.kind, n)
          // Ids: kind + "-" + 1-based index per kind; black holes use "hole-N" (ruling: every arena).
          const prefix = well.kind === "blackhole" ? "hole" : well.kind
          expect(well.id, label).toBe(`${prefix}-${n}`)
          if (well.kind === "star") {
            // The Vast replaces the central star with a giant, deliberately low-density one.
            const star =
              arena === "vast"
                ? {
                    gm: CONFIG.vast.starGm,
                    radius: CONFIG.vast.starRadius,
                    chargeRadius: CONFIG.vast.starChargeRadius,
                    chargeRate: CONFIG.vast.starChargeRate,
                  }
                : {
                    gm: CONFIG.well.starGm,
                    radius: CONFIG.well.starRadius,
                    chargeRadius: CONFIG.well.starChargeRadius,
                    chargeRate: CONFIG.well.starChargeRate,
                  }
            expect(well).toMatchObject({ ...star, lethal: true })
          } else if (well.kind === "blackhole") {
            expect(well.lethal, label).toBe(true)
            expect(well.chargeRadius).toBe(0)
            expect(well.chargeRate).toBe(0)
            if (arena !== "maw") {
              expect(well.gm).toBe(CONFIG.well.holeGm)
              expect(well.radius).toBe(CONFIG.well.holeRadius)
            }
          } else {
            const k = CONFIG.wellKinds[well.kind]
            expect(well).toMatchObject({ gm: k.gm, radius: k.radius, chargeRadius: k.chargeRadius, chargeRate: k.chargeRate, lethal: k.lethal })
          }
          if (well.kind === "pulsar") {
            expect(well.beam, label).not.toBeNull()
            expect(well.beam!.w).toBe(CONFIG.pulsarBeam.w)
            expect(well.beam!.halfWidth).toBe(CONFIG.pulsarBeam.halfWidth)
            expect(well.beam!.length).toBe(CONFIG.pulsarBeam.length)
            expect(well.beam!.accel).toBe(CONFIG.pulsarBeam.accel)
            expect(Number.isFinite(well.beam!.phase)).toBe(true)
          } else {
            expect(well.beam, label).toBeNull()
          }
          if (well.orbit) {
            // Moving wells start at their orbit position for time 0 with the tangential velocity.
            const o = well.orbit
            expectClose(well.x, o.cx + o.r * Math.cos(o.phase), 1e-9, `${label} x`)
            expectClose(well.y, o.cy + o.r * Math.sin(o.phase), 1e-9, `${label} y`)
            expectClose(well.vx, -o.r * o.w * Math.sin(o.phase), 1e-9, `${label} vx`)
            expectClose(well.vy, o.r * o.w * Math.cos(o.phase), 1e-9, `${label} vy`)
          } else {
            expect(well.vx, label).toBe(0)
            expect(well.vy, label).toBe(0)
          }
        }
      }
    })

    it("nothing overlaps the spawn ring (ring +/- 120): well charge bands, surfaces, orbits and zones (50 seeds)", () => {
      for (const seed of SEEDS) {
        const w = make(arena, seed)
        for (const well of w.wells) {
          const extent = Math.max(well.chargeRadius, well.radius)
          const samples = well.orbit ? 48 : 1
          for (let i = 0; i < samples; i++) {
            let x = well.x
            let y = well.y
            if (well.orbit) {
              const th = well.orbit.phase + (TWO_PI * i) / samples
              x = well.orbit.cx + well.orbit.r * Math.cos(th)
              y = well.orbit.cy + well.orbit.r * Math.sin(th)
            }
            expect(overlapsRing(Math.hypot(x, y), extent, RING[arena]), `${arena} seed ${seed} ${well.id} (sample ${i})`).toBe(false)
          }
        }
        for (const z of w.zones) {
          expect(overlapsRing(polar(z), z.r, RING[arena]), `${arena} seed ${seed} ${z.id}`).toBe(false)
        }
      }
    })

    it("bodies start evenly spaced, at rest, clear of every lethal well (50 seeds)", () => {
      for (const seed of SEEDS) {
        const w = make(arena, seed)
        const n = w.bodies.length
        const angles = w.bodies.map((b) => Math.atan2(b.y, b.x)).sort((a, b) => a - b)
        for (let i = 0; i < n; i++) {
          const next = i + 1 < n ? angles[i + 1] : angles[0] + TWO_PI
          expectClose(next - angles[i], TWO_PI / n, 1e-9, `${arena} seed ${seed} angular gap`)
        }
        for (const b of w.bodies) {
          for (const well of w.wells) {
            if (well.lethal) expect(dist(b, well), `${arena} seed ${seed} ${b.id} vs ${well.id}`).toBeGreaterThan(well.radius + b.radius)
          }
        }
      }
    })

    it("debris: target counts, inside the arena, clear of wells, spread per the debris field", () => {
      let inRing = 0
      let loose = 0
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        const w = make(arena, seed)
        const dr = w.debris.filter((d) => d.kind !== "crystal")
        expect(dr, `${arena} seed ${seed}`).toHaveLength(budget(arena, CONFIG.debris.target, CONFIG.vast.debrisMul))
        expect(w.debris.filter((d) => d.kind === "crystal")).toHaveLength(
          budget(arena, CONFIG.crystal.target, CONFIG.vast.crystalMul),
        )
        for (const d of w.debris) {
          expect(polar(d)).toBeLessThanOrEqual(w.arenaRadius + 1e-9)
          for (const well of w.wells) {
            expect(dist(d, well), `${arena} seed ${seed} debris ${d.id} vs ${well.id}`).toBeGreaterThanOrEqual(
              well.radius + CONFIG.debris.wellClearance - 1e-9,
            )
          }
        }
        if (FIELD[arena].ringShare > 0) {
          for (const d of dr) {
            loose++
            const r = polar(d)
            if (r >= FIELD[arena].ringInner! && r <= FIELD[arena].ringOuter!) inRing++
          }
        }
      }
      if (FIELD[arena].ringShare > 0) {
        const share = FIELD[arena].ringShare
        const inner = FIELD[arena].ringInner!
        const outer = FIELD[arena].ringOuter!
        // The uniform remainder also lands in the annulus by area.
        const spill = (1 - share) * ((outer * outer - inner * inner) / (BASE[arena] * BASE[arena]))
        expect(inRing / loose).toBeGreaterThan(share - 0.05)
        expect(inRing / loose).toBeLessThan(share + spill + 0.06)
      }
    })

    it("is deterministic and different per seed", () => {
      expect(snapshot(make(arena, 4))).toBe(snapshot(make(arena, 4)))
      expect(snapshot(make(arena, 4))).not.toBe(snapshot(make(arena, 5)))
    })

    it("works for every difficulty and a custom bot count", () => {
      for (const difficulty of ["easy", "normal", "hard"] as const) {
        expect(make(arena, 2, difficulty).bodies).toHaveLength(1 + CONFIG.difficulty[difficulty].bots)
      }
      expect(createWorld({ seed: 2, difficulty: "normal", arena, botCount: 0 }).bodies).toHaveLength(1)
    })
  })
}

describe("classic is the documented original layout", () => {
  it("two stars in the orbit band at least 90 degrees apart, one hole near the centre, no zones (50 seeds)", () => {
    for (const seed of SEEDS) {
      const w = make("classic", seed)
      expect(w.zones).toHaveLength(0)
      const stars = ofKind(w, "star")
      stars.forEach((s, i) => {
        expect(s.id).toBe(`star-${i + 1}`)
        expect(polar(s)).toBeGreaterThanOrEqual(CONFIG.well.starOrbit[0] - 1e-9)
        expect(polar(s)).toBeLessThanOrEqual(CONFIG.well.starOrbit[1] + 1e-9)
        expect(s.orbit).toBeNull()
      })
      for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
          expect(angularGap(Math.atan2(stars[i].y, stars[i].x), Math.atan2(stars[j].y, stars[j].x))).toBeGreaterThanOrEqual(Math.PI / 2 - 1e-9)
        }
      }
      const hole = ofKind(w, "blackhole")[0]
      expect(polar(hole)).toBeLessThanOrEqual(CONFIG.well.holeOffsetMax + 1e-9)
      expect(hole.gm).toBe(CONFIG.well.holeGm)
      expect(hole.radius).toBe(CONFIG.well.holeRadius)
      for (const wh of w.wormholes) {
        expect(polar(wh)).toBeGreaterThanOrEqual(CONFIG.wormhole.orbit[0] - 1e-9)
        expect(polar(wh)).toBeLessThanOrEqual(CONFIG.wormhole.orbit[1] + 1e-9)
        for (const well of w.wells) expect(dist(wh, well)).toBeGreaterThanOrEqual(CONFIG.wormhole.wellClearance - 1e-9)
      }
      expect(dist(w.wormholes[0], w.wormholes[1])).toBeGreaterThanOrEqual(CONFIG.wormhole.minSeparation - 1e-9)
    }
  })

  it("buildArena can be called directly on a fresh world and returns ring radius and field", () => {
    const w = controlledWorld({ botCount: 1 })
    w.wells = []
    w.zones = []
    w.wormholes = []
    const out = buildArena(w, "maw")
    expect(out.ringRadius).toBe(RING.maw)
    expect(out.field.ringShare).toBe(0.4)
    expect(w.arenaBase).toBe(BASE.maw)
    expect(w.arenaRadius).toBe(BASE.maw)
    expect(w.wells.length).toBe(5)
  })
})

describe("binary", () => {
  it("two stars orbit the centre on opposite sides (r 420, w = +/- 2 pi / 70, same sign), neutron star fixed at r 1150", () => {
    for (const seed of SEEDS) {
      const w = make("binary", seed)
      const [a, b] = ofKind(w, "star")
      for (const s of [a, b]) {
        expect(s.orbit).not.toBeNull()
        expect(s.orbit!.cx).toBe(0)
        expect(s.orbit!.cy).toBe(0)
        expect(s.orbit!.r).toBe(420)
        expectClose(Math.abs(s.orbit!.w), TWO_PI / 70, 1e-12, "|w|")
      }
      expect(Math.sign(a.orbit!.w)).toBe(Math.sign(b.orbit!.w))
      expectClose(angularGap(a.orbit!.phase, b.orbit!.phase), Math.PI, 1e-9, "phase gap")
      const ns = ofKind(w, "neutronstar")[0]
      expect(ns.orbit).toBeNull()
      expectClose(polar(ns), 1150, 1e-9, "neutron star radius")
    }
  })

  it("the star orbit sign takes both values across seeds", () => {
    const signs = new Set(SEEDS.map((s) => Math.sign(ofKind(make("binary", s), "star")[0].orbit!.w)))
    expect(signs.size).toBe(2)
  })
})

describe("maw", () => {
  it("one big black hole at the centre, two white dwarfs at r 1050 opposite, two stations at r 700 on the perpendicular axis", () => {
    for (const seed of SEEDS) {
      const w = make("maw", seed)
      const hole = ofKind(w, "blackhole")[0]
      expectClose(polar(hole), 0, 1e-9, "hole at the centre")
      expectClose(hole.gm, 2.4 * CONFIG.well.holeGm, 1e-3, "hole gm")
      expect(hole.radius).toBe(70)
      const [d1, d2] = ofKind(w, "whitedwarf")
      expectClose(polar(d1), 1050, 1e-9)
      expectClose(polar(d2), 1050, 1e-9)
      expectClose(d1.x + d2.x, 0, 1e-9, "opposite sides x")
      expectClose(d1.y + d2.y, 0, 1e-9, "opposite sides y")
      const [s1, s2] = ofKind(w, "station")
      expectClose(polar(s1), 700, 1e-9)
      expectClose(polar(s2), 700, 1e-9)
      expectClose(s1.x + s2.x, 0, 1e-9)
      expectClose(s1.y + s2.y, 0, 1e-9)
      expectClose((s1.x * d1.x + s1.y * d1.y) / (700 * 1050), 0, 1e-9, "stations perpendicular to the dwarfs")
      for (const k of [d1, d2, s1, s2]) expect(k.orbit).toBeNull()
    }
  })
})

describe("nebula", () => {
  it("star at r 800, hole within 350, pulsar at r 900 at least 120 degrees from the star", () => {
    for (const seed of SEEDS) {
      const w = make("nebula", seed)
      const star = ofKind(w, "star")[0]
      const hole = ofKind(w, "blackhole")[0]
      const pulsar = ofKind(w, "pulsar")[0]
      expectClose(polar(star), 800, 1e-9, "star r")
      expect(polar(hole)).toBeLessThanOrEqual(350 + 1e-9)
      expectClose(polar(pulsar), 900, 1e-9, "pulsar r")
      expect(angularGap(Math.atan2(star.y, star.x), Math.atan2(pulsar.y, pulsar.x))).toBeGreaterThanOrEqual((2 * Math.PI) / 3 - 1e-9)
    }
  })

  it("three nebula zones (radius 320..420, strength nebulaDrag, r 500..1100, clear of well charge bands + 80) and one repulsor", () => {
    for (const seed of SEEDS) {
      const w = make("nebula", seed)
      const nebulae = w.zones.filter((z) => z.kind === "nebula")
      const repulsors = w.zones.filter((z) => z.kind === "repulsor")
      expect(w.zones, `seed ${seed}`).toHaveLength(4)
      expect(nebulae, `seed ${seed}`).toHaveLength(3)
      expect(repulsors, `seed ${seed}`).toHaveLength(1)
      w.zones.forEach((z, i) => {
        expect(z.id).toBe(`zone-${i + 1}`)
        expect(z.eventId).toBeNull()
        expect(z.vx).toBe(0)
        expect(z.vy).toBe(0)
      })
      for (const z of nebulae) {
        expect(z.r).toBeGreaterThanOrEqual(320 - 1e-9)
        expect(z.r).toBeLessThanOrEqual(420 + 1e-9)
        expect(z.strength).toBe(CONFIG.zones.nebulaDrag)
        expect(polar(z)).toBeGreaterThanOrEqual(500 - 1e-9)
        expect(polar(z)).toBeLessThanOrEqual(1100 + 1e-9)
        for (const well of w.wells) {
          expect(dist(z, well), `seed ${seed} ${z.id} vs ${well.id}`).toBeGreaterThanOrEqual(
            z.r + Math.max(well.chargeRadius, well.radius) + 80 - 1e-6,
          )
        }
      }
      const rep = repulsors[0]
      expect(rep.r).toBe(220)
      expect(rep.strength).toBe(CONFIG.zones.repulsorAccel)
      // "near the hole at r 450..600": read as the distance from the black hole (the header defines r
      // as the distance from the arena centre, which would put it up to 950 u from the hole).
      const hole = ofKind(w, "blackhole")[0]
      expect(dist(rep, hole), `seed ${seed} repulsor distance from the hole`).toBeGreaterThanOrEqual(450 - 1e-9)
      expect(dist(rep, hole), `seed ${seed} repulsor distance from the hole`).toBeLessThanOrEqual(600 + 1e-9)
    }
  })

  it("has no wormholes", () => {
    expect(make("nebula", 3).wormholes).toEqual([])
  })
})

describe("belt", () => {
  it("star at the centre, planets orbiting it at r 650 (w 2 pi / 50) and r 1250 (w -2 pi / 80), station at r 950", () => {
    for (const seed of SEEDS) {
      const w = make("belt", seed)
      const star = ofKind(w, "star")[0]
      expectClose(polar(star), 0, 1e-9, "star at the centre")
      expect(star.orbit).toBeNull()
      const [p1, p2] = ofKind(w, "planet")
      expect(p1.orbit).not.toBeNull()
      expect(p2.orbit).not.toBeNull()
      expect(p1.orbit!.r).toBe(650)
      expectClose(p1.orbit!.w, TWO_PI / 50, 1e-12)
      expect(p2.orbit!.r).toBe(1250)
      expectClose(p2.orbit!.w, -TWO_PI / 80, 1e-12)
      for (const p of [p1, p2]) {
        expectClose(p.orbit!.cx, star.x, 1e-9, "orbit centre x")
        expectClose(p.orbit!.cy, star.y, 1e-9, "orbit centre y")
        expect(p.lethal).toBe(false)
      }
      const st = ofKind(w, "station")[0]
      expectClose(polar(st), 950, 1e-9)
      expect(st.orbit).toBeNull()
      expect(st.lethal).toBe(false)
    }
  })

  it("planet phases are random across seeds", () => {
    const phases = new Set(SEEDS.map((s) => Math.round(ofKind(make("belt", s), "planet")[0].orbit!.phase * 1e6)))
    expect(phases.size).toBeGreaterThan(30)
  })
})

describe("placeWormholePair", () => {
  function worldWithoutPair(arenaRadius?: number) {
    const w = make("classic", 8)
    w.wormholes = []
    if (arenaRadius !== undefined) w.arenaRadius = arenaRadius
    return w
  }

  it("creates a linked wh-a / wh-b pair under the classic rules", () => {
    for (const seed of SEEDS) {
      const w = make("classic", seed)
      w.wormholes = []
      placeWormholePair(w)
      expect(w.wormholes.map((x) => x.id), `seed ${seed}`).toEqual(["wh-a", "wh-b"])
      const [a, b] = w.wormholes
      expect(a.linkId).toBe("wh-b")
      expect(b.linkId).toBe("wh-a")
      for (const wh of w.wormholes) {
        expect(wh.radius).toBe(CONFIG.wormhole.radius)
        expect(polar(wh)).toBeGreaterThanOrEqual(CONFIG.wormhole.orbit[0] - 1e-9)
        expect(polar(wh)).toBeLessThanOrEqual(CONFIG.wormhole.orbit[1] + 1e-9)
        for (const well of w.wells) expect(dist(wh, well)).toBeGreaterThanOrEqual(CONFIG.wormhole.wellClearance - 1e-9)
      }
      expect(dist(a, b)).toBeGreaterThanOrEqual(CONFIG.wormhole.minSeparation - 1e-9)
    }
  })

  it("keeps the existing ids and re-places the ends", () => {
    const w = make("classic", 8)
    const before = w.wormholes.map((x) => `${x.x.toFixed(6)},${x.y.toFixed(6)}`)
    placeWormholePair(w)
    expect(w.wormholes.map((x) => x.id)).toEqual(["wh-a", "wh-b"])
    expect(w.wormholes).toHaveLength(2)
    expect(w.wormholes.map((x) => `${x.x.toFixed(6)},${x.y.toFixed(6)}`)).not.toEqual(before)
  })

  it("clamps the distance to the current arenaRadius - 200", () => {
    for (const seed of SEEDS) {
      const w = worldWithoutPair(1300)
      w.rngState = seed * 7919
      placeWormholePair(w)
      for (const wh of w.wormholes) expect(polar(wh), `seed ${seed}`).toBeLessThanOrEqual(1300 - 200 + 1e-9)
    }
  })

  it("is deterministic given the world's rng state", () => {
    const a = worldWithoutPair()
    const b = worldWithoutPair()
    placeWormholePair(a)
    placeWormholePair(b)
    expect(JSON.stringify(a.wormholes)).toBe(JSON.stringify(b.wormholes))
    expect(a.rngState).toBe(b.rngState)
  })
})

describe("well helper types", () => {
  it("Well objects from buildArena are plain data (JSON round-trip safe)", () => {
    const w = make("belt", 3)
    const copy: Well[] = JSON.parse(JSON.stringify(w.wells))
    expect(copy).toEqual(w.wells)
  })
})

describe("placeWormholePair: clearance from lethal orbiting wells", () => {
  // Contract: for every LETHAL well with an orbit, | |p - (cx, cy)| - orbit.r | >= well.radius +
  // CONFIG.wormhole.wellClearance (the whole orbit circle is swept).
  const orbitOffset = (p: { x: number; y: number }, well: Well) => Math.abs(Math.hypot(p.x - well.orbit!.cx, p.y - well.orbit!.cy) - well.orbit!.r)

  it("binary: the pair built with the arena keeps clear of both stars' orbit circles (100 seeds)", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const w = make("binary", seed)
      for (const star of ofKind(w, "star")) {
        for (const wh of w.wormholes) {
          expect(orbitOffset(wh, star), `seed ${seed} ${wh.id} vs ${star.id}`).toBeGreaterThanOrEqual(star.radius + CONFIG.wormhole.wellClearance - 1e-9)
        }
      }
    }
  })

  it("binary: every later re-placement (wormhole storms) does too (100 seeds x 6 re-placements)", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const w = make("binary", seed)
      for (let k = 0; k < 6; k++) {
        placeWormholePair(w)
        for (const star of ofKind(w, "star")) {
          for (const wh of w.wormholes) {
            expect(orbitOffset(wh, star), `seed ${seed} re-placement ${k} ${wh.id}`).toBeGreaterThanOrEqual(
              star.radius + CONFIG.wormhole.wellClearance - 1e-9,
            )
          }
        }
        expect(dist(w.wormholes[0], w.wormholes[1])).toBeGreaterThanOrEqual(CONFIG.wormhole.minSeparation - 1e-9)
      }
    }
  })

  it("applies only to LETHAL orbiting wells: belt planets (solid) impose no orbit clearance beyond the point rule", () => {
    for (const planet of ofKind(make("belt", 1), "planet")) expect(planet.lethal).toBe(false)
    for (let seed = 1; seed <= 50; seed++) {
      const w = make("belt", seed)
      for (const wh of w.wormholes) {
        for (const well of w.wells) expect(dist(wh, well)).toBeGreaterThanOrEqual(CONFIG.wormhole.wellClearance - 1e-9)
      }
    }
  })
})
