// Arena presets: where wells, zones, wormholes and debris go at the start of a round.
// Pure and deterministic: every random draw comes from world.rngState (rand/randRange).
// Imports only config, rng and types (never engine.ts: the engine imports this module).
//
// CONTRACT — exported signatures and documented behaviour are fixed. Helpers go below PRIVATE.

import { CONFIG } from "./config"
import { rand, randRange } from "./rng"
import type { ArenaId, Vec, Well, WellKind, World, Zone } from "./types"

export const ARENA_IDS: readonly ArenaId[] = ["classic", "binary", "maw", "nebula", "belt", "vast"]

export interface ArenaInfo {
  id: ArenaId
  /** Menu label and one-line description (no emoji). */
  name: string
  blurb: string
}

export const ARENAS: Readonly<Record<ArenaId, ArenaInfo>> = {
  classic: { id: "classic", name: "Classic", blurb: "Two stars, a black hole and a wormhole pair." },
  binary: { id: "binary", name: "Binary", blurb: "Twin stars locked in orbit around each other." },
  maw: { id: "maw", name: "The Maw", blurb: "One enormous black hole. Feed it, or feed on it." },
  nebula: { id: "nebula", name: "Nebula Field", blurb: "Thick drag clouds and a sweeping pulsar." },
  belt: { id: "belt", name: "The Belt", blurb: "A dense asteroid ring with orbiting planets." },
  vast: { id: "vast", name: "The Vast", blurb: "A red supergiant, a wide asteroid belt, and the long dark beyond." },
}

/** Where debris spawns: uniform over the disc, or concentrated in an annulus. */
export interface DebrisField {
  /** Fraction of dust/rock that spawns in the annulus (the rest is uniform over the disc). */
  ringShare: number
  ringInner: number
  ringOuter: number
}

/**
 * Lay out the arena's fixed content into a freshly created world: world.wells, world.zones,
 * world.wormholes, world.arenaBase and world.arenaRadius. Called by createWorld BEFORE bodies and
 * debris are placed. Returns the spawn ring radius for bodies and the debris field.
 *
 * Every well must have all Well fields (vx/vy 0 for fixed wells; orbit/beam null unless stated).
 * Moving wells start at their orbit position for time 0 with vx/vy = the orbit's tangential
 * velocity. Per-kind gm/radius/charge/lethal values come from CONFIG.well (star, blackhole) and
 * CONFIG.wellKinds (others); the pulsar beam from CONFIG.pulsarBeam with a random phase.
 *
 * Layouts (r = distance from the arena centre; angles random unless stated; nothing may be placed
 * so that a well's chargeRadius or a zone overlaps the spawn ring, ringRadius ± 120):
 * - classic: EXACTLY the pre-Phase-A layout and draw order (2 stars in CONFIG.well.starOrbit at
 *   least 90° apart, the black hole within holeOffsetMax, the wormhole pair). No zones.
 *   arenaBase = CONFIG.arena.radius. Spawn ring CONFIG.spawn.ringRadius. Field: ringShare 0.
 * - binary: two stars orbiting the centre on opposite sides: orbit r 420, w ±(2π/70) (same sign),
 *   phases θ and θ+π. A neutron star at r 1150. The wormhole pair (same placement rules as
 *   classic but using these wells). arenaBase 2000, spawn ring 1600. Field: ringShare 0.
 * - maw: one black hole at the centre with gm = 2.4 * CONFIG.well.holeGm and radius 70; two white
 *   dwarfs at r 1050 on opposite sides; two stations at r 700 on the perpendicular axis (they are
 *   the only big energy source). One wormhole pair. arenaBase 2100, spawn ring 1650.
 *   Field: ringShare 0.4, ring 600..1000 (an accretion ring outside the hole's danger zone).
 * - nebula: one star at r 800, the black hole within 350 of the centre, one pulsar at r 900 at
 *   least 120° from the star, three static nebula zones (radius 320..420, strength
 *   CONFIG.zones.nebulaDrag) spread at r 500..1100 not overlapping wells' chargeRadius + 80, and
 *   one repulsor zone (radius 220, strength CONFIG.zones.repulsorAccel) near the hole at r 450..600.
 *   No wormholes. arenaBase 2000, spawn ring 1550. Field: ringShare 0.
 * - belt: one star at the centre; two planets orbiting it at r 650 and 1250 (w 2π/50 and
 *   -2π/80, random phases); one station at r 950. One wormhole pair. arenaBase 2000, spawn
 *   ring 1600 (outside the outer planet's path, clear of the wall warning band). Field: ringShare 0.65, ring 850..1150.
 * - vast: the oversized arena. One giant central star (CONFIG.vast star values: radius 360 and a
 *   deliberately lower gm than its size implies), two solid planets orbiting it at r 2000
 *   (w 2π/90) and 3050 (w -2π/120) with random phases, two white dwarfs on opposite sides of the
 *   outer reach at r 4200, one wormhole pair in the middle field, one dust-lane nebula (r 2450,
 *   radius 640, drag CONFIG.vast.dustLane.drag), one quantum anomaly opposite it (r 1350, radius
 *   240), and two repulsor fields at r 4240 perpendicular to the white dwarfs' axis (radius 330,
 *   strength CONFIG.zones.repulsorAccel). arenaBase 4800, spawn ring 3300. Field: ringShare 0.7,
 *   ring 1200..3200.
 * Ids: kind + "-" + 1-based index per kind, except black holes use "hole" ("star-1", "hole-1",
 * "planet-2", "station-1"...);
 * zone ids "zone-1", ...
 */
export function buildArena(world: World, arena: ArenaId): { ringRadius: number; field: DebrisField } {
  world.arena = arena
  world.wells = []
  world.zones = []
  world.wormholes = []
  const noField: DebrisField = { ringShare: 0, ringInner: 0, ringOuter: 0 }
  let ringRadius: number
  let field = noField
  let base: number

  if (arena === "classic") {
    base = CONFIG.arena.radius
    ringRadius = CONFIG.spawn.ringRadius
    world.arenaBase = base
    world.arenaRadius = base
    // Draw order is load-bearing (tests and the Python reference depend on it): per star the
    // angle retries then the distance, then the hole (distance, angle), then the wormholes.
    const starAngles: number[] = []
    for (let i = 0; i < CONFIG.well.starCount; i++) {
      let angle = 0
      for (let tries = 0; tries < 200; tries++) {
        angle = randRange(world, 0, TWO_PI)
        let ok = true
        for (let k = 0; k < starAngles.length; k++) {
          if (angularGap(angle, starAngles[k]) < Math.PI / 2) {
            ok = false
            break
          }
        }
        if (ok) break
      }
      starAngles.push(angle)
      const dist = randRange(world, CONFIG.well.starOrbit[0], CONFIG.well.starOrbit[1])
      addStar(world, Math.cos(angle) * dist, Math.sin(angle) * dist)
    }
    addHoleInDisc(world, CONFIG.well.holeOffsetMax)
    placeWormholePair(world)
    return { ringRadius, field }
  }

  if (arena === "binary") {
    base = 2000
    ringRadius = 1600
    world.arenaBase = base
    world.arenaRadius = base
    const theta = randRange(world, 0, TWO_PI)
    const w = (rand(world) < 0.5 ? -1 : 1) * (TWO_PI / 70)
    addOrbiter(world, "star", 0, 0, 420, w, theta)
    addOrbiter(world, "star", 0, 0, 420, w, theta + Math.PI)
    const na = randRange(world, 0, TWO_PI)
    addFixed(world, "neutronstar", Math.cos(na) * 1150, Math.sin(na) * 1150)
    placeWormholePair(world)
  } else if (arena === "maw") {
    base = 2100
    ringRadius = 1650
    world.arenaBase = base
    world.arenaRadius = base
    field = { ringShare: 0.4, ringInner: 600, ringOuter: 1000 }
    world.wells.push(makeWell("blackhole", "hole-1", 0, 0, 2.4 * CONFIG.well.holeGm, 70))
    const a = randRange(world, 0, TWO_PI)
    for (let i = 0; i < 2; i++) {
      const ang = a + Math.PI * i
      addFixed(world, "whitedwarf", Math.cos(ang) * 1050, Math.sin(ang) * 1050)
    }
    for (let i = 0; i < 2; i++) {
      const ang = a + Math.PI / 2 + Math.PI * i
      addFixed(world, "station", Math.cos(ang) * 700, Math.sin(ang) * 700)
    }
    placeWormholePair(world)
  } else if (arena === "nebula") {
    base = 2000
    ringRadius = 1550
    world.arenaBase = base
    world.arenaRadius = base
    const sa = randRange(world, 0, TWO_PI)
    addStar(world, Math.cos(sa) * 800, Math.sin(sa) * 800)
    addHoleInDisc(world, 350)
    const pa = sa + randRange(world, (2 * Math.PI) / 3, (4 * Math.PI) / 3)
    const pulsar = addFixed(world, "pulsar", Math.cos(pa) * 900, Math.sin(pa) * 900)
    pulsar.beam = {
      w: CONFIG.pulsarBeam.w,
      phase: randRange(world, 0, TWO_PI),
      halfWidth: CONFIG.pulsarBeam.halfWidth,
      length: CONFIG.pulsarBeam.length,
      accel: CONFIG.pulsarBeam.accel,
    }
    for (let i = 0; i < 3; i++) {
      const zr = randRange(world, 320, 420)
      let p: Vec = { x: 0, y: 0 }
      for (let tries = 0; tries < 200; tries++) {
        const d = randRange(world, 500, 1100)
        const ang = randRange(world, 0, TWO_PI)
        p = { x: Math.cos(ang) * d, y: Math.sin(ang) * d }
        if (d + zr > ringRadius - 120) continue
        if (!clearOfWells(world, p.x, p.y, zr)) continue
        let apart = true
        for (const z of world.zones) {
          if (Math.hypot(p.x - z.x, p.y - z.y) < 500) apart = false
        }
        if (apart) break
      }
      addZone(world, "nebula", p.x, p.y, zr, CONFIG.zones.nebulaDrag)
    }
    {
      const hole = world.wells.find((w) => w.kind === "blackhole")!
      let p: Vec = { x: hole.x, y: hole.y }
      for (let tries = 0; tries < 200; tries++) {
        const d = randRange(world, 450, 600)
        const ang = randRange(world, 0, TWO_PI)
        p = { x: hole.x + Math.cos(ang) * d, y: hole.y + Math.sin(ang) * d }
        if (Math.hypot(p.x, p.y) + 220 > ringRadius - 120) continue
        if (clearOfWells(world, p.x, p.y, 220)) break
      }
      addZone(world, "repulsor", p.x, p.y, 220, CONFIG.zones.repulsorAccel)
    }
  } else if (arena === "belt") {
    // belt
    base = 2000
    ringRadius = 1600
    world.arenaBase = base
    world.arenaRadius = base
    field = { ringShare: 0.65, ringInner: 850, ringOuter: 1150 }
    addFixed(world, "star", 0, 0)
    addOrbiter(world, "planet", 0, 0, 650, TWO_PI / 50, randRange(world, 0, TWO_PI))
    addOrbiter(world, "planet", 0, 0, 1250, -TWO_PI / 80, randRange(world, 0, TWO_PI))
    const sa = randRange(world, 0, TWO_PI)
    addFixed(world, "station", Math.cos(sa) * 950, Math.sin(sa) * 950)
    placeWormholePair(world)
  } else {
    // vast: bigger in every dimension, but the giant star's gm is tuned low so its reach is not
    // overwhelming. Draw order: five anchor draws, then the wormhole pair, then the zones.
    const V = CONFIG.vast
    base = V.arenaRadius
    ringRadius = V.spawnRing
    world.arenaBase = base
    world.arenaRadius = base
    field = { ringShare: V.beltShare, ringInner: V.beltInner, ringOuter: V.beltOuter }
    const star = addStar(world, 0, 0)
    star.gm = V.starGm
    star.radius = V.starRadius
    star.chargeRadius = V.starChargeRadius
    star.chargeRate = V.starChargeRate
    const phases = [randRange(world, 0, TWO_PI), randRange(world, 0, TWO_PI)]
    addOrbiter(world, "planet", 0, 0, V.planetInnerOrbit, TWO_PI / 90, phases[0])
    addOrbiter(world, "planet", 0, 0, V.planetOuterOrbit, -TWO_PI / 120, phases[1])
    const outerAxis = randRange(world, 0, TWO_PI)
    addFixed(world, "whitedwarf", Math.cos(outerAxis) * V.remnantOrbit, Math.sin(outerAxis) * V.remnantOrbit)
    addFixed(world, "whitedwarf", Math.cos(outerAxis + Math.PI) * V.remnantOrbit, Math.sin(outerAxis + Math.PI) * V.remnantOrbit)
    placeWormholePair(world)
    // Dust lane: the planets move, so choose an angle clear of both of their time-0 positions.
    const dl = V.dustLane
    let dust: Vec = { x: dl.orbit, y: 0 }
    for (let tries = 0; tries < 200; tries++) {
      const a = randRange(world, 0, TWO_PI)
      dust = { x: Math.cos(a) * dl.orbit, y: Math.sin(a) * dl.orbit }
      if (dl.orbit + dl.radius > ringRadius - 120) continue
      if (clearOfWells(world, dust.x, dust.y, dl.radius)) break
    }
    addZone(world, "nebula", dust.x, dust.y, dl.radius, dl.drag)
    const an = V.anomaly
    const anomalyAngle = Math.atan2(dust.y, dust.x) + Math.PI
    addZone(world, "anomaly", Math.cos(anomalyAngle) * an.orbit, Math.sin(anomalyAngle) * an.orbit, an.radius, CONFIG.zones.anomalyUlt)
    const rp = V.repulsor
    for (let i = 0; i < 2; i++) {
      const a = outerAxis + Math.PI / 2 + Math.PI * i
      addZone(world, "repulsor", Math.cos(a) * rp.orbit, Math.sin(a) * rp.orbit, rp.radius, CONFIG.zones.repulsorAccel)
    }
  }
  return { ringRadius, field }
}

/**
 * (Re)place world.wormholes as a linked pair "wh-a"/"wh-b" using the classic rules (distance in
 * CONFIG.wormhole.orbit from the centre — clamped to the current arenaRadius - 200 — at least
 * CONFIG.wormhole.wellClearance from every well centre, and for every LETHAL well with an orbit
 * at least well.radius + CONFIG.wormhole.wellClearance from its whole orbit circle
 * (| |p - (cx, cy)| - orbit.r | >= that), and CONFIG.wormhole.minSeparation apart;
 * 200 tries, then the last draw). Keeps existing ids when the pair already exists. Used by
 * buildArena and by the wormhole storm in cosmic.ts.
 */
export function placeWormholePair(world: World): void {
  const orbit = world.arena === "vast" ? CONFIG.vast.wormholeOrbit : CONFIG.wormhole.orbit
  const maxDist = Math.min(orbit[1], world.arenaRadius - 200)
  const minDist = Math.min(orbit[0], maxDist)
  const pos: Vec[] = []
  for (let n = 0; n < 2; n++) {
    let x = 0
    let y = 0
    for (let tries = 0; tries < 200; tries++) {
      const dist = randRange(world, minDist, maxDist)
      const angle = randRange(world, 0, TWO_PI)
      x = Math.cos(angle) * dist
      y = Math.sin(angle) * dist
      let ok = true
      for (const w of world.wells) {
        if (Math.hypot(x - w.x, y - w.y) < CONFIG.wormhole.wellClearance) {
          ok = false
          break
        }
        // A lethal orbiting well sweeps its whole orbit circle: keep clear of all of it.
        if (w.lethal && w.orbit) {
          const off = Math.abs(Math.hypot(x - w.orbit.cx, y - w.orbit.cy) - w.orbit.r)
          if (off < w.radius + CONFIG.wormhole.wellClearance) {
            ok = false
            break
          }
        }
      }
      if (ok && n === 1 && Math.hypot(x - pos[0].x, y - pos[0].y) < CONFIG.wormhole.minSeparation) ok = false
      if (ok) break
    }
    pos.push({ x, y })
  }
  const a = world.wormholes.find((h) => h.id === "wh-a")
  const b = world.wormholes.find((h) => h.id === "wh-b")
  if (a && b) {
    a.x = pos[0].x
    a.y = pos[0].y
    b.x = pos[1].x
    b.y = pos[1].y
    return
  }
  world.wormholes = [
    { id: "wh-a", x: pos[0].x, y: pos[0].y, radius: CONFIG.wormhole.radius, linkId: "wh-b" },
    { id: "wh-b", x: pos[1].x, y: pos[1].y, radius: CONFIG.wormhole.radius, linkId: "wh-a" },
  ]
}

/** Pick a uniformly random arena id from the world's rng (used when the player chooses "Random"). */
export function randomArena(world: World): ArenaId {
  return ARENA_IDS[Math.min(ARENA_IDS.length - 1, Math.floor(rand(world) * ARENA_IDS.length))]
}

// ---------------------------------------------------------------------------------------------
// PRIVATE — implementation helpers go below this line.
// ---------------------------------------------------------------------------------------------

const TWO_PI = Math.PI * 2

/** Smallest absolute angle between two angles (0..PI). */
function angularGap(a: number, b: number): number {
  let d = Math.abs(a - b) % TWO_PI
  if (d > Math.PI) d = TWO_PI - d
  return d
}

function makeWell(kind: WellKind, id: string, x: number, y: number, gm: number, radius: number): Well {
  const isStar = kind === "star"
  const isHole = kind === "blackhole"
  const k = isStar || isHole ? null : CONFIG.wellKinds[kind as Exclude<WellKind, "star" | "blackhole">]
  return {
    id,
    kind,
    x,
    y,
    vx: 0,
    vy: 0,
    gm,
    radius,
    chargeRadius: isStar ? CONFIG.well.starChargeRadius : k ? k.chargeRadius : 0,
    chargeRate: isStar ? CONFIG.well.starChargeRate : k ? k.chargeRate : 0,
    lethal: k ? k.lethal : true,
    orbit: null,
    beam: null,
  }
}

function nextId(world: World, kind: WellKind): string {
  let n = 1
  for (const w of world.wells) if (w.kind === kind) n++
  // Black holes keep the original "hole-N" ids (classic layout, tests and saved replays use them).
  return `${kind === "blackhole" ? "hole" : kind}-${n}`
}

/** Fixed well of any kind with its per-kind CONFIG values. */
function addFixed(world: World, kind: WellKind, x: number, y: number): Well {
  let gm: number
  let radius: number
  if (kind === "star") {
    gm = CONFIG.well.starGm
    radius = CONFIG.well.starRadius
  } else if (kind === "blackhole") {
    gm = CONFIG.well.holeGm
    radius = CONFIG.well.holeRadius
  } else {
    gm = CONFIG.wellKinds[kind].gm
    radius = CONFIG.wellKinds[kind].radius
  }
  const w = makeWell(kind, nextId(world, kind), x, y, gm, radius)
  world.wells.push(w)
  return w
}

function addStar(world: World, x: number, y: number): Well {
  return addFixed(world, "star", x, y)
}

/** Black hole uniform over a disc of the given radius around the centre (classic draw order). */
function addHoleInDisc(world: World, maxDist: number): void {
  const dist = maxDist * Math.sqrt(rand(world))
  const angle = randRange(world, 0, TWO_PI)
  addFixed(world, "blackhole", Math.cos(angle) * dist, Math.sin(angle) * dist)
}

/** Well on a circular orbit, placed at its time-0 position with the tangential velocity. */
function addOrbiter(world: World, kind: WellKind, cx: number, cy: number, r: number, w: number, phase: number): Well {
  const well = addFixed(world, kind, 0, 0)
  well.orbit = { cx, cy, r, w, phase }
  well.x = cx + r * Math.cos(phase)
  well.y = cy + r * Math.sin(phase)
  well.vx = -r * w * Math.sin(phase)
  well.vy = r * w * Math.cos(phase)
  return well
}

function addZone(world: World, kind: Zone["kind"], x: number, y: number, r: number, strength: number): void {
  world.zones.push({ id: `zone-${world.zones.length + 1}`, kind, x, y, r, vx: 0, vy: 0, strength, eventId: null })
}

/** True if a circle (x, y, r) stays clear of every well's charge band (or surface) by 80 u. */
function clearOfWells(world: World, x: number, y: number, r: number): boolean {
  for (const w of world.wells) {
    if (Math.hypot(x - w.x, y - w.y) < r + Math.max(w.chargeRadius, w.radius) + 80) return false
  }
  return true
}
