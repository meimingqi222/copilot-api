// 数据库表结构创建与迁移逻辑（从 stats-store.ts 拆分而来，纯代码移动，无逻辑变更）

import { Database } from "bun:sqlite"

import {
  accountManagedProvider,
  listAccountManagedConnections,
} from "~/lib/provider-connections"

/** 创建所有统计相关的表与索引，并执行一次性迁移。 */
export function createTables(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT NOT NULL,
      account_id TEXT NOT NULL,
      requests INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      PRIMARY KEY (date, account_id)
    )
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_date ON daily_stats(date)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_account ON daily_stats(account_id)
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS usage_stats (
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
      timestamp INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_stats(date)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_stats(account_id)
  `)
  ensureUsageUserColumn(db)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_stats(user_id)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_stats(model)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_stats(timestamp)
  `)

  // Application configuration (e.g. admin password hash)
  db.run(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Add performance columns to usage_stats (migration for existing DBs)
  ensureColumn(db, "usage_stats", "ttft_ms", "REAL")
  ensureColumn(db, "usage_stats", "tps", "REAL")
  ensureColumn(db, "usage_stats", "streaming", "INTEGER DEFAULT 0")
  // Add provider column so usage can be aggregated by provider even after
  // an account/connection is deleted (historical rows keep their provider).
  ensureColumn(db, "usage_stats", "provider", "TEXT")
  ensureColumn(db, "usage_stats", "connection_id", "TEXT")
  ensureColumn(db, "usage_stats", "credential_id", "TEXT")
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_stats(provider)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_connection ON usage_stats(connection_id)
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS model_pricing (
      model TEXT PRIMARY KEY,
      prompt_price_per_1k REAL DEFAULT 0,
      completion_price_per_1k REAL DEFAULT 0,
      cache_read_price_per_1k REAL DEFAULT 0,
      cache_write_price_per_1k REAL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `)
  ensureColumn(db, "model_pricing", "context_threshold_tokens", "INTEGER")
  ensureColumn(
    db,
    "model_pricing",
    "extended_prompt_price_per_1k",
    "REAL DEFAULT 0",
  )
  ensureColumn(
    db,
    "model_pricing",
    "extended_completion_price_per_1k",
    "REAL DEFAULT 0",
  )
  ensureColumn(
    db,
    "model_pricing",
    "extended_cache_read_price_per_1k",
    "REAL DEFAULT 0",
  )
  ensureColumn(
    db,
    "model_pricing",
    "extended_cache_write_price_per_1k",
    "REAL DEFAULT 0",
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS stats_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
  migrateSwe16UsageLabels(db)
  backfillProviderColumn(db)
  repairCodebuddyProviderAttribution(db)
}

/** One-time: drop obvious junk swe-1-6-fast test rows (tiny input, zero output). */
export function migrateSwe16UsageLabels(db: Database): void {
  const applied = db
    .prepare("SELECT 1 AS ok FROM stats_migrations WHERE name = ?")
    .get("swe-1-6-fast-junk-cleanup") as { ok: number } | undefined
  if (applied) return

  db.run(`
    DELETE FROM usage_stats
    WHERE model = 'swe-1-6-fast'
      AND completion_tokens = 0
      AND prompt_tokens < 200
  `)
  db.run("INSERT INTO stats_migrations (name, applied_at) VALUES (?, ?)", [
    "swe-1-6-fast-junk-cleanup",
    Date.now(),
  ])
}

/**
 * One-time: backfill the `provider` column for pre-existing usage rows by
 * joining against the current account registry. Rows whose account no longer
 * exists are left NULL and reported as "unknown" by the by-provider query.
 */
export function backfillProviderColumn(db: Database): void {
  const applied = db
    .prepare("SELECT 1 AS ok FROM stats_migrations WHERE name = ?")
    .get("backfill-usage-provider") as { ok: number } | undefined
  if (applied) return

  const stmt = db.prepare(
    "UPDATE usage_stats SET provider = ? WHERE account_id = ? AND provider IS NULL",
  )
  // 用 connection 原生回填 provider（metadata.provider 优先）。
  // 注意：codebuddy / codebuddy-cn 共用 codebuddy-native，不能用
  // providerFromProtocol（永远得到 codebuddy-cn）。
  for (const conn of listAccountManagedConnections()) {
    stmt.run(accountManagedProvider(conn), conn.id)
  }
  db.run("INSERT INTO stats_migrations (name, applied_at) VALUES (?, ?)", [
    "backfill-usage-provider",
    Date.now(),
  ])
}

/**
 * One-time:修复 codebuddy / codebuddy-cn 共用协议导致的 provider 误标。
 * recordUsage 曾用 providerFromProtocol(conn.protocol) 记录 provider，
 * codebuddy-native 永远反查为 codebuddy-cn，导致国际版账号的用量被记到
 * codebuddy-cn 分组下。按当前 connection 的真实 provider
 *（metadata.provider 优先）把历史行纠正回来。
 *
 * v2：v1 在存量国内版连接的 metadata.provider 修正（boot-migration 的
 * repairCodebuddyCnConnections）之前运行过的话，会把国内版账号的历史行
 * 误写成 "codebuddy"。改名重跑，在连接修复之后按真实 provider 再纠正一次。
 */
export function repairCodebuddyProviderAttribution(db: Database): void {
  const applied = db
    .prepare("SELECT 1 AS ok FROM stats_migrations WHERE name = ?")
    .get("repair-codebuddy-provider-attribution-v2") as
    | { ok: number }
    | undefined
  if (applied) return

  const stmt = db.prepare(
    "UPDATE usage_stats SET provider = ? WHERE account_id = ? AND (provider IS NULL OR provider != ?)",
  )
  const connections = listAccountManagedConnections()
  for (const conn of connections) {
    const trueProvider = accountManagedProvider(conn)
    if (trueProvider !== "codebuddy" && trueProvider !== "codebuddy-cn") {
      continue
    }
    stmt.run(trueProvider, conn.id, trueProvider)
  }
  // 连接尚未加载（如脚本直接 statsStore.init()）时不标记已应用，
  // 留待下次正常启动重跑；空表重扫代价可忽略。
  if (connections.length === 0) return
  db.run("INSERT INTO stats_migrations (name, applied_at) VALUES (?, ?)", [
    "repair-codebuddy-provider-attribution-v2",
    Date.now(),
  ])
}

export function ensureColumn(
  db: Database,
  table: string,
  column: string,
  type: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
  }>
  if (!rows.some((r) => r.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

export function ensureUsageUserColumn(db: Database): void {
  const rows = db.prepare("PRAGMA table_info(usage_stats)").all() as Array<{
    name: string
  }>
  if (rows.some((row) => row.name === "user_id")) {
    return
  }
  db.run("ALTER TABLE usage_stats ADD COLUMN user_id TEXT")
}
