"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { emptyProfile, loadProfile, type AchievementDef } from "@/game/achievements"
import { ARENA_IDS } from "@/game/arenas"
import { createSfx, type Sfx } from "@/game/audio"
import type { InputController } from "@/game/input"
import type { ArenaId, BodyStats, Difficulty, GameMode, HudSnapshot, RoundResult } from "@/game/types"
import { GameView } from "./components/GameView"
import { Hud } from "./components/Hud"
import { ProfilePanel } from "./components/Profile"
import { ARENA_CHOICES, EndScreen, MenuScreen, PauseScreen, saveBest, type ArenaChoice } from "./components/Screens"
import { Toasts, type ToastItem } from "./components/Toasts"

type Screen = "menu" | "playing" | "paused" | "over"

const MUTE_KEY = "gw:muted"
const ARENA_KEY = "gw:arena"
const MODE_KEY = "gw:mode"
const TOAST_MS = 3500

function noop() {}

function newSeed(): number {
  return (Date.now() + Math.floor(Math.random() * 1000003)) % 2147483647
}

export default function Page() {
  const [screen, setScreen] = useState<Screen>("menu")
  const [difficulty, setDifficulty] = useState<Difficulty>("normal")
  const [seed, setSeed] = useState(1)
  const [muted, setMuted] = useState(false)
  const [arena, setArena] = useState<ArenaChoice>("random")
  const [roundArena, setRoundArena] = useState<ArenaId>("classic")
  const [mode, setMode] = useState<GameMode>("endless")
  const [roundMode, setRoundMode] = useState<GameMode>("endless")
  const [deathText, setDeathText] = useState("")
  const [profileTick, setProfileTick] = useState(0)
  const [showProfile, setShowProfile] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [outcome, setOutcome] = useState<{ result: RoundResult; stats: BodyStats; unlocked: AchievementDef[] } | null>(null)
  const [hud, setHud] = useState<HudSnapshot | null>(null)
  const [layout, setLayout] = useState<"desktop" | "touch">("desktop")
  const [demoSeed, setDemoSeed] = useState(7)
  const [sfx, setSfx] = useState<Sfx | null>(null)

  const sfxRef = useRef<Sfx | null>(null)
  const inputRef = useRef<InputController | null>(null)
  const profileRef = useRef(emptyProfile())
  const toastKey = useRef(0)
  const topRef = useRef<boolean | null>(null)
  const lastLeadToast = useRef(0)
  const state = useRef({ screen, difficulty, muted, arena, showProfile, mode, roundMode })
  state.current = { screen, difficulty, muted, arena, showProfile, mode, roundMode }

  useEffect(() => setDemoSeed(newSeed()), [])

  // Sound engine, created on the client only.
  useEffect(() => {
    const s = createSfx()
    sfxRef.current = s
    setSfx(s)
    return () => {
      s.dispose()
      sfxRef.current = null
    }
  }, [])

  // Restore persisted mute and detect a touch-first device.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(MUTE_KEY) === "1") setMuted(true)
      const a = window.localStorage.getItem(ARENA_KEY)
      if (a && (ARENA_CHOICES as string[]).includes(a)) setArena(a as ArenaChoice)
      const m = window.localStorage.getItem(MODE_KEY)
      if (m === "round" || m === "endless") setMode(m)
    } catch {
      // Storage blocked: stay unmuted, default arena.
    }
    let stored: Storage | null = null
    try {
      stored = window.localStorage
    } catch {
      stored = null
    }
    Object.assign(profileRef.current, loadProfile(stored))
    setProfileTick((n) => n + 1)
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) setLayout("touch")
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType === "touch") setLayout("touch")
    }
    window.addEventListener("pointerdown", onPointer, true)
    return () => window.removeEventListener("pointerdown", onPointer, true)
  }, [])

  useEffect(() => {
    sfx?.setMuted(muted)
  }, [sfx, muted])

  const unlock = useCallback(() => sfxRef.current?.unlock(), [])

  const toggleMute = useCallback(() => {
    const next = !state.current.muted
    setMuted(next)
    try {
      window.localStorage.setItem(MUTE_KEY, next ? "1" : "0")
    } catch {
      // Not persisted; still applies for this session.
    }
  }, [])

  const chooseArena = useCallback((a: ArenaChoice) => {
    sfxRef.current?.ui("click")
    setArena(a)
    try {
      window.localStorage.setItem(ARENA_KEY, a)
    } catch {
      // Not persisted.
    }
  }, [])

  const chooseMode = useCallback((m: GameMode) => {
    sfxRef.current?.ui("click")
    setMode(m)
    try {
      window.localStorage.setItem(MODE_KEY, m)
    } catch {
      // Not persisted.
    }
  }, [])

  const onUnlock = useCallback((defs: AchievementDef[]) => {
    const items = defs.map((def) => ({ key: ++toastKey.current, def }))
    setToasts((t) => [...t, ...items])
    window.setTimeout(() => setToasts((t) => t.filter((x) => !items.some((i) => i.key === x.key))), TOAST_MS)
  }, [])

  // Endless: toast once each time the player takes the lead (the first reading is only a baseline).
  useEffect(() => {
    if (!hud || hud.mode !== "endless" || hud.phase !== "playing" || hud.endless === null || hud.endless.respawnIn > 0) return
    const first = hud.leaderboard[0]?.isPlayer === true
    if (topRef.current === false && first && Date.now() - lastLeadToast.current > 10000) {
      lastLeadToast.current = Date.now()
      onUnlock([{ id: "lead", name: "You're #1", description: "Top of the leaderboard." }])
    }
    topRef.current = first
  }, [hud, onUnlock])

  const play = useCallback(() => {
    const choice = state.current.arena
    setRoundMode(state.current.mode)
    setDeathText("")
    topRef.current = null
    setRoundArena(choice === "random" ? ARENA_IDS[Math.floor(Math.random() * ARENA_IDS.length)] : choice)
    setToasts([])
    sfxRef.current?.unlock()
    sfxRef.current?.ui("start")
    setHud(null)
    setOutcome(null)
    setSeed(newSeed())
    setScreen("playing")
  }, [])

  const toMenu = useCallback(() => {
    sfxRef.current?.ui("click")
    setHud(null)
    setToasts([])
    setScreen("menu")
  }, [])

  const requestPause = useCallback(() => {
    setScreen((s) => (s === "playing" ? "paused" : s))
  }, [])

  const pauseNow = useCallback(() => {
    sfxRef.current?.ui("pause")
    requestPause()
  }, [requestPause])

  const resume = useCallback(() => {
    sfxRef.current?.ui("click")
    setScreen((s) => (s === "paused" ? "playing" : s))
  }, [])

  const handleEnd = useCallback((result: RoundResult, stats: BodyStats, unlocked: AchievementDef[]) => {
    saveBest(state.current.difficulty, result.playerWon, stats.peakMass)
    setOutcome({ result, stats, unlocked })
    setScreen("over")
  }, [])

  // Keyboard for menu / pause / end screens. (Esc to pause while playing is handled by input.ts.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (state.current.screen !== "paused") sfxRef.current?.unlock()
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
      const s = state.current.screen
      const onControl = t instanceof Element && t.closest("button, a, input, select, textarea") !== null
      const handle = (fn: () => void) => {
        e.preventDefault()
        fn()
      }
      if (e.code === "KeyM") return handle(toggleMute)
      if (s === "menu" && state.current.showProfile) {
        if (e.code === "Escape") handle(() => setShowProfile(false))
      } else if (s === "menu") {
        if ((e.code === "Enter" || e.code === "NumpadEnter") && !onControl) handle(play)
      } else if (s === "over") {
        if (((e.code === "Enter" || e.code === "NumpadEnter") && !onControl) || e.code === "KeyR") handle(play)
        else if (e.code === "KeyQ") handle(toMenu)
      } else if (s === "paused") {
        if (e.code === "Escape" || e.code === "KeyP") handle(resume)
        else if (e.code === "KeyR") handle(play)
        else if (e.code === "KeyQ") handle(toMenu)
      }
    }
    const onPointer = () => {
      if (state.current.screen !== "paused") sfxRef.current?.unlock()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onPointer, true)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onPointer, true)
    }
  }, [play, toMenu, resume, toggleMute])

  return (
    <div className="gw-root">
      {screen === "menu" && sfx && (
        <GameView
          demo
          difficulty="normal"
          seed={demoSeed}
          paused={false}
          sfx={sfx}
          onHud={noop}
          onEnd={noop}
          onPauseRequest={noop}
          arena="classic"
          onGesture={noop}
          onLayout={noop}
        />
      )}
      {screen !== "menu" && sfx && (
        <GameView
          difficulty={difficulty}
          seed={seed}
          arena={roundArena}
          mode={roundMode}
          onDeath={setDeathText}
          profile={profileRef.current}
          onUnlock={onUnlock}
          onInputReady={(c) => {
            inputRef.current = c
          }}
          hud={hud}
          paused={screen === "paused"}
          initialLayout={layout}
          hideTouch={screen !== "playing"}
          sfx={sfx}
          onHud={setHud}
          onEnd={handleEnd}
          onPauseRequest={requestPause}
          onGesture={unlock}
          onLayout={setLayout}
        />
      )}
      {(screen === "playing" || screen === "paused") && (
        <Hud
          inert={screen === "paused"}
          hud={hud}
          muted={muted}
          layout={layout}
          deathText={deathText}
          onPress={(k) => inputRef.current?.press(k)}
          onPause={pauseNow}
          onToggleMute={toggleMute}
        />
      )}
      {screen === "menu" && (
        <MenuScreen
          difficulty={difficulty}
          onDifficulty={(d) => {
            sfxRef.current?.ui("click")
            setDifficulty(d)
          }}
          onPlay={play}
          muted={muted}
          onToggleMute={toggleMute}
          layout={layout}
          arena={arena}
          mode={mode}
          onMode={chooseMode}
          active={!showProfile}
          endlessBest={Math.round(profileRef.current.stats.endlessBest) + profileTick * 0}
          onArena={chooseArena}
          onStats={() => setShowProfile(true)}
        />
      )}
      {screen === "menu" && showProfile && (
        <ProfilePanel profile={profileRef.current} onClose={() => setShowProfile(false)} />
      )}
      {screen !== "menu" && <Toasts items={toasts} layout={layout} />}
      {screen === "paused" && <PauseScreen onResume={resume} onRestart={play} onQuit={toMenu} />}
      {screen === "over" && outcome && (
        <EndScreen result={outcome.result} stats={outcome.stats} onPlayAgain={play} onQuit={toMenu} unlocked={outcome.unlocked} />
      )}
    </div>
  )
}
