// A minimal D1 adapter over Node's built-in SQLite for local tests. It implements only the
// surfaces the Worker uses, so the SQL, constraints and transaction behavior are real SQLite.
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite"

interface Meta {
  changes: number
  last_row_id: number
  changed_db: boolean
  duration: number
  rows_read: number
  rows_written: number
}

class ShimStatement {
  private readonly sql: string
  private readonly params: SQLInputValue[]

  constructor(private readonly db: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
    this.sql = sql
    this.params = params
  }

  bind(...params: SQLInputValue[]): ShimStatement {
    return new ShimStatement(this.db, this.sql, params)
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.prepare().get(...this.params)
    return (row as T | undefined) ?? null
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Meta }> {
    const results = this.prepare().all(...this.params) as T[]
    return { results, success: true, meta: meta(results.length, 0) }
  }

  async run(): Promise<{ success: true; meta: Meta }> {
    const result = this.prepare().run(...this.params)
    return { success: true, meta: meta(Number(result.changes), Number(result.lastInsertRowid)) }
  }

  private prepare(): StatementSync {
    return this.db.prepare(this.sql)
  }
}

class ShimD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.db, sql)
  }

  async batch(statements: ShimStatement[]): Promise<Array<{ success: true; meta: Meta }>> {
    this.db.exec("BEGIN")
    try {
      const out: Array<{ success: true; meta: Meta }> = []
      for (const statement of statements) out.push(await statement.run())
      this.db.exec("COMMIT")
      return out
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}

/** Creates an in-memory D1 stand-in with the given migration SQL applied. */
export function createTestDb(migrationSql: string): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:")
  raw.exec("PRAGMA foreign_keys = ON")
  raw.exec(migrationSql)
  return { db: new ShimD1(raw) as unknown as D1Database, raw }
}

function meta(changes: number, lastRowId: number): Meta {
  return {
    changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    duration: 0,
    rows_read: 0,
    rows_written: changes,
  }
}
