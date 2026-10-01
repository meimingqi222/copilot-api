/**
 * Admin API: plan allowance readings.
 *
 * A plan reports its allowance as shares of a rolling window rather than as
 * request counts, which makes a reading replayable: the last good one is kept
 * on disk and re-served after a transient upstream failure (see
 * `~/lib/plan-quota`). This router exposes that stored reading, plus a reset
 * for the case where the reading no longer describes the account.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { Hono } from "hono"

import { logger } from "~/lib/logger"
import { assertWritableDataPath } from "~/lib/paths"
import {
  lastReading,
  planQuotaFilePath,
  setPlanQuotaFilePath,
} from "~/lib/plan-quota"

export const planQuotaApiRoutes = new Hono()

/** Version stamped into the rewritten file when it is absent/unreadable. */
const FILE_VERSION = 1

/**
 * Normalized user half of a store key: lowercased, so one account reached with
 * different capitalization resolves to the same reading.
 */
function readingUser(user: string): string {
  return user.trim().toLowerCase()
}

/** Does this stored key fall inside the provider/user being reset? */
function matchesReading(
  key: string,
  provider: string | undefined,
  user: string | undefined,
): boolean {
  const separator = key.indexOf("/")
  if (separator < 0) return false
  const keyProvider = key.slice(0, separator)
  const keyUser = key.slice(separator + 1)
  if (provider && keyProvider !== provider) return false
  if (user && keyUser !== readingUser(user)) return false
  return true
}

interface StoredFile {
  version: number
  readings: Record<string, unknown>
}

/**
 * Read the allowance file as it is on disk. A missing, unreadable or corrupt
 * file yields undefined: a reset has nothing usable to rewrite, and the store
 * treats the same file as an empty store anyway.
 */
async function readStoredFile(
  filePath: string,
): Promise<StoredFile | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; readings?: unknown }
    if (
      typeof parsed !== "object"
      || parsed === null
      || typeof parsed.readings !== "object"
      || parsed.readings === null
    ) {
      return undefined
    }
    return {
      version:
        typeof parsed.version === "number" ? parsed.version : FILE_VERSION,
      readings: parsed.readings as Record<string, unknown>,
    }
  } catch {
    return undefined
  }
}

/** Write the file the way the store writes it: temp file, then rename. */
async function writeStoredFile(
  filePath: string,
  stored: StoredFile,
): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(
    tmpPath,
    JSON.stringify(
      { version: stored.version, readings: stored.readings },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  )
  try {
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined)
    throw error
  }
}

/**
 * Drop stored readings and forget them in memory.
 *
 * The store only exposes reads, so a reset rewrites its file and then re-points
 * the store at the same path, which drops the cache and makes the next read
 * reload from disk. A reset with no filter clears every reading.
 */
async function clearReadings(provider?: string, user?: string): Promise<void> {
  const filePath = planQuotaFilePath()
  assertWritableDataPath(filePath, "reset")

  const stored = await readStoredFile(filePath)
  if (stored) {
    const readings: Record<string, unknown> = {}
    for (const [key, reading] of Object.entries(stored.readings)) {
      if (!matchesReading(key, provider, user)) readings[key] = reading
    }
    await writeStoredFile(filePath, { version: stored.version, readings })
  }

  // Same path, dropped cache: the next lastReading() sees the rewritten file.
  setPlanQuotaFilePath(filePath)
}

/** The last allowance reading for `provider/user`. Null members mean none. */
planQuotaApiRoutes.get("/:provider/:user", async (c) => {
  const provider = c.req.param("provider").trim()
  const user = c.req.param("user").trim()
  if (!provider || !user) {
    return c.json({ error: "provider and user are required." }, 400)
  }

  const reading = await lastReading(provider, user, Date.now())
  if (!reading) {
    return c.json({ windows: null, asOf: null })
  }
  return c.json({ windows: reading.windows, asOf: reading.asOf })
})

/**
 * Clear the stored reading for one provider/user, for a whole provider, or for
 * every account (no filters).
 */
planQuotaApiRoutes.post("/reset", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    provider?: unknown
    user?: unknown
  }
  const provider =
    typeof body.provider === "string" && body.provider.trim() ?
      body.provider.trim()
    : undefined
  const user =
    typeof body.user === "string" && body.user.trim() ?
      body.user.trim()
    : undefined

  try {
    await clearReadings(provider, user)
  } catch (error) {
    logger.warn(`[plan-quota] Failed to reset readings: ${String(error)}`)
    return c.json({ ok: false, error: "Failed to reset plan readings." }, 500)
  }

  logger.info(
    `Plan readings reset (provider=${provider ?? "*"} user=${user ?? "*"})`,
  )
  return c.json({ ok: true })
})
