"use client"

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import type { AchievementDef } from "@/game/achievements"
import { ARENAS, ARENA_IDS } from "@/game/arenas"
import {
  ABILITY_UNLOCKS,
  CAMPAIGN_LEVELS,
  MAX_CAMPAIGN_STARS,
  isUnlocked,
  isWon,
  sectorOf,
  starsOf,
  totalStars,
  type AbilityId,
  type AbilityUnlock,
  type CampaignLevel,
  type CampaignProgress,
} from "@/game/campaign"
import type { DailyConfig } from "@/game/daily"
import { CONFIG } from "@/game/config"
import type { ArenaId, BodyStats, DeathCause, Difficulty, GameMode, RoundResult } from "@/game/types"
import { AbilityIcon, LockIcon, StarIcon } from "./Icons"
import { BURN_TIP } from "./hudView"
import { radioTabStop, radioTarget } from "./radioNav"

const BEST_KEY = "gw:best:v1"

/**
 * Move focus and selection in a role="radio" group with the APG arrow/Home/End keys. Disabled
 * radios are skipped; the target is focused before the selection changes so a re-render that
 * swaps the panel below cannot lose it.
 */
function onRadioKey(
  e: ReactKeyboardEvent<HTMLButtonElement>,
  refs: { current: (HTMLButtonElement | null)[] },
  index: number,
  count: number,
  isDisabled: ((index: number) => boolean) | undefined,
  choose: (index: number) => void,
) {
  const target = radioTarget(e.key, index, count, isDisabled)
  if (target === null) return
  e.preventDefault()
  refs.current[target]?.focus()
  choose(target)
}

export const DIFFICULTIES: { id: Difficulty; label: string; sub: string; endlessSub: string }[] = [
  { id: "easy", label: "Easy", sub: "3 slow rivals", endlessSub: "gentle start" },
  { id: "normal", label: "Normal", sub: "5 rivals that hunt", endlessSub: "mixed skills" },
  { id: "hard", label: "Hard", sub: "7 sharp rivals", endlessSub: "sharp from the start" },
]

/** The mode the menu offers: the two engine modes plus the campaign and the daily challenge. */
export type MenuMode = GameMode | "campaign" | "daily"

/** The Round goal for the selected starting skill (CONFIG.round.criticalMassByDifficulty). */
export function roundGoal(difficulty: Difficulty): number {
  return CONFIG.round.criticalMassByDifficulty[difficulty]
}

/** The round clock as the menu states it, from the engine's own duration. */
export const ROUND_LENGTH = `${Math.floor(CONFIG.round.duration / 60)}:${String(CONFIG.round.duration % 60).padStart(2, "0")}`

/** The one-line teaching each mode shows under its tab. Round names the goal for the chosen skill. */
export const MODES: { id: MenuMode; label: string; copy: (difficulty: Difficulty) => string }[] = [
  { id: "endless", label: "Endless", copy: () => "Endless \u2014 the arena never sleeps. Climb the leaderboard." },
  {
    id: "round",
    label: "Round",
    copy: (d) => `${ROUND_LENGTH} match. Reach ${roundGoal(d)} mass or be the last one left.`,
  },
  { id: "campaign", label: "Campaign", copy: () => "The Long Fall \u2014 twelve levels down three sectors, three bosses, one way out." },
  { id: "daily", label: "Daily", copy: () => "One seeded arena for everyone, today only. Your score is the peak mass of a single run." },
]

/** Everything the daily panel needs about today and the player's record. */
export interface DailyView {
  config: DailyConfig
  best: number
  streak: number
  runs: number
}

/** The campaign summary the end screen shows for a finished level. */
export interface CampaignOutcome {
  level: CampaignLevel
  goalMet: boolean
  bonusMet: boolean
  stars: number
  relicFound: boolean
  newBest: boolean
  unlocked: AbilityUnlock[]
  next: CampaignLevel | null
}

/** The daily summary the end screen shows for a finished daily run. */
export interface DailyOutcome {
  key: string
  score: number
  best: number
  isBest: boolean
  streak: number
}

export type ArenaChoice = ArenaId | "random"
export const ARENA_CHOICES: ArenaChoice[] = ["random", ...ARENA_IDS]

type BestMap = Partial<Record<Difficulty, { wins: number; bestMass: number }>>

export function loadBest(): BestMap {
  try {
    const raw = window.localStorage.getItem(BEST_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as BestMap) : {}
  } catch {
    return {}
  }
}

export function saveBest(difficulty: Difficulty, won: boolean, peakMass: number): void {
  try {
    const best = loadBest()
    const prev = best[difficulty] ?? { wins: 0, bestMass: 0 }
    best[difficulty] = {
      wins: prev.wins + (won ? 1 : 0),
      bestMass: Math.max(prev.bestMass, Math.round(peakMass)),
    }
    window.localStorage.setItem(BEST_KEY, JSON.stringify(best))
  } catch {
    // Storage unavailable (private mode, blocked): best stats are simply not kept.
  }
}

/** Death line shared by the round end screen and the Endless respawn overlay. */
export function deathLine(cause: DeathCause, nameOf: (id: string) => string): string {
  switch (cause.by) {
    case "body":
      return `Absorbed by ${nameOf(cause.killerId)}`
    case "star":
      return "Burned up in a star"
    case "blackhole":
      return "Lost to the black hole"
    case "whitedwarf":
      return "Burned up by a white dwarf"
    case "neutronstar":
      return "Crushed by a neutron star"
    default:
      return "Caught in a pulsar beam"
  }
}

function formatTime(s: number): string {
  const t = Math.max(0, Math.round(s))
  const m = Math.floor(t / 60)
  const r = t % 60
  return `${m}:${r < 10 ? "0" : ""}${r}`
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
      {muted ? (
        <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
      ) : (
        <path
          d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      )}
    </svg>
  )
}

/** Three stars, filled up to `n`. The count is the image's accessible name; the icons are decorative. */
function Stars({ n, size = 14 }: { n: number; size?: number }) {
  return (
    <span className="gw-stars" role="img" aria-label={`${n} of 3 stars`}>
      {[1, 2, 3].map((i) => (
        <span key={i} className={i <= n ? "gw-star-on" : "gw-star-off"} aria-hidden="true">
          <StarIcon size={size} filled={i <= n} />
        </span>
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------

// Both control lines ship in the HTML and CSS shows one. The server cannot evaluate
// (pointer: coarse), so picking a line during render made a coarse-pointer client's first render
// differ from the server's text: React hydration error #418. See .gw-controls in globals.css.
const DESKTOP_CONTROLS =
  "WASD or hold the mouse to thrust · Space or right-click to pull · Shift = DASH ALONG PATH · E repulse · Q Singularity · Esc pauses"
const TOUCH_CONTROLS = "Drag on the left to steer · hold PULL · tap the glowing DASH, REPULSE and ULT"

interface MenuProps {
  difficulty: Difficulty
  onDifficulty(d: Difficulty): void
  onPlay(): void
  muted: boolean
  onToggleMute(): void
  layout: "desktop" | "touch"
  arena: ArenaChoice
  onArena(a: ArenaChoice): void
  onStats(): void
  mode: MenuMode
  onMode(m: MenuMode): void
  endlessBest: number
  /** Campaign: the selected level and the levels whose goal is already met. */
  campaignLevel: CampaignLevel
  onCampaignLevel(l: CampaignLevel): void
  campaignProgress: CampaignProgress
  /** Today's daily challenge and the local record for it. */
  daily: DailyView | null
  /** False while another panel (stats) is open on top: the menu keys then do nothing. */
  active?: boolean
}

export function MenuScreen({
  difficulty,
  onDifficulty,
  onPlay,
  muted,
  onToggleMute,
  layout,
  arena,
  onArena,
  onStats,
  mode,
  onMode,
  endlessBest,
  campaignLevel,
  onCampaignLevel,
  campaignProgress,
  daily,
  active = true,
}: MenuProps) {
  const [best, setBest] = useState<BestMap>({})
  const playRef = useRef<HTMLButtonElement>(null)
  const modeButtons = useRef<(HTMLButtonElement | null)[]>([])
  const levelButtons = useRef<(HTMLButtonElement | null)[]>([])
  const diffButtons = useRef<(HTMLButtonElement | null)[]>([])
  const arenaButtons = useRef<(HTMLButtonElement | null)[]>([])
  const diffRef = useRef(difficulty)
  diffRef.current = difficulty
  const onDiffRef = useRef(onDifficulty)
  onDiffRef.current = onDifficulty
  const modeRef = useRef(mode)
  modeRef.current = mode
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    setBest(loadBest())
    playRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current || e.ctrlKey || e.metaKey || e.altKey) return
      // In the campaign and the daily the arena and the difficulty are fixed, so those keys do nothing.
      if (modeRef.current === "campaign" || modeRef.current === "daily") return
      // Arrow keys belong to the focused radio group (see onRadioKey), not to the window.
      let next = -1
      if (e.code === "Digit1" || e.code === "Numpad1") next = 0
      else if (e.code === "Digit2" || e.code === "Numpad2") next = 1
      else if (e.code === "Digit3" || e.code === "Numpad3") next = 2
      if (next < 0) return
      e.preventDefault()
      onDiffRef.current(DIFFICULTIES[next].id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const modeIndex = MODES.findIndex((m) => m.id === mode)
  const levelEnabled = CAMPAIGN_LEVELS.map((l) => isUnlocked(campaignProgress, l))
  const levelIndex = CAMPAIGN_LEVELS.findIndex((l) => l.id === campaignLevel.id)
  const diffIndex = DIFFICULTIES.findIndex((d) => d.id === difficulty)
  const arenaIndex = ARENA_CHOICES.indexOf(arena)
  const levelDisabled = (i: number) => !levelEnabled[i]

  const b = best[difficulty]

  const stars = totalStars(campaignProgress)
  const relics = campaignProgress.relics.length
  const sector = sectorOf(campaignLevel)
  const meta =
    mode === "campaign"
      ? bestLineCampaign(stars, relics)
      : mode === "daily"
        ? daily && daily.best > 0
          ? `Best today: ${daily.best} mass · ${daily.streak}-day streak`
          : "No run today yet"
        : mode === "endless"
          ? endlessBest > 0
            ? `Endless best: mass ${endlessBest}`
            : "No Endless sessions yet"
          : b
            ? `Best on ${difficulty}: ${b.wins} ${b.wins === 1 ? "win" : "wins"}, peak mass ${b.bestMass}`
            : `No ${difficulty} rounds yet`

  return (
    <div className="gw-overlay gw-overlay-menu">
      <div className="gw-panel gw-menu" role="dialog" aria-label="Gravity Wars menu">
        <h1 className="gw-title">GRAVITY WARS</h1>
        <p className="gw-tagline">Eat debris. Absorb smaller rivals. Don&apos;t fall in.</p>

        <div className="gw-seg gw-seg-mode" role="radiogroup" aria-label="Mode">
          {MODES.map((m, i) => (
            <button
              key={m.id}
              ref={(el) => {
                modeButtons.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={m.id === mode}
              tabIndex={radioTabStop(modeIndex, MODES.length) === i ? 0 : -1}
              className="gw-seg-btn"
              data-on={m.id === mode ? "1" : undefined}
              onClick={() => onMode(m.id)}
              onKeyDown={(e) => onRadioKey(e, modeButtons, i, MODES.length, undefined, (t) => onMode(MODES[t].id))}
            >
              <span className="gw-seg-name">{m.label}</span>
            </button>
          ))}
        </div>
        <p className="gw-mode-copy">{MODES.find((m) => m.id === mode)?.copy(difficulty)}</p>

        {mode === "campaign" ? (
          <>
            <div className="gw-arena-label">
              Sector {["I", "II", "III"][sector.id - 1]} &middot; {sector.name}
            </div>
            <div className="gw-levels" role="radiogroup" aria-label="Campaign level">
              {CAMPAIGN_LEVELS.map((l, i) => {
                const unlocked = levelEnabled[i]
                const won = isWon(campaignProgress, l)
                const lStars = starsOf(campaignProgress, l)
                return (
                  <button
                    key={l.id}
                    ref={(el) => {
                      levelButtons.current[i] = el
                    }}
                    type="button"
                    role="radio"
                    aria-checked={l.id === campaignLevel.id}
                    aria-label={`Level ${l.index}: ${l.name}${unlocked ? `, ${lStars} of 3 stars` : ", locked"}`}
                    tabIndex={radioTabStop(levelIndex, CAMPAIGN_LEVELS.length, levelDisabled) === i ? 0 : -1}
                    className="gw-level-btn"
                    data-on={l.id === campaignLevel.id ? "1" : undefined}
                    data-won={won ? "1" : undefined}
                    data-boss={l.boss !== null ? "1" : undefined}
                    data-sector={l.sector}
                    disabled={!unlocked}
                    onClick={() => onCampaignLevel(l)}
                    onKeyDown={(e) =>
                      onRadioKey(e, levelButtons, i, CAMPAIGN_LEVELS.length, levelDisabled, (t) =>
                        onCampaignLevel(CAMPAIGN_LEVELS[t]),
                      )
                    }
                  >
                    <span className="gw-level-no">{l.index}</span>
                    <span className="gw-level-name">{l.name}</span>
                    {unlocked ? <Stars n={lStars} size={9} /> : <LockIcon size={11} />}
                  </button>
                )
              })}
            </div>
            <div className="gw-goal-box">
              <p className="gw-goal-line">Goal: {campaignLevel.goal.line}</p>
              <p className="gw-bonus-line">Bonus star: {campaignLevel.bonus.line}</p>
              <p className="gw-arena-blurb">{campaignLevel.brief}</p>
            </div>
            <div className="gw-ability-track" aria-label="Abilities unlocked by campaign stars">
              {ABILITY_UNLOCKS.map((a) => {
                const on = stars >= a.stars
                return (
                  <span
                    key={a.id}
                    className={`gw-ability-chip${on ? " gw-ability-on" : ""}`}
                    title={on ? `${a.name} unlocked` : `${a.name} at ${a.stars} stars`}
                  >
                    <AbilityIcon kind={a.id} size={16} />
                    <span className="gw-ability-name">{a.name}</span>
                    {!on && <span className="gw-ability-req">{a.stars} {a.stars === 1 ? "star" : "stars"}</span>}
                  </span>
                )
              })}
            </div>
          </>
        ) : mode === "daily" ? (
          <>
            <div className="gw-daily-card">
              <div className="gw-daily-head">
                <span className="gw-daily-date">{daily?.config.key ?? "-"}</span>
                <span className="gw-daily-arena">
                  {daily ? `${ARENAS[daily.config.arena].name} · ${daily.config.difficulty}` : ""}
                </span>
              </div>
              <p className="gw-daily-line">
                A seeded arena: everyone plays the same field today. Your score is the peak mass of one round.
              </p>
              <div className="gw-daily-stats">
                <span>
                  <strong>{daily?.best ? `${daily.best}` : "-"}</strong> today&apos;s best
                </span>
                <span>
                  <strong>{daily?.streak ?? 0}</strong> day streak
                </span>
                <span>
                  <strong>{daily?.runs ?? 0}</strong> runs
                </span>
              </div>
              <p className="gw-daily-seed">Seed {daily ? daily.config.seed : "-"}</p>
            </div>
          </>
        ) : (
          <>
            <div className="gw-arena-label">{mode === "endless" ? "Starting skill" : "Difficulty"}</div>
            <div className="gw-seg" role="radiogroup" aria-label="Difficulty">
              {DIFFICULTIES.map((d, i) => (
                <button
                  key={d.id}
                  ref={(el) => {
                    diffButtons.current[i] = el
                  }}
                  type="button"
                  role="radio"
                  aria-checked={d.id === difficulty}
                  tabIndex={radioTabStop(diffIndex, DIFFICULTIES.length) === i ? 0 : -1}
                  className="gw-seg-btn"
                  data-on={d.id === difficulty ? "1" : undefined}
                  onClick={() => onDifficulty(d.id)}
                  onKeyDown={(e) =>
                    onRadioKey(e, diffButtons, i, DIFFICULTIES.length, undefined, (t) => onDifficulty(DIFFICULTIES[t].id))
                  }
                >
                  <span className="gw-seg-name">{d.label}</span>
                  <span className="gw-seg-sub">{mode === "endless" ? d.endlessSub : d.sub}</span>
                </button>
              ))}
            </div>

            <div className="gw-arena-label">Arena</div>
            <div className="gw-arenas" role="radiogroup" aria-label="Arena">
              {ARENA_CHOICES.map((a, i) => (
                <button
                  key={a}
                  ref={(el) => {
                    arenaButtons.current[i] = el
                  }}
                  type="button"
                  role="radio"
                  aria-checked={a === arena}
                  tabIndex={radioTabStop(arenaIndex, ARENA_CHOICES.length) === i ? 0 : -1}
                  className="gw-arena-btn"
                  data-on={a === arena ? "1" : undefined}
                  onClick={() => onArena(a)}
                  onKeyDown={(e) =>
                    onRadioKey(e, arenaButtons, i, ARENA_CHOICES.length, undefined, (t) => onArena(ARENA_CHOICES[t]))
                  }
                >
                  {a === "random" ? "Random" : ARENAS[a].name}
                </button>
              ))}
            </div>
            <p className="gw-arena-blurb">{arena === "random" ? "A different arena every round." : ARENAS[arena].blurb}</p>
          </>
        )}

        <div className="gw-sticky">
          <button ref={playRef} type="button" className="gw-btn gw-btn-primary gw-btn-wide" onClick={onPlay}>
            {mode === "campaign" ? `Play level ${campaignLevel.index}` : mode === "daily" ? "Play today's challenge" : "Play"}
            <span className="gw-key">Enter</span>
          </button>
        </div>

        <ul className="gw-how">
          {mode === "endless" ? (
            <>
              <li>{BURN_TIP}</li>
              <li>Get absorbed and you respawn in a few seconds. Rivals come and go.</li>
              <li>Stars recharge energy, but touching a star or the black hole is fatal.</li>
            </>
          ) : mode === "campaign" ? (
            <>
              <li>Each level has a goal, a bonus star and a hidden relic: three stars per level.</li>
              <li>Stars unlock Dash, Repulse and the Singularity inside the campaign.</li>
              <li>Three bosses wait at the end of the three sectors. Kill all of them.</li>
            </>
          ) : mode === "daily" ? (
            <>
              <li>Everyone gets the same seeded arena, rivals and cosmic events today.</li>
              <li>One round, {ROUND_LENGTH}. Your score is your peak mass.</li>
              <li>Come back tomorrow for a new arena and seed.</li>
            </>
          ) : (
            <>
              <li>{BURN_TIP}</li>
              <li>Reach {roundGoal(difficulty)} mass or be the last one left.</li>
              <li>Stars recharge energy, but touching a star or the black hole is fatal.</li>
            </>
          )}
        </ul>
        <p className="gw-controls" data-touch={layout === "touch" ? "1" : undefined}>
          <span className="gw-controls-line" data-for="desktop">
            {DESKTOP_CONTROLS}
          </span>
          <span className="gw-controls-line" data-for="touch">
            {TOUCH_CONTROLS}
          </span>
        </p>

        <div className="gw-menu-foot">
          <button type="button" className="gw-btn gw-btn-ghost gw-btn-small" onClick={onStats}>
            Stats &amp; achievements
          </button>
          <span className="gw-best">{meta}</span>
          <button
            type="button"
            className="gw-btn gw-btn-ghost gw-btn-small"
            aria-pressed={muted}
            onClick={onToggleMute}
          >
            <SpeakerIcon muted={muted} />
            <span>{muted ? "Sound off" : "Sound on"}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function bestLineCampaign(stars: number, relics: number): string {
  const parts = [`${stars} / ${MAX_CAMPAIGN_STARS} stars`, `${relics} / ${CAMPAIGN_LEVELS.length} relics`]
  if (stars >= MAX_CAMPAIGN_STARS) parts.push("The Long Fall complete")
  return parts.join(" · ")
}

// ---------------------------------------------------------------------------------------------

interface PauseProps {
  onResume(): void
  onRestart(): void
  onQuit(): void
}

export function PauseScreen({ onResume, onRestart, onQuit }: PauseProps) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div className="gw-overlay">
      <div className="gw-panel gw-pause" role="dialog" aria-modal="true" aria-label="Paused">
        <h2 className="gw-h2">Paused</h2>
        <div className="gw-sticky">
          <button ref={ref} type="button" className="gw-btn gw-btn-primary gw-btn-wide" onClick={onResume}>
            Resume
            <span className="gw-key">Esc</span>
          </button>
        </div>
        <button type="button" className="gw-btn gw-btn-wide" onClick={onRestart}>
          Restart
          <span className="gw-key">R</span>
        </button>
        <button type="button" className="gw-btn gw-btn-ghost gw-btn-wide" onClick={onQuit}>
          Quit to menu
          <span className="gw-key">Q</span>
        </button>
        {/* Help stays on the pause screen so the controls can be re-read mid-round. Both control
            lines ship in the HTML and CSS shows the one the pointer matches: the same rule as the
            menu, and the reason the server's markup never depends on matchMedia. */}
        <div className="gw-pause-help">
          <p className="gw-pause-tip">{BURN_TIP}</p>
          <p className="gw-controls">
            <span className="gw-controls-line" data-for="desktop">
              {DESKTOP_CONTROLS}
            </span>
            <span className="gw-controls-line" data-for="touch">
              {TOUCH_CONTROLS}
            </span>
          </p>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

interface EndProps {
  result: RoundResult
  stats: BodyStats
  onPlayAgain(): void
  onQuit(): void
  unlocked: AchievementDef[]
  /** Campaign only: the level result, stars, bonus, relic and any ability unlock. */
  campaign?: CampaignOutcome
  /** Campaign only: start the next level. */
  onNextLevel?(): void
  /** Daily only: the run's score and the local record. */
  daily?: DailyOutcome
  /** Share the result (Web Share / clipboard). */
  onShare?(): void
}

function reasonLine(r: RoundResult): string {
  const nameOf = (id: string | null) => r.standings.find((s) => s.id === id)?.name ?? "A rival"
  if (r.playerWon) {
    if (r.reason === "criticalMass") return "Critical mass reached"
    if (r.reason === "lastStanding") return "Last body standing"
    return "Heaviest when the clock ran out"
  }
  if (r.reason === "playerDied" && r.playerCause) {
    return deathLine(r.playerCause, nameOf)
  }
  if (r.reason === "criticalMass") return `${nameOf(r.winnerId)} reached critical mass first`
  if (r.reason === "timeUp") return `${nameOf(r.winnerId)} out-massed you`
  return "Round over"
}

export function EndScreen({ result, stats, onPlayAgain, onQuit, unlocked, campaign, onNextLevel, daily, onShare }: EndProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const shareRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  const won = result.playerWon
  const met = campaign ? campaign.goalMet : won
  const nextAvailable = campaign !== undefined && campaign.goalMet && campaign.next !== null
  const player = result.standings.find((s) => s.id === "player")
  const cells: [string, string][] = [
    ["Final mass", String(Math.round(player?.mass ?? 0))],
    ["Peak mass", String(Math.round(stats.peakMass))],
    ["Rivals absorbed", String(stats.rivalsAbsorbed)],
    ["Debris eaten", String(stats.debrisEaten)],
    ["Crystals", String(stats.crystals)],
    ["Time survived", formatTime(result.durationS)],
    ["Slingshots", String(stats.slingshots)],
    ["Oberths", String(stats.oberths)],
    ["Assists", String(stats.assists)],
    ["Pickups", String(stats.pickups)],
  ]
  const headline = campaign ? (campaign.goalMet ? "GOAL MET" : "GOAL MISSED") : daily ? (daily.isBest ? "NEW DAILY BEST" : "DAILY RUN") : won ? "VICTORY" : "DEFEAT"
  const label = campaign ? (campaign.goalMet ? "Goal met" : "Goal missed") : daily ? "Daily run" : won ? "Victory" : "Defeat"
  return (
    <div className="gw-overlay">
      <div className="gw-panel gw-end" role="dialog" aria-modal="true" aria-label={label}>
        <h2 className={`gw-headline ${met ? "gw-win" : "gw-lose"}`}>{headline}</h2>

        {campaign && (
          <>
            <div className="gw-end-stars">
              <Stars n={campaign.stars} size={30} />
              <span className="gw-end-level">
                Level {campaign.level.index} · {campaign.level.name}
              </span>
            </div>
            <p className="gw-goal-line">Goal: {campaign.level.goal.line}</p>
            <ul className="gw-checklist">
              <li data-on={campaign.goalMet ? "1" : undefined}>
                {campaign.goalMet ? "Goal complete: " : "Goal not met: "}{campaign.level.goal.line}
              </li>
              <li data-on={campaign.bonusMet ? "1" : undefined}>
                {campaign.bonusMet ? "Bonus star: " : "No bonus star: "}{campaign.level.bonus.line}
              </li>
              <li data-on={campaign.relicFound ? "1" : undefined}>
                {campaign.relicFound ? "Relic recovered: " : "Relic not found: "}a hidden fragment of the old signal
              </li>
            </ul>
            {campaign.newBest && <p className="gw-new-best">New best for this level</p>}
            {campaign.unlocked.length > 0 && (
              <div className="gw-unlock" role="status">
                <div className="gw-unlock-kicker">Ability unlocked</div>
                {campaign.unlocked.map((a) => (
                  <div key={a.id} className="gw-unlock-row">
                    <span className="gw-unlock-icon">
                      <AbilityIcon kind={a.id} size={26} />
                    </span>
                    <span>
                      <strong>{a.name}</strong>
                      <span className="gw-unlock-desc">{a.description}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {daily && (
          <div className="gw-daily-result">
            <div className="gw-daily-score">
              <span className="gw-daily-score-value">{daily.score}</span>
              <span className="gw-daily-score-label">peak mass</span>
            </div>
            <div className="gw-daily-stats">
              <span>
                <strong>{daily.best}</strong> best today
              </span>
              <span>
                <strong>{daily.streak}</strong> day streak
              </span>
            </div>
            <p className="gw-daily-seed">{daily.key}</p>
          </div>
        )}

        {!campaign && !daily && <p className="gw-reason">{reasonLine(result)}</p>}
        {campaign && !campaign.goalMet && <p className="gw-reason">{reasonLine(result)}</p>}

        {onShare && (
          <button type="button" className="gw-btn gw-btn-ghost gw-btn-wide gw-share-btn" onClick={onShare}>
            Share result
            <span className="gw-key">S</span>
          </button>
        )}

        <dl className="gw-stats">
          {cells.map(([k, v]) => (
            <div key={k} className="gw-stat">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>

        {unlocked.length > 0 && (
          <div className="gw-newach">
            <div className="gw-newach-title">New achievements</div>
            <ul>
              {unlocked.map((d) => (
                <li key={d.id}>
                  <strong>{d.name}</strong>
                  <span>{d.description}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ol className="gw-standings">
          {result.standings.slice(0, 6).map((s) => (
            <li key={s.id} className={s.id === "player" ? "gw-standing-you" : undefined}>
              <span className="gw-dot" style={{ background: s.color }} />
              <span className="gw-standing-name">{s.name}</span>
              <span className="gw-standing-mass">{Math.round(s.mass)}</span>
              <span className="gw-standing-out">{s.alive ? "" : "out"}</span>
            </li>
          ))}
        </ol>

        <div className="gw-end-actions gw-sticky">
          {nextAvailable ? (
            <button ref={ref} type="button" className="gw-btn gw-btn-primary" onClick={onNextLevel}>
              Next level
              <span className="gw-key">Enter</span>
            </button>
          ) : (
            <button ref={ref} type="button" className="gw-btn gw-btn-primary" onClick={onPlayAgain}>
              {campaign ? "Retry level" : daily ? "Replay today" : "Play again"}
              <span className="gw-key">Enter</span>
            </button>
          )}
          <button type="button" className={nextAvailable ? "gw-btn" : "gw-btn gw-btn-ghost"} onClick={onQuit}>
            {campaign || daily ? "Menu" : "Change difficulty"}
            <span className="gw-key">Q</span>
          </button>
        </div>
      </div>
    </div>
  )
}
