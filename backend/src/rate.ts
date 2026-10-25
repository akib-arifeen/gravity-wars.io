import { HttpError } from "./http.ts";

export interface RateRule {
  bucket: string;
  windowMs: number;
  limit: number;
}

/** Fixed windows, keyed to the hashed client IP and bucket. Abuse limits, not fairness quotas. */
export const RATE_RULES = {
  issueMinute: { bucket: "run:minute", windowMs: 60_000, limit: 6 },
  issueDay: { bucket: "run:day", windowMs: 86_400_000, limit: 40 },
  submitMinute: { bucket: "submit:minute", windowMs: 60_000, limit: 10 },
  submitDay: { bucket: "submit:day", windowMs: 86_400_000, limit: 40 },
  readMinute: { bucket: "read:minute", windowMs: 60_000, limit: 120 },
} as const satisfies Record<string, RateRule>;

export interface RateHit {
  limit: number;
  remaining: number;
  resetAt: number;
}

/**
 * One fixed-window increment. Throws RATE_LIMITED with Retry-After when the window is full.
 *
 * `ipHash` is an HMAC of the request IP under ACTOR_HASH_KEY. It is the abuse signal for this
 * API and nothing else: it never identifies an actor and is never stored on a run or a submission.
 */
export async function takeRateLimit(
  db: D1Database,
  rule: RateRule,
  ipHash: string,
  now: number,
): Promise<RateHit> {
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs
  const resetAt = windowStart + rule.windowMs
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, ip_hash, window_start, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (bucket, ip_hash, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(rule.bucket, ipHash, windowStart)
    .first<{ count: number }>()
  const count = Number(row?.count ?? 1)
  if (count > rule.limit) {
    throw new HttpError(429, "RATE_LIMITED", "Too many requests for this window", {
      retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      details: { bucket: rule.bucket, limit: rule.limit },
    })
  }
  return { limit: rule.limit, remaining: Math.max(0, rule.limit - count), resetAt }
}

/**
 * The read path's limiter. A leaderboard read is cheap and repeatable, so it counts only when the
 * read is actually going to be served: the window is peeked first, and the row is written only
 * while the window still has room. A read that is already over its budget is refused with no
 * write at all, so a client hammering reads cannot make the Worker write on its behalf.
 *
 * Two concurrent peeks can both pass near the limit, which is acceptable for a read budget;
 * issue and submit keep the exact increment above.
 */
export async function takeReadRateLimit(
  db: D1Database,
  rule: RateRule,
  ipHash: string,
  now: number,
): Promise<RateHit> {
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs
  const resetAt = windowStart + rule.windowMs
  const seen = await db
    .prepare(`SELECT count FROM rate_limits WHERE bucket = ? AND ip_hash = ? AND window_start = ?`)
    .bind(rule.bucket, ipHash, windowStart)
    .first<{ count: number }>()
  const count = Number(seen?.count ?? 0)
  if (count >= rule.limit) {
    throw new HttpError(429, "RATE_LIMITED", "Too many requests for this window", {
      retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      details: { bucket: rule.bucket, limit: rule.limit },
    })
  }
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, ip_hash, window_start, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (bucket, ip_hash, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(rule.bucket, ipHash, windowStart)
    .first<{ count: number }>()
  const after = Number(row?.count ?? count + 1)
  return { limit: rule.limit, remaining: Math.max(0, rule.limit - after), resetAt }
}

/** Rate-limit response headers, so a client can back off without parsing the error. */
export function rateHeaders(hit: RateHit): Record<string, string> {
  return {
    "x-ratelimit-limit": String(hit.limit),
    "x-ratelimit-remaining": String(hit.remaining),
    "x-ratelimit-reset": String(Math.ceil(hit.resetAt / 1000)),
  }
}
