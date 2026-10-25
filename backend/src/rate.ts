import { HttpError } from "./http.ts";

export interface RateRule {
  bucket: string;
  windowMs: number;
  limit: number;
}

/** Fixed windows, keyed to the actor and bucket. Kept small: abuse limits, not fairness quotas. */
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

/** One fixed-window increment. Throws RATE_LIMITED with Retry-After when the window is full. */
export async function takeRateLimit(
  db: D1Database,
  rule: RateRule,
  actorHash: string,
  now: number,
): Promise<RateHit> {
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs
  const resetAt = windowStart + rule.windowMs
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, actor_hash, window_start, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (bucket, actor_hash, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(rule.bucket, actorHash, windowStart)
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

/** Rate-limit response headers, so a client can back off without parsing the error. */
export function rateHeaders(hit: RateHit): Record<string, string> {
  return {
    "x-ratelimit-limit": String(hit.limit),
    "x-ratelimit-remaining": String(hit.remaining),
    "x-ratelimit-reset": String(Math.ceil(hit.resetAt / 1000)),
  }
}
