// The client half of the local daily-challenge API. Everything here is inert unless a loopback
// API base is configured at build time (`NEXT_PUBLIC_GW_CHALLENGE_API`), so a normal build never
// fetches anything and the static game behaves exactly as before.
//
// The base is restricted to this machine: the experiment talks to a `cf dev` Worker, never to a
// deployed host or a third party. Pure apart from the injected fetch, so it is unit-tested without
// a browser.

import { ARENA_IDS } from "@/game/arenas"
import type { ArenaId, Difficulty } from "@/game/types"

/** Build-time setting. Empty (the default) keeps the experimental UI off. */
export const CHALLENGE_API_ENV = "NEXT_PUBLIC_GW_CHALLENGE_API"

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"]
const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"]
const DEFAULT_TIMEOUT_MS = 8000

export interface ChallengeBase {
  enabled: boolean
  /** Origin only, no trailing slash. Null when disabled. */
  base: string | null
  /** Set only when a value was configured and refused, so the menu can say why. */
  reason: string | null
}

/**
 * Resolve the configured API base. Only a loopback http(s) origin is accepted: the verified-run
 * experiment is local-only, and a stray configured URL must not be able to receive traces.
 */
export function resolveChallengeBase(raw: string | undefined | null): ChallengeBase {
  const value = (raw ?? "").trim()
  if (!value) return { enabled: false, base: null, reason: null }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { enabled: false, base: null, reason: "is not a valid URL" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { enabled: false, base: null, reason: "must be an http(s) URL" }
  }
  if (url.username || url.password) {
    return { enabled: false, base: null, reason: "must not carry credentials" }
  }
  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    return { enabled: false, base: null, reason: "must be a loopback address (localhost or 127.0.0.1)" }
  }
  return { enabled: true, base: url.origin, reason: null }
}

/** One day's challenge as the server issued it. The client uses these values and chooses nothing. */
export interface RunChallenge {
  date: string
  seed: number
  arena: ArenaId
  difficulty: Difficulty
  rulesetVersion: number
}

export interface RunDescriptor {
  runId: string
  leagueId: string
  challenge: RunChallenge
  nonce: string
  issuedAt: string
  expiresAt: string
  assisted: boolean
  ranked: boolean
  submission: { path: string; token: string }
  limits: { maxTraceSteps: number; maxBodyBytes: number }
}

/** The server's answer after replaying the trace. `score` and `rank` are its own. */
export interface SubmissionResult {
  submissionId: string
  runId: string
  leagueId: string
  date: string
  rulesetVersion: number
  assisted: boolean
  ranked: boolean
  verified: boolean
  verification: string
  score: number
  claimedScore: number
  traceSteps: number
  replayMs: number
  submittedAt: string
  rank: number | null
}

/** One submission answer, with whether the Worker replayed a stored response for the key. */
export interface SubmitOutcome {
  result: SubmissionResult
  replayed: boolean
}

export interface SubmitInput {
  descriptor: RunDescriptor
  traceData: string
  claimedScore: number
  idempotencyKey: string
}

export interface ChallengeClient {
  issue(assisted: boolean): Promise<RunDescriptor>
  submit(input: SubmitInput): Promise<SubmitOutcome>
}

/** A refusal the UI can show. `retryable` is true only for transport and server-side failures. */
export class ChallengeApiError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly status: number | null
  readonly retryAfterS: number | null

  constructor(code: string, message: string, retryable: boolean, status: number | null = null, retryAfterS: number | null = null) {
    super(message)
    this.name = "ChallengeApiError"
    this.code = code
    this.retryable = retryable
    this.status = status
    this.retryAfterS = retryAfterS
  }
}

export interface ChallengeClientOptions {
  base: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export function createChallengeClient(options: ChallengeClientOptions): ChallengeClient {
  const base = options.base.replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function send(path: string, init: RequestInit): Promise<{ status: number; headers: Headers; body: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    let text: string
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, signal: controller.signal })
      text = await response.text()
    } catch {
      throw new ChallengeApiError("NETWORK", "The challenge server did not answer.", true)
    } finally {
      clearTimeout(timer)
    }
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }
    return { status: response.status, headers: response.headers, body }
  }

  return {
    async issue(assisted) {
      const response = await send("/v1/daily/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assisted }),
      })
      if (response.status !== 201) throw refusal(response)
      return parseDescriptor(response.body)
    },

    async submit(input) {
      const key = input.idempotencyKey
      if (key.length < 8 || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) {
        throw new ChallengeApiError("IDEMPOTENCY_KEY_INVALID", "The run's idempotency key is malformed.", false)
      }
      // The body is serialised once per call from fixed fields, so a retry of the same run sends a
      // byte-identical body: the Worker's key check then replays its stored answer.
      const body = JSON.stringify({
        rulesetVersion: input.descriptor.challenge.rulesetVersion,
        nonce: input.descriptor.nonce,
        token: input.descriptor.submission.token,
        assisted: input.descriptor.assisted,
        claimedScore: input.claimedScore,
        trace: { format: "gwt1", data: input.traceData },
      })
      const response = await send(input.descriptor.submission.path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body,
      })
      if (response.status !== 200 && response.status !== 201) throw refusal(response)
      return {
        result: parseSubmission(response.body),
        replayed: response.headers.get("idempotent-replay") === "true",
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// PRIVATE helpers

interface Envelope {
  status: number
  headers: Headers
  body: unknown
}

/** Map a non-success answer to a typed refusal: transport and server faults may be retried. */
function refusal(response: Envelope): ChallengeApiError {
  const error = recordOrNull(response.body)
  const detail = error ? recordOrNull(error.error) : null
  const code = typeof detail?.code === "string" ? detail.code : `HTTP_${response.status}`
  const message = typeof detail?.message === "string" ? detail.message : `The challenge server answered ${response.status}.`
  const retryable = response.status === 429 || response.status >= 500
  const retryAfter = Number(response.headers.get("retry-after") ?? "")
  return new ChallengeApiError(code, message, retryable, response.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null)
}

function parseDescriptor(value: unknown): RunDescriptor {
  const body = record(value, "descriptor")
  const challenge = record(body.challenge, "challenge")
  const submission = record(body.submission, "submission")
  const limits = record(body.limits, "limits")

  const date = text(challenge.date, "challenge.date")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad("challenge.date must be a YYYY-MM-DD date")
  const arena = text(challenge.arena, "challenge.arena")
  if (!(ARENA_IDS as readonly string[]).includes(arena)) bad("challenge.arena is not an arena this game knows")
  const difficulty = text(challenge.difficulty, "challenge.difficulty")
  if (!(DIFFICULTIES as string[]).includes(difficulty)) bad("challenge.difficulty is not a known skill")
  const nonce = text(body.nonce, "nonce")
  if (!/^[a-f0-9]{32}$/.test(nonce)) bad("nonce must be 32 lowercase hex characters")
  const token = text(submission.token, "submission.token")
  if (token.length < 20 || token.length > 200) bad("submission.token is malformed")
  const path = text(submission.path, "submission.path")
  if (!path.startsWith("/v1/daily/runs/") || !path.endsWith("/submissions")) bad("submission.path is not a run submission path")
  const issuedAt = time(body.issuedAt, "issuedAt")
  const expiresAt = time(body.expiresAt, "expiresAt")
  if (expiresAt <= issuedAt) bad("the descriptor expires before it was issued")

  return {
    runId: text(body.runId, "runId"),
    leagueId: text(body.leagueId, "leagueId"),
    challenge: {
      date,
      seed: whole(challenge.seed, "challenge.seed", 1, 2147483646),
      arena: arena as ArenaId,
      difficulty: difficulty as Difficulty,
      rulesetVersion: whole(challenge.rulesetVersion, "challenge.rulesetVersion", 1, 1_000_000),
    },
    nonce,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    assisted: bool(body.assisted, "assisted"),
    ranked: bool(body.ranked, "ranked"),
    submission: { path, token },
    limits: {
      maxTraceSteps: whole(limits.maxTraceSteps, "limits.maxTraceSteps", 1, 10_000_000),
      maxBodyBytes: whole(limits.maxBodyBytes, "limits.maxBodyBytes", 1, 100_000_000),
    },
  }
}

function parseSubmission(value: unknown): SubmissionResult {
  const body = record(value, "submission")
  const rankValue = body.rank
  const rank = rankValue === null || rankValue === undefined ? null : whole(rankValue, "rank", 1, 1_000_000)
  return {
    submissionId: text(body.submissionId, "submissionId"),
    runId: text(body.runId, "runId"),
    leagueId: text(body.leagueId, "leagueId"),
    date: text(body.date, "date"),
    rulesetVersion: whole(body.rulesetVersion, "rulesetVersion", 1, 1_000_000),
    assisted: bool(body.assisted, "assisted"),
    ranked: bool(body.ranked, "ranked"),
    verified: bool(body.verified, "verified"),
    verification: text(body.verification, "verification"),
    score: whole(body.score, "score", 0, 1_000_000_000),
    claimedScore: whole(body.claimedScore, "claimedScore", 0, 1_000_000_000),
    traceSteps: whole(body.traceSteps, "traceSteps", 1, 10_000_000),
    replayMs: whole(body.replayMs, "replayMs", 0, 10_000_000),
    submittedAt: text(body.submittedAt, "submittedAt"),
    rank,
  }
}

function bad(message: string): never {
  throw new ChallengeApiError("BAD_RESPONSE", `The challenge server sent an unusable answer: ${message}.`, false)
}

function record(value: unknown, name: string): Record<string, unknown> {
  const out = recordOrNull(value)
  if (!out) bad(`${name} is not an object`)
  return out
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) bad(`${name} is missing`)
  return value
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") bad(`${name} is not a boolean`)
  return value
}

function whole(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    bad(`${name} is not an integer in [${min}, ${max}]`)
  }
  return value
}

function time(value: unknown, name: string): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed)) bad(`${name} is not a date`)
  return parsed
}
