// Local player input: keyboard, mouse and touch merged into one Intent.
//
// CONTRACT — exported signatures and documented behaviour are fixed.

import type { Intent, Vec } from "./types"

export interface InputCallbacks {
  /** Esc or P pressed. */
  onPause(): void
  /** Any key/pointer gesture; the shell uses it to unlock audio. */
  onGesture(): void
}

export interface InputController {
  /**
   * The player's intent right now. Keyboard (WASD/arrows, normalised; Space = pull; Shift/E/Q = ability presses, see press())
   * wins over mouse when any direction key is held. Mouse: while the primary button is held on
   * the canvas, thrust toward the cursor (full strength beyond 90 px from playerScreen, scaling
   * down to 0 at 12 px); secondary button held = pull. Touch: the on-screen controls write
   * through setVirtual().
   */
  read(playerScreen: Vec): Intent
  /** Joystick/pull button state from on-screen touch controls; merged with the others. */
  setVirtual(v: Intent | null): void
  /**
   * Queue a one-shot ability press (on-screen buttons). Keyboard presses queue the same way:
   * Shift = dash, E = repulse, Q = Singularity (keydown, not repeat). The next read() returns the
   * flag true once and clears it. clear() drops queued presses too.
   */
  press(kind: "dash" | "repulse" | "ult"): void
  /**
   * Enable or disable the controller (default enabled). While disabled, keydown/press() queue
   * nothing and no key is held; disabling also clear()s. The shell disables it while paused so a
   * press made during pause cannot fire on resume; press() semantics are otherwise unchanged.
   */
  setEnabled(enabled: boolean): void
  /** Drop every held key and button (on blur, pause, round end). */
  clear(): void
  dispose(): void
}

/**
 * Listen on `canvas` for pointer/contextmenu events and on window for keys. preventDefault on
 * the keys the game uses (arrows, Space) so a page or iframe host does not scroll.
 */
export function createInput(canvas: HTMLCanvasElement, callbacks: InputCallbacks): InputController {
  const keys = new Set<string>()
  // Bit 0 = primary button held, bit 1 = secondary button held (mouse pointers only).
  let mouseButtons = 0
  let mx = 0
  let my = 0
  let haveMouse = false
  // True only for a mouse press that began on the canvas; a press that began on a HUD button
  // and drags over the game must not thrust.
  let pressOnCanvas = false
  // True while the browser holds a pointer capture for our mouse press: the release is then
  // guaranteed to reach us (even outside the iframe), so a cursor leaving must not cancel it.
  let captured = false
  // False while the game is paused or the round is over: key and button presses are ignored.
  let enabled = true
  let virtual: Intent | null = null

  const LEFT = ["KeyA", "ArrowLeft"]
  const RIGHT = ["KeyD", "ArrowRight"]
  const UP = ["KeyW", "ArrowUp"]
  const DOWN = ["KeyS", "ArrowDown"]
  const PULL = ["Space"]
  const ABILITY_KEYS: Record<string, "dash" | "repulse" | "ult"> = {
    ShiftLeft: "dash",
    ShiftRight: "dash",
    KeyE: "repulse",
    KeyQ: "ult",
  }
  const ABILITY_BY_KEY: Record<string, "dash" | "repulse" | "ult"> = { shift: "dash", e: "repulse", q: "ult" }
  // One-shot ability presses waiting for the next read(); dropped by clear() so a press queued
  // before a pause can never fire on resume.
  const queued = { dash: false, repulse: false, ult: false }
  const PREVENT = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"])

  const held = (codes: string[]): boolean => codes.some((c) => keys.has(c))

  const isTextTarget = (t: EventTarget | null): boolean => {
    if (!(t instanceof HTMLElement)) return false
    if (t instanceof HTMLTextAreaElement) return true
    if (t instanceof HTMLInputElement) {
      return !["button", "checkbox", "radio", "range", "submit", "reset"].includes(t.type)
    }
    return t.isContentEditable
  }

  const isControlTarget = (t: EventTarget | null): boolean =>
    t instanceof Element && t.closest("button, a, input, select, textarea, summary") !== null

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTextTarget(e.target)) return
    // The page's own handler (registered first) already consumed this key, e.g. Esc to resume.
    if (e.defaultPrevented) return
    if (PREVENT.has(e.code) && !isControlTarget(e.target)) e.preventDefault()
    callbacks.onGesture()
    if ((e.code === "Escape" || e.code === "KeyP") && !e.repeat) {
      callbacks.onPause()
      return
    }
    // Some virtual/IME keyboards report an empty `code`; fall back to `key` only then.
    // Paused / round over: no ability queueing and no held keys (a press must not fire on resume).
    if (!enabled) return
    const ability = ABILITY_KEYS[e.code] ?? (e.code === "" ? ABILITY_BY_KEY[e.key.toLowerCase()] : undefined)
    if (ability) {
      if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) queued[ability] = true
      return
    }
    keys.add(e.code)
  }

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space" && !isTextTarget(e.target) && !isControlTarget(e.target)) e.preventDefault()
    keys.delete(e.code)
  }

  const setMouseFrom = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    mx = e.clientX - r.left
    my = e.clientY - r.top
    haveMouse = true
    mouseButtons = pressOnCanvas ? e.buttons & 3 : 0
  }

  const onPointerDown = (e: PointerEvent) => {
    callbacks.onGesture()
    if (e.pointerType !== "mouse") return
    pressOnCanvas = true
    setMouseFrom(e)
    // Capture so the release still reaches us when the drag ends outside the canvas, including
    // outside the iframe when embedded. Without it the ship keeps thrusting after release.
    try {
      canvas.setPointerCapture(e.pointerId)
      captured = true
    } catch {
      // Pointer already gone; the window listeners still clear state on the next event.
    }
  }

  const onLostCapture = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return
    captured = false
    mouseButtons = 0
    pressOnCanvas = false
  }

  const onLeave = () => {
    if (captured) return
    mouseButtons = 0
    pressOnCanvas = false
  }

  const onWindowPointer = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return
    setMouseFrom(e)
    if ((e.buttons & 3) === 0) pressOnCanvas = false
  }

  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return
    mouseButtons = 0
    pressOnCanvas = false
  }

  const onContextMenu = (e: Event) => e.preventDefault()

  const clear = () => {
    keys.clear()
    mouseButtons = 0
    pressOnCanvas = false
    virtual = null
    queued.dash = queued.repulse = queued.ult = false
    captured = false
  }

  window.addEventListener("keydown", onKeyDown)
  window.addEventListener("keyup", onKeyUp)
  window.addEventListener("blur", clear)
  window.addEventListener("pointerleave", onLeave)
  document.documentElement.addEventListener("mouseleave", onLeave)
  window.addEventListener("pointermove", onWindowPointer)
  window.addEventListener("pointerup", onWindowPointer)
  window.addEventListener("pointercancel", onPointerCancel)
  canvas.addEventListener("pointerdown", onPointerDown)
  canvas.addEventListener("lostpointercapture", onLostCapture)
  canvas.addEventListener("contextmenu", onContextMenu)

  return {
    read(playerScreen: Vec): Intent {
      let ax = 0
      let ay = 0
      const kx = (held(RIGHT) ? 1 : 0) - (held(LEFT) ? 1 : 0)
      const ky = (held(DOWN) ? 1 : 0) - (held(UP) ? 1 : 0)
      if (kx !== 0 || ky !== 0) {
        const len = Math.hypot(kx, ky)
        ax = kx / len
        ay = ky / len
      } else if ((mouseButtons & 1) !== 0 && haveMouse) {
        const dx = mx - playerScreen.x
        const dy = my - playerScreen.y
        const dist = Math.hypot(dx, dy)
        if (dist > 0) {
          const strength = Math.min(1, Math.max(0, (dist - 12) / (90 - 12)))
          ax = (dx / dist) * strength
          ay = (dy / dist) * strength
        }
      } else if (virtual) {
        ax = virtual.ax
        ay = virtual.ay
      }
      const pull = held(PULL) || ((mouseButtons & 2) !== 0) || (virtual?.pull ?? false)
      const out: Intent = { ax, ay, pull, dash: queued.dash, repulse: queued.repulse, ult: queued.ult }
      queued.dash = queued.repulse = queued.ult = false
      return out
    },
    press(kind: "dash" | "repulse" | "ult") {
      if (enabled) queued[kind] = true
    },
    setEnabled(on: boolean) {
      enabled = on
      if (!on) clear()
    },
    setVirtual(v: Intent | null) {
      virtual = v
    },
    clear,
    dispose() {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", clear)
      window.removeEventListener("pointerleave", onLeave)
      document.documentElement.removeEventListener("mouseleave", onLeave)
      window.removeEventListener("pointermove", onWindowPointer)
      window.removeEventListener("pointerup", onWindowPointer)
      window.removeEventListener("pointercancel", onPointerCancel)
      canvas.removeEventListener("pointerdown", onPointerDown)
      canvas.removeEventListener("lostpointercapture", onLostCapture)
      canvas.removeEventListener("contextmenu", onContextMenu)
    },
  }
}
