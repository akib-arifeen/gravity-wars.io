import { ARENA_IDS } from "../../game/arenas.ts"
import type { League, RunRow } from "./daily.ts"

export interface SubmissionRow {
  id: string
  run_id: string
  league_id: string
  actor_id: string
  score: number
  claimed_score: number
  trace_hash: string
  trace_steps: number
  assisted: number
  ranked: number
  verified: number
  submitted_at: number
  replay_ms: number
  engine: string
}

export interface IdempotencyRow {
  key_hash: string
  actor_id: string
  request_hash: string
  status: number
  response_json: string
  created_at: number
  expires_at: number
}

export interface LeaderboardRow {
  id: string
  score: number
  submitted_at: number
  assisted: number
}

export interface ReplayCacheRow {
  run_id: string
  trace_hash: string
  league_id: string
  ruleset_version: number
  score: number
  peak_mass: number
  ticks: number
  trace_steps: number
  duration_s: number
  winner_id: string | null
  replay_ms: number
  created_at: number
}

/** What a submission's own standing on the board is. */
export interface SubmissionRank {
  /** 1-based position among the board's best-per-actor rows; null when it has no row. */
  rank: number | null
  /** False when a better run of the same actor already holds the actor's row. */
  best: boolean
}

/**
 * Every actor's best rankable submission in a league, one row per actor. "Best" is the board's own
 * order — score, then earlier submission, then id — so a tie is resolved the same way everywhere.
 * The board, the rank of a new submission and its personal-best flag all read this one shape.
 */
const BEST_PER_ACTOR = `SELECT s.* FROM submissions s
  WHERE s.league_id = ? AND s.ranked = 1 AND s.verified = 1 AND s.assisted = 0
    AND NOT EXISTS (
      SELECT 1 FROM submissions b
      WHERE b.league_id = s.league_id AND b.actor_id = s.actor_id
        AND b.ranked = 1 AND b.verified = 1 AND b.assisted = 0
        AND (b.score > s.score
          OR (b.score = s.score AND (b.submitted_at < s.submitted_at
            OR (b.submitted_at = s.submitted_at AND b.id < s.id))))
    )`

export async function ensureLeague(db: D1Database, league: League, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO leagues (id, date, ruleset_version, seed, arena, difficulty, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (date, ruleset_version) DO NOTHING`,
    )
    .bind(league.id, league.date, league.rulesetVersion, league.seed, league.arena, league.difficulty, now)
    .run()
}

/** The stored league for a run. Replay uses these values, not today's derived challenge. */
export async function getLeagueById(db: D1Database, id: string): Promise<League | null> {
  const row = await db
    .prepare(`SELECT id, date, ruleset_version, seed, arena, difficulty FROM leagues WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>()
  return row ? leagueFromRow(row) : null
}

/**
 * The league that owns a date's leaderboard: the highest stored ruleset version for that date.
 * Resolving the stored row keeps history readable after a ruleset bump while staying bounded to
 * one league per date.
 */
export async function getLatestLeagueForDate(db: D1Database, date: string): Promise<League | null> {
  const row = await db
    .prepare(
      `SELECT id, date, ruleset_version, seed, arena, difficulty FROM leagues
       WHERE date = ? ORDER BY ruleset_version DESC LIMIT 1`,
    )
    .bind(date)
    .first<Record<string, unknown>>()
  return row ? leagueFromRow(row) : null
}

export async function insertRun(db: D1Database, run: RunRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runs
         (id, league_id, actor_id, nonce_hash, token_hash, assisted, ranked, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      run.id,
      run.leagueId,
      run.actorId,
      run.nonceHash,
      run.tokenHash,
      run.assisted ? 1 : 0,
      run.ranked ? 1 : 0,
      run.issuedAt,
      run.expiresAt,
    )
    .run()
}

export async function getRun(db: D1Database, runId: string): Promise<RunRow | null> {
  const row = await db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(runId).first<Record<string, unknown>>()
  if (!row) return null
  return {
    id: String(row.id),
    leagueId: String(row.league_id),
    actorId: String(row.actor_id),
    nonceHash: String(row.nonce_hash),
    tokenHash: String(row.token_hash),
    assisted: Number(row.assisted) === 1,
    ranked: Number(row.ranked) === 1,
    issuedAt: Number(row.issued_at),
    expiresAt: Number(row.expires_at),
  }
}

export async function getSubmissionByRun(db: D1Database, runId: string): Promise<SubmissionRow | null> {
  const row = await db
    .prepare(`SELECT * FROM submissions WHERE run_id = ?`)
    .bind(runId)
    .first<SubmissionRow>()
  return row ?? null
}

/**
 * A submission's place on the best-per-actor board. Two reads: whether this submission is its
 * actor's row at all, then how many rows sort ahead of it. A submission that is not its actor's
 * best has no row on the board and no rank.
 */
export async function rankOfSubmission(db: D1Database, submissionId: string): Promise<SubmissionRank | null> {
  const own = await db
    .prepare(`SELECT id, league_id, score, submitted_at FROM submissions WHERE id = ?`)
    .bind(submissionId)
    .first<{ id: string; league_id: string; score: number; submitted_at: number }>()
  if (!own) return null

  const holder = await db
    .prepare(`SELECT 1 AS ok FROM (${BEST_PER_ACTOR}) WHERE id = ?`)
    .bind(own.league_id, own.id)
    .first<{ ok: number }>()
  if (!holder) return { rank: null, best: false }

  const ahead = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM (${BEST_PER_ACTOR})
       WHERE score > ? OR (score = ? AND (submitted_at < ? OR (submitted_at = ? AND id < ?)))`,
    )
    .bind(own.league_id, own.score, own.score, own.submitted_at, own.submitted_at, own.id)
    .first<{ n: number }>()
  return { rank: Number(ahead?.n ?? 0) + 1, best: true }
}

/**
 * Insert one submission only if its run is still unconsumed, then consume the run. The two
 * statements run as one D1 batch, so a lost race cannot leave a claimed run with no submission.
 * Returns false when the run was already consumed.
 */
export async function insertSubmissionIfOpen(
  db: D1Database,
  submission: SubmissionRow,
  consumedAt: number,
): Promise<boolean> {
  const insert = db
    .prepare(
      `INSERT INTO submissions
         (id, run_id, league_id, actor_id, score, claimed_score, trace_hash, trace_steps,
          assisted, ranked, verified, submitted_at, replay_ms, engine)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND consumed_at IS NULL)`,
    )
    .bind(
      submission.id,
      submission.run_id,
      submission.league_id,
      submission.actor_id,
      submission.score,
      submission.claimed_score,
      submission.trace_hash,
      submission.trace_steps,
      submission.assisted,
      submission.ranked,
      submission.verified,
      submission.submitted_at,
      submission.replay_ms,
      submission.engine,
      submission.run_id,
    )
  const consume = db
    .prepare(`UPDATE runs SET consumed_at = ?, submission_id = ? WHERE id = ? AND consumed_at IS NULL`)
    .bind(consumedAt, submission.id, submission.run_id)
  const results = await db.batch([insert, consume])
  return (results[0]?.meta.changes ?? 0) === 1
}

/** The board: one row per actor, their best. No ids, hashes or network data leave this query. */
export async function getLeaderboard(
  db: D1Database,
  leagueId: string,
  limit: number,
): Promise<LeaderboardRow[]> {
  const result = await db
    .prepare(
      `SELECT id, score, submitted_at, assisted FROM (${BEST_PER_ACTOR})
       ORDER BY score DESC, submitted_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(leagueId, limit)
    .all<LeaderboardRow>()
  return result.results ?? []
}

/**
 * The stored replay for this exact (run, trace), if any. A hit means the engine already replayed
 * these inputs under this league and ruleset, so the request can reuse that result instead of
 * spending the CPU again. A row for another league or ruleset is ignored, not trusted.
 */
export async function getReplayCache(
  db: D1Database,
  runId: string,
  traceHash: string,
  leagueId: string,
  rulesetVersion: number,
): Promise<ReplayCacheRow | null> {
  const row = await db
    .prepare(`SELECT * FROM replay_cache WHERE run_id = ? AND trace_hash = ?`)
    .bind(runId, traceHash)
    .first<ReplayCacheRow>()
  if (!row) return null
  if (row.league_id !== leagueId || Number(row.ruleset_version) !== rulesetVersion) return null
  return row
}

/** Remember a successful replay. A concurrent identical replay may already have stored it. */
export async function putReplayCache(db: D1Database, row: ReplayCacheRow): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO replay_cache
         (run_id, trace_hash, league_id, ruleset_version, score, peak_mass, ticks, trace_steps,
          duration_s, winner_id, replay_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.run_id,
      row.trace_hash,
      row.league_id,
      row.ruleset_version,
      row.score,
      row.peak_mass,
      row.ticks,
      row.trace_steps,
      row.duration_s,
      row.winner_id,
      row.replay_ms,
      row.created_at,
    )
    .run()
}

export async function getIdempotency(db: D1Database, keyHash: string): Promise<IdempotencyRow | null> {
  const row = await db
    .prepare(`SELECT * FROM idempotency_keys WHERE key_hash = ?`)
    .bind(keyHash)
    .first<IdempotencyRow>()
  return row ?? null
}

/** Returns false when another request already stored this key. */
export async function insertIdempotency(db: D1Database, row: IdempotencyRow): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys
         (key_hash, actor_id, request_hash, status, response_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.key_hash, row.actor_id, row.request_hash, row.status, row.response_json, row.created_at, row.expires_at)
    .run()
  return (result.meta.changes ?? 0) === 1
}

export async function deleteIdempotency(db: D1Database, keyHash: string): Promise<void> {
  await db.prepare(`DELETE FROM idempotency_keys WHERE key_hash = ?`).bind(keyHash).run()
}

function leagueFromRow(row: Record<string, unknown>): League {
  const arena = ARENA_IDS.find((id) => id === row.arena)
  if (!arena) throw new Error(`Stored league has an unknown arena: ${String(row.arena)}`)
  const difficulty = row.difficulty
  if (difficulty !== "easy" && difficulty !== "normal" && difficulty !== "hard") {
    throw new Error(`Stored league has an unknown difficulty: ${String(difficulty)}`)
  }
  return {
    id: String(row.id),
    date: String(row.date),
    rulesetVersion: Number(row.ruleset_version),
    seed: Number(row.seed),
    arena,
    difficulty,
  }
}
