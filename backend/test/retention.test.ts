// The retention sweep: bounded deletes, only provably dead rows, and a truthful report.

import { describe, expect, it } from "vitest"
import { RATE_LIMIT_GRACE_MS, RETENTION_LIMITS, runRetention } from "../src/retention.ts"
import { createTestDb } from "./d1-shim.ts"
import { FIXED_NOW, migrationSql } from "./helpers.ts"

function freshDb(): D1Database {
  return createTestDb(migrationSql()).db
}

async function rateRow(db: D1Database, ipHash: string, windowStart: number, bucket = "read:minute"): Promise<void> {
  await db
    .prepare(`INSERT INTO rate_limits (bucket, ip_hash, window_start, count) VALUES (?, ?, ?, 1)`)
    .bind(bucket, ipHash, windowStart)
    .run()
}

async function idempotencyRow(db: D1Database, keyHash: string, expiresAt: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO idempotency_keys (key_hash, actor_id, request_hash, status, response_json, created_at, expires_at)
       VALUES (?, 'actor', 'req', 201, '{}', ?, ?)`,
    )
    .bind(keyHash, expiresAt - 86_400_000, expiresAt)
    .run()
}

async function count(db: D1Database, table: string, where = "1 = 1"): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

describe("retention", () => {
  it("deletes only windows that can no longer be counted", async () => {
    const db = freshDb()
    const stale = FIXED_NOW - RATE_LIMIT_GRACE_MS - 1
    const kept = FIXED_NOW - RATE_LIMIT_GRACE_MS + 60_000
    await rateRow(db, "stale", stale)
    await rateRow(db, "kept-edge", kept)
    await rateRow(db, "kept-now", FIXED_NOW)

    const report = await runRetention(db, FIXED_NOW)
    expect(report.rateLimits).toBe(1)
    expect(report.pending).toBe(false)
    expect(await count(db, "rate_limits")).toBe(2)
    expect(await count(db, "rate_limits", "ip_hash = 'stale'")).toBe(0)
    expect(await count(db, "rate_limits", "ip_hash = 'kept-edge'")).toBe(1)
  })

  it("deletes expired idempotency keys and keeps live ones", async () => {
    const db = freshDb()
    await idempotencyRow(db, "expired", FIXED_NOW - 1)
    await idempotencyRow(db, "exact", FIXED_NOW)
    await idempotencyRow(db, "live", FIXED_NOW + 60_000)

    const report = await runRetention(db, FIXED_NOW)
    expect(report.idempotencyKeys).toBe(2)
    expect(await count(db, "idempotency_keys")).toBe(1)
    expect(await count(db, "idempotency_keys", "key_hash = 'live'")).toBe(1)
  })

  it("is bounded: one event cannot delete an unbounded backlog", async () => {
    const db = freshDb()
    const stale = FIXED_NOW - RATE_LIMIT_GRACE_MS - 1
    const total = RETENTION_LIMITS.batchSize * RETENTION_LIMITS.maxBatches + 25
    const statements = Array.from({ length: total }, (_, i) =>
      db.prepare(`INSERT INTO rate_limits (bucket, ip_hash, window_start, count) VALUES ('read:minute', ?, ?, 1)`).bind(
        `ip-${i}`,
        stale,
      ),
    )
    await db.batch(statements as unknown as D1PreparedStatement[])

    const report = await runRetention(db, FIXED_NOW)
    expect(report.rateLimits).toBe(RETENTION_LIMITS.batchSize * RETENTION_LIMITS.maxBatches)
    expect(report.pending).toBe(true)
    expect(await count(db, "rate_limits")).toBe(25)

    // The next event picks up where this one stopped, so nothing is lost by the bound.
    const next = await runRetention(db, FIXED_NOW)
    expect(next.rateLimits).toBe(25)
    expect(next.pending).toBe(false)
    expect(await count(db, "rate_limits")).toBe(0)
  })

  it("stops on its wall-clock budget", async () => {
    const db = freshDb()
    const stale = FIXED_NOW - RATE_LIMIT_GRACE_MS - 1
    await rateRow(db, "old", stale)
    const report = await runRetention(db, FIXED_NOW, { batchSize: 1, maxBatches: 100, budgetMs: -1 })
    expect(report.rateLimits).toBe(0)
    expect(report.pending).toBe(true)
    expect(await count(db, "rate_limits")).toBe(1)
  })

  it("does nothing, and says so, on an empty database", async () => {
    const db = freshDb()
    const report = await runRetention(db, FIXED_NOW)
    expect(report).toMatchObject({ rateLimits: 0, idempotencyKeys: 0, pending: false })
  })
})
