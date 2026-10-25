/**
 * Bun test preload, listed first: drop variables Bun auto-loaded from the
 * developer's local `.env` files.
 *
 * `bun test` reads `.env`, `.env.test` and `.env.local` before any preload,
 * and bunfig has no test-only switch to stop it (a top-level `env = false`
 * would also stop `bun run dev` from reading `.env`). Without this, a local
 * `DUMP_REQUESTS=1` or `API_KEY=…` changes defaults the tests assert, so the
 * suite passes in CI and fails on the machine that has the file.
 */
import fs from "node:fs"
import path from "node:path"

for (const name of [".env", ".env.test", ".env.local"]) {
  let text: string
  try {
    text = fs.readFileSync(path.join(process.cwd(), name), "utf8")
  } catch {
    continue
  }
  for (const line of text.split(/\r?\n/)) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/.exec(line)?.[1]
    if (key) delete process.env[key]
  }
}
