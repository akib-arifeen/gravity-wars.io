// Campaign mode: "The Long Fall". Twelve handcrafted levels in three sectors, each one an
// ordinary engine round with a goal, a bonus objective and a hidden relic. Three levels end in a
// boss encounter (see boss.ts).
//
// Pure module: no React, no DOM, no engine import. Everything here is plain data in, plain data
// out, so the rules are unit-tested without a browser.
//
// CONTRACT — exported signatures and documented behaviour are fixed. Helpers go below PRIVATE.

import { CONFIG } from "./config"
import type { ArenaId, BodyStats, Difficulty, RoundResult } from "./types"

/** The engine round-end reason a campaign goal is met by (see evaluateGoal). */
export type CampaignGoalKind =
  | "criticalMass"
  | "lastStanding"
  | "timeUp"
  | "survive"
  | "absorb"
  | "relic"
  | "mass"
  | "slingshot"

export interface CampaignGoal {
  kind: CampaignGoalKind
  /** One line for the menu: what the player has to do to win the level. */
  line: string
  /** Only for "absorb" (rivals to absorb), "mass" (peak mass) and "slingshot" (slingshots). */
  count?: number
}

/** The secondary objective: one extra star on a successful run. */
export type CampaignBonusKind = "time" | "mass" | "absorb" | "slingshot" | "assist"

export interface CampaignBonus {
  kind: CampaignBonusKind
  /** Seconds for "time", mass for "mass", count for the rest. */
  value: number
  /** One line for the menu. */
  line: string
}

/** The three boss encounters. */
export type BossId = "leviathan" | "twinPulsars" | "voidKing"

/** The abilities that unlock from campaign stars, in unlock order. */
export type AbilityId = "dash" | "repulse" | "ult"

export interface AbilityUnlock {
  id: AbilityId
  /** Total campaign stars needed. */
  stars: number
  name: string
  description: string
}

/**
 * Abilities unlock from total stars: Dash after the first level, Repulse before the sector I
 * boss, the Singularity before the sector II boss. Endless and Round are not gated; the campaign
 * is where the fall teaches you one tool at a time.
 */
export const ABILITY_UNLOCKS: readonly AbilityUnlock[] = [
  { id: "dash", stars: 1, name: "Dash", description: "A hard burst of thrust that also burns energy. Shift, or the DASH button." },
  { id: "repulse", stars: 3, name: "Repulse", description: "A shockwave that shoves debris and rivals away. Knocks rivals into wells. E, or REPULSE." },
  { id: "ult", stars: 6, name: "Singularity", description: "Absorbing charges it. Fire it to become a black hole for five seconds. Q, or ULT." },
]

export interface CampaignSector {
  id: 1 | 2 | 3
  name: string
  /** One line for the menu. */
  line: string
}

export const CAMPAIGN_SECTORS: readonly CampaignSector[] = [
  { id: 1, name: "Descent", line: "The fall starts at the edge of a dead system." },
  { id: 2, name: "The Signal", line: "Something is broadcasting from inside the storm." },
  { id: 3, name: "The Void", line: "The signal leads down." },
]

export interface CampaignLevel {
  id: string
  /** 1-based position in the campaign. */
  index: number
  /** 1, 2 or 3. */
  sector: 1 | 2 | 3
  name: string
  arena: ArenaId
  difficulty: Difficulty
  /** Fixed world seed: a handcrafted level always has the same layout. */
  seed: number
  /** Round time limit in seconds; the round ends (time up) when it runs out. */
  timeLimit: number
  /** Bodies in the round, the boss included when the level has one. */
  bots: number
  /** The boss encounter, or null for an ordinary level. */
  boss: BossId | null
  goal: CampaignGoal
  bonus: CampaignBonus
  /** One or two sentences of cosmic lore, shown next to the level. */
  brief: string
}

/**
 * The twelve campaign levels, in play order. Level n is locked until level n-1's goal is met.
 * The arena, the goal, the bonus, the time limit and the encounter are the whole design; the
 * engine is unchanged.
 */
export const CAMPAIGN_LEVELS: readonly CampaignLevel[] = [
  // --- Sector I: Descent -------------------------------------------------------------------
  {
    id: "fall-1",
    index: 1,
    sector: 1,
    name: "First Orbit",
    arena: "classic",
    difficulty: "easy",
    seed: 1101,
    timeLimit: 75,
    bots: 3,
    boss: null,
    goal: { kind: "mass", count: 45, line: "Reach 45 mass" },
    bonus: { kind: "mass", value: 60, line: "Reach 60 peak mass" },
    brief: "Two suns and a hungry hole at the edge of a dead system. Nothing here has fallen in a long time. Grow heavy enough to matter.",
  },
  {
    id: "fall-2",
    index: 2,
    sector: 1,
    name: "Twin Suns",
    arena: "binary",
    difficulty: "easy",
    seed: 1211,
    timeLimit: 90,
    bots: 3,
    boss: null,
    goal: { kind: "mass", count: 60, line: "Reach 60 mass" },
    bonus: { kind: "mass", value: 75, line: "Reach 75 peak mass" },
    brief: "The binary trades heat for pull, and the orbits do not care who is watching. Ride them, or be ridden into the dark.",
  },
  {
    id: "fall-3",
    index: 3,
    sector: 1,
    name: "The Maw",
    arena: "maw",
    difficulty: "easy",
    seed: 1307,
    timeLimit: 90,
    bots: 3,
    boss: null,
    goal: { kind: "absorb", count: 2, line: "Absorb two rivals" },
    bonus: { kind: "mass", value: 50, line: "Reach 50 peak mass" },
    brief: "One enormous hole at the centre, and bounty hunters already fat on the fall. Take two of them before the hole takes you.",
  },
  {
    id: "fall-4",
    index: 4,
    sector: 1,
    name: "The Leviathan",
    arena: "classic",
    difficulty: "normal",
    seed: 1401,
    timeLimit: 150,
    bots: 1,
    boss: "leviathan",
    goal: { kind: "lastStanding", line: "Defeat the Leviathan and everything it leaves behind" },
    bonus: { kind: "time", value: 120, line: "Win in under 2:00" },
    brief: "Something old is swimming through the field, and it has been hungry for a very long time. When it bleeds, it splits. Kill all of it.",
  },
  // --- Sector II: The Signal ---------------------------------------------------------------
  {
    id: "fall-5",
    index: 5,
    sector: 2,
    name: "Drift Field",
    arena: "nebula",
    difficulty: "normal",
    seed: 2503,
    timeLimit: 90,
    bots: 3,
    boss: null,
    goal: { kind: "mass", count: 55, line: "Reach 55 mass" },
    bonus: { kind: "mass", value: 70, line: "Reach 70 peak mass" },
    brief: "The nebula drags at everything that moves, and the signal gets louder the deeper you sink. Grow heavy before it swallows you.",
  },
  {
    id: "fall-6",
    index: 6,
    sector: 2,
    name: "Ring Runner",
    arena: "belt",
    difficulty: "easy",
    seed: 2601,
    timeLimit: 90,
    bots: 2,
    boss: null,
    goal: { kind: "mass", count: 100, line: "Reach 100 mass in the ring" },
    bonus: { kind: "slingshot", value: 3, line: "Earn three slingshots" },
    brief: "The belt is a ring of moving graves and moving shields. The signal bounces between the rocks. Whip the ring for three slingshots and stay alive.",
  },
  {
    id: "fall-7",
    index: 7,
    sector: 2,
    name: "Pulsar's Toll",
    arena: "nebula",
    difficulty: "hard",
    seed: 2709,
    timeLimit: 90,
    bots: 3,
    boss: null,
    goal: { kind: "survive", line: "Survive until the clock runs out" },
    bonus: { kind: "mass", value: 55, line: "Reach 55 peak mass" },
    brief: "The pulsar sweeps the field on a slow, patient arc. It was built to warn ships away. It will not warn you twice.",
  },
  {
    id: "fall-8",
    index: 8,
    sector: 2,
    name: "Twin Pulsars",
    arena: "classic",
    difficulty: "normal",
    seed: 2809,
    timeLimit: 80,
    bots: 2,
    boss: "twinPulsars",
    goal: { kind: "survive", line: "Survive the twin beams until the clock runs out" },
    bonus: { kind: "mass", value: 55, line: "Reach 55 peak mass" },
    brief: "Two pulsars, locked in step, sweeping the field clean. Read the beams, time the gap, and stay alive long enough to hear what the signal says.",
  },
  // --- Sector III: The Void -----------------------------------------------------------------
  {
    id: "fall-9",
    index: 9,
    sector: 3,
    name: "Event Horizon",
    arena: "maw",
    difficulty: "normal",
    seed: 3907,
    timeLimit: 150,
    bots: 1,
    boss: null,
    goal: { kind: "criticalMass", line: `Reach critical mass (${CONFIG.round.criticalMass})` },
    bonus: { kind: "time", value: 120, line: "Win in under 2:00" },
    brief: "The hole has grown since you were last here. Its event horizon is not a place, it is a promise. Reach critical mass before the field does.",
  },
  {
    id: "fall-10",
    index: 10,
    sector: 3,
    name: "Dead Signal",
    arena: "binary",
    difficulty: "hard",
    seed: 3009,
    timeLimit: 90,
    bots: 3,
    boss: null,
    goal: { kind: "relic", line: "Recover the source of the signal" },
    bonus: { kind: "mass", value: 50, line: "Reach 50 peak mass" },
    brief: "The signal has a source, and the source is somewhere in the twin system. Find it before the rivals find you.",
  },
  {
    id: "fall-11",
    index: 11,
    sector: 3,
    name: "Last Light",
    arena: "belt",
    difficulty: "normal",
    seed: 3113,
    timeLimit: 120,
    bots: 3,
    boss: null,
    goal: { kind: "lastStanding", line: "Be the last body in the ring" },
    bonus: { kind: "time", value: 100, line: "Win in under 1:40" },
    brief: "The belt has gone quiet. Every rival out here is a survivor, and every one of them knows the way out. Be the last light in the ring.",
  },
  {
    id: "fall-12",
    index: 12,
    sector: 3,
    name: "The Void King",
    arena: "maw",
    difficulty: "hard",
    seed: 3201,
    timeLimit: 150,
    bots: 1,
    boss: "voidKing",
    goal: { kind: "lastStanding", line: "Defeat the Void King" },
    bonus: { kind: "time", value: 150, line: "Win in under 2:30" },
    brief: "At the bottom of the fall, something wears the hole like a crown. It pulls. It waits. It has never had to be afraid. Make it afraid.",
  },
]

/** The level with this id, or undefined when the id is unknown. */
export function levelById(id: string): CampaignLevel | undefined {
  return CAMPAIGN_LEVELS.find((l) => l.id === id)
}

/** The level after this one, or undefined when this is the last level of the campaign. */
export function nextLevel(level: CampaignLevel): CampaignLevel | undefined {
  return CAMPAIGN_LEVELS.find((l) => l.index === level.index + 1)
}

/** The sector a level belongs to. */
export function sectorOf(level: CampaignLevel): CampaignSector {
  return CAMPAIGN_SECTORS[level.sector - 1]
}

/** True when the run used the relic: only the level's own relic counts, and only in that level. */
export interface CampaignRun {
  /** The hidden relic of this level was recovered during this run. */
  relicCollected: boolean
}

/** Mid-round progress used to end "get to X" levels the moment the goal is met. */
export interface GoalProgress {
  alive: boolean
  /** Current mass. */
  mass: number
  rivalsAbsorbed: number
  slingshots: number
  relicCollected: boolean
}

/**
 * True when a campaign goal has just been reached mid-round. A "get to X" goal (mass, absorb,
 * slingshot, relic) ends its level immediately; timer and win-condition goals (survive, timeUp,
 * criticalMass, lastStanding) return false because the engine decides when their round ends.
 */
export function goalProgressReached(level: CampaignLevel, p: GoalProgress): boolean {
  if (!p.alive) return false
  switch (level.goal.kind) {
    case "mass":
      return p.mass >= (level.goal.count ?? 0)
    case "absorb":
      return p.rivalsAbsorbed >= (level.goal.count ?? 0)
    case "slingshot":
      return p.slingshots >= (level.goal.count ?? 0)
    case "relic":
      return p.relicCollected
    default:
      return false
  }
}

/** Everything evaluateGoal needs: the engine's result, the player's stats and what the run found. */
export interface GoalContext extends CampaignRun {
  result: RoundResult
  stats: BodyStats
}

function playerAlive(result: RoundResult): boolean {
  const row = result.standings.find((s) => s.id === "player")
  return row !== undefined && row.alive
}

/**
 * True when the round result meets the level's goal.
 * - criticalMass: the player won by reaching critical mass.
 * - lastStanding: the player won as the last body standing (this is also how every boss level ends).
 * - timeUp: the player was the heaviest body when the clock ran out.
 * - survive: the player is alive at the end (any round-end reason but their own death).
 * - absorb: the player is alive and absorbed at least `count` rivals.
 * - relic: the player is alive and recovered the level's hidden relic.
 * - mass: the player is alive and reached the target mass (peak mass, so a late loss cannot undo it).
 * - slingshot: the player is alive and earned at least `count` slingshots.
 * Every other outcome misses the goal.
 */
export function evaluateGoal(level: CampaignLevel, ctx: GoalContext): boolean {
  const { result, stats, relicCollected } = ctx
  switch (level.goal.kind) {
    case "criticalMass":
      return result.playerWon && result.reason === "criticalMass"
    case "lastStanding":
      return result.playerWon && result.reason === "lastStanding"
    case "timeUp":
      return result.playerWon && result.reason === "timeUp"
    case "survive":
      return result.reason !== "playerDied" && playerAlive(result)
    case "absorb":
      return playerAlive(result) && stats.rivalsAbsorbed >= (level.goal.count ?? 0)
    case "relic":
      return playerAlive(result) && relicCollected
    case "mass":
      return playerAlive(result) && stats.peakMass >= (level.goal.count ?? 0)
    case "slingshot":
      return playerAlive(result) && stats.slingshots >= (level.goal.count ?? 0)
  }
}

/** True when the run met the level's bonus objective. */
export function evaluateBonus(level: CampaignLevel, ctx: GoalContext): boolean {
  const { bonus } = level
  switch (bonus.kind) {
    case "time":
      return ctx.result.durationS <= bonus.value
    case "mass":
      return ctx.stats.peakMass >= bonus.value
    case "absorb":
      return ctx.stats.rivalsAbsorbed >= bonus.value
    case "slingshot":
      return ctx.stats.slingshots >= bonus.value
    case "assist":
      return ctx.stats.assists >= bonus.value
  }
}

/**
 * Stars earned by one run: 0 when the goal was missed, otherwise 1 for the goal, +1 for the bonus
 * objective and +1 for recovering the level's relic (a relic recovered on a failed run still
 * counts towards the relic collection, but it cannot lift a failed run above 0 stars).
 */
export function starsFor(level: CampaignLevel, ctx: GoalContext): number {
  if (!evaluateGoal(level, ctx)) return 0
  let stars = 1
  if (evaluateBonus(level, ctx)) stars += 1
  if (ctx.relicCollected) stars += 1
  return stars
}

/** The hidden relic: how close (u, centre to centre) the player must get to collect it. */
export const RELIC_PICKUP_RADIUS = 30

/** A circular hazard the relic must not spawn inside. */
export interface RelicHazard {
  x: number
  y: number
  /** Visual/lethal radius of the hazard. */
  r: number
}

/**
 * Where a level's hidden relic drifts. Deterministic for a given seed: 32 candidate points on a
 * ring around the arena are scored by their clearance from every hazard, and the roomiest one
 * wins. The point is always inside the arena (well inside the wall) and clear of every hazard.
 * Pure: takes the hazard list rather than a World.
 */
export function relicPoint(opts: { seed: number; arenaRadius: number; hazards: readonly RelicHazard[] }): { x: number; y: number } {
  const seed = opts.seed
  const n = 32
  let bestX = 0
  let bestY = 0
  let bestScore = -Infinity
  for (let i = 0; i < n; i++) {
    const jitter = unit(seed, i * 3) * 0.09
    const angle = (i / n) * Math.PI * 2 + jitter
    const radius = opts.arenaRadius * (0.42 + unit(seed, i * 3 + 1) * 0.28)
    const x = Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    let clearance = arenaClearance(x, y, opts.arenaRadius)
    for (const h of opts.hazards) {
      const d = Math.hypot(x - h.x, y - h.y) - h.r
      if (d < clearance) clearance = d
    }
    if (clearance > bestScore) {
      bestScore = clearance
      bestX = x
      bestY = y
    }
  }
  return { x: bestX, y: bestY }
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

/** Which levels the player has beaten, how well, and which relics they have recovered. */
export interface CampaignProgress {
  version: 2
  /** Level id -> best stars (1..3). A level not in the map has not been won. */
  stars: Record<string, number>
  /** Ids of every level whose hidden relic has been recovered. */
  relics: string[]
}

/** Storage key for the campaign progress. */
export const CAMPAIGN_PROGRESS_KEY = "gw:campaign:v2"

/** The Phase B key, read once for migration. */
export const CAMPAIGN_LEGACY_KEY = "gw:campaign:v1"

/** A fresh, empty progress. */
export function emptyProgress(): CampaignProgress {
  return { version: 2, stars: {}, relics: [] }
}

/** How many levels the campaign has. */
export const CAMPAIGN_LEVEL_COUNT = CAMPAIGN_LEVELS.length

/** The most stars the whole campaign can award. */
export const MAX_CAMPAIGN_STARS = CAMPAIGN_LEVELS.length * 3

function clampStars(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0
  const n = Math.floor(v)
  if (n < 1) return 0
  if (n > 3) return 3
  return n
}

/**
 * Read the campaign progress. Missing, corrupt or unknown data yields an empty progress; ids that
 * are not campaign levels are dropped; stars are clamped to 1..3. A Phase B progress (v1, a `won`
 * list) is migrated to one star per won level the first time it is read. Never throws.
 */
export function loadProgress(storage: Pick<Storage, "getItem"> | null): CampaignProgress {
  let raw: unknown = null
  let legacy: unknown = null
  try {
    const text = storage ? storage.getItem(CAMPAIGN_PROGRESS_KEY) : null
    raw = text ? JSON.parse(text) : null
    if (raw === null) {
      const old = storage ? storage.getItem(CAMPAIGN_LEGACY_KEY) : null
      legacy = old ? JSON.parse(old) : null
    }
  } catch {
    return emptyProgress()
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const m = raw as { stars?: unknown; relics?: unknown }
    const stars: Record<string, number> = {}
    if (m.stars && typeof m.stars === "object" && !Array.isArray(m.stars)) {
      for (const [id, value] of Object.entries(m.stars as Record<string, unknown>)) {
        if (!levelById(id)) continue
        const s = clampStars(value)
        if (s > 0) stars[id] = s
      }
    }
    const relics: string[] = []
    if (Array.isArray(m.relics)) {
      for (const id of m.relics) {
        if (typeof id !== "string") continue
        if (!levelById(id)) continue
        if (relics.includes(id)) continue
        relics.push(id)
      }
    }
    return { version: 2, stars, relics }
  }
  // Legacy migration: v1 stored { won: string[] } at gw:campaign:v1.
  if (typeof legacy === "object" && legacy !== null && !Array.isArray(legacy)) {
    const won = (legacy as { won?: unknown }).won
    if (Array.isArray(won)) {
      const stars: Record<string, number> = {}
      for (const id of won) {
        if (typeof id !== "string") continue
        if (!levelById(id)) continue
        stars[id] = 1
      }
      return { version: 2, stars, relics: [] }
    }
  }
  return emptyProgress()
}

/** Write the campaign progress. Never throws. */
export function saveProgress(storage: Pick<Storage, "setItem"> | null, progress: CampaignProgress): void {
  try {
    storage?.setItem(CAMPAIGN_PROGRESS_KEY, JSON.stringify(progress))
  } catch {
    // Storage blocked or full: the progress simply is not kept.
  }
}

/** True when the player has met this level's goal. */
export function isWon(progress: CampaignProgress, level: CampaignLevel): boolean {
  return (progress.stars[level.id] ?? 0) > 0
}

/** Stars the player has on this level (0..3). */
export function starsOf(progress: CampaignProgress, level: CampaignLevel): number {
  return progress.stars[level.id] ?? 0
}

/** Total stars across the campaign. */
export function totalStars(progress: CampaignProgress): number {
  let total = 0
  for (const level of CAMPAIGN_LEVELS) total += starsOf(progress, level)
  return total
}

/** True when every level's goal has been met at least once. */
export function campaignComplete(progress: CampaignProgress): boolean {
  return CAMPAIGN_LEVELS.every((l) => isWon(progress, l))
}

/** True when every relic has been recovered. Recovering all of them unlocks the Voidtouched skin. */
export function allRelicsFound(progress: CampaignProgress): boolean {
  return CAMPAIGN_LEVELS.every((l) => progress.relics.includes(l.id))
}

/** The abilities the player's stars have unlocked, in unlock order. */
export function unlockedAbilities(progress: CampaignProgress): AbilityId[] {
  const total = totalStars(progress)
  return ABILITY_UNLOCKS.filter((a) => total >= a.stars).map((a) => a.id)
}

/** Abilities crossed by moving from one progress to another, in unlock order. */
export function newlyUnlockedAbilities(before: CampaignProgress, after: CampaignProgress): AbilityUnlock[] {
  const had = new Set(unlockedAbilities(before))
  return ABILITY_UNLOCKS.filter((a) => !had.has(a.id) && unlockedAbilities(after).includes(a.id))
}

/**
 * True when the level may be played: the first level always can, every later level only after the
 * previous level's goal has been met.
 */
export function isUnlocked(progress: CampaignProgress, level: CampaignLevel): boolean {
  if (level.index <= 1) return true
  const previous = CAMPAIGN_LEVELS.find((l) => l.index === level.index - 1)
  return previous !== undefined && isWon(progress, previous)
}

export interface RecordResult {
  progress: CampaignProgress
  /** Stars this run earned (0..3). */
  stars: number
  /** True when this run recovered the level's relic for the first time. */
  newRelic: boolean
  /** True when this run improved the level's best star count. */
  newBest: boolean
  /** Abilities whose star threshold this run crossed. */
  unlocked: AbilityUnlock[]
}

/**
 * Fold one finished run into the progress: keep the best star count per level, add the relic to
 * the collection when it was recovered, and report which abilities were unlocked by the change.
 * Pure: returns a new progress and never mutates the one passed in.
 */
export function recordRun(progress: CampaignProgress, level: CampaignLevel, stars: number, relicCollected: boolean): RecordResult {
  const before = unlockedAbilities(progress)
  const prevStars = starsOf(progress, level)
  const capped = clampStars(stars)
  const nextStars = Math.max(prevStars, capped)
  const nextRelics = relicCollected && !progress.relics.includes(level.id) ? [...progress.relics, level.id] : [...progress.relics]
  const next: CampaignProgress = { version: 2, stars: { ...progress.stars }, relics: nextRelics }
  if (nextStars > 0) next.stars[level.id] = nextStars
  const after = unlockedAbilities(next)
  const unlocked = ABILITY_UNLOCKS.filter((a) => before.indexOf(a.id) < 0 && after.indexOf(a.id) >= 0)
  return {
    progress: next,
    stars: capped,
    newRelic: nextRelics.length !== progress.relics.length,
    newBest: nextStars > prevStars,
    unlocked,
  }
}

/**
 * The level the menu offers: the first unlocked level the player has not met the goal on yet. When
 * every unlocked level is won, the last unlocked one is offered, so the player can replay it.
 */
export function currentLevel(progress: CampaignProgress): CampaignLevel {
  for (const level of CAMPAIGN_LEVELS) {
    if (isUnlocked(progress, level) && !isWon(progress, level)) return level
  }
  for (let i = CAMPAIGN_LEVELS.length - 1; i >= 0; i--) {
    if (isUnlocked(progress, CAMPAIGN_LEVELS[i])) return CAMPAIGN_LEVELS[i]
  }
  return CAMPAIGN_LEVELS[0]
}

// ---------------------------------------------------------------------------------------------
// PRIVATE helpers
// ---------------------------------------------------------------------------------------------

/** Deterministic [0, 1) from a seed and an index (no shared state, no Math.random). */
function unit(seed: number, index: number): number {
  let h = (seed ^ 0x9e3779b9) | 0
  h = Math.imul(h ^ (index + 1), 0x85ebca6b) | 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) | 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

/** Distance from a point out to the arena wall (positive inside). */
function arenaClearance(x: number, y: number, arenaRadius: number): number {
  return arenaRadius - Math.hypot(x, y)
}
