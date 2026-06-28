import fs from "node:fs/promises"

import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"

function getLockPath(): string {
  return `${PATHS.APP_DIR}/server.lock`
}
const LOCK_POLL_MS = 200
const LOCK_WAIT_MAX_MS = 15_000

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readLockPid(): Promise<number | undefined> {
  try {
    const raw = (await fs.readFile(getLockPath(), "utf8")).trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

async function tryAcquireLock(): Promise<boolean> {
  try {
    await fs.writeFile(getLockPath(), String(process.pid), {
      encoding: "utf8",
      flag: "wx",
    })
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EEXIST") return false
    throw error
  }
}

/**
 * Ensures only one server process runs at a time.
 *
 * All persisted state (accounts.json, provider-connections.json, users.json,
 * guard.json, cache/*.json, stats.db) assumes a single writer. The lock is
 * acquired at startup before any load/save and released on shutdown.
 *
 * Waits briefly for a dying peer (e.g. bun --watch reload) before taking over.
 */
export async function acquireServerLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MAX_MS

  while (Date.now() < deadline) {
    const holder = await readLockPid()
    if (holder && holder !== process.pid && isProcessAlive(holder)) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
      continue
    }

    if (holder && holder !== process.pid) {
      await fs.unlink(getLockPath()).catch((error: unknown) => {
        logger.debug(
          `Failed to remove stale lock file: ${(error as Error).message}`,
        )
      })
    }

    if (await tryAcquireLock()) {
      if (holder && holder !== process.pid) {
        logger.info(
          `Acquired server lock after previous instance (pid ${holder}) exited`,
        )
      }
      return
    }

    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }

  const holder = await readLockPid()
  throw new Error(
    `Could not acquire server lock within ${LOCK_WAIT_MAX_MS / 1000}s`
      + (holder ? ` (still held by pid ${holder})` : ""),
  )
}

export async function releaseServerLock(): Promise<void> {
  const holder = await readLockPid()
  if (holder === process.pid) {
    await fs.unlink(getLockPath()).catch((error: unknown) => {
      logger.debug(`Failed to release lock file: ${(error as Error).message}`)
    })
  }
}
