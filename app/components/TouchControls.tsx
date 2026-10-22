"use client"

import { useEffect, useRef } from "react"
import type { InputController } from "@/game/input"

const KNOB_MAX = 56
const DEADZONE = 0.12

interface Props {
  input: InputController
  onGesture?: () => void
}

/**
 * Floating joystick (left 55% x bottom 60% of the stage) plus a hold-to-pull button.
 * Joystick listeners sit on the parent stage so mouse clicks on a hybrid device still reach
 * the canvas; only non-mouse pointers are handled here.
 */
export function TouchControls({ input, onGesture }: Props) {
  const layerRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const pullRef = useRef<HTMLDivElement>(null)
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

    let stickId: number | null = null
    let pullId: number | null = null
    let ox = 0
    let oy = 0
    let ax = 0
    let ay = 0

    const write = () => input.setVirtual({ ax, ay, pull: pullId !== null })

    const showStick = (on: boolean) => {
      base.style.opacity = on ? "1" : "0"
      ghost.style.opacity = on ? "0" : "1"
      if (!on) knob.style.transform = "translate(-50%, -50%)"
    }

    const moveStick = (e: PointerEvent) => {
      let dx = e.clientX - ox
      let dy = e.clientY - oy
      const len = Math.hypot(dx, dy)
      if (len > KNOB_MAX) {
        dx = (dx / len) * KNOB_MAX
        dy = (dy / len) * KNOB_MAX
      }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
      const nx = dx / KNOB_MAX
      const ny = dy / KNOB_MAX
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
      if ((e.target as Element | null)?.closest("[data-gw-pull]")) return
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
      input.setVirtual(null)
    }
  }, [input])

  return (
    <div ref={layerRef} className="gw-touch" aria-hidden="true">
      <div ref={ghostRef} className="gw-stick-ghost" />
      <div ref={baseRef} className="gw-stick-base" style={{ opacity: 0 }}>
        <div ref={knobRef} className="gw-stick-knob" />
      </div>
      <div ref={pullRef} className="gw-pull" data-gw-pull="1">
        PULL
      </div>
    </div>
  )
}
