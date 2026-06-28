/**
 * Admin password hashing.
 *
 * 如果 ADMIN_PASSWORD 是明文(无 sha256: 前缀),首次启动时原地哈希并
 * 回写 .env,避免磁盘上长期保留明文密码。回写是 best-effort,失败不阻塞启动
 * (密码可能来自 CLI flag 而非 .env)。
 */
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { resolve } from "node:path"

import { logger } from "~/lib/logger"
import { state } from "~/lib/state"

/**
 * If the admin password is plaintext (not sha256: prefixed),
 * hash it in-place and rewrite the .env file so the secret
 * is never stored in cleartext on disk after first boot.
 */
export async function hashAdminPasswordInEnv(password: string): Promise<void> {
  if (password.startsWith("sha256:")) return

  const hashed = `sha256:${createHash("sha256").update(password).digest("hex")}`
  state.adminPassword = hashed

  // Attempt to rewrite .env — best-effort, non-fatal
  const envPath = resolve(process.cwd(), ".env")
  try {
    const content = await fs.readFile(envPath, "utf8")
    const updated = content.replace(
      /^ADMIN_PASSWORD=.+$/m,
      `ADMIN_PASSWORD=${hashed}`,
    )
    if (updated !== content) {
      await fs.writeFile(envPath, updated, "utf8")
      logger.success("ADMIN_PASSWORD in .env has been auto-hashed (sha256)")
    }
  } catch {
    // .env may not exist (password via CLI flag) — that's fine
  }
}
