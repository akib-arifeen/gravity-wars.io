// Pure camera and navigation math shared by the renderer and the tests. Nothing here touches the
// DOM or the World; the renderer feeds it the last frame's camera and gets screen-space answers.

import { CONFIG } from "./config"

/** Rival/eye sense multiplier for an arena: 1 at classic scale, capped by CONFIG.camera.senseMax. */
export function arenaScale(arenaBase: number): number {
  const s = Math.sqrt(Math.max(1, arenaBase) / CONFIG.camera.arenaRadiusRef)
  return Math.min(CONFIG.camera.senseMax, Math.max(1, s))
}

/** Multiplier applied to the camera zoom target so larger arenas show more context. */
export function cameraZoomScale(arenaBase: number): number {
  const s = Math.sqrt(CONFIG.camera.arenaRadiusRef / Math.max(1, arenaBase))
  return Math.max(CONFIG.camera.arenaZoomFloor, Math.min(1, s))
}

/** How far (world units) off-screen rival arrows reach: classic's 1600, widened with the arena. */
export function indicatorRange(arenaBase: number): number {
  const extra = Math.max(0, arenaBase - CONFIG.camera.arenaRadiusRef) * CONFIG.camera.indicatorRangeGain
  return CONFIG.camera.indicatorRangeMin + extra
}

/** A marker on the rectangular edge that points back toward an off-screen world point. */
export interface FrameEdgeMarker {
  /** Screen position of the marker (CSS px). */
  x: number
  y: number
  /** Direction from the screen centre to the point (radians). */
  angle: number
  /** World distance from the camera target to the point. */
  distance: number
}

/**
 * Point a compass marker at (x, y) when it is outside the viewport. Returns null when the point is
 * on screen. Bounds default to the viewport edge; the renderer passes the HUD-safe rectangle.
 */
export function frameEdgeMarker(
  x: number,
  y: number,
  camX: number,
  camY: number,
  zoom: number,
  width: number,
  height: number,
  bounds?: { left: number; top: number; right: number; bottom: number },
): FrameEdgeMarker | null {
  const sx = (x - camX) * zoom + width / 2
  const sy = (y - camY) * zoom + height / 2
  if (sx >= 0 && sx <= width && sy >= 0 && sy <= height) return null
  const left = bounds ? bounds.left : 0
  const top = bounds ? bounds.top : 0
  const right = bounds ? bounds.right : width
  const bottom = bounds ? bounds.bottom : height
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  const dx = sx - cx
  const dy = sy - cy
  const hw = Math.max(1, (right - left) / 2)
  const hh = Math.max(1, (bottom - top) / 2)
  const tx = Math.abs(dx) < 1e-9 ? Infinity : hw / Math.abs(dx)
  const ty = Math.abs(dy) < 1e-9 ? Infinity : hh / Math.abs(dy)
  const t = Math.min(tx, ty)
  return {
    x: cx + dx * t,
    y: cy + dy * t,
    angle: Math.atan2(dy, dx),
    distance: Math.hypot(x - camX, y - camY),
  }
}
