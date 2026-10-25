// What the menu starts on. Kept out of page.tsx (a page module may only export the page) and
// pure, so the first-run rule can be tested without a DOM or localStorage.

import type { ArenaId, Difficulty } from "@/game/types"
import { ARENA_CHOICES, type ArenaChoice } from "./components/Screens"

/**
 * A first run (nothing saved) gets the forgiving pair: Easy and the Classic arena, which has no
 * cosmic events to survive while learning. A returning player's own choice always wins, and an
 * unreadable value falls back to the same forgiving default.
 */
export function startDefaults(stored: { difficulty?: string | null; arena?: string | null }): {
  difficulty: Difficulty
  arena: ArenaChoice
} {
  const d = stored.difficulty
  const a = stored.arena
  return {
    difficulty: d === "easy" || d === "normal" || d === "hard" ? d : "easy",
    arena: a && (ARENA_CHOICES as string[]).includes(a) ? (a as ArenaId | "random") : "classic",
  }
}
