// The submission half of a verified run: one attempt, its honest pending/success/failure state, and
// a retry that reuses the same idempotency key and body. The page renders the state; this module
// only decides it, so the flow is testable without a DOM.

import { ChallengeApiError, type ChallengeClient, type SubmissionResult } from "./api"
import { submissionPayload, type ChallengeRun } from "./run"

export type SubmitState =
  | { phase: "idle" }
  | { phase: "pending"; attempt: number }
  | { phase: "success"; attempt: number; result: SubmissionResult; replayed: boolean }
  | { phase: "failure"; attempt: number; code: string; message: string; retryable: boolean; retryAfterS: number | null }

/**
 * Submit the finished run once. The caller may call this again for a retry: the run keeps its
 * idempotency key, so a retry either returns the stored result or is refused as a conflict, and it
 * can never score twice.
 */
export async function submitChallengeRun(
  run: ChallengeRun,
  client: ChallengeClient,
  onState: (state: SubmitState) => void,
): Promise<void> {
  if (run.busy) return
  const payload = submissionPayload(run)
  const attempt = run.attempts
  if (!payload.ok) {
    onState({ phase: "failure", attempt, code: payload.code, message: payload.message, retryable: false, retryAfterS: null })
    return
  }

  run.busy = true
  run.attempts = attempt + 1
  onState({ phase: "pending", attempt: run.attempts })
  try {
    const outcome = await client.submit({
      descriptor: run.descriptor,
      traceData: payload.traceData,
      claimedScore: payload.claimedScore,
      idempotencyKey: payload.idempotencyKey,
    })
    onState({ phase: "success", attempt: run.attempts, result: outcome.result, replayed: outcome.replayed })
  } catch (error) {
    if (error instanceof ChallengeApiError) {
      onState({
        phase: "failure",
        attempt: run.attempts,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        retryAfterS: error.retryAfterS,
      })
    } else {
      onState({
        phase: "failure",
        attempt: run.attempts,
        code: "UNKNOWN",
        message: error instanceof Error ? error.message : "The submission failed.",
        retryable: false,
        retryAfterS: null,
      })
    }
  } finally {
    run.busy = false
  }
}
