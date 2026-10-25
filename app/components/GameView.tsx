"use client"

import { useEffect, useRef, useState } from "react"
import { createBotBrain, botIntent, type BotBrain } from "@/game/bots"
import {
  applyCampaignLevel,
  bossDefeated,
  bossHud,
  bossIntent,
  damageBoss,
  repulseDamageAgainst,
  updateBoss,
  type BossHud,
  type EncounterState,
} from "@/game/boss"
import {
  RELIC_PICKUP_RADIUS,
  goalProgressReached,
  relicPoint,
  type AbilityId,
  type CampaignLevel,
  type RelicHazard,
} from "@/game/campaign"
import { ARENA_IDS } from "@/game/arenas"
import { finishEndlessSession, type EndlessFold, finishRound, newTracker, saveProfile, trackStep, type AchievementDef, type Profile } from "@/game/achievements"
import { CONFIG } from "@/game/config"
import { createWorld, hudSnapshot, repulseRadius, step } from "@/game/engine"
import { feedLines, mergeFeed, type FeedItem, type FeedView } from "@/game/feed"
import { createInput, type InputController } from "@/game/input"
import { createRenderer, type RenderFrame, type RenderView } from "@/game/render"
import type { Sfx } from "@/game/audio"
import { deathLine } from "./Screens"
import { firstDeathTip, ultHintDue, ultHintNotice } from "./hudView"
import { roundCriticalMass } from "@/app/roundSetup"
import type { ArenaId, BodyStats, DeathCause, Difficulty, GameMode, Intent, RoundResult, World } from "@/game/types"
import { TouchControls } from "./TouchControls"

interface GwDebug {
  world: () => World | null
  /** Campaign/QA: where the hidden relic is and whether it has been recovered. */
  relic: () => { x: number; y: number; collected: boolean } | null
  /** Campaign/QA: the encounter (boss state machine) for scripted boss checks. */
  encounter: () => EncounterState | null
  autopilot: boolean
  audioState: () => string
  perf: { frameMs: number[]; stepMs: number[]; renderMs: number[] }
}

declare global {
  interface Window {
    __gw?: GwDebug
  }
}

/** Extra facts a campaign run contributes to the end screen. */
export interface RunFacts {
  relicCollected: boolean
  bossDefeated: boolean
}

/** A one-off announcement from inside the round (boss split, relic, boss down). */
export interface Notice {
  kicker: string
  name: string
  description?: string
}

export interface GameViewProps {
  difficulty: Difficulty
  seed: number
  arena: ArenaId
  /** Defaults to "round". Endless never ends: no onEnd; the session folds into the profile on unmount. */
  mode?: GameMode
  paused: boolean
  sfx: Sfx
  onHud(h: FeedView): void
  /** `unlocked` = every achievement earned this round (mid-round and round-end). */
  onEnd(r: RoundResult, playerStats: BodyStats, unlocked: AchievementDef[], facts: RunFacts): void
  onPauseRequest(): void
  onGesture(): void
  onLayout(l: "desktop" | "touch"): void
  /** Attract mode: autopilot plays a self-restarting round; no input, sound, HUD or end callbacks. */
  demo?: boolean
  /** Layout known by the page (covers hybrid devices that have already seen touch). */
  initialLayout?: "desktop" | "touch"
  /** Endless: the player died; `text` is the death line for the respawn overlay, `tip` the one
   * teaching line for the first death of the round (empty afterwards). */
  onDeath?(text: string, tip: string): void
  /** Lifetime profile, mutated in place by achievement tracking (never in demo mode). */
  profile?: Profile
  /** Achievements unlocked mid-round, for toasts. */
  onUnlock?(defs: AchievementDef[]): void
  /** The live input controller (null in demo / before mount), so the HUD can press abilities. */
  onInputReady?(ctl: InputController | null): void
  /** Latest HUD snapshot, used for the touch buttons' cooldown and charge rings. */
  hud?: FeedView | null
  /** Hide the on-screen touch controls (paused / round over). */
  hideTouch?: boolean
  /** Bumped by the shell on every new round, so restarting the same level rebuilds the world. */
  runId?: number
  /** Campaign level being played (fixed seed, time limit, goal, encounter), or null. */
  level?: CampaignLevel | null
  /** Campaign abilities not unlocked by stars yet: presses are dropped and the HUD shows them locked. */
  lockedAbilities?: readonly AbilityId[]
  /** Cosmetic body colour (unlocked skin), or undefined for the default. */
  playerColor?: string
  /** The boss bar state; called with null when the encounter has no boss or the boss is dead. */
  onBoss?(b: BossHud | null): void
  /** In-round announcements (boss splits, boss down, relic recovered). */
  onNotice?(n: Notice): void
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
  const runId = props.runId ?? 0
  const demo = props.demo === true
  const difficulty: Difficulty = demo ? "normal" : props.difficulty
  const mode: GameMode = demo ? "round" : props.mode ?? "round"
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
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
    const overlay = overlayRef.current
    if (!stage || !canvas || !overlay) return
    // Local non-null aliases so the long-lived closures keep the narrowed type.
    const ov: HTMLCanvasElement = overlay

    const mq = (q: string) => (typeof window.matchMedia === "function" ? window.matchMedia(q).matches : false)
    let touchSeen = false
    let curLayout: "desktop" | "touch" = propsRef.current.initialLayout === "touch" || mq("(pointer: coarse)") ? "touch" : "desktop"
    setLayout(curLayout)
    propsRef.current.onLayout(curLayout)

    const level = props.level ?? null
    const locked: readonly AbilityId[] = props.lockedAbilities ?? []
    const pickArena = (): ArenaId => (demo ? ARENA_IDS[Math.floor(Math.random() * ARENA_IDS.length)] : level ? level.arena : arena)
    let world: World = createWorld({
      seed,
      difficulty,
      arena: pickArena(),
      mode,
      botCount: level ? level.bots : undefined,
      // The mass race is on for Round, Endless and the critical-mass level; a campaign level with
      // its own goal turns it off. See app/roundSetup.ts.
      criticalMass: roundCriticalMass(level),
    })
    let goalReached = false
    // Unready-Singularity feedback: the last time one was announced, and the minimum gap between
    // announcements (a mash gets one answer per gap, not one per press).
    let lastUltHint = -1e9
    // The respawn teaching line is for the first death of this round only.
    let deathsSeen = 0
    let encounter: EncounterState | null = null
    if (level && !demo) encounter = applyCampaignLevel(world, level)
    const skin = props.playerColor
    if (skin) world.bodies[0].color = skin
    // The level's hidden relic: deterministic for the level, clear of every well and zone.
    let relic: { x: number; y: number } | null = null
    let relicCollected = false
    if (level && !demo) {
      const hazards: RelicHazard[] = []
      for (const w of world.wells) hazards.push({ x: w.x, y: w.y, r: Math.max(w.radius, w.chargeRadius) })
      for (const z of world.zones) hazards.push({ x: z.x, y: z.y, r: z.r })
      relic = relicPoint({ seed: level.seed * 31 + 7, arenaRadius: world.arenaRadius, hazards })
    }
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
        dashLocked: (propsRef.current.lockedAbilities ?? locked).includes("dash"),
        ...(demo ? { demo: true } : {}),
      }
    }

    const renderer = createRenderer(canvas, makeView())
    renderer.reset(world)
    const octx = overlay.getContext("2d")

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
        relic: () => (relic ? { x: relic.x, y: relic.y, collected: relicCollected } : null),
        encounter: () => encounter,
        autopilot: false,
        audioState: () => sfx.state?.() ?? "none",
        perf: { frameMs: [], stepMs: [], renderMs: [] },
      }
      window.__gw = debug
    }

    const doResize = () => {
      const view = makeView()
      renderer.resize(view)
      const dpr = view.dpr
      ov.width = Math.max(1, Math.round(view.width * dpr))
      ov.height = Math.max(1, Math.round(view.height * dpr))
      // resize() clears the canvas; redraw if no loop is running to do it (pause, round end).
      if (!running) {
        renderer.render(world, Math.min(1, Math.max(0, acc / CONFIG.dt)), 0)
        drawOverlay()
      }
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
    let feed: FeedItem[] = []
    let feedNextId = 1
    let lastBossKey = ""
    // One solar-current toast per round, at the first meaningful ride (not on entering the band).
    let solarToastShown = false

    // A function (not an inline comparison) so TypeScript does not narrow world.phase across step().
    const isOver = () => world.phase === "over"

    const pushHud = (now: number) => {
      lastHudAt = now
      if (demo) return
      const snap = hudSnapshot(world) as FeedView
      if (feed.length > 0) snap.feed = feed
      propsRef.current.onHud(snap)
    }

    const notify = (n: Notice) => {
      if (!demo) propsRef.current.onNotice?.(n)
    }

    const publishBoss = () => {
      if (demo) return
      if (!encounter?.boss || encounter.boss.defeated) {
        if (lastBossKey !== "") {
          lastBossKey = ""
          propsRef.current.onBoss?.(null)
        }
        return
      }
      const hud = bossHud(world, encounter.boss)
      if (!hud) {
        if (lastBossKey !== "") {
          lastBossKey = ""
          propsRef.current.onBoss?.(null)
        }
        return
      }
      const key = `${hud.phase}:${hud.special ?? ""}:${Math.round(hud.healthPct * 100)}:${Math.round(hud.t * 4)}`
      if (key !== lastBossKey) {
        lastBossKey = key
        propsRef.current.onBoss?.(hud)
      }
    }

    // ---- overlay canvas: boss telegraphs and the hidden relic marker -------------------------
    function w2s(f: RenderFrame, x: number, y: number): { x: number; y: number } {
      return { x: (x - f.camX) * f.zoom + f.width / 2 + f.shakeX, y: (y - f.camY) * f.zoom + f.height / 2 + f.shakeY }
    }

    function clearOverlay() {
      if (!octx) return
      octx.setTransform(1, 0, 0, 1, 0, 0)
      octx.clearRect(0, 0, ov.width, ov.height)
    }

    function drawOverlay() {
      if (!octx || demo) return
      const f = renderer.frame()
      octx.setTransform(1, 0, 0, 1, 0, 0)
      octx.clearRect(0, 0, ov.width, ov.height)
      octx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0)
      const t = world.time

      // Boss telegraphs.
      const bossState = encounter?.boss
      if (bossState && !bossState.defeated) {
        const body = world.bodies.find((b) => b.id === bossState.id)
        if (body && body.alive) {
          const p = w2s(f, body.x, body.y)
          const r = body.radius * f.zoom
          // Always mark the boss so it reads as the encounter's focus.
          octx.strokeStyle = "rgba(255,123,213,0.5)"
          octx.lineWidth = 2
          octx.beginPath()
          octx.arc(p.x, p.y, r + 10, 0, Math.PI * 2)
          octx.stroke()
          const hud = bossHud(world, bossState)
          if (hud) {
            if (hud.phase === "telegraph") {
              const progress = Math.max(0, Math.min(1, hud.t / Math.max(0.01, hud.total)))
              const pulling = hud.special === "pull"
              const collapsing = hud.special === "ult"
              const dangerR = (CONFIG.pull.baseRadius + body.radius * CONFIG.pull.radiusPerR) * (collapsing ? 2.2 : 1.35)
              const ringR = (0.35 + 0.65 * progress) * dangerR * f.zoom
              const rgb = collapsing ? "201,168,255" : "255,77,109"
              octx.save()
              octx.globalAlpha = 0.18 + progress * 0.22
              octx.fillStyle = `rgba(${rgb},1)`
              octx.beginPath()
              octx.arc(p.x, p.y, ringR, 0, Math.PI * 2)
              octx.fill()
              octx.restore()
              octx.strokeStyle = `rgba(${rgb},0.9)`
              octx.lineWidth = 3
              octx.setLineDash(pulling ? [10, 12] : [])
              octx.beginPath()
              octx.arc(p.x, p.y, ringR, 0, Math.PI * 2)
              octx.stroke()
              octx.setLineDash([])
              if (hud.special === "lunge") {
                const target = w2s(f, world.bodies[0].x, world.bodies[0].y)
                const dx = target.x - p.x
                const dy = target.y - p.y
                const d = Math.hypot(dx, dy) || 1
                octx.strokeStyle = "rgba(255,77,109,0.85)"
                octx.lineWidth = 3
                octx.setLineDash([14, 10])
                octx.beginPath()
                octx.moveTo(p.x, p.y)
                octx.lineTo(p.x + (dx / d) * Math.min(d, 900), p.y + (dy / d) * Math.min(d, 900))
                octx.stroke()
                octx.setLineDash([])
              }
            } else if (hud.phase === "attack" && hud.special === "pull") {
              const r2 = (p.x - p.x) * 0 // keep the shape identical; pulse the ring inward
              void r2
              octx.strokeStyle = "rgba(255,77,109,0.7)"
              octx.lineWidth = 4
              octx.beginPath()
              octx.arc(p.x, p.y, (CONFIG.pull.baseRadius + body.radius * CONFIG.pull.radiusPerR) * f.zoom, 0, Math.PI * 2)
              octx.stroke()
            } else if (hud.phase === "attack" && hud.special === "ult") {
              octx.fillStyle = "rgba(30,0,60,0.35)"
              octx.beginPath()
              octx.arc(p.x, p.y, 160 * f.zoom, 0, Math.PI * 2)
              octx.fill()
            }
          }
        }
      }

      // The hidden relic: a slow-turning diamond with a halo, plus an edge chevron when off screen.
      if (relic && !relicCollected) {
        const p = w2s(f, relic.x, relic.y)
        const margin = 46
        // On phones the top strip is a stacked HUD; keep the off-screen chevron below it.
        const topMargin = f.width < 560 ? 190 : margin
        const onScreen = p.x > margin && p.x < f.width - margin && p.y > topMargin && p.y < f.height - margin
        const pulse = mq("(prefers-reduced-motion: reduce)") ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.2)
        if (onScreen) {
          const size = 9 + pulse * 3
          octx.save()
          octx.translate(p.x, p.y)
          octx.rotate(t * 0.8)
          const halo = octx.createRadialGradient(0, 0, 0, 0, 0, size * 3.2)
          halo.addColorStop(0, "rgba(255,224,130,0.55)")
          halo.addColorStop(1, "rgba(255,224,130,0)")
          octx.fillStyle = halo
          octx.beginPath()
          octx.arc(0, 0, size * 3.2, 0, Math.PI * 2)
          octx.fill()
          octx.fillStyle = `rgba(255,236,170,${0.55 + 0.35 * pulse})`
          octx.beginPath()
          octx.moveTo(0, -size)
          octx.lineTo(size, 0)
          octx.lineTo(0, size)
          octx.lineTo(-size, 0)
          octx.closePath()
          octx.fill()
          octx.restore()
        } else {
          const cx = Math.max(margin, Math.min(f.width - margin, p.x))
          const cy = Math.max(topMargin, Math.min(f.height - margin, p.y))
          const dx = p.x - cx
          const dy = p.y - cy
          const d = Math.hypot(dx, dy) || 1
          octx.save()
          octx.translate(cx, cy)
          octx.rotate(Math.atan2(dy, dx))
          octx.fillStyle = "rgba(255,224,130,0.7)"
          octx.beginPath()
          octx.moveTo(14, 0)
          octx.lineTo(-8, 8)
          octx.lineTo(-8, -8)
          octx.closePath()
          octx.fill()
          octx.restore()
          const worldDist = Math.round(Math.hypot(world.bodies[0].x - relic.x, world.bodies[0].y - relic.y))
          // ds-allow-hardcode: canvas 2D has no CSS token pipeline; matches the HUD's system font.
          octx.font = "700 11px system-ui, -apple-system, sans-serif"
          octx.fillStyle = "rgba(255,236,170,0.85)"
          octx.textAlign = "center"
          octx.textBaseline = "middle"
          octx.fillText(`RELIC ${worldDist}`, cx, cy + 20)
        }
      }
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
            const raw: Intent =
              demo || (debug && debug.autopilot) || !ctl ? botIntent(world, autopilotBrain) : ctl.read(renderer.playerScreen())
            if (locked.length > 0) {
              // Campaign progression: an ability that has not been earned is not a press.
              if (locked.indexOf("dash") >= 0) raw.dash = false
              if (locked.indexOf("repulse") >= 0) raw.repulse = false
              if (locked.indexOf("ult") >= 0) raw.ult = false
            }
            // An unready Singularity used to swallow the press silently, which reads as a broken
            // button. Answer it once with the charge, at most every few seconds: a press is
            // immediate feedback, the rate limit keeps a mash from stacking toasts.
            if (ultHintDue(raw.ult === true, player.ult, now, lastUltHint) && !demo) {
              lastUltHint = now
              notify(ultHintNotice(player.ult))
            }
            intents.set("player", raw)
          }
          // The boss runs on the same Intent seam as every other body; its state machine lives in
          // boss.ts, outside the fixed step, so the engine stays untouched and deterministic.
          const bossState = encounter?.boss
          if (bossState && !bossState.defeated) {
            intents.set(bossState.id, bossIntent(world, bossState))
          }
          for (const b of world.bodies) {
            if (b.kind !== "bot" || !b.alive) continue
            if (bossState && b.id === bossState.id) continue
            let brain = brains.get(b.id)
            if (!brain) {
              // A bot that joined (Endless), a boss fragment or a reused slot gets its own brain.
              brain = createBotBrain(b.id, b.skill ?? difficulty, brainSeed + ++joins)
              brains.set(b.id, brain)
            }
            intents.set(b.id, botIntent(world, brain))
          }
          step(world, intents)
          renderer.onEvents(world, world.events)
          if (!solarToastShown && world.arena === "vast" && player.alive && player.sail >= 0.5) {
            solarToastShown = true
            notify({
              kicker: "Solar current",
              name: "Riding the current",
              description: "Your speed cap rises while you hold the arc. It fades outside.",
            })
          }
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

          // Activity feed: the arena keeps happening even when the player is not the story.
          if (world.events.length > 0) {
            const lines = feedLines(world, world.events, feedNextId)
            feedNextId = lines.nextId
            if (lines.items.length > 0) {
              feed = mergeFeed(feed, lines.items, world.time)
              forceHud = true
            }
          }
          // Boss maintenance: the split, the death, the HUD bar.
          if (encounter) {
            const bossEvents = updateBoss(world, encounter)
            for (const ev of bossEvents) {
              if (ev.type === "split") {
                propsRef.current.sfx.ui("boss")
                notify({
                  kicker: "Boss",
                  name: `${encounter.boss?.name ?? "The boss"} splits`,
                  description: `${ev.fragments ?? 2} fragments break away. Kill them all.`,
                })
              } else if (ev.type === "defeated") {
                propsRef.current.sfx.ui("achievement")
                notify({ kicker: "Boss", name: `${encounter.boss?.name ?? "The boss"} is dead`, description: "Clean up what is left." })
              }
            }
            publishBoss()
          }
          // A campaign goal that is "get to X" ends the level the moment it is met: the level's
          // goal is the level. timer goals (survive / time up) still run their clock out.
          if (level && !goalReached && world.phase === "playing") {
            const pl = world.bodies[0]
            goalReached = goalProgressReached(level, {
              alive: pl.alive,
              mass: pl.mass,
              rivalsAbsorbed: pl.stats.rivalsAbsorbed,
              slingshots: pl.stats.slingshots,
              relicCollected,
            })
            if (goalReached) world.timeLeft = Math.min(world.timeLeft, CONFIG.dt * 0.5)
          }
          // The hidden relic is recovered by flying into it.
          if (relic && !relicCollected) {
            const p = world.bodies[0]
            if (p.alive && Math.hypot(p.x - relic.x, p.y - relic.y) < RELIC_PICKUP_RADIUS + p.radius) {
              relicCollected = true
              if (level?.goal.kind === "relic") goalReached = true
              if (level?.goal.kind === "relic") world.timeLeft = Math.min(world.timeLeft, CONFIG.dt * 0.5)
              propsRef.current.sfx.ui("relic")
              notify({
                kicker: "Relic recovered",
                name: level?.name ?? "The Long Fall",
                description: "A fragment of the old signal. Three stars need it.",
              })
            }
          }
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
              // The tip rides along with the first death only: the overlay already appears every
              // respawn, and a teaching line that repeats on every death becomes noise.
              const tip = firstDeathTip(deathsSeen, ev.cause)
              deathsSeen++
              propsRef.current.onDeath?.(deathText(world, ev.cause), tip)
              forceHud = true
            }
            if (ev.type === "phase") forceHud = true
            else if (ev.type === "absorb" && (ev.eaterId === "player" || ev.victimId === "player")) {
              hitStop = CONFIG.feel.hitStop
            } else if (ev.type === "repulse" && ev.bodyId === "player" && encounter?.boss && !encounter.boss.defeated) {
              // The player's shockwave is the one attack that chips the boss: walk it down to the
              // Leviathan's split threshold (or the Void King's floor) without waiting to out-grow it.
              const bossBody = world.bodies.find((b) => b.id === encounter!.boss!.id)
              const pl = world.bodies[0]
              if (bossBody && bossBody.alive && pl.alive) {
                const d = Math.hypot(pl.x - bossBody.x, pl.y - bossBody.y)
                if (d <= repulseRadius(pl) + bossBody.radius) {
                  if (damageBoss(world, encounter, repulseDamageAgainst(encounter.boss)) > 0) {
                    hitStop = CONFIG.feel.hitStop
                    publishBoss()
                    forceHud = true
                  }
                }
              }
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
      drawOverlay()
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
          feed = []
          acc = 0
          hitStop = 0
          overAt = -1
        } else if (!demo && now - overAt >= AFTERMATH_MS && world.result) {
          ended = true
          ctl?.clear()
          ctl?.setEnabled(false)
          feed = []
          clearOverlay()
          propsRef.current.onBoss?.(null)
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
          const facts: RunFacts = { relicCollected, bossDefeated: bossDefeated(world, encounter) }
          propsRef.current.onEnd(world.result, world.bodies[0].stats, roundUnlocked, facts)
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
        drawOverlay()
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

    if (!demo) propsRef.current.onHud(hudSnapshot(world) as FeedView)
    doResize()
    if (pausedRef.current) {
      ctl?.setEnabled(false)
      renderer.render(world, 0, 0)
      drawOverlay()
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
      propsRef.current.onBoss?.(null)
      if (debug && window.__gw === debug) delete window.__gw
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, seed, difficulty, arena, mode, sfx, demo, props.level?.id, props.playerColor])

  useEffect(() => {
    propsRef.current.onInputReady?.(input)
  }, [input])

  useEffect(() => {
    setPausedRef.current?.(paused)
  }, [paused])

  return (
    <div ref={stageRef} className="gw-stage">
      <canvas ref={canvasRef} className="gw-canvas" role="img" aria-label="Gravity Wars arena" />
      <canvas ref={overlayRef} className="gw-overlay-canvas" aria-hidden="true" />
      {!demo && !props.hideTouch && layout === "touch" && input && (
        <TouchControls
          input={input}
          hud={props.hud ?? null}
          onGesture={props.onGesture}
          lockedAbilities={props.lockedAbilities}
        />
      )}
    </div>
  )
}
