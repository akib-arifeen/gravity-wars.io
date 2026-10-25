// The client half of the daily API: base resolution, strict descriptor/answer parsing, and the
// refusal classification that decides whether a retry is offered. No browser needed.

import { describe, expect, it } from "vitest"
import { dailyChallenge } from "@/game/daily"
import { ChallengeApiError, createChallengeClient, resolveChallengeBase } from "../api"

const CHALLENGE = dailyChallenge(new Date("2026-10-26T12:00:00Z"))
const RUN_ID = "00000000-0000-4000-8000-000000000000"

function descriptorBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    leagueId: `daily:${CHALLENGE.key}:v1`,
    challenge: {
      date: CHALLENGE.key,
      seed: CHALLENGE.seed,
      arena: CHALLENGE.arena,
      difficulty: CHALLENGE.difficulty,
      rulesetVersion: 1,
    },
    nonce: "ab".repeat(16),
    issuedAt: "2026-10-26T12:00:00.000Z",
    expiresAt: "2026-10-26T14:00:00.000Z",
    assisted: false,
    ranked: true,
    submission: { path: `/v1/daily/runs/${RUN_ID}/submissions`, token: "t".repeat(43) },
    limits: { maxTraceSteps: 13_000, maxBodyBytes: 250_000 },
    ...overrides,
  }
}

function submissionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    submissionId: "11111111-1111-4111-8111-111111111111",
    runId: RUN_ID,
    leagueId: `daily:${CHALLENGE.key}:v1`,
    date: CHALLENGE.key,
    rulesetVersion: 1,
    assisted: false,
    ranked: true,
    verified: true,
    verification: "engine-replay",
    score: 73,
    claimedScore: 73,
    traceSteps: 9100,
    replayMs: 480,
    submittedAt: "2026-10-26T12:04:00.000Z",
    rank: 3,
    ...overrides,
  }
}

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(replies: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return replies(call)
  }
  return { fetchImpl: impl as typeof fetch, calls }
}

function client(fetchImpl: typeof fetch, base = "http://localhost:5173") {
  return createChallengeClient({ base, fetchImpl, timeoutMs: 50 })
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const errorResponse = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  jsonResponse({ error: { code, message, requestId: "req-1" } }, status, headers)

describe("resolveChallengeBase", () => {
  it("stays off when nothing is configured", () => {
    expect(resolveChallengeBase(undefined)).toEqual({ enabled: false, base: null, reason: null })
    expect(resolveChallengeBase("")).toEqual({ enabled: false, base: null, reason: null })
    expect(resolveChallengeBase("   ")).toEqual({ enabled: false, base: null, reason: null })
  })

  it("accepts a loopback origin and normalises it to the origin", () => {
    expect(resolveChallengeBase("http://localhost:5173")).toEqual({ enabled: true, base: "http://localhost:5173", reason: null })
    expect(resolveChallengeBase("http://localhost:5173/")).toEqual({ enabled: true, base: "http://localhost:5173", reason: null })
    expect(resolveChallengeBase(" http://127.0.0.1:8787/api ")).toEqual({
      enabled: true,
      base: "http://127.0.0.1:8787",
      reason: null,
    })
    expect(resolveChallengeBase("http://[::1]:5173")).toEqual({ enabled: true, base: "http://[::1]:5173", reason: null })
  })

  it("refuses a non-loopback host, a bad scheme, credentials and nonsense", () => {
    const remote = resolveChallengeBase("https://daily.example.com")
    expect(remote.enabled).toBe(false)
    expect(remote.base).toBeNull()
    expect(remote.reason).toContain("loopback")

    expect(resolveChallengeBase("ftp://localhost:5173").reason).toContain("http")
    expect(resolveChallengeBase("http://user:pw@localhost:5173").reason).toContain("credentials")
    expect(resolveChallengeBase("not a url").reason).toContain("valid URL")
  })
})

describe("descriptor", () => {
  it("posts the assisted declaration and returns the server's values untouched", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(descriptorBody({ assisted: true, ranked: false }), 201))
    const descriptor = await client(fetchImpl).issue(true)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://localhost:5173/v1/daily/runs")
    expect(calls[0].init.method).toBe("POST")
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json")
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ assisted: true })

    expect(descriptor.challenge).toEqual({
      date: CHALLENGE.key,
      seed: CHALLENGE.seed,
      arena: CHALLENGE.arena,
      difficulty: CHALLENGE.difficulty,
      rulesetVersion: 1,
    })
    expect(descriptor.assisted).toBe(true)
    expect(descriptor.ranked).toBe(false)
    expect(descriptor.submission.token).toHaveLength(43)
  })

  it("refuses a descriptor that would make the client invent its own seed, arena or skill", async () => {
    const broken = [
      descriptorBody({ challenge: undefined }),
      descriptorBody({ challenge: { date: CHALLENGE.key, seed: 0, arena: "classic", difficulty: "normal", rulesetVersion: 1 } }),
      descriptorBody({ challenge: { date: CHALLENGE.key, seed: 1, arena: "moon", difficulty: "normal", rulesetVersion: 1 } }),
      descriptorBody({ challenge: { date: CHALLENGE.key, seed: 1, arena: "classic", difficulty: "nightmare", rulesetVersion: 1 } }),
      descriptorBody({ challenge: { date: "26-10-2026", seed: 1, arena: "classic", difficulty: "normal", rulesetVersion: 1 } }),
      descriptorBody({ nonce: "nope" }),
      descriptorBody({ submission: { path: `/v1/daily/runs/${RUN_ID}/submissions`, token: "short" } }),
      descriptorBody({ submission: { path: "/v1/other", token: "t".repeat(43) } }),
      descriptorBody({ expiresAt: "2026-10-26T11:00:00.000Z" }),
      descriptorBody({ limits: { maxTraceSteps: 0, maxBodyBytes: 1 } }),
    ]
    for (const body of broken) {
      const { fetchImpl } = fakeFetch(() => jsonResponse(body, 201))
      await expect(client(fetchImpl).issue(false)).rejects.toMatchObject({ code: "BAD_RESPONSE", retryable: false })
    }
  })
})

describe("submission", () => {
  const descriptor = {
    runId: RUN_ID,
    leagueId: `daily:${CHALLENGE.key}:v1`,
    challenge: {
      date: CHALLENGE.key,
      seed: CHALLENGE.seed,
      arena: CHALLENGE.arena,
      difficulty: CHALLENGE.difficulty,
      rulesetVersion: 1,
    },
    nonce: "ab".repeat(16),
    issuedAt: "2026-10-26T12:00:00.000Z",
    expiresAt: "2026-10-26T14:00:00.000Z",
    assisted: false,
    ranked: true,
    submission: { path: `/v1/daily/runs/${RUN_ID}/submissions`, token: "t".repeat(43) },
    limits: { maxTraceSteps: 13_000, maxBodyBytes: 250_000 },
  }
  const input = { descriptor, traceData: "GWT1data", claimedScore: 73, idempotencyKey: "run-key-0001" }

  it("sends the contract body, the stable key, and returns the server's score and rank", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(submissionBody(), 201, { "idempotent-replay": "false" }))
    const outcome = await client(fetchImpl).submit(input)

    expect(calls[0].url).toBe(`http://localhost:5173/v1/daily/runs/${RUN_ID}/submissions`)
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get("idempotency-key")).toBe("run-key-0001")
    const body = JSON.parse(String(calls[0].init.body))
    expect(Object.keys(body).sort()).toEqual(["assisted", "claimedScore", "nonce", "rulesetVersion", "token", "trace"])
    expect(body).toMatchObject({
      rulesetVersion: 1,
      nonce: "ab".repeat(16),
      token: "t".repeat(43),
      assisted: false,
      claimedScore: 73,
      trace: { format: "gwt1", data: "GWT1data" },
    })
    expect(JSON.stringify(body)).not.toMatch(/name|email|ip|address/i)

    expect(outcome.result.score).toBe(73)
    expect(outcome.result.rank).toBe(3)
    expect(outcome.result.verified).toBe(true)
    expect(outcome.replayed).toBe(false)
  })

  it("reports an idempotent replay instead of pretending it scored twice", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(submissionBody(), 201, { "idempotent-replay": "true" }))
    const outcome = await client(fetchImpl).submit(input)
    expect(outcome.replayed).toBe(true)
    expect(outcome.result.score).toBe(73)
  })

  it("keeps the key and body byte-identical across a retry", async () => {
    let attempt = 0
    const { fetchImpl, calls } = fakeFetch(() => {
      attempt += 1
      if (attempt === 1) throw new TypeError("connection reset")
      return jsonResponse(submissionBody(), 200, { "idempotent-replay": "true" })
    })
    const api = client(fetchImpl)
    await expect(api.submit(input)).rejects.toMatchObject({ code: "NETWORK", retryable: true })
    const outcome = await api.submit(input)

    expect(calls).toHaveLength(2)
    expect(new Headers(calls[0].init.headers).get("idempotency-key")).toBe(
      new Headers(calls[1].init.headers).get("idempotency-key"),
    )
    expect(calls[0].init.body).toBe(calls[1].init.body)
    expect(outcome.replayed).toBe(true)
  })

  it("classifies refusals: retry only transport, 429 and 5xx", async () => {
    const cases: [Response, string, boolean, number | null][] = [
      [errorResponse(500, "INTERNAL_ERROR", "Internal error"), "INTERNAL_ERROR", true, null],
      [errorResponse(503, "DEPENDENCY_UNAVAILABLE", "Database is unavailable"), "DEPENDENCY_UNAVAILABLE", true, null],
      [errorResponse(429, "RATE_LIMITED", "Too many requests", { "retry-after": "7" }), "RATE_LIMITED", true, 7],
      [errorResponse(422, "SCORE_MISMATCH", "Replay does not match the claimed score"), "SCORE_MISMATCH", false, null],
      [errorResponse(409, "IDEMPOTENCY_CONFLICT", "Key was already used"), "IDEMPOTENCY_CONFLICT", false, null],
      [errorResponse(410, "RUN_EXPIRED", "Run descriptor has expired"), "RUN_EXPIRED", false, null],
    ]
    for (const [response, code, retryable, retryAfterS] of cases) {
      const { fetchImpl } = fakeFetch(() => response)
      const error = await client(fetchImpl)
        .submit(input)
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ChallengeApiError)
      expect(error).toMatchObject({ code, retryable, retryAfterS })
    }
  })

  it("refuses a malformed success answer instead of showing it as a verified score", async () => {
    for (const body of [
      submissionBody({ score: "73" }),
      submissionBody({ score: -1 }),
      submissionBody({ rank: 0 }),
      submissionBody({ verified: "yes" }),
      submissionBody({ submissionId: undefined }),
    ]) {
      const { fetchImpl } = fakeFetch(() => jsonResponse(body, 201))
      await expect(client(fetchImpl).submit(input)).rejects.toMatchObject({ code: "BAD_RESPONSE" })
    }
  })

  it("rejects a malformed idempotency key before it reaches the network", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(submissionBody(), 201))
    await expect(client(fetchImpl).submit({ ...input, idempotencyKey: "short" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_INVALID",
      retryable: false,
    })
    expect(calls).toHaveLength(0)
  })

  it("turns a hung server into a retryable timeout", async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
      })) as typeof fetch
    const api = createChallengeClient({ base: "http://localhost:5173", fetchImpl, timeoutMs: 20 })
    await expect(api.issue(false)).rejects.toMatchObject({ code: "NETWORK", retryable: true })
  })
})
