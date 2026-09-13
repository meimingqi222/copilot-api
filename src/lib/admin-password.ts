/**
 * Admin password hashing.
 *
 * 如果 ADMIN_PASSWORD 是明文(无 scrypt$/sha256: 前缀),首次启动时哈希并
 * 回写 .env,避免磁盘上长期保留明文密码。回写是 best-effort,失败不阻塞启动
 * (密码可能来自 CLI flag 而非 .env)。
 */
import fs from "node:fs/promises"
import { resolve } from "node:path"

import { logger } from "~/lib/logger"
import { hashSecret } from "~/lib/secret-hash"
import { state } from "~/lib/state"

/**
 * If the admin password is plaintext (not scrypt$/sha256: prefixed),
 * hash it in-place and rewrite the .env file so the secret
 * is never stored in cleartext on disk after first boot.
 */
export async function hashAdminPasswordInEnv(
  password: string,
  envPath = resolve(process.cwd(), ".env"),
): Promise<void> {
  if (password.startsWith("scrypt$") || password.startsWith("sha256:")) return

  const hashed = hashSecret(password)
  state.adminPassword = hashed

  // Attempt to rewrite .env — best-effort, non-fatal
  try {
    const content = await fs.readFile(envPath, "utf8")
    // scrypt hashes are full of `$`, and the runtime's .env loader expands
    // unescaped `$name` to an empty string — writing the raw hash would make
    // the next boot read a mangled value and lock the admin out. Escape every
    // `$` (the loader turns `\$` back into `$`). The replacement is a function
    // so `$` sequences are not treated as replacement patterns either.
    const encoded = hashed.replaceAll("$", String.raw`\$`)
    const updated = content.replace(
      /^ADMIN_PASSWORD=.+$/m,
      () => `ADMIN_PASSWORD=${encoded}`,
    )
    if (updated !== content) {
      await fs.writeFile(envPath, updated, "utf8")
      logger.success("ADMIN_PASSWORD in .env has been auto-hashed (scrypt)")
    }
  } catch {
    // .env may not exist (password via CLI flag) — that's fine
  }
}
