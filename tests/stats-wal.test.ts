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
