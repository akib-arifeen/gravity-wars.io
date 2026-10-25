"use client"

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { CONFIG } from "@/game/config"
import { burnPromptVisible } from "@/game/assist"
import { ARENAS } from "@/game/arenas"
import { bossAnnouncement, bossPhaseText, type BossHud } from "@/game/boss"
import { COSMIC_INFO } from "@/game/cosmic"
import { FEED_MAX, type FeedItem, type FeedView } from "@/game/feed"
import type { AbilityId } from "@/game/campaign"
import type { LeaderboardEntry } from "@/game/types"
import { AbilityIcon, LockIcon, WallIcon } from "./Icons"
import { centreHud, dashName, dismissesLeaderboard, leaderboardRows, rankPill, rankPillLabel, speedCapText, speedLine, speedValue, BURN_TIP, type HudMode } from "./hudView"

/** Campaign context the HUD shows: the level badge and its goal. */
export interface CampaignHud {
  index: number
  total: number
  name: string
  goalLine: string
  /** Seconds allowed for the level (the level's custom clock). */
  timeLimit: number
}

interface HudProps {
  hud: FeedView | null
  muted: boolean
  onPause(): void
  onToggleMute(): void
  /** True while a modal overlay is open, so Tab cannot reach the buttons behind it. */
  inert?: boolean
  layout: "desktop" | "touch"
  /** Desktop ability slots are clickable. */
  onPress(kind: "dash" | "repulse" | "ult"): void
  /** Endless: why the player died, for the respawn overlay. */
  deathText?: string
  /** Endless: the one teaching line for the first respawn of a round, or "". */
  deathTip?: string
  /** The boss encounter's bar, or null. */
  boss?: BossHud | null
  /** Campaign only: level name, goal and clock. */
  campaign?: CampaignHud | null
  /** Campaign abilities not earned yet: shown locked instead of pressable. */
  lockedAbilities?: readonly AbilityId[]
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

export function Hud({ hud, muted, onPause, onToggleMute, inert, layout, onPress, deathText = "", deathTip = "", boss = null, campaign = null, lockedAbilities = [] }: HudProps) {
  const [showGo, setShowGo] = useState(false)
  const [wallBanner, setWallBanner] = useState(false)
  const [lbOpen, setLbOpen] = useState(false)
  const [backFlash, setBackFlash] = useState(false)
  const prevRespawn = useRef(0)
  const prevPhase = useRef<string | null>(null)
  const prevEscalating = useRef(false)
  const pillRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

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

  const ed = hud?.endless ?? null
  const respawnIn = ed?.respawnIn ?? 0
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    if (prevRespawn.current > 0 && respawnIn <= 0) {
      setBackFlash(true)
      timer = setTimeout(() => setBackFlash(false), 1600)
    }
    prevRespawn.current = respawnIn
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [respawnIn])

  const escalating = hud?.escalating ?? false
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    if (escalating && !prevEscalating.current) {
      setWallBanner(true)
      timer = setTimeout(() => setWallBanner(false), 3200)
    }
    prevEscalating.current = escalating
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [escalating])

  // A respawn overlay owns the screen; the board would sit on top of it.
  useEffect(() => {
    if (respawnIn > 0) setLbOpen(false)
  }, [respawnIn])

  const closeLb = useCallback(() => {
    setLbOpen(false)
    pillRef.current?.focus()
  }, [])

  // Escape closes the board rather than pausing: capture, so the shell's window handler never sees it.
  useEffect(() => {
    if (!lbOpen) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (!dismissesLeaderboard(e.key, lbOpen)) return
      e.preventDefault()
      e.stopPropagation()
      closeLb()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [lbOpen, closeLb])

  const mode: HudMode = ed ? "endless" : campaign ? "campaign" : "round"
  const centre = centreHud(mode, layout, {
    timeLeft: hud?.timeLeft ?? 0,
    rank: hud?.rank ?? 0,
    alive: hud?.alive ?? 0,
    arenaName: hud ? ARENAS[hud.arena].name : "",
    campaign: campaign
      ? { index: campaign.index, total: campaign.total, name: campaign.name, goalLine: campaign.goalLine }
      : null,
  })

  const massPct = hud ? Math.min(100, (hud.mass / hud.criticalMass) * 100) : 0
  const energyPct = hud ? Math.min(100, Math.max(0, (hud.energy / hud.energyMax) * 100)) : 0
  const energyLow = hud ? hud.energy < CONFIG.energy.lowThreshold : false
  const timeCritical = hud ? hud.phase === "playing" && hud.timeLeft <= 10 : false
  // The surge and solar-current ceilings, if any: a narrow phone drops this before the number.
  const speedCap = hud ? speedCapText(hud.assist.surge, hud.assist.surgeMul, hud.sail) : ""

  const status: string[] = []
  if (hud?.pulling) status.push("PULLING")
  if (hud?.charging) status.push("CHARGING")
  if (hud && hud.shield > 0) status.push("SHIELD")

  const chips: { label: string; cls: string; secs: number }[] = []
  if (hud) {
    if (hud.power.overdrive > 0) chips.push({ label: "OVERDRIVE", cls: "od", secs: Math.ceil(hud.power.overdrive) })
    if (hud.power.magnet > 0) chips.push({ label: "MAGNET", cls: "mg", secs: Math.ceil(hud.power.magnet) })
    if (hud.power.phase > 0) chips.push({ label: "PHASE", cls: "ph", secs: Math.ceil(hud.power.phase) })
  }

  const cosmic = hud?.cosmic ?? null
  const cosmicInfo = cosmic ? COSMIC_INFO[cosmic.kind] : null
  const cosmicText = cosmic && cosmicInfo ? (cosmic.stage === "warning" ? cosmicInfo.warning : cosmicInfo.active) : ""
  const cosmicTotal = cosmic
    ? cosmic.stage === "warning"
      ? CONFIG.cosmic[cosmic.kind].warning
      : CONFIG.cosmic[cosmic.kind].duration
    : 1
  const cosmicPct = cosmic ? Math.min(100, Math.max(0, (cosmic.secondsLeft / Math.max(0.01, cosmicTotal)) * 100)) : 0

  const countdownLabel = hud && hud.phase === "countdown" ? String(Math.max(1, hud.countdown)) : showGo ? "GO" : null

  const ab = CONFIG.abilities
  const ultActive = hud ? hud.ultActive > 0 : false
  const ultReady = hud ? hud.ult >= 1 && !ultActive : false
  const slots: { kind: "dash" | "repulse" | "ult"; label: string; key: string; pct: number; low: boolean; locked: boolean }[] = hud
    ? [
        {
          kind: "dash",
          label: "Dash",
          key: "Shift",
          pct: hud.dashMax > 0 ? (hud.dashCd / hud.dashMax) * 100 : 0,
          low: hud.energy < ab.dash.cost,
          locked: lockedAbilities.includes("dash"),
        },
        {
          kind: "repulse",
          label: "Repulse",
          key: "E",
          pct: hud.repulseMax > 0 ? (hud.repulseCd / hud.repulseMax) * 100 : 0,
          low: hud.energy < ab.repulse.cost,
          locked: lockedAbilities.includes("repulse"),
        },
        {
          kind: "ult",
          label: "Singularity",
          key: "Q",
          pct: 100 - Math.min(100, hud.ult * 100),
          low: false,
          locked: lockedAbilities.includes("ult"),
        },
      ]
    : []

  const feed = hud?.feed ?? null
  const bossActive = boss !== null && hud?.phase !== "over"
  // The visual bar changes ~4x/s; the status text below changes only when the fight's state does.
  const bossAnnounce = bossActive && boss ? bossAnnouncement(boss) : ""
  // The accessible equivalent of the dash slot's burn highlight: a real flyby's window is open and
  // the dash can pay it right now. It is announced through the dash control's NAME only — never
  // through the live region below, which would announce late, twice, or over the boss line for a
  // 0.35 s window that also has a visual and canvas cue.
  const burnReady = hud
    ? burnPromptVisible(hud.assist.window, hud.dashCd, hud.energy, lockedAbilities.includes("dash"))
    : false

  return (
    <div className="gw-hud" data-mode={mode} data-layout={layout} inert={inert}>
      {hud && (
        <>
          <div className="gw-hud-leftcol">
            <div className="gw-hud-panel gw-hud-left">
              <div className="gw-hud-label">{campaign ? "MASS / GOAL" : "MASS"}</div>
              <div className="gw-hud-mass">
                <span className="gw-hud-mass-value">{Math.round(hud.mass)}</span>
                {!ed && !campaign && <span className="gw-hud-mass-max"> / {hud.criticalMass}</span>}
                {ed && <span className="gw-hud-mass-max"> best {Math.round(Math.max(ed.best, hud.mass))}</span>}
              </div>
              {ed ? (
                <div className="gw-hud-kd">
                  Kills {ed.kills} &middot; Deaths {ed.deaths}
                </div>
              ) : campaign ? (
                <div className="gw-hud-kd">Rank {hud.rank > 0 ? `#${hud.rank}` : "-"} of {hud.alive}</div>
              ) : (
                <div className="gw-bar gw-bar-thin" role="presentation">
                  <div className="gw-bar-fill gw-bar-mass" style={{ width: `${massPct}%` }} />
                </div>
              )}
              <div className="gw-hud-label gw-hud-energy-label">ENERGY</div>
              <div className={`gw-bar${energyLow ? " gw-bar-low" : ""}`} role="presentation">
                <div className="gw-bar-fill gw-bar-energy" style={{ width: `${energyPct}%` }} />
              </div>
              <div className="gw-hud-status" aria-live="off">
                {status.join(" / ") || "\u00a0"}
              </div>
              {chips.length > 0 && (
                <div className="gw-chips">
                  {chips.map((c) => (
                    <span key={c.label} className={`gw-chip gw-chip-${c.cls}`}>
                      {c.label} {c.secs}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {cosmic && cosmicInfo && (
              <div key={`${cosmic.kind}-${cosmic.stage}`} className={`gw-cosmic gw-cosmic-${cosmic.stage}`} role="status">
                <div className="gw-cosmic-title">{cosmicInfo.title}</div>
                {cosmicText && <div className="gw-cosmic-text">{cosmicText}</div>}
                <div className="gw-cosmic-bar" role="presentation">
                  <div className="gw-cosmic-fill" style={{ width: `${cosmicPct}%` }} />
                </div>
              </div>
            )}
          </div>

          <div className="gw-hud-center">
            {centre.tag && <div className="gw-hud-tag">{centre.tag}</div>}
            {centre.arena && <div className="gw-hud-arena">{centre.arena}</div>}
            {layout === "touch" && ed && hud.leaderboard.length > 0 && (
              <button
                ref={pillRef}
                type="button"
                className="gw-lb-pill"
                aria-expanded={lbOpen}
                aria-controls="gw-lb-panel"
                aria-label={rankPillLabel(hud.rank, hud.alive)}
                onClick={() => setLbOpen((o) => !o)}
              >
                {rankPill(hud.rank, hud.alive)}
                {escalating && (
                  <span className="gw-wall-icon">
                    <WallIcon size={14} />
                  </span>
                )}
              </button>
            )}
            {centre.timer && (
              <div className={`gw-hud-timer${timeCritical ? " gw-hud-timer-crit" : ""}`}>{centre.timer}</div>
            )}
            {centre.goal ? (
              <div className="gw-hud-goal">{centre.goal}</div>
            ) : centre.rank ? (
              <div className={`gw-hud-rank${ed ? " gw-hud-rank-ed" : ""}`}>
                {centre.rank}
                {escalating && !wallBanner && (
                  <span className="gw-wall-icon" role="img" aria-label="The wall is closing" title="The wall is closing">
                    <WallIcon />
                  </span>
                )}
              </div>
            ) : null}
            {/* Live speed: the body's absolute speed, shown so "DASH ALONG PATH" has a visible
                payoff. It is not the figure a burn is graded on — the engine grades a pass
                relative to the well — and the surge multiplier beside it is the temporary speed
                ceiling, not a measured ratio. Not a live region (it changes at 10 Hz); the
                aria-live status paragraph below stays the only thing that speaks. */}
            {hud.phase !== "countdown" && (
              <div className="gw-hud-speed">
                {/* The whole line for assistive tech; the parts below are what a narrow phone can
                    trim. Not a live region, so the visible split never announces twice. */}
                <span className="gw-sr-only">{speedLine(hud.speed, hud.assist.surge, hud.assist.surgeMul, hud.sail)}</span>
                <span aria-hidden="true" className="gw-speed-prefix">
                  SPEED{" "}
                </span>
                <span aria-hidden="true">{speedValue(hud.speed)}</span>
                {speedCap && (
                  <span aria-hidden="true" className="gw-speed-cap">
                    {speedCap}
                  </span>
                )}
              </div>
            )}
          </div>

          {bossActive && boss && <BossBar boss={boss} />}
          {/* Persistent polite status region: only its text changing announces, and that text
              ignores the 4 Hz mass/health updates. The burn window is deliberately not in here;
              it is carried by the dash control's name instead. */}
          <p className="gw-sr-only" role="status" aria-live="polite">
            {bossAnnounce}
          </p>

          {ed && hud.leaderboard.length > 0 && (
            <Leaderboard rows={hud.leaderboard} touch={layout === "touch"} open={lbOpen} onToggle={() => setLbOpen((o) => !o)} />
          )}

          {ed && hud.leaderboard.length > 0 && layout === "touch" && lbOpen && (
            <LeaderboardPanel rows={hud.leaderboard} closeRef={closeRef} onClose={closeLb} />
          )}

          {feed && feed.length > 0 && <Feed items={feed} layout={layout} />}

          {wallBanner && (
            <div className="gw-wall-banner" role="status">
              THE WALL IS CLOSING
            </div>
          )}

          {layout === "desktop" && (
            <div className="gw-abilities">
              {slots.map((sl) => (
                <button
                  key={sl.kind}
                  type="button"
                  className="gw-slot"
                  aria-label={
                    sl.locked
                      ? `${sl.label} (locked: earn campaign stars to unlock)`
                      : dashName(`${sl.label} (${sl.key})`, sl.kind === "dash" && burnReady)
                  }
                  disabled={sl.locked}
                  data-locked={sl.locked ? "1" : undefined}
                  data-low={sl.low ? "1" : undefined}
                  data-ready={sl.kind === "ult" && (ultReady || ultActive) ? "1" : undefined}
                  data-burn={sl.kind === "dash" && burnReady ? "1" : undefined}
                  style={{ ["--p" as string]: sl.pct }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPress(sl.kind)}
                >
                  {sl.locked ? <LockIcon size={20} /> : <AbilityIcon kind={sl.kind} />}
                  <span className="gw-slot-key">
                    {sl.locked ? "LOCK" : sl.kind === "ult" ? (ultActive ? `${Math.ceil(hud.ultActive)}s` : ultReady ? "READY" : sl.key) : sl.key}
                  </span>
                </button>
              ))}
            </div>
          )}
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

      {ed && respawnIn > 0 && (
        <div className="gw-death" role="status">
          <div className="gw-death-box">
            <div className="gw-death-cause">{deathText || "You were eliminated"}</div>
            <div className="gw-death-count">Respawning in {Math.max(1, Math.ceil(respawnIn))}...</div>
            <div className="gw-death-stats">
              Best {Math.round(ed.best)} &middot; Kills {ed.kills}
            </div>
            {deathTip && <div className="gw-death-tip">{deathTip}</div>}
          </div>
        </div>
      )}
      {ed && backFlash && respawnIn <= 0 && <div className="gw-back">Back in the fight</div>}

      {hud && hud.phase === "countdown" && (
        <div className="gw-countdown">
          <div className="gw-countdown-arena">{campaign ? `LEVEL ${campaign.index} · ${campaign.name}` : ARENAS[hud.arena].name}</div>
          {campaign && <div className="gw-countdown-hint">{campaign.goalLine}</div>}
          <div key={countdownLabel} className="gw-countdown-num">
            {countdownLabel}
          </div>
          {!campaign && (
            <>
              <div className="gw-countdown-hint">{BURN_TIP}</div>
              <div className="gw-countdown-hint">Green ring = you can absorb it. Red ring = it can absorb you.</div>
            </>
          )}
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

/** The boss bar: a visual-only meter plus the phase line. The live region lives in the HUD. */
function BossBar({ boss }: { boss: BossHud }) {
  const telegraph = boss.phase === "telegraph" || boss.phase === "attack"
  const health = Math.max(0, Math.min(100, Math.round(boss.healthPct * 100)))
  return (
    <div className={`gw-boss${telegraph ? " gw-boss-warn" : ""}`}>
      <div className="gw-boss-head">
        <span className="gw-boss-name">{boss.name}</span>
        <span className="gw-boss-mass">{Math.round(boss.mass)} mass</span>
      </div>
      <div
        className="gw-boss-bar"
        role="meter"
        aria-label={`${boss.name} health`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={health}
        aria-valuetext={`${health}% mass`}
      >
        <div className="gw-boss-fill" style={{ width: `${Math.max(0, boss.healthPct * 100)}%` }} />
      </div>
      <div className="gw-boss-phase">{bossPhaseText(boss)}</div>
    </div>
  )
}

/** The activity feed: what just happened in the arena, newest last. */
function Feed({ items, layout }: { items: FeedItem[]; layout: "desktop" | "touch" }) {
  const shown = layout === "touch" ? items.slice(-3) : items.slice(-FEED_MAX)
  return (
    <div className={`gw-feed gw-feed-${layout}`} aria-live="off" aria-label="Arena activity">
      {shown.map((f) => (
        <div key={f.id} className={`gw-feed-line gw-feed-${f.tone}`}>
          {f.text}
        </div>
      ))}
    </div>
  )
}

function Leaderboard({
  rows,
  touch,
  open,
  onToggle,
}: {
  rows: LeaderboardEntry[]
  touch: boolean
  open: boolean
  onToggle(): void
}) {
  // Touch shows a compact top 3 plus the player; a tap expands to the full board. Phones hide this
  // box and open the panel below from the rank pill instead.
  const shown = leaderboardRows(rows, { touch, open })
  const body = (
    <>
      <div className="gw-lb-head">
        <span>LEADERBOARD</span>
        {touch && <span className="gw-lb-more">{open ? "less" : "more"}</span>}
      </div>
      <LeaderboardRows rows={shown} />
    </>
  )
  return touch ? (
    <button
      type="button"
      className="gw-lb gw-lb-touch"
      data-open={open ? "1" : undefined}
      aria-expanded={open}
      aria-label="Leaderboard"
      onClick={onToggle}
    >
      {body}
    </button>
  ) : (
    <div className="gw-lb" aria-label="Leaderboard">
      {body}
    </div>
  )
}

/** Phone: the rank pill opens this panel, the only place the full board appears. */
function LeaderboardPanel({
  rows,
  closeRef,
  onClose,
}: {
  rows: LeaderboardEntry[]
  closeRef: RefObject<HTMLButtonElement | null>
  onClose(): void
}) {
  return (
    <div id="gw-lb-panel" className="gw-lb gw-lb-drop" data-open="1" role="dialog" aria-label="Leaderboard">
      <div className="gw-lb-head">
        <span>LEADERBOARD</span>
        <button ref={closeRef} type="button" className="gw-lb-close" aria-label="Close leaderboard" onClick={onClose}>
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
      <LeaderboardRows rows={rows} />
    </div>
  )
}

function LeaderboardRows({ rows }: { rows: LeaderboardEntry[] }) {
  return (
    <ol className="gw-lb-list">
      {rows.map((r, i) => (
        <li
          key={r.id}
          className={`${r.isPlayer ? "gw-lb-you" : ""}${i > 0 && r.rank - rows[i - 1].rank > 1 ? " gw-lb-gap" : ""}`}
        >
          <span className="gw-lb-rank">{r.rank}</span>
          <span className="gw-dot" style={{ background: r.color }} />
          <span className="gw-lb-name">{r.name}</span>
          <span className="gw-lb-mass">{Math.round(r.mass)}</span>
        </li>
      ))}
    </ol>
  )
}
