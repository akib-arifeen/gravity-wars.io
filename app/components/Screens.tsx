"use client"

import { useEffect, useRef, useState } from "react"
import { CONFIG } from "@/game/config"
import type { BodyStats, Difficulty, RoundResult } from "@/game/types"

const BEST_KEY = "gw:best:v1"

export const DIFFICULTIES: { id: Difficulty; label: string; sub: string }[] = [
  { id: "easy", label: "Easy", sub: "3 slow rivals" },
  { id: "normal", label: "Normal", sub: "5 rivals that hunt" },
  { id: "hard", label: "Hard", sub: "7 sharp rivals" },
]

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
}

export function MenuScreen({ difficulty, onDifficulty, onPlay, muted, onToggleMute, layout }: MenuProps) {
  const [best, setBest] = useState<BestMap>({})
  const playRef = useRef<HTMLButtonElement>(null)
  const diffRef = useRef(difficulty)
  diffRef.current = difficulty
  const onDiffRef = useRef(onDifficulty)
  onDiffRef.current = onDifficulty

  useEffect(() => {
    setBest(loadBest())
    playRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const i = DIFFICULTIES.findIndex((d) => d.id === diffRef.current)
      let next = -1
      if (e.code === "ArrowLeft" || e.code === "ArrowUp") next = Math.max(0, i - 1)
      else if (e.code === "ArrowRight" || e.code === "ArrowDown") next = Math.min(DIFFICULTIES.length - 1, i + 1)
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
      ? "Drag on the left to steer · hold PULL"
      : "WASD or hold the mouse to thrust · Space or right-click to pull · Esc pauses"

  return (
    <div className="gw-overlay gw-overlay-menu">
      <div className="gw-panel gw-menu" role="dialog" aria-label="Gravity Wars menu">
        <h1 className="gw-title">GRAVITY WARS</h1>
        <p className="gw-tagline">Eat debris. Absorb smaller rivals. Don&apos;t fall in.</p>

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
              <span className="gw-seg-sub">{d.sub}</span>
            </button>
          ))}
        </div>

        <button ref={playRef} type="button" className="gw-btn gw-btn-primary gw-btn-wide" onClick={onPlay}>
          Play
          <span className="gw-key">Enter</span>
        </button>

        <ul className="gw-how">
          <li>Grow by eating debris and smaller rivals.</li>
          <li>Reach {CONFIG.round.criticalMass} mass or be the last one left.</li>
          <li>Stars recharge energy, but touching a star or the black hole is fatal.</li>
        </ul>
        <p className="gw-controls">{controls}</p>

        <div className="gw-menu-foot">
          <span className="gw-best">
            {b ? `Best on ${difficulty}: ${b.wins} ${b.wins === 1 ? "win" : "wins"}, peak mass ${b.bestMass}` : `No ${difficulty} rounds yet`}
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
        <button ref={ref} type="button" className="gw-btn gw-btn-primary gw-btn-wide" onClick={onResume}>
          Resume
          <span className="gw-key">Esc</span>
        </button>
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
}

function reasonLine(r: RoundResult): string {
  const nameOf = (id: string | null) => r.standings.find((s) => s.id === id)?.name ?? "A rival"
  if (r.playerWon) {
    if (r.reason === "criticalMass") return "Critical mass reached"
    if (r.reason === "lastStanding") return "Last body standing"
    return "Heaviest when the clock ran out"
  }
  if (r.reason === "playerDied" && r.playerCause) {
    const c = r.playerCause
    if (c.by === "body") return `Absorbed by ${nameOf(c.killerId)}`
    if (c.by === "star") return "Burned up in a star"
    return "Lost to the black hole"
  }
  if (r.reason === "criticalMass") return `${nameOf(r.winnerId)} reached critical mass first`
  if (r.reason === "timeUp") return `${nameOf(r.winnerId)} out-massed you`
  return "Round over"
}

export function EndScreen({ result, stats, onPlayAgain, onQuit }: EndProps) {
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

        <div className="gw-end-actions">
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
