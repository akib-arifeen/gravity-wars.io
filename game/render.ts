// Canvas 2D renderer. Reads the World, never mutates it. Owns the camera, particles, screen
// shake, floating text and every visual effect; none of that touches simulation state.
//
// CONTRACT — exported signatures and documented behaviour are fixed.

import { CONFIG } from "./config"
import { canAbsorb, pullRadius } from "./engine"
import type { Body, GameEvent, Vec, World } from "./types"

export interface RenderView {
  /** Canvas size in CSS pixels. */
  width: number
  height: number
  /** devicePixelRatio to render at (the shell caps it at 2). */
  dpr: number
  /** prefers-reduced-motion: no screen shake, no flashes, gentler particles. */
  reducedMotion: boolean
  /** "touch" leaves room for the on-screen joystick (bottom-left) and pull button (bottom-right). */
  layout: "desktop" | "touch"
  /**
   * Attract mode behind the menu: draw the world only — no vignette, flashes, floating text,
   * off-screen indicators or minimap.
   */
  demo?: boolean
}

export interface Renderer {
  /**
   * Draw one frame. alpha in [0, 1] interpolates every body and debris between (px, py) and
   * (x, y). frameDt is the real seconds since the previous frame (for camera smoothing,
   * particles and decay of shake), independent of the physics step.
   */
  render(world: World, alpha: number, frameDt: number): void
  /** Feed the events of one step (particles, shake, pop, floating text). Call after every step. */
  onEvents(world: World, events: readonly GameEvent[]): void
  /** Call when the canvas is resized; sets the backing store to width*dpr x height*dpr. */
  resize(view: RenderView): void
  /** Convert a CSS-pixel point on the canvas to world coordinates using the last frame's camera. */
  screenToWorld(sx: number, sy: number): Vec
  /** Where the player was drawn last frame, in CSS pixels. */
  playerScreen(): Vec
  /** Reset camera, particles and effects (call when a new world starts). */
  reset(world: World): void
  dispose(): void
}

// ---------------------------------------------------------------------------------------------
// Constants and pure helpers
// ---------------------------------------------------------------------------------------------

const TAU = Math.PI * 2
const MAX_PARTICLES = 700
const MAX_TEXTS = 12
const SPRITE = 128
const TILE = 512

const C_BG = "#02030a"
const C_PLAYER = "#5ef2ff"
const C_THREAT = "#ff4d6d"
const C_PREY = "#7bed9f"
const C_AMBER = "#ffb84d"
const C_WORM = "#9d7bff"
const C_TEXT = "#e8f6ff"
const C_DUST = "#8b93a7"
const C_ROCK = "#b08968"
const C_NEUTRAL = "rgba(255,255,255,0.5)"
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

const P_DOT = 0
const P_RING = 1
const P_FLASH = 2

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  return c
}

function parseColor(c: string): [number, number, number] {
  if (c.charAt(0) === "#") {
    if (c.length === 7) {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
    }
    if (c.length === 4) {
      return [parseInt(c.charAt(1) + c.charAt(1), 16), parseInt(c.charAt(2) + c.charAt(2), 16), parseInt(c.charAt(3) + c.charAt(3), 16)]
    }
  }
  return [255, 255, 255]
}

function lighten(c: string, t: number): string {
  const [r, g, b] = parseColor(c)
  return `rgb(${Math.round(r + (255 - r) * t)},${Math.round(g + (255 - g) * t)},${Math.round(b + (255 - b) * t)})`
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// ---------------------------------------------------------------------------------------------

export function createRenderer(canvas: HTMLCanvasElement, view: RenderView): Renderer {
  const ctx = canvas.getContext("2d", { alpha: false })
  if (!ctx) {
    // No 2D context available: return a renderer that draws nothing rather than crash the shell.
    const none: Vec = { x: 0, y: 0 }
    return {
      render() {},
      onEvents() {},
      resize() {},
      screenToWorld: () => none,
      playerScreen: () => none,
      reset() {},
      dispose() {},
    }
  }
  const g: CanvasRenderingContext2D = ctx

  // ---- view -------------------------------------------------------------------------------
  let W = view.width
  let H = view.height
  let dpr = view.dpr
  let reduced = view.reducedMotion
  let touch = view.layout === "touch"
  let demo = !!view.demo

  // ---- camera -----------------------------------------------------------------------------
  let camX = 0
  let camY = 0
  let zoom = 1
  let aliveZoomTarget = 1
  let camInit = false
  let shx = 0
  let shy = 0
  let playerSx = W / 2
  let playerSy = H / 2
  let clock = 0

  // ---- effects state ----------------------------------------------------------------------
  let trauma = 0
  let flashT = 0
  let vigI = 0
  let vigAmber = false

  // ---- sprite caches ----------------------------------------------------------------------
  const glowCache = new Map<string, HTMLCanvasElement>()
  const discCache = new Map<string, HTMLCanvasElement>()
  let ringSprite: HTMLCanvasElement | null = null
  let vignetteSprite: HTMLCanvasElement | null = null

  function glow(color: string): HTMLCanvasElement {
    let s = glowCache.get(color)
    if (!s) {
      s = makeCanvas(SPRITE, SPRITE)
      const sg = s.getContext("2d")
      if (sg) {
        const [r, gg, b] = parseColor(color)
        const gd = sg.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2)
        gd.addColorStop(0, `rgba(${r},${gg},${b},1)`)
        gd.addColorStop(0.25, `rgba(${r},${gg},${b},0.45)`)
        gd.addColorStop(0.6, `rgba(${r},${gg},${b},0.12)`)
        gd.addColorStop(1, `rgba(${r},${gg},${b},0)`)
        sg.fillStyle = gd
        sg.fillRect(0, 0, SPRITE, SPRITE)
      }
      glowCache.set(color, s)
    }
    return s
  }

  /** Lit sphere sprite: highlight colour c0 near the upper-left, base colour c1 at the rim. */
  function disc(c0: string, c1: string): HTMLCanvasElement {
    const key = c0 + "|" + c1
    let s = discCache.get(key)
    if (!s) {
      s = makeCanvas(SPRITE, SPRITE)
      const sg = s.getContext("2d")
      if (sg) {
        const gd = sg.createRadialGradient(SPRITE * 0.42, SPRITE * 0.4, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2)
        gd.addColorStop(0, c0)
        gd.addColorStop(1, c1)
        sg.fillStyle = gd
        sg.beginPath()
        sg.arc(SPRITE / 2, SPRITE / 2, SPRITE / 2 - 1, 0, TAU)
        sg.fill()
      }
      discCache.set(key, s)
    }
    return s
  }
  const DISC_PAD = SPRITE / (SPRITE - 2)
  const bodyDiscCache = new Map<string, HTMLCanvasElement>()
  /** Per-colour body sprite (keyed by colour alone so the hot loop builds no strings). */
  function bodyDisc(color: string): HTMLCanvasElement {
    let s = bodyDiscCache.get(color)
    if (!s) {
      s = disc(lighten(color, 0.55), color)
      bodyDiscCache.set(color, s)
    }
    return s
  }

  function getRingSprite(): HTMLCanvasElement {
    if (!ringSprite) {
      ringSprite = makeCanvas(SPRITE * 2, SPRITE * 2)
      const sg = ringSprite.getContext("2d")
      if (sg) {
        const S = SPRITE * 2
        const gd = sg.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
        gd.addColorStop(0, "rgba(255,77,141,0)")
        gd.addColorStop(0.3, "rgba(255,77,141,0)")
        gd.addColorStop(0.38, "rgba(255,77,141,0.95)")
        gd.addColorStop(0.55, "rgba(199,125,255,0.6)")
        gd.addColorStop(0.78, "rgba(199,125,255,0.14)")
        gd.addColorStop(1, "rgba(199,125,255,0)")
        sg.fillStyle = gd
        sg.fillRect(0, 0, S, S)
      }
    }
    return ringSprite
  }

  let vignetteAmber: HTMLCanvasElement | null = null
  function getVignette(amber: boolean): HTMLCanvasElement {
    const make = (rgb: string) => {
      const c = makeCanvas(256, 256)
      const sg = c.getContext("2d")
      if (sg) {
        const gd = sg.createRadialGradient(128, 128, 0, 128, 128, 128)
        gd.addColorStop(0, `rgba(${rgb},0)`)
        gd.addColorStop(0.55, `rgba(${rgb},0)`)
        gd.addColorStop(1, `rgba(${rgb},1)`)
        sg.fillStyle = gd
        sg.fillRect(0, 0, 256, 256)
      }
      return c
    }
    if (amber) return vignetteAmber || (vignetteAmber = make("255,184,77"))
    return vignetteSprite || (vignetteSprite = make("255,40,70"))
  }

  // ---- star background --------------------------------------------------------------------
  const STAR_DENSITY = [90, 50, 20]
  const STAR_SIZE: Array<[number, number]> = [
    [0.6, 1.0],
    [0.8, 1.3],
    [1.0, 1.6],
  ]
  const STAR_PARALLAX = [0.05, 0.12, 0.25]
  const STAR_TINT = ["#ffffff", "#cfe8ff", "#ffe9cf", "#ffffff"]
  let tilePatterns: Array<CanvasPattern | null> = []
  let tileDpr = 0
  const patMatrix: DOMMatrix | null = typeof DOMMatrix !== "undefined" ? new DOMMatrix() : null

  function buildTiles() {
    tilePatterns = []
    tileDpr = dpr
    const px = Math.round(TILE * dpr)
    for (let layer = 0; layer < 3; layer++) {
      const tile = makeCanvas(px, px)
      const tg = tile.getContext("2d")
      if (tg) {
        tg.scale(dpr, dpr)
        let s = 0x1234abcd + layer * 7919
        const next = () => {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0
          return s / 4294967296
        }
        for (let i = 0; i < STAR_DENSITY[layer]; i++) {
          const x = 2 + next() * (TILE - 4)
          const y = 2 + next() * (TILE - 4)
          const size = STAR_SIZE[layer][0] + next() * (STAR_SIZE[layer][1] - STAR_SIZE[layer][0])
          const a = 0.35 + next() * 0.55
          tg.globalAlpha = a
          tg.fillStyle = STAR_TINT[(next() * STAR_TINT.length) | 0]
          tg.beginPath()
          tg.arc(x, y, size, 0, TAU)
          tg.fill()
        }
      }
      tilePatterns.push(g.createPattern(tile, "repeat"))
    }
  }

  // ---- nebulae (world space, from world.seed) ---------------------------------------------
  const NEBULA_COLORS = ["#3b2a8f", "#0f5a7a", "#7a1f5c"]
  const nebX = [0, 0, 0]
  const nebY = [0, 0, 0]
  const nebR = [0, 0, 0]
  let nebSeed = -1

  function placeNebulae(seed: number) {
    nebSeed = seed
    let s = (Math.floor(Math.abs(seed)) ^ 0x5bd1e995) >>> 0
    const next = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 4294967296
    }
    for (let i = 0; i < 3; i++) {
      const a = next() * TAU
      const d = 300 + next() * 1300
      nebX[i] = Math.cos(a) * d
      nebY[i] = Math.sin(a) * d
      nebR[i] = 600 + next() * 450
    }
  }

  // ---- per-body visual state (indexed like world.bodies) ----------------------------------
  let popX: number[] = []
  let popV: number[] = []
  let emitThrust: number[] = []
  let emitSpark: number[] = []
  let bx = new Float64Array(16)
  let by = new Float64Array(16)

  function ensureBodies(n: number) {
    while (popX.length < n) {
      popX.push(0)
      popV.push(0)
      emitThrust.push(0)
      emitSpark.push(0)
    }
    if (bx.length < n) {
      bx = new Float64Array(n * 2)
      by = new Float64Array(n * 2)
    }
  }

  // ---- particle pool (struct of arrays) ---------------------------------------------------
  const pX = new Float32Array(MAX_PARTICLES)
  const pY = new Float32Array(MAX_PARTICLES)
  const pVX = new Float32Array(MAX_PARTICLES)
  const pVY = new Float32Array(MAX_PARTICLES)
  const pLife = new Float32Array(MAX_PARTICLES)
  const pMax = new Float32Array(MAX_PARTICLES)
  const pSize = new Float32Array(MAX_PARTICLES)
  const pKind = new Uint8Array(MAX_PARTICLES)
  const pCol: string[] = new Array(MAX_PARTICLES).fill("#ffffff")
  let pn = 0

  function addP(kind: number, x: number, y: number, vx: number, vy: number, life: number, size: number, color: string, force: boolean) {
    let i = pn
    if (i >= MAX_PARTICLES) {
      if (!force) return
      i = (Math.random() * MAX_PARTICLES) | 0
    } else if (!force && pn > MAX_PARTICLES * 0.85) {
      return
    } else {
      pn++
    }
    pX[i] = x
    pY[i] = y
    pVX[i] = vx
    pVY[i] = vy
    pLife[i] = life
    pMax[i] = life
    pSize[i] = size
    pKind[i] = kind
    pCol[i] = color
  }

  function burst(x: number, y: number, count: number, vMin: number, vMax: number, life: number, sizePx: number, color: string, force: boolean) {
    const n = reduced ? Math.ceil(count * 0.5) : count
    const sp = reduced ? 0.6 : 1
    const size = sizePx / zoom
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU
      const v = (vMin + Math.random() * (vMax - vMin)) * sp
      addP(P_DOT, x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.7 + Math.random() * 0.6), size * (0.7 + Math.random() * 0.6), color, force)
    }
  }

  function shockwave(x: number, y: number, maxR: number, color: string) {
    addP(P_RING, x, y, 0, 0, 0.45, maxR, color, true)
  }

  function flashAt(x: number, y: number, size: number, color: string) {
    addP(P_FLASH, x, y, 0, 0, 0.35, size, color, true)
  }

  // ---- floating text ----------------------------------------------------------------------
  const tText: string[] = new Array(MAX_TEXTS).fill("")
  const tX = new Float64Array(MAX_TEXTS)
  const tY = new Float64Array(MAX_TEXTS)
  const tAge = new Float32Array(MAX_TEXTS)
  const tLife = new Float32Array(MAX_TEXTS) // 0 = inactive
  const tSize = new Float32Array(MAX_TEXTS)
  const tCol: string[] = new Array(MAX_TEXTS).fill("#fff")
  const tGain = new Uint8Array(MAX_TEXTS)
  const TEXT_LIFE = 0.8
  let gainIdx = -1
  let gainTotal = 0
  let gainAt = -10

  function spawnText(text: string, x: number, y: number, color: string, size: number, isGain: boolean): number {
    let idx = -1
    let oldest = -1
    for (let i = 0; i < MAX_TEXTS; i++) {
      if (tLife[i] <= 0) {
        idx = i
        break
      }
      if (tAge[i] > oldest) {
        oldest = tAge[i]
        idx = i
      }
    }
    tText[idx] = text
    tX[idx] = x
    tY[idx] = y
    tAge[idx] = 0
    tLife[idx] = TEXT_LIFE
    tSize[idx] = size
    tCol[idx] = color
    tGain[idx] = isGain ? 1 : 0
    return idx
  }

  // ---- misc scratch -----------------------------------------------------------------------
  const dash: number[] = [0, 0]
  const NO_DASH: number[] = []

  function setDash(a: number, b: number) {
    dash[0] = a
    dash[1] = b
    g.setLineDash(dash)
  }

  function bodyIndex(world: World, id: string): number {
    const bs = world.bodies
    for (let i = 0; i < bs.length; i++) if (bs[i].id === id) return i
    return -1
  }

  function visible(x: number, y: number, r: number): boolean {
    const hw = W / (2 * zoom) + r + 20 / zoom
    const hh = H / (2 * zoom) + r + 20 / zoom
    return Math.abs(x - camX) < hw && Math.abs(y - camY) < hh
  }

  function setScreen() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function setWorld() {
    g.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (W / 2 + shx - camX * zoom), dpr * (H / 2 + shy - camY * zoom))
  }

  function zoomTargetFor(world: World, p: Body): number {
    let zt = Math.sqrt(W * H) / (1000 + p.radius * 8)
    if (world.phase === "countdown") zt *= 0.75
    if (demo) zt *= 0.55
    return zt
  }

  // ---- public: reset / resize -------------------------------------------------------------
  function reset(world: World) {
    const p = world.bodies[0]
    if (p) {
      camX = p.x + p.vx * 0.18
      camY = p.y + p.vy * 0.18
      if (demo) {
        camX *= 0.65
        camY *= 0.65
      }
      aliveZoomTarget = zoomTargetFor(world, p)
      zoom = aliveZoomTarget
      playerSx = W / 2
      playerSy = H / 2
    }
    camInit = true
    pn = 0
    for (let i = 0; i < MAX_TEXTS; i++) tLife[i] = 0
    gainIdx = -1
    gainTotal = 0
    trauma = 0
    flashT = 0
    vigI = 0
    shx = 0
    shy = 0
    ensureBodies(world.bodies.length)
    for (let i = 0; i < popX.length; i++) {
      popX[i] = 0
      popV[i] = 0
      emitThrust[i] = 0
      emitSpark[i] = 0
    }
    placeNebulae(world.seed)
  }

  function resize(v: RenderView) {
    W = v.width
    H = v.height
    dpr = v.dpr
    reduced = v.reducedMotion
    touch = v.layout === "touch"
    demo = !!v.demo
    canvas.width = Math.max(1, Math.round(W * dpr))
    canvas.height = Math.max(1, Math.round(H * dpr))
    if (tileDpr !== dpr) buildTiles()
  }

  // ---- public: events ---------------------------------------------------------------------
  function onEvents(world: World, events: readonly GameEvent[]) {
    ensureBodies(world.bodies.length)
    const player = world.bodies[0]
    for (let n = 0; n < events.length; n++) {
      const ev = events[n]
      switch (ev.type) {
        case "eat": {
          const bi = bodyIndex(world, ev.bodyId)
          if (bi >= 0) {
            const amt = ev.kind === "crystal" ? 0.1 : 0.06
            popX[bi] += amt * 0.5
            popV[bi] += amt * 8
          }
          if (visible(ev.x, ev.y, 100)) {
            const col = ev.kind === "dust" ? C_DUST : ev.kind === "rock" ? C_ROCK : C_PLAYER
            const cnt = 4 + ((Math.random() * 5) | 0)
            burst(ev.x, ev.y, cnt, 30, 95, 0.4, ev.kind === "crystal" ? 2.4 : 1.8, col, false)
          }
          if (ev.bodyId === "player" && player) {
            if (gainIdx >= 0 && tLife[gainIdx] > 0 && tGain[gainIdx] === 1 && clock - gainAt < 0.15) {
              gainTotal += ev.mass
              tText[gainIdx] = "+" + gainTotal.toFixed(1)
              if (tAge[gainIdx] > 0.3) tAge[gainIdx] = 0.3
              tLife[gainIdx] = TEXT_LIFE
            } else {
              gainTotal = ev.mass
              gainIdx = spawnText("+" + gainTotal.toFixed(1), player.x, player.y - player.radius, C_TEXT, 14, true)
            }
            gainAt = clock
          }
          break
        }
        case "absorb": {
          const vi = bodyIndex(world, ev.victimId)
          const ei = bodyIndex(world, ev.eaterId)
          const victim = vi >= 0 ? world.bodies[vi] : null
          const col = victim ? victim.color : C_THREAT
          const vr = victim ? victim.radius : 12
          if (ei >= 0) {
            popX[ei] += 0.28 * 0.5
            popV[ei] += 0.28 * 8
          }
          burst(ev.x, ev.y, 40, 60, 360, 0.8, 3, col, true)
          shockwave(ev.x, ev.y, vr * 4, col)
          if (ev.eaterId === "player") {
            trauma = Math.min(1, trauma + 0.35)
            flashT = 0.08
            spawnText("ABSORBED " + (victim ? victim.name : ""), ev.x, ev.y - vr - 10, C_TEXT, 22, false)
          } else if (ev.victimId !== "player" && visible(ev.x, ev.y, 0)) {
            trauma = Math.min(1, trauma + 0.15)
          }
          break
        }
        case "death": {
          if (ev.bodyId === "player") trauma = Math.min(1, trauma + 0.8)
          if (ev.cause.by !== "body") {
            const bi = bodyIndex(world, ev.bodyId)
            const col = bi >= 0 ? world.bodies[bi].color : C_AMBER
            burst(ev.x, ev.y, 50, 60, 380, 0.9, 3, col, true)
            flashAt(ev.x, ev.y, 140, "#ffffff")
            if (ev.bodyId === "player") flashT = Math.max(flashT, 0.08)
          }
          break
        }
        case "bounce": {
          burst(ev.x, ev.y, 8, 80, 260, 0.3, 1.8, "#ffe9a8", true)
          if (ev.aId === "player" || ev.bId === "player") trauma = Math.min(1, trauma + 0.15)
          break
        }
        case "warp": {
          const r = 60
          const n = reduced ? 12 : 24
          for (let i = 0; i < n; i++) {
            const a = Math.random() * TAU
            const ca = Math.cos(a)
            const sa = Math.sin(a)
            addP(P_DOT, ev.fromX + ca * r, ev.fromY + sa * r, (-ca * r) / 0.35, (-sa * r) / 0.35, 0.35, 3 / zoom, C_WORM, true)
          }
          burst(ev.toX, ev.toY, 24, 80, 260, 0.5, 3, C_WORM, true)
          break
        }
        case "lowEnergy": {
          if (ev.bodyId === "player" && player) spawnText("LOW ENERGY", player.x, player.y - player.radius - 20, C_AMBER, 16, false)
          break
        }
        default:
          break
      }
    }
  }

  // ---- frame passes -----------------------------------------------------------------------
  function drawBackground() {
    setScreen()
    for (let layer = 0; layer < 3; layer++) {
      const pat = tilePatterns[layer]
      if (!pat) continue
      if (patMatrix) {
        const f = STAR_PARALLAX[layer]
        patMatrix.a = 1 / dpr
        patMatrix.d = 1 / dpr
        patMatrix.e = -camX * f + shx
        patMatrix.f = -camY * f + shy
        pat.setTransform(patMatrix)
      }
      g.fillStyle = pat
      g.fillRect(0, 0, W, H)
    }
  }

  function drawNebulae() {
    g.globalCompositeOperation = "lighter"
    g.globalAlpha = 0.22
    for (let i = 0; i < 3; i++) {
      if (!visible(nebX[i], nebY[i], nebR[i])) continue
      g.drawImage(glow(NEBULA_COLORS[i]), nebX[i] - nebR[i], nebY[i] - nebR[i], nebR[i] * 2, nebR[i] * 2)
    }
    g.globalAlpha = 1
    g.globalCompositeOperation = "source-over"
  }

  function drawArena(world: World, player: Body | undefined, ppx: number, ppy: number) {
    const R = world.arenaRadius
    if (player && player.alive) {
      const edge = R - Math.hypot(ppx, ppy)
      if (edge < 300) {
        const a = clamp(1 - edge / 300, 0, 1)
        g.strokeStyle = C_THREAT
        const widths = [40, 100, 180]
        for (let i = 0; i < 3; i++) {
          g.globalAlpha = a * 0.07
          g.lineWidth = widths[i]
          g.beginPath()
          g.arc(0, 0, R - widths[i] / 2, 0, TAU)
          g.stroke()
        }
        g.globalAlpha = 1
      }
    }
    g.strokeStyle = "rgba(94,242,255,0.25)"
    g.lineWidth = 2 / zoom
    g.beginPath()
    g.arc(0, 0, R, 0, TAU)
    g.stroke()
  }

  function drawWells(world: World, player: Body | undefined) {
    const wells = world.wells
    for (let i = 0; i < wells.length; i++) {
      const w = wells[i]
      const r = w.radius
      if (w.kind === "star") {
        const outer = Math.max(r * 4, w.chargeRadius)
        if (!visible(w.x, w.y, outer)) continue
        // glow
        g.globalCompositeOperation = "lighter"
        g.globalAlpha = 0.85
        g.drawImage(glow("#ffb347"), w.x - r * 4, w.y - r * 4, r * 8, r * 8)
        // corona: 8 wobbling spikes, slowly rotating
        g.globalAlpha = 0.4
        g.fillStyle = "#ffc86b"
        g.beginPath()
        const rot = clock * 0.18
        for (let k = 0; k < 8; k++) {
          const a = rot + (k * TAU) / 8
          const len = r * (1.5 + 0.35 * Math.sin(clock * 1.7 + k * 1.3))
          const hw = 0.2
          g.moveTo(w.x + Math.cos(a - hw) * r * 0.9, w.y + Math.sin(a - hw) * r * 0.9)
          g.lineTo(w.x + Math.cos(a) * len, w.y + Math.sin(a) * len)
          g.lineTo(w.x + Math.cos(a + hw) * r * 0.9, w.y + Math.sin(a + hw) * r * 0.9)
        }
        g.fill()
        g.globalAlpha = 1
        g.globalCompositeOperation = "source-over"
        // disk
        g.drawImage(disc("#fff3c4", "#ffb347"), w.x - r * DISC_PAD, w.y - r * DISC_PAD, r * 2 * DISC_PAD, r * 2 * DISC_PAD)
        // dashed charge band
        if (w.chargeRadius > 0) {
          g.globalAlpha = player && player.alive && player.charging ? 0.4 : 0.18
          g.strokeStyle = C_AMBER
          g.lineWidth = 1.6 / zoom
          setDash(18, 14)
          g.lineDashOffset = -clock * 8
          g.beginPath()
          g.arc(w.x, w.y, w.chargeRadius, 0, TAU)
          g.stroke()
          g.setLineDash(NO_DASH)
          g.lineDashOffset = 0
          g.globalAlpha = 1
        }
      } else {
        if (!visible(w.x, w.y, r * 4.5)) continue
        g.globalCompositeOperation = "lighter"
        g.globalAlpha = 0.45
        g.drawImage(glow("#7a3cff"), w.x - r * 4.5, w.y - r * 4.5, r * 9, r * 9)
        g.globalAlpha = 0.9
        const ro = r * 3
        g.drawImage(getRingSprite(), w.x - ro, w.y - ro, ro * 2, ro * 2)
        // rotating accretion arcs
        g.lineCap = "round"
        for (let k = 0; k < 3; k++) {
          const rad = r * (1.55 + 0.55 * k)
          const rot = clock * (1.9 - 0.45 * k) * (k % 2 === 0 ? 1 : -1)
          g.strokeStyle = k % 2 === 0 ? "#c77dff" : "#ff4d8d"
          g.lineWidth = r * (0.24 - 0.05 * k)
          g.globalAlpha = 0.8
          g.beginPath()
          g.arc(w.x, w.y, rad, rot, rot + 2.4)
          g.stroke()
          g.globalAlpha = 0.45
          g.beginPath()
          g.arc(w.x, w.y, rad, rot + 3.3, rot + 4.9)
          g.stroke()
        }
        g.lineCap = "butt"
        g.globalAlpha = 1
        g.globalCompositeOperation = "source-over"
        // core + lensing ring
        g.fillStyle = "#000"
        g.beginPath()
        g.arc(w.x, w.y, r, 0, TAU)
        g.fill()
        g.strokeStyle = "rgba(255,232,255,0.85)"
        g.lineWidth = 1.5 / zoom
        g.beginPath()
        g.arc(w.x, w.y, r * 1.12, 0, TAU)
        g.stroke()
      }
    }
  }

  function drawWormholes(world: World) {
    const whs = world.wormholes
    g.globalCompositeOperation = "lighter"
    g.lineCap = "round"
    for (let i = 0; i < whs.length; i++) {
      const w = whs[i]
      const r = w.radius * 1.6
      if (!visible(w.x, w.y, r * 3.5)) continue
      const breathe = 0.5 + 0.5 * Math.sin(clock * 1.2 + i * 2)
      g.globalAlpha = 1
      g.drawImage(glow(C_WORM), w.x - r * 3, w.y - r * 3, r * 6, r * 6)
      g.globalAlpha = 0.6
      g.drawImage(glow("#c9b6ff"), w.x - r * 1.4, w.y - r * 1.4, r * 2.8, r * 2.8)
      g.strokeStyle = C_WORM
      g.lineWidth = 2.8 / zoom + 0.8
      g.globalAlpha = 1
      for (let k = 0; k < 3; k++) {
        const dir = k % 2 === 0 ? 1 : -1
        const a0 = clock * 1.6 * dir + (k * TAU) / 3
        g.beginPath()
        const SEG = 10
        for (let s = 0; s <= SEG; s++) {
          const t = s / SEG
          const a = a0 + dir * t * 2.6
          const rad = r * (0.25 + 0.75 * t)
          const x = w.x + Math.cos(a) * rad
          const y = w.y + Math.sin(a) * rad
          if (s === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.stroke()
      }
      g.globalAlpha = 0.3
      g.lineWidth = 1.6 / zoom
      g.beginPath()
      g.arc(w.x, w.y, r * (1.5 + 0.2 * breathe), 0, TAU)
      g.stroke()
    }
    g.lineCap = "butt"
    g.globalAlpha = 1
    g.globalCompositeOperation = "source-over"
  }

  function drawDebris(world: World, alpha: number) {
    const ds = world.debris
    const hw = W / (2 * zoom) + 30 / zoom
    const hh = H / (2 * zoom) + 30 / zoom
    // dust
    const dustMin = 1 / zoom
    g.fillStyle = C_DUST
    g.beginPath()
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i]
      if (d.kind !== "dust") continue
      const x = d.px + (d.x - d.px) * alpha
      const y = d.py + (d.y - d.py) * alpha
      if (Math.abs(x - camX) > hw || Math.abs(y - camY) > hh) continue
      const r = d.radius > dustMin ? d.radius : dustMin
      g.moveTo(x + r, y)
      g.arc(x, y, r, 0, TAU)
    }
    g.fill()
    // rock
    const rockMin = 1.5 / zoom
    g.fillStyle = C_ROCK
    g.beginPath()
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i]
      if (d.kind !== "rock") continue
      const x = d.px + (d.x - d.px) * alpha
      const y = d.py + (d.y - d.py) * alpha
      if (Math.abs(x - camX) > hw || Math.abs(y - camY) > hh) continue
      const r = d.radius > rockMin ? d.radius : rockMin
      g.moveTo(x + r, y)
      g.arc(x, y, r, 0, TAU)
    }
    g.fill()
    // crystals: pulsing glow, then diamonds
    g.globalCompositeOperation = "lighter"
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i]
      if (d.kind !== "crystal") continue
      const x = d.px + (d.x - d.px) * alpha
      const y = d.py + (d.y - d.py) * alpha
      if (Math.abs(x - camX) > hw + 20 || Math.abs(y - camY) > hh + 20) continue
      const pulse = 0.5 + 0.5 * Math.sin(clock * 4 + d.id * 1.7)
      const gr = 7 * (2.2 + 0.9 * pulse)
      g.globalAlpha = 0.45 + 0.35 * pulse
      g.drawImage(glow(C_PLAYER), x - gr, y - gr, gr * 2, gr * 2)
    }
    g.globalAlpha = 1
    g.globalCompositeOperation = "source-over"
    g.fillStyle = "#b8fbff"
    g.strokeStyle = C_PLAYER
    g.lineWidth = 1.4 / zoom
    g.beginPath()
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i]
      if (d.kind !== "crystal") continue
      const x = d.px + (d.x - d.px) * alpha
      const y = d.py + (d.y - d.py) * alpha
      if (Math.abs(x - camX) > hw + 20 || Math.abs(y - camY) > hh + 20) continue
      g.moveTo(x, y - 7)
      g.lineTo(x + 4.5, y)
      g.lineTo(x, y + 7)
      g.lineTo(x - 4.5, y)
      g.closePath()
    }
    g.fill()
    g.stroke()
  }

  function drawPulls(world: World) {
    const bs = world.bodies
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]
      if (!b.alive || !b.pulling) continue
      const R = pullRadius(b)
      const x = bx[i]
      const y = by[i]
      if (!visible(x, y, R)) continue
      g.fillStyle = b.color
      g.globalAlpha = 0.06
      g.beginPath()
      g.arc(x, y, R, 0, TAU)
      g.fill()
      g.globalAlpha = 0.35
      g.strokeStyle = b.color
      g.lineWidth = 1.6 / zoom
      // ring + 12 spokes drawn outer -> inner; a negative dash offset marches the dashes inward
      setDash(10 / zoom + 4, 9 / zoom + 4)
      g.lineDashOffset = -clock * 60
      g.beginPath()
      for (let k = 0; k < 12; k++) {
        const a = (k * TAU) / 12 + clock * 0.2
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        g.moveTo(x + ca * R, y + sa * R)
        g.lineTo(x + ca * (b.radius * 1.3), y + sa * (b.radius * 1.3))
      }
      g.stroke()
      g.lineDashOffset = 0
      g.setLineDash(NO_DASH)
      g.beginPath()
      g.arc(x, y, R, 0, TAU)
      g.stroke()
      g.globalAlpha = 1
    }
  }

  function drawParticles() {
    g.globalCompositeOperation = "lighter"
    let lastCol = ""
    for (let i = 0; i < pn; i++) {
      const life = pLife[i] / pMax[i]
      const kind = pKind[i]
      const x = pX[i]
      const y = pY[i]
      if (kind === P_DOT) {
        if (Math.abs(x - camX) > W / (2 * zoom) + 20 || Math.abs(y - camY) > H / (2 * zoom) + 20) continue
        const col = pCol[i]
        if (col !== lastCol) {
          g.fillStyle = col
          lastCol = col
        }
        g.globalAlpha = life > 1 ? 1 : life
        const s = pSize[i] * (0.4 + 0.6 * life)
        if (s * zoom < 3) {
          g.fillRect(x - s / 2, y - s / 2, s, s)
        } else {
          g.beginPath()
          g.arc(x, y, s / 2, 0, TAU)
          g.fill()
        }
      } else if (kind === P_RING) {
        const p = 1 - life
        const r = pSize[i] * (1 - (1 - p) * (1 - p) * (1 - p))
        if (!visible(x, y, r)) continue
        g.globalAlpha = life * 0.9
        g.strokeStyle = pCol[i]
        g.lineWidth = (4 * life + 1) / zoom
        g.beginPath()
        g.arc(x, y, r, 0, TAU)
        g.stroke()
        lastCol = ""
      } else {
        const p = 1 - life
        const r = pSize[i] * (0.4 + 0.8 * p)
        if (!visible(x, y, r)) continue
        g.globalAlpha = life * 0.9
        g.drawImage(glow(pCol[i]), x - r, y - r, r * 2, r * 2)
      }
    }
    g.globalAlpha = 1
    g.globalCompositeOperation = "source-over"
  }

  function drawBodies(world: World, player: Body | undefined) {
    const bs = world.bodies
    const playerAlive = !!player && player.alive
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]
      if (!b.alive) continue
      const x = bx[i]
      const y = by[i]
      const scale = clamp(1 + popX[i], 0.6, 1.6)
      const r = b.radius * scale
      if (!visible(x, y, r * 2.4)) continue
      // glow
      const gr = r * 2.2
      g.globalCompositeOperation = "lighter"
      g.globalAlpha = 0.35
      g.drawImage(glow(b.color), x - gr, y - gr, gr * 2, gr * 2)
      g.globalAlpha = 1
      g.globalCompositeOperation = "source-over"
      // disk
      const d = r * DISC_PAD
      g.drawImage(bodyDisc(b.color), x - d, y - d, d * 2, d * 2)
      // outline
      let outline = "#ffffff"
      if (i > 0) {
        if (playerAlive && player) {
          outline = canAbsorb(b, player) ? C_THREAT : canAbsorb(player, b) ? C_PREY : C_NEUTRAL
        } else {
          outline = C_NEUTRAL
        }
      }
      g.strokeStyle = outline
      g.lineWidth = 3 / zoom
      g.beginPath()
      g.arc(x, y, r, 0, TAU)
      g.stroke()
      if (i > 0 && playerAlive && player) {
        const pd = Math.hypot(x - bx[0], y - by[0])
        if (pd < 500 && canAbsorb(b, player)) {
          const ph = (clock * 1.2) % 1
          g.globalAlpha = 0.45 * (1 - ph)
          g.strokeStyle = C_THREAT
          g.lineWidth = 3 / zoom
          g.beginPath()
          g.arc(x, y, r + (6 + 8 * ph) / zoom, 0, TAU)
          g.stroke()
          g.globalAlpha = 1
        } else if (pd < 400 && canAbsorb(player, b)) {
          g.globalAlpha = 0.25
          g.strokeStyle = C_PREY
          g.lineWidth = 4 / zoom
          g.beginPath()
          g.arc(x, y, r + 8 / zoom, 0, TAU)
          g.stroke()
          g.globalAlpha = 1
        }
      }
      // shield
      if (b.shield > 0) {
        g.globalAlpha = 0.55 + 0.4 * Math.sin(clock * 10)
        g.strokeStyle = C_TEXT
        g.lineWidth = 2 / zoom
        setDash(r * 0.45, r * 0.3)
        g.lineDashOffset = -clock * r * 1.5
        g.beginPath()
        g.arc(x, y, r * 1.4, 0, TAU)
        g.stroke()
        g.setLineDash(NO_DASH)
        g.lineDashOffset = 0
        g.globalAlpha = 1
      }
    }
  }

  function drawFloatingTextsAndLabels(world: World) {
    setScreen()
    g.textAlign = "center"
    g.textBaseline = "alphabetic"
    // bot labels
    const bs = world.bodies
    g.font = "12px " + FONT
    g.fillStyle = "rgba(255,255,255,0.75)"
    for (let i = 1; i < bs.length; i++) {
      const b = bs[i]
      if (!b.alive) continue
      const x = bx[i]
      const y = by[i]
      if (!visible(x, y, b.radius * 2)) continue
      const sx = (x - camX) * zoom + W / 2 + shx
      const sy = (y - camY) * zoom + H / 2 + shy - b.radius * zoom * clamp(1 + popX[i], 0.6, 1.6) - 8
      g.fillText(b.name + "  " + Math.round(b.mass), sx, sy)
    }
    // floating texts
    g.lineJoin = "round"
    g.strokeStyle = "rgba(2,3,10,0.7)"
    g.lineWidth = 3
    for (let i = 0; i < MAX_TEXTS && !demo; i++) {
      if (tLife[i] <= 0) continue
      const t = tAge[i] / TEXT_LIFE
      const sx = (tX[i] - camX) * zoom + W / 2 + shx
      const sy = (tY[i] - camY) * zoom + H / 2 + shy - 6 - t * 46
      g.globalAlpha = clamp(1 - t * t, 0, 1)
      g.font = "700 " + tSize[i] + "px " + FONT
      g.strokeText(tText[i], sx, sy)
      g.fillStyle = tCol[i]
      g.fillText(tText[i], sx, sy)
    }
    g.globalAlpha = 1
  }

  /** HUD exclusion zones (CSS px) that off-screen arrows must stay out of. */
  function blocked(x: number, y: number): boolean {
    const pad = 14
    if (x < 215 + pad && y < 145 + pad) return true
    if (x > W / 2 - 80 - pad && x < W / 2 + 80 + pad && y < 70 + pad) return true
    if (x > W - 110 - pad && y < 70 + pad) return true
    const mx = touch ? W - 12 - 56 : W - 18 - 56
    const my = touch ? 64 + 56 : H - 18 - 56
    const ddx = x - mx
    const ddy = y - my
    return ddx * ddx + ddy * ddy < (66 + pad) * (66 + pad)
  }

  function drawIndicators(world: World, player: Body, ppx: number, ppy: number) {
    const left = 24
    const top = 80
    const right = W - 24
    const bottom = Math.max(top + 40, H - (touch ? 170 : 24))
    const rcx = (left + right) / 2
    const rcy = (top + bottom) / 2
    const hrw = (right - left) / 2
    const hrh = (bottom - top) / 2
    const bs = world.bodies
    for (let i = 1; i < bs.length; i++) {
      const b = bs[i]
      if (!b.alive) continue
      const x = bx[i]
      const y = by[i]
      const dist = Math.hypot(x - ppx, y - ppy)
      if (dist > 1600) continue
      const sx = (x - camX) * zoom + W / 2
      const sy = (y - camY) * zoom + H / 2
      const m = b.radius * zoom
      if (sx > -m && sx < W + m && sy > -m && sy < H + m) continue
      const a = Math.atan2(sy - H / 2, sx - W / 2)
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      const tx = Math.abs(dx) < 1e-6 ? Infinity : hrw / Math.abs(dx)
      const ty = Math.abs(dy) < 1e-6 ? Infinity : hrh / Math.abs(dy)
      const t = Math.min(tx, ty)
      let ex = rcx + dx * t
      let ey = rcy + dy * t
      if (blocked(ex, ey)) {
        // slide along the rectangle's edge (both ways, 8 px steps) until clear of the HUD zones
        const w2 = hrw * 2
        const h2 = hrh * 2
        const per = 2 * (w2 + h2)
        let u: number
        if (tx < ty) u = dx > 0 ? w2 + (ey - top) : per - (ey - top)
        else u = dy > 0 ? w2 + h2 + (right - ex) : ex - left
        for (let step = 8; step < per / 2; step += 8) {
          let found = false
          for (let sgn = -1; sgn <= 1; sgn += 2) {
            let v = (u + sgn * step) % per
            if (v < 0) v += per
            let px2: number
            let py2: number
            if (v < w2) {
              px2 = left + v
              py2 = top
            } else if (v < w2 + h2) {
              px2 = right
              py2 = top + (v - w2)
            } else if (v < 2 * w2 + h2) {
              px2 = right - (v - w2 - h2)
              py2 = bottom
            } else {
              px2 = left
              py2 = bottom - (v - 2 * w2 - h2)
            }
            if (!blocked(px2, py2)) {
              ex = px2
              ey = py2
              found = true
              break
            }
          }
          if (found) break
        }
      }
      const s = 7 + 9 * (1 - dist / 1600)
      g.fillStyle = canAbsorb(b, player) ? C_THREAT : canAbsorb(player, b) ? C_PREY : C_NEUTRAL
      g.globalAlpha = 0.9
      g.beginPath()
      g.moveTo(ex + dx * s, ey + dy * s)
      g.lineTo(ex - dx * s * 0.7 - dy * s * 0.75, ey - dy * s * 0.7 + dx * s * 0.75)
      g.lineTo(ex - dx * s * 0.7 + dy * s * 0.75, ey - dy * s * 0.7 - dx * s * 0.75)
      g.closePath()
      g.fill()
    }
    g.globalAlpha = 1
  }

  function drawMinimap(world: World) {
    const R = 56
    const mx = touch ? W - 12 - R : W - 18 - R
    const my = touch ? 64 + R : H - 18 - R
    const k = R / world.arenaRadius
    g.fillStyle = "rgba(2,3,10,0.7)"
    g.beginPath()
    g.arc(mx, my, R, 0, TAU)
    g.fill()
    g.strokeStyle = "rgba(94,242,255,0.5)"
    g.lineWidth = 1.5
    g.stroke()
    // crystals
    g.fillStyle = C_PLAYER
    const ds = world.debris
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i]
      if (d.kind !== "crystal") continue
      g.fillRect(mx + d.x * k - 1, my + d.y * k - 1, 2, 2)
    }
    // wells and wormholes
    for (let i = 0; i < world.wells.length; i++) {
      const w = world.wells[i]
      g.fillStyle = w.kind === "star" ? C_AMBER : "#ff4d8d"
      g.beginPath()
      g.arc(mx + w.x * k, my + w.y * k, 3, 0, TAU)
      g.fill()
    }
    g.fillStyle = C_WORM
    for (let i = 0; i < world.wormholes.length; i++) {
      const w = world.wormholes[i]
      g.beginPath()
      g.arc(mx + w.x * k, my + w.y * k, 2.5, 0, TAU)
      g.fill()
    }
    // bodies
    const bs = world.bodies
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i]
      if (!b.alive) continue
      g.fillStyle = b.color
      g.beginPath()
      g.arc(mx + bx[i] * k, my + by[i] * k, i === 0 ? 3.6 : 2.5, 0, TAU)
      g.fill()
      if (i === 0) {
        g.strokeStyle = "#ffffff"
        g.lineWidth = 1.2
        g.stroke()
      }
    }
  }

  function drawOverlays(world: World, player: Body | undefined, ppx: number, ppy: number, dt: number) {
    setScreen()
    if (demo) return
    // vignette: red for a nearby threat (or threat + low energy), amber for low energy alone
    let threat = false
    let low = false
    if (player && player.alive) {
      low = player.energy < CONFIG.energy.lowThreshold
      const bs = world.bodies
      for (let i = 1; i < bs.length; i++) {
        const b = bs[i]
        if (!b.alive) continue
        const dx = b.x - player.x
        const dy = b.y - player.y
        if (dx * dx + dy * dy < 260 * 260 && canAbsorb(b, player)) {
          threat = true
          break
        }
      }
    }
    const danger = threat || low
    vigI += ((danger ? 1 : 0) - vigI) * (1 - Math.exp(-8 * dt))
    if (threat) vigAmber = false
    else if (low) vigAmber = true
    if (vigI > 0.01) {
      const hz = vigAmber ? 1 : 2
      const pulse = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(clock * TAU * hz)
      g.globalAlpha = (vigAmber ? 0.14 : 0.25) * vigI * (reduced ? 0.6 : 0.25 + 0.75 * pulse)
      g.drawImage(vigAmber ? getVignette(true) : getVignette(false), 0, 0, W, H)
      g.globalAlpha = 1
    }
    // white flash
    if (flashT > 0 && !reduced) {
      g.globalAlpha = 0.12 * (flashT / 0.08)
      g.fillStyle = "#ffffff"
      g.fillRect(0, 0, W, H)
      g.globalAlpha = 1
    }
    drawMinimap(world)
    if (player && player.alive) drawIndicators(world, player, ppx, ppy)
  }

  // ---- public: render ---------------------------------------------------------------------
  function render(world: World, alpha: number, frameDt: number) {
    const dt = frameDt > 0 ? Math.min(frameDt, 0.1) : 0
    clock += dt
    if (!camInit || nebSeed !== world.seed) {
      if (!camInit) reset(world)
      else placeNebulae(world.seed)
    }
    const bs = world.bodies
    const n = bs.length
    ensureBodies(n)
    for (let i = 0; i < n; i++) {
      const b = bs[i]
      bx[i] = b.px + (b.x - b.px) * alpha
      by[i] = b.py + (b.y - b.py) * alpha
    }
    const player = bs[0]
    const ppx = n > 0 ? bx[0] : 0
    const ppy = n > 0 ? by[0] : 0

    // camera
    if (player) {
      let tx = camX
      let ty = camY
      let zt: number
      if (player.alive) {
        tx = ppx + player.vx * 0.18
        ty = ppy + player.vy * 0.18
        if (demo) {
          tx *= 0.65
          ty *= 0.65
        }
        aliveZoomTarget = zoomTargetFor(world, player)
        zt = aliveZoomTarget
      } else {
        zt = aliveZoomTarget * 0.8
      }
      const kp = 1 - Math.exp(-6 * dt)
      const kz = 1 - Math.exp(-3 * dt)
      camX += (tx - camX) * kp
      camY += (ty - camY) * kp
      zoom += (zt - zoom) * kz
    }
    if (zoom < 0.05) zoom = 0.05

    // shake / flash decay
    if (reduced || demo) {
      trauma = 0
      shx = 0
      shy = 0
    } else {
      if (trauma > 0) {
        trauma = Math.max(0, trauma - 1.4 * dt)
        const s = 14 * trauma * trauma
        shx = s * (Math.sin(clock * 41.3) + 0.6 * Math.sin(clock * 27.7 + 2.1)) * 0.625
        shy = s * (Math.sin(clock * 37.9 + 1.1) + 0.6 * Math.sin(clock * 23.3 + 0.4)) * 0.625
      } else {
        shx = 0
        shy = 0
      }
      if (flashT > 0) flashT = Math.max(0, flashT - dt)
    }

    playerSx = (ppx - camX) * zoom + W / 2
    playerSy = (ppy - camY) * zoom + H / 2

    // springs
    if (dt > 0) {
      const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
      const h = dt / steps
      for (let i = 0; i < n; i++) {
        let x = popX[i]
        let v = popV[i]
        if (x === 0 && v === 0) continue
        for (let s = 0; s < steps; s++) {
          v += (-300 * x - 18 * v) * h
          x += v * h
        }
        if (Math.abs(x) < 1e-4 && Math.abs(v) < 1e-3) {
          x = 0
          v = 0
        }
        popX[i] = x
        popV[i] = v
      }
    }

    // continuous emitters (exhaust, charging sparkles)
    if (dt > 0 && world.phase !== "countdown") {
      for (let i = 0; i < n; i++) {
        const b = bs[i]
        if (!b.alive) continue
        const x = bx[i]
        const y = by[i]
        if (!visible(x, y, 200)) continue
        if (b.thrusting) {
          const sp = Math.hypot(b.vx, b.vy)
          if (sp > 20) {
            emitThrust[i] += dt * (reduced ? 14 : 34)
            if (emitThrust[i] > 4) emitThrust[i] = 4
            const ux = b.vx / sp
            const uy = b.vy / sp
            while (emitThrust[i] >= 1) {
              emitThrust[i] -= 1
              const j = (Math.random() - 0.5) * 0.7
              const sv = 80 + Math.random() * 90
              addP(
                P_DOT,
                x - ux * b.radius + (Math.random() - 0.5) * b.radius * 0.5,
                y - uy * b.radius + (Math.random() - 0.5) * b.radius * 0.5,
                -ux * sv - uy * sv * j,
                -uy * sv + ux * sv * j,
                0.3 + Math.random() * 0.2,
                2.4 / zoom,
                b.color,
                false,
              )
            }
          }
        }
        if (b.charging) {
          let star = null
          let sd = 0
          for (let k = 0; k < world.wells.length; k++) {
            const w = world.wells[k]
            if (w.kind !== "star") continue
            const d = Math.hypot(x - w.x, y - w.y)
            if (d < w.chargeRadius && d > w.radius) {
              star = w
              sd = d
              break
            }
          }
          if (star) {
            emitSpark[i] += dt * (reduced ? 10 : 22)
            if (emitSpark[i] > 4) emitSpark[i] = 4
            while (emitSpark[i] >= 1) {
              emitSpark[i] -= 1
              const ux = (x - star.x) / sd
              const uy = (y - star.y) / sd
              const span = Math.max(0, sd - star.radius - b.radius)
              const off = star.radius + Math.random() * span * 0.6
              const sx = star.x + ux * off + (Math.random() - 0.5) * 10
              const sy = star.y + uy * off + (Math.random() - 0.5) * 10
              const life = 0.5
              addP(P_DOT, sx, sy, ((x - sx) / life) * 0.9, ((y - sy) / life) * 0.9, life, 2 / zoom, "#ffe9a8", false)
            }
          }
        }
      }
    }

    // particles
    if (dt > 0) {
      const drag = Math.max(0, 1 - 2.5 * dt)
      for (let i = pn - 1; i >= 0; i--) {
        pLife[i] -= dt
        if (pLife[i] <= 0) {
          const last = pn - 1
          if (i !== last) {
            pX[i] = pX[last]
            pY[i] = pY[last]
            pVX[i] = pVX[last]
            pVY[i] = pVY[last]
            pLife[i] = pLife[last]
            pMax[i] = pMax[last]
            pSize[i] = pSize[last]
            pKind[i] = pKind[last]
            pCol[i] = pCol[last]
          }
          pn = last
          continue
        }
        if (pKind[i] === P_DOT) {
          pX[i] += pVX[i] * dt
          pY[i] += pVY[i] * dt
          pVX[i] *= drag
          pVY[i] *= drag
        }
      }
      for (let i = 0; i < MAX_TEXTS; i++) {
        if (tLife[i] <= 0) continue
        tAge[i] += dt
        if (tAge[i] >= tLife[i]) tLife[i] = 0
      }
    }

    // ---- draw ----
    g.globalAlpha = 1
    g.globalCompositeOperation = "source-over"
    setScreen()
    g.fillStyle = C_BG
    g.fillRect(0, 0, W, H)
    drawBackground()
    setWorld()
    drawNebulae()
    drawArena(world, player, ppx, ppy)
    drawWells(world, player)
    drawWormholes(world)
    drawDebris(world, alpha)
    drawPulls(world)
    drawParticles()
    drawBodies(world, player)
    drawFloatingTextsAndLabels(world)
    drawOverlays(world, player, ppx, ppy, dt)
    setScreen()
  }

  function dispose() {
    glowCache.clear()
    discCache.clear()
    bodyDiscCache.clear()
    ringSprite = null
    vignetteSprite = null
    vignetteAmber = null
    tilePatterns = []
    pn = 0
  }

  // initial backing store + star tiles
  canvas.width = Math.max(1, Math.round(W * dpr))
  canvas.height = Math.max(1, Math.round(H * dpr))
  buildTiles()

  return {
    render,
    onEvents,
    resize,
    screenToWorld(sx: number, sy: number): Vec {
      return { x: (sx - W / 2) / zoom + camX, y: (sy - H / 2) / zoom + camY }
    },
    playerScreen(): Vec {
      return { x: playerSx, y: playerSy }
    },
    reset,
    dispose,
  }
}
