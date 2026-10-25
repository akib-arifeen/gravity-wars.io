// Retention for the two tables with a provable expiry: rate-limit windows that can no longer be
// counted, and idempotency records that have expired. Both are dead weight once their window has
// passed, and neither may be deleted in one unbounded statement: a scheduled event is bounded work.
//
// This is bounded, not exhaustive. `runs`, `submissions`, `replay_cache` and `leagues` also grow
// with use and are not touched here — a run stops being useful within its 2 h lifetime, but a
// submission and its league are the leaderboard's history, so their retention is a product
// decision rather than a window arithmetic one. The README says the same.
//
// The bounds are deliberate. Each statement deletes at most `batchSize` rows, each event runs at
// most `maxBatches` statements per table, and the loop also stops on a wall-clock budget. Whatever
// is left is picked up by the next event, so no single invocation can run long.

/** Two days of slack: longer than the longest rate-limit window, so a live window is never cut. */
export const RATE_LIMIT_GRACE_MS = 2 * 86_400_000

export interface RetentionLimits {
  /** Rows per DELETE statement. */
  batchSize: number
  /** DELETE statements per table per event. */
  maxBatches: number
  /** Wall-clock ceiling for one event. */
  budgetMs: number
}

export const RETENTION_LIMITS: RetentionLimits = {
  batchSize: 500,
  maxBatches: 8,
  budgetMs: 2_000,
}

export interface RetentionReport {
  /** Rows deleted by this event. */
  rateLimits: number
  idempotencyKeys: number
  /** True when dead rows remain, i.e. the event hit a bound rather than the end of the work. */
  pending: boolean
  ms: number
}

/**
 * Delete what is provably dead, in bounded batches. Returns what it removed and whether work is
 * still queued, so the caller can log a truthful report instead of assuming it finished. Only the
 * two tables with an expiry window are swept; see the note at the top about the rest.
 */
export async function runRetention(
  db: D1Database,
  now: number,
  limits: RetentionLimits = RETENTION_LIMITS,
): Promise<RetentionReport> {
  const started = Date.now()
  const staleBefore = now - RATE_LIMIT_GRACE_MS
  const rateLimits = await sweep(
    db,
    `DELETE FROM rate_limits WHERE rowid IN (
       SELECT rowid FROM rate_limits WHERE window_start < ? LIMIT ?
     )`,
    staleBefore,
    limits,
    started,
  )
  const idempotencyKeys = await sweep(
    db,
    `DELETE FROM idempotency_keys WHERE key_hash IN (
       SELECT key_hash FROM idempotency_keys WHERE expires_at <= ? LIMIT ?
     )`,
    now,
    limits,
    started,
  )
  const remaining = await countRemaining(db, staleBefore, now)
  return {
    rateLimits,
    idempotencyKeys,
    pending: remaining.rateLimits > 0 || remaining.idempotencyKeys > 0,
    ms: Date.now() - started,
  }
}

async function sweep(
  db: D1Database,
  sql: string,
  cutoff: number,
  limits: RetentionLimits,
  started: number,
): Promise<number> {
  let removed = 0
  for (let batch = 0; batch < limits.maxBatches; batch++) {
    if (Date.now() - started > limits.budgetMs) break
    const result = await db.prepare(sql).bind(cutoff, limits.batchSize).run()
    const changes = result.meta.changes ?? 0
    removed += changes
    if (changes < limits.batchSize) break
  }
  return removed
}

/**
 * Only used to report truthfully whether the event finished its work. Both counts use an index on
 * the column they filter, so this stays cheap.
 */
async function countRemaining(
  db: D1Database,
  staleBefore: number,
  now: number,
): Promise<{ rateLimits: number; idempotencyKeys: number }> {
  const stale = await db
    .prepare(`SELECT COUNT(*) AS n FROM rate_limits WHERE window_start < ?`)
    .bind(staleBefore)
    .first<{ n: number }>()
  const expired = await db
    .prepare(`SELECT COUNT(*) AS n FROM idempotency_keys WHERE expires_at <= ?`)
    .bind(now)
    .first<{ n: number }>()
  return { rateLimits: Number(stale?.n ?? 0), idempotencyKeys: Number(expired?.n ?? 0) }
}
