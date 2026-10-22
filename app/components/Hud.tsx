"use client"

import { useEffect, useRef, useState } from "react"
import { CONFIG } from "@/game/config"
import type { HudSnapshot } from "@/game/types"

interface HudProps {
  hud: HudSnapshot | null
  muted: boolean
  onPause(): void
  onToggleMute(): void
  /** True while a modal overlay is open, so Tab cannot reach the buttons behind it. */
  inert?: boolean
}

function formatTime(s: number): string {
  const t = Math.max(0, Math.ceil(s))
  const m = Math.floor(t / 60)
  const r = t % 60
  return `${m}:${r < 10 ? "0" : ""}${r}`
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </svg>
  )
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
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

export function Hud({ hud, muted, onPause, onToggleMute, inert }: HudProps) {
  const [showGo, setShowGo] = useState(false)
  const prevPhase = useRef<string | null>(null)

  const phase = hud?.phase ?? null
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    if (prevPhase.current === "countdown" && phase === "playing") {
      setShowGo(true)
      timer = setTimeout(() => setShowGo(false), 800)
    }
    prevPhase.current = phase
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [phase])

  const massPct = hud ? Math.min(100, (hud.mass / hud.criticalMass) * 100) : 0
  const energyPct = hud ? Math.min(100, Math.max(0, (hud.energy / hud.energyMax) * 100)) : 0
  const energyLow = hud ? hud.energy < CONFIG.energy.lowThreshold : false
  const timeCritical = hud ? hud.phase === "playing" && hud.timeLeft <= 10 : false

  const status: string[] = []
  if (hud?.pulling) status.push("PULLING")
  if (hud?.charging) status.push("CHARGING")
  if (hud && hud.shield > 0) status.push("SHIELD")

  const countdownLabel = hud && hud.phase === "countdown" ? String(Math.max(1, hud.countdown)) : showGo ? "GO" : null

  return (
    <div className="gw-hud" inert={inert}>
      {hud && (
        <>
          <div className="gw-hud-panel gw-hud-left">
            <div className="gw-hud-label">MASS</div>
            <div className="gw-hud-mass">
              <span className="gw-hud-mass-value">{Math.round(hud.mass)}</span>
              <span className="gw-hud-mass-max"> / {hud.criticalMass}</span>
            </div>
            <div className="gw-bar gw-bar-thin" role="presentation">
              <div className="gw-bar-fill gw-bar-mass" style={{ width: `${massPct}%` }} />
            </div>
            <div className="gw-hud-label gw-hud-energy-label">ENERGY</div>
            <div className={`gw-bar${energyLow ? " gw-bar-low" : ""}`} role="presentation">
              <div className="gw-bar-fill gw-bar-energy" style={{ width: `${energyPct}%` }} />
            </div>
            <div className="gw-hud-status" aria-live="off">
              {status.join(" / ") || " "}
            </div>
          </div>

          <div className="gw-hud-center">
            <div className={`gw-hud-timer${timeCritical ? " gw-hud-timer-crit" : ""}`}>{formatTime(hud.timeLeft)}</div>
            <div className="gw-hud-rank">{hud.rank > 0 ? `Rank ${hud.rank} / ${hud.alive}` : "Eliminated"}</div>
          </div>
        </>
      )}

      <div className="gw-hud-buttons">
        {/* preventDefault on mousedown keeps a clicked button from holding focus, so the next
            Space press pulls instead of re-clicking it. Keyboard (Tab) focus still works. */}
        <button
          type="button"
          className="gw-icon-btn"
          aria-label="Pause"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onPause}
        >
          <PauseIcon />
        </button>
        <button
          type="button"
          className="gw-icon-btn"
          aria-label={muted ? "Unmute sound" : "Mute sound"}
          aria-pressed={muted}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleMute}
        >
          <SpeakerIcon muted={muted} />
        </button>
      </div>

      {hud && hud.phase === "countdown" && (
        <div className="gw-countdown">
          <div key={countdownLabel} className="gw-countdown-num">
            {countdownLabel}
          </div>
          <div className="gw-countdown-hint">Green ring = you can absorb it. Red ring = it can absorb you.</div>
        </div>
      )}
      {hud && hud.phase !== "countdown" && showGo && (
        <div className="gw-countdown">
          <div className="gw-countdown-num gw-countdown-go">GO</div>
        </div>
      )}
    </div>
  )
}
