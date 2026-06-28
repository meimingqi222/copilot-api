import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const APP_DIR = path.join(os.homedir(), ".local", "share", "copilot-api")

const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  ACCOUNTS_PATH: path.join(APP_DIR, "accounts.json"),
  USERS_PATH: path.join(APP_DIR, "users.json"),
  PENDING_FLOWS_PATH: path.join(APP_DIR, "pending_flows.json"),
  PENDING_OAUTH_FLOWS_PATH: path.join(APP_DIR, "pending_oauth_flows.json"),
  STATS_PATH: path.join(APP_DIR, "stats.db"),
  GUARD_PATH: path.join(APP_DIR, "guard.json"),
  PROVIDER_CONNECTIONS_PATH: path.join(APP_DIR, "provider-connections.json"),
  MODELS_DEV_CACHE_PATH: path.join(APP_DIR, "models-dev.json"),
  CACHE_DIR: path.join(APP_DIR, "cache"),
  /** Rotated diagnostic logs: `server-YYYY-MM-DD.log` (+ optional `.N` segments). */
  LOG_DIR: path.join(APP_DIR, "logs"),
  /** Active log file path (resolved at runtime; see `~/lib/log-rotation`). */
  LOG_FILE: path.join(APP_DIR, "logs", "server.log"),
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await fs.mkdir(PATHS.CACHE_DIR, { recursive: true })
  await fs.mkdir(PATHS.LOG_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
