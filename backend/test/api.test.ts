import { describe, expect, it } from "vitest"
import { addDays, DAILY_RULESET_VERSION } from "../../game/daily.ts"
import { encodeTrace } from "../../game/runTrace.ts"
import { hmacHex, sha256Hex } from "../src/crypto.ts"
import { MAX_BODY_BYTES, RUN_TTL_MS } from "../src/daily.ts"
import { FIXED_NOW, call, jsonInit, leagueForTest, recordAutopilotRun, testEnv } from "./helpers.ts"

interface Descriptor {
  runId: string
  leagueId: string
  challenge: { date: string; seed: number; arena: string; difficulty: string; rulesetVersion: number }
  nonce: string
  issuedAt: string
  expiresAt: string
  assisted: boolean
  ranked: boolean
  submission: { path: string; token: string }
  limits: { maxTraceSteps: number; maxBodyBytes: number }
}

interface SubmissionResult {
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

const league = leagueForTest()
const recorded = recordAutopilotRun(league)

async function issue(
  env: Env,
  now = FIXED_NOW,
  assisted = false,
  actor = "203.0.113.10",
): Promise<Descriptor> {
  const response = await call(
    env,
    "/v1/daily/runs",
    jsonInit(assisted ? { assisted: true } : {}),
    now,
    actor,
  )
  expect(response.status).toBe(201)
  return (await response.json()) as Descriptor
}

function submissionBody(descriptor: Descriptor, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rulesetVersion: descriptor.challenge.rulesetVersion,
    nonce: descriptor.nonce,
    token: descriptor.submission.token,
    assisted: descriptor.assisted,
    claimedScore: recorded.score,
    trace: { format: "gwt1", data: recorded.trace },
    ...overrides,
  }
}

async function submit(
  env: Env,
  descriptor: Descriptor,
  body: Record<string, unknown>,
  key: string,
  now = FIXED_NOW,
  actor = "203.0.113.10",
): Promise<Response> {
  return call(
    env,
    descriptor.submission.path,
    jsonInit(body, { "idempotency-key": key }),
    now,
    actor,
  )
}

describe("daily API", () => {
  it("reports health and the configured ruleset", async () => {
    const { env } = testEnv()
    const response = await call(env, "/v1/health", {}, FIXED_NOW)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, rulesetVersion: DAILY_RULESET_VERSION })
  })

  it("issues a deterministic challenge with fresh randomness and an opaque token", async () => {
    const { env, db } = testEnv()
    const first = await issue(env)
    const second = await issue(env)

    expect(first.challenge).toEqual(second.challenge)
    expect(first.leagueId).toBe(`daily:${first.challenge.date}:v${DAILY_RULESET_VERSION}`)
    expect(first.runId).not.toBe(second.runId)
    expect(first.nonce).toMatch(/^[a-f0-9]{32}$/)
    expect(first.submission.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.submission.token).not.toBe(second.submission.token)
    expect(Date.parse(first.expiresAt) - Date.parse(first.issuedAt)).toBe(RUN_TTL_MS)
    expect(first.ranked).toBe(true)
    expect(first.assisted).toBe(false)

    const row = await db
      .prepare("SELECT token_hash, nonce_hash, consumed_at FROM runs WHERE id = ?")
      .bind(first.runId)
      .first<{ token_hash: string; nonce_hash: string; consumed_at: number | null }>()
    expect(row?.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(row?.token_hash).not.toBe(first.submission.token)
    expect(row?.nonce_hash).not.toBe(first.nonce)
    expect(row?.consumed_at).toBeNull()
  })

  it("accepts a replay-verified submission and stores the server score", async () => {
    const { env, db } = testEnv()
    const descriptor = await issue(env)
    const response = await submit(env, descriptor, submissionBody(descriptor), "key-verified-0001")
    expect(response.status).toBe(201)

    const body = (await response.json()) as SubmissionResult
    expect(body.verified).toBe(true)
    expect(body.verification).toBe("engine-replay")
    expect(body.score).toBe(recorded.score)
    expect(body.rank).toBe(1)
    expect(body.traceSteps).toBe(recorded.steps)
    expect(response.headers.get("server-timing")).toContain("replay;dur=")

    const row = await db
      .prepare("SELECT score, claimed_score, trace_steps, verified, ranked FROM submissions WHERE run_id = ?")
      .bind(descriptor.runId)
      .first<{ score: number; claimed_score: number; trace_steps: number; verified: number; ranked: number }>()
    expect(row).toMatchObject({
      score: recorded.score,
      claimed_score: recorded.score,
      trace_steps: recorded.steps,
      verified: 1,
      ranked: 1,
    })
  })

  it("uses the replayed score, not a claimed score inside the drift tolerance", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)
    const claimed = recorded.score + 1
    const response = await submit(env, descriptor, submissionBody(descriptor, { claimedScore: claimed }), "key-tolerance-0001")
    expect(response.status).toBe(201)
    const body = (await response.json()) as SubmissionResult
    expect(body.score).toBe(recorded.score)
    expect(body.claimedScore).toBe(claimed)
  })

  it("rejects a fabricated score without consuming the run, then accepts the honest retry", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)
    const rejected = await submit(
      env,
      descriptor,
      submissionBody(descriptor, { claimedScore: recorded.score + 5000 }),
      "key-fabricated-0001",
    )
    expect(rejected.status).toBe(422)
    expect(await rejected.json()).toMatchObject({ error: { code: "SCORE_MISMATCH" } })

    const retry = await submit(env, descriptor, submissionBody(descriptor), "key-honest-0001")
    expect(retry.status).toBe(201)
  })

  it("rejects a mismatched token or nonce", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)
    const wrongToken = await submit(
      env,
      descriptor,
      submissionBody(descriptor, { token: "x".repeat(43) }),
      "key-token-0001",
    )
    expect(wrongToken.status).toBe(403)
    expect(await wrongToken.json()).toMatchObject({ error: { code: "INVALID_BINDING" } })

    const wrongNonce = await submit(
      env,
      descriptor,
      submissionBody(descriptor, { nonce: "0".repeat(32) }),
      "key-nonce-0001",
    )
    expect(wrongNonce.status).toBe(403)

    // Binding rejection must happen before trace decoding.
    const badTokenBadTrace = await submit(
      env,
      descriptor,
      submissionBody(descriptor, { token: "x".repeat(43), trace: { format: "gwt1", data: "AAAA" } }),
      "key-binding-order-0001",
    )
    expect(badTokenBadTrace.status).toBe(403)
    expect(await badTokenBadTrace.json()).toMatchObject({ error: { code: "INVALID_BINDING" } })
  })

  it("rejects another client's run", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)
    const response = await submit(env, descriptor, submissionBody(descriptor), "key-other-0001", FIXED_NOW, "198.51.100.7")
    expect(response.status).toBe(403)
  })

  it("rejects an expired descriptor", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)
    const response = await submit(env, descriptor, submissionBody(descriptor), "key-expired-0001", FIXED_NOW + RUN_TTL_MS + 1)
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({ error: { code: "RUN_EXPIRED" } })
  })

  it("rejects a different ruleset or assisted marker", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)
    const ruleset = await submit(
      env,
      descriptor,
      submissionBody(descriptor, { rulesetVersion: DAILY_RULESET_VERSION + 1 }),
      "key-ruleset-0001",
    )
    expect(ruleset.status).toBe(409)
    expect(await ruleset.json()).toMatchObject({ error: { code: "RULESET_MISMATCH" } })

    const assisted = await submit(env, descriptor, submissionBody(descriptor, { assisted: true }), "key-assisted-0001")
    expect(assisted.status).toBe(409)
    expect(await assisted.json()).toMatchObject({ error: { code: "ASSISTED_MISMATCH" } })
  })

  it("stores an assisted run but keeps it off the ranked board", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env, FIXED_NOW, true)
    expect(descriptor.ranked).toBe(false)
    const response = await submit(env, descriptor, submissionBody(descriptor), "key-assisted-run-0001")
    expect(response.status).toBe(201)
    const body = (await response.json()) as SubmissionResult
    expect(body.assisted).toBe(true)
    expect(body.ranked).toBe(false)
    expect(body.rank).toBeNull()

    const board = await call(env, `/v1/daily/leaderboard?date=${descriptor.challenge.date}`, {}, FIXED_NOW)
    const data = (await board.json()) as { entries: unknown[] }
    expect(data.entries).toEqual([])
  })

  it("replays an idempotent retry and rejects a reused key with a different body", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)
    const body = submissionBody(descriptor)
    const first = await submit(env, descriptor, body, "key-idempotent-0001")
    expect(first.status).toBe(201)
    const firstJson = await first.text()

    const replay = await submit(env, descriptor, body, "key-idempotent-0001")
    expect(replay.status).toBe(201)
    expect(replay.headers.get("idempotent-replay")).toBe("true")
    expect(await replay.text()).toBe(firstJson)

    const conflict = await submit(env, descriptor, { ...body, claimedScore: body.claimedScore as number }, "key-idempotent-0001")
    expect(conflict.status).toBe(201)

    const different = await submit(
      env,
      descriptor,
      { ...body, claimedScore: (body.claimedScore as number) + 1 },
      "key-idempotent-0001",
    )
    expect(different.status).toBe(409)
    expect(await different.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } })
  })

  it("returns the first result for the same trace under a new key, and rejects a different trace", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)
    const body = submissionBody(descriptor)
    expect((await submit(env, descriptor, body, "key-first-0001")).status).toBe(201)

    const retry = await submit(env, descriptor, body, "key-second-0001")
    expect(retry.status).toBe(200)
    expect(retry.headers.get("idempotent-replay")).toBe("true")

    const differentTrace = await submit(
      env,
      descriptor,
      submissionBody(descriptor, {
        trace: { format: "gwt1", data: encodeTrace({ version: 1, steps: [{ ax: 0, ay: 0, pull: false, dash: false, repulse: false, ult: false }] }) },
      }),
      "key-third-0001",
    )
    expect(differentTrace.status).toBe(409)
    expect(await differentTrace.json()).toMatchObject({ error: { code: "RUN_ALREADY_SUBMITTED" } })
  })

  it("returns the stored response when a concurrent retry wins the idempotency race", async () => {
    const { env, db } = testEnv()
    const descriptor = await issue(env)
    // A higher score is already on the board, so this submission's live rank would be 2.
    await seedSubmission(db, descriptor.leagueId, "race", recorded.score + 50, FIXED_NOW - 5000, true)

    const key = "key-race-0001"
    const body = submissionBody(descriptor)
    const raw = JSON.stringify(body)
    const actorHash = await hmacHex("test-only-actor-key", "203.0.113.10")
    const keyHash = await sha256Hex(`${actorHash}:${descriptor.runId}:${key}`)
    const requestHash = await sha256Hex(raw)
    const storedBody = JSON.stringify({ stored: true, rank: 1 })
    await db
      .prepare(
        `INSERT INTO idempotency_keys
           (key_hash, actor_hash, request_hash, status, response_json, created_at, expires_at)
         VALUES (?, ?, ?, 201, ?, ?, ?)`,
      )
      .bind(keyHash, actorHash, requestHash, storedBody, FIXED_NOW, FIXED_NOW + 60_000)
      .run()

    // Simulate the race: the initial lookup misses, then the insert finds the other request's row.
    const racingEnv = { ...env, DB: hideFirstIdempotencyRead(db) } as Env
    const response = await call(
      racingEnv,
      descriptor.submission.path,
      jsonInit(body, { "idempotency-key": key }),
      FIXED_NOW,
    )
    expect(response.status).toBe(201)
    expect(response.headers.get("idempotent-replay")).toBe("true")
    expect(await response.text()).toBe(storedBody)
  })

  it("validates shape, headers, size and routes", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)

    const noKey = await call(env, descriptor.submission.path, jsonInit(submissionBody(descriptor)), FIXED_NOW)
    expect(noKey.status).toBe(400)
    expect(await noKey.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } })

    const badJson = await call(
      env,
      descriptor.submission.path,
      { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "key-bad-json-0001" }, body: "{" },
      FIXED_NOW,
    )
    expect(badJson.status).toBe(400)

    const badTrace = await submit(env, descriptor, submissionBody(descriptor, { trace: { format: "gwt1", data: "AAAA" } }), "key-badtrace-0001")
    expect(badTrace.status).toBe(422)
    expect(await badTrace.json()).toMatchObject({ error: { code: "TRACE_INVALID" } })

    const largeBody = "x".repeat(MAX_BODY_BYTES + 1)
    const tooLarge = await call(
      env,
      descriptor.submission.path,
      { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "key-large-0001" }, body: largeBody },
      FIXED_NOW,
    )
    expect(tooLarge.status).toBe(413)

    const wrongMethod = await call(env, "/v1/daily/runs", {}, FIXED_NOW)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("POST")

    const unknown = await call(env, "/v1/nope", {}, FIXED_NOW)
    expect(unknown.status).toBe(404)
  })

  it("orders the board deterministically and returns no PII", async () => {
    const { env, db } = testEnv()
    await issue(env) // creates the league row for today
    const leagueId = `daily:${league.date}:v${DAILY_RULESET_VERSION}`
    await seedSubmission(db, leagueId, "a", 30, FIXED_NOW - 3000, true)
    await seedSubmission(db, leagueId, "b", 30, FIXED_NOW - 2000, true)
    await seedSubmission(db, leagueId, "c", 20, FIXED_NOW - 1000, true)
    await seedSubmission(db, leagueId, "d", 99, FIXED_NOW - 500, false)

    const response = await call(env, `/v1/daily/leaderboard?date=${league.date}&limit=10`, {}, FIXED_NOW)
    expect(response.status).toBe(200)
    const data = (await response.json()) as {
      date: string
      leagueId: string
      entries: Array<{ rank: number; score: number; submittedAt: string; assisted: boolean }>
    }
    expect(data.date).toBe(league.date)
    expect(data.leagueId).toBe(leagueId)
    expect(data.entries.map((e) => [e.rank, e.score])).toEqual([
      [1, 30],
      [2, 30],
      [3, 20],
    ])
    expect(data.entries[0].submittedAt).toBe(new Date(FIXED_NOW - 3000).toISOString())
    expect(Object.keys(data.entries[0]).sort()).toEqual(["assisted", "rank", "score", "submittedAt"])
    expect(data.entries.every((e) => e.assisted === false)).toBe(true)
    expect(JSON.stringify(data)).not.toMatch(/token|nonce|actor|203\.0\.113/)
  })

  it("limits leaderboard history to the last 31 days", async () => {
    const { env } = testEnv()
    const today = league.date
    const tooOld = new Date(Date.parse(`${today}T00:00:00Z`) - 31 * 86_400_000).toISOString().slice(0, 10)
    const future = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

    expect((await call(env, `/v1/daily/leaderboard?date=${tooOld}`, {}, FIXED_NOW)).status).toBe(422)
    expect((await call(env, `/v1/daily/leaderboard?date=${future}`, {}, FIXED_NOW)).status).toBe(422)
    expect((await call(env, "/v1/daily/leaderboard?limit=0", {}, FIXED_NOW)).status).toBe(422)
  })

  it("returns 409, not 500, for a run stored under a previous ruleset", async () => {
    const { env, db } = testEnv()
    const descriptor = await issue(env)
    const oldLeagueId = `daily:${descriptor.challenge.date}:v0`
    await db
      .prepare(
        `INSERT INTO leagues (id, date, ruleset_version, seed, arena, difficulty, created_at)
         VALUES (?, ?, 0, 123, 'classic', 'normal', ?)`,
      )
      .bind(oldLeagueId, descriptor.challenge.date, FIXED_NOW)
      .run()
    await db.prepare(`UPDATE runs SET league_id = ? WHERE id = ?`).bind(oldLeagueId, descriptor.runId).run()

    const response = await submit(env, descriptor, submissionBody(descriptor), "key-oldruleset-0001")
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: "RULESET_MISMATCH", details: { run: 0, current: DAILY_RULESET_VERSION } },
    })
  })

  it("keeps leaderboard history for a stored previous ruleset", async () => {
    const { env, db } = testEnv()
    const historicalDate = addDays(league.date, -2)
    const oldLeagueId = `daily:${historicalDate}:v0`
    await db
      .prepare(
        `INSERT INTO leagues (id, date, ruleset_version, seed, arena, difficulty, created_at)
         VALUES (?, ?, 0, 123, 'classic', 'normal', ?)`,
      )
      .bind(oldLeagueId, historicalDate, FIXED_NOW)
      .run()
    const submittedAt = FIXED_NOW - 2 * 86_400_000
    await seedSubmission(db, oldLeagueId, "history", 42, submittedAt, true)

    const response = await call(env, `/v1/daily/leaderboard?date=${historicalDate}`, {}, FIXED_NOW)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      date: historicalDate,
      leagueId: oldLeagueId,
      rulesetVersion: 0,
      entries: [{ rank: 1, score: 42, submittedAt: new Date(submittedAt).toISOString(), assisted: false }],
    })
  })

  it("returns an empty board with no league id when a date has no stored league", async () => {
    const { env } = testEnv()
    const response = await call(env, "/v1/daily/leaderboard", {}, FIXED_NOW)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      date: league.date,
      leagueId: null,
      rulesetVersion: null,
      entries: [],
    })
  })

  it("validates a leaderboard read before consuming a rate-limit write", async () => {
    const { env, db } = testEnv()
    const writes = async () =>
      Number((await db.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>())?.n ?? 0)

    expect(await writes()).toBe(0)
    expect((await call(env, "/v1/daily/leaderboard?limit=0", {}, FIXED_NOW)).status).toBe(422)
    expect(await writes()).toBe(0)
    expect((await call(env, "/v1/daily/leaderboard?date=2026-02-30", {}, FIXED_NOW)).status).toBe(422)
    expect(await writes()).toBe(0)
  })

  it("rate-limits descriptor issuance per client", async () => {
    const { env } = testEnv()
    for (let i = 0; i < 6; i++) await issue(env)
    const blocked = await call(env, "/v1/daily/runs", jsonInit({}), FIXED_NOW)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("retry-after")).toBeTruthy()
    expect(await blocked.json()).toMatchObject({ error: { code: "RATE_LIMITED" } })
  })
})

async function seedSubmission(
  db: D1Database,
  leagueId: string,
  suffix: string,
  score: number,
  submittedAt: number,
  ranked: boolean,
): Promise<void> {
  const runId = `run-${suffix}`
  await db
    .prepare(
      `INSERT INTO runs (id, league_id, actor_hash, nonce_hash, token_hash, assisted, ranked, issued_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .bind(runId, leagueId, `actor-${suffix}`, `nonce-${suffix}`, `token-${suffix}`, ranked ? 1 : 0, submittedAt, submittedAt + 60_000, submittedAt)
    .run()
  await db
    .prepare(
      `INSERT INTO submissions
         (id, run_id, league_id, actor_hash, score, claimed_score, trace_hash, trace_steps,
          assisted, ranked, verified, submitted_at, replay_ms, engine)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 1, ?, 1, 'test')`,
    )
    .bind(`sub-${suffix}`, runId, leagueId, `actor-${suffix}`, score, score, `trace-${suffix}`, ranked ? 1 : 0, submittedAt)
    .run()
}

/**
 * Hide only the first idempotency SELECT so a test can insert the winning row between the
 * handler's initial lookup and its conditional insert.
 */
function hideFirstIdempotencyRead(db: D1Database): D1Database {
  let hidden = false
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (!hidden && sql.includes("FROM idempotency_keys")) {
            hidden = true
            return { bind: () => ({ first: async () => null }) } as unknown as D1PreparedStatement
          }
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as D1Database
}

describe("local CORS", () => {
  it("answers a loopback preflight and exposes the retry header to the page", async () => {
    const { env } = testEnv()
    const response = await call(
      env,
      "/v1/daily/runs/00000000-0000-4000-8000-000000000000/submissions",
      {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,idempotency-key",
        },
      },
      FIXED_NOW,
    )
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(response.headers.get("access-control-allow-headers")).toContain("idempotency-key")
    expect(response.headers.get("access-control-expose-headers")).toContain("idempotent-replay")
    expect(response.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/)
  })

  it("adds the allow-origin header to an ordinary read from a loopback page", async () => {
    const { env } = testEnv()
    for (const origin of ["http://127.0.0.1:3000", "http://[::1]:3000"]) {
      const response = await call(env, "/v1/health", { headers: { origin } }, FIXED_NOW)
      expect(response.status).toBe(200)
      expect(response.headers.get("access-control-allow-origin")).toBe(origin)
    }
  })

  it("leaves every other origin without CORS headers and refuses its preflight", async () => {
    const { env } = testEnv()
    const read = await call(env, "/v1/health", { headers: { origin: "https://gravity-warsio.vercel.app" } }, FIXED_NOW)
    expect(read.status).toBe(200)
    expect(read.headers.get("access-control-allow-origin")).toBeNull()

    const preflight = await call(
      env,
      "/v1/daily/runs",
      { method: "OPTIONS", headers: { origin: "https://gravity-warsio.vercel.app" } },
      FIXED_NOW,
    )
    expect(preflight.status).toBe(403)
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull()
    expect(await preflight.json()).toMatchObject({ error: { code: "CORS_FORBIDDEN" } })
  })

  it("still has no CORS headers when a request carries no origin at all", async () => {
    const { env } = testEnv()
    const response = await call(env, "/v1/health", {}, FIXED_NOW, "")
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })
})
