// Which copy the in-round HUD keeps, and how the touch leaderboard opens and closes.
//
// Pure: the HUD renders exactly what these functions return, so the phone layout can be tested
// without a DOM. The shell's `layout` prop is the only desktop/phone input.

import type { DeathCause, LeaderboardEntry } from "@/game/types"

export type HudLayout = "desktop" | "touch"
export type HudMode = "endless" | "round" | "campaign"

/**
 * The one plain-language sentence that teaches the gravity-assist burn. The menu, the countdown,
 * the pause help and the respawn tip all use these exact words, so a newcomer meets one phrase.
 * The technical name ("prograde burn window open") rides along on the dash control for assistive
 * tech, after the same words the screen shows.
 */
export const BURN_TIP = "Fly close past a star, then DASH ALONG PATH for a speed boost."

/**
 * The single respawn tip, chosen by what just killed the player. Shown on the Endless respawn
 * overlay for the first death of a round only, so it teaches once instead of nagging.
 */
export function respawnTip(cause: DeathCause): string {
  switch (cause.by) {
    case "star":
    case "whitedwarf":
    case "neutronstar":
      return "Stars refill energy, but the surface is fatal: skim the edge. " + BURN_TIP
    case "blackhole":
      return "Nothing escapes the black hole once you are inside. Steer wide. " + BURN_TIP
    case "pulsar":
      return "Pulsar beams sweep the field. Cross between pulses. " + BURN_TIP
    default:
      return "Anything ringed in red can absorb you. Break away early. " + BURN_TIP
  }
}

/**
 * The live speed readout. `speed` is the body's absolute speed in world units, not its speed
 * relative to a well, so the label says SPEED and nothing more. `surgeMul` is the temporary
 * speed-ceiling multiplier from the burn, not a measured ratio of anything, so it is shown as
 * "×1.24 cap" only while a surge is running.
 *
 * The HUD splits this into parts so a narrow phone can drop the prefix and the ceiling before they
 * run under the mass panel; the whole string stays in the DOM as the accessible copy at every width.
 */
export function speedValue(speed: number): string {
  return `${Math.max(0, Math.round(speed))} u/s`
}

/** The surge ceiling as a suffix (" · ×1.24 cap"), or "" when no surge is running. */
export function speedCapText(surge: number, surgeMul: number): string {
  return surge > 0 && surgeMul > 1 ? ` · ×${surgeMul.toFixed(2)} cap` : ""
}

/** The whole readout on one line: "SPEED 342 u/s · ×1.24 cap". */
export function speedLine(speed: number, surge: number, surgeMul: number): string {
  return `SPEED ${speedValue(speed)}${speedCapText(surge, surgeMul)}`
}

/** The quiet gap between two unready-Singularity answers (ms). */
export const ULT_HINT_MS = 4000

/**
 * Whether an unready Singularity press should be answered now. The engine ignores the press
 * silently, so the shell answers it with the charge; `last` is the time of the previous answer, so
 * a mash gets one message per gap instead of one per press.
 */
export function ultHintDue(pressed: boolean, ult: number, now: number, last: number): boolean {
  return pressed && ult < 1 && now - last >= ULT_HINT_MS
}

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

/**
 * The dash control's accessible name. A payable burn window is announced here and nowhere else:
 * the name changes while the window is open (and back when it closes) without a live region
 * speaking a 0.35 s window late, twice, or over the boss line, and without touching the boss text.
 * It repeats the on-screen phrase first ("DASH ALONG PATH") and only then the technical name.
 */
export function dashName(base: string, burnReady: boolean): string {
  return burnReady ? `${base}, DASH ALONG PATH (prograde burn window open)` : base
}

/**
 * The answer to an unready Singularity press: what is missing and how to fill it. Pure so the
 * shell keeps no copy of its own, and the charge is always read from the live value.
 */
export function ultHintNotice(ult: number): { kicker: string; name: string; description: string } {
  return {
    kicker: "Singularity",
    name: `${Math.round(ult * 100)}% charged`,
    description: "Absorb mass to fill the charge. Ready at 100%.",
  }
}

/** The tip the respawn overlay shows: the teaching line on the round's first death, then nothing. */
export function firstDeathTip(deathsSeen: number, cause: DeathCause): string {
  return deathsSeen === 0 ? respawnTip(cause) : ""
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
