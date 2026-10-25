// Canvas 2D renderer. Reads the World, never mutates it. Owns the camera, particles, screen
// shake, floating text and every visual effect; none of that touches simulation state.
//
// CONTRACT — exported signatures and documented behaviour are fixed.

import { assistView, burnPromptVisible } from "./assist"
import { CONFIG } from "./config"
import { canAbsorb, pullRadius } from "./engine"
import { cameraZoomScale, frameEdgeMarker, indicatorRange } from "./framing"
import { nextRandom } from "./rng"
import { hasSolarCurrent, solarCurrentRadius, solarCurrentVisual, type SolarCurrentVisual } from "./solarCurrent"
import type { Body, CosmicKind, GameEvent, PowerUpKind, Vec, World } from "./types"

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
  /** Campaign levels can lock the dash: the burn prompt must not advertise a locked ability. */
  dashLocked?: boolean
  /**
   * Attract mode behind the menu: draw the world only — no vignette, flashes, floating text,
   * off-screen indicators or minimap.
   */
  demo?: boolean
}

/** The last frame's camera transform, so a shell-owned overlay can draw in world coordinates. */
export interface RenderFrame {
  camX: number
  camY: number
  zoom: number
  /** Screen-shake offset in CSS px. */
  shakeX: number
  shakeY: number
  /** Canvas size in CSS px. */
  width: number
  height: number
  dpr: number
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
  /** The last frame's camera transform (for a shell overlay canvas). */
  frame(): RenderFrame
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
/** Straight streak from (x, y) along the stored vector (vx, vy); does not move. */
const P_LINE = 3
const DASH_T = 0.18
/** Ring that collapses to its centre (warp-in / warp-out). */
const P_RINGIN = 4

const PICK_COL: Record<PowerUpKind, string> = { overdrive: "#ffb84d", magnet: "#5ef2ff", phase: "#9d7bff", bulk: "#7bed9f" }
const COSMIC_RGB: Record<CosmicKind, string> = {
  meteorShower: "255,184,77",
  solarFlare: "255,77,109",
  gravityStorm: "157,123,255",
  wormholeStorm: "157,123,255",
  nebulaDrift: "199,125,255",
  quantumAnomaly: "123,237,159",
}

const RND = new Float32Array(32)
{
  let seed = 0x2545f491
  for (let i = 0; i < RND.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    RND[i] = seed / 4294967296
  }
}

const MINI_WELL: Record<string, string> = {
  star: "#ffb84d",
  blackhole: "#ff4d8d",
  whitedwarf: "#cfeaff",
  neutronstar: "#9ff1ff",
  pulsar: "#c9a8ff",
  planet: "#b6c28a",
  station: "#5ef2ff",
}

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

/**
 * The flyby telegraph drawn over the player while a dash would pay the burn. Plain language: a
 * newcomer reads what to press, not "prograde". The accessible name for the same window stays
 * technical ("prograde burn window open") on the dash control, which is its only channel.
 */
export function burnPromptLabel(touch: boolean): string {
  return touch ? "DASH ALONG PATH" : "DASH ALONG PATH  SHIFT"
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
      frame: () => ({ camX: 0, camY: 0, zoom: 1, shakeX: 0, shakeY: 0, width: W, height: H, dpr }),
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
  let dashLocked = !!view.dashLocked
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
  let curAlpha = 1
  let evFlashT = 0
  let evFlashRgb = "255,255,255"
  let WX = 0
  let WY = 0
  const whPrev = new Float64Array(4)
  let whInit = false

  // ---- sprite caches ----------------------------------------------------------------------
  const glowCache = new Map<string, HTMLCanvasElement>()
  const discCache = new Map<string, HTMLCanvasElement>()
  let ringSprite: HTMLCanvasElement | null = null
  // The Vast's solar current: one cached annulus sprite, per-seed visual parameters and one
  // cached star-surface texture. All are built on demand, never per frame.
  let currentRing: HTMLCanvasElement | null = null
  let currentVisual: SolarCurrentVisual | null = null
  let currentVisualSeed = -1
  let starSurface: { key: string; canvas: HTMLCanvasElement } | null = null

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

  const vignetteCache = new Map<string, HTMLCanvasElement>()
  /** Edge vignette sprite for an "r,g,b" colour string (transparent centre, solid rim). */
  function getVignette(rgb: string): HTMLCanvasElement {
    let c = vignetteCache.get(rgb)
    if (!c) {
      c = makeCanvas(256, 256)
      const sg = c.getContext("2d")
      if (sg) {
        const gd = sg.createRadialGradient(128, 128, 0, 128, 128, 128)
        gd.addColorStop(0, `rgba(${rgb},0)`)
        gd.addColorStop(0.55, `rgba(${rgb},0)`)
        gd.addColorStop(1, `rgba(${rgb},1)`)
        sg.fillStyle = gd
        sg.fillRect(0, 0, 256, 256)
      }
      vignetteCache.set(rgb, c)
    }
    return c
  }
  const VIG_RED = "255,40,70"
  const VIG_AMBER = "255,184,77"
  const VIG_VIOLET = "157,123,255"

  /** Triangle sprite: apex at the left-middle (wide = false) or wide at the left, apex right. */
  function makeTri(wideLeft: boolean, c0: string, c1: string): HTMLCanvasElement {
    const c = makeCanvas(256, 64)
    const sg = c.getContext("2d")
    if (sg) {
      const gd = sg.createLinearGradient(0, 0, 256, 0)
      gd.addColorStop(0, c0)
      gd.addColorStop(1, c1)
      sg.fillStyle = gd
      sg.beginPath()
      if (wideLeft) {
        sg.moveTo(0, 0)
        sg.lineTo(0, 64)
        sg.lineTo(256, 32)
      } else {
        sg.moveTo(0, 32)
        sg.lineTo(256, 0)
        sg.lineTo(256, 64)
      }
      sg.closePath()
      sg.fill()
    }
    return c
  }
  let beamSprite: HTMLCanvasElement | null = null
  let beamCore: HTMLCanvasElement | null = null
  let tailSprite: HTMLCanvasElement | null = null
  function getBeam(): HTMLCanvasElement {
    return beamSprite || (beamSprite = makeTri(false, "rgba(205,170,255,0.6)", "rgba(160,110,255,0)"))
  }
  function getBeamCore(): HTMLCanvasElement {
    return beamCore || (beamCore = makeTri(false, "rgba(255,255,255,0.9)", "rgba(230,215,255,0)"))
  }
  function getTail(): HTMLCanvasElement {
    return tailSprite || (tailSprite = makeTri(true, "rgba(191,233,255,0.85)", "rgba(120,190,255,0)"))
  }

  const fogSprites: HTMLCanvasElement[] = []
  function getFog(k: number): HTMLCanvasElement {
    let c = fogSprites[k]
    if (!c) {
      c = makeCanvas(256, 256)
      const sg = c.getContext("2d")
      if (sg) {
        let s = 0x9e3779b1 + k * 104729
        const next = () => {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0
          return s / 4294967296
        }
        for (let i = 0; i < 9; i++) {
          const a = next() * TAU
          const d = next() * 70
          const x = 128 + Math.cos(a) * d
          const y = 128 + Math.sin(a) * d
          const r = 50 + next() * 50
          const col = next() < 0.5 ? "120,70,210" : "40,150,170"
          const gd = sg.createRadialGradient(x, y, 0, x, y, r)
          gd.addColorStop(0, `rgba(${col},0.5)`)
          gd.addColorStop(1, `rgba(${col},0)`)
          sg.fillStyle = gd
          sg.fillRect(0, 0, 256, 256)
        }
      }
      fogSprites[k] = c
    }
    return c
  }

  const planetSprites: HTMLCanvasElement[] = []
  /** Solid planet: lit sphere, a few surface patches, terminator shading and an atmosphere rim. */
  function getPlanet(pal: number): HTMLCanvasElement {
    let c = planetSprites[pal]
    if (!c) {
      const S = 192
      c = makeCanvas(S, S)
      const sg = c.getContext("2d")
      if (sg) {
        const earth = pal === 0
        sg.save()
        sg.beginPath()
        sg.arc(S / 2, S / 2, S / 2 - 1, 0, TAU)
        sg.clip()
        const base = sg.createRadialGradient(S * 0.36, S * 0.34, 0, S / 2, S / 2, S / 2)
        base.addColorStop(0, earth ? "#e6c590" : "#f2fdff")
        base.addColorStop(1, earth ? "#8a5a3a" : "#5f9fc4")
        sg.fillStyle = base
        sg.fillRect(0, 0, S, S)
        let s = 0x1b873593 + pal * 977
        const next = () => {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0
          return s / 4294967296
        }
        for (let i = 0; i < 7; i++) {
          sg.globalAlpha = 0.22
          sg.fillStyle = earth ? "#5a3a24" : "#9fd6ee"
          sg.beginPath()
          sg.ellipse(next() * S, next() * S, 14 + next() * 30, 6 + next() * 14, next() * 3, 0, TAU)
          sg.fill()
        }
        sg.globalAlpha = 1
        const term = sg.createRadialGradient(S * 0.3, S * 0.28, 0, S * 0.3, S * 0.28, S * 1.05)
        term.addColorStop(0, "rgba(0,0,12,0)")
        term.addColorStop(0.5, "rgba(0,0,12,0)")
        term.addColorStop(1, "rgba(0,0,12,0.82)")
        sg.fillStyle = term
        sg.fillRect(0, 0, S, S)
        const rim = sg.createRadialGradient(S / 2, S / 2, S * 0.4, S / 2, S / 2, S / 2)
        rim.addColorStop(0, "rgba(255,255,255,0)")
        rim.addColorStop(0.82, "rgba(255,255,255,0)")
        rim.addColorStop(1, earth ? "rgba(255,215,160,0.6)" : "rgba(150,235,255,0.65)")
        sg.fillStyle = rim
        sg.fillRect(0, 0, S, S)
        sg.restore()
      }
      planetSprites[pal] = c
    }
    return c
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

  function placeNebulae(world: World) {
    nebSeed = world.seed
    let s = (Math.floor(Math.abs(world.seed)) ^ 0x5bd1e995) >>> 0
    const next = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 4294967296
    }
    // The Vast spreads its background clouds over the larger field so the dark does not read flat.
    const spread = world.arena === "vast" ? Math.sqrt(world.arenaBase / 2000) : 1
    for (let i = 0; i < 3; i++) {
      const a = next() * TAU
      const d = (300 + next() * 1300) * spread
      nebX[i] = Math.cos(a) * d
      nebY[i] = Math.sin(a) * d
      nebR[i] = (600 + next() * 450) * spread
    }
  }

  // ---- per-body visual state (indexed like world.bodies) ----------------------------------
  let popX: number[] = []
  let popV: number[] = []
  let emitThrust: number[] = []
  let emitSpark: number[] = []
  const dashT: number[] = []
  const dashDx: number[] = []
  const dashDy: number[] = []
  const slingT: number[] = []
  const emitPow: number[] = []
  const emitSling: number[] = []
  let bx = new Float64Array(16)
  let by = new Float64Array(16)

  function ensureBodies(n: number) {
    while (popX.length < n) {
      popX.push(0)
      popV.push(0)
      emitThrust.push(0)
      emitSpark.push(0)
      dashT.push(0)
      dashDx.push(1)
      dashDy.push(0)
      slingT.push(0)
      emitPow.push(0)
      emitSling.push(0)
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
    // Larger arenas pull the camera back so more context stays readable, never below the floor.
    let zt = (Math.sqrt(W * H) / (1000 + p.radius * 8)) * cameraZoomScale(world.arenaBase)
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
      dashT[i] = 0
      slingT[i] = 0
      emitPow[i] = 0
      emitSling[i] = 0
    }
    evFlashT = 0
    whInit = false
    placeNebulae(world)
  }

  function resize(v: RenderView) {
    W = v.width
    H = v.height
    dpr = v.dpr
    reduced = v.reducedMotion
    touch = v.layout === "touch"
    dashLocked = !!v.dashLocked
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
            const amt = ev.kind === "comet" ? 0.16 : ev.kind === "crystal" ? 0.1 : 0.06
            popX[bi] += amt * 0.5
            popV[bi] += amt * 8
          }
          if (visible(ev.x, ev.y, 100)) {
            const col = ev.kind === "dust" ? C_DUST : ev.kind === "rock" ? C_ROCK : ev.kind === "comet" ? "#bfe9ff" : C_PLAYER
            const cnt = ev.kind === "comet" ? 12 : 4 + ((Math.random() * 5) | 0)
            burst(ev.x, ev.y, cnt, 30, ev.kind === "comet" ? 180 : 95, 0.4, ev.kind === "crystal" || ev.kind === "comet" ? 2.6 : 1.8, col, false)
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
        case "dash": {
          const bi = bodyIndex(world, ev.bodyId)
          const len = Math.hypot(ev.dx, ev.dy) || 1
          const ux = ev.dx / len
          const uy = ev.dy / len
          const col = bi >= 0 ? world.bodies[bi].color : "#ffffff"
          if (bi >= 0) {
            dashT[bi] = DASH_T
            dashDx[bi] = ux
            dashDy[bi] = uy
          }
          if (visible(ev.x, ev.y, 200)) {
            addP(P_LINE, ev.x, ev.y, -ux * 130, -uy * 130, 0.25, 4 / zoom, "#ffffff", true)
            addP(P_LINE, ev.x, ev.y, -ux * 90, -uy * 90, 0.32, 9 / zoom, col, true)
            const cnt = reduced ? 5 : 10
            for (let i = 0; i < cnt; i++) {
              const sv = 120 + Math.random() * 200
              const j = (Math.random() - 0.5) * 0.9
              addP(P_DOT, ev.x, ev.y, -ux * sv - uy * sv * j, -uy * sv + ux * sv * j, 0.35 + Math.random() * 0.2, 3 / zoom, col, true)
            }
          }
          break
        }
        case "repulse": {
          const bi = bodyIndex(world, ev.bodyId)
          const col = bi >= 0 ? world.bodies[bi].color : "#ffffff"
          if (bi >= 0) {
            popX[bi] += 0.12
            popV[bi] += 2
          }
          addP(P_RING, ev.x, ev.y, 0, 0, 0.35, ev.r, col, true)
          addP(P_RING, ev.x, ev.y, 0, 0, 0.3, ev.r * 0.65, "#ffffff", true)
          burst(ev.x, ev.y, 22, 250, 650, 0.5, 2.4, col, true)
          if (ev.bodyId === "player") trauma = Math.min(1, trauma + 0.2)
          break
        }
        case "ultStart": {
          const bi = bodyIndex(world, ev.bodyId)
          const col = bi >= 0 ? world.bodies[bi].color : "#ffffff"
          const R0 = 170
          const cnt = reduced ? 20 : 40
          for (let i = 0; i < cnt; i++) {
            const a = Math.random() * TAU
            const ca = Math.cos(a)
            const sa = Math.sin(a)
            const rr = R0 * (0.6 + Math.random() * 0.6)
            addP(P_DOT, ev.x + ca * rr, ev.y + sa * rr, (-ca * rr) / 0.45, (-sa * rr) / 0.45, 0.45, 3 / zoom, col, true)
          }
          flashAt(ev.x, ev.y, 280, col)
          if (ev.bodyId === "player") {
            trauma = Math.min(1, trauma + 0.4)
            flashT = Math.max(flashT, 0.08)
          }
          break
        }
        case "ultEnd": {
          const bi = bodyIndex(world, ev.bodyId)
          if (bi >= 0) {
            const b = world.bodies[bi]
            burst(b.x, b.y, 60, 100, 520, 0.8, 3, b.color, true)
            shockwave(b.x, b.y, 340, b.color)
            popX[bi] += 0.15
          }
          break
        }
        case "ultReady": {
          if (ev.bodyId === "player" && player) spawnText("SINGULARITY READY", player.x, player.y - player.radius - 34, "#d9b8ff", 16, false)
          break
        }
        case "slingshot": {
          const bi = bodyIndex(world, ev.bodyId)
          if (bi >= 0) slingT[bi] = 0.6
          if (ev.bodyId === "player") spawnText("SLINGSHOT " + Math.round(ev.speed), ev.x, ev.y - 30, "#e8f6ff", 16, false)
          break
        }
        case "oberth": {
          // The graded flyby burn. Colour by tier, then reuse the slingshot trail.
          const bi = bodyIndex(world, ev.bodyId)
          const col = ev.tier === "oberth" ? "#ffd36b" : ev.tier === "burn" ? "#ffb347" : "#9fe8ff"
          if (bi >= 0) {
            slingT[bi] = 0.9
            popX[bi] += ev.tier === "oberth" ? 0.2 : 0.1
            popV[bi] += 6
            if (reduced) {
              // Reduced motion: a single static ring, no particles, no flash, no shake.
              shockwave(ev.x, ev.y, 120, col)
            } else {
              burst(ev.x, ev.y, ev.tier === "oberth" ? 34 : 20, 90, ev.tier === "oberth" ? 480 : 320, 0.6, 3, col, true)
              shockwave(ev.x, ev.y, ev.tier === "oberth" ? 260 : 180, col)
              flashAt(ev.x, ev.y, ev.tier === "oberth" ? 200 : 140, col)
            }
          }
          if (ev.bodyId === "player" && player) {
            if (!reduced) trauma = Math.min(1, trauma + (ev.tier === "oberth" ? 0.22 : 0.12))
            const label = ev.tier === "oberth" ? "OBERTH" : ev.tier === "burn" ? "BURN" : "GRAZE"
            spawnText(label + "  x" + ev.speedMul.toFixed(2), player.x, player.y - player.radius - 40, col, ev.tier === "oberth" ? 19 : 17, false)
          }
          break
        }
        case "pickup": {
          const col = PICK_COL[ev.kind]
          burst(ev.x, ev.y, 14, 60, 220, 0.5, 2.6, col, true)
          shockwave(ev.x, ev.y, 46, col)
          const bi = bodyIndex(world, ev.bodyId)
          if (bi >= 0 && ev.kind === "bulk") {
            popX[bi] += 0.1
            popV[bi] += 3
          }
          if (ev.bodyId === "player" && player) {
            const txt = ev.kind === "bulk" ? "+" + CONFIG.powerups.bulk.mass + " MASS" : ev.kind.toUpperCase()
            spawnText(txt, player.x, player.y - player.radius - 26, col, 16, false)
          }
          break
        }
        case "assist": {
          if (ev.bodyId === "player" && player) spawnText("ASSIST", player.x, player.y - player.radius - 40, "#ffd36b", 18, false)
          break
        }
        case "solidHit": {
          burst(ev.x, ev.y, 6, 20, 80, 0.5, 3, "#c9b79c", false)
          break
        }
        case "cosmic": {
          if (ev.stage !== "end") {
            evFlashT = 0.35
            evFlashRgb = COSMIC_RGB[ev.kind]
          }
          break
        }
        case "join": {
          const bi = bodyIndex(world, ev.bodyId)
          const col = bi >= 0 ? world.bodies[bi].color : "#ffffff"
          if (!visible(ev.x, ev.y, 120)) break
          addP(P_RINGIN, ev.x, ev.y, 0, 0, 0.45, 110, col, true)
          burst(ev.x, ev.y, 26, 60, 280, 0.6, 3, col, true)
          flashAt(ev.x, ev.y, 120, col)
          if (!demo) spawnText(ev.name + " joined", ev.x, ev.y - (bi >= 0 ? world.bodies[bi].radius : 12) - 14, col, 13, false)
          break
        }
        case "leave": {
          const bi = bodyIndex(world, ev.bodyId)
          const col = bi >= 0 ? world.bodies[bi].color : "#ffffff"
          if (!visible(ev.x, ev.y, 120)) break
          addP(P_RINGIN, ev.x, ev.y, 0, 0, 0.4, 70, col, true)
          const R0 = 60
          const cnt = reduced ? 10 : 22
          for (let i = 0; i < cnt; i++) {
            const a = Math.random() * TAU
            const ca = Math.cos(a)
            const sa = Math.sin(a)
            const rr = R0 * (0.5 + Math.random() * 0.6)
            addP(P_DOT, ev.x + ca * rr, ev.y + sa * rr, (-ca * rr) / 0.4, (-sa * rr) / 0.4, 0.4, 3 / zoom, col, true)
          }
          break
        }
        case "respawn": {
          const bi = bodyIndex(world, ev.bodyId)
          const col = bi >= 0 ? world.bodies[bi].color : C_PLAYER
          if (bi >= 0) {
            popX[bi] += 0.3
            popV[bi] += 4
          }
          burst(ev.x, ev.y, 40, 80, 420, 0.7, 3, col, true)
          flashAt(ev.x, ev.y, 240, "#ffffff")
          addP(P_RING, ev.x, ev.y, 0, 0, 0.45, 220, col, true)
          if (ev.bodyId === "player") {
            // the player teleported: snap the camera instead of gliding across the arena
            camX = ev.x
            camY = ev.y
            flashT = Math.max(flashT, 0.08)
          }
          break
        }
        case "escalation": {
          evFlashT = 0.35
          evFlashRgb = "255,77,109"
          trauma = Math.min(1, trauma + 0.1)
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
    // Vast scale: fixed sector rings at one and two thirds of the arena give the eye landmarks.
    if (world.arenaBase > CONFIG.camera.arenaRadiusRef * 1.5) {
      g.strokeStyle = "rgba(94,242,255,0.13)"
      g.lineWidth = 1.4 / zoom
      setDash(26, 22)
      for (let i = 1; i <= 2; i++) {
        g.beginPath()
        g.arc(0, 0, (world.arenaBase * i) / 3, 0, TAU)
        g.stroke()
      }
      g.setLineDash(NO_DASH)
      g.strokeStyle = "rgba(94,242,255,0.2)"
      for (let i = 1; i <= 2; i++) {
        const sr = (world.arenaBase * i) / 3
        g.beginPath()
        for (let k = 0; k < 12; k++) {
          const a = (k * TAU) / 12
          const ca = Math.cos(a)
          const sa = Math.sin(a)
          g.moveTo(ca * (sr - 14), sa * (sr - 14))
          g.lineTo(ca * (sr + 14), sa * (sr + 14))
        }
        g.stroke()
      }
    }
    const esc = R < world.arenaBase - 0.5
    const sev = esc ? clamp((world.arenaBase - R) / (world.arenaBase * (1 - CONFIG.escalation.shrinkTo)), 0, 1) : 0
    if (esc) {
      // faint ghost of the original wall, and a red band hugging the closing one
      g.globalAlpha = 0.14
      g.strokeStyle = "#5ef2ff"
      g.lineWidth = 1.5 / zoom
      setDash(18, 14)
      g.beginPath()
      g.arc(0, 0, world.arenaBase, 0, TAU)
      g.stroke()
      g.setLineDash(NO_DASH)
      g.strokeStyle = C_THREAT
      const pulse = 0.75 + 0.25 * Math.sin(clock * 3)
      for (let i = 0; i < 2; i++) {
        const wd = i === 0 ? 70 : 150
        g.globalAlpha = (0.06 + 0.1 * sev) * pulse
        g.lineWidth = wd
        g.beginPath()
        g.arc(0, 0, R - wd / 2, 0, TAU)
        g.stroke()
      }
      g.globalAlpha = 1
    }
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
    if (esc) {
      g.strokeStyle = C_THREAT
      g.globalAlpha = 0.18 + 0.12 * sev
      g.lineWidth = (8 + 8 * sev) / zoom
      g.beginPath()
      g.arc(0, 0, R, 0, TAU)
      g.stroke()
      g.globalAlpha = 0.55 + 0.35 * sev
      g.lineWidth = (3 + 3 * sev) / zoom
      g.beginPath()
      g.arc(0, 0, R, 0, TAU)
      g.stroke()
      g.globalAlpha = 1
      return
    }
    g.strokeStyle = "rgba(94,242,255,0.25)"
    g.lineWidth = 2 / zoom
    g.beginPath()
    g.arc(0, 0, R, 0, TAU)
    g.stroke()
  }

  /** Per-seed visual parameters, rebuilt only when the world seed changes. */
  function solarVisual(world: World): SolarCurrentVisual {
    if (currentVisualSeed !== world.seed || !currentVisual) {
      currentVisualSeed = world.seed
      currentVisual = solarCurrentVisual(world)
    }
    return currentVisual
  }

  /**
   * Cached annulus sprite: a low-alpha, source-over band with soft inner and outer edges. It is
   * built once (512 px, then scaled to the band) and never allocated per frame.
   */
  function getCurrentRing(): HTMLCanvasElement {
    if (currentRing) return currentRing
    const S = 512
    const c = makeCanvas(S, S)
    const sg = c.getContext("2d")
    if (sg) {
      const R = CONFIG.vast.arenaRadius * CONFIG.vast.solarCurrent.bandRadiusFrac
      const hw = CONFIG.vast.solarCurrent.halfWidth
      const inner = (R - hw) / (R + hw)
      const mid = R / (R + hw)
      const gd = sg.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
      gd.addColorStop(0, "rgba(255,170,100,0)")
      gd.addColorStop(Math.max(0, inner - 0.02), "rgba(255,150,80,0)")
      gd.addColorStop(inner + 0.03, "rgba(255,160,90,0.08)")
      gd.addColorStop(mid, "rgba(255,196,128,0.12)")
      gd.addColorStop(1, "rgba(255,225,180,0)")
      sg.fillStyle = gd
      sg.fillRect(0, 0, S, S)
    }
    currentRing = c
    return c
  }

  /** Cached star-surface texture: seeded granulation plus a limb-darkened edge. */
  function getStarSurface(world: World, r: number): HTMLCanvasElement {
    const key = `${world.seed}|${Math.round(r)}`
    if (starSurface && starSurface.key === key) return starSurface.canvas
    const S = 512
    const c = makeCanvas(S, S)
    const sg = c.getContext("2d")
    if (sg) {
      const visual = solarVisual(world)
      let st = visual.granulationSeed || 1
      const rnd = (): number => {
        const [v, s] = nextRandom(st)
        st = s
        return v
      }
      const cx = S / 2
      const cy = S / 2
      const rad = S / 2 - 2
      const depth = CONFIG.vast.solarCurrent.depth
      sg.save()
      sg.beginPath()
      sg.arc(cx, cy, rad, 0, TAU)
      sg.clip()
      // Granulation: many soft cells; warm bright tops and darker lanes.
      const cells = 150
      for (let i = 0; i < cells; i++) {
        const a = rnd() * TAU
        const d = Math.sqrt(rnd()) * rad * 0.97
        const cr = rad * (0.025 + rnd() * 0.075)
        const bright = rnd() < 0.42
        const alpha = (0.03 + rnd() * 0.06) * depth * 4
        const gr = sg.createRadialGradient(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0, cx + Math.cos(a) * d, cy + Math.sin(a) * d, cr)
        gr.addColorStop(0, bright ? `rgba(255,244,205,${alpha})` : `rgba(110,32,8,${alpha})`)
        gr.addColorStop(1, "rgba(0,0,0,0)")
        sg.fillStyle = gr
        sg.beginPath()
        sg.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, cr, 0, TAU)
        sg.fill()
      }
      // Limb: a dark, slightly warm rim so the huge disc reads as a sphere, not a flat circle.
      const limb = sg.createRadialGradient(cx, cy, rad * 0.55, cx, cy, rad)
      limb.addColorStop(0, "rgba(0,0,0,0)")
      limb.addColorStop(0.8, "rgba(0,0,0,0)")
      limb.addColorStop(0.96, `rgba(70,16,2,${0.2 * depth * 4})`)
      limb.addColorStop(1, `rgba(35,8,0,${0.32 * depth * 4})`)
      sg.fillStyle = limb
      sg.fillRect(0, 0, S, S)
      sg.restore()
    }
    starSurface = { key, canvas: c }
    return c
  }

  /**
   * The Vast's solar current, drawn in world space behind wells and bodies: a source-over
   * annulus, 16 co-rotating direction chevrons and two streamers from the giant star's limb.
   * Additive blending is deliberately not used. Reduced motion freezes rotation and sway.
   */
  function drawSolarCurrent(world: World) {
    if (!hasSolarCurrent(world)) return
    const R = solarCurrentRadius(world)
    const hw = CONFIG.vast.solarCurrent.halfWidth
    const outer = R + hw
    if (!visible(0, 0, outer)) return
    const S = CONFIG.vast.solarCurrent
    const vis = solarVisual(world)
    const spin = reduced ? 0 : (clock * TAU) / S.cyclePeriod / 4
    g.save()
    g.globalCompositeOperation = "source-over"
    // Annulus.
    g.globalAlpha = 1
    g.drawImage(getCurrentRing(), -outer, -outer, outer * 2, outer * 2)
    // Two streamers/prominences, from the star's limb out across the band.
    let starR = 0
    for (let i = 0; i < world.wells.length; i++) {
      const w = world.wells[i]
      if (w.kind === "star" && w.radius > starR) starR = w.radius
    }
    if (starR > 0) {
      for (let i = 0; i < S.streamers; i++) {
        const sway = reduced ? 0 : Math.sin(clock * (TAU / S.cyclePeriod) + i * 2.1) * 0.1
        const a0 = vis.streamerAngles[i] ?? (TAU * i) / Math.max(1, S.streamers)
        const a1 = a0 + 0.55 + sway
        const r0 = starR * 0.98
        const r1 = R * 0.9
        const m0 = (a0 + a1) / 2 - 0.18
        const m1 = (a0 + a1) / 2 + 0.3
        for (let k = 0; k < 3; k++) {
          const wd = k === 0 ? 12 : k === 1 ? 4.5 : 1.4
          const al = k === 0 ? 0.028 : k === 1 ? 0.05 : 0.085
          g.strokeStyle = `rgba(255,214,150,${al})`
          g.lineWidth = wd
          g.beginPath()
          g.moveTo(Math.cos(a0) * r0, Math.sin(a0) * r0)
          g.bezierCurveTo(
            Math.cos(m0) * (r0 + (r1 - r0) * 0.35),
            Math.sin(m0) * (r0 + (r1 - r0) * 0.35),
            Math.cos(m1) * (r0 + (r1 - r0) * 0.7),
            Math.sin(m1) * (r0 + (r1 - r0) * 0.7),
            Math.cos(a1) * r1,
            Math.sin(a1) * r1,
          )
          g.stroke()
        }
      }
    }
    // 16 direction chevrons, tangent to the co-rotation. Below ~0.65 zoom (phones) they are
    // clamped in screen space so they stay countable instead of shrinking to a few pixels.
    g.fillStyle = "rgba(255,196,132,0.32)"
    const size = Math.max(13, 8.5 / zoom)
    for (let i = 0; i < S.chevrons; i++) {
      const a = vis.chevronPhase + (i * TAU) / S.chevrons + spin
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const x = ca * R
      const y = sa * R
      const nx = -sa
      const ny = ca
      g.beginPath()
      g.moveTo(x + nx * size, y + ny * size)
      g.lineTo(x - nx * size * 0.55 + ca * size * 0.7, y - ny * size * 0.55 + sa * size * 0.7)
      g.lineTo(x - nx * size * 0.55 - ca * size * 0.7, y - ny * size * 0.55 - sa * size * 0.7)
      g.closePath()
      g.fill()
    }
    g.restore()
  }

  /** Interpolated centre of a (possibly moving) well, into WX / WY. */
  function wellPos(w: { x: number; y: number; vx: number; vy: number }) {
    const back = CONFIG.dt * (1 - curAlpha)
    WX = w.x - w.vx * back
    WY = w.y - w.vy * back
  }

  function dashRing(x: number, y: number, r: number, color: string, alpha: number, a: number, b: number, speed: number) {
    g.globalAlpha = alpha
    g.strokeStyle = color
    g.lineWidth = 1.6 / zoom
    setDash(a, b)
    g.lineDashOffset = -clock * speed
    g.beginPath()
    g.arc(x, y, r, 0, TAU)
    g.stroke()
    g.setLineDash(NO_DASH)
    g.lineDashOffset = 0
    g.globalAlpha = 1
  }

  function drawOrbits(world: World) {
    const wells = world.wells
    const reach = Math.hypot(W, H) / (2 * zoom)
    g.strokeStyle = "rgba(190,215,255,0.16)"
    g.lineWidth = 1.3 / zoom
    setDash(10, 16)
    for (let i = 0; i < wells.length; i++) {
      const o = wells[i].orbit
      if (!o) continue
      if (Math.abs(Math.hypot(camX - o.cx, camY - o.cy) - o.r) > reach + 40) continue
      g.beginPath()
      g.arc(o.cx, o.cy, o.r, 0, TAU)
      g.stroke()
    }
    g.setLineDash(NO_DASH)
  }

  function drawWells(world: World, player: Body | undefined) {
    const wells = world.wells
    const cosmic = world.cosmic
    const storm = !!cosmic && cosmic.kind === "gravityStorm"
    const gs = storm ? 1.5 : 1
    const simT = world.time - CONFIG.dt * (1 - curAlpha)
    const charging = !!player && player.alive && player.charging
    // The one well that currently holds the player's flyby pass, if any (telegraphed below).
    const pass = player && player.alive ? assistView(world, player) : null
    for (let i = 0; i < wells.length; i++) {
      const w = wells[i]
      const r = w.radius
      wellPos(w)
      const x = WX
      const y = WY
      if (pass && pass.wellId === w.id) {
        const pr = w.radius * CONFIG.assist.periBand
        if (visible(x, y, pr + 60)) {
          // The periapsis band: a dash inside it is the burn. It brightens and quickens when the
          // timed window is live; reduced motion keeps it static.
          const hot = pass.window
          dashRing(x, y, pr, hot ? "#ffe28a" : "#8fd9ff", hot ? 0.9 : 0.32, 14, 12, reduced ? 0 : hot ? 46 : 10)
          if (hot) dashRing(x, y, pr, "#ffffff", 0.4, 3, 46, reduced ? 0 : 30)
        }
      }
      switch (w.kind) {
        case "star": {
          const fl = cosmic && cosmic.kind === "solarFlare" && cosmic.targetId === w.id ? cosmic : null
          const hot = !!fl && fl.stage === "active"
          const wp = fl && fl.stage === "warning" ? clamp(fl.t / Math.max(0.01, fl.warning), 0, 1) : 0
          const grow = 1 + 0.9 * wp
          const lethalR = hot ? r * CONFIG.cosmic.solarFlare.radiusMul : r
          // A supergiant's 4x glow covers a millions-of-pixels quad on desktop; 2.4x keeps the
          // presence with far less overdraw.
          const glowMul = r >= 220 ? 2.4 : 4
          const outer = Math.max(r * glowMul * gs * grow, w.chargeRadius, hot ? lethalR * 1.6 : 0)
          if (!visible(x, y, outer)) break
          g.globalCompositeOperation = "lighter"
          g.globalAlpha = 0.85
          const gl = r * glowMul * gs * grow
          g.drawImage(glow("#ffb347"), x - gl, y - gl, gl * 2, gl * 2)
          if (hot) {
            g.globalAlpha = 0.8
            const hg = lethalR * 1.5
            g.drawImage(glow("#fff3c4"), x - hg, y - hg, hg * 2, hg * 2)
          }
          // corona: 8 wobbling spikes, slowly rotating
          g.globalAlpha = hot ? 0.55 : 0.4
          g.fillStyle = hot ? "#fff6d6" : "#ffc86b"
          g.beginPath()
          const rot = clock * (hot ? 0.5 : 0.18)
          for (let k = 0; k < 8; k++) {
            const a = rot + (k * TAU) / 8
            const wob = 1.5 + 0.35 * Math.sin(clock * (hot ? 4 : 1.7) + k * 1.3)
            const len = hot ? lethalR * (0.8 + 0.2 * Math.sin(clock * 5 + k * 1.3)) : r * wob * grow
            const hw = hot ? 0.28 : 0.2
            g.moveTo(x + Math.cos(a - hw) * r * 0.9, y + Math.sin(a - hw) * r * 0.9)
            g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
            g.lineTo(x + Math.cos(a + hw) * r * 0.9, y + Math.sin(a + hw) * r * 0.9)
          }
          g.fill()
          g.globalAlpha = 1
          g.globalCompositeOperation = "source-over"
          g.drawImage(hot ? disc("#ffffff", "#fff3c4") : disc("#fff3c4", "#ffb347"), x - r * DISC_PAD, y - r * DISC_PAD, r * 2 * DISC_PAD, r * 2 * DISC_PAD)
          if (r >= 220) {
            // Supergiant surface: broad convection bands read as scale at a glance.
            g.save()
            g.beginPath()
            g.arc(x, y, r * 0.97, 0, TAU)
            g.clip()
            g.strokeStyle = "rgba(150,44,12,0.22)"
            g.lineWidth = r * 0.1
            for (let k = -2; k <= 2; k++) {
              g.beginPath()
              g.ellipse(x, y + k * r * 0.31, r, r * 0.2, 0, 0, TAU)
              g.stroke()
            }
            g.strokeStyle = "rgba(255,240,190,0.26)"
            g.lineWidth = r * 0.04
            g.beginPath()
            g.arc(x, y, r * 0.9, 0, TAU)
            g.stroke()
            g.restore()
            if (world.arena === "vast") {
              // Cached seeded granulation and limb treatment: one texture per world seed, no
              // per-frame allocation, source-over only.
              const surf = getStarSurface(world, r)
              g.save()
              g.beginPath()
              g.arc(x, y, r * 0.985, 0, TAU)
              g.clip()
              g.drawImage(surf, x - r, y - r, r * 2, r * 2)
              g.restore()
            }
          }
          if (hot) {
            g.strokeStyle = "rgba(255,150,100,0.85)"
            g.lineWidth = 3 / zoom
            g.beginPath()
            g.arc(x, y, lethalR, 0, TAU)
            g.stroke()
          } else if (fl) {
            // warning: red dashed ring at the coming flare radius, pulsing faster as it nears
            const ph = 0.5 + 0.5 * Math.sin(clock * TAU * (2 + 8 * wp))
            dashRing(x, y, r * CONFIG.cosmic.solarFlare.radiusMul, C_THREAT, 0.3 + 0.5 * ph, 16, 12, 20)
          }
          if (w.chargeRadius > 0) dashRing(x, y, w.chargeRadius, C_AMBER, charging ? 0.4 : 0.18, 18, 14, 8)
          break
        }
        case "blackhole": {
          if (!visible(x, y, r * 4.5 * gs)) break
          g.globalCompositeOperation = "lighter"
          g.globalAlpha = 0.45
          const gl = r * 4.5 * gs
          g.drawImage(glow("#7a3cff"), x - gl, y - gl, gl * 2, gl * 2)
          g.globalAlpha = 0.9
          const ro = r * 3
          g.drawImage(getRingSprite(), x - ro, y - ro, ro * 2, ro * 2)
          g.lineCap = "round"
          for (let k = 0; k < 3; k++) {
            const rad = r * (1.55 + 0.55 * k)
            const rot = clock * (1.9 - 0.45 * k) * (k % 2 === 0 ? 1 : -1)
            g.strokeStyle = k % 2 === 0 ? "#c77dff" : "#ff4d8d"
            g.lineWidth = r * (0.24 - 0.05 * k)
            g.globalAlpha = 0.8
            g.beginPath()
            g.arc(x, y, rad, rot, rot + 2.4)
            g.stroke()
            g.globalAlpha = 0.45
            g.beginPath()
            g.arc(x, y, rad, rot + 3.3, rot + 4.9)
            g.stroke()
          }
          g.lineCap = "butt"
          g.globalAlpha = 1
          g.globalCompositeOperation = "source-over"
          g.fillStyle = "#000"
          g.beginPath()
          g.arc(x, y, r, 0, TAU)
          g.fill()
          g.strokeStyle = "rgba(255,232,255,0.85)"
          g.lineWidth = 1.5 / zoom
          g.beginPath()
          g.arc(x, y, r * 1.12, 0, TAU)
          g.stroke()
          break
        }
        case "whitedwarf": {
          if (!visible(x, y, Math.max(r * 6 * gs, w.chargeRadius))) break
          g.globalCompositeOperation = "lighter"
          g.globalAlpha = 0.9
          const gl = r * 6 * gs
          g.drawImage(glow("#8fd3ff"), x - gl, y - gl, gl * 2, gl * 2)
          g.globalAlpha = 0.8
          const g2 = r * 2.8
          g.drawImage(glow("#ffffff"), x - g2, y - g2, g2 * 2, g2 * 2)
          g.globalAlpha = 1
          g.globalCompositeOperation = "source-over"
          g.drawImage(disc("#dff6ff", "#8fd3ff"), x - r * DISC_PAD, y - r * DISC_PAD, r * 2 * DISC_PAD, r * 2 * DISC_PAD)
          if (w.chargeRadius > 0) dashRing(x, y, w.chargeRadius, "#8fd3ff", charging ? 0.35 : 0.15, 14, 12, 10)
          break
        }
        case "neutronstar": {
          if (!visible(x, y, r * 12 * gs)) break
          const pulse = 0.75 + 0.25 * Math.sin(clock * 9)
          g.globalCompositeOperation = "lighter"
          g.globalAlpha = 0.9
          const gl = r * 10 * gs
          g.drawImage(glow("#7fe7ff"), x - gl, y - gl, gl * 2, gl * 2)
          g.globalAlpha = pulse
          const g2 = r * 4.2
          g.drawImage(glow("#ffffff"), x - g2, y - g2, g2 * 2, g2 * 2)
          // magnetic field-line arcs, three opposite pairs
          g.lineCap = "round"
          g.strokeStyle = "#9ff1ff"
          for (let k = 0; k < 3; k++) {
            const rad = r * (2.4 + 1.1 * k)
            const rot = clock * (2.4 - 0.5 * k) * (k % 2 === 0 ? 1 : -1) + k
            g.lineWidth = 1.8 / zoom + 0.4
            g.globalAlpha = 0.65 - 0.12 * k
            g.beginPath()
            g.arc(x, y, rad, rot, rot + 1.1)
            g.stroke()
            g.beginPath()
            g.arc(x, y, rad, rot + Math.PI, rot + Math.PI + 1.1)
            g.stroke()
          }
          g.lineCap = "butt"
          g.globalAlpha = 1
          g.globalCompositeOperation = "source-over"
          g.drawImage(disc("#ffffff", "#bff6ff"), x - r * DISC_PAD, y - r * DISC_PAD, r * 2 * DISC_PAD, r * 2 * DISC_PAD)
          break
        }
        case "pulsar": {
          const beam = w.beam
          const reach = beam ? beam.length : r * 6
          if (!visible(x, y, reach)) break
          g.globalCompositeOperation = "lighter"
          if (beam) {
            const th = beam.phase + beam.w * simT
            const wid = Math.tan(beam.halfWidth)
            const flick = 0.85 + 0.15 * Math.sin(clock * 11)
            for (let k = 0; k < 2; k++) {
              const ang = th + k * Math.PI
              g.translate(x, y)
              g.rotate(ang)
              g.scale(reach, reach * wid)
              g.globalAlpha = flick
              g.drawImage(getBeam(), 0, -1, 1, 2)
              g.scale(1, 0.28)
              g.globalAlpha = flick
              g.drawImage(getBeamCore(), 0, -1, 1, 2)
              setWorld()
            }
            // danger rim along the beam edges
            g.strokeStyle = "rgba(225,200,255,0.35)"
            g.lineWidth = 1.5 / zoom
            g.globalAlpha = 1
            g.beginPath()
            for (let k = 0; k < 2; k++) {
              for (let e = -1; e <= 1; e += 2) {
                const a = th + k * Math.PI + e * beam.halfWidth
                g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r)
                g.lineTo(x + Math.cos(a) * reach, y + Math.sin(a) * reach)
              }
            }
            g.stroke()
          }
          g.globalAlpha = 0.9
          const gl = r * 6 * gs
          g.drawImage(glow("#b48cff"), x - gl, y - gl, gl * 2, gl * 2)
          g.globalAlpha = 1
          g.globalCompositeOperation = "source-over"
          g.drawImage(disc("#ffffff", "#b48cff"), x - r * DISC_PAD, y - r * DISC_PAD, r * 2 * DISC_PAD, r * 2 * DISC_PAD)
          if (w.chargeRadius > 0) dashRing(x, y, w.chargeRadius, "#b48cff", charging ? 0.35 : 0.15, 14, 12, 10)
          break
        }
        case "planet": {
          if (!visible(x, y, r * 3)) break
          let h = 0
          for (let k = 0; k < w.id.length; k++) h += w.id.charCodeAt(k)
          const pal = h % 2
          g.globalCompositeOperation = "lighter"
          g.globalAlpha = 0.25
          const ag = r * 2.6
          g.drawImage(glow(pal === 0 ? "#ffcf94" : "#8fe3ff"), x - ag, y - ag, ag * 2, ag * 2)
          g.globalAlpha = 1
          g.globalCompositeOperation = "source-over"
          g.drawImage(getPlanet(pal), x - r * DISC_PAD, y - r * DISC_PAD, r * 2 * DISC_PAD, r * 2 * DISC_PAD)
          break
        }
        case "station": {
          if (!visible(x, y, Math.max(r * 2, w.chargeRadius))) break
          const rot = clock * 0.35
          g.fillStyle = "rgba(8,22,36,0.85)"
          g.beginPath()
          g.arc(x, y, r, 0, TAU)
          g.fill()
          g.strokeStyle = "#cfe8f5"
          g.lineWidth = r * 0.16
          g.beginPath()
          g.arc(x, y, r * 0.92, 0, TAU)
          g.stroke()
          g.strokeStyle = "#5ef2ff"
          g.lineWidth = r * 0.07
          g.beginPath()
          g.arc(x, y, r * 0.72, 0, TAU)
          g.stroke()
          g.strokeStyle = "#cfe8f5"
          g.lineWidth = r * 0.1
          g.beginPath()
          for (let k = 0; k < 4; k++) {
            const a = rot + (k * TAU) / 4
            g.moveTo(x + Math.cos(a) * r * 0.25, y + Math.sin(a) * r * 0.25)
            g.lineTo(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9)
          }
          g.stroke()
          g.fillStyle = "#e8fbff"
          g.beginPath()
          g.arc(x, y, r * 0.24, 0, TAU)
          g.fill()
          g.globalCompositeOperation = "lighter"
          for (let k = 0; k < 4; k++) {
            const a = rot + (k * TAU) / 4
            g.globalAlpha = 0.5 + 0.5 * Math.sin(clock * 3 + k * 1.6)
            const lg = r * 0.5
            g.drawImage(glow("#5ef2ff"), x + Math.cos(a) * r * 0.92 - lg, y + Math.sin(a) * r * 0.92 - lg, lg * 2, lg * 2)
          }
          g.globalAlpha = 1
          g.globalCompositeOperation = "source-over"
          if (w.chargeRadius > 0) dashRing(x, y, w.chargeRadius, "#5ef2ff", charging ? 0.45 : 0.22, 16, 12, 12)
          break
        }
        default:
          break
      }
      // gravity storm: ripple rings radiating from every well
      if (storm && visible(x, y, r * 9)) {
        g.strokeStyle = C_WORM
        g.lineWidth = 2 / zoom
        for (let k = 0; k < 2; k++) {
          const ph = (clock * 0.45 + k * 0.5 + i * 0.13) % 1
          g.globalAlpha = (1 - ph) * 0.3
          g.beginPath()
          g.arc(x, y, r * 1.5 + ph * (r * 7 + 90), 0, TAU)
          g.stroke()
        }
        g.globalAlpha = 1
      }
    }
  }

  function drawZones(world: World) {
    const zs = world.zones
    const back = CONFIG.dt * (1 - curAlpha)
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i]
      const x = z.x - z.vx * back
      const y = z.y - z.vy * back
      const r = z.r
      if (!visible(x, y, r * 1.4)) continue
      if (z.kind === "nebula") {
        g.globalAlpha = 0.55
        g.drawImage(glow("#3a2478"), x - r * 1.3, y - r * 1.3, r * 2.6, r * 2.6)
        for (let k = 0; k < 3; k++) {
          const sz = r * (1.5 + 0.15 * k)
          g.translate(x + Math.cos(clock * 0.07 + k * 2.1) * r * 0.12, y + Math.sin(clock * 0.05 + k * 1.7) * r * 0.12)
          g.rotate(clock * 0.03 * (k % 2 === 0 ? 1 : -1) + k * 2)
          g.globalAlpha = 0.5
          g.drawImage(getFog(k), -sz / 2, -sz / 2, sz, sz)
          setWorld()
        }
        dashRing(x, y, r, "#b08cff", 0.25, 14, 12, 6)
      } else if (z.kind === "repulsor") {
        g.globalCompositeOperation = "lighter"
        g.globalAlpha = 0.14
        g.drawImage(glow(C_AMBER), x - r * 1.1, y - r * 1.1, r * 2.2, r * 2.2)
        g.strokeStyle = C_AMBER
        g.lineWidth = 2.6 / zoom
        for (let k = 0; k < 4; k++) {
          const ph = (clock * 0.55 + k / 4) % 1
          g.globalAlpha = (1 - ph) * 0.55
          g.beginPath()
          g.arc(x, y, r * (0.1 + 0.9 * ph), 0, TAU)
          g.stroke()
        }
        g.globalAlpha = 1
        g.globalCompositeOperation = "source-over"
        dashRing(x, y, r, C_AMBER, 0.3, 12, 10, -14)
      } else {
        g.globalCompositeOperation = "lighter"
        g.globalAlpha = 0.3 + 0.1 * Math.sin(clock * 3)
        g.drawImage(glow("#7bed9f"), x - r * 1.2, y - r * 1.2, r * 2.4, r * 2.4)
        g.globalAlpha = 0.22
        g.drawImage(glow("#9d7bff"), x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8)
        g.lineCap = "round"
        g.lineWidth = 2.4 / zoom + 0.6
        for (let k = 0; k < 4; k++) {
          const dir = k % 2 === 0 ? 1 : -1
          const a0 = clock * 1.1 * dir + (k * TAU) / 4
          g.strokeStyle = k % 2 === 0 ? "#7bed9f" : "#9d7bff"
          g.globalAlpha = 0.65
          g.beginPath()
          for (let s = 0; s <= 12; s++) {
            const t = s / 12
            const a = a0 + dir * t * 3
            const rad = r * (0.12 + 0.82 * t)
            if (s === 0) g.moveTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad)
            else g.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad)
          }
          g.stroke()
        }
        g.lineCap = "butt"
        g.fillStyle = "#e8fff0"
        for (let k = 0; k < 9; k++) {
          const a = clock * (0.8 + (k % 3) * 0.3) + k * 0.7
          const rad = r * (0.25 + 0.65 * ((k * 0.37) % 1))
          g.globalAlpha = 0.6 + 0.4 * Math.sin(clock * 4 + k)
          const m = 2.5 / zoom + 1
          g.fillRect(x + Math.cos(a) * rad - m / 2, y + Math.sin(a) * rad - m / 2, m, m)
        }
        g.globalAlpha = 1
        g.globalCompositeOperation = "source-over"
        dashRing(x, y, r, "#7bed9f", 0.3, 10, 10, 10)
      }
    }
  }

  function drawPickups(world: World) {
    const ps = world.pickups
    g.lineCap = "round"
    g.lineJoin = "round"
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]
      const R = Math.max(CONFIG.powerups.radius, 12 / zoom)
      const x = p.x
      const y = p.y + Math.sin(clock * 2.2 + p.id) * 3
      if (!visible(x, y, R * 2.5)) continue
      if (p.ttl < 3 && Math.sin(clock * 14) < 0) continue
      const col = PICK_COL[p.kind]
      const k = R / 13
      g.globalCompositeOperation = "lighter"
      g.globalAlpha = 0.7
      g.drawImage(glow(col), x - R * 2.4, y - R * 2.4, R * 4.8, R * 4.8)
      g.globalCompositeOperation = "source-over"
      g.globalAlpha = 1
      g.fillStyle = "rgba(2,3,10,0.7)"
      g.beginPath()
      g.arc(x, y, R, 0, TAU)
      g.fill()
      g.strokeStyle = col
      g.lineWidth = 2 / zoom
      g.beginPath()
      g.arc(x, y, R, 0, TAU)
      g.stroke()
      g.fillStyle = col
      g.strokeStyle = col
      if (p.kind === "overdrive") {
        g.beginPath()
        g.moveTo(x + 2.5 * k, y - 10 * k)
        g.lineTo(x - 5.5 * k, y + 1 * k)
        g.lineTo(x - 0.5 * k, y + 1 * k)
        g.lineTo(x - 2.5 * k, y + 10 * k)
        g.lineTo(x + 5.5 * k, y - 2 * k)
        g.lineTo(x + 0.5 * k, y - 2 * k)
        g.closePath()
        g.fill()
      } else if (p.kind === "magnet") {
        g.lineWidth = 3.4 * k
        g.lineCap = "butt"
        g.beginPath()
        g.moveTo(x - 5.5 * k, y - 8 * k)
        g.lineTo(x - 5.5 * k, y)
        g.arc(x, y, 5.5 * k, Math.PI, 0, true)
        g.lineTo(x + 5.5 * k, y - 8 * k)
        g.stroke()
        g.strokeStyle = "#ffffff"
        g.beginPath()
        g.moveTo(x - 5.5 * k, y - 8 * k)
        g.lineTo(x - 5.5 * k, y - 4.5 * k)
        g.moveTo(x + 5.5 * k, y - 8 * k)
        g.lineTo(x + 5.5 * k, y - 4.5 * k)
        g.stroke()
        g.lineCap = "round"
      } else if (p.kind === "phase") {
        g.lineWidth = 2.6 * k
        setDash(3.2 * k, 3.2 * k)
        g.lineDashOffset = -clock * 6 * k
        g.beginPath()
        g.arc(x, y, 7.5 * k, 0, TAU)
        g.stroke()
        g.setLineDash(NO_DASH)
        g.lineDashOffset = 0
        g.beginPath()
        g.arc(x, y, 2.2 * k, 0, TAU)
        g.fill()
      } else {
        g.beginPath()
        for (let s = 0; s < 6; s++) {
          const a = Math.PI / 6 + (s * TAU) / 6
          const px2 = x + Math.cos(a) * 8.5 * k
          const py2 = y + Math.sin(a) * 8.5 * k
          if (s === 0) g.moveTo(px2, py2)
          else g.lineTo(px2, py2)
        }
        g.closePath()
        g.fill()
        g.fillStyle = "#d9ffe6"
        g.beginPath()
        for (let s = 0; s < 6; s++) {
          const a = Math.PI / 6 + (s * TAU) / 6
          const px2 = x + Math.cos(a) * 4.2 * k
          const py2 = y + Math.sin(a) * 4.2 * k
          if (s === 0) g.moveTo(px2, py2)
          else g.lineTo(px2, py2)
        }
        g.closePath()
        g.fill()
      }
    }
    g.lineCap = "butt"
    g.lineJoin = "miter"
    g.globalAlpha = 1
  }

  function drawMeteors(world: World) {
    const ev = world.cosmic
    if (!ev || ev.kind !== "meteorShower") return
    const r = ev.r
    if (!visible(ev.x, ev.y, r * 1.2)) return
    if (ev.stage === "warning") {
      const p = 0.5 + 0.5 * Math.sin(clock * 8)
      dashRing(ev.x, ev.y, r, C_AMBER, 0.3 + 0.45 * p, 18, 12, 30)
      return
    }
    g.save()
    g.beginPath()
    g.arc(ev.x, ev.y, r, 0, TAU)
    g.clip()
    g.globalCompositeOperation = "lighter"
    g.lineCap = "round"
    g.strokeStyle = "#ffd9a0"
    g.lineWidth = 2.4 / zoom + 0.6
    g.beginPath()
    for (let k = 0; k < 26; k++) {
      const h1 = RND[k]
      const h2 = RND[(k * 7 + 3) % RND.length]
      const ph = (clock * (0.7 + 0.5 * h2) + h1 * 3.7) % 1
      const sx = ev.x + (h1 - 0.5) * 2.4 * r - r * 0.5
      const sy = ev.y - r * 1.1
      const hx = sx + 0.5 * 2.3 * r * ph
      const hy = sy + 2.3 * r * ph
      g.moveTo(hx - 0.45 * 70, hy - 70)
      g.lineTo(hx, hy)
    }
    g.stroke()
    g.restore()
    g.globalAlpha = 0.18
    g.drawImage(glow(C_AMBER), ev.x - r, ev.y - r, r * 2, r * 2)
    g.globalAlpha = 1
    g.globalCompositeOperation = "source-over"
    g.lineCap = "butt"
    dashRing(ev.x, ev.y, r, C_AMBER, 0.35, 18, 12, 30)
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
      const fl = world.cosmic && world.cosmic.kind === "wormholeStorm" ? 0.45 + 0.55 * Math.abs(Math.sin(clock * 31 + i * 5) * Math.sin(clock * 17)) : 1
      g.globalAlpha = fl
      g.drawImage(glow(C_WORM), w.x - r * 3, w.y - r * 3, r * 6, r * 6)
      g.globalAlpha = 0.6 * fl
      g.drawImage(glow("#c9b6ff"), w.x - r * 1.4, w.y - r * 1.4, r * 2.8, r * 2.8)
      g.strokeStyle = C_WORM
      g.lineWidth = 2.8 / zoom + 0.8
      g.globalAlpha = fl
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
    // comets: bright head, long fading tail opposite the velocity
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i]
      if (d.kind !== "comet") continue
      const x = d.px + (d.x - d.px) * alpha
      const y = d.py + (d.y - d.py) * alpha
      const sp = Math.hypot(d.vx, d.vy)
      const L = Math.max(sp * 0.25, 50)
      if (Math.abs(x - camX) > hw + L || Math.abs(y - camY) > hh + L) continue
      g.globalCompositeOperation = "lighter"
      g.translate(x, y)
      g.rotate(Math.atan2(-d.vy, -d.vx))
      g.scale(L, d.radius * 1.1)
      g.globalAlpha = 1
      g.drawImage(getTail(), 0, -1, 1, 2)
      setWorld()
      g.globalAlpha = 0.9
      const gr = d.radius * 3.4
      g.drawImage(glow("#bfe9ff"), x - gr, y - gr, gr * 2, gr * 2)
      g.globalAlpha = 1
      g.globalCompositeOperation = "source-over"
      const dr = d.radius * DISC_PAD
      g.drawImage(disc("#ffffff", "#bfe9ff"), x - dr, y - dr, dr * 2, dr * 2)
    }
  }

  function drawPulls(world: World) {
    const bs = world.bodies
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]
      const ult = b.ultActive > 0
      if (!b.alive || (!b.pulling && !ult)) continue
      const R = pullRadius(b)
      const x = bx[i]
      const y = by[i]
      if (!visible(x, y, R)) continue
      // a hint, not a field: rivals at half strength, everything fading as the radius grows on screen
      const f = i === 0 ? 1 : 0.5
      const s = clamp(1 - (R * zoom - 250) / 350, 0, 1)
      g.fillStyle = b.color
      g.globalAlpha = 0.03 * f * s
      if (g.globalAlpha > 0) {
        g.beginPath()
        g.arc(x, y, R, 0, TAU)
        g.fill()
      }
      g.strokeStyle = b.color
      g.lineWidth = 1.5 / zoom
      // 12 spokes drawn outer -> inner; a negative dash offset marches the dashes inward.
      // Inner stretch is stronger than the outer one, so they fade toward the edge.
      setDash(10 / zoom + 4, 9 / zoom + 4)
      g.lineDashOffset = -clock * (ult ? 110 : 60)
      const r0 = b.radius * 1.3
      const mid = r0 + (R - r0) * 0.6
      for (let pass = 0; pass < 2; pass++) {
        g.globalAlpha = (pass === 0 ? 0.18 : 0.07) * f * (0.3 + 0.7 * s)
        g.beginPath()
        for (let k = 0; k < 12; k++) {
          const a = (k * TAU) / 12 + clock * 0.2
          const ca = Math.cos(a)
          const sa = Math.sin(a)
          const from = pass === 0 ? mid : R
          const to = pass === 0 ? r0 : mid
          g.moveTo(x + ca * from, y + sa * from)
          g.lineTo(x + ca * to, y + sa * to)
        }
        g.stroke()
      }
      g.lineDashOffset = 0
      g.setLineDash(NO_DASH)
      g.globalAlpha = 0.3 * f * (0.4 + 0.6 * s)
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
      } else if (kind === P_RING || kind === P_RINGIN) {
        const p = 1 - life
        const r = kind === P_RING ? pSize[i] * (1 - (1 - p) * (1 - p) * (1 - p)) : pSize[i] * life
        if (!visible(x, y, r)) continue
        g.globalAlpha = life * 0.9
        g.strokeStyle = pCol[i]
        g.lineWidth = (4 * life + 1) / zoom
        g.beginPath()
        g.arc(x, y, r, 0, TAU)
        g.stroke()
        lastCol = ""
      } else if (kind === P_LINE) {
        if (!visible(x, y, 200)) continue
        g.globalAlpha = life
        g.strokeStyle = pCol[i]
        g.lineWidth = pSize[i] * (0.3 + 0.7 * life)
        g.lineCap = "round"
        g.beginPath()
        g.moveTo(x, y)
        g.lineTo(x + pVX[i], y + pVY[i])
        g.stroke()
        g.lineCap = "butt"
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
      const ult = b.ultActive > 0
      const magnet = b.power.magnet > 0
      const mr = magnet ? pullRadius(b) : 0
      if (!visible(x, y, Math.max(r * 2.4, mr))) continue
      // phase: semi-transparent, blinking in its last second
      const phased = b.power.phase > 0
      let ba = 1
      if (phased) ba = b.power.phase < 1 && ((clock * 10) | 0) % 2 === 0 ? 0.85 : 0.42
      const stretched = dashT[i] > 0
      let sx = 1
      let sy = 1
      let ang = 0
      if (stretched) {
        sx = 1 + 0.4 * (dashT[i] / DASH_T)
        sy = 1 / Math.sqrt(sx)
        ang = Math.atan2(dashDy[i], dashDx[i])
      }
      // glow
      const gr = r * 2.2
      g.globalCompositeOperation = "lighter"
      g.globalAlpha = 0.35 * (phased ? 0.6 : 1)
      g.drawImage(glow(b.color), x - gr, y - gr, gr * 2, gr * 2)
      g.globalAlpha = ba
      g.globalCompositeOperation = "source-over"
      // disk (squash and stretch along the dash direction)
      const d = r * DISC_PAD
      if (stretched) {
        g.translate(x, y)
        g.rotate(ang)
        g.scale(sx, sy)
        g.drawImage(bodyDisc(b.color), -d, -d, d * 2, d * 2)
        setWorld()
      } else {
        g.drawImage(bodyDisc(b.color), x - d, y - d, d * 2, d * 2)
      }
      // Singularity: dark core, bright event-horizon rim, accretion swirl
      if (ult) {
        const ua = Math.min(1, b.ultActive / 0.5)
        g.globalAlpha = ua
        g.fillStyle = "#000"
        g.beginPath()
        g.arc(x, y, r * 0.74, 0, TAU)
        g.fill()
        g.strokeStyle = "#ffffff"
        g.lineWidth = 2.5 / zoom
        g.beginPath()
        g.arc(x, y, r * 0.74, 0, TAU)
        g.stroke()
        g.globalCompositeOperation = "lighter"
        g.lineCap = "round"
        g.strokeStyle = b.color
        for (let k = 0; k < 3; k++) {
          const rot = clock * (3.2 - k * 0.7) * (k % 2 === 0 ? 1 : -1) + k * 2
          g.lineWidth = r * (0.16 - 0.03 * k)
          g.globalAlpha = ua * 0.85
          g.beginPath()
          g.arc(x, y, r * (1.05 + 0.2 * k), rot, rot + 2.2)
          g.stroke()
        }
        g.lineCap = "butt"
        g.globalCompositeOperation = "source-over"
        g.globalAlpha = ba
      }
      // outline
      let outline = "#ffffff"
      if (i > 0) {
        if (playerAlive && player) {
          outline = canAbsorb(b, player) ? C_THREAT : canAbsorb(player, b) ? C_PREY : C_NEUTRAL
        } else {
          outline = C_NEUTRAL
        }
      }
      if (phased) {
        g.globalAlpha = 0.5 + 0.45 * Math.sin(clock * 12)
        outline = "#e6dcff"
      }
      g.strokeStyle = outline
      g.lineWidth = 3 / zoom
      g.beginPath()
      if (stretched) g.ellipse(x, y, r * sx, r * sy, ang, 0, TAU)
      else g.arc(x, y, r, 0, TAU)
      g.stroke()
      g.globalAlpha = 1
      // Earned gravity-assist surge: a rim that fades as the boost expires. Reduced motion keeps
      // it a still ring; it never covers the body and adds no persistent HUD.
      if (b.assist.surge > 0) {
        const f = b.assist.surgeFull > 0 ? clamp(b.assist.surge / b.assist.surgeFull, 0, 1) : 1
        const pulse = reduced ? 1 : 0.7 + 0.3 * Math.sin(clock * 7)
        g.globalCompositeOperation = "lighter"
        g.globalAlpha = (0.35 + 0.5 * f) * pulse
        g.strokeStyle = "#ffd36b"
        g.lineWidth = 2.4 / zoom
        g.beginPath()
        g.arc(x, y, r + 5 / zoom, 0, TAU)
        g.stroke()
        g.globalAlpha = 1
        g.globalCompositeOperation = "source-over"
      }
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
      // Singularity ready: a subtle pulsing ring around the player
      if (i === 0 && b.ult >= 0.999 && !ult) {
        const ph = (clock * 1.5) % 1
        g.strokeStyle = "#d9b8ff"
        g.lineWidth = 2.4 / zoom
        g.globalAlpha = 0.35 + 0.35 * Math.sin(clock * 5)
        g.beginPath()
        g.arc(x, y, r * 1.7, 0, TAU)
        g.stroke()
        g.globalAlpha = 0.4 * (1 - ph)
        g.beginPath()
        g.arc(x, y, r * (1.7 + 0.9 * ph), 0, TAU)
        g.stroke()
        g.globalAlpha = 1
      }
      // magnet: rotating dashed ring at the pull radius
      if (magnet) {
        g.globalAlpha = 0.4
        g.strokeStyle = C_PLAYER
        g.lineWidth = 2 / zoom
        setDash(16, 12)
        g.lineDashOffset = -clock * 40
        g.beginPath()
        g.arc(x, y, mr, 0, TAU)
        g.stroke()
        g.setLineDash(NO_DASH)
        g.lineDashOffset = 0
        g.globalAlpha = 1
      }
      // shield
      if (b.shield > 0) {
        g.globalAlpha = 0.07 + 0.04 * Math.sin(clock * 6)
        g.fillStyle = C_TEXT
        g.beginPath()
        g.arc(x, y, r * 1.4, 0, TAU)
        g.fill()
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
    // bot labels, skill pips (endless) and the leader crown
    const bs = world.bodies
    const endless = world.mode === "endless"
    let leader = -1
    if (endless) {
      let best = -1
      for (let i = 0; i < bs.length; i++) {
        if (bs[i].alive && bs[i].mass > best) {
          best = bs[i].mass
          leader = i
        }
      }
    }
    g.font = "12px " + FONT
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]
      if (!b.alive) continue
      const x = bx[i]
      const y = by[i]
      if (!visible(x, y, b.radius * 2)) continue
      const sx = (x - camX) * zoom + W / 2 + shx
      const sy = (y - camY) * zoom + H / 2 + shy - b.radius * zoom * clamp(1 + popX[i], 0.6, 1.6) - 8
      let crownY = sy - 2
      if (i > 0) {
        const label = b.name + "  " + Math.round(b.mass)
        g.fillStyle = "rgba(255,255,255,0.75)"
        g.fillText(label, sx, sy)
        if (endless) {
          const n = b.skill === "hard" ? 3 : b.skill === "normal" ? 2 : 1
          g.fillStyle = b.skill === "hard" ? C_THREAT : b.skill === "normal" ? C_AMBER : "#9fb3c8"
          const px0 = sx + label.length * 3.2 + 8
          for (let k = 0; k < n; k++) {
            g.beginPath()
            g.arc(px0 + k * 6, sy - 4, 2, 0, TAU)
            g.fill()
          }
        }
        crownY = sy - 17
      }
      if (i === leader) {
        // crown: five-point silhouette drawn from paths
        g.fillStyle = "#ffd166"
        g.strokeStyle = "rgba(60,35,0,0.7)"
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(sx - 7, crownY)
        g.lineTo(sx - 8, crownY - 8)
        g.lineTo(sx - 3.5, crownY - 4)
        g.lineTo(sx, crownY - 10)
        g.lineTo(sx + 3.5, crownY - 4)
        g.lineTo(sx + 8, crownY - 8)
        g.lineTo(sx + 7, crownY)
        g.closePath()
        g.fill()
        g.stroke()
      }
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
  // Set by drawIndicators: Endless shows a DOM leaderboard on the right that arrows must avoid.
  let lbZone = false
  function blocked(x: number, y: number): boolean {
    const pad = 14
    if (x < 215 + pad && y < 145 + pad) return true
    if (lbZone && (touch ? x > W - 172 - pad && y > 176 - pad && y < 340 + pad : x > W - 232 - pad && y > 52 - pad && y < 300 + pad)) return true
    if (x > W / 2 - 80 - pad && x < W / 2 + 80 + pad && y < 70 + pad) return true
    if (x > W - 110 - pad && y < 70 + pad) return true
    const mx = touch ? W - 12 - 56 : W - 18 - 56
    const my = touch ? 64 + 56 : H - 18 - 56
    const ddx = x - mx
    const ddy = y - my
    return ddx * ddx + ddy * ddy < (66 + pad) * (66 + pad)
  }

  function drawIndicators(world: World, player: Body, ppx: number, ppy: number) {
    lbZone = world.mode === "endless"
    const left = 24
    const top = 80
    const right = W - 24
    const bottom = Math.max(top + 40, H - (touch ? 170 : 24))
    const rcx = (left + right) / 2
    const rcy = (top + bottom) / 2
    const hrw = (right - left) / 2
    const hrh = (bottom - top) / 2
    const bs = world.bodies
    const range = indicatorRange(world.arenaBase)
    for (let i = 1; i < bs.length; i++) {
      const b = bs[i]
      if (!b.alive) continue
      const x = bx[i]
      const y = by[i]
      const dist = Math.hypot(x - ppx, y - ppy)
      if (dist > range) continue
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
      const s = 7 + 9 * (1 - dist / range)
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

  /** Off-screen compass for the giant central star: which edge the core lies past, and how far. */
  function drawCoreCompass(world: World) {
    lbZone = world.mode === "endless"
    let core: (typeof world.wells)[number] | undefined
    for (let i = 0; i < world.wells.length; i++) {
      const w = world.wells[i]
      if (w.kind !== "star" || w.radius < 220) continue
      if (!core || w.radius > core.radius) core = w
    }
    if (!core) return
    const left = 24
    const top = 96
    const right = W - 24
    const bottom = Math.max(top + 40, H - (touch ? 170 : 24))
    const m = frameEdgeMarker(core.x, core.y, camX, camY, zoom, W, H, { left, top, right, bottom })
    if (!m) return
    let ex = m.x
    let ey = m.y
    if (blocked(ex, ey)) {
      // Slide along the frame edge until the marker clears the HUD panels.
      const tx = -Math.sin(m.angle)
      const ty = Math.cos(m.angle)
      for (let step = 20; step <= 160 && blocked(ex, ey); step += 20) {
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          const px = ex + tx * step * sgn
          const py = ey + ty * step * sgn
          if (px >= left && px <= right && py >= top && py <= bottom && !blocked(px, py)) {
            ex = px
            ey = py
            break
          }
        }
      }
    }
    const pulse = reduced ? 0.75 : 0.6 + 0.4 * Math.sin(clock * 2.4)
    g.save()
    g.translate(ex, ey)
    g.rotate(m.angle)
    g.globalAlpha = 0.9 * pulse
    g.fillStyle = C_AMBER
    g.beginPath()
    g.moveTo(9, 0)
    g.lineTo(0, 5)
    g.lineTo(-5, 0)
    g.lineTo(0, -5)
    g.closePath()
    g.fill()
    g.restore()
    // Label inset toward the frame centre so it stays inside the HUD-safe rectangle.
    const lx = ex - Math.cos(m.angle) * 26
    const ly = ey - Math.sin(m.angle) * 26
    g.globalAlpha = 0.75
    g.fillStyle = C_AMBER
    g.font = "700 11px " + FONT
    g.textAlign = "center"
    g.textBaseline = "middle"
    g.fillText(
      m.distance >= 1000 ? "CORE " + (m.distance / 1000).toFixed(1) + "k" : "CORE " + Math.round(m.distance),
      lx,
      ly,
    )
    g.globalAlpha = 1
    g.textBaseline = "alphabetic"
  }

  function drawMinimap(world: World) {
    const R = 56
    const mx = touch ? W - 12 - R : W - 18 - R
    const my = touch ? 64 + R : H - 18 - R
    const base = world.arenaBase > 0 ? world.arenaBase : world.arenaRadius
    const k = R / base
    g.fillStyle = "rgba(2,3,10,0.7)"
    g.beginPath()
    g.arc(mx, my, R, 0, TAU)
    g.fill()
    g.strokeStyle = "rgba(94,242,255,0.5)"
    g.lineWidth = 1.5
    g.stroke()
    // escalation: the closing wall in red
    if (world.arenaRadius < base - 0.5) {
      g.strokeStyle = "rgba(255,77,109,0.85)"
      g.lineWidth = 1.5
      g.beginPath()
      g.arc(mx, my, world.arenaRadius * k, 0, TAU)
      g.stroke()
    }
    // Vast scale: two sector rings give the eye fixed distances in an otherwise empty field.
    if (world.arenaBase > CONFIG.camera.arenaRadiusRef * 1.5) {
      g.strokeStyle = "rgba(94,242,255,0.16)"
      g.lineWidth = 1
      for (let i = 1; i <= 2; i++) {
        g.beginPath()
        g.arc(mx, my, (world.arenaBase * i) / 3 * k, 0, TAU)
        g.stroke()
      }
    }
    // zones
    for (let i = 0; i < world.zones.length; i++) {
      const z = world.zones[i]
      g.globalAlpha = 0.28
      g.fillStyle = z.kind === "nebula" ? "#8a62d6" : z.kind === "repulsor" ? C_AMBER : "#7bed9f"
      g.beginPath()
      g.arc(mx + z.x * k, my + z.y * k, Math.max(2, z.r * k), 0, TAU)
      g.fill()
    }
    g.globalAlpha = 1
    // cosmic event focus
    const ev = world.cosmic
    if (ev && (ev.kind === "meteorShower" || ev.kind === "solarFlare" || ev.kind === "nebulaDrift" || ev.kind === "quantumAnomaly")) {
      g.strokeStyle = "#ffffff"
      g.lineWidth = 1
      setDash(3, 3)
      g.beginPath()
      g.arc(mx + ev.x * k, my + ev.y * k, Math.max(3, ev.r * k), 0, TAU)
      g.stroke()
      g.setLineDash(NO_DASH)
    }
    // crystals, comets
    const ds = world.debris
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i]
      if (d.kind === "crystal") {
        g.fillStyle = C_PLAYER
        g.fillRect(mx + d.x * k - 1, my + d.y * k - 1, 2, 2)
      } else if (d.kind === "comet") {
        g.fillStyle = "#ffffff"
        g.fillRect(mx + d.x * k - 1.5, my + d.y * k - 1.5, 3, 3)
      }
    }
    // pickups
    for (let i = 0; i < world.pickups.length; i++) {
      const p = world.pickups[i]
      g.fillStyle = PICK_COL[p.kind]
      g.fillRect(mx + p.x * k - 1.5, my + p.y * k - 1.5, 3, 3)
    }
    // wells (moving ones at their current position) and wormholes
    for (let i = 0; i < world.wells.length; i++) {
      const w = world.wells[i]
      const wr = Math.max(w.kind === "neutronstar" || w.kind === "whitedwarf" ? 2.2 : 3, w.radius * k)
      if (w.kind === "star" && w.chargeRadius * k > wr) {
        g.strokeStyle = "rgba(255,184,77,0.22)"
        g.lineWidth = 1
        g.beginPath()
        g.arc(mx + w.x * k, my + w.y * k, w.chargeRadius * k, 0, TAU)
        g.stroke()
      }
      g.fillStyle = MINI_WELL[w.kind]
      g.beginPath()
      g.arc(mx + w.x * k, my + w.y * k, wr, 0, TAU)
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
      g.drawImage(getVignette(vigAmber ? VIG_AMBER : VIG_RED), 0, 0, W, H)
      g.globalAlpha = 1
    }
    // white flash
    if (flashT > 0 && !reduced) {
      g.globalAlpha = 0.12 * (flashT / 0.08)
      g.fillStyle = "#ffffff"
      g.fillRect(0, 0, W, H)
      g.globalAlpha = 1
    }
    // gravity storm: violet screen-edge tint
    if (world.cosmic && world.cosmic.kind === "gravityStorm") {
      g.globalAlpha = reduced ? 0.1 : 0.1 + 0.05 * Math.sin(clock * 3)
      g.drawImage(getVignette(VIG_VIOLET), 0, 0, W, H)
      g.globalAlpha = 1
    }
    // cosmic event start / warning: a short flash in the event's colour
    if (evFlashT > 0 && !reduced) {
      g.globalAlpha = 0.16 * (evFlashT / 0.35)
      g.fillStyle = `rgb(${evFlashRgb})`
      g.fillRect(0, 0, W, H)
      g.globalAlpha = 1
    }
    // Flyby telegraph: only a dash along the flight path, inside the periapsis window, is the
    // burn, so the prompt names the direction in plain language. Drawn above the player in screen
    // space so it stays legible at any zoom (and needs no HUD element).
    if (player && player.alive) {
      const v = assistView(world, player)
      if (burnPromptVisible(v.window, player.dashCd, player.energy, dashLocked)) {
        // Clamp to the viewport so the prompt can never clip at an edge (or run under the HUD edge).
        const label = burnPromptLabel(touch)
        g.font = "700 13px " + FONT
        const half = g.measureText(label).width / 2
        const pad = 10
        const sx = clamp((ppx - camX) * zoom + W / 2 + shx, half + pad, W - half - pad)
        const sy = clamp((ppy - camY) * zoom + H / 2 + shy - player.radius * zoom - 24, 26, H - 14)
        g.globalAlpha = reduced ? 0.9 : 0.7 + 0.3 * Math.sin(clock * 14)
        g.textAlign = "center"
        g.textBaseline = "alphabetic"
        g.fillStyle = "#ffe28a"
        g.shadowColor = "#ffb347"
        g.shadowBlur = 8
        g.fillText(label, sx, sy)
        g.shadowBlur = 0
        g.globalAlpha = 1
      }
    }
    drawMinimap(world)
    if (player && player.alive) drawIndicators(world, player, ppx, ppy)
    drawCoreCompass(world)
  }

  // ---- public: render ---------------------------------------------------------------------
  function render(world: World, alpha: number, frameDt: number) {
    const dt = frameDt > 0 ? Math.min(frameDt, 0.1) : 0
    clock += dt
    curAlpha = alpha
    if (!camInit || nebSeed !== world.seed) {
      if (!camInit) reset(world)
      else placeNebulae(world)
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
      // Dead in Endless: the arena keeps living, so the camera follows the current leader instead
      // of parking on the corpse. In a round the game is over, so the camera stays where it was.
      let followIdx = 0
      let followingPlayer = true
      if (!player.alive && world.mode === "endless") {
        let best = -1
        for (let i = 1; i < n; i++) {
          if (!bs[i].alive) continue
          if (best < 0 || bs[i].mass > bs[best].mass) best = i
        }
        if (best >= 0) {
          followIdx = best
          followingPlayer = false
        }
      }
      let tx = camX
      let ty = camY
      let zt: number
      if (followingPlayer) {
        tx = ppx + player.vx * 0.18
        ty = ppy + player.vy * 0.18
        if (demo) {
          tx *= 0.65
          ty *= 0.65
        }
        if (player.alive) {
          aliveZoomTarget = zoomTargetFor(world, player)
          zt = aliveZoomTarget
        } else {
          zt = aliveZoomTarget * 0.8
        }
      } else {
        const follower = bs[followIdx]
        tx = bx[followIdx] + follower.vx * 0.12
        ty = by[followIdx] + follower.vy * 0.12
        zt = Math.max(0.32, aliveZoomTarget * 0.85)
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
      if (evFlashT > 0) evFlashT = Math.max(0, evFlashT - dt)
    }

    playerSx = (ppx - camX) * zoom + W / 2
    playerSy = (ppy - camY) * zoom + H / 2

    // dash stretch / slingshot timers
    for (let i = 0; i < n; i++) {
      if (dashT[i] > 0) dashT[i] -= dt
      if (slingT[i] > 0) slingT[i] -= dt
    }
    // wormhole relocation (wormhole storm): flash where each end was and where it landed
    {
      const whs = world.wormholes
      if (whs.length >= 2) {
        if (whInit) {
          for (let i = 0; i < 2; i++) {
            const w = whs[i]
            if (Math.hypot(w.x - whPrev[i * 2], w.y - whPrev[i * 2 + 1]) > 30) {
              flashAt(whPrev[i * 2], whPrev[i * 2 + 1], 160, C_WORM)
              flashAt(w.x, w.y, 200, "#ffffff")
              burst(w.x, w.y, 20, 80, 300, 0.5, 3, C_WORM, true)
            }
          }
        }
        for (let i = 0; i < 2; i++) {
          whPrev[i * 2] = whs[i].x
          whPrev[i * 2 + 1] = whs[i].y
        }
        whInit = true
      }
    }
    // comet sparkles
    if (dt > 0) {
      const ds = world.debris
      for (let i = 0; i < ds.length; i++) {
        const d = ds[i]
        if (d.kind !== "comet" || Math.random() > dt * 35) continue
        if (!visible(d.x, d.y, 200)) continue
        addP(P_DOT, d.x + (Math.random() - 0.5) * d.radius, d.y + (Math.random() - 0.5) * d.radius, (Math.random() - 0.5) * 50 - d.vx * 0.1, (Math.random() - 0.5) * 50 - d.vy * 0.1, 0.5, 2.2 / zoom, "#bfe9ff", false)
      }
    }
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
        if (b.power.overdrive > 0) {
          emitPow[i] += dt * (reduced ? 12 : 30)
          if (emitPow[i] > 4) emitPow[i] = 4
          while (emitPow[i] >= 1) {
            emitPow[i] -= 1
            const a = Math.random() * TAU
            addP(P_DOT, x + Math.cos(a) * b.radius, y + Math.sin(a) * b.radius, Math.cos(a) * 50 + (Math.random() - 0.5) * 40, Math.sin(a) * 50 - 30, 0.4 + Math.random() * 0.2, 2.2 / zoom, C_AMBER, false)
          }
        }
        if (slingT[i] > 0) {
          const sp = Math.hypot(b.vx, b.vy)
          if (sp > 50) {
            emitSling[i] += dt * 50
            if (emitSling[i] > 3) emitSling[i] = 3
            while (emitSling[i] >= 1) {
              emitSling[i] -= 1
              const ox = (Math.random() - 0.5) * b.radius
              const oy = (Math.random() - 0.5) * b.radius
              addP(P_LINE, x + ox, y + oy, (-b.vx / sp) * sp * 0.08, (-b.vy / sp) * sp * 0.08, 0.28, 3.5 / zoom, "#e8f6ff", false)
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
    drawZones(world)
    drawArena(world, player, ppx, ppy)
    drawSolarCurrent(world)
    drawOrbits(world)
    drawWells(world, player)
    drawWormholes(world)
    drawMeteors(world)
    drawPickups(world)
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
    currentRing = null
    currentVisual = null
    currentVisualSeed = -1
    starSurface = null
    vignetteCache.clear()
    fogSprites.length = 0
    planetSprites.length = 0
    beamSprite = null
    beamCore = null
    tailSprite = null
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
    frame(): RenderFrame {
      return { camX, camY, zoom, shakeX: shx, shakeY: shy, width: W, height: H, dpr }
    },
    reset,
    dispose,
  }
}
