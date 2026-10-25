// What the menu starts on. Kept out of page.tsx (a page module may only export the page) and
// pure, so the first-run rule can be tested without a DOM or localStorage.

import { PROFILE_KEY } from "@/game/achievements"
import { CAMPAIGN_PROGRESS_KEY } from "@/game/campaign"
import { DAILY_KEY } from "@/game/daily"
import type { ArenaId, Difficulty } from "@/game/types"
import { ARENA_CHOICES, BEST_KEY, type ArenaChoice } from "./components/Screens"

/** Storage keys for the menu's own selections. */
export const DIFFICULTY_KEY = "gw:difficulty"
export const ARENA_KEY = "gw:arena"

const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"]

/**
 * Keys that mean this browser has played before: a saved best, profile, daily record or campaign
 * progress — all written by a finished or in-progress run. Menu choices are deliberately not here,
 * the mode tab least of all: a visitor who clicked Round and left has still played nothing, and a
 * stored skill or arena is applied on its own terms anyway.
 */
export const HISTORY_KEYS = [BEST_KEY, PROFILE_KEY, DAILY_KEY, CAMPAIGN_PROGRESS_KEY]

/** Whether any saved key shows real play, read through the caller's storage accessor. */
export function hasPlayHistory(read: (key: string) => string | null): boolean {
  return HISTORY_KEYS.some((key) => read(key) !== null)
}

/**
 * The menu's starting skill and arena.
 *
 * `hasHistory` is the caller's reading of the saved play record: an existing player can have no
 * `gw:difficulty` key, so a missing key alone does not mean a newcomer. Without any history the
 * forgiving pair is Easy and the Classic arena, which has no cosmic events to survive while
 * learning. With history but no stored choice the returning player gets Normal and Random, which
 * neither punishes them with a downgrade nor pins them to one arena they never picked.
 *
 * A stored choice always wins, and an unreadable stored value is treated as absent.
 */
export function startDefaults(stored: {
  difficulty?: string | null
  arena?: string | null
  hasHistory?: boolean
}): { difficulty: Difficulty; arena: ArenaChoice } {
  const d = stored.difficulty
  const a = stored.arena
  const returning = stored.hasHistory === true
  return {
    difficulty: DIFFICULTIES.includes(d as Difficulty) ? (d as Difficulty) : returning ? "normal" : "easy",
    arena: a && (ARENA_CHOICES as string[]).includes(a) ? (a as ArenaId | "random") : returning ? "random" : "classic",
  }
}
