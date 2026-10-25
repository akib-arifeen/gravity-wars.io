"use client"

import { useEffect, useRef } from "react"
import { ACHIEVEMENTS, type Profile } from "@/game/achievements"

function formatPlayed(s: number): string {
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Lifetime stats and the achievements list. Esc is handled by the page; the Close button works by tap. */
export function ProfilePanel({ profile, onClose }: { profile: Profile; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
  }, [])

  const st = profile.stats
  const winRate = st.rounds > 0 ? `${Math.round((st.wins / st.rounds) * 100)}%` : "-"
  const cells: [string, string][] = [
    ["Rounds", String(st.rounds)],
    ["Wins", String(st.wins)],
    ["Win rate", winRate],
    ["Time played", formatPlayed(st.timePlayed)],
    ["Best mass", String(Math.round(st.bestMass))],
    ["Top speed", String(Math.round(st.topSpeed))],
    ["Absorbs", String(st.absorbs)],
    ["Slingshots", String(st.slingshots)],
    ["Oberths", String(st.oberths)],
    ["Assists", String(st.assists)],
    ["Pickups", String(st.pickups)],
    ["Comets", String(st.comets)],
  ]

  const unlocked = ACHIEVEMENTS.filter((a) => profile.achievements[a.id] !== undefined).sort(
    (a, b) => profile.achievements[b.id] - profile.achievements[a.id],
  )
  const locked = ACHIEVEMENTS.filter((a) => profile.achievements[a.id] === undefined)

  return (
    <div className="gw-overlay gw-overlay-profile">
      <div className="gw-panel gw-profile" role="dialog" aria-modal="true" aria-label="Stats and achievements">
        <div className="gw-profile-head">
          <h2 className="gw-h2 gw-h2-left">Stats</h2>
          <button ref={closeRef} type="button" className="gw-btn gw-btn-small" onClick={onClose}>
            Close
            <span className="gw-key">Esc</span>
          </button>
        </div>

        <dl className="gw-stats gw-stats-4">
          {cells.map(([k, v]) => (
            <div key={k} className="gw-stat">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>

        <h3 className="gw-h3">
          Achievements <span className="gw-count">{unlocked.length} / {ACHIEVEMENTS.length} unlocked</span>
        </h3>
        <ul className="gw-ach">
          {unlocked.map((a) => (
            <li key={a.id} className="gw-ach-on">
              <span className="gw-ach-name">{a.name}</span>
              <span className="gw-ach-desc">{a.description}</span>
              <span className="gw-ach-date">{new Date(profile.achievements[a.id]).toLocaleDateString()}</span>
            </li>
          ))}
          {locked.map((a) => (
            <li key={a.id} className="gw-ach-off">
              <span className="gw-ach-name">{a.name}</span>
              <span className="gw-ach-desc">{a.description}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
