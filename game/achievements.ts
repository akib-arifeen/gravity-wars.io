// Local achievements and lifetime stats. Pure: no DOM, no Date, no storage access except through
// the storage parameter of loadProfile/saveProfile. The shell feeds it every step's events.
//
// CONTRACT — exported signatures and documented behaviour are fixed. Helpers go below PRIVATE.

import { ARENA_IDS } from "./arenas"
import { CONFIG } from "./config"
import { lethalRadius } from "./cosmic"
import type { ArenaId, Difficulty, GameEvent, PowerUpKind, RoundResult, World } from "./types"

export interface LifetimeStats {
  rounds: number
  wins: number
  winsByDifficulty: Record<Difficulty, number>
  /** Rounds played and won per arena. */
  arenaRounds: Record<ArenaId, number>
  arenaWins: Record<ArenaId, number>
  absorbs: number
  debris: number
  comets: number
  slingshots: number
  dashes: number
  repulses: number
  ults: number
  assists: number
  pickups: number
  /** Kinds of power-up ever collected. */
  pickupKinds: Record<PowerUpKind, boolean>
  bestMass: number
  topSpeed: number
  /** Seconds of play (countdown excluded). */
  timePlayed: number
  /** Highest mass reached in Endless mode. */
  endlessBest: number
}

export interface Profile {
  version: 1
  stats: LifetimeStats
  /** Achievement id -> unlock time (ms since epoch, as passed in by the caller). */
  achievements: Record<string, number>
}

export interface AchievementDef {
  id: string
  name: string
  description: string
}

/**
 * The achievement list, in display order. Conditions (player = world.bodies[0]):
 *  first_contact    "First Contact"   Absorb a rival.
 *  slingshot        "Slingshot"       Earn a slingshot.
 *  escape_velocity  "Escape Velocity" Reach a speed of 600 u/s.
 *  gravity_assist   "Gravity Assist"  Knock a rival into a well with a repulse (an assist).
 *  event_horizon    "Event Horizon"   Activate the Singularity.
 *  hungry_void      "Hungry Void"     Absorb a rival while your Singularity is active.
 *  comet_chaser     "Comet Chaser"    Eat a comet.
 *  power_hungry     "Power Hungry"    Collect every kind of power-up (lifetime).
 *  phase_diver      "Phase Diver"     Be inside a lethal well's kill distance while Phase is active, and survive the round's next 2 seconds.
 *  sunburn          "Sunburn"         Survive within 150 u of an active solar flare's edge.
 *  cadet            "Cadet"           Win on Easy.
 *  pilot            "Pilot"           Win on Normal.
 *  ace              "Ace"             Win on Hard.
 *  critical         "Critical Mass"   Win by reaching critical mass.
 *  last_light       "Last Light"      Win as the last body standing.
 *  grazer           "Grazer"          Win without absorbing a rival.
 *  hands_off        "Hands Off"       Win without ever pulling.
 *  hat_trick        "Hat Trick"       Absorb 3 rivals in one round.
 *  cartographer     "Cartographer"    Play a round in every arena.
 *  conqueror        "Conqueror"       Win in every arena.
 *  veteran          "Veteran"         Play 25 rounds.
 *  apex             "Apex"            Endless: hold rank 1 on the leaderboard for 10 seconds in a row while
 *                                     at 40 mass or more (so the opening, when everyone is small, does not count).
 *  survivor         "Survivor"        Endless: stay alive for 5 minutes in a single life.
 * (Endless sessions never call finishRound; trackStep handles apex/survivor and keeps
 *  stats.endlessBest = max(endlessBest, player mass) in endless mode.)
 */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: "first_contact", name: "First Contact", description: "Absorb a rival." },
  { id: "slingshot", name: "Slingshot", description: "Whip around a well fast enough to earn a slingshot." },
  { id: "escape_velocity", name: "Escape Velocity", description: "Reach a speed of 600." },
  { id: "gravity_assist", name: "Gravity Assist", description: "Repulse a rival into a star or the black hole." },
  { id: "event_horizon", name: "Event Horizon", description: "Activate the Singularity." },
  { id: "hungry_void", name: "Hungry Void", description: "Absorb a rival while your Singularity is active." },
  { id: "comet_chaser", name: "Comet Chaser", description: "Catch and eat a comet." },
  { id: "power_hungry", name: "Power Hungry", description: "Collect every kind of power-up." },
  { id: "phase_diver", name: "Phase Diver", description: "Dive through a star with Phase active and live." },
  { id: "sunburn", name: "Sunburn", description: "Survive right next to a solar flare." },
  { id: "cadet", name: "Cadet", description: "Win a round on Easy." },
  { id: "pilot", name: "Pilot", description: "Win a round on Normal." },
  { id: "ace", name: "Ace", description: "Win a round on Hard." },
  { id: "critical", name: "Critical Mass", description: "Win by reaching critical mass." },
  { id: "last_light", name: "Last Light", description: "Win as the last body standing." },
  { id: "grazer", name: "Grazer", description: "Win without absorbing a single rival." },
  { id: "hands_off", name: "Hands Off", description: "Win without ever using pull." },
  { id: "hat_trick", name: "Hat Trick", description: "Absorb three rivals in one round." },
  { id: "cartographer", name: "Cartographer", description: "Play a round in every arena." },
  { id: "conqueror", name: "Conqueror", description: "Win a round in every arena." },
  { id: "veteran", name: "Veteran", description: "Play 25 rounds." },
  { id: "apex", name: "Apex", description: "Hold first place on the Endless leaderboard for 10 seconds at 40 mass or more." },
  { id: "survivor", name: "Survivor", description: "Stay alive for five minutes in a single Endless life." },
]

/** Per-round facts gathered from events (plain data). */
export interface RoundTracker {
  absorbs: number
  absorbsDuringUlt: number
  pulled: boolean
  phaseDiveAt: number | null
  flareNearSurvivedFrom: number | null
  pickupKinds: Record<PowerUpKind, boolean>
  /** Endless: when the player's current #1 streak and current life started (world.time), or null. */
  apexSince: number | null
  lifeSince: number | null
}

export function emptyProfile(): Profile {
  const arenaCounts = (): Record<ArenaId, number> => ({ classic: 0, binary: 0, maw: 0, nebula: 0, belt: 0, vast: 0 })
  return {
    version: 1,
    stats: {
      rounds: 0,
      wins: 0,
      winsByDifficulty: { easy: 0, normal: 0, hard: 0 },
      arenaRounds: arenaCounts(),
      arenaWins: arenaCounts(),
      absorbs: 0,
      debris: 0,
      comets: 0,
      slingshots: 0,
      dashes: 0,
      repulses: 0,
      ults: 0,
      assists: 0,
      pickups: 0,
      pickupKinds: { overdrive: false, magnet: false, phase: false, bulk: false },
      bestMass: 0,
      topSpeed: 0,
      timePlayed: 0,
      endlessBest: 0,
    },
    achievements: {},
  }
}

export function newTracker(): RoundTracker {
  return {
    absorbs: 0,
    absorbsDuringUlt: 0,
    pulled: false,
    phaseDiveAt: null,
    flareNearSurvivedFrom: null,
    pickupKinds: { overdrive: false, magnet: false, phase: false, bulk: false },
    apexSince: null,
    lifeSince: null,
  }
}

const scratch: string[] = []
const NO_UNLOCKS: AchievementDef[] = Object.freeze([]) as unknown as AchievementDef[]

/** Unlock `id` once (no per-step allocation: ids collect in a module scratch array). */
function grant(profile: Profile, now: number, id: string): void {
  if (profile.achievements[id] === undefined) {
    profile.achievements[id] = now
    scratch.push(id)
  }
}

/**
 * Feed one step: the world after step() and that step's events. Updates the tracker and the
 * profile's stats that are known mid-round (topSpeed is taken at round end, not here), unlocks
 * any achievement whose condition is now met (profile.achievements[id] = now) and returns the
 * newly unlocked defs in ACHIEVEMENTS order (empty when none). Never unlocks an id twice.
 * Mid-round unlocks: first_contact, slingshot, escape_velocity (player speed > 600),
 * gravity_assist, event_horizon, hungry_void, comet_chaser, power_hungry, phase_diver, sunburn,
 * hat_trick. Win/round-count achievements unlock only in finishRound.
 * Returns a shared frozen empty array when nothing unlocked (do not mutate the result).
 */
export function trackStep(profile: Profile, tracker: RoundTracker, world: World, events: readonly GameEvent[], now: number): AchievementDef[] {
  scratch.length = 0
  const player = world.bodies[0]

  for (const ev of events) {
    switch (ev.type) {
      case "absorb":
        if (ev.eaterId === "player") {
          tracker.absorbs++
          if (player && player.ultActive > 0) tracker.absorbsDuringUlt++
          grant(profile, now, "first_contact")
          if (tracker.absorbsDuringUlt > 0) grant(profile, now, "hungry_void")
          if (tracker.absorbs >= 3) grant(profile, now, "hat_trick")
        }
        break
      case "slingshot":
        if (ev.bodyId === "player") grant(profile, now, "slingshot")
        break
      case "assist":
        if (ev.bodyId === "player") grant(profile, now, "gravity_assist")
        break
      case "ultStart":
        if (ev.bodyId === "player") grant(profile, now, "event_horizon")
        break
      case "eat":
        if (ev.bodyId === "player" && ev.kind === "comet") grant(profile, now, "comet_chaser")
        break
      case "pickup":
        if (ev.bodyId === "player") {
          tracker.pickupKinds[ev.kind] = true
          profile.stats.pickupKinds[ev.kind] = true
          const k = profile.stats.pickupKinds
          if (k.overdrive && k.magnet && k.phase && k.bulk) grant(profile, now, "power_hungry")
        }
        break
      case "cosmic":
        if (ev.kind === "solarFlare" && ev.stage === "end") {
          // -1 = the player already spent a full second near the flaring star.
          if (player && player.alive && tracker.flareNearSurvivedFrom !== null) {
            const from = tracker.flareNearSurvivedFrom
            if (from === -1 || world.time - from >= 1) grant(profile, now, "sunburn")
          }
          tracker.flareNearSurvivedFrom = null
        }
        break
      default:
        break
    }
  }

  if (world.mode === "endless" && player) {
    if (player.alive) {
      profile.stats.endlessBest = Math.max(profile.stats.endlessBest, player.mass)
      // Rank 1 = no living rival at least as heavy (the player is bodies[0], so it wins ties).
      let first = true
      for (let i = 1; i < world.bodies.length; i++) {
        const b = world.bodies[i]
        if (b.alive && b.mass > player.mass) {
          first = false
          break
        }
      }
      if (first && player.mass >= 40) {
        if (tracker.apexSince === null) tracker.apexSince = world.time
        else if (world.time - tracker.apexSince >= 10) grant(profile, now, "apex")
      } else {
        tracker.apexSince = null
      }
      if (tracker.lifeSince === null) tracker.lifeSince = world.time
      else if (world.time - tracker.lifeSince >= 300) grant(profile, now, "survivor")
    } else {
      tracker.apexSince = null
      tracker.lifeSince = null
    }
  }

  if (player && !player.alive) {
    // A death ends every in-progress streak (a dead body must not complete one later).
    tracker.phaseDiveAt = null
    tracker.flareNearSurvivedFrom = null
    tracker.apexSince = null
    tracker.lifeSince = null
  }

  if (player && player.alive) {
    if (Math.hypot(player.vx, player.vy) > 600) grant(profile, now, "escape_velocity")
    if (player.pulling) tracker.pulled = true

    // Phase diver: inside a lethal well's kill distance while Phase is active, still alive 2 s later.
    if (tracker.phaseDiveAt === null) {
      if (player.power.phase > 0) {
        for (const w of world.wells) {
          if (!w.lethal) continue
          const d = Math.hypot(player.x - w.x, player.y - w.y)
          if (d < lethalRadius(world, w) + player.radius * CONFIG.well.killOverlap) {
            tracker.phaseDiveAt = world.time
            break
          }
        }
      }
    } else if (world.time - tracker.phaseDiveAt >= 2) {
      grant(profile, now, "phase_diver")
    }

    // Sunburn: within lethalRadius + 150 of the flaring star for a continuous second, alive at the end.
    const ev = world.cosmic
    if (ev && ev.kind === "solarFlare" && ev.stage === "active") {
      const star = world.wells.find((w) => w.id === ev.targetId)
      if (star) {
        const near = Math.hypot(player.x - star.x, player.y - star.y) < lethalRadius(world, star) + 150
        const from = tracker.flareNearSurvivedFrom
        if (from === -1) {
          // already earned; waiting for the flare to end
        } else if (near) {
          if (from === null) tracker.flareNearSurvivedFrom = world.time
          else if (world.time - from >= 1) tracker.flareNearSurvivedFrom = -1
        } else {
          tracker.flareNearSurvivedFrom = null
        }
      }
    }
  }

  if (scratch.length === 0) return NO_UNLOCKS
  return ACHIEVEMENTS.filter((d) => scratch.includes(d.id))
}

/**
 * Fold a finished round into the lifetime stats (rounds, wins, per-difficulty/arena counts,
 * absorbs/debris/comets/slingshots/dashes/repulses/ults/assists/pickups from the player's
 * BodyStats, bestMass from peakMass, topSpeed, timePlayed += result.durationS) and unlock the
 * round-end achievements. Returns the newly unlocked defs (ACHIEVEMENTS order). Mutates profile.
 */
export function finishRound(profile: Profile, tracker: RoundTracker, world: World, result: RoundResult, now: number): AchievementDef[] {
  const got = new Set<string>()
  const unlock = (id: string) => {
    if (profile.achievements[id] === undefined) {
      profile.achievements[id] = now
      got.add(id)
    }
  }
  const st = profile.stats
  const ps = world.bodies[0].stats
  const won = result.playerWon

  st.rounds++
  st.arenaRounds[world.arena]++
  if (won) {
    st.wins++
    st.winsByDifficulty[world.difficulty]++
    st.arenaWins[world.arena]++
  }
  st.absorbs += ps.rivalsAbsorbed
  st.debris += ps.debrisEaten
  st.comets += ps.comets
  st.slingshots += ps.slingshots
  st.dashes += ps.dashes
  st.repulses += ps.repulses
  st.ults += ps.ults
  st.assists += ps.assists
  st.pickups += ps.pickups
  for (const k of Object.keys(tracker.pickupKinds) as PowerUpKind[]) {
    if (tracker.pickupKinds[k]) st.pickupKinds[k] = true
  }
  st.bestMass = Math.max(st.bestMass, ps.peakMass)
  st.topSpeed = Math.max(st.topSpeed, ps.topSpeed)
  st.timePlayed += result.durationS

  if (won) {
    if (world.difficulty === "easy") unlock("cadet")
    if (world.difficulty === "normal") unlock("pilot")
    if (world.difficulty === "hard") unlock("ace")
    if (result.reason === "criticalMass") unlock("critical")
    if (result.reason === "lastStanding") unlock("last_light")
    if (ps.rivalsAbsorbed === 0) unlock("grazer")
    if (!tracker.pulled) unlock("hands_off")
  }
  if (ARENA_IDS.every((id) => st.arenaRounds[id] > 0)) unlock("cartographer")
  if (ARENA_IDS.every((id) => st.arenaWins[id] > 0)) unlock("conqueror")
  if (st.rounds >= 25) unlock("veteran")

  return collect(got)
}

/** What an Endless fold has already added to the profile, so a later fold adds only the difference. */
export type EndlessFold = Readonly<
  Record<"time" | "rivalsAbsorbed" | "debrisEaten" | "comets" | "slingshots" | "dashes" | "repulses" | "ults" | "assists" | "pickups", number>
>

/**
 * Fold an Endless session into the lifetime stats. Safe to call repeatedly (hidden tab, page
 * hide, quit): pass the value returned by the previous call as `since` and only the difference
 * is added, so nothing is counted twice. Adds timePlayed (world.time), the player's cumulative
 * BodyStats (absorbs, debris, comets, slingshots, dashes, repulses, ults, assists, pickups) and
 * folds the maxima (endlessBest from world.endless.best, bestMass from peakMass, topSpeed). Does
 * not count a round or a win. Mutates profile; returns the snapshot to pass next time.
 */
export function finishEndlessSession(profile: Profile, world: World, tracker: RoundTracker, since?: EndlessFold): EndlessFold {
  const st = profile.stats
  const ps = world.bodies[0].stats
  const now: EndlessFold = {
    time: world.time,
    rivalsAbsorbed: ps.rivalsAbsorbed,
    debrisEaten: ps.debrisEaten,
    comets: ps.comets,
    slingshots: ps.slingshots,
    dashes: ps.dashes,
    repulses: ps.repulses,
    ults: ps.ults,
    assists: ps.assists,
    pickups: ps.pickups,
  }
  const d = (k: keyof EndlessFold): number => now[k] - (since ? since[k] : 0)
  if (world.endless) st.endlessBest = Math.max(st.endlessBest, world.endless.best)
  st.absorbs += d("rivalsAbsorbed")
  st.debris += d("debrisEaten")
  st.comets += d("comets")
  st.slingshots += d("slingshots")
  st.dashes += d("dashes")
  st.repulses += d("repulses")
  st.ults += d("ults")
  st.assists += d("assists")
  st.pickups += d("pickups")
  for (const k of Object.keys(tracker.pickupKinds) as PowerUpKind[]) {
    if (tracker.pickupKinds[k]) st.pickupKinds[k] = true
  }
  st.bestMass = Math.max(st.bestMass, ps.peakMass)
  st.topSpeed = Math.max(st.topSpeed, ps.topSpeed)
  st.timePlayed += d("time")
  return now
}

/** Storage key for the profile. */
export const PROFILE_KEY = "gw:profile:v1"

/**
 * Read the profile; any missing, corrupt or wrong-version data yields emptyProfile() merged with
 * whatever valid fields exist. Never throws (storage access errors included).
 */
export function loadProfile(storage: Pick<Storage, "getItem"> | null): Profile {
  const p = emptyProfile()
  let raw: unknown
  try {
    const text = storage ? storage.getItem(PROFILE_KEY) : null
    raw = text ? JSON.parse(text) : null
  } catch {
    return p
  }
  if (!isRecord(raw)) return p
  const rs = raw.stats
  if (isRecord(rs)) {
    const st = p.stats as unknown as Record<string, unknown>
    for (const k of Object.keys(st)) {
      const v = rs[k]
      if (typeof st[k] === "number") {
        if (isNum(v)) st[k] = v
      } else if (isRecord(v)) {
        const target = st[k] as Record<string, unknown>
        for (const sub of Object.keys(target)) {
          const sv = v[sub]
          if (typeof target[sub] === "number" ? isNum(sv) : typeof sv === "boolean") target[sub] = sv
        }
      }
    }
  }
  if (isRecord(raw.achievements)) {
    for (const def of ACHIEVEMENTS) {
      const v = raw.achievements[def.id]
      if (isNum(v)) p.achievements[def.id] = v
    }
  }
  return p
}

/** Write the profile. Never throws. */
export function saveProfile(storage: Pick<Storage, "setItem"> | null, profile: Profile): void {
  try {
    storage?.setItem(PROFILE_KEY, JSON.stringify(profile))
  } catch {
    // Storage full or blocked: the profile simply is not kept.
  }
}

// ---------------------------------------------------------------------------------------------
// PRIVATE — implementation helpers go below this line.
// ---------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

/** Newly unlocked ids -> defs, in ACHIEVEMENTS order. */
function collect(ids: ReadonlySet<string>): AchievementDef[] {
  return ACHIEVEMENTS.filter((d) => ids.has(d.id))
}
