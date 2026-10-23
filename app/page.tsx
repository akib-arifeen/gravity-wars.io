"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { emptyProfile, loadProfile, type AchievementDef } from "@/game/achievements"
import { ARENA_IDS } from "@/game/arenas"
import { createSfx, type Sfx } from "@/game/audio"
import { type BossHud } from "@/game/boss"
import {
  ABILITY_UNLOCKS,
  CAMPAIGN_LEVELS,
  allRelicsFound,
  currentLevel,
  emptyProgress,
  evaluateBonus,
  evaluateGoal,
  loadProgress,
  nextLevel,
  recordRun,
  saveProgress,
  starsFor,
  unlockedAbilities,
  type AbilityId,
  type CampaignLevel,
  type CampaignProgress,
} from "@/game/campaign"
import { dailyChallenge, dailyScore, dailyStreak, emptyDaily, loadDaily, recordDailyRun, saveDaily, type DailyConfig, type DailyProgress } from "@/game/daily"
import { shareCard, shareOrCopy } from "@/game/share"
import { ARENAS } from "@/game/arenas"
import type { InputController } from "@/game/input"
import type { ArenaId, BodyStats, Difficulty, GameMode, HudSnapshot, RoundResult } from "@/game/types"
import { GameView, type Notice, type RunFacts } from "./components/GameView"
import { Hud } from "./components/Hud"
import { ProfilePanel } from "./components/Profile"
import {
  ARENA_CHOICES,
  EndScreen,
  MenuScreen,
  PauseScreen,
  saveBest,
  type ArenaChoice,
  type CampaignOutcome,
  type DailyOutcome,
  type DailyView,
  type MenuMode,
} from "./components/Screens"
import { Toasts, type ToastItem } from "./components/Toasts"

type Screen = "menu" | "playing" | "paused" | "over"

/** What kind of round is running, which decides the end-screen context. */
type RunKind = "endless" | "round" | "campaign" | "daily"

interface Outcome {
  result: RoundResult
  stats: BodyStats
  unlocked: AchievementDef[]
  campaign: CampaignOutcome | null
  daily: DailyOutcome | null
}

const MUTE_KEY = "gw:muted"
const ARENA_KEY = "gw:arena"
const MODE_KEY = "gw:mode"
const TOAST_MS = 3500
/** The cosmetic reward for recovering every hidden relic. */
// ds-allow-hardcode: player body colour is game data, not a UI theme token.
const SKIN_COLOR = "#e0b3ff"
const SKIN_NAME = "Voidtouched"

function noop() {}

function newSeed(): number {
  return (Date.now() + Math.floor(Math.random() * 1000003)) % 2147483647
}

export default function Page() {
  const [screen, setScreen] = useState<Screen>("menu")
  const [difficulty, setDifficulty] = useState<Difficulty>("normal")
  const [seed, setSeed] = useState(1)
  const [runId, setRunId] = useState(0)
  const [muted, setMuted] = useState(false)
  const [arena, setArena] = useState<ArenaChoice>("random")
  const [roundArena, setRoundArena] = useState<ArenaId>("classic")
  const [mode, setMode] = useState<MenuMode>("endless")
  const [roundMode, setRoundMode] = useState<GameMode>("endless")
  const [roundDifficulty, setRoundDifficulty] = useState<Difficulty>("normal")
  const [runKind, setRunKind] = useState<RunKind>("endless")
  const [campaignLevel, setCampaignLevel] = useState<CampaignLevel>(CAMPAIGN_LEVELS[0])
  const [roundLevel, setRoundLevel] = useState<CampaignLevel | null>(null)
  const [roundLocked, setRoundLocked] = useState<AbilityId[]>([])
  const [campaignProgress, setCampaignProgress] = useState<CampaignProgress>(emptyProgress())
  const [dailyProgress, setDailyProgress] = useState<DailyProgress>(emptyDaily())
  const [dailyConfig, setDailyConfig] = useState<DailyConfig | null>(null)
  const [boss, setBoss] = useState<BossHud | null>(null)
  const [deathText, setDeathText] = useState("")
  const [profileTick, setProfileTick] = useState(0)
  const [showProfile, setShowProfile] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [hud, setHud] = useState<HudSnapshot | null>(null)
  const [layout, setLayout] = useState<"desktop" | "touch">("desktop")
  const [demoSeed, setDemoSeed] = useState(7)
  const [sfx, setSfx] = useState<Sfx | null>(null)

  const sfxRef = useRef<Sfx | null>(null)
  const inputRef = useRef<InputController | null>(null)
  const profileRef = useRef(emptyProfile())
  const storageRef = useRef<Storage | null>(null)
  const toastKey = useRef(0)
  const topRef = useRef<boolean | null>(null)
  const lastLeadToast = useRef(0)
  const state = useRef({
    screen,
    difficulty,
    muted,
    arena,
    showProfile,
    mode,
    roundMode,
    roundDifficulty,
    runKind,
    campaignLevel,
    roundLevel,
    campaignProgress,
    dailyProgress,
    dailyConfig,
    outcome,
  })
  state.current = {
    screen,
    difficulty,
    muted,
    arena,
    showProfile,
    mode,
    roundMode,
    roundDifficulty,
    runKind,
    campaignLevel,
    roundLevel,
    campaignProgress,
    dailyProgress,
    dailyConfig,
    outcome,
  }

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
      if (m === "round" || m === "endless" || m === "campaign" || m === "daily") setMode(m)
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
    storageRef.current = stored
    const progress = loadProgress(stored)
    setCampaignProgress(progress)
    const first = currentLevel(progress)
    setCampaignLevel(first)
    setDailyProgress(loadDaily(stored))
    setDailyConfig(dailyChallenge(new Date()))
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

  const chooseMode = useCallback((m: MenuMode) => {
    sfxRef.current?.ui("click")
    setMode(m)
    try {
      window.localStorage.setItem(MODE_KEY, m)
    } catch {
      // Not persisted.
    }
  }, [])

  /** Add one toast for `def`, with a kicker line (achievements use theirs by default). */
  const pushToast = useCallback((kicker: string, def: AchievementDef) => {
    const item = { key: ++toastKey.current, kicker, def }
    setToasts((t) => [...t, item])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.key !== item.key)), TOAST_MS)
  }, [])

  const onUnlock = useCallback(
    (defs: AchievementDef[]) => {
      for (const def of defs) pushToast("Achievement unlocked", def)
    },
    [pushToast],
  )

  const onNotice = useCallback(
    (n: Notice) => {
      pushToast(n.kicker, { id: `notice-${toastKey.current}`, name: n.name, description: n.description ?? "" })
    },
    [pushToast],
  )

  // Endless: toast once each time the player takes the lead (the first reading is only a baseline).
  useEffect(() => {
    if (!hud || hud.mode !== "endless" || hud.phase !== "playing" || hud.endless === null || hud.endless.respawnIn > 0) return
    const first = hud.leaderboard[0]?.isPlayer === true
    if (topRef.current === false && first && Date.now() - lastLeadToast.current > 10000) {
      lastLeadToast.current = Date.now()
      pushToast("Leaderboard", { id: "lead", name: "You're #1", description: "Top of the board. Stay there." })
    }
    topRef.current = first
  }, [hud, pushToast])

  // Start a round with the given engine mode, arena, difficulty and end-screen context.
  const beginRound = useCallback(
    (opts: { mode: GameMode; arena: ArenaId; difficulty: Difficulty; kind: RunKind; seed?: number; level?: CampaignLevel | null }) => {
      const progress = state.current.campaignProgress
      const unlockedNow = unlockedAbilities(progress)
      setRoundMode(opts.mode)
      setRoundArena(opts.arena)
      setRoundDifficulty(opts.difficulty)
      setRunKind(opts.kind)
      setRoundLevel(opts.level ?? null)
      setRoundLocked(
        opts.kind === "campaign" ? ABILITY_UNLOCKS.filter((a) => unlockedNow.indexOf(a.id) < 0).map((a) => a.id) : [],
      )
      setDeathText("")
      topRef.current = null
      setToasts([])
      setBoss(null)
      sfxRef.current?.unlock()
      sfxRef.current?.ui("start")
      setHud(null)
      setOutcome(null)
      setSeed(opts.seed ?? newSeed())
      setRunId((n) => n + 1)
      setScreen("playing")
    },
    [],
  )

  // Play one campaign level and make it the menu's selection.
  const playLevel = useCallback(
    (level: CampaignLevel) => {
      setCampaignLevel(level)
      beginRound({ mode: "round", arena: level.arena, difficulty: level.difficulty, kind: "campaign", seed: level.seed, level })
    },
    [beginRound],
  )

  // Play today's daily challenge: same seed, arena and skill for everyone, all day.
  const playDaily = useCallback(() => {
    const config = state.current.dailyConfig
    if (!config) return
    beginRound({ mode: "round", arena: config.arena, difficulty: config.difficulty, kind: "daily", seed: config.seed })
  }, [beginRound])

  // The menu's Play button: whichever mode is selected.
  const play = useCallback(() => {
    const m = state.current.mode
    if (m === "campaign") {
      playLevel(state.current.campaignLevel)
      return
    }
    if (m === "daily") {
      playDaily()
      return
    }
    const choice = state.current.arena
    beginRound({
      mode: m,
      arena: choice === "random" ? ARENA_IDS[Math.floor(Math.random() * ARENA_IDS.length)] : choice,
      difficulty: state.current.difficulty,
      kind: m,
    })
  }, [beginRound, playDaily, playLevel])

  // The end screen's "play again": replay the same level / daily seed, otherwise a fresh round.
  const playAgain = useCallback(() => {
    const kind = state.current.runKind
    if (kind === "campaign" && state.current.roundLevel) {
      playLevel(state.current.roundLevel)
      return
    }
    if (kind === "daily") {
      playDaily()
      return
    }
    play()
  }, [play, playDaily, playLevel])

  const toMenu = useCallback(() => {
    sfxRef.current?.ui("click")
    setHud(null)
    setBoss(null)
    setToasts([])
    if (state.current.mode === "campaign") setCampaignLevel(currentLevel(state.current.campaignProgress))
    setScreen("menu")
  }, [])

  // Campaign: the level after the one just played, if the campaign has one.
  const playNextLevel = useCallback(() => {
    const current = state.current.roundLevel
    if (!current) {
      toMenu()
      return
    }
    const next = nextLevel(current)
    if (!next) {
      toMenu()
      return
    }
    playLevel(next)
  }, [playLevel, toMenu])

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

  const handleEnd = useCallback((result: RoundResult, stats: BodyStats, earned: AchievementDef[], facts: RunFacts) => {
    const kind = state.current.runKind
    saveBest(state.current.roundDifficulty, result.playerWon, stats.peakMass)
    if (kind === "campaign" && state.current.roundLevel) {
      const level = state.current.roundLevel
      const ctx = { result, stats, relicCollected: facts.relicCollected }
      const goalMet = evaluateGoal(level, ctx)
      const bonusMet = evaluateBonus(level, ctx)
      const stars = starsFor(level, ctx)
      const rec = recordRun(state.current.campaignProgress, level, stars, facts.relicCollected)
      if (rec.newBest || rec.newRelic) {
        setCampaignProgress(rec.progress)
        saveProgress(storageRef.current, rec.progress)
      }
      setOutcome({
        result,
        stats,
        unlocked: earned,
        campaign: {
          level,
          goalMet,
          bonusMet,
          stars,
          relicFound: facts.relicCollected,
          newBest: rec.newBest,
          unlocked: rec.unlocked,
          next: goalMet ? nextLevel(level) ?? null : null,
        },
        daily: null,
      })
      setScreen("over")
      return
    }
    if (kind === "daily" && state.current.dailyConfig) {
      const config = state.current.dailyConfig
      const score = dailyScore(stats)
      const rec = recordDailyRun(state.current.dailyProgress, config, score)
      setDailyProgress(rec.progress)
      saveDaily(storageRef.current, rec.progress)
      setOutcome({
        result,
        stats,
        unlocked: earned,
        campaign: null,
        daily: { key: config.key, score, best: rec.best, isBest: rec.isBest, streak: rec.streak },
      })
      setScreen("over")
      return
    }
    setOutcome({ result, stats, unlocked: earned, campaign: null, daily: null })
    setScreen("over")
  }, [])

  /** Share the finished run through the Web Share sheet or the clipboard. */
  const shareOutcome = useCallback(async () => {
    const o = state.current.outcome
    if (!o) return
    const kind = state.current.runKind
    let input
    if (kind === "campaign" && o.campaign) {
      input = {
        kind: "campaign" as const,
        level: o.campaign.level,
        goalMet: o.campaign.goalMet,
        stars: o.campaign.stars,
        bonusMet: o.campaign.bonusMet,
        relicFound: o.campaign.relicFound,
        peakMass: o.stats.peakMass,
      }
    } else if (kind === "daily" && o.daily) {
      input = {
        kind: "daily" as const,
        key: o.daily.key,
        score: o.daily.score,
        best: o.daily.best,
        streak: o.daily.streak,
        arenaName: ARENAS[state.current.dailyConfig?.arena ?? "classic"].name,
      }
    } else {
      input = {
        kind: "round" as const,
        result: o.result,
        stats: o.stats,
        arenaName: ARENAS[state.current.roundLevel?.arena ?? "classic"].name,
        difficulty: state.current.roundDifficulty,
      }
    }
    const card = shareCard(input)
    const res = await shareOrCopy(card)
    if (res === "copied") pushToast("Share", { id: "share", name: "Result copied to clipboard", description: card.text.split("\n")[0] })
    else if (res === "shared") pushToast("Share", { id: "share", name: "Result shared", description: card.text.split("\n")[0] })
    else if (res === "failed") pushToast("Share", { id: "share", name: "Sharing is unavailable here", description: "Copy the text from the end screen." })
  }, [pushToast])

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
        const camp = state.current.outcome?.campaign ?? null
        const canNext = state.current.runKind === "campaign" && camp !== null && camp.goalMet && camp.next !== null
        if ((e.code === "Enter" || e.code === "NumpadEnter") && !onControl) handle(canNext ? playNextLevel : playAgain)
        else if (e.code === "KeyR") handle(playAgain)
        else if (e.code === "KeyQ") handle(toMenu)
        else if (e.code === "KeyS") handle(() => void shareOutcome())
      } else if (s === "paused") {
        if (e.code === "Escape" || e.code === "KeyP") handle(resume)
        else if (e.code === "KeyR") handle(playAgain)
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
  }, [play, playAgain, playNextLevel, toMenu, resume, toggleMute, shareOutcome])

  const today = dailyConfig ? dailyProgress.days[dailyConfig.key] : undefined
  const dailyView: DailyView | null = dailyConfig
    ? { config: dailyConfig, best: today?.best ?? 0, streak: dailyStreak(dailyProgress, dailyConfig.key), runs: today?.runs ?? 0 }
    : null
  const skin = allRelicsFound(campaignProgress) ? SKIN_COLOR : undefined
  const campaignHud =
    runKind === "campaign" && roundLevel
      ? {
          index: roundLevel.index,
          total: CAMPAIGN_LEVELS.length,
          name: roundLevel.name,
          goalLine: roundLevel.goal.line,
          timeLimit: roundLevel.timeLimit,
        }
      : null
  const dailyArena = dailyConfig ? ARENAS[dailyConfig.arena].name : ""

  return (
    <div className="gw-root" data-build="phase-b2-2026-10-24">
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
          playerColor={skin}
        />
      )}
      {screen !== "menu" && sfx && (
        <GameView
          runId={runId}
          difficulty={roundDifficulty}
          seed={seed}
          arena={roundArena}
          mode={roundMode}
          level={runKind === "campaign" ? roundLevel : null}
          lockedAbilities={roundLocked}
          playerColor={skin}
          onDeath={setDeathText}
          onBoss={setBoss}
          onNotice={onNotice}
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
          boss={boss}
          campaign={campaignHud}
          lockedAbilities={roundLocked}
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
          campaignLevel={campaignLevel}
          onCampaignLevel={(l) => {
            sfxRef.current?.ui("click")
            setCampaignLevel(l)
          }}
          campaignProgress={campaignProgress}
          daily={dailyView}
        />
      )}
      {screen === "menu" && showProfile && (
        <ProfilePanel profile={profileRef.current} onClose={() => setShowProfile(false)} />
      )}
      {screen !== "menu" && <Toasts items={toasts} layout={layout} />}
      {screen === "paused" && <PauseScreen onResume={resume} onRestart={playAgain} onQuit={toMenu} />}
      {screen === "over" && outcome && (
        <EndScreen
          result={outcome.result}
          stats={outcome.stats}
          onPlayAgain={playAgain}
          onQuit={toMenu}
          unlocked={outcome.unlocked}
          campaign={outcome.campaign ?? undefined}
          onNextLevel={playNextLevel}
          daily={outcome.daily ?? undefined}
          onShare={() => void shareOutcome()}
        />
      )}
      {screen === "over" && dailyView && (
        <span className="gw-sr-only">
          Daily {dailyView.config.key} on {dailyArena}: best {dailyView.best}, streak {dailyView.streak}.
        </span>
      )}
      {skin && <span className="gw-sr-only">{SKIN_NAME} skin unlocked.</span>}
    </div>
  )
}
