import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Real user data dir — never write here while tests are isolated. */
export const PRODUCTION_APP_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "copilot-api",
)

function resolveAppDir(): string {
  const fromEnv = process.env.COPILOT_API_DATA_DIR?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return PRODUCTION_APP_DIR
}

/** Mutable root used by PATHS getters. Only redirectPathsToDir may change it. */
let currentAppDir = resolveAppDir()

function pathUnderApp(fileName: string): string {
  return path.join(currentAppDir, fileName)
}

/**
 * All data-dir paths. Individual keys are read-only getters so tests cannot
 * partially reassign `PATHS.ACCOUNTS_PATH` back to production while another
 * async save is still in flight (that race previously polluted real data).
 * Use {@link redirectPathsToDir} to relocate the whole tree.
 */
export const PATHS = {
  get APP_DIR(): string {
    return currentAppDir
  },
  get GITHUB_TOKEN_PATH(): string {
    return pathUnderApp("github_token")
  },
  get ACCOUNTS_PATH(): string {
    return pathUnderApp("accounts.json")
  },
  get USERS_PATH(): string {
    return pathUnderApp("users.json")
  },
  get PENDING_FLOWS_PATH(): string {
    return pathUnderApp("pending_flows.json")
  },
  get PENDING_OAUTH_FLOWS_PATH(): string {
    return pathUnderApp("pending_oauth_flows.json")
  },
  get STATS_PATH(): string {
    return pathUnderApp("stats.db")
  },
  get GUARD_PATH(): string {
    return pathUnderApp("guard.json")
  },
  get PROVIDER_CONNECTIONS_PATH(): string {
    return pathUnderApp("provider-connections.json")
  },
  get MODELS_DEV_CACHE_PATH(): string {
    return pathUnderApp("models-dev.json")
  },
  get CACHE_DIR(): string {
    return pathUnderApp("cache")
  },
  /** Rotated diagnostic logs: `server-YYYY-MM-DD.log` (+ optional `.N` segments). */
  get LOG_DIR(): string {
    return pathUnderApp("logs")
  },
  /** Active log file path (resolved at runtime; see `~/lib/log-rotation`). */
  get LOG_FILE(): string {
    return path.join(currentAppDir, "logs", "server.log")
  },
} as const

/** True when the path is the production data dir or a file inside it. */
export function isProductionDataPath(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  const prod = path.resolve(PRODUCTION_APP_DIR)
  return resolved === prod || resolved.startsWith(prod + path.sep)
}

/**
 * Test isolation flag set by tests/setup/isolate-data-dir.ts (bunfig preload).
 */
export function isTestDataIsolationEnabled(): boolean {
  return process.env.COPILOT_API_TEST_ISOLATION === "1"
}

/**
 * Refuse writes that would mutate the real user data directory during tests.
 * Call this from every persistence entrypoint.
 */
export function assertWritableDataPath(
  filePath: string,
  operation = "write",
): void {
  if (!isTestDataIsolationEnabled()) return
  if (!isProductionDataPath(filePath)) return
  throw new Error(
    `Refusing to ${operation} production data path during tests: ${filePath}`,
  )
}

/**
 * Point all PATHS at a temporary (or custom) data directory.
 * This is the only supported way to relocate the data tree.
 *
 * Under test isolation, redirecting back to the production data dir is refused
 * so afterEach hooks cannot re-open a race that writes fixture accounts into
 * ~/.local/share/copilot-api.
 */
export function redirectPathsToDir(appDir: string): void {
  const resolved = path.resolve(appDir)
  if (isTestDataIsolationEnabled() && isProductionDataPath(resolved)) {
    throw new Error(
      `Refusing to redirect PATHS to production data dir during tests: ${resolved}`,
    )
  }
  currentAppDir = resolved
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
    assertWritableDataPath(filePath, "create")
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
