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
  getReplayCache,
  getRun,
  getSubmissionByRun,
  insertIdempotency,
  insertRun,
  insertSubmissionIfOpen,
  putReplayCache,
  rankOfSubmission,
  type IdempotencyRow,
  type ReplayCacheRow,
  type SubmissionRank,
  type SubmissionRow,
} from "./db.ts"
import { HttpError, errorResponse, corsHeaders, isLoopbackOrigin, json, readJsonBody, structuredError, structuredLog } from "./http.ts"
import { RATE_RULES, rateHeaders, takeRateLimit, takeReadRateLimit } from "./rate.ts"
import { ReplayError, replayDailyRun, type ReplayOutcome } from "./replay.ts"
import {
  decodeSubmissionTrace,
  parseActorId,
  parseIssueInput,
  parseSubmissionBinding,
  type SubmissionBinding,
} from "./validate.ts"

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const LEADERBOARD_HISTORY_DAYS = 31
const MAX_ISSUE_BODY_BYTES = 4 * 1024
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface HandlerOptions {
  /** Injectable clock for tests; production uses Date.now. */
  now?: () => number
}

/** What a response may say about the replay behind its score. */
interface ReplayReport {
  /** True when this request reused a stored result instead of replaying the round. */
  cached: boolean
  /** The duration this request spent replaying, or null when it spent none. */
  ms: number | null
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
  for (const [name, value] of Object.entries(corsHeaders(request.headers.get("origin")))) {
    response.headers.set(name, value)
  }
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
  // Local development serves the game from another port, so a loopback page needs a preflight.
  // Anything else keeps the previous behaviour: no CORS headers, no extra routes.
  if (request.method === "OPTIONS") {
    if (!isLoopbackOrigin(request.headers.get("origin"))) {
      throw new HttpError(403, "CORS_FORBIDDEN", "Cross-origin requests are only allowed from loopback origins")
    }
    if (!path.startsWith("/v1/")) throw new HttpError(404, "NOT_FOUND", "Unknown endpoint")
    return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) })
  }
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
  // The id is the client's own and is checked before anything is written; the IP hash below is
  // only how this request is rate limited.
  const actorId = parseActorId(request)
  const ipHash = await clientIpHash(env, request)
  const minute = await takeRateLimit(env.DB, RATE_RULES.issueMinute, ipHash, now)
  await takeRateLimit(env.DB, RATE_RULES.issueDay, ipHash, now)

  const { value } = await readJsonBody(request, MAX_ISSUE_BODY_BYTES, { allowEmpty: true })
  const input = parseIssueInput(value)
  const league = leagueFor(new Date(now))
  const { descriptor, run } = await createRun(now, input.assisted, actorId)
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
  const actorId = parseActorId(request)
  const idempotencyKey = request.headers.get("idempotency-key")
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200 || !/^[\x21-\x7e]+$/.test(idempotencyKey)) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key must be 8-200 visible ASCII characters")
  }
  // Keyed to the client's own id, so an idempotent retry is recognised for this browser only.
  const keyHash = await sha256Hex(`${actorId}:${runId}:${idempotencyKey}`)

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

  const ipHash = await clientIpHash(env, request)
  const minute = await takeRateLimit(env.DB, RATE_RULES.submitMinute, ipHash, now)
  await takeRateLimit(env.DB, RATE_RULES.submitDay, ipHash, now)

  // Cheap shape and binding checks first; the trace is decoded only after the run, actor,
  // ruleset, assisted flag and nonce/token have all been accepted.
  const input = parseSubmissionBinding(value)
  const run = await getRun(env.DB, runId)
  if (!run) throw new HttpError(404, "RUN_NOT_FOUND", "Unknown run")
  if (run.actorId !== actorId) throw new HttpError(403, "INVALID_BINDING", "Run does not belong to this client")
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
    return replayExisting(env.DB, existing, league, traceHash, requestHash, keyHash, actorId, now)
  }

  // A repeated identical trace reuses the engine's earlier answer for this run, so a client that
  // fixed a rejected claim cannot make the Worker replay the round again. Any other trace for this
  // run misses the cache and goes through the capped replay below.
  const cached = await getReplayCache(env.DB, runId, traceHash, league.id, league.rulesetVersion)
  let outcome: ReplayOutcome
  let traceSteps: number
  /** What this request may report about its own replay: a cache hit spent none of it. */
  let replay: ReplayReport
  if (cached) {
    outcome = outcomeFromCache(cached)
    traceSteps = cached.trace_steps
    replay = { cached: true, ms: null }
  } else {
    const trace = decodeSubmissionTrace(input)
    outcome = replayOrThrow(league, trace.steps)
    traceSteps = trace.steps.length
    await putReplayCache(env.DB, cacheRowFor(run, traceHash, league, outcome, traceSteps, now))
    replay = { cached: false, ms: outcome.replayMs }
  }

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
  const row = submissionRow(run, input, traceSteps, outcome, submissionId, traceHash, now, ranked)
  const inserted = await insertSubmissionIfOpen(env.DB, row, now)
  if (!inserted) {
    const raced = await getSubmissionByRun(env.DB, runId)
    if (raced) return replayExisting(env.DB, raced, league, traceHash, requestHash, keyHash, actorId, now)
    throw new HttpError(409, "RUN_ALREADY_SUBMITTED", "Run was already submitted")
  }

  // Read the standing after the row exists: the board keeps one row per actor, so this
  // submission's place is its position among the actors' bests, not its position in raw rows.
  const standing = ranked ? await rankOfSubmission(env.DB, submissionId) : null
  const body = submissionBody(row, league, standing, replay)
  const stored = await rememberIdempotency(env.DB, keyHash, requestHash, 201, JSON.stringify(body), actorId, now)
  if (stored) return storedResponse(stored)
  structuredLog("submission_verified", {
    requestId,
    runId,
    submissionId,
    leagueId: run.leagueId,
    score: outcome.score,
    claimed: input.claimedScore,
    steps: traceSteps,
    // The replay that produced the score, and whether this request paid for it.
    replayMs: row.replay_ms,
    replayCached: replay.cached,
    ranked,
  })
  return json(body, 201, {
    ...rateHeaders(minute),
    // A cache hit reports that it reused a result rather than claiming a rounded-down 0 ms replay.
    "server-timing": replay.ms === null ? 'replay;desc="cached"' : `replay;dur=${replay.ms}`,
  })
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

  // Validation is complete before the first D1 write, and the read limiter writes only while the
  // window still has room, so an invalid or already-refused read costs nothing.
  const ipHash = await clientIpHash(env, request)
  const hit = await takeReadRateLimit(env.DB, RATE_RULES.readMinute, ipHash, now)

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
    if (error instanceof ReplayError) {
      // The CPU backstop is a server limit, not a bad trace: 503 says "try again", not "send
      // something else", and no score is produced either way.
      if (error.code === "REPLAY_BUDGET_EXCEEDED") {
        throw new HttpError(503, error.code, error.message, { retryAfter: 1 })
      }
      throw new HttpError(422, error.code, error.message)
    }
    throw error
  }
}

function outcomeFromCache(row: ReplayCacheRow): ReplayOutcome {
  return {
    score: Number(row.score),
    peakMass: Number(row.peak_mass),
    ticks: Number(row.ticks),
    durationS: Number(row.duration_s),
    winnerId: row.winner_id,
    // The cost that produced this score, kept so the stored submission records a real provenance
    // and never a 0 ms that would read as "replaying is free".
    replayMs: Number(row.replay_ms),
  }
}

function cacheRowFor(
  run: RunRow,
  traceHash: string,
  league: League,
  outcome: ReplayOutcome,
  traceSteps: number,
  now: number,
): ReplayCacheRow {
  return {
    run_id: run.id,
    trace_hash: traceHash,
    league_id: league.id,
    ruleset_version: league.rulesetVersion,
    score: outcome.score,
    peak_mass: outcome.peakMass,
    ticks: outcome.ticks,
    trace_steps: traceSteps,
    duration_s: outcome.durationS,
    winner_id: outcome.winnerId,
    replay_ms: outcome.replayMs,
    created_at: now,
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
    actor_id: run.actorId,
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

function submissionBody(
  row: SubmissionRow,
  league: League,
  standing: SubmissionRank | null,
  replay: ReplayReport,
): Record<string, unknown> {
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
    // Null, not 0, when this request reused a stored result: no replay ran, so there is no
    // duration to report and none should be inferred.
    replayMs: replay.ms,
    replayCached: replay.cached,
    // The board keeps one row per actor: a run that is not this actor's best has no row and no
    // rank, and `personalBest: false` says why rather than leaving the client to guess.
    personalBest: standing === null ? false : standing.best,
    rank: standing === null ? null : standing.rank,
    submittedAt: new Date(row.submitted_at).toISOString(),
  }
}

async function replayExisting(
  db: D1Database,
  existing: SubmissionRow,
  league: League,
  traceHash: string,
  requestHash: string,
  keyHash: string,
  actorId: string,
  now: number,
): Promise<Response> {
  if (existing.trace_hash !== traceHash) {
    throw new HttpError(409, "RUN_ALREADY_SUBMITTED", "Run was already submitted with a different trace", {
      details: { submissionId: existing.id },
    })
  }
  const standing = existing.ranked === 1 ? await rankOfSubmission(db, existing.id) : null
  // This request did not replay either: it found the run already submitted and reused that answer.
  const body = submissionBody(existing, league, standing, { cached: true, ms: null })
  const stored = await rememberIdempotency(db, keyHash, requestHash, 200, JSON.stringify(body), actorId, now)
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
  actorId: string,
  now: number,
): Promise<IdempotencyRow | null> {
  const inserted = await insertIdempotency(db, {
    key_hash: keyHash,
    actor_id: actorId,
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

/**
 * The rate-limit subject: an HMAC of the request IP under a Worker secret. The raw address is
 * never stored or logged, and nothing else in this API reads it — identity comes from the
 * client's own opaque id, so a changed or shared address does not lose or merge a run.
 */
async function clientIpHash(env: Env, request: Request): Promise<string> {
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
