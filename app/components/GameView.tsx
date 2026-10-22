"use client"

import { useEffect, useRef, useState } from "react"
import { createBotBrain, botIntent, type BotBrain } from "@/game/bots"
import { ARENA_IDS } from "@/game/arenas"
import { finishEndlessSession, type EndlessFold, finishRound, newTracker, saveProfile, trackStep, type AchievementDef, type Profile } from "@/game/achievements"
import { CONFIG } from "@/game/config"
import { createWorld, hudSnapshot, step } from "@/game/engine"
import { createInput, type InputController } from "@/game/input"
import { createRenderer, type RenderView } from "@/game/render"
import type { Sfx } from "@/game/audio"
import { deathLine } from "./Screens"
import type { ArenaId, BodyStats, DeathCause, Difficulty, GameMode, HudSnapshot, Intent, RoundResult, World } from "@/game/types"
import { TouchControls } from "./TouchControls"

interface GwDebug {
  world: () => World | null
  autopilot: boolean
  audioState: () => string
  perf: { frameMs: number[]; stepMs: number[]; renderMs: number[] }
}

declare global {
  interface Window {
    __gw?: GwDebug
  }
}

export interface GameViewProps {
  difficulty: Difficulty
  seed: number
  arena: ArenaId
  /** Defaults to "round". Endless never ends: no onEnd; the session folds into the profile on unmount. */
  mode?: GameMode
  paused: boolean
  sfx: Sfx
  onHud(h: HudSnapshot): void
  /** `unlocked` = every achievement earned this round (mid-round and round-end). */
  onEnd(r: RoundResult, playerStats: BodyStats, unlocked: AchievementDef[]): void
  onPauseRequest(): void
  onGesture(): void
  onLayout(l: "desktop" | "touch"): void
  /** Attract mode: autopilot plays a self-restarting round; no input, sound, HUD or end callbacks. */
  demo?: boolean
  /** Layout known by the page (covers hybrid devices that have already seen touch). */
  initialLayout?: "desktop" | "touch"
  /** Endless: the player died; `text` is the death line for the respawn overlay. */
  onDeath?(text: string): void
  /** Lifetime profile, mutated in place by achievement tracking (never in demo mode). */
  profile?: Profile
  /** Achievements unlocked mid-round, for toasts. */
  onUnlock?(defs: AchievementDef[]): void
  /** The live input controller (null in demo / before mount), so the HUD can press abilities. */
  onInputReady?(ctl: InputController | null): void
  /** Latest HUD snapshot, used for the touch buttons' cooldown and charge rings. */
  hud?: HudSnapshot | null
  /** Hide the on-screen touch controls (paused / round over). */
  hideTouch?: boolean
}

function deathText(world: World, cause: DeathCause): string {
  return deathLine(cause, (id) => world.bodies.find((b) => b.id === id)?.name ?? "a rival")
}

const DEBUG_BUILD = process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_GW_DEBUG === "1"
const HUD_INTERVAL_MS = 100
const AFTERMATH_MS = 1400
const PERF_SAMPLES = 600

function pushSample(buf: number[], v: number) {
  buf.push(v)
  if (buf.length > PERF_SAMPLES) buf.shift()
}

export function GameView(props: GameViewProps) {
  const { seed, sfx, paused, arena } = props
  const demo = props.demo === true
  const difficulty: Difficulty = demo ? "normal" : props.difficulty
  const mode: GameMode = demo ? "round" : props.mode ?? "round"
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [layout, setLayout] = useState<"desktop" | "touch">("desktop")
  const [input, setInput] = useState<InputController | null>(null)

  // Latest props for use inside the long-lived effect closure.
  const propsRef = useRef(props)
  propsRef.current = props
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  // Set by the main effect; flips the loop between running and paused.
  const setPausedRef = useRef<((p: boolean) => void) | null>(null)

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return

    const mq = (q: string) => (typeof window.matchMedia === "function" ? window.matchMedia(q).matches : false)
    let touchSeen = false
    let curLayout: "desktop" | "touch" = propsRef.current.initialLayout === "touch" || mq("(pointer: coarse)") ? "touch" : "desktop"
    setLayout(curLayout)
    propsRef.current.onLayout(curLayout)

    const pickArena = (): ArenaId => (demo ? ARENA_IDS[Math.floor(Math.random() * ARENA_IDS.length)] : arena)
    let world: World = createWorld({ seed, difficulty, arena: pickArena(), mode })
    let tracker = newTracker()
    const roundUnlocked: AchievementDef[] = []
    const store = (): Storage | null => {
      try {
        return window.localStorage
      } catch {
        return null
      }
    }
    const brains = new Map<string, BotBrain>()
    let autopilotBrain: BotBrain
    let brainSeed = seed
    let joins = 0
    const setupBrains = (sd: number) => {
      brains.clear()
      brainSeed = sd
      joins = 0
      world.bodies.forEach((b, i) => {
        if (b.kind === "bot") brains.set(b.id, createBotBrain(b.id, b.skill ?? difficulty, sd + i * 7919))
      })
      autopilotBrain = createBotBrain("player", "hard", sd + 1)
    }
    setupBrains(seed)

    const makeView = (): RenderView => {
      const r = stage.getBoundingClientRect()
      return {
        width: Math.max(1, Math.round(r.width)),
        height: Math.max(1, Math.round(r.height)),
        dpr: Math.min(window.devicePixelRatio || 1, 2),
        reducedMotion: mq("(prefers-reduced-motion: reduce)"),
        layout: curLayout,
        ...(demo ? { demo: true } : {}),
      }
    }

    const renderer = createRenderer(canvas, makeView())
    renderer.reset(world)

    const ctl: InputController | null = demo
      ? null
      : createInput(canvas, {
          onPause: () => {
            if (!pausedRef.current) propsRef.current.onPauseRequest()
          },
          onGesture: () => propsRef.current.onGesture(),
        })
    setInput(ctl)

    let debug: GwDebug | null = null
    // Probe/QA hook (world access + bot autopilot). Compiled in only for `next dev` or a build with
    // NEXT_PUBLIC_GW_DEBUG=1; Next inlines both values, so a normal production build drops it.
    // Then it still needs an exact ?debug parameter, not any URL that happens to contain "debug".
    if (DEBUG_BUILD && new URLSearchParams(window.location.search).has("debug")) {
      debug = {
        world: () => world,
        autopilot: false,
        audioState: () => sfx.state?.() ?? "none",
        perf: { frameMs: [], stepMs: [], renderMs: [] },
      }
      window.__gw = debug
    }

    const doResize = () => {
      renderer.resize(makeView())
      // resize() clears the canvas; redraw if no loop is running to do it (pause, round end).
      if (!running) renderer.render(world, Math.min(1, Math.max(0, acc / CONFIG.dt)), 0)
    }
    const ro = new ResizeObserver(doResize)
    ro.observe(stage)

    const onTouchPointer = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || touchSeen) return
      touchSeen = true
      if (curLayout !== "touch") {
        curLayout = "touch"
        setLayout("touch")
        propsRef.current.onLayout("touch")
        doResize()
      }
    }
    if (!demo) window.addEventListener("pointerdown", onTouchPointer, true)

    const intents = new Map<string, Intent>()
    let raf = 0
    let running = false
    let last = 0
    let acc = 0
    let hitStop = 0
    let lastHudAt = -Infinity
    let overAt = -1
    let ended = false
    let lastFrameAt = 0

    // A function (not an inline comparison) so TypeScript does not narrow world.phase across step().
    const isOver = () => world.phase === "over"

    const pushHud = (now: number) => {
      lastHudAt = now
      if (!demo) propsRef.current.onHud(hudSnapshot(world))
    }

    const frame = (now: number) => {
      if (!running) return
      raf = requestAnimationFrame(frame)
      // Clamp both ends: the first rAF timestamp can predate start()'s performance.now().
      const frameDt = Math.max(0, Math.min((now - last) / 1000, CONFIG.maxFrameDt))
      last = now
      if (debug) {
        if (lastFrameAt) pushSample(debug.perf.frameMs, now - lastFrameAt)
        lastFrameAt = now
      }

      let forceHud = false
      const t0 = debug ? performance.now() : 0
      if (isOver()) {
        acc = 0
      } else if (hitStop > 0) {
        hitStop -= frameDt
      } else {
        acc += frameDt
        let steps = 0
        while (acc >= CONFIG.dt && steps < CONFIG.maxStepsPerFrame && !isOver()) {
          intents.clear()
          const player = world.bodies[0]
          if (!player.alive && ctl) {
            // Drain presses queued while dead so they cannot fire on respawn.
            ctl.read(renderer.playerScreen())
          }
          if (player.alive) {
            intents.set(
              "player",
              demo || (debug && debug.autopilot) || !ctl
                ? botIntent(world, autopilotBrain)
                : ctl.read(renderer.playerScreen()),
            )
          }
          for (const b of world.bodies) {
            if (b.kind !== "bot" || !b.alive) continue
            let brain = brains.get(b.id)
            if (!brain) {
              // A bot that joined (Endless) or whose slot was reused gets its own brain at its skill.
              brain = createBotBrain(b.id, b.skill ?? difficulty, brainSeed + ++joins)
              brains.set(b.id, brain)
            }
            intents.set(b.id, botIntent(world, brain))
          }
          step(world, intents)
          renderer.onEvents(world, world.events)
          const prof = propsRef.current.profile
          if (!demo && prof) {
            const got = trackStep(prof, tracker, world, world.events, Date.now())
            if (got.length > 0) {
              roundUnlocked.push(...got)
              saveProfile(store(), prof)
              propsRef.current.sfx.ui("achievement")
              propsRef.current.onUnlock?.(got)
            }
          }
          if (!demo) propsRef.current.sfx.onEvents(world, world.events)
          for (const ev of world.events) {
            if (ev.type === "join" || ev.type === "respawn" || ev.type === "leave") {
              forceHud = true
              if (ev.type === "join" && world.mode === "endless") {
                const jb = world.bodies.find((b) => b.id === ev.bodyId)
                brains.set(ev.bodyId, createBotBrain(ev.bodyId, jb?.skill ?? ev.skill, brainSeed + ++joins))
                // Drop brains of bodies that no longer exist (slots reused by new ids).
                if (brains.size > world.bodies.length) {
                  for (const id of Array.from(brains.keys())) {
                    if (!world.bodies.some((b) => b.id === id)) brains.delete(id)
                  }
                }
              }
            } else if (ev.type === "death" && ev.bodyId === "player" && world.mode === "endless") {
              propsRef.current.onDeath?.(deathText(world, ev.cause))
              forceHud = true
            }
            if (ev.type === "phase") forceHud = true
            else if (ev.type === "absorb" && (ev.eaterId === "player" || ev.victimId === "player")) {
              hitStop = CONFIG.feel.hitStop
            }
          }
          acc -= CONFIG.dt
          steps++
        }
        // Drop only a real backlog (a stall), not the remainder of a frame that used every step.
        if (steps >= CONFIG.maxStepsPerFrame && acc >= CONFIG.dt) acc = 0
      }
      if (debug) pushSample(debug.perf.stepMs, performance.now() - t0)

      const alpha = Math.min(1, Math.max(0, acc / CONFIG.dt))
      const r0 = debug ? performance.now() : 0
      renderer.render(world, alpha, frameDt)
      if (debug) pushSample(debug.perf.renderMs, performance.now() - r0)
      if (!demo) propsRef.current.sfx.update(world)

      if (forceHud || now - lastHudAt >= HUD_INTERVAL_MS) pushHud(now)

      if (isOver() && !ended) {
        if (overAt < 0) overAt = now
        if (demo && now - overAt >= AFTERMATH_MS) {
          const sd = (Date.now() + Math.floor(Math.random() * 1000003)) % 2147483647
          world = createWorld({ seed: sd, difficulty, arena: pickArena() })
          setupBrains(sd)
          renderer.reset(world)
          acc = 0
          hitStop = 0
          overAt = -1
        } else if (!demo && now - overAt >= AFTERMATH_MS && world.result) {
          ended = true
          ctl?.clear()
          ctl?.setEnabled(false)
          pushHud(now)
          const prof = propsRef.current.profile
          if (prof) {
            const got = finishRound(prof, tracker, world, world.result, Date.now())
            if (got.length > 0) {
              roundUnlocked.push(...got)
              propsRef.current.sfx.ui("achievement")
            }
            saveProfile(store(), prof)
          }
          propsRef.current.onEnd(world.result, world.bodies[0].stats, roundUnlocked)
          running = false
          cancelAnimationFrame(raf)
        }
      }
    }

    const start = () => {
      if (running || ended) return
      running = true
      last = performance.now()
      lastFrameAt = 0
      raf = requestAnimationFrame(frame)
    }

    const setPaused = (p: boolean) => {
      if (p) {
        running = false
        cancelAnimationFrame(raf)
        ctl?.clear()
        ctl?.setEnabled(false)
        renderer.render(world, Math.min(1, Math.max(0, acc / CONFIG.dt)), 0)
        if (!demo) propsRef.current.sfx.suspend()
      } else {
        ctl?.clear()
        ctl?.setEnabled(true)
        if (!demo) propsRef.current.sfx.resume()
        start()
      }
    }
    setPausedRef.current = setPaused

    const autoPause = () => {
      if (demo) return
      ctl?.clear()
      if (!pausedRef.current && !ended && (world.phase === "countdown" || world.phase === "playing")) {
        propsRef.current.onPauseRequest()
      }
    }
    const onBlur = () => autoPause()
    const onVisibility = () => {
      if (document.visibilityState === "hidden") autoPause()
    }
    window.addEventListener("blur", onBlur)
    document.addEventListener("visibilitychange", onVisibility)

    if (!demo) propsRef.current.onHud(hudSnapshot(world))
    if (pausedRef.current) {
      ctl?.setEnabled(false)
      renderer.render(world, 0, 0)
    } else {
      start()
    }

    // Endless has no round end: fold the session into the lifetime stats whenever it may be
    // abandoned (tab hidden, page hidden, quit/restart/unmount). Each fold adds only what changed
    // since the previous one, so repeated folds never double-count and nothing needs re-arming
    // after a bfcache restore.
    let foldSnap: EndlessFold | undefined
    const foldSession = () => {
      const prof = propsRef.current.profile
      if (demo || !prof || world.mode !== "endless") return
      foldSnap = finishEndlessSession(prof, world, tracker, foldSnap)
      saveProfile(store(), prof)
    }
    window.addEventListener("pagehide", foldSession)
    const onHiddenFold = () => {
      if (document.visibilityState === "hidden") foldSession()
    }
    document.addEventListener("visibilitychange", onHiddenFold)

    return () => {
      foldSession()
      window.removeEventListener("pagehide", foldSession)
      document.removeEventListener("visibilitychange", onHiddenFold)
      running = false
      cancelAnimationFrame(raf)
      setPausedRef.current = null
      window.removeEventListener("blur", onBlur)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pointerdown", onTouchPointer, true)
      ro.disconnect()
      ctl?.dispose()
      renderer.dispose()
      setInput(null)
      if (debug && window.__gw === debug) delete window.__gw
    }
  }, [seed, difficulty, arena, mode, sfx, demo])

  useEffect(() => {
    propsRef.current.onInputReady?.(input)
  }, [input])

  useEffect(() => {
    setPausedRef.current?.(paused)
  }, [paused])

  return (
    <div ref={stageRef} className="gw-stage">
      <canvas ref={canvasRef} className="gw-canvas" role="img" aria-label="Gravity Wars arena" />
      {!demo && !props.hideTouch && layout === "touch" && input && <TouchControls input={input} hud={props.hud ?? null} onGesture={props.onGesture} />}
    </div>
  )
}
