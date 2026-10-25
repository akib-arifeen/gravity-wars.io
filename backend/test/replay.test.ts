import { describe, expect, it } from "vitest"
import { decodeTrace } from "../../game/runTrace.ts"
import type { RunTraceStep } from "../../game/runTrace.ts"
import { MAX_TRACE_STEPS } from "../src/daily.ts"
import { REPLAY_LIMITS, ReplayError, replayDailyRun } from "../src/replay.ts"
import { leagueForTest, recordAutopilotRun } from "./helpers.ts"

const league = leagueForTest()
const recorded = recordAutopilotRun(league)
const trace = decodeTrace(recorded.trace)
const NO_STEP: RunTraceStep = { ax: 0, ay: 0, pull: false, dash: false, repulse: false, ult: false }

describe("daily replay", () => {
  it("replays the real engine to the same peak mass the client saw", () => {
    const outcome = replayDailyRun(league, trace.steps)
    expect(outcome.peakMass).toBe(recorded.peakMass)
    expect(outcome.score).toBe(recorded.score)
    expect(outcome.ticks).toBe(recorded.steps)
  })

  it("rejects a trace that stops before the round is over", () => {
    expect(() => replayDailyRun(league, trace.steps.slice(0, -1))).toThrow(ReplayError)
    try {
      replayDailyRun(league, trace.steps.slice(0, -1))
    } catch (error) {
      expect((error as ReplayError).code).toBe("TRACE_INCOMPLETE")
    }
  })

  it("rejects steps after the round ended instead of ignoring them", () => {
    const extra: RunTraceStep[] = [...trace.steps, NO_STEP]
    try {
      replayDailyRun(league, extra)
      throw new Error("expected a replay failure")
    } catch (error) {
      expect((error as ReplayError).code).toBe("TRACE_AFTER_END")
    }
  })

  it("rejects a trace longer than the arena can run", () => {
    const tooMany = Array.from({ length: MAX_TRACE_STEPS + 1 }, () => NO_STEP)
    try {
      replayDailyRun(league, tooMany)
      throw new Error("expected a replay failure")
    } catch (error) {
      expect((error as ReplayError).code).toBe("TRACE_TOO_LONG")
    }
  })

  it("publishes one explicit step cap for every arena and honours it", () => {
    expect(MAX_TRACE_STEPS).toBe(REPLAY_LIMITS.maxSteps)
    expect(REPLAY_LIMITS.maxReplayMs).toBeGreaterThan(0)
    // The per-request cap is checkable on its own, independent of the arena's own maximum.
    const tighter = { ...REPLAY_LIMITS, maxSteps: trace.steps.length - 1 }
    try {
      replayDailyRun(league, trace.steps, tighter)
      throw new Error("expected a replay failure")
    } catch (error) {
      expect((error as ReplayError).code).toBe("TRACE_TOO_LONG")
    }
  })

  it("stops on its CPU budget instead of replaying anyway", () => {
    try {
      replayDailyRun(league, trace.steps, { ...REPLAY_LIMITS, maxReplayMs: -1 })
      throw new Error("expected a replay failure")
    } catch (error) {
      expect((error as ReplayError).code).toBe("REPLAY_BUDGET_EXCEEDED")
    }
  })

  it("is deterministic across repeated replays", () => {
    const a = replayDailyRun(league, trace.steps)
    const b = replayDailyRun(league, trace.steps)
    expect([a.score, a.peakMass, a.ticks, a.winnerId]).toEqual([b.score, b.peakMass, b.ticks, b.winnerId])
  })
})
