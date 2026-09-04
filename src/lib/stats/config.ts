// 应用配置（app_config 表）读写逻辑（从 stats-store.ts 拆分而来，纯代码移动，无逻辑变更）

import { Database } from "bun:sqlite"

export function getConfig(db: Database, key: string): string | undefined {
  const stmt = db.prepare("SELECT value FROM app_config WHERE key = ?")
  const row = stmt.get(key) as { value: string } | undefined
  return row?.value
}

export function setConfig(db: Database, key: string, value: string): void {
  const stmt = db.prepare(`
    INSERT INTO app_config (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `)
  stmt.run(key, value, Date.now())
}

export function deleteConfig(db: Database, key: string): void {
  db.prepare("DELETE FROM app_config WHERE key = ?").run(key)
}
