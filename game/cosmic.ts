// Cosmic events: one timed, announced event at a time (meteor showers, solar flares, gravity
// storms, wormhole storms, drifting nebulae, quantum anomalies). Pure and deterministic.
// Imports only config, rng, types and arenas.ts (never engine.ts: the engine imports this module).
//
// CONTRACT — exported signatures and documented behaviour are fixed. Helpers go below PRIVATE.

import { placeWormholePair } from "./arenas"
import { CONFIG } from "./config"
import { rand, randRange } from "./rng"
import type { CosmicEvent, CosmicKind, Well, World } from "./types"

export const COSMIC_KINDS: readonly CosmicKind[] = [
  "meteorShower",
  "solarFlare",
  "gravityStorm",
  "wormholeStorm",
  "nebulaDrift",
  "quantumAnomaly",
]

/** HUD/announcer copy for each event (no emoji). */
export const COSMIC_INFO: Readonly<Record<CosmicKind, { title: string; warning: string; active: string }>> = {
  meteorShower: { title: "Meteor shower", warning: "Debris incoming", active: "Free mass is falling" },
  solarFlare: { title: "Solar flare", warning: "A star is about to flare", active: "Stay clear of the flaring star" },
  gravityStorm: { title: "Gravity storm", warning: "Gravity is surging", active: "Every well pulls harder" },
  wormholeStorm: { title: "Wormhole storm", warning: "Wormholes destabilising", active: "Wormholes are jumping" },
  nebulaDrift: { title: "Nebula drift", warning: "", active: "A drag cloud is drifting through" },
  quantumAnomaly: { title: "Quantum anomaly", warning: "", active: "Charge your Singularity inside it" },
}

/**
 * Advance the cosmic event system by one fixed step. Called by step() once per playing step
 * (see the engine's step() order). Mutates world; pushes {type:"cosmic"} events into
 * world.events.
 *
 * - If world.cosmic is null: world.nextCosmicIn -= dt; when it reaches <= 0, start an event:
 *   pick a kind uniformly from those VALID for this world (solarFlare needs a star; wormholeStorm
 *   needs wormholes; others always valid), then create it in stage "warning" if its CONFIG
 *   warning > 0 else "active". Emit stage "warning" or "start" accordingly. Placement:
 *     meteorShower: centre at a random point at r 300..arenaRadius-500, r = cfg.radius;
 *     solarFlare: a random star; x/y = that star; r = star.radius * cfg.radiusMul; targetId = id;
 *     gravityStorm: x = y = 0, r = arenaRadius;
 *     wormholeStorm: x = y = 0, r = arenaRadius;
 *     nebulaDrift: start just inside the wall at a random angle, moving toward the opposite side
 *       at cfg.speed; r = cfg.radius; adds a Zone {kind "nebula", strength cfg.drag,
 *       eventId = event id};
 *     quantumAnomaly: centre at r 300..1200 not within 400 of any lethal well; r = cfg.radius;
 *       adds a Zone {kind "anomaly", strength CONFIG.zones.anomalyUlt, eventId}.
 * - Stage "warning": t += dt; at t >= warning switch to "active", t = 0, emit "start" (for
 *   nebula/anomaly the zone exists from creation).
 * - Stage "active": t += dt; per-step effects:
 *     meteorShower: request debris via the returned spawn count (see return value);
 *     wormholeStorm: every cfg.every seconds of active time, re-place the pair with
 *       placeWormholePair(world) (arenas.ts);
 *     nebulaDrift: the zone moves by (vx, vy) * dt (zones move in step(); nothing extra here).
 *   At t >= duration: end — remove zones with this eventId, emit "end", world.cosmic = null,
 *   world.nextCosmicIn = a draw in CONFIG.cosmic.gap.
 * - Escalation: while world.timeLeft <= CONFIG.escalation.last, gaps are halved (the draw when
 *   an event ends is multiplied by 0.5).
 *
 * Returns how many meteor debris pieces step() should spawn this step: while a meteor shower is
 * ACTIVE, floor(tAfter * rate) - floor(tBefore * rate) where t is the event's active time before
 * and after this step's increment; otherwise 0. step() places them (see step 11).
 */
export function updateCosmic(world: World): number {
  const dt = CONFIG.dt
  const ev = world.cosmic

  if (!ev) {
    world.nextCosmicIn -= dt
    if (world.nextCosmicIn > 0) return 0
    startEvent(world)
    return 0
  }

  if (ev.stage === "warning") {
    ev.t += dt
    if (ev.t >= ev.warning) {
      ev.stage = "active"
      ev.t = 0
      emit(world, ev, "start")
    }
    return 0
  }

  // Active.
  const before = ev.t
  ev.t += dt
  let meteors = 0
  if (ev.kind === "meteorShower") {
    const rate = CONFIG.cosmic.meteorShower.rate
    meteors = Math.floor(ev.t * rate) - Math.floor(before * rate)
  } else if (ev.kind === "wormholeStorm") {
    const every = CONFIG.cosmic.wormholeStorm.every
    if (Math.floor(ev.t / every) > Math.floor(before / every)) placeWormholePair(world)
  }
  if (ev.t >= ev.duration) {
    for (const z of world.zones) {
      if (z.eventId === ev.id) {
        ev.x = z.x
        ev.y = z.y
      }
    }
    world.zones = world.zones.filter((z) => z.eventId !== ev.id)
    emit(world, ev, "end")
    world.cosmic = null
    world.nextCosmicIn = drawGap(world)
  }
  return meteors
}

/** Multiplier on every well's gm right now (gravityStorm active: CONFIG.cosmic.gravityStorm.gmMul; else 1). */
export function gmScale(world: World): number {
  const ev = world.cosmic
  return ev && ev.kind === "gravityStorm" && ev.stage === "active" ? CONFIG.cosmic.gravityStorm.gmMul : 1
}

/**
 * The radius at which this well kills right now: well.radius, or well.radius *
 * CONFIG.cosmic.solarFlare.radiusMul while a solar flare targeting it is ACTIVE (not during the
 * warning). Non-lethal wells return well.radius (they are solid instead).
 */
export function lethalRadius(world: World, well: Well): number {
  const ev = world.cosmic
  if (well.lethal && ev && ev.kind === "solarFlare" && ev.stage === "active" && ev.targetId === well.id) {
    return well.radius * CONFIG.cosmic.solarFlare.radiusMul
  }
  return well.radius
}

// ---------------------------------------------------------------------------------------------
// PRIVATE — implementation helpers go below this line.
// ---------------------------------------------------------------------------------------------

function drawGap(world: World): number {
  const gap = randRange(world, CONFIG.cosmic.gap[0], CONFIG.cosmic.gap[1])
  return world.timeLeft <= CONFIG.escalation.last ? gap * 0.5 : gap
}

function emit(world: World, ev: CosmicEvent, stage: "warning" | "start" | "end"): void {
  world.events.push({ type: "cosmic", kind: ev.kind, stage, x: ev.x, y: ev.y, r: ev.r, targetId: ev.targetId })
}

function startEvent(world: World): void {
  const valid: CosmicKind[] = []
  for (const k of COSMIC_KINDS) {
    if (k === "solarFlare" && !world.wells.some((w) => w.kind === "star")) continue
    if (k === "wormholeStorm" && world.wormholes.length === 0) continue
    valid.push(k)
  }
  if (valid.length === 0) {
    world.nextCosmicIn = drawGap(world)
    return
  }
  const kind = valid[Math.min(valid.length - 1, Math.floor(rand(world) * valid.length))]
  const cfg = CONFIG.cosmic[kind]
  const ev: CosmicEvent = {
    id: world.nextCosmicId++,
    kind,
    stage: cfg.warning > 0 ? "warning" : "active",
    t: 0,
    warning: cfg.warning,
    duration: cfg.duration,
    x: 0,
    y: 0,
    r: 0,
    targetId: "",
  }
  const TWO_PI = Math.PI * 2
  if (kind === "meteorShower") {
    const m = CONFIG.cosmic.meteorShower
    const d = randRange(world, 300, Math.max(301, world.arenaRadius - 500))
    const a = randRange(world, 0, TWO_PI)
    ev.x = Math.cos(a) * d
    ev.y = Math.sin(a) * d
    ev.r = m.radius
  } else if (kind === "solarFlare") {
    const stars = world.wells.filter((w) => w.kind === "star")
    const star = stars[Math.min(stars.length - 1, Math.floor(rand(world) * stars.length))]
    ev.x = star.x
    ev.y = star.y
    ev.r = star.radius * CONFIG.cosmic.solarFlare.radiusMul
    ev.targetId = star.id
  } else if (kind === "gravityStorm" || kind === "wormholeStorm") {
    ev.r = world.arenaRadius
  } else if (kind === "nebulaDrift") {
    const n = CONFIG.cosmic.nebulaDrift
    const a = randRange(world, 0, TWO_PI)
    const start = world.arenaRadius - 100
    ev.x = Math.cos(a) * start
    ev.y = Math.sin(a) * start
    ev.r = n.radius
    world.zones.push({
      id: `zone-e${ev.id}`,
      kind: "nebula",
      x: ev.x,
      y: ev.y,
      r: n.radius,
      vx: -Math.cos(a) * n.speed,
      vy: -Math.sin(a) * n.speed,
      strength: n.drag,
      eventId: ev.id,
    })
  } else {
    const q = CONFIG.cosmic.quantumAnomaly
    const maxD = Math.max(301, Math.min(1200, world.arenaRadius - q.radius))
    for (let tries = 0; tries < 100; tries++) {
      const d = randRange(world, 300, maxD)
      const a = randRange(world, 0, TWO_PI)
      ev.x = Math.cos(a) * d
      ev.y = Math.sin(a) * d
      let ok = true
      for (const w of world.wells) {
        if (w.lethal && Math.hypot(ev.x - w.x, ev.y - w.y) < 400) {
          ok = false
          break
        }
      }
      if (ok) break
    }
    ev.r = q.radius
    world.zones.push({
      id: `zone-e${ev.id}`,
      kind: "anomaly",
      x: ev.x,
      y: ev.y,
      r: q.radius,
      vx: 0,
      vy: 0,
      strength: CONFIG.zones.anomalyUlt,
      eventId: ev.id,
    })
  }
  world.cosmic = ev
  emit(world, ev, ev.stage === "warning" ? "warning" : "start")
}
