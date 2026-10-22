"use client"

import { useEffect, useRef, useState } from "react"
import type { AchievementDef } from "@/game/achievements"
import { ARENAS, ARENA_IDS } from "@/game/arenas"
import { CONFIG } from "@/game/config"
import type { ArenaId, BodyStats, DeathCause, Difficulty, GameMode, RoundResult } from "@/game/types"

const BEST_KEY = "gw:best:v1"

export const DIFFICULTIES: { id: Difficulty; label: string; sub: string; endlessSub: string }[] = [
  { id: "easy", label: "Easy", sub: "3 slow rivals", endlessSub: "gentle start" },
  { id: "normal", label: "Normal", sub: "5 rivals that hunt", endlessSub: "mixed skills" },
  { id: "hard", label: "Hard", sub: "7 sharp rivals", endlessSub: "sharp from the start" },
]

export const MODES: { id: GameMode; label: string; copy: string }[] = [
  { id: "endless", label: "Endless", copy: "Endless \u2014 the arena never sleeps. Climb the leaderboard." },
  { id: "round", label: "Round", copy: `3 minute match. Reach ${CONFIG.round.criticalMass} mass or be the last one left.` },
]

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

// ---------------------------------------------------------------------------------------------

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
  mode: GameMode
  onMode(m: GameMode): void
  endlessBest: number
  /** False while another panel (stats) is open on top: the menu keys then do nothing. */
  active?: boolean
}

export function MenuScreen({ difficulty, onDifficulty, onPlay, muted, onToggleMute, layout, arena, onArena, onStats, mode, onMode, endlessBest, active = true }: MenuProps) {
  const [best, setBest] = useState<BestMap>({})
  const playRef = useRef<HTMLButtonElement>(null)
  const diffRef = useRef(difficulty)
  diffRef.current = difficulty
  const onDiffRef = useRef(onDifficulty)
  onDiffRef.current = onDifficulty
  const arenaRef = useRef(arena)
  arenaRef.current = arena
  const activeRef = useRef(active)
  activeRef.current = active
  const onArenaRef = useRef(onArena)
  onArenaRef.current = onArena

  useEffect(() => {
    setBest(loadBest())
    playRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current || e.ctrlKey || e.metaKey || e.altKey) return
      const i = DIFFICULTIES.findIndex((d) => d.id === diffRef.current)
      let next = -1
      if (e.code === "ArrowUp" || e.code === "ArrowDown") {
        const ai = ARENA_CHOICES.indexOf(arenaRef.current)
        const an = Math.min(ARENA_CHOICES.length - 1, Math.max(0, ai + (e.code === "ArrowUp" ? -1 : 1)))
        e.preventDefault()
        onArenaRef.current(ARENA_CHOICES[an])
        return
      }
      if (e.code === "ArrowLeft") next = Math.max(0, i - 1)
      else if (e.code === "ArrowRight") next = Math.min(DIFFICULTIES.length - 1, i + 1)
      else if (e.code === "Digit1" || e.code === "Numpad1") next = 0
      else if (e.code === "Digit2" || e.code === "Numpad2") next = 1
      else if (e.code === "Digit3" || e.code === "Numpad3") next = 2
      if (next < 0) return
      e.preventDefault()
      onDiffRef.current(DIFFICULTIES[next].id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const b = best[difficulty]
  const controls =
    layout === "touch"
      ? "Drag on the left to steer · hold PULL · tap DASH, REPULSE and ULT"
      : "WASD or hold the mouse to thrust · Space or right-click to pull · Shift dash · E repulse · Q Singularity · Esc pauses"

  return (
    <div className="gw-overlay gw-overlay-menu">
      <div className="gw-panel gw-menu" role="dialog" aria-label="Gravity Wars menu">
        <h1 className="gw-title">GRAVITY WARS</h1>
        <p className="gw-tagline">Eat debris. Absorb smaller rivals. Don&apos;t fall in.</p>

        <div className="gw-seg gw-seg-mode" role="radiogroup" aria-label="Mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={m.id === mode}
              className="gw-seg-btn"
              data-on={m.id === mode ? "1" : undefined}
              onClick={() => onMode(m.id)}
            >
              <span className="gw-seg-name">{m.label}</span>
            </button>
          ))}
        </div>
        <p className="gw-mode-copy">{MODES.find((m) => m.id === mode)?.copy}</p>

        <div className="gw-arena-label">{mode === "endless" ? "Starting skill" : "Difficulty"}</div>
        <div className="gw-seg" role="radiogroup" aria-label="Difficulty">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.id}
              type="button"
              role="radio"
              aria-checked={d.id === difficulty}
              className="gw-seg-btn"
              data-on={d.id === difficulty ? "1" : undefined}
              onClick={() => onDifficulty(d.id)}
            >
              <span className="gw-seg-name">{d.label}</span>
              <span className="gw-seg-sub">{mode === "endless" ? d.endlessSub : d.sub}</span>
            </button>
          ))}
        </div>

        <div className="gw-arena-label">Arena</div>
        <div className="gw-arenas" role="radiogroup" aria-label="Arena">
          {ARENA_CHOICES.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={a === arena}
              className="gw-arena-btn"
              data-on={a === arena ? "1" : undefined}
              onClick={() => onArena(a)}
            >
              {a === "random" ? "Random" : ARENAS[a].name}
            </button>
          ))}
        </div>
        <p className="gw-arena-blurb">{arena === "random" ? "A different arena every round." : ARENAS[arena].blurb}</p>

        <div className="gw-sticky">
          <button ref={playRef} type="button" className="gw-btn gw-btn-primary gw-btn-wide" onClick={onPlay}>
            Play
            <span className="gw-key">Enter</span>
          </button>
        </div>

        <ul className="gw-how">
          {mode === "endless" ? (
            <>
              <li>Eat debris and smaller rivals to climb the leaderboard.</li>
              <li>Get absorbed and you respawn in a few seconds. Rivals come and go.</li>
              <li>Stars recharge energy, but touching a star or the black hole is fatal.</li>
            </>
          ) : (
            <>
              <li>Grow by eating debris and smaller rivals.</li>
              <li>Reach {CONFIG.round.criticalMass} mass or be the last one left.</li>
              <li>Stars recharge energy, but touching a star or the black hole is fatal.</li>
            </>
          )}
        </ul>
        <p className="gw-controls">{controls}</p>

        <div className="gw-menu-foot">
          <button type="button" className="gw-btn gw-btn-ghost gw-btn-small" onClick={onStats}>
            Stats &amp; achievements
          </button>
          <span className="gw-best">
            {mode === "endless"
              ? endlessBest > 0
                ? `Endless best: mass ${endlessBest}`
                : "No Endless sessions yet"
              : b ? `Best on ${difficulty}: ${b.wins} ${b.wins === 1 ? "win" : "wins"}, peak mass ${b.bestMass}` : `No ${difficulty} rounds yet`}
          </span>
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

export function EndScreen({ result, stats, onPlayAgain, onQuit, unlocked }: EndProps) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  const won = result.playerWon
  const player = result.standings.find((s) => s.id === "player")
  const cells: [string, string][] = [
    ["Final mass", String(Math.round(player?.mass ?? 0))],
    ["Peak mass", String(Math.round(stats.peakMass))],
    ["Rivals absorbed", String(stats.rivalsAbsorbed)],
    ["Debris eaten", String(stats.debrisEaten)],
    ["Crystals", String(stats.crystals)],
    ["Time survived", formatTime(result.durationS)],
    ["Slingshots", String(stats.slingshots)],
    ["Assists", String(stats.assists)],
    ["Pickups", String(stats.pickups)],
  ]
  return (
    <div className="gw-overlay">
      <div className="gw-panel gw-end" role="dialog" aria-modal="true" aria-label={won ? "Victory" : "Defeat"}>
        <h2 className={`gw-headline ${won ? "gw-win" : "gw-lose"}`}>{won ? "VICTORY" : "DEFEAT"}</h2>
        <p className="gw-reason">{reasonLine(result)}</p>

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
          <button ref={ref} type="button" className="gw-btn gw-btn-primary" onClick={onPlayAgain}>
            Play again
            <span className="gw-key">Enter</span>
          </button>
          <button type="button" className="gw-btn gw-btn-ghost" onClick={onQuit}>
            Change difficulty
            <span className="gw-key">Q</span>
          </button>
        </div>
      </div>
    </div>
  )
}
