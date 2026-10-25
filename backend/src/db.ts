import { ARENA_IDS } from "../../game/arenas.ts"
import type { League, RunRow } from "./daily.ts"

export interface SubmissionRow {
  id: string
  run_id: string
  league_id: string
  actor_hash: string
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
  actor_hash: string
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
         (id, league_id, actor_hash, nonce_hash, token_hash, assisted, ranked, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      run.id,
      run.leagueId,
      run.actorHash,
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
    actorHash: String(row.actor_hash),
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

/** 1-based rank by score, then earlier submission, then id: the same order the board uses. */
export async function rankBefore(
  db: D1Database,
  leagueId: string,
  score: number,
  submittedAt: number,
  id: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM submissions
       WHERE league_id = ? AND ranked = 1 AND verified = 1 AND assisted = 0
         AND (score > ? OR (score = ? AND (submitted_at < ? OR (submitted_at = ? AND id < ?))))`,
    )
    .bind(leagueId, score, score, submittedAt, submittedAt, id)
    .first<{ n: number }>()
  return Number(row?.n ?? 0) + 1
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
         (id, run_id, league_id, actor_hash, score, claimed_score, trace_hash, trace_steps,
          assisted, ranked, verified, submitted_at, replay_ms, engine)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND consumed_at IS NULL)`,
    )
    .bind(
      submission.id,
      submission.run_id,
      submission.league_id,
      submission.actor_hash,
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

export async function getLeaderboard(
  db: D1Database,
  leagueId: string,
  limit: number,
): Promise<LeaderboardRow[]> {
  const result = await db
    .prepare(
      `SELECT id, score, submitted_at, assisted FROM submissions
       WHERE league_id = ? AND ranked = 1 AND verified = 1 AND assisted = 0
       ORDER BY score DESC, submitted_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(leagueId, limit)
    .all<LeaderboardRow>()
  return result.results ?? []
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
         (key_hash, actor_hash, request_hash, status, response_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.key_hash, row.actor_hash, row.request_hash, row.status, row.response_json, row.created_at, row.expires_at)
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
