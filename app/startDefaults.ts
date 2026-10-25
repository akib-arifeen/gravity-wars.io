// What the menu starts on. Kept out of page.tsx (a page module may only export the page) and
// pure, so the first-run rule can be tested without a DOM or localStorage.

import type { ArenaId, Difficulty } from "@/game/types"
import { ARENA_CHOICES, type ArenaChoice } from "./components/Screens"

const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"]

/**
 * The menu's starting skill and arena.
 *
 * `hasHistory` is the caller's reading of the saved play record (best scores, profile, daily
 * streak, campaign progress, any stored menu choice): an existing player can have no
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
