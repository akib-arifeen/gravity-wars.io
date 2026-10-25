// The end-screen view model: every claim it makes has to come from the server's answer.

import { describe, expect, it } from "vitest"
import type { SubmissionResult } from "../api"
import { challengeView } from "../view"

const RESULT: SubmissionResult = {
  submissionId: "11111111-1111-4111-8111-111111111111",
  runId: "00000000-0000-4000-8000-000000000000",
  leagueId: "daily:2026-10-26:v1",
  date: "2026-10-26",
  rulesetVersion: 1,
  assisted: false,
  ranked: true,
  verified: true,
  verification: "engine-replay",
  score: 73,
  claimedScore: 73,
  traceSteps: 9100,
  replayMs: 480,
  replayCached: false,
  personalBest: true,
  submittedAt: "2026-10-26T12:04:00.000Z",
  rank: 3,
}

describe("challengeView", () => {
  it("says nothing at all before a run", () => {
    expect(challengeView({ phase: "idle" })).toMatchObject({
      tone: "idle",
      headline: "",
      score: null,
      rank: null,
      retry: false,
      verified: false,
    })
  })

  it("claims no score or rank while the submission is pending", () => {
    const view = challengeView({ phase: "pending", attempt: 1 })
    expect(view).toMatchObject({ tone: "pending", score: null, rank: null, retry: false, verified: false })
    expect(view.headline).toContain("Submitting")
    expect(view.detail).toContain("replays every recorded step")
  })

  it("shows the server's score and rank on a verified ranked run", () => {
    const view = challengeView({ phase: "success", attempt: 1, result: RESULT, replayed: false })
    expect(view).toMatchObject({ tone: "success", headline: "Replay-verified", score: 73, rank: 3, ranked: true, verified: true })
    expect(view.detail).toContain("Rank 3")
    expect(view.note).toContain("V8")
  })

  it("never shows a rank for an assisted, unranked run", () => {
    const view = challengeView({
      phase: "success",
      attempt: 1,
      result: { ...RESULT, assisted: true, ranked: false, rank: null },
      replayed: false,
    })
    expect(view).toMatchObject({ tone: "success", score: 73, rank: null, ranked: false, verified: true })
    expect(view.detail).toContain("Assisted")
    expect(view.detail).not.toContain("Rank")
  })

  it("does not claim verification the server did not give", () => {
    const view = challengeView({
      phase: "success",
      attempt: 1,
      result: { ...RESULT, verified: false, verification: "stored-only" },
      replayed: false,
    })
    expect(view).toMatchObject({ headline: "Stored, not verified", verified: false })
  })

  it("says a run did not place when a better run of the same browser holds the row", () => {
    const view = challengeView({
      phase: "success",
      attempt: 1,
      result: { ...RESULT, rank: null, personalBest: false },
      replayed: false,
    })
    expect(view).toMatchObject({ tone: "success", score: 73, rank: null, ranked: true, verified: true })
    expect(view.detail).toContain("better run of yours")
    expect(view.detail).not.toContain("Rank ")
  })

  it("marks a replayed answer as the stored result", () => {
    const view = challengeView({ phase: "success", attempt: 2, result: RESULT, replayed: true })
    expect(view.detail).toContain("stored result")
  })

  it("offers a retry only when the failure was retryable, and never invents a score", () => {
    const retryable = challengeView({
      phase: "failure",
      attempt: 1,
      code: "NETWORK",
      message: "The challenge server did not answer.",
      retryable: true,
      retryAfterS: null,
    })
    expect(retryable).toMatchObject({ tone: "failure", retry: true, score: null, rank: null, code: "NETWORK" })
    expect(retryable.headline).toBe("Submission failed")
    expect(retryable.detail).toContain("cannot score twice")

    const rateLimited = challengeView({
      phase: "failure",
      attempt: 1,
      code: "RATE_LIMITED",
      message: "Too many requests for this window",
      retryable: true,
      retryAfterS: 7,
    })
    expect(rateLimited.detail).toContain("Retry in 7s")

    const rejected = challengeView({
      phase: "failure",
      attempt: 1,
      code: "SCORE_MISMATCH",
      message: "Replay does not match the claimed score",
      retryable: false,
      retryAfterS: null,
    })
    expect(rejected).toMatchObject({ retry: false, code: "SCORE_MISMATCH", score: null, rank: null })
    expect(rejected.detail).not.toContain("score twice")
  })

  it("calls a local refusal what it is: not submitted", () => {
    for (const code of ["ASSISTED_UNDECLARED", "RUN_NOT_FINISHED", "TRACE_OVER_LIMIT"]) {
      const view = challengeView({ phase: "failure", attempt: 0, code, message: "refused", retryable: false, retryAfterS: null })
      expect(view.headline).toBe("Not submitted")
      expect(view.retry).toBe(false)
    }
  })

  it("does not call a server code, or a transport code, a local refusal", () => {
    // TRACE_TOO_LONG is also a server answer, and IDEMPOTENCY_KEY_INVALID comes from the client's
    // transport layer, so neither proves nothing was sent.
    for (const code of ["TRACE_TOO_LONG", "IDEMPOTENCY_KEY_INVALID", "SCORE_MISMATCH"]) {
      const view = challengeView({ phase: "failure", attempt: 1, code, message: "refused", retryable: false, retryAfterS: null })
      expect(view.headline).toBe("Submission failed")
    }
  })
})
