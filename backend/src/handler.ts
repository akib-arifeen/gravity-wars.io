import { DAILY_RULESET_VERSION, addDays, dateKey, dayNumber } from "../../game/daily.ts"
import { hmacHex, sha256Hex, timingSafeEqualHex } from "./crypto.ts"
import {
  MAX_BODY_BYTES,
  createRun,
  leagueFor,
  type League,
  type RunRow,
} from "./daily.ts"
import {
  deleteIdempotency,
  ensureLeague,
  getLeaderboard,
  getIdempotency,
  getLatestLeagueForDate,
  getLeagueById,
  getRun,
  getSubmissionByRun,
  insertIdempotency,
  insertRun,
  insertSubmissionIfOpen,
  rankBefore,
  type IdempotencyRow,
  type SubmissionRow,
} from "./db.ts"
import { HttpError, errorResponse, json, readJsonBody, structuredError, structuredLog } from "./http.ts"
import { RATE_RULES, rateHeaders, takeRateLimit } from "./rate.ts"
import { ReplayError, replayDailyRun, type ReplayOutcome } from "./replay.ts"
import { decodeSubmissionTrace, parseIssueInput, parseSubmissionBinding, type SubmissionBinding } from "./validate.ts"

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const LEADERBOARD_HISTORY_DAYS = 31
const MAX_ISSUE_BODY_BYTES = 4 * 1024
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface HandlerOptions {
  /** Injectable clock for tests; production uses Date.now. */
  now?: () => number
}

export async function handle(request: Request, env: Env, options: HandlerOptions = {}): Promise<Response> {
  const started = performance.now()
  const requestId = crypto.randomUUID()
  const now = options.now ? options.now() : Date.now()
  const url = new URL(request.url)
  let response: Response
  try {
    response = await route(request, env, url, now, requestId)
  } catch (error) {
    if (error instanceof HttpError) {
      response = errorResponse(error, requestId)
    } else {
      structuredError("request_error", {
        requestId,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
      response = errorResponse(new HttpError(500, "INTERNAL_ERROR", "Internal error"), requestId)
    }
  }
  response.headers.set("x-request-id", requestId)
  structuredLog("request", {
    requestId,
    method: request.method,
    path: url.pathname,
    status: response.status,
    ms: Math.round(performance.now() - started),
  })
  return response
}

async function route(
  request: Request,
  env: Env,
  url: URL,
  now: number,
  requestId: string,
): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/"
  if (path === "/v1/health") {
    requireMethod(request, ["GET"])
    return health(env, now)
  }
  if (path === "/v1/daily/runs") {
    requireMethod(request, ["POST"])
    return issueRun(request, env, now, requestId)
  }
  if (path === "/v1/daily/leaderboard") {
    requireMethod(request, ["GET"])
    return leaderboard(request, env, url, now)
  }
  const submission = /^\/v1\/daily\/runs\/([^/]+)\/submissions$/.exec(path)
  if (submission) {
    requireMethod(request, ["POST"])
    const runId = submission[1]
    if (!UUID_V4.test(runId)) throw new HttpError(404, "NOT_FOUND", "Unknown run")
    return submitRun(request, env, runId, now, requestId)
  }
  throw new HttpError(404, "NOT_FOUND", "Unknown endpoint")
}

async function health(env: Env, now: number): Promise<Response> {
  try {
    await env.DB.prepare("SELECT 1").first()
  } catch {
    throw new HttpError(503, "DEPENDENCY_UNAVAILABLE", "Database is unavailable")
  }
  return json({
    ok: true,
    rulesetVersion: DAILY_RULESET_VERSION,
    now: new Date(now).toISOString(),
  })
}

async function issueRun(request: Request, env: Env, now: number, requestId: string): Promise<Response> {
  const actorHash = await actorKey(env, request)
  const minute = await takeRateLimit(env.DB, RATE_RULES.issueMinute, actorHash, now)
  await takeRateLimit(env.DB, RATE_RULES.issueDay, actorHash, now)

  const { value } = await readJsonBody(request, MAX_ISSUE_BODY_BYTES, { allowEmpty: true })
  const input = parseIssueInput(value)
  const league = leagueFor(new Date(now))
  const { descriptor, run } = await createRun(now, input.assisted, actorHash)
  await ensureLeague(env.DB, league, now)
  await insertRun(env.DB, run)

  structuredLog("run_issued", {
    requestId,
    runId: run.id,
    leagueId: league.id,
    assisted: input.assisted,
  })
  return json(descriptor, 201, {
    ...rateHeaders(minute),
    location: `/v1/daily/runs/${run.id}`,
  })
}

async function submitRun(
  request: Request,
  env: Env,
  runId: string,
  now: number,
  requestId: string,
): Promise<Response> {
  const actorHash = await actorKey(env, request)
  const idempotencyKey = request.headers.get("idempotency-key")
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200 || !/^[\x21-\x7e]+$/.test(idempotencyKey)) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key must be 8-200 visible ASCII characters")
  }
  const keyHash = await sha256Hex(`${actorHash}:${runId}:${idempotencyKey}`)

  const { raw, value } = await readJsonBody(request, MAX_BODY_BYTES)
  const requestHash = await sha256Hex(raw)

  const prior = await getIdempotency(env.DB, keyHash)
  if (prior) {
    if (prior.expires_at > now) {
      if (prior.request_hash !== requestHash) {
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different body")
      }
      return storedResponse(prior)
    }
    await deleteIdempotency(env.DB, keyHash)
  }

  const minute = await takeRateLimit(env.DB, RATE_RULES.submitMinute, actorHash, now)
  await takeRateLimit(env.DB, RATE_RULES.submitDay, actorHash, now)

  // Cheap shape and binding checks first; the trace is decoded only after the run, actor,
  // ruleset, assisted flag and nonce/token have all been accepted.
  const input = parseSubmissionBinding(value)
  const run = await getRun(env.DB, runId)
  if (!run) throw new HttpError(404, "RUN_NOT_FOUND", "Unknown run")
  if (run.actorHash !== actorHash) throw new HttpError(403, "INVALID_BINDING", "Run does not belong to this client")
  if (now > run.expiresAt) throw new HttpError(410, "RUN_EXPIRED", "Run descriptor has expired")

  const league = await getLeagueById(env.DB, run.leagueId)
  if (!league) throw new HttpError(500, "INTERNAL_ERROR", "Stored run has no league")
  if (league.rulesetVersion !== DAILY_RULESET_VERSION) {
    throw new HttpError(409, "RULESET_MISMATCH", "Run was issued under a previous ruleset", {
      details: { run: league.rulesetVersion, current: DAILY_RULESET_VERSION },
    })
  }
  if (input.rulesetVersion !== league.rulesetVersion) {
    throw new HttpError(409, "RULESET_MISMATCH", "Submitted ruleset does not match the run", {
      details: { run: league.rulesetVersion, submitted: input.rulesetVersion },
    })
  }
  if (run.assisted !== input.assisted) {
    throw new HttpError(409, "ASSISTED_MISMATCH", "assisted must match the value declared when the run was issued")
  }

  const [nonceHash, tokenHash] = await Promise.all([sha256Hex(input.nonce), sha256Hex(input.token)])
  if (!timingSafeEqualHex(nonceHash, run.nonceHash) || !timingSafeEqualHex(tokenHash, run.tokenHash)) {
    throw new HttpError(403, "INVALID_BINDING", "Run binding does not match")
  }

  const traceHash = await sha256Hex(input.traceData)
  const existing = await getSubmissionByRun(env.DB, runId)
  if (existing) {
    return replayExisting(env.DB, existing, league, traceHash, requestHash, keyHash, actorHash, now)
  }

  const trace = decodeSubmissionTrace(input)
  const outcome = replayOrThrow(league, trace.steps)
  const tolerance = Math.max(1, Math.round(outcome.score * 0.002))
  if (Math.abs(input.claimedScore - outcome.score) > tolerance) {
    structuredLog("submission_mismatch", {
      requestId,
      runId,
      claimed: input.claimedScore,
      server: outcome.score,
      tolerance,
    })
    throw new HttpError(422, "SCORE_MISMATCH", "Replay does not match the claimed score", {
      details: { claimed: input.claimedScore, server: outcome.score, tolerance },
    })
  }

  const submissionId = crypto.randomUUID()
  const ranked = run.ranked && !input.assisted
  const rank = ranked ? await rankBefore(env.DB, run.leagueId, outcome.score, now, submissionId) : null
  const row = submissionRow(run, input, trace.steps.length, outcome, submissionId, traceHash, now, ranked)
  const inserted = await insertSubmissionIfOpen(env.DB, row, now)
  if (!inserted) {
    const raced = await getSubmissionByRun(env.DB, runId)
    if (raced) return replayExisting(env.DB, raced, league, traceHash, requestHash, keyHash, actorHash, now)
    throw new HttpError(409, "RUN_ALREADY_SUBMITTED", "Run was already submitted")
  }

  const body = submissionBody(row, league, rank)
  const stored = await rememberIdempotency(env.DB, keyHash, requestHash, 201, JSON.stringify(body), actorHash, now)
  if (stored) return storedResponse(stored)
  structuredLog("submission_verified", {
    requestId,
    runId,
    submissionId,
    leagueId: run.leagueId,
    score: outcome.score,
    claimed: input.claimedScore,
    steps: trace.steps.length,
    replayMs: outcome.replayMs,
    ranked,
  })
  return json(body, 201, { ...rateHeaders(minute), "server-timing": `replay;dur=${outcome.replayMs}` })
}

async function leaderboard(request: Request, env: Env, url: URL, now: number): Promise<Response> {
  const today = dateKey(new Date(now))
  const requested = url.searchParams.get("date") ?? today
  const requestedDay = dayNumber(requested)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(requested) ||
    !Number.isFinite(requestedDay) ||
    dateKey(new Date(requestedDay * 86_400_000)) !== requested
  ) {
    throw new HttpError(422, "INVALID_REQUEST", "date must be a real YYYY-MM-DD UTC date")
  }
  const age = dayNumber(today) - requestedDay
  if (age < 0 || age >= LEADERBOARD_HISTORY_DAYS) {
    throw new HttpError(422, "INVALID_REQUEST", `date must be within the last ${LEADERBOARD_HISTORY_DAYS} days`, {
      details: { oldest: addDays(today, -(LEADERBOARD_HISTORY_DAYS - 1)), newest: today },
    })
  }

  const limitParam = url.searchParams.get("limit")
  const limit = limitParam === null ? 10 : Number(limitParam)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new HttpError(422, "INVALID_REQUEST", "limit must be an integer in [1, 50]")
  }

  // Validation is complete before the first D1 write, so an invalid read cannot consume quota.
  const actorHash = await actorKey(env, request)
  const hit = await takeRateLimit(env.DB, RATE_RULES.readMinute, actorHash, now)

  // Resolve the stored league for the date, so history stays readable after a ruleset bump.
  const league = await getLatestLeagueForDate(env.DB, requested)
  const rows = league ? await getLeaderboard(env.DB, league.id, limit) : []
  return json(
    {
      date: requested,
      leagueId: league?.id ?? null,
      rulesetVersion: league?.rulesetVersion ?? null,
      entries: rows.map((row, index) => ({
        rank: index + 1,
        score: Number(row.score),
        submittedAt: new Date(Number(row.submitted_at)).toISOString(),
        assisted: Number(row.assisted) === 1,
      })),
      generatedAt: new Date(now).toISOString(),
    },
    200,
    rateHeaders(hit),
  )
}

function replayOrThrow(league: League, steps: Parameters<typeof replayDailyRun>[1]): ReplayOutcome {
  try {
    return replayDailyRun(league, steps)
  } catch (error) {
    if (error instanceof ReplayError) throw new HttpError(422, error.code, error.message)
    throw error
  }
}

function submissionRow(
  run: RunRow,
  input: SubmissionBinding,
  traceSteps: number,
  outcome: ReplayOutcome,
  id: string,
  traceHash: string,
  now: number,
  ranked: boolean,
): SubmissionRow {
  return {
    id,
    run_id: run.id,
    league_id: run.leagueId,
    actor_hash: run.actorHash,
    score: outcome.score,
    claimed_score: input.claimedScore,
    trace_hash: traceHash,
    trace_steps: traceSteps,
    assisted: input.assisted ? 1 : 0,
    ranked: ranked ? 1 : 0,
    verified: 1,
    submitted_at: now,
    replay_ms: outcome.replayMs,
    engine: `gravity-wars:${DAILY_RULESET_VERSION}`,
  }
}

function submissionBody(row: SubmissionRow, league: League, rank: number | null): Record<string, unknown> {
  return {
    submissionId: row.id,
    runId: row.run_id,
    leagueId: league.id,
    date: league.date,
    rulesetVersion: league.rulesetVersion,
    assisted: row.assisted === 1,
    ranked: row.ranked === 1,
    verified: row.verified === 1,
    verification: "engine-replay",
    score: row.score,
    claimedScore: row.claimed_score,
    traceSteps: row.trace_steps,
    replayMs: row.replay_ms,
    submittedAt: new Date(row.submitted_at).toISOString(),
    rank,
  }
}

async function replayExisting(
  db: D1Database,
  existing: SubmissionRow,
  league: League,
  traceHash: string,
  requestHash: string,
  keyHash: string,
  actorHash: string,
  now: number,
): Promise<Response> {
  if (existing.trace_hash !== traceHash) {
    throw new HttpError(409, "RUN_ALREADY_SUBMITTED", "Run was already submitted with a different trace", {
      details: { submissionId: existing.id },
    })
  }
  const rank =
    existing.ranked === 1
      ? await rankBefore(db, existing.league_id, existing.score, existing.submitted_at, existing.id)
      : null
  const body = submissionBody(existing, league, rank)
  const stored = await rememberIdempotency(db, keyHash, requestHash, 200, JSON.stringify(body), actorHash, now)
  if (stored) return storedResponse(stored)
  return json(body, 200, { "idempotent-replay": "true" })
}

/**
 * Store this response for the key. Returns the row another request already stored when this
 * request loses the race: a concurrent honest retry of the same body must replay the stored
 * response even if the leaderboard rank moved between the two submissions.
 */
async function rememberIdempotency(
  db: D1Database,
  keyHash: string,
  requestHash: string,
  status: number,
  body: string,
  actorHash: string,
  now: number,
): Promise<IdempotencyRow | null> {
  const inserted = await insertIdempotency(db, {
    key_hash: keyHash,
    actor_hash: actorHash,
    request_hash: requestHash,
    status,
    response_json: body,
    created_at: now,
    expires_at: now + IDEMPOTENCY_TTL_MS,
  })
  if (inserted) return null
  const prior = await getIdempotency(db, keyHash)
  if (!prior) throw new HttpError(500, "INTERNAL_ERROR", "Idempotency record could not be read after a conflict")
  if (prior.request_hash !== requestHash) {
    throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different body")
  }
  return prior
}

function storedResponse(prior: IdempotencyRow): Response {
  return new Response(prior.response_json, {
    status: prior.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "idempotent-replay": "true",
    },
  })
}

async function actorKey(env: Env, request: Request): Promise<string> {
  if (!env.ACTOR_HASH_KEY) {
    throw new HttpError(500, "CONFIGURATION_ERROR", "ACTOR_HASH_KEY is not configured")
  }
  const forwarded = request.headers.get("cf-connecting-ip") ?? "local"
  return hmacHex(env.ACTOR_HASH_KEY, forwarded.trim().toLowerCase() || "local")
}

function requireMethod(request: Request, allowed: string[]): void {
  if (!allowed.includes(request.method)) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", `Allowed: ${allowed.join(", ")}`, { allow: allowed.join(", ") })
  }
}
