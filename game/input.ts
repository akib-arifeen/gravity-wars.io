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
   * The player's intent right now. Keyboard (WASD/arrows, normalised; Space or Shift = pull)
   * wins over mouse when any direction key is held. Mouse: while the primary button is held on
   * the canvas, thrust toward the cursor (full strength beyond 90 px from playerScreen, scaling
   * down to 0 at 12 px); secondary button held = pull. Touch: the on-screen controls write
   * through setVirtual().
   */
  read(playerScreen: Vec): Intent
  /** Joystick/pull button state from on-screen touch controls; merged with the others. */
  setVirtual(v: Intent | null): void
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
  // When embedded, a drag released outside the iframe may never reach us (no pointerup, no
  // leave). Mouse thrust therefore lapses after this long without any pointer event; the next
  // movement resumes it. Removing this lets the ship thrust forever after such a release.
  const MOUSE_STALE_MS = 2500
  let lastPointerAt = 0
  let virtual: Intent | null = null

  const LEFT = ["KeyA", "ArrowLeft"]
  const RIGHT = ["KeyD", "ArrowRight"]
  const UP = ["KeyW", "ArrowUp"]
  const DOWN = ["KeyS", "ArrowDown"]
  const PULL = ["Space", "ShiftLeft", "ShiftRight"]
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
    lastPointerAt = performance.now()
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
    } catch {
      // Pointer already gone; the window listeners still clear state on the next event.
    }
  }

  const onLostCapture = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return
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
  }

  window.addEventListener("keydown", onKeyDown)
  window.addEventListener("keyup", onKeyUp)
  window.addEventListener("blur", clear)
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
      } else if ((mouseButtons & 1) !== 0 && haveMouse && performance.now() - lastPointerAt < MOUSE_STALE_MS) {
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
      const mouseFresh = performance.now() - lastPointerAt < MOUSE_STALE_MS
      const pull = held(PULL) || ((mouseButtons & 2) !== 0 && mouseFresh) || (virtual?.pull ?? false)
      return { ax, ay, pull }
    },
    setVirtual(v: Intent | null) {
      virtual = v
    },
    clear,
    dispose() {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", clear)
      window.removeEventListener("pointermove", onWindowPointer)
      window.removeEventListener("pointerup", onWindowPointer)
      window.removeEventListener("pointercancel", onPointerCancel)
      canvas.removeEventListener("pointerdown", onPointerDown)
      canvas.removeEventListener("lostpointercapture", onLostCapture)
      canvas.removeEventListener("contextmenu", onContextMenu)
    },
  }
}
