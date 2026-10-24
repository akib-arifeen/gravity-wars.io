// Share cards: one short text line for a finished run, handed to the Web Share API or the
// clipboard. Pure text building (unit-tested), plus one thin browser helper.
//
// No analytics, no network call, no URL shortener: the text is returned to the caller and only
// leaves the device when the player taps Share.

import type { CampaignLevel } from "./campaign"
import type { BodyStats, Difficulty, RoundResult } from "./types"

/** The public game URL, used in every card. */
export const GAME_URL = "https://gravity-warsio.vercel.app"

export interface ShareCard {
  title: string
  text: string
}

export type ShareInput =
  | { kind: "round"; result: RoundResult; stats: BodyStats; arenaName: string; difficulty: Difficulty }
  | { kind: "campaign"; level: CampaignLevel; goalMet: boolean; stars: number; bonusMet: boolean; relicFound: boolean; peakMass: number }
  | { kind: "daily"; key: string; score: number; best: number; streak: number; arenaName: string }
  | { kind: "endless"; best: number; kills: number; deaths: number }

const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: "Easy", normal: "Normal", hard: "Hard" }

/**
 * Build the share card for a finished run. Text only (no image), no emoji, no undefined values:
 * every branch produces a complete sentence plus the URL.
 */
export function shareCard(input: ShareInput): ShareCard {
  switch (input.kind) {
    case "round": {
      const title = "Gravity Wars"
      const how = input.result.playerWon ? "won" : "fell"
      const reason = reasonPhrase(input.result)
      const text = `Gravity Wars · ${input.arenaName} (${DIFFICULTY_LABEL[input.difficulty]}): ${how}${reason} — peak mass ${Math.round(input.stats.peakMass)}, ${Math.round(input.stats.rivalsAbsorbed)} absorbed.\n${GAME_URL}`
      return { title, text }
    }
    case "campaign": {
      const state = input.goalMet ? "goal met" : "goal missed"
      const stars = `${input.stars}/3 stars`
      const extras = [input.bonusMet ? "bonus" : "", input.relicFound ? "relic found" : ""].filter(Boolean).join(", ")
      const tail = extras ? `, ${extras}` : ""
      return {
        title: "Gravity Wars · The Long Fall",
        text: `Gravity Wars · The Long Fall — ${input.level.index}. ${input.level.name}: ${state}, ${stars}${tail}. Peak mass ${Math.round(input.peakMass)}.\n${GAME_URL}`,
      }
    }
    case "daily": {
      const isBest = input.best > 0 && input.score >= input.best ? "personal best" : `best ${input.best}`
      const streak = input.streak > 1 ? `, ${input.streak}-day streak` : ""
      return {
        title: "Gravity Wars · Daily",
        text: `Gravity Wars · Daily ${input.key} on ${input.arenaName}: peak mass ${input.score} (${isBest}${streak}).\n${GAME_URL}`,
      }
    }
    case "endless": {
      return {
        title: "Gravity Wars · Endless",
        text: `Gravity Wars · Endless: best mass ${Math.round(input.best)}, ${Math.round(input.kills)} absorbed, ${Math.round(input.deaths)} deaths. The arena never sleeps.\n${GAME_URL}`,
      }
    }
  }
}

/** True when the browser exposes the Web Share API. */
export function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function"
}

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed"

/**
 * Share the card: native share sheet when available, clipboard otherwise. A dismissed native
 * sheet is "cancelled" (no fallback, the player chose not to share). Never throws.
 */
export async function shareOrCopy(card: ShareCard): Promise<ShareOutcome> {
  if (canNativeShare()) {
    try {
      await navigator.share({ title: card.title, text: card.text })
      return "shared"
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return "cancelled"
      // Anything else (permissions, no share targets) falls through to the clipboard.
    }
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(card.text)
      return "copied"
    }
  } catch {
    // Clipboard blocked: fall through.
  }
  return "failed"
}

function reasonPhrase(result: RoundResult): string {
  if (result.reason === "criticalMass") return result.playerWon ? " on critical mass" : ""
  if (result.reason === "lastStanding") return result.playerWon ? " as the last body standing" : ""
  if (result.reason === "timeUp") return result.playerWon ? " on mass at time up" : " on mass at time up"
  return ""
}
