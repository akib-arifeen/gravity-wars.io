import { describe, expect, it } from "vitest"
import { addDays, DAILY_RULESET_VERSION } from "../../game/daily.ts"
import { encodeTrace } from "../../game/runTrace.ts"
import { sha256Hex } from "../src/crypto.ts"
import { MAX_BODY_BYTES, RUN_TTL_MS } from "../src/daily.ts"
import { REPLAY_LIMITS } from "../src/replay.ts"
import {
  ACTOR_A,
  ACTOR_B,
  FIXED_NOW,
  IP_A,
  IP_B,
  call,
  jsonInit,
  leagueForTest,
  recordAutopilotRun,
  testEnv,
} from "./helpers.ts"

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
  replayMs: number | null
  replayCached: boolean
  personalBest: boolean
  submittedAt: string
  rank: number | null
}

const league = leagueForTest()
const recorded = recordAutopilotRun(league)

async function issue(
  env: Env,
  now = FIXED_NOW,
  assisted = false,
  ip = IP_A,
  actorId = ACTOR_A,
): Promise<Descriptor> {
  const response = await call(
    env,
    "/v1/daily/runs",
    jsonInit(assisted ? { assisted: true } : {}),
    now,
    ip,
    actorId,
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
  ip = IP_A,
  actorId = ACTOR_A,
): Promise<Response> {
  return call(
    env,
    descriptor.submission.path,
    jsonInit(body, { "idempotency-key": key }),
    now,
    ip,
    actorId,
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
    expect(first.limits).toEqual({ maxTraceSteps: REPLAY_LIMITS.maxSteps, maxBodyBytes: MAX_BODY_BYTES })

    const row = await db
      .prepare("SELECT token_hash, nonce_hash, consumed_at, actor_id FROM runs WHERE id = ?")
      .bind(first.runId)
      .first<{ token_hash: string; nonce_hash: string; consumed_at: number | null; actor_id: string }>()
    expect(row?.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(row?.token_hash).not.toBe(first.submission.token)
    expect(row?.nonce_hash).not.toBe(first.nonce)
    expect(row?.consumed_at).toBeNull()
    // The binding is the client's own id, stored verbatim, not a hash of anything network-shaped.
    expect(row?.actor_id).toBe(ACTOR_A)
  })

  it("requires an opaque client id and refuses a malformed one before writing anything", async () => {
    const { env, db } = testEnv()
    const missing = await call(env, "/v1/daily/runs", jsonInit({}), FIXED_NOW, IP_A, "")
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ error: { code: "ACTOR_ID_REQUIRED" } })

    for (const bad of ["short", "g".repeat(32), "A1".repeat(16) + "0", "203.0.113.10"]) {
      const response = await call(env, "/v1/daily/runs", jsonInit({}), FIXED_NOW, IP_A, bad)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: "ACTOR_ID_INVALID" } })
    }

    const writes = await db.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>()
    expect(Number(writes?.n)).toBe(0)
    const runs = await db.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>()
    expect(Number(runs?.n)).toBe(0)
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
    expect(body.personalBest).toBe(true)
    expect(body.replayCached).toBe(false)
    expect(body.replayMs).toBeGreaterThanOrEqual(0)
    expect(body.traceSteps).toBe(recorded.steps)
    expect(response.headers.get("server-timing")).toContain("replay;dur=")

    const row = await db
      .prepare("SELECT score, claimed_score, trace_steps, verified, ranked, actor_id FROM submissions WHERE run_id = ?")
      .bind(descriptor.runId)
      .first<{
        score: number
        claimed_score: number
        trace_steps: number
        verified: number
        ranked: number
        actor_id: string
      }>()
    expect(row).toMatchObject({
      score: recorded.score,
      claimed_score: recorded.score,
      trace_steps: recorded.steps,
      verified: 1,
      ranked: 1,
      actor_id: ACTOR_A,
    })
  })

  it("binds a run to the client id, not to the address it was issued from", async () => {
    const { env } = testEnv()
    // Issued from one address, submitted from another: the browser moved, the run still belongs
    // to it. This is the whole point of the opaque id.
    const descriptor = await issue(env, FIXED_NOW, false, IP_A, ACTOR_A)
    const moved = await submit(env, descriptor, submissionBody(descriptor), "key-moved-network-1", FIXED_NOW, IP_B, ACTOR_A)
    expect(moved.status).toBe(201)

    const other = await issue(env, FIXED_NOW, false, IP_A, ACTOR_B)
    const stranger = await submit(env, other, submissionBody(other), "key-stranger-0001", FIXED_NOW, IP_A, ACTOR_A)
    expect(stranger.status).toBe(403)
    expect(await stranger.json()).toMatchObject({ error: { code: "INVALID_BINDING" } })
  })

  it("ignores the request address when deciding who a run belongs to", async () => {
    const { env, db } = testEnv()
    // Two different clients behind one address get independent runs and independent bindings.
    const one = await issue(env, FIXED_NOW, false, IP_A, ACTOR_A)
    const two = await issue(env, FIXED_NOW, false, IP_A, ACTOR_B)
    expect((await submit(env, two, submissionBody(two), "key-nat-b-0001", FIXED_NOW, IP_A, ACTOR_B)).status).toBe(201)
    const wrongActor = await submit(env, one, submissionBody(one), "key-nat-a-0001", FIXED_NOW, IP_A, ACTOR_B)
    expect(wrongActor.status).toBe(403)

    const rows = await db.prepare("SELECT actor_id FROM runs ORDER BY actor_id").all<{ actor_id: string }>()
    expect((rows.results ?? []).map((row) => row.actor_id)).toEqual([ACTOR_A, ACTOR_B])
    // Nothing in the run or the submission records the address it arrived from.
    const text = JSON.stringify(await db.prepare("SELECT * FROM submissions").all())
    expect(text).not.toContain(IP_A)
    expect(text).not.toContain(IP_B)
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
    const { env, db } = testEnv()
    const descriptor = await issue(env)
    const rejected = await submit(
      env,
      descriptor,
      submissionBody(descriptor, { claimedScore: recorded.score + 5000 }),
      "key-fabricated-0001",
    )
    expect(rejected.status).toBe(422)
    expect(await rejected.json()).toMatchObject({ error: { code: "SCORE_MISMATCH" } })

    // The rejected attempt still paid for one replay; the honest retry of the identical trace
    // reuses that result instead of replaying the round again. A reused result reports no
    // duration at all, rather than a 0 ms that would read as a free replay.
    const retry = await submit(env, descriptor, submissionBody(descriptor), "key-honest-0001")
    expect(retry.status).toBe(201)
    const retryBody = (await retry.json()) as SubmissionResult
    expect(retryBody.replayCached).toBe(true)
    expect(retryBody.replayMs).toBeNull()
    expect(retry.headers.get("server-timing")).toBe('replay;desc="cached"')

    const cache = await db
      .prepare("SELECT run_id, trace_hash, score, replay_ms FROM replay_cache WHERE run_id = ?")
      .bind(descriptor.runId)
      .first<{ run_id: string; trace_hash: string; score: number; replay_ms: number }>()
    expect(cache?.score).toBe(recorded.score)
    expect(cache?.trace_hash).toMatch(/^[a-f0-9]{64}$/)

    // The stored submission keeps the cost that produced the score, so nothing in D1 records a
    // cache hit as a 0 ms replay.
    const stored = await db
      .prepare("SELECT replay_ms FROM submissions WHERE run_id = ?")
      .bind(descriptor.runId)
      .first<{ replay_ms: number }>()
    expect(stored?.replay_ms).toBe(Number(cache?.replay_ms))
    expect(stored?.replay_ms).toBeGreaterThan(0)
  })

  it("keeps replayCached truthful across the first answer and its replays", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)
    const body = submissionBody(descriptor)

    const first = await submit(env, descriptor, body, "key-flags-first-01")
    const firstBody = (await first.json()) as SubmissionResult
    expect(firstBody).toMatchObject({ replayCached: false })
    expect(firstBody.replayMs).toBeGreaterThanOrEqual(0)

    // Same key, byte-identical body: the stored answer, unchanged, including its replay flags.
    const sameKey = await submit(env, descriptor, body, "key-flags-first-01")
    expect(sameKey.headers.get("idempotent-replay")).toBe("true")
    expect((await sameKey.json()) as SubmissionResult).toMatchObject({
      replayCached: false,
      replayMs: firstBody.replayMs,
    })

    // A new key on an already-submitted run reused that answer: this request replayed nothing.
    const newKey = await submit(env, descriptor, body, "key-flags-second-1")
    expect(newKey.status).toBe(200)
    expect((await newKey.json()) as SubmissionResult).toMatchObject({ replayCached: true, replayMs: null })
  })

  it("does not reuse a cached replay for a different trace", async () => {
    const { env, db } = testEnv()
    const descriptor = await issue(env)
    await submit(env, descriptor, submissionBody(descriptor, { claimedScore: recorded.score + 5000 }), "key-cache-miss-1")

    const other = submissionBody(descriptor, {
      trace: { format: "gwt1", data: encodeTrace({ version: 1, steps: [{ ax: 0, ay: 0, pull: false, dash: false, repulse: false, ult: false }] }) },
    })
    const short = await submit(env, descriptor, other, "key-cache-miss-2")
    // A different trace is a different key: it is replayed (and rejected), never answered from the
    // cache row the first trace wrote.
    expect(short.status).toBe(422)
    expect(await short.json()).toMatchObject({ error: { code: "TRACE_INCOMPLETE" } })

    const cache = await db.prepare("SELECT COUNT(*) AS n FROM replay_cache").first<{ n: number }>()
    expect(Number(cache?.n)).toBe(1)
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
    const response = await submit(env, descriptor, submissionBody(descriptor), "key-other-0001", FIXED_NOW, IP_B, ACTOR_B)
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
    expect(body.personalBest).toBe(false)

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

  it("keeps an idempotency key scoped to the client that used it", async () => {
    const { env } = testEnv()
    const descriptor = await issue(env)
    const body = submissionBody(descriptor)
    expect((await submit(env, descriptor, body, "key-scoped-0001")).status).toBe(201)

    // The same key text from a different browser is a different key: it cannot read the stored
    // response, and it is not the run's owner, so the run is refused.
    const other = await submit(env, descriptor, body, "key-scoped-0001", FIXED_NOW, IP_B, ACTOR_B)
    expect(other.status).toBe(403)
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
    await seedSubmission(db, descriptor.leagueId, "race", recorded.score + 50, FIXED_NOW - 5000, true, ACTOR_B)

    const key = "key-race-0001"
    const body = submissionBody(descriptor)
    const raw = JSON.stringify(body)
    const keyHash = await sha256Hex(`${ACTOR_A}:${descriptor.runId}:${key}`)
    const requestHash = await sha256Hex(raw)
    const storedBody = JSON.stringify({ stored: true, rank: 1 })
    await db
      .prepare(
        `INSERT INTO idempotency_keys
           (key_hash, actor_id, request_hash, status, response_json, created_at, expires_at)
         VALUES (?, ?, ?, 201, ?, ?, ?)`,
      )
      .bind(keyHash, ACTOR_A, requestHash, storedBody, FIXED_NOW, FIXED_NOW + 60_000)
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

  it("keeps exactly one submission when two requests race the same run", async () => {
    const { env, db } = testEnv()
    const descriptor = await issue(env)
    const body = submissionBody(descriptor)
    // Both requests pass the "already submitted?" check (the two reads are hidden), so both reach
    // the conditional insert. Only one may win; the loser must report the winner's submission.
    const racingEnv = { ...env, DB: hideFirstSubmissionReads(db, 2) } as Env

    const [first, second] = await Promise.all([
      call(racingEnv, descriptor.submission.path, jsonInit(body, { "idempotency-key": "key-race-a-0001" }), FIXED_NOW),
      call(racingEnv, descriptor.submission.path, jsonInit(body, { "idempotency-key": "key-race-b-0001" }), FIXED_NOW),
    ])

    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 201])
    const firstBody = (await first.json()) as SubmissionResult
    const secondBody = (await second.json()) as SubmissionResult
    expect(firstBody.submissionId).toBe(secondBody.submissionId)
    expect(firstBody.score).toBe(secondBody.score)

    const rows = await db
      .prepare("SELECT COUNT(*) AS n FROM submissions WHERE run_id = ?")
      .bind(descriptor.runId)
      .first<{ n: number }>()
    expect(Number(rows?.n)).toBe(1)
    const consumed = await db
      .prepare("SELECT consumed_at, submission_id FROM runs WHERE id = ?")
      .bind(descriptor.runId)
      .first<{ consumed_at: number | null; submission_id: string | null }>()
    expect(consumed?.consumed_at).toBe(FIXED_NOW)
    expect(consumed?.submission_id).toBe(firstBody.submissionId)
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
    await seedSubmission(db, leagueId, "a", 30, FIXED_NOW - 3000, true, ACTOR_A)
    await seedSubmission(db, leagueId, "b", 30, FIXED_NOW - 2000, true, "c3".repeat(16))
    await seedSubmission(db, leagueId, "c", 20, FIXED_NOW - 1000, true, "d4".repeat(16))
    await seedSubmission(db, leagueId, "d", 99, FIXED_NOW - 500, false, "e5".repeat(16))

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

  it("shows one board row per client — its best", async () => {
    const { env, db } = testEnv()
    const descriptor = await issue(env)
    const first = await submit(env, descriptor, submissionBody(descriptor), "key-best-first-01")
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as SubmissionResult
    expect(firstBody).toMatchObject({ personalBest: true, rank: 1 })

    // The same client later records a better run, stored directly so the test controls the score.
    const better = recorded.score + 25
    const leagueId = `daily:${league.date}:v${DAILY_RULESET_VERSION}`
    await seedSubmission(db, leagueId, "better", better, FIXED_NOW + 1000, true, ACTOR_A)

    // A third run by the same client is worse than its best, so it has no row and no rank.
    const third = await issue(env)
    const worse = await submit(env, third, submissionBody(third), "key-best-third-01")
    expect(worse.status).toBe(201)
    const worseBody = (await worse.json()) as SubmissionResult
    expect(worseBody.personalBest).toBe(false)
    expect(worseBody.rank).toBeNull()
    expect(worseBody.score).toBe(recorded.score)

    const board = await call(env, `/v1/daily/leaderboard?date=${league.date}`, {}, FIXED_NOW)
    const entries = ((await board.json()) as { entries: Array<{ rank: number; score: number }> }).entries
    // One row for this client — its best — not one per run.
    expect(entries).toEqual([{ rank: 1, score: better, submittedAt: new Date(FIXED_NOW + 1000).toISOString(), assisted: false }])

    // A different client takes its own row.
    const other = await issue(env, FIXED_NOW, false, IP_A, ACTOR_B)
    expect((await submit(env, other, submissionBody(other), "key-best-other-01", FIXED_NOW, IP_A, ACTOR_B)).status).toBe(201)
    const two = await call(env, `/v1/daily/leaderboard?date=${league.date}`, {}, FIXED_NOW)
    const rows = ((await two.json()) as { entries: Array<{ rank: number; score: number }> }).entries
    expect(rows.length).toBe(2)
    expect(rows[0]).toEqual({ rank: 1, score: better, submittedAt: new Date(FIXED_NOW + 1000).toISOString(), assisted: false })
    expect(rows[1]).toMatchObject({ rank: 2, score: recorded.score })
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
    await seedSubmission(db, oldLeagueId, "history", 42, submittedAt, true, ACTOR_A)

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

  it("answers a leaderboard read with no client id and no preflight", async () => {
    const { env } = testEnv()
    // A read needs no identity, so a browser can make it as a simple request: no custom header, no
    // OPTIONS round trip. Only the two POST routes require `x-gw-actor`.
    const response = await call(
      env,
      "/v1/daily/leaderboard",
      { headers: { origin: "http://localhost:3000" } },
      FIXED_NOW,
      IP_A,
      "",
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")

    const post = await call(env, "/v1/daily/runs", jsonInit({}), FIXED_NOW, IP_A, "")
    expect(post.status).toBe(400)
    expect(await post.json()).toMatchObject({ error: { code: "ACTOR_ID_REQUIRED" } })
  })

  it("stops writing rate-limit rows once a read budget is spent", async () => {
    const { env, db } = testEnv()
    await call(env, "/v1/daily/leaderboard", {}, FIXED_NOW)
    const first = await db
      .prepare("SELECT count FROM rate_limits WHERE bucket = 'read:minute'")
      .first<{ count: number }>()
    expect(Number(first?.count)).toBe(1)

    // Spend the window, then keep reading: each refusal must leave the stored count untouched.
    await db.prepare("UPDATE rate_limits SET count = 120 WHERE bucket = 'read:minute'").run()
    for (let i = 0; i < 3; i++) {
      const response = await call(env, "/v1/daily/leaderboard", {}, FIXED_NOW)
      expect(response.status).toBe(429)
      expect(response.headers.get("retry-after")).toBeTruthy()
    }
    const after = await db
      .prepare("SELECT count FROM rate_limits WHERE bucket = 'read:minute'")
      .first<{ count: number }>()
    expect(Number(after?.count)).toBe(120)
  })

  it("rate-limits descriptor issuance per client", async () => {
    const { env } = testEnv()
    for (let i = 0; i < 6; i++) await issue(env)
    const blocked = await call(env, "/v1/daily/runs", jsonInit({}), FIXED_NOW)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("retry-after")).toBeTruthy()
    expect(await blocked.json()).toMatchObject({ error: { code: "RATE_LIMITED" } })
  })

  it("rate-limits a reused address across different client ids", async () => {
    const { env } = testEnv()
    // Rotating the opaque id does not reset the abuse limit: the address is the limit subject.
    for (let i = 0; i < 3; i++) await issue(env, FIXED_NOW, false, IP_A, `f${i}`.repeat(16))
    for (let i = 3; i < 6; i++) await issue(env, FIXED_NOW, false, IP_A, `f${i}`.repeat(16))
    const blocked = await call(env, "/v1/daily/runs", jsonInit({}), FIXED_NOW, IP_A, "ff".repeat(16))
    expect(blocked.status).toBe(429)
    // A different address is a different bucket.
    const other = await call(env, "/v1/daily/runs", jsonInit({}), FIXED_NOW, IP_B, ACTOR_A)
    expect(other.status).toBe(201)
  })
})

async function seedSubmission(
  db: D1Database,
  leagueId: string,
  suffix: string,
  score: number,
  submittedAt: number,
  ranked: boolean,
  actorId = `actor-${suffix}`,
): Promise<void> {
  const runId = `run-${suffix}`
  await db
    .prepare(
      `INSERT INTO runs (id, league_id, actor_id, nonce_hash, token_hash, assisted, ranked, issued_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .bind(runId, leagueId, actorId, `nonce-${suffix}`, `token-${suffix}`, ranked ? 1 : 0, submittedAt, submittedAt + 60_000, submittedAt)
    .run()
  await db
    .prepare(
      `INSERT INTO submissions
         (id, run_id, league_id, actor_id, score, claimed_score, trace_hash, trace_steps,
          assisted, ranked, verified, submitted_at, replay_ms, engine)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 1, ?, 1, 'test')`,
    )
    .bind(`sub-${suffix}`, runId, leagueId, actorId, score, score, `trace-${suffix}`, ranked ? 1 : 0, submittedAt)
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

/** Hide the first `count` "has this run been submitted?" reads, so every racer reaches the insert. */
function hideFirstSubmissionReads(db: D1Database, count: number): D1Database {
  let hidden = 0
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (hidden < count && sql.includes("FROM submissions WHERE run_id")) {
            hidden++
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
          "access-control-request-headers": "content-type,idempotency-key,x-gw-actor",
        },
      },
      FIXED_NOW,
    )
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(response.headers.get("access-control-allow-headers")).toContain("idempotency-key")
    expect(response.headers.get("access-control-allow-headers")).toContain("x-gw-actor")
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
