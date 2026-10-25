// Submission flow: what the player sees from pending through a failure to a retried success, and
// the two cases that must never leave the browser.

import { describe, expect, it } from "vitest"
import { ChallengeApiError, type ChallengeClient, type SubmissionResult, type SubmitInput } from "../api"
import { createChallengeRun, noteRunResult, type ChallengeRun } from "../run"
import { submitChallengeRun, type SubmitState } from "../submit"

const RUN_ID = "00000000-0000-4000-8000-000000000000"

function newRun(assisted = false): ChallengeRun {
  const run = createChallengeRun(
    {
      runId: RUN_ID,
      leagueId: "daily:2026-10-26:v1",
      challenge: { date: "2026-10-26", seed: 1234, arena: "classic", difficulty: "normal", rulesetVersion: 1 },
      nonce: "ab".repeat(16),
      issuedAt: "2026-10-26T12:00:00.000Z",
      expiresAt: "2026-10-26T14:00:00.000Z",
      assisted,
      ranked: !assisted,
      submission: { path: `/v1/daily/runs/${RUN_ID}/submissions`, token: "t".repeat(43) },
      limits: { maxTraceSteps: 13_000, maxBodyBytes: 250_000 },
    },
    () => "run-key-0001",
  )
  run.recorder.record({ ax: 0, ay: 0, pull: false })
  noteRunResult(run, {
    debrisEaten: 0,
    crystals: 0,
    rivalsAbsorbed: 0,
    peakMass: 73.4,
    dashes: 0,
    repulses: 0,
    ults: 0,
    slingshots: 0,
    oberths: 0,
    assists: 0,
    pickups: 0,
    comets: 0,
    topSpeed: 0,
  })
  return run
}

const RESULT: SubmissionResult = {
  submissionId: "11111111-1111-4111-8111-111111111111",
  runId: RUN_ID,
  leagueId: "daily:2026-10-26:v1",
  date: "2026-10-26",
  rulesetVersion: 1,
  assisted: false,
  ranked: true,
  verified: true,
  verification: "engine-replay",
  score: 73,
  claimedScore: 73,
  traceSteps: 1,
  replayMs: 12,
  submittedAt: "2026-10-26T12:04:00.000Z",
  rank: 2,
}

function fakeClient(handler: (input: SubmitInput) => Promise<{ result: SubmissionResult; replayed: boolean }>) {
  const calls: SubmitInput[] = []
  const client: ChallengeClient = {
    issue: async () => {
      throw new Error("not used")
    },
    submit: async (input) => {
      calls.push(input)
      return handler(input)
    },
  }
  return { client, calls }
}

describe("submission flow", () => {
  it("shows pending, then the server's own score and rank", async () => {
    const states: SubmitState[] = []
    const { client, calls } = fakeClient(async () => ({ result: RESULT, replayed: false }))
    await submitChallengeRun(newRun(), client, (s) => states.push(s))

    expect(states.map((s) => s.phase)).toEqual(["pending", "success"])
    expect(states[1]).toMatchObject({ phase: "success", replayed: false, result: { score: 73, rank: 2 } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ claimedScore: 73, idempotencyKey: "run-key-0001", traceData: expect.any(String) })
  })

  it("keeps the key and trace across a retry and reports the stored result", async () => {
    const states: SubmitState[] = []
    let attempt = 0
    const { client, calls } = fakeClient(async () => {
      attempt += 1
      if (attempt === 1) throw new ChallengeApiError("NETWORK", "The challenge server did not answer.", true)
      return { result: RESULT, replayed: true }
    })
    const run = newRun()

    await submitChallengeRun(run, client, (s) => states.push(s))
    expect(states[1]).toMatchObject({ phase: "failure", code: "NETWORK", retryable: true, attempt: 1 })

    await submitChallengeRun(run, client, (s) => states.push(s))
    expect(states.map((s) => s.phase)).toEqual(["pending", "failure", "pending", "success"])
    expect(states[3]).toMatchObject({ phase: "success", replayed: true, attempt: 2 })

    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
    expect(run.idempotencyKey).toBe("run-key-0001")
  })

  it("does not start a second attempt while one is in flight", async () => {
    const pending: { release: () => void } = { release: () => {} }
    const { client, calls } = fakeClient(
      () =>
        new Promise((resolve) => {
          pending.release = () => resolve({ result: RESULT, replayed: false })
        }),
    )
    const run = newRun()
    const first = submitChallengeRun(run, client, () => {})
    await submitChallengeRun(run, client, () => {})
    expect(calls).toHaveLength(1)
    pending.release()
    await first
    expect(calls).toHaveLength(1)
  })

  it("refuses an autopiloted run issued as unassisted without calling the server", async () => {
    const states: SubmitState[] = []
    const { client, calls } = fakeClient(async () => ({ result: RESULT, replayed: false }))
    const run = newRun(false)
    run.trace.markAssisted()
    await submitChallengeRun(run, client, (s) => states.push(s))

    expect(calls).toHaveLength(0)
    expect(states).toEqual([
      { phase: "failure", attempt: 0, code: "ASSISTED_UNDECLARED", message: expect.stringContaining("autopilot"), retryable: false, retryAfterS: null },
    ])
  })

  it("refuses a run with no score instead of inventing one", async () => {
    const states: SubmitState[] = []
    const { client, calls } = fakeClient(async () => ({ result: RESULT, replayed: false }))
    const run = newRun()
    run.claimedScore = null
    await submitChallengeRun(run, client, (s) => states.push(s))
    expect(calls).toHaveLength(0)
    expect(states[0]).toMatchObject({ phase: "failure", code: "RUN_NOT_FINISHED", retryable: false })
  })

  it("surfaces a non-API failure without offering a retry it cannot reason about", async () => {
    const states: SubmitState[] = []
    const { client } = fakeClient(async () => {
      throw new Error("boom")
    })
    await submitChallengeRun(newRun(), client, (s) => states.push(s))
    expect(states[1]).toMatchObject({ phase: "failure", code: "UNKNOWN", message: "boom", retryable: false })
  })
})
