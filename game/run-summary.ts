// What a finished run reports: whether it belongs in the Round best map and which arena it names
// on a share card. Pure module: no DOM, no React, so the shell's decisions stay testable.

import type { ArenaId } from "./types"

/** What kind of round is running, which decides the end-screen context. */
export type RunKind = "endless" | "round" | "campaign" | "daily"

/**
 * Whether a finished run updates the Round best-per-difficulty map. Round and Endless are that
 * mode's rounds; campaign levels and the daily challenge keep their own records.
 */
export function recordsRoundBest(kind: RunKind): boolean {
  return kind === "round" || kind === "endless"
}

/**
 * The arena a finished run was played in: the campaign level's for a level, the day's for the
 * daily challenge, and the arena the round started with for Round and Endless.
 */
export function runArena(
  kind: RunKind,
  arenas: { round: ArenaId; level: ArenaId | null; daily: ArenaId | null },
): ArenaId {
  if (kind === "campaign" && arenas.level) return arenas.level
  if (kind === "daily" && arenas.daily) return arenas.daily
  return arenas.round
}
