/**
 * Persistent install identifier for the copilot-api instance.
 *
 * Used to derive a stable `device_id` for Claude Code fingerprinting
 * (`metadata.user_id`). A random UUID is generated once on first use and
 * persisted to disk so the device fingerprint is consistent across requests
 * and process restarts. A fresh random id per request would inflate the
 * Anthropic backend's session count and look bot-like.
 *
 * Ported from oh-my-pi getInstallId().
 */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"

const INSTALL_ID_FILE = path.join(PATHS.CACHE_DIR, "install-id.json")

let cached: string | undefined
let initPromise: Promise<string> | undefined

interface InstallIdFile {
  installId: string
}

async function loadOrCreate(): Promise<string> {
  try {
    const raw = await readFile(INSTALL_ID_FILE, "utf8")
    const parsed = JSON.parse(raw) as Partial<InstallIdFile>
    if (typeof parsed.installId === "string" && parsed.installId.length > 0) {
      return parsed.installId
    }
  } catch {
    // File doesn't exist or is corrupt - fall through to create.
  }

  const installId = randomUUID()
  try {
    await mkdir(PATHS.CACHE_DIR, { recursive: true })
    await writeFile(
      INSTALL_ID_FILE,
      JSON.stringify({ installId } satisfies InstallIdFile),
    )
  } catch {
    // Best-effort persistence; in-memory id still works for this session.
  }
  return installId
}

/**
 * Returns the persistent install id, generating and persisting it on first
 * use. Concurrent first accesses coalesce on a single init promise.
 */
export function getInstallId(): Promise<string> {
  if (cached) return Promise.resolve(cached)
  if (!initPromise) {
    initPromise = loadOrCreate().then((id) => {
      cached = id
      return id
    })
  }
  return initPromise
}

/** Test-only: reset the in-memory cache (does not delete the file). */
export function resetInstallIdForTest(): void {
  cached = undefined
  initPromise = undefined
}
