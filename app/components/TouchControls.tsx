"use client"

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react"
import { burnPromptVisible } from "@/game/assist"
import { CONFIG } from "@/game/config"
import type { InputController } from "@/game/input"
import type { HudSnapshot } from "@/game/types"
import type { AbilityId } from "@/game/campaign"
import { AbilityIcon, LockIcon } from "./Icons"

const KNOB_BASE = 56
const DEADZONE = 0.12
/** How long an accessible movement tap keeps thrusting (a tap, not a held joystick). */
const NUDGE_MS = 600

interface Props {
  input: InputController
  hud?: HudSnapshot | null
  onGesture?: () => void
  /** Campaign abilities not earned yet: the button shows a lock and cannot fire. */
  lockedAbilities?: readonly AbilityId[]
}

/**
 * Floating joystick (left 55% x bottom 60% of the stage) plus a hold-to-pull button.
 * Joystick listeners sit on the parent stage so mouse clicks on a hybrid device still reach
 * the canvas; only non-mouse pointers are handled here.
 */
export function TouchControls({ input, hud = null, onGesture, lockedAbilities = [] }: Props) {
  const layerRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const pullRef = useRef<HTMLDivElement>(null)
  // The screen-reader control panel (outside the aria-hidden visual layer) writes movement here.
  const assistRef = useRef<{ nudge(x: number, y: number): void; togglePull(): void } | null>(null)
  const [pullLatched, setPullLatched] = useState(false)
  // Callers pass a fresh function each render; keep it out of the effect deps so a re-render
  // does not tear down an active joystick.
  const gestureRef = useRef(onGesture)
  gestureRef.current = onGesture

  useEffect(() => {
    const layer = layerRef.current
    const host = layer?.parentElement
    const base = baseRef.current
    const knob = knobRef.current
    const ghost = ghostRef.current
    const pullBtn = pullRef.current
    if (!layer || !host || !base || !knob || !ghost || !pullBtn) return

    // The stick scales with the layout (tablets get larger controls via --s in CSS).
    const knobMax = () => (base.offsetWidth > 0 ? base.offsetWidth / 2 : KNOB_BASE)
    let stickId: number | null = null
    let pullId: number | null = null
    let ox = 0
    let oy = 0
    let ax = 0
    let ay = 0
    // Discrete movement and a latched pull for the screen-reader buttons. The joystick wins while
    // it is being dragged; otherwise these fill in.
    let assistAx = 0
    let assistAy = 0
    let assistPull = false
    let nudgeTimer: ReturnType<typeof setTimeout> | undefined

    const write = () =>
      input.setVirtual({
        ax: stickId !== null ? ax : assistAx,
        ay: stickId !== null ? ay : assistAy,
        pull: pullId !== null || assistPull,
      })

    assistRef.current = {
      nudge(x: number, y: number) {
        assistAx = x
        assistAy = y
        write()
        if (nudgeTimer) clearTimeout(nudgeTimer)
        nudgeTimer = setTimeout(() => {
          assistAx = 0
          assistAy = 0
          write()
        }, NUDGE_MS)
      },
      togglePull() {
        assistPull = !assistPull
        setPullLatched(assistPull)
        write()
      },
    }

    const showStick = (on: boolean) => {
      base.style.opacity = on ? "1" : "0"
      ghost.style.opacity = on ? "0" : "1"
      if (!on) knob.style.transform = "translate(-50%, -50%)"
    }

    const moveStick = (e: PointerEvent) => {
      let dx = e.clientX - ox
      let dy = e.clientY - oy
      const len = Math.hypot(dx, dy)
      if (len > knobMax()) {
        dx = (dx / len) * knobMax()
        dy = (dy / len) * knobMax()
      }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
      const nx = dx / knobMax()
      const ny = dy / knobMax()
      if (Math.hypot(nx, ny) < DEADZONE) {
        ax = 0
        ay = 0
      } else {
        ax = nx
        ay = ny
      }
      write()
    }

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return
      gestureRef.current?.()
      if ((e.target as Element | null)?.closest("[data-gw-pull], [data-gw-ability]")) return
      const r = host.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      if (x > r.width * 0.55 || y < r.height * 0.4) return
      stickId = e.pointerId
      ox = e.clientX
      oy = e.clientY
      try {
        host.setPointerCapture(e.pointerId)
      } catch {
        // Capture can fail if the pointer already ended; the stick still works without it.
      }
      base.style.left = `${x}px`
      base.style.top = `${y}px`
      ax = 0
      ay = 0
      showStick(true)
      knob.style.transform = "translate(-50%, -50%)"
      write()
    }

    const onMove = (e: PointerEvent) => {
      if (e.pointerId === stickId) moveStick(e)
    }

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== stickId) return
      stickId = null
      ax = 0
      ay = 0
      showStick(false)
      write()
    }

    const onPullDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return
      e.preventDefault()
      gestureRef.current?.()
      pullId = e.pointerId
      try {
        pullBtn.setPointerCapture(e.pointerId)
      } catch {
        // See above.
      }
      pullBtn.dataset.active = "1"
      write()
    }

    const onPullUp = (e: PointerEvent) => {
      if (e.pointerId !== pullId) return
      pullId = null
      delete pullBtn.dataset.active
      write()
    }

    host.addEventListener("pointerdown", onDown)
    host.addEventListener("pointermove", onMove)
    host.addEventListener("pointerup", onUp)
    host.addEventListener("pointercancel", onUp)
    pullBtn.addEventListener("pointerdown", onPullDown)
    pullBtn.addEventListener("pointerup", onPullUp)
    pullBtn.addEventListener("pointercancel", onPullUp)
    pullBtn.addEventListener("lostpointercapture", onPullUp)
    host.addEventListener("lostpointercapture", onUp)

    return () => {
      host.removeEventListener("pointerdown", onDown)
      host.removeEventListener("pointermove", onMove)
      host.removeEventListener("pointerup", onUp)
      host.removeEventListener("pointercancel", onUp)
      host.removeEventListener("lostpointercapture", onUp)
      pullBtn.removeEventListener("pointerdown", onPullDown)
      pullBtn.removeEventListener("pointerup", onPullUp)
      pullBtn.removeEventListener("pointercancel", onPullUp)
      pullBtn.removeEventListener("lostpointercapture", onPullUp)
      stickId = null
      pullId = null
      ax = 0
      ay = 0
      if (nudgeTimer) clearTimeout(nudgeTimer)
      assistAx = 0
      assistAy = 0
      assistPull = false
      assistRef.current = null
      input.setVirtual(null)
    }
  }, [input])

  const ab = CONFIG.abilities
  const energy = hud?.energy ?? 100
  const isLocked = (kind: "dash" | "repulse" | "ult") => lockedAbilities.includes(kind)
  const press = (kind: "dash" | "repulse" | "ult") => (e: RPointerEvent) => {
    if (e.pointerType === "mouse") return
    e.preventDefault()
    gestureRef.current?.()
    input.press(kind)
  }
  const cd = (left: number | undefined, max: number | undefined) => (left && max ? Math.min(100, (left / max) * 100) : 0)
  const ultCharge = hud?.ult ?? 0
  const ultReady = ultCharge >= 1
  const ultActive = (hud?.ultActive ?? 0) > 0
  // Same gate as the visual dash highlight: the HUD only ever answers "is a burn payable now".
  const burnReady = burnPromptVisible(hud?.assist.window ?? false, hud?.dashCd ?? 0, energy, isLocked("dash"))

  const moves: [string, number, number][] = [
    ["Thrust up", 0, -1],
    ["Thrust left", -1, 0],
    ["Thrust right", 1, 0],
    ["Thrust down", 0, 1],
  ]
  const abilities: { kind: "dash" | "repulse" | "ult"; name: string }[] = [
    { kind: "dash", name: "Dash" },
    { kind: "repulse", name: "Repulse" },
    { kind: "ult", name: "Singularity" },
  ]

  return (
    <>
      <div ref={layerRef} className="gw-touch" aria-hidden="true">
        <div ref={ghostRef} className="gw-stick-ghost" />
        <div ref={baseRef} className="gw-stick-base" style={{ opacity: 0 }}>
          <div ref={knobRef} className="gw-stick-knob" />
        </div>
        <div ref={pullRef} className="gw-pull" data-gw-pull="1">
          PULL
        </div>
        <div
          className="gw-abtn gw-abtn-dash"
          data-gw-ability="dash"
          data-locked={isLocked("dash") ? "1" : undefined}
          data-low={energy < ab.dash.cost ? "1" : undefined}
          data-burn={burnReady ? "1" : undefined}
          style={{ ["--p" as string]: isLocked("dash") ? 0 : cd(hud?.dashCd, hud?.dashMax) }}
          onPointerDown={isLocked("dash") ? undefined : press("dash")}
        >
          {isLocked("dash") ? <LockIcon size={18} /> : <AbilityIcon kind="dash" />}
          <span className="gw-abtn-label">{isLocked("dash") ? "LOCK" : "DASH"}</span>
        </div>
        <div
          className="gw-abtn gw-abtn-repulse"
          data-gw-ability="repulse"
          data-locked={isLocked("repulse") ? "1" : undefined}
          data-low={energy < ab.repulse.cost ? "1" : undefined}
          style={{ ["--p" as string]: isLocked("repulse") ? 0 : cd(hud?.repulseCd, hud?.repulseMax) }}
          onPointerDown={isLocked("repulse") ? undefined : press("repulse")}
        >
          {isLocked("repulse") ? <LockIcon size={18} /> : <AbilityIcon kind="repulse" />}
          <span className="gw-abtn-label">{isLocked("repulse") ? "LOCK" : "REPULSE"}</span>
        </div>
        <div
          className="gw-abtn gw-abtn-ult"
          data-gw-ability="ult"
          data-locked={isLocked("ult") ? "1" : undefined}
          data-ready={!isLocked("ult") && (ultReady || ultActive) ? "1" : undefined}
          style={{ ["--p" as string]: isLocked("ult") ? 0 : 100 - Math.min(100, ultCharge * 100) }}
          onPointerDown={isLocked("ult") ? undefined : press("ult")}
        >
          {isLocked("ult") ? <LockIcon size={18} /> : <AbilityIcon kind="ult" />}
          <span className="gw-abtn-label">
            {isLocked("ult") ? "LOCK" : ultActive ? `${Math.ceil(hud?.ultActive ?? 0)}s` : ultReady ? "READY" : "ULT"}
          </span>
        </div>
      </div>

      {/* Screen-reader / switch path. The visual joystick and hold-to-pull divs above are
          pointer-only and aria-hidden; these real buttons are visually hidden (no layout change)
          but operate the same controller: a movement button is a short thrust burst, Pull latches,
          and the ability buttons queue the same presses as the visual ones. */}
      <div className="gw-sr-only gw-touch-a11y" role="group" aria-label="Movement">
        {moves.map(([label, x, y]) => (
          <button key={label} type="button" onClick={() => assistRef.current?.nudge(x, y)}>
            {label}
          </button>
        ))}
      </div>
      <div className="gw-sr-only gw-touch-a11y" role="group" aria-label="Actions">
        <button type="button" aria-pressed={pullLatched} onClick={() => assistRef.current?.togglePull()}>
          Pull
        </button>
        {abilities.map((a) => {
          const locked = isLocked(a.kind)
          const burnCue = a.kind === "dash" && burnReady ? ", prograde burn window open" : ""
          return (
            <button
              key={a.kind}
              type="button"
              aria-disabled={locked || undefined}
              aria-label={
                locked ? `${a.name} (locked: earn campaign stars to unlock)` : `${a.name}${burnCue}`
              }
              onClick={() => {
                if (!locked) input.press(a.kind)
              }}
            >
              {a.name}
            </button>
          )
        })}
      </div>
    </>
  )
}
