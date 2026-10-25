import { beforeEach, describe, expect, it } from "vitest"
import { createTestDb } from "./d1-shim.ts"
import { migrationSql } from "./helpers.ts"

const LEAGUE = "daily:2026-10-26:v1"
let db: D1Database

beforeEach(async () => {
  const created = createTestDb(migrationSql())
  db = created.db
  await db
    .prepare(
      `INSERT INTO leagues (id, date, ruleset_version, seed, arena, difficulty, created_at)
       VALUES (?, '2026-10-26', 1, 1, 'classic', 'normal', 0)`,
    )
    .bind(LEAGUE)
    .run()
})

async function insertRun(id: string, assisted: number, ranked: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runs (id, league_id, actor_hash, nonce_hash, token_hash, assisted, ranked, issued_at, expires_at)
       VALUES (?, ?, 'actor', ?, ?, ?, ?, 0, 1000)`,
    )
    .bind(id, LEAGUE, `nonce-${id}`, `token-${id}`, assisted, ranked)
    .run()
}

async function insertSubmission(id: string, runId: string, assisted: number, ranked: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO submissions
         (id, run_id, league_id, actor_hash, score, claimed_score, trace_hash, trace_steps,
          assisted, ranked, verified, submitted_at, replay_ms, engine)
       VALUES (?, ?, ?, 'actor', 10, 10, 'trace', 1, ?, ?, 1, 0, 1, 'test')`,
    )
    .bind(id, runId, LEAGUE, assisted, ranked)
    .run()
}

describe("daily schema guards", () => {
  it("allows a ranked unassisted run and an unranked assisted run", async () => {
    await insertRun("run-ranked", 0, 1)
    await insertRun("run-assisted", 1, 0)
    const row = await db.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>()
    expect(Number(row?.n)).toBe(2)
  })

  it("refuses an assisted ranked run in the database, not only in the handler", async () => {
    await expect(insertRun("run-invalid", 1, 1)).rejects.toThrow(/CHECK constraint failed/)
  })

  it("allows a ranked unassisted submission and an unranked assisted submission", async () => {
    await insertRun("run-a", 0, 1)
    await insertRun("run-b", 1, 0)
    await insertSubmission("sub-ranked", "run-a", 0, 1)
    await insertSubmission("sub-assisted", "run-b", 1, 0)
    const row = await db.prepare("SELECT COUNT(*) AS n FROM submissions").first<{ n: number }>()
    expect(Number(row?.n)).toBe(2)
  })

  it("refuses an assisted ranked submission in the database", async () => {
    await insertRun("run-invalid", 1, 0)
    await expect(insertSubmission("sub-invalid", "run-invalid", 1, 1)).rejects.toThrow(/CHECK constraint failed/)
  })

  it("does not keep the unused runs_actor_issued index", async () => {
    const row = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_actor_issued'`)
      .first()
    expect(row).toBeNull()
  })
})
