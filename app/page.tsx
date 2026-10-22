"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createSfx, type Sfx } from "@/game/audio"
import type { BodyStats, Difficulty, HudSnapshot, RoundResult } from "@/game/types"
import { GameView } from "./components/GameView"
import { Hud } from "./components/Hud"
import { EndScreen, MenuScreen, PauseScreen, saveBest } from "./components/Screens"

type Screen = "menu" | "playing" | "paused" | "over"

const MUTE_KEY = "gw:muted"

function noop() {}

function newSeed(): number {
  return (Date.now() + Math.floor(Math.random() * 1000003)) % 2147483647
}

export default function Page() {
  const [screen, setScreen] = useState<Screen>("menu")
  const [difficulty, setDifficulty] = useState<Difficulty>("normal")
  const [seed, setSeed] = useState(1)
  const [muted, setMuted] = useState(false)
  const [outcome, setOutcome] = useState<{ result: RoundResult; stats: BodyStats } | null>(null)
  const [hud, setHud] = useState<HudSnapshot | null>(null)
  const [layout, setLayout] = useState<"desktop" | "touch">("desktop")
  const [demoSeed, setDemoSeed] = useState(7)
  const [sfx, setSfx] = useState<Sfx | null>(null)

  const sfxRef = useRef<Sfx | null>(null)
  const state = useRef({ screen, difficulty, muted })
  state.current = { screen, difficulty, muted }

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
    } catch {
      // Storage blocked: stay unmuted.
    }
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

  const play = useCallback(() => {
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

  const handleEnd = useCallback((result: RoundResult, stats: BodyStats) => {
    saveBest(state.current.difficulty, result.playerWon, stats.peakMass)
    setOutcome({ result, stats })
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
      if (s === "menu") {
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
          onGesture={noop}
          onLayout={noop}
        />
      )}
      {screen !== "menu" && sfx && (
        <GameView
          difficulty={difficulty}
          seed={seed}
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
        <Hud inert={screen === "paused"} hud={hud} muted={muted} onPause={pauseNow} onToggleMute={toggleMute} />
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
        />
      )}
      {screen === "paused" && <PauseScreen onResume={resume} onRestart={play} onQuit={toMenu} />}
      {screen === "over" && outcome && (
        <EndScreen result={outcome.result} stats={outcome.stats} onPlayAgain={play} onQuit={toMenu} />
      )}
    </div>
  )
}
