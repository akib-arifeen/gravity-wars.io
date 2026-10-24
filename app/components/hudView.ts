// Which copy the in-round HUD keeps, and how the touch leaderboard opens and closes.
//
// Pure: the HUD renders exactly what these functions return, so the phone layout can be tested
// without a DOM. The shell's `layout` prop is the only desktop/phone input.

import type { LeaderboardEntry } from "@/game/types"

export type HudLayout = "desktop" | "touch"
export type HudMode = "endless" | "round" | "campaign"

/** Round clock as m:ss, rounded up so 0.2 s left still reads 0:01. */
export function formatClock(s: number): string {
  const t = Math.max(0, Math.ceil(s))
  const m = Math.floor(t / 60)
  const r = t % 60
  return `${m}:${r < 10 ? "0" : ""}${r}`
}

/** The rank pill's short text: the rank, or "Out" once the player is eliminated. */
export function rankPill(rank: number, alive: number): string {
  return rank > 0 ? `#${rank} / ${alive}` : "Out"
}

/** The pill's accessible name, which spells out the rank the visible text only implies. */
export function rankPillLabel(rank: number, alive: number): string {
  return rank > 0 ? `Leaderboard, rank ${rank} of ${alive}` : "Leaderboard, eliminated"
}

/**
 * Rows the board shows. Touch keeps it behind the rank pill: closed, it is the top three plus the
 * player; open, the whole board. The wide layout always shows every row.
 */
export function leaderboardRows(rows: LeaderboardEntry[], opts: { touch: boolean; open: boolean }): LeaderboardEntry[] {
  if (!opts.touch || opts.open) return rows
  const top = rows.slice(0, 3)
  const you = rows.find((r) => r.isPlayer)
  return you && !top.includes(you) ? [...top, you] : top
}

/** Escape closes an open board; there is no other key in the disclosure. */
export function dismissesLeaderboard(key: string, open: boolean): boolean {
  return open && key === "Escape"
}

export interface CentreHud {
  /** Mode/level label above the numbers, or null when the phone layout drops it. */
  tag: string | null
  /** Arena name, desktop Endless only: the phone shows it on the countdown instead. */
  arena: string | null
  /** Round clock, or null in Endless (which has no clock). */
  timer: string | null
  /** Standings line, or null where the phone layout leaves that to the rank pill. */
  rank: string | null
  /** Campaign objective, kept on every layout: it is what the level is won by. */
  goal: string | null
}

export interface CentreInput {
  timeLeft: number
  rank: number
  alive: number
  arenaName: string
  campaign: { index: number; total: number; name: string; goalLine: string } | null
}

/** "Rank 4 / 11", or "Eliminated" between respawns. */
export function rankLine(rank: number, alive: number): string {
  return rank > 0 ? `Rank ${rank} / ${alive}` : "Eliminated"
}

/**
 * The centre block. Phones keep the clock, the objective and the rank pill, and drop the mode
 * label, the arena name and the duplicated standings line.
 */
export function centreHud(mode: HudMode, layout: HudLayout, o: CentreInput): CentreHud {
  const wide = layout === "desktop"
  if (mode === "campaign" && o.campaign) {
    const c = o.campaign
    return {
      tag: wide ? `LEVEL ${c.index} / ${c.total} · ${c.name.toUpperCase()}` : `LEVEL ${c.index} / ${c.total}`,
      arena: null,
      timer: formatClock(o.timeLeft),
      rank: null,
      goal: c.goalLine,
    }
  }
  if (mode === "endless") {
    return {
      tag: wide ? "ENDLESS" : null,
      arena: wide ? o.arenaName : null,
      timer: null,
      rank: wide ? rankLine(o.rank, o.alive) : null,
      goal: null,
    }
  }
  return { tag: null, arena: null, timer: formatClock(o.timeLeft), rank: rankLine(o.rank, o.alive), goal: null }
}
