// Verified-run recording, end to end. The loop below mirrors GameView's fixed-step loop, records
// through the same seam the shell uses, and then replays the trace with the Worker's own replay
// module. If the trace were short, shifted, or taken before the ability filter, the server's
// replay would not reproduce the round.

import { describe, expect, it } from "vitest"
import { ReplayError, replayDailyRun } from "@/backend/src/replay"
import type { League } from "@/backend/src/daily"
import { botIntent, createBotBrain } from "@/game/bots"
import { CONFIG } from "@/game/config"
import { dailyChallenge } from "@/game/daily"
import { NO_INTENT, createWorld, step } from "@/game/engine"
import { DAILY_RULESET_VERSION } from "@/game/daily"
import { decodeTrace } from "@/game/runTrace"
import type { BodyStats, Intent } from "@/game/types"
import type { RunDescriptor } from "../api"
import { configFromDescriptor, createChallengeRun, noteRunResult, submissionPayload } from "../run"
import { recordPlayerIntent } from "../trace"

const CHALLENGE = dailyChallenge(new Date("2026-10-26T12:00:00Z"))
const LEAGUE: League = {
  id: `daily:${CHALLENGE.key}:v${DAILY_RULESET_VERSION}`,
  date: CHALLENGE.key,
  rulesetVersion: DAILY_RULESET_VERSION,
  seed: CHALLENGE.seed,
  arena: CHALLENGE.arena,
  difficulty: CHALLENGE.difficulty,
}
const RUN_ID = "00000000-0000-4000-8000-000000000000"

const stats = (over: Partial<BodyStats> = {}): BodyStats => ({
  debrisEaten: 0,
  crystals: 0,
  rivalsAbsorbed: 0,
  peakMass: 42,
  dashes: 0,
  repulses: 0,
  ults: 0,
  slingshots: 0,
  oberths: 0,
  assists: 0,
  pickups: 0,
  comets: 0,
  topSpeed: 0,
  ...over,
})

function descriptorFor(league: League): RunDescriptor {
  return {
    runId: RUN_ID,
    leagueId: league.id,
    challenge: {
      date: league.date,
      seed: league.seed,
      arena: league.arena,
      difficulty: league.difficulty,
      rulesetVersion: league.rulesetVersion,
    },
    nonce: "ab".repeat(16),
    issuedAt: "2026-10-26T12:00:00.000Z",
    expiresAt: "2026-10-26T14:00:00.000Z",
    assisted: false,
    ranked: true,
    submission: { path: `/v1/daily/runs/${RUN_ID}/submissions`, token: "t".repeat(43) },
    limits: { maxTraceSteps: 13_000, maxBodyBytes: 250_000 },
  }
}

/** One full round, driven exactly like GameView: bots by brain, player by brain, one record/step. */
function playRecordedRound(league: League) {
  const descriptor = descriptorFor(league)
  const run = createChallengeRun(descriptor, () => "run-key-0001")
  const world = createWorld({
    seed: league.seed,
    difficulty: league.difficulty,
    arena: league.arena,
    mode: "round",
    criticalMass: CONFIG.round.criticalMass,
  })
  const brains = new Map<string, ReturnType<typeof createBotBrain>>()
  world.bodies.forEach((body, index) => {
    if (body.kind === "bot") brains.set(body.id, createBotBrain(body.id, body.skill ?? league.difficulty, league.seed + index * 7919))
  })
  const playerBrain = createBotBrain("player", "hard", league.seed + 1)
  const intents = new Map<string, Intent>()
  let stepCalls = 0
  let countdownSteps = 0
  while (world.phase !== "over" && stepCalls < descriptor.limits.maxTraceSteps) {
    intents.clear()
    if (world.phase === "countdown") countdownSteps++
    if (world.bodies[0].alive) intents.set("player", botIntent(world, playerBrain))
    for (const body of world.bodies) {
      if (body.kind !== "bot" || !body.alive) continue
      const brain = brains.get(body.id)
      if (brain) intents.set(body.id, botIntent(world, brain))
    }
    recordPlayerIntent(run.trace, intents)
    step(world, intents)
    stepCalls++
  }
  noteRunResult(run, world.bodies[0].stats)
  return { run, world, stepCalls, countdownSteps }
}

describe("verified run recording", () => {
  it("records one intent per fixed step, including the countdown, and the server replays it exactly", () => {
    const { run, world, stepCalls, countdownSteps } = playRecordedRound(LEAGUE)
    expect(world.phase).toBe("over")
    expect(countdownSteps).toBeGreaterThan(0)

    const payload = submissionPayload(run)
    expect(payload.ok).toBe(true)
    if (!payload.ok) return

    const trace = decodeTrace(payload.traceData)
    expect(trace.steps).toHaveLength(stepCalls)
    expect(payload.claimedScore).toBe(Math.round(world.bodies[0].stats.peakMass))

    const replay = replayDailyRun(LEAGUE, trace.steps)
    expect(replay.score).toBe(payload.claimedScore)
    expect(replay.ticks).toBe(stepCalls)
    expect(replay.winnerId).toBe(world.result?.winnerId ?? null)
  })

  it("is rejected by the server if the last step (the one that ended the round) is missing", () => {
    const { run } = playRecordedRound(LEAGUE)
    const payload = submissionPayload(run)
    if (!payload.ok) throw new Error("expected a payload")
    const steps = decodeTrace(payload.traceData).steps

    try {
      replayDailyRun(LEAGUE, steps.slice(0, -1))
      throw new Error("expected the short trace to be rejected")
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayError)
      expect((error as ReplayError).code).toBe("TRACE_INCOMPLETE")
    }
  })

  it("is rejected by the server if a step after the end is recorded", () => {
    const { run } = playRecordedRound(LEAGUE)
    const payload = submissionPayload(run)
    if (!payload.ok) throw new Error("expected a payload")
    const steps = decodeTrace(payload.traceData).steps

    try {
      // One extra recorded step, the shape a recorder with an off-by-one would produce.
      replayDailyRun(LEAGUE, [...steps, { ax: 0, ay: 0, pull: false, dash: false, repulse: false, ult: false }])
      throw new Error("expected the long trace to be rejected")
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayError)
      expect((error as ReplayError).code).toBe("TRACE_AFTER_END")
    }
  })

  it("records a zero intent for a step with no player intent (a dead player), keeping the trace aligned", () => {
    const run = createChallengeRun(descriptorFor(LEAGUE), () => "run-key-0001")
    recordPlayerIntent(run.trace, new Map<string, Intent>())
    expect(decodeTrace(run.recorder.encode()).steps).toEqual([
      { ax: 0, ay: 0, pull: false, dash: false, repulse: false, ult: false },
    ])
  })

  it("records what the engine receives, after the ability filter has run", () => {
    const run = createChallengeRun(descriptorFor(LEAGUE), () => "run-key-0001")
    const raw: Intent = { ax: 0.5, ay: -0.5, pull: true, dash: true, repulse: true, ult: true }
    // The shell clears an ability the player has not earned before the step; the recorder sits
    // downstream of that, so the trace cannot claim a press the engine never saw.
    const locked: string[] = ["dash", "repulse", "ult"]
    if (locked.indexOf("dash") >= 0) raw.dash = false
    if (locked.indexOf("repulse") >= 0) raw.repulse = false
    if (locked.indexOf("ult") >= 0) raw.ult = false
    const intents = new Map<string, Intent>([["player", raw]])
    recordPlayerIntent(run.trace, intents)

    expect(decodeTrace(run.recorder.encode()).steps).toEqual([
      { ax: 0.5, ay: -0.5, pull: true, dash: false, repulse: false, ult: false },
    ])
  })

  it("is a no-op without a trace", () => {
    expect(() => recordPlayerIntent(null, new Map([["player", NO_INTENT]]))).not.toThrow()
    expect(() => recordPlayerIntent(undefined, new Map())).not.toThrow()
  })
})

describe("challenge run", () => {
  it("maps the descriptor's day, arena, skill and seed and keeps a stable key", () => {
    const descriptor = descriptorFor(LEAGUE)
    const run = createChallengeRun(descriptor, () => "run-key-0001")
    expect(run.idempotencyKey).toBe("run-key-0001")
    expect(configFromDescriptor(descriptor)).toEqual({
      key: CHALLENGE.key,
      number: Math.floor(Date.parse(`${CHALLENGE.key}T00:00:00Z`) / 86_400_000),
      seed: CHALLENGE.seed,
      arena: CHALLENGE.arena,
      difficulty: CHALLENGE.difficulty,
      line: `${CHALLENGE.difficulty} · verified run · ${CHALLENGE.key}`,
    })
  })

  it("claims nothing until the round has ended", () => {
    const run = createChallengeRun(descriptorFor(LEAGUE), () => "run-key-0001")
    expect(submissionPayload(run)).toMatchObject({ ok: false, code: "RUN_NOT_FINISHED" })
  })

  it("refuses to submit an autopiloted run issued as unassisted", () => {
    const run = createChallengeRun(descriptorFor(LEAGUE), () => "run-key-0001")
    run.recorder.record(NO_INTENT)
    noteRunResult(run, stats({ peakMass: 42 }))
    run.trace.markAssisted()
    expect(submissionPayload(run)).toMatchObject({ ok: false, code: "ASSISTED_UNDECLARED" })
  })

  it("submits an assisted run when the descriptor declared it", () => {
    const run = createChallengeRun({ ...descriptorFor(LEAGUE), assisted: true, ranked: false }, () => "run-key-0001")
    run.recorder.record(NO_INTENT)
    noteRunResult(run, stats({ peakMass: 42 }))
    run.trace.markAssisted()
    expect(submissionPayload(run)).toMatchObject({ ok: true, claimedScore: 42 })
  })

  it("refuses a trace longer than the descriptor allows", () => {
    const run = createChallengeRun(
      { ...descriptorFor(LEAGUE), limits: { maxTraceSteps: 1, maxBodyBytes: 250_000 } },
      () => "run-key-0001",
    )
    run.recorder.record(NO_INTENT)
    run.recorder.record(NO_INTENT)
    noteRunResult(run, stats({ peakMass: 10 }))
    expect(submissionPayload(run)).toMatchObject({ ok: false, code: "TRACE_TOO_LONG" })
  })
})
