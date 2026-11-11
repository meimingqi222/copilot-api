import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createTables } from "~/lib/stats/schema"

test("file-backed statistics use WAL while another reader has a snapshot open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stats-wal-"))
  const db = new Database(join(dir, "stats.db"))
  const reader = new Database(join(dir, "stats.db"))
  try {
    createTables(db)
    expect(db.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    })
    reader.exec("BEGIN")
    reader.query("SELECT count(*) FROM daily_stats").get()
    db.run("INSERT INTO daily_stats VALUES ('2026-10-09', 'synthetic', 1, 0)")
    reader.exec("COMMIT")
    expect(reader.query("SELECT requests FROM daily_stats").get()).toEqual({
      requests: 1,
    })
  } finally {
    reader.close()
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("a stats DB from before cache-unknown gains the column and backfills Trae 0/0 rows", () => {
  const db = new Database(":memory:")
  try {
    db.run(`CREATE TABLE usage_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      account_id TEXT NOT NULL,
      user_id TEXT,
      model TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      provider TEXT
    )`)
    db.run(
      `INSERT INTO usage_stats
        (date, account_id, model, prompt_tokens, cache_read_tokens, timestamp, provider)
       VALUES
        ('2026-03-10', 'old-account', 'glm-5.2', 1000, 0, 1, 'trae-cn'),
        ('2026-03-10', 'old-account', 'gpt-5', 500, 0, 2, 'copilot'),
        ('2026-03-10', 'old-account', 'kimi-k3', 1000, 400, 3, 'trae-cn')`,
    )
    createTables(db)
    expect(db.query("PRAGMA table_info(usage_stats)").all()).toContainEqual(
      expect.objectContaining({ name: "cache_unknown" }),
    )
    expect(
      db.query("SELECT id, cache_unknown FROM usage_stats ORDER BY id").all(),
    ).toEqual([
      { id: 1, cache_unknown: 1 },
      { id: 2, cache_unknown: 0 },
      { id: 3, cache_unknown: 0 },
    ])
  } finally {
    db.close()
  }
})

test("legacy request migration preserves daily totals and persists its exact-data coverage across restarts", () => {
  const db = new Database(":memory:")
  try {
    db.run(`CREATE TABLE daily_stats (date TEXT NOT NULL, account_id TEXT NOT NULL,
      requests INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, PRIMARY KEY (date, account_id))`)
    db.run(
      "INSERT INTO daily_stats VALUES ('2026-10-17', 'old-account', 19, 3)",
    )
    const before = Date.now()
    createTables(db)
    const coverage = db
      .query("SELECT value FROM app_config WHERE key = 'request_stats_since'")
      .get() as { value: string }
    expect(Number(coverage.value)).toBeGreaterThanOrEqual(before)
    expect(Number(coverage.value)).toBeLessThanOrEqual(Date.now())
    expect(db.query("SELECT requests, errors FROM daily_stats").get()).toEqual({
      requests: 19,
      errors: 3,
    })
    expect(
      db.query("SELECT COUNT(*) AS count FROM request_stats").get(),
    ).toEqual({ count: 0 })
    createTables(db)
    expect(
      db
        .query("SELECT value FROM app_config WHERE key = 'request_stats_since'")
        .get(),
    ).toEqual(coverage)
  } finally {
    db.close()
  }
})
