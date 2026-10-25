import { RunTraceError, decodeTrace, type RunTrace } from "../../game/runTrace.ts"
import { HttpError } from "./http.ts"
import { MAX_TRACE_STEPS } from "./daily.ts"

export interface IssueInput {
  assisted: boolean
}

export interface SubmissionInput {
  rulesetVersion: number
  nonce: string
  token: string
  assisted: boolean
  claimedScore: number
  traceData: string
  trace: RunTrace
}

export function parseIssueInput(value: unknown): IssueInput {
  if (!isRecord(value)) invalid("body must be a JSON object")
  const assisted = value.assisted
  if (assisted === undefined) return { assisted: false }
  if (typeof assisted !== "boolean") invalid("assisted must be a boolean")
  return { assisted }
}

export function parseSubmissionInput(value: unknown): SubmissionInput {
  if (!isRecord(value)) invalid("body must be a JSON object")

  const rulesetVersion = integer(value.rulesetVersion, "rulesetVersion", 1, 1_000_000)
  if (typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce)) {
    invalid("nonce must be a 32-character lowercase hex string")
  }
  if (typeof value.token !== "string" || value.token.length < 20 || value.token.length > 200) {
    invalid("token is missing or malformed")
  }
  if (typeof value.assisted !== "boolean") invalid("assisted must be a boolean")
  const claimedScore = integer(value.claimedScore, "claimedScore", 0, 1_000_000_000)

  if (!isRecord(value.trace)) invalid("trace must be an object")
  if (value.trace.format !== "gwt1") invalid('trace.format must be "gwt1"')
  if (typeof value.trace.data !== "string" || value.trace.data.length === 0) {
    invalid("trace.data must be a non-empty base64url string")
  }

  let trace: RunTrace
  try {
    trace = decodeTrace(value.trace.data)
  } catch (error) {
    if (error instanceof RunTraceError) {
      throw new HttpError(422, "TRACE_INVALID", error.message)
    }
    throw error
  }
  if (trace.steps.length > MAX_TRACE_STEPS) {
    throw new HttpError(422, "TRACE_TOO_LONG", `Trace has ${trace.steps.length} steps; the limit is ${MAX_TRACE_STEPS}`, {
      details: { maxTraceSteps: MAX_TRACE_STEPS },
    })
  }

  return {
    rulesetVersion,
    nonce: value.nonce,
    token: value.token,
    assisted: value.assisted,
    claimedScore,
    traceData: value.trace.data,
    trace,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${name} must be an integer in [${min}, ${max}]`)
  }
  return value
}

function invalid(message: string): never {
  throw new HttpError(422, "INVALID_REQUEST", message)
}
