"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
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
import { dailyScore, dailyStreak, emptyDaily, loadDaily, recordDailyRun, refreshDaily, saveDaily, type DailyConfig, type DailyProgress } from "@/game/daily"
import { recordsRoundBest, runArena, type RunKind } from "@/game/run-summary"
import { shareCard, shareOrCopy } from "@/game/share"
import { ARENAS } from "@/game/arenas"
import type { InputController } from "@/game/input"
import type { ArenaId, BodyStats, Difficulty, GameMode, HudSnapshot, RoundResult } from "@/game/types"
import { ChallengeApiError, createChallengeClient, resolveChallengeBase } from "./challenge/api"
import { configFromDescriptor, createChallengeRun, noteRunResult, type ChallengeRun } from "./challenge/run"
import { submitChallengeRun, type SubmitState } from "./challenge/submit"
import { challengeView } from "./challenge/view"
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
import type { ChallengeMenuModel } from "./components/Challenge"
import { Toasts, type ToastItem } from "./components/Toasts"
import { ARENA_KEY, DIFFICULTY_KEY, hasPlayHistory, startDefaults } from "./startDefaults"

type Screen = "menu" | "playing" | "paused" | "over"

interface Outcome {
  result: RoundResult
  stats: BodyStats
  unlocked: AchievementDef[]
  campaign: CampaignOutcome | null
  daily: DailyOutcome | null
}

const MUTE_KEY = "gw:muted"
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

function challengeErrorText(error: unknown): string {
  if (error instanceof ChallengeApiError) return `${error.message} (${error.code})`
  return "Could not reach the local challenge server."
}

const FIRST_RUN = startDefaults({})

/**
 * The verified-run experiment: a local challenge server, off unless
 * NEXT_PUBLIC_GW_CHALLENGE_API names a loopback API at build time. A default build has no base,
 * no client and no network calls, so the static game is exactly what it was.
 */
const CHALLENGE = resolveChallengeBase(process.env.NEXT_PUBLIC_GW_CHALLENGE_API)
const CHALLENGE_CLIENT = CHALLENGE.base === null ? null : createChallengeClient({ base: CHALLENGE.base })
const CHALLENGE_HOST = CHALLENGE.base === null ? "" : new URL(CHALLENGE.base).host

interface ChallengeIssue {
  phase: "idle" | "pending" | "error"
  message: string
}

/**
 * Apply the stored menu choices in the same commit that hydrates, before the browser paints it, so
 * the menu is already the returning player's when it first becomes live: the first-run values are
 * replaced before the next paint and before any click can land. This cannot remove the served
 * markup, which a static export always writes as the first-run menu until the client hydrates; it
 * only means the swap happens inside hydration rather than visibly after it. A plain effect would
 * paint the first-run menu first and then change it under the player.
 */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

export default function Page() {
  const [screen, setScreen] = useState<Screen>("menu")
  const [difficulty, setDifficulty] = useState<Difficulty>(FIRST_RUN.difficulty)
  const [seed, setSeed] = useState(1)
  const [runId, setRunId] = useState(0)
  const [muted, setMuted] = useState(false)
  const [arena, setArena] = useState<ArenaChoice>(FIRST_RUN.arena)
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
  const [dailyRunConfig, setDailyRunConfig] = useState<DailyConfig | null>(null)
  const [boss, setBoss] = useState<BossHud | null>(null)
  const [deathText, setDeathText] = useState("")
  const [deathTip, setDeathTip] = useState("")
  const [profileTick, setProfileTick] = useState(0)
  const [showProfile, setShowProfile] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [hud, setHud] = useState<HudSnapshot | null>(null)
  const [layout, setLayout] = useState<"desktop" | "touch">("desktop")
  const [demoSeed, setDemoSeed] = useState(7)
  const [sfx, setSfx] = useState<Sfx | null>(null)
  const [challengeAssisted, setChallengeAssisted] = useState(false)
  const [challengeIssue, setChallengeIssue] = useState<ChallengeIssue>({ phase: "idle", message: "" })
  const [challengeRun, setChallengeRun] = useState<ChallengeRun | null>(null)
  const [challengeSubmit, setChallengeSubmit] = useState<SubmitState>({ phase: "idle" })

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
    roundArena,
    runKind,
    campaignLevel,
    roundLevel,
    campaignProgress,
    dailyProgress,
    dailyConfig,
    dailyRunConfig,
    outcome,
    challengeRun,
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
    roundArena,
    runKind,
    campaignLevel,
    roundLevel,
    campaignProgress,
    dailyProgress,
    dailyConfig,
    dailyRunConfig,
    outcome,
    challengeRun,
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

  // Restore the stored menu choices inside hydration, so a returning player never sees the menu
  // change under them once it is live. `hasPlayHistory` is why a missing `gw:difficulty` alone does
  // not make a veteran a newcomer — and why a mode tab click alone does not make one a veteran.
  useIsoLayoutEffect(() => {
    try {
      const s = window.localStorage
      if (s.getItem(MUTE_KEY) === "1") setMuted(true)
      const start = startDefaults({
        difficulty: s.getItem(DIFFICULTY_KEY),
        arena: s.getItem(ARENA_KEY),
        hasHistory: hasPlayHistory((key) => s.getItem(key)),
      })
      setDifficulty(start.difficulty)
      setArena(start.arena)
      const m = s.getItem(MODE_KEY)
      if (m === "round" || m === "endless" || m === "campaign" || m === "daily") setMode(m)
    } catch {
      // Storage blocked: stay unmuted, on the first-run defaults.
    }
  }, [])

  // Restore the saved record and detect a touch-first device.
  useEffect(() => {
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
    setDailyConfig(refreshDaily(null, new Date()))
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

  // Roll the menu's daily challenge over at UTC midnight, including for a tab that was left open
  // or in the background. A minute of slack on a minute's tick; nothing runs per frame.
  useEffect(() => {
    const sync = () => {
      setDailyConfig((c) => {
        const next = refreshDaily(c, new Date())
        return next.key === c?.key ? c : next
      })
    }
    const timer = window.setInterval(sync, 60_000)
    const onVisible = () => {
      if (document.visibilityState === "visible") sync()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", sync)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", sync)
    }
  }, [])

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

  const chooseDifficulty = useCallback((d: Difficulty) => {
    sfxRef.current?.ui("click")
    setDifficulty(d)
    try {
      window.localStorage.setItem(DIFFICULTY_KEY, d)
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
    (opts: {
      mode: GameMode
      arena: ArenaId
      difficulty: Difficulty
      kind: RunKind
      seed?: number
      level?: CampaignLevel | null
      /** A verified run to record; every other round clears it so nothing is ever recorded into it. */
      challenge?: ChallengeRun | null
    }) => {
      const progress = state.current.campaignProgress
      const unlockedNow = unlockedAbilities(progress)
      setRoundMode(opts.mode)
      setRoundArena(opts.arena)
      setRoundDifficulty(opts.difficulty)
      setRunKind(opts.kind)
      setRoundLevel(opts.level ?? null)
      setChallengeRun(opts.challenge ?? null)
      setChallengeSubmit({ phase: "idle" })
      setRoundLocked(
        opts.kind === "campaign" ? ABILITY_UNLOCKS.filter((a) => unlockedNow.indexOf(a.id) < 0).map((a) => a.id) : [],
      )
      setDeathText("")
      setDeathTip("")
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
    // Pick up the new day here as well as from the menu timer, and snapshot the config: a run that
    // crosses UTC midnight still records on the day it started.
    const config = refreshDaily(state.current.dailyConfig, new Date())
    setDailyConfig(config)
    setDailyRunConfig(config)
    beginRound({ mode: "round", arena: config.arena, difficulty: config.difficulty, kind: "daily", seed: config.seed })
  }, [beginRound])

  // Verified run: ask the local server for the daily descriptor and play exactly what it issued.
  // The client never picks the seed, arena, skill or ruleset.
  const startVerifiedRun = useCallback(() => {
    const client = CHALLENGE_CLIENT
    if (!client || challengeIssue.phase === "pending") return
    // The debug autopilot is an assist, and assisted has to be declared when the run is issued.
    const autopilot = typeof window !== "undefined" && window.__gw?.autopilot === true
    setChallengeIssue({ phase: "pending", message: "" })
    client
      .issue(challengeAssisted || autopilot)
      .then((descriptor) => {
        setDailyRunConfig(configFromDescriptor(descriptor))
        setChallengeIssue({ phase: "idle", message: "" })
        beginRound({
          mode: "round",
          arena: descriptor.challenge.arena,
          difficulty: descriptor.challenge.difficulty,
          kind: "daily",
          seed: descriptor.challenge.seed,
          challenge: createChallengeRun(descriptor),
        })
      })
      .catch((error: unknown) => setChallengeIssue({ phase: "error", message: challengeErrorText(error) }))
  }, [beginRound, challengeAssisted, challengeIssue.phase])

  // Retry the same submission: the run keeps its idempotency key, so this cannot score twice.
  const retryChallengeSubmit = useCallback(() => {
    const run = state.current.challengeRun
    if (!run || !CHALLENGE_CLIENT) return
    void submitChallengeRun(run, CHALLENGE_CLIENT, setChallengeSubmit)
  }, [])

  // The menu's Play button: whichever mode is selected.
  const play = useCallback(() => {
    // Pressing Play is the explicit choice: store the pair the menu resolved to, so the next visit
    // opens on it even if the player never tapped the segmented controls. No click sound here.
    try {
      window.localStorage.setItem(DIFFICULTY_KEY, state.current.difficulty)
      window.localStorage.setItem(ARENA_KEY, state.current.arena)
    } catch {
      // Not persisted; the choice still applies for this session.
    }
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
    // Only the Round mode's own rounds feed its best map; campaign and daily keep their records.
    if (recordsRoundBest(kind)) saveBest(state.current.roundDifficulty, result.playerWon, stats.peakMass)
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
    if (kind === "daily" && state.current.dailyRunConfig) {
      const config = state.current.dailyRunConfig
      const score = dailyScore(stats)
      const rec = recordDailyRun(state.current.dailyProgress, config, score)
      setDailyProgress(rec.progress)
      saveDaily(storageRef.current, rec.progress)
      // A verified run submits the recording this round produced; nothing is claimed until the
      // round's own peak mass is known, and the server's replayed score is the one that counts.
      const run = state.current.challengeRun
      if (run && CHALLENGE_CLIENT) {
        noteRunResult(run, stats)
        void submitChallengeRun(run, CHALLENGE_CLIENT, setChallengeSubmit)
      }
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
    // The arena the run was actually played in: Round/Endless keep it on the round, not on a level.
    const arena = runArena(kind, {
      round: state.current.roundArena,
      level: o.campaign?.level.arena ?? null,
      daily: state.current.dailyRunConfig?.arena ?? state.current.dailyConfig?.arena ?? null,
    })
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
        arenaName: ARENAS[arena].name,
      }
    } else {
      input = {
        kind: "round" as const,
        result: o.result,
        stats: o.stats,
        arenaName: ARENAS[arena].name,
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
  // The experimental block: nothing at all unless a loopback challenge API was configured, and a
  // refused base is shown disabled rather than silently hidden.
  const challengeMenu: ChallengeMenuModel | null =
    CHALLENGE.enabled && CHALLENGE.base !== null
      ? {
          host: CHALLENGE_HOST,
          disabledReason: null,
          assisted: challengeAssisted,
          busy: challengeIssue.phase === "pending",
          error: challengeIssue.phase === "error" ? challengeIssue.message : null,
          onAssisted: setChallengeAssisted,
          onStart: startVerifiedRun,
        }
      : CHALLENGE.reason === null
        ? null
        : {
            host: "",
            disabledReason: CHALLENGE.reason,
            assisted: false,
            busy: false,
            error: null,
            onAssisted: noop,
            onStart: noop,
          }
  // A verified run records only a plain Round world: no campaign level, so no boss or relic path.
  const challengeTrace = runKind === "daily" && roundLevel === null ? (challengeRun?.trace ?? null) : null
  const challengeEnd =
    challengeRun !== null && runKind === "daily"
      ? { view: challengeView(challengeSubmit), onRetry: retryChallengeSubmit }
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
  // The day the end screen reports: the run's own day once a daily run has started, otherwise the
  // menu's (today's) challenge.
  const resultDaily = dailyRunConfig ?? dailyConfig
  const dailyArena = resultDaily ? ARENAS[resultDaily.arena].name : ""

  return (
    <main className="gw-root" data-build="phase-b2-2026-10-24">
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
          onDeath={(text, tip) => {
            setDeathText(text)
            setDeathTip(tip)
          }}
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
          trace={challengeTrace}
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
          deathTip={deathTip}
          onPress={(k) => inputRef.current?.press(k)}
          onPause={pauseNow}
          onToggleMute={toggleMute}
        />
      )}
      {screen === "menu" && (
        <MenuScreen
          difficulty={difficulty}
          onDifficulty={chooseDifficulty}
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
          challenge={challengeMenu}
        />
      )}
      {screen === "menu" && showProfile && (
        <ProfilePanel profile={profileRef.current} onClose={() => setShowProfile(false)} />
      )}
      {screen !== "menu" && <Toasts items={toasts} layout={layout} />}
      {screen === "paused" && (
        <PauseScreen layout={layout} onResume={resume} onRestart={playAgain} onQuit={toMenu} />
      )}
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
          challenge={challengeEnd}
          onShare={() => void shareOutcome()}
        />
      )}
      {screen === "over" && resultDaily && (
        <span className="gw-sr-only">
          Daily {resultDaily.key} on {dailyArena}: best {dailyProgress.days[resultDaily.key]?.best ?? 0}, streak{" "}
          {dailyStreak(dailyProgress, resultDaily.key)}.
        </span>
      )}
      {skin && <span className="gw-sr-only">{SKIN_NAME} skin unlocked.</span>}
    </main>
  )
}
