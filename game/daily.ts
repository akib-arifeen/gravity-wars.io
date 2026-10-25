// The daily challenge: one seeded round per UTC date, the same arena and skill for everyone, no
// backend. The score is the player's peak mass in that single round; the best score per date is
// kept locally, along with a streak of consecutive days played.
//
// Pure module: no DOM, no Date.now (the caller passes the date), no storage access beyond the
// storage parameter. Unit-tested.

import { ARENA_IDS } from "./arenas"
import type { ArenaId, BodyStats, Difficulty } from "./types"

/** One day's challenge. `seed` plus `arena` plus `difficulty` is the whole configuration. */
export interface DailyConfig {
  /** UTC date key, "YYYY-MM-DD". */
  key: string
  /** Days since 1970-01-01 UTC. */
  number: number
  /** World seed (the rival roster and the arena layout come from it). */
  seed: number
  arena: ArenaId
  /** "normal" every day; "hard" on every seventh challenge. */
  difficulty: Difficulty
  /** One line for the menu. */
  line: string
}

export const DAILY_KEY = "gw:daily:v1"

/**
 * Bump when anything that changes a replayed daily round changes: the engine, the arena layout,
 * CONFIG, bot brains or the trace format. A server rejects a run issued under another version
 * instead of replaying it with different rules.
 */
export const DAILY_RULESET_VERSION = 1

/**
 * How many days of records are kept. A year, so a full year's streak is still displayable; the
 * set stays bounded (one small record per day, well under a localStorage quota).
 */
export const DAILY_KEEP_DAYS = 365

/** UTC date key for a Date. */
export function dateKey(date: Date): string {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth() + 1
  const d = date.getUTCDate()
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

/** Days since 1970-01-01 UTC for a date key; NaN when the key is malformed. */
export function dayNumber(key: string): number {
  const t = Date.parse(`${key}T00:00:00Z`)
  if (!Number.isFinite(t)) return NaN
  return Math.floor(t / 86400000)
}

/** The key `n` days after the given key. */
export function addDays(key: string, n: number): string {
  const t = Date.parse(`${key}T00:00:00Z`) + n * 86400000
  return dateKey(new Date(t))
}

/**
 * The challenge for a date. Deterministic: the same UTC day gives every player the same config.
 * The arena rotates through every arena and the seed is a hash of the date key, so the roster
 * and the layout are identical for everyone that day.
 */
export function dailyChallenge(date: Date): DailyConfig {
  const key = dateKey(date)
  const number = dayNumber(key)
  const seed = (hash32(key) % 2147483646) + 1
  const arena = ARENA_IDS[hash32(`${key}:arena`) % ARENA_IDS.length]
  const difficulty: Difficulty = number % 7 === 6 ? "hard" : "normal"
  const line = `${arenaName(arena)} · ${difficulty} · one run today`
  return { key, number, seed, arena, difficulty, line }
}

/**
 * The daily config the menu and the next run should use at `now`: the caller's cached config
 * while it still belongs to today, a fresh challenge once the UTC date has rolled over.
 */
export function refreshDaily(current: DailyConfig | null, now: Date): DailyConfig {
  if (current && current.key === dateKey(now)) return current
  return dailyChallenge(now)
}

/** The daily score for a finished round: peak mass, rounded. */
export function dailyScore(stats: BodyStats): number {
  return Math.max(0, Math.round(stats.peakMass))
}

/** One day's local record. */
export interface DailyRecord {
  key: string
  best: number
  runs: number
}

export interface DailyProgress {
  version: 1
  /** Date key -> record. Only recent days are kept. */
  days: Record<string, DailyRecord>
}

export function emptyDaily(): DailyProgress {
  return { version: 1, days: {} }
}

/**
 * Read the daily progress. Missing, corrupt or unknown data yields an empty progress; records with
 * an unknown shape are dropped. Never throws.
 */
export function loadDaily(storage: Pick<Storage, "getItem"> | null): DailyProgress {
  let raw: unknown = null
  try {
    const text = storage ? storage.getItem(DAILY_KEY) : null
    raw = text ? JSON.parse(text) : null
  } catch {
    return emptyDaily()
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyDaily()
  const days = (raw as { days?: unknown }).days
  if (typeof days !== "object" || days === null || Array.isArray(days)) return emptyDaily()
  const out: Record<string, DailyRecord> = {}
  for (const [key, value] of Object.entries(days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
    if (typeof value !== "object" || value === null) continue
    const v = value as { best?: unknown; runs?: unknown }
    const best = typeof v.best === "number" && Number.isFinite(v.best) ? Math.max(0, Math.round(v.best)) : 0
    const runs = typeof v.runs === "number" && Number.isFinite(v.runs) ? Math.max(1, Math.floor(v.runs)) : 1
    out[key] = { key, best, runs }
  }
  return { version: 1, days: out }
}

/** Write the daily progress. Never throws. */
export function saveDaily(storage: Pick<Storage, "setItem"> | null, progress: DailyProgress): void {
  try {
    storage?.setItem(DAILY_KEY, JSON.stringify(progress))
  } catch {
    // Storage blocked or full: the record simply is not kept.
  }
}

export interface DailyResult {
  progress: DailyProgress
  /** The best for this date after the run. */
  best: number
  /** True when this run set a new best for the date. */
  isBest: boolean
  /** Consecutive days played, counting back from today (0 when today has no record). */
  streak: number
}

/**
 * Fold one finished run into the daily progress: raise the date's best, count the run, and drop
 * records older than DAILY_KEEP_DAYS. Pure: returns a new progress.
 */
export function recordDailyRun(progress: DailyProgress, config: DailyConfig, score: number): DailyResult {
  const prev = progress.days[config.key]
  const best = Math.max(prev?.best ?? 0, Math.round(score))
  const mine: DailyRecord = { key: config.key, best, runs: (prev?.runs ?? 0) + 1 }
  const days: Record<string, DailyRecord> = { ...progress.days, [config.key]: mine }
  const oldest = addDays(config.key, -DAILY_KEEP_DAYS)
  for (const key of Object.keys(days)) {
    if (key < oldest) delete days[key]
  }
  const next: DailyProgress = { version: 1, days }
  return {
    progress: next,
    best,
    isBest: best > (prev?.best ?? 0),
    streak: dailyStreak(next, config.key),
  }
}

/**
 * Consecutive days played, counting back from `today` (or from yesterday when today has no run
 * yet, so a streak is still shown before the day's run). 0 when there is no streak.
 */
export function dailyStreak(progress: DailyProgress, today: string): number {
  let cursor = progress.days[today] ? today : addDays(today, -1)
  let streak = 0
  // Bounded by the records kept, so this cannot loop forever on corrupt data.
  for (let i = 0; i < DAILY_KEEP_DAYS + 1; i++) {
    if (!progress.days[cursor]) break
    streak++
    cursor = addDays(cursor, -1)
  }
  return streak
}

// ---------------------------------------------------------------------------------------------
// PRIVATE helpers
// ---------------------------------------------------------------------------------------------

/** Deterministic 32-bit hash of a string (FNV-1a then a mix), 0..2^32-1. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

function arenaName(id: ArenaId): string {
  switch (id) {
    case "classic":
      return "Classic"
    case "binary":
      return "Binary"
    case "maw":
      return "The Maw"
    case "nebula":
      return "Nebula Field"
    case "belt":
      return "The Belt"
    case "vast":
      return "The Vast"
  }
}
