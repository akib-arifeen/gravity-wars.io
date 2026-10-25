// Boss encounters for the campaign. Three set pieces sit on top of the unmodified engine:
//
// - The Leviathan (a body boss): a huge rival that hunts you, telegraphs a gravity maw, and splits
//   into fragments when it loses a third of its mass.
// - Twin Pulsars (an environmental boss): two extra pulsar wells on slow orbits sweep the field
//   with beams you have to read and time.
// - The Void King (a body boss): a heavier rival that telegraphs a Singularity collapse and lunges.
//
// A body boss is an ordinary Body driven through the ordinary Intent seam, so step() stays
// untouched and deterministic. Everything here runs in the shell, outside the fixed step: it only
// reads the world and supplies intents / spawns the encounter before the first step.
//
// CONTRACT — exported signatures and documented behaviour are fixed. Helpers go below PRIVATE.

import { emptyAssist } from "./assist"
import { botIntent, createBotBrain, type BotBrain } from "./bots"
import { CONFIG } from "./config"
import { radiusForMass } from "./engine"
import type { BossId, CampaignLevel } from "./campaign"
import type { Body, GameEvent, Intent, Well, World } from "./types"

export type BossKind = Extract<BossId, "leviathan" | "voidKing">
export type BossPhase = "stalk" | "telegraph" | "attack" | "recover"
export type BossSpecial = "pull" | "ult" | "lunge"

/** Per-boss numbers. Everything is seconds unless stated. */
export interface BossSpec {
  name: string
  /** Body colour. */
  color: string
  /** Mass at the start of the fight. The player must out-grow it to absorb it. */
  mass: number
  /** Seconds of stalking before the first special (the player's grace period). */
  firstSpecialIn: number
  /** Seconds between specials. */
  cooldown: number
  /** Seconds of play before the boss wakes up and starts hunting (the player's opening). */
  wakeAfter: number
  /** Boss movement intent is scaled by this (the boss is heavy, not nimble). */
  moveScale: number
  /** Mass the boss may grow to, as a multiple of its starting mass. */
  growthCap: number
  /** Mass the boss loses per player repulse hit, as a multiple of its starting mass. */
  repulseDamage: number
  /** Telegraph duration per special. */
  telegraph: Record<BossSpecial, number>
  /** Attack duration per special (lunge is a single dash step). */
  attack: Record<BossSpecial, number>
  /** Seconds of recovery after an attack. */
  recover: number
}

export const BOSS_SPECS: Readonly<Record<BossKind, BossSpec>> = {
  leviathan: {
    name: "The Leviathan",
    color: "#ff7bd5",
    mass: 55,
    firstSpecialIn: 7,
    cooldown: 9,
    wakeAfter: 12,
    moveScale: 0.82,
    growthCap: 1.1,
    repulseDamage: 0.09,
    telegraph: { pull: 1.2, ult: 1.2, lunge: 0.9 },
    attack: { pull: 1.6, ult: 1.6, lunge: 0 },
    recover: 1.1,
  },
  voidKing: {
    name: "The Void King",
    color: "#c9a8ff",
    mass: 52,
    firstSpecialIn: 8,
    cooldown: 8,
    wakeAfter: 14,
    moveScale: 0.8,
    growthCap: 1.1,
    repulseDamage: 0.08,
    telegraph: { pull: 1.1, ult: 1.5, lunge: 0.9 },
    attack: { pull: 1.6, ult: 5.2, lunge: 0 },
    recover: 1.3,
  },
}

/** Human labels for the HUD. */
export const BOSS_SPECIAL_LABEL: Readonly<Record<BossSpecial, string>> = {
  pull: "GRAVITY MAW",
  ult: "COLLAPSE",
  lunge: "LUNGE",
}

/** One split fragment's mass share of the boss's current mass and the number of fragments. */
const SPLIT_SHARE = 0.22
const SPLIT_COUNT = 2
/** The Leviathan splits when its mass falls to this fraction of its starting mass. */
const SPLIT_AT = 0.6

export interface BossState {
  id: string
  kind: BossKind
  name: string
  startingMass: number
  /** Seconds in the current phase. */
  t: number
  /** Seconds of stalking before the next special (grace after spawn, then the cooldown). */
  nextIn: number
  phase: BossPhase
  /** The special the current cycle is telegraphing/attacking with, or null while stalking. */
  special: BossSpecial | null
  /** The special the next cycle will use (alternates between pull and lunge, or ult and lunge). */
  nextSpecial: BossSpecial
  /** Total mass the player's repulses have chipped away; it caps how far the boss can regrow. */
  damageTaken: number
  /** True once the Leviathan has split (it only splits once). */
  splitDone: boolean
  /** True once the body is gone. */
  defeated: boolean
  brain: BotBrain
}

/** What the shell needs to draw the boss bar and the telegraphs. */
export interface BossHud {
  name: string
  kind: BossKind
  /** 0..1 of the starting mass. */
  healthPct: number
  mass: number
  phase: BossPhase
  special: BossSpecial | null
  /** Seconds the current phase has run and the phase's length (for the telegraph ring). */
  t: number
  total: number
  splitDone: boolean
}

/** The visible HUD phrase for the fight's state. Stable between health updates. */
export function bossPhaseText(boss: BossHud): string {
  const label = boss.special ? BOSS_SPECIAL_LABEL[boss.special] : ""
  if (boss.phase === "telegraph") return `${label} INCOMING`
  if (boss.phase === "attack") {
    return label === "GRAVITY MAW" ? "GRAVITY MAW ACTIVE" : label === "COLLAPSE" ? "COLLAPSE ACTIVE" : "LUNGE"
  }
  return boss.splitDone ? "WOUNDED" : "HUNTING"
}

/**
 * One sentence for the screen-reader status region. The HUD updates several times a second, but
 * this text only changes when the fight's state does (phase, special, wounded), so the region
 * cannot read the health bar aloud continuously.
 */
export function bossAnnouncement(boss: BossHud): string {
  if (boss.phase === "telegraph" && boss.special) {
    return `${boss.name}: ${BOSS_SPECIAL_LABEL[boss.special].toLowerCase()} incoming.`
  }
  if (boss.phase === "attack" && boss.special) {
    return `${boss.name}: ${BOSS_SPECIAL_LABEL[boss.special].toLowerCase()} active.`
  }
  if (boss.splitDone) return `${boss.name} is wounded.`
  return `${boss.name} is hunting you.`
}

export interface EncounterState {
  levelId: string
  /** The body boss, or null for the Twin Pulsars set piece. */
  boss: BossState | null
  /** Pulsars added for the Twin Pulsars set piece (0 otherwise). */
  pulsars: number
}

export interface SplitEvent {
  type: "split"
  fragments: number
}

/**
 * Set up a campaign level's world before the first step: apply the level's time limit and, when
 * the level has a boss, build the encounter. Mutates `world`; deterministic for a given level.
 * Returns null for an ordinary level.
 */
export function applyCampaignLevel(world: World, level: CampaignLevel): EncounterState | null {
  world.timeLeft = level.timeLimit
  if (level.boss === null) return null
  if (level.boss === "twinPulsars") {
    const added = addTwinPulsars(world)
    return { levelId: level.id, boss: null, pulsars: added }
  }
  const boss = addBodyBoss(world, level.boss, level.seed, level.id)
  return { levelId: level.id, boss, pulsars: 0 }
}

/**
 * The boss's intent for one fixed step. Mutates the boss state machine (phase timers), reads the
 * world, never mutates the world except through the returned Intent. A defeated boss returns
 * NO_INTENT-like data and sets `defeated`.
 */
export function bossIntent(world: World, boss: BossState): Intent {
  const body = findBody(world, boss.id)
  if (!body || !body.alive) {
    boss.defeated = true
    return { ax: 0, ay: 0, pull: false }
  }
  const spec = BOSS_SPECS[boss.kind]
  const player = world.bodies[0]
  // Stalk and recover: ordinary bot movement, with every ability stripped so the only abilities the
  // player ever sees are the telegraphed ones.
  const slow = spec.moveScale
  const wander = (): Intent => {
    const i = botIntent(world, boss.brain)
    return { ax: i.ax * slow, ay: i.ay * slow, pull: false }
  }
  switch (boss.phase) {
    case "stalk": {
      // The boss sleeps through the opening so the player can grow and read the field.
      if (world.time < spec.wakeAfter) return { ax: 0, ay: 0, pull: false }
      boss.t += CONFIG.dt
      if (boss.t >= boss.nextIn) startTelegraph(boss, spec, body)
      return wander()
    }
    case "telegraph": {
      boss.t += CONFIG.dt
      if (boss.t >= spec.telegraph[boss.special ?? "pull"]) startAttack(boss)
      // Brake hard and hold the line while the warning ring is up.
      return { ax: 0, ay: 0, pull: false }
    }
    case "attack": {
      boss.t += CONFIG.dt
      if (boss.special === "pull") {
        const aim = aimAt(body, player)
        if (boss.t >= spec.attack.pull) {
          endAttack(boss)
          return wander()
        }
        return { ax: aim.ax * 0.55, ay: aim.ay * 0.55, pull: true }
      }
      if (boss.special === "ult") {
        const firing = boss.t <= CONFIG.dt * 1.5 && body.ult >= 1 && body.ultActive === 0
        if (!firing && body.ultActive === 0) {
          endAttack(boss)
          return wander()
        }
        // Channel in place: the collapse drags the player in, so chasing adds nothing, and
        // thrusting through the whole window has flown the boss into the maw's black hole.
        return { ax: 0, ay: 0, pull: body.ultActive > 0, ult: firing }
      }
      // lunge: one dash step, then recover
      const aim = aimAt(body, player)
      endAttack(boss)
      return { ax: aim.ax, ay: aim.ay, pull: false, dash: true }
    }
    case "recover": {
      boss.t += CONFIG.dt
      if (boss.t >= spec.recover) {
        boss.phase = "stalk"
        boss.special = null
        boss.t = 0
        boss.nextIn = spec.cooldown
      }
      return wander()
    }
  }
}

/** The current HUD view of the boss, or null once it is defeated. */
export function bossHud(world: World, boss: BossState): BossHud | null {
  const body = findBody(world, boss.id)
  if (!body || !body.alive) return null
  const spec = BOSS_SPECS[boss.kind]
  const total =
    boss.phase === "stalk" || boss.phase === "recover"
      ? spec.recover
      : boss.phase === "telegraph"
        ? spec.telegraph[boss.special ?? "pull"]
        : spec.attack[boss.special ?? "pull"]
  return {
    name: boss.name,
    kind: boss.kind,
    healthPct: Math.max(0, Math.min(1, body.mass / boss.startingMass)),
    mass: body.mass,
    phase: boss.phase,
    special: boss.special,
    t: boss.t,
    total,
    splitDone: boss.splitDone,
  }
}

/**
 * Read-only facts the shell folds into the end screen: the boss body is dead. Returns false for
 * environmental encounters (there is no single body to kill).
 */
export function bossDefeated(world: World, encounter: EncounterState | null): boolean {
  if (!encounter || !encounter.boss) return false
  return encounter.boss.defeated || findBody(world, encounter.boss.id) === undefined
}

/**
 * Per-step maintenance after step(), for a body boss: split the Leviathan the first time it is
 * wounded enough, and notice its death. Returns the events that happened (usually empty), which
 * the shell turns into toasts / sounds.
 */
export function updateBoss(world: World, encounter: EncounterState | null): Array<{ type: "split" | "defeated"; fragments?: number }> {
  const boss = encounter?.boss
  if (!boss || boss.defeated) return []
  const body = findBody(world, boss.id)
  if (!body || !body.alive) {
    boss.defeated = true
    return [{ type: "defeated" }]
  }
  // The boss grows by eating the field, but only up to a ceiling, and every repulse the player
  // lands permanently lowers that ceiling: the wound does not heal.
  const cap = Math.max(1, boss.startingMass * BOSS_SPECS[boss.kind].growthCap - boss.damageTaken)
  if (body.mass > cap) {
    body.mass = cap
    body.radius = radiusForMass(cap)
  }
  if (boss.kind === "leviathan" && !boss.splitDone && body.mass <= boss.startingMass * SPLIT_AT) {
    const fragments = splitLeviathan(world, boss, body)
    boss.splitDone = true
    return [{ type: "split", fragments }]
  }
  return []
}

/**
 * A player repulse hit landed on the boss: the shockwave chips its mass away. This is the only
 * way the player can hurt the boss before being heavy enough to absorb it, and it is what drives
 * the Leviathan down to its split threshold. The boss never drops below half of its starting mass
 * before the split (so the split happens exactly once, then the core can be eaten) and never
 * below a quarter afterwards. Returns the mass lost.
 */
export function damageBoss(world: World, encounter: EncounterState | null, amount: number): number {
  const boss = encounter?.boss
  if (!boss || boss.defeated) return 0
  const body = findBody(world, boss.id)
  if (!body || !body.alive) return 0
  const spec = BOSS_SPECS[boss.kind]
  const floor = boss.kind === "leviathan" && !boss.splitDone ? boss.startingMass * SPLIT_AT : boss.startingMass * 0.25
  const before = body.mass
  // The floor bounds what a hit may take away; it must never add mass. A split can leave the core
  // below the post-split floor, so the result is clamped against the current mass as well.
  const after = Math.min(before, Math.max(floor, before - Math.max(1, amount)))
  body.mass = after
  if (after < before) {
    body.radius = radiusForMass(after)
    boss.damageTaken += before - after
    return before - after
  }
  return 0
}

/** The default damage one player repulse does to the boss. */
export function repulseDamageAgainst(boss: BossState): number {
  return boss.startingMass * BOSS_SPECS[boss.kind].repulseDamage
}

// ---------------------------------------------------------------------------------------------
// PRIVATE — encounter construction and helpers
// ---------------------------------------------------------------------------------------------

function findBody(world: World, id: string): Body | undefined {
  for (const b of world.bodies) if (b.id === id) return b
  return undefined
}

function startTelegraph(boss: BossState, spec: BossSpec, body: Body): void {
  // The Void King fights alone: with no rival to absorb its meter never fills, so every collapse
  // was downgraded to a lunge. Its signature ultimate counts as armed; the engine still spends the
  // meter and runs the collapse through the ordinary path. Any other ult with no charge still
  // downgrades.
  boss.special = boss.nextSpecial
  if (boss.special === "ult" && boss.kind === "voidKing") body.ult = 1
  if (boss.special === "ult" && body.ult < 1) boss.special = "lunge"
  boss.nextSpecial =
    boss.special === "pull" || boss.special === "ult" ? "lunge" : boss.kind === "voidKing" ? "ult" : "pull"
  boss.phase = "telegraph"
  boss.t = 0
}

function startAttack(boss: BossState): void {
  boss.phase = "attack"
  boss.t = 0
}

function endAttack(boss: BossState): void {
  boss.phase = "recover"
  boss.t = 0
}

/** Unit-ish vector from `body` toward the player, (0, 0) when they share a centre. */
function aimAt(body: Body, player: Body): { ax: number; ay: number } {
  const dx = player.x - body.x
  const dy = player.y - body.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-6) return { ax: 0, ay: 0 }
  return { ax: dx / d, ay: dy / d }
}

/** Add the Twin Pulsars set piece: two pulsars on slow, opposite orbits, each with a sweep beam. */
function addTwinPulsars(world: World): number {
  const kind = CONFIG.wellKinds.pulsar
  const baseAngle = clearAngle(world, 620, 16)
  const sets = [
    { phase: baseAngle, w: 0.32, beamPhase: 0 },
    { phase: baseAngle + Math.PI, w: -0.32, beamPhase: Math.PI / 2 },
  ]
  const orbitR = 620
  const beamLength = 900
  const beamAccel = 480
  for (let i = 0; i < sets.length; i++) {
    const s = sets[i]
    const x = Math.cos(s.phase) * orbitR
    const y = Math.sin(s.phase) * orbitR
    const well: Well = {
      id: `pulsar-twin-${i + 1}`,
      kind: "pulsar",
      x,
      y,
      vx: -Math.sin(s.phase) * orbitR * s.w,
      vy: Math.cos(s.phase) * orbitR * s.w,
      gm: kind.gm,
      radius: kind.radius,
      chargeRadius: kind.chargeRadius,
      chargeRate: kind.chargeRate,
      lethal: true,
      orbit: { cx: 0, cy: 0, r: orbitR, w: s.w, phase: s.phase },
      beam: { w: 0.42, phase: s.beamPhase, halfWidth: CONFIG.pulsarBeam.halfWidth, length: beamLength, accel: beamAccel },
    }
    world.wells.push(well)
  }
  return sets.length
}

/** Turn one of the existing bots into the body boss and pull it clear of the player. */
function addBodyBoss(world: World, kind: BossKind, seed: number, levelId: string): BossState {
  const spec = BOSS_SPECS[kind]
  let body = world.bodies.find((b) => b.kind === "bot")
  if (!body) {
    body = spawnBody(world, {
      id: "boss",
      name: spec.name,
      color: spec.color,
      mass: spec.mass,
      x: 0,
      y: 0,
      skill: "hard",
    })
    world.bodies.push(body)
  } else {
    body.id = "boss"
    body.name = spec.name
    body.color = spec.color
    body.skill = "hard"
    body.mass = spec.mass
    body.radius = radiusForMass(spec.mass)
    body.stats.peakMass = spec.mass
    body.shield = Math.max(body.shield, 1.5)
  }
  // Park the boss on the far side of the field, clear of every well: 16 deterministic candidates.
  const player = world.bodies[0]
  const base = Math.atan2(body.y - player.y, body.x - player.x)
  const spot = bestSpot(world, base, 1200, player)
  body.x = spot.x
  body.y = spot.y
  body.px = spot.x
  body.py = spot.y
  body.vx = 0
  body.vy = 0
  void seed
  void levelId
  return {
    id: "boss",
    kind,
    name: spec.name,
    startingMass: spec.mass,
    t: 0,
    nextIn: spec.firstSpecialIn,
    phase: "stalk",
    damageTaken: 0,
    special: null,
    nextSpecial: kind === "voidKing" ? "ult" : "pull",
    splitDone: false,
    defeated: false,
    brain: createBotBrain("boss", "hard", 4242 + spec.mass),
  }
}

/** Split the wounded Leviathan into fragments and shrink the core. Returns the fragment count. */
function splitLeviathan(world: World, boss: BossState, body: Body): number {
  const current = body.mass
  const fragmentMass = Math.max(CONFIG.body.startMass, current * SPLIT_SHARE)
  const take = fragmentMass * SPLIT_COUNT
  // Mass-conserving: the fragments carry exactly what the core gives up, and the core never falls
  // below a normal body (the floor economics of the split, not a damage floor).
  body.mass = Math.max(CONFIG.body.startMass, current - take)
  body.radius = radiusForMass(body.mass)
  for (let i = 0; i < SPLIT_COUNT; i++) {
    const angle = (i / SPLIT_COUNT) * Math.PI * 2 + Math.PI / 2
    const distance = body.radius + radiusForMass(fragmentMass) + 90
    let x = body.x + Math.cos(angle) * distance
    let y = body.y + Math.sin(angle) * distance
    const r = Math.hypot(x, y)
    const lim = world.arenaRadius - 140
    if (r > lim) {
      x = (x / r) * lim
      y = (y / r) * lim
    }
    const fragment = spawnBody(world, {
      id: `boss-frag-${i + 1}`,
      name: `${boss.name} fragment`,
      color: "#ff9fb8",
      mass: fragmentMass,
      x,
      y,
      skill: "normal",
    })
    fragment.shield = 1.2
    world.bodies.push(fragment)
  }
  return SPLIT_COUNT
}

/** A fresh Body with every field the engine contract expects. */
function spawnBody(
  world: World,
  opts: { id: string; name: string; color: string; mass: number; x: number; y: number; skill: Body["skill"] },
): Body {
  void world
  return {
    id: opts.id,
    kind: "bot",
    name: opts.name,
    color: opts.color,
    x: opts.x,
    y: opts.y,
    vx: 0,
    vy: 0,
    px: opts.x,
    py: opts.y,
    mass: opts.mass,
    radius: radiusForMass(opts.mass),
    energy: CONFIG.energy.max,
    alive: true,
    shield: CONFIG.body.spawnShield,
    warpCooldown: 0,
    idleTime: 0,
    thrusting: false,
    pulling: false,
    charging: false,
    sail: 0,
    dashCd: 0,
    repulseCd: 0,
    ult: 0,
    ultActive: 0,
    power: { overdrive: 0, magnet: 0, phase: 0 },
    slingCd: 0,
    assist: emptyAssist(),
    lastHitBy: "",
    lastHitAt: -1e9,
    skill: opts.skill,
    stats: {
      debrisEaten: 0,
      crystals: 0,
      rivalsAbsorbed: 0,
      peakMass: opts.mass,
      dashes: 0,
      repulses: 0,
      ults: 0,
      slingshots: 0,
      oberths: 0,
      assists: 0,
      pickups: 0,
      comets: 0,
      topSpeed: 0,
    },
  }
}

/** The clearest of 16 points on a ring, starting at `base` and used to keep the pulse pair off the arena's own wells. */
function clearAngle(world: World, radius: number, count: number): number {
  let best = 0
  let bestClearance = -Infinity
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2
    const x = Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    let clearance = Infinity
    for (const w of world.wells) {
      const d = Math.hypot(x - w.x, y - w.y) - Math.max(w.radius, w.chargeRadius)
      if (d < clearance) clearance = d
    }
    if (clearance > bestClearance) {
      bestClearance = clearance
      best = angle
    }
  }
  return best
}

/**
 * The roomiest of 16 points on a ring around `base`: clear of every well and at least BOSS_MIN_GAP
 * from the player when any candidate manages it (otherwise the farthest one wins).
 */
const BOSS_MIN_GAP = 950
function bestSpot(world: World, base: number, radius: number, player: Body): { x: number; y: number } {
  let bestX = 0
  let bestY = 0
  let bestScore = -Infinity
  let fallbackX = 0
  let fallbackY = 0
  let fallbackGap = -Infinity
  for (let i = 0; i < 16; i++) {
    const angle = base + (i / 16) * Math.PI * 2
    const x = Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    const r = Math.hypot(x, y)
    const lim = world.arenaRadius - 160
    const sx = r > lim ? (x / r) * lim : x
    const sy = r > lim ? (y / r) * lim : y
    let clearance = Infinity
    for (const w of world.wells) {
      const d = Math.hypot(sx - w.x, sy - w.y) - Math.max(w.radius, w.chargeRadius)
      if (d < clearance) clearance = d
    }
    const gap = Math.hypot(sx - player.x, sy - player.y)
    if (gap > fallbackGap) {
      fallbackGap = gap
      fallbackX = sx
      fallbackY = sy
    }
    // Only candidates clear of the player and of every well compete on well clearance.
    if (gap >= BOSS_MIN_GAP) {
      const score = Math.min(clearance, gap * 0.5)
      if (score > bestScore) {
        bestScore = score
        bestX = sx
        bestY = sy
      }
    }
  }
  if (bestScore === -Infinity) return { x: fallbackX, y: fallbackY }
  return { x: bestX, y: bestY }
}

/** Kept for tests that want to check the split threshold without re-deriving it. */
export const SPLIT_THRESHOLD_SHARE = SPLIT_AT

/** Re-exported engine event type for shell call sites. */
export type BossEvent = GameEvent
