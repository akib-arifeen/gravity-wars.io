// The end-screen view of a submission. Every claim here is checked against the server's own
// answer: the score and the rank come from the response, never from the client's own numbers.

import type { SubmitState } from "./submit"

/** Shown wherever the experiment appears: what replay does and does not prove. */
export const REPLAY_NOTE =
  "Replay proves this score followed from these inputs, not that a person produced them. V8 browsers replay today — Chrome, Edge and Node; Safari and Firefox can be rejected until a cross-engine policy exists."

export interface ChallengeView {
  tone: "idle" | "pending" | "success" | "failure"
  headline: string
  detail: string
  code: string | null
  /** The server's score. Null until it answered; the client's own peak mass is shown elsewhere. */
  score: number | null
  /** The server's rank. Null when the run is unranked or the server did not place it. */
  rank: number | null
  ranked: boolean
  /** True only when the server says its replay verified the run. */
  verified: boolean
  retry: boolean
  note: string
}

const LOCAL_REFUSALS = ["ASSISTED_UNDECLARED", "RUN_NOT_FINISHED", "TRACE_TOO_LONG", "IDEMPOTENCY_KEY_INVALID"]

export function challengeView(state: SubmitState): ChallengeView {
  const base = { code: null, score: null, rank: null, ranked: false, verified: false, retry: false, note: REPLAY_NOTE }
  switch (state.phase) {
    case "idle":
      return { ...base, tone: "idle", headline: "", detail: "", note: "" }
    case "pending":
      return {
        ...base,
        tone: "pending",
        headline: "Submitting the run…",
        detail: "The server replays every recorded step before it scores anything.",
      }
    case "success": {
      const { result } = state
      const parts: string[] = []
      if (result.ranked && result.rank !== null) parts.push(`Rank ${result.rank} on this server's board.`)
      else if (!result.ranked) parts.push(result.assisted ? "Assisted — stored but never ranked." : "Stored unranked.")
      else parts.push("Verified. The server returned no rank.")
      if (state.replayed) parts.push("Re-sent with the same key; this is the stored result.")
      return {
        ...base,
        tone: "success",
        headline: result.verified ? "Replay-verified" : "Stored, not verified",
        detail: parts.join(" "),
        score: result.score,
        rank: result.rank,
        ranked: result.ranked,
        verified: result.verified,
      }
    }
    case "failure": {
      const local = LOCAL_REFUSALS.includes(state.code)
      const retryHint = state.retryable
        ? state.retryAfterS !== null
          ? ` Retry in ${state.retryAfterS}s; it reuses this run's key, so it cannot score twice.`
          : " Retry reuses this run's key, so it cannot score twice."
        : ""
      return {
        ...base,
        tone: "failure",
        headline: local ? "Not submitted" : "Submission failed",
        detail: `${state.message}${retryHint}`,
        code: state.code,
        retry: state.retryable,
      }
    }
  }
}
