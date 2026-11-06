import { constants } from "node:fs"
import fs from "node:fs/promises"
import { join } from "node:path"

import { assertWritableDataPath, PATHS } from "~/lib/paths"
import { logger } from "~/lib/logger"

/** Callers MUST sanitize all fields before saving; this store does not redact. */
interface StreamIncidentRecord {
  requestId: string
  createdAt: number
  [key: string]: unknown
}

interface IncidentEntry {
  requestId: string
  createdAt: number
  bytes: number
}

const TTL_MS = 24 * 60 * 60 * 1000
const MAX_BYTES = 32 * 1024 * 1024
const MAX_RECORD_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 50
const MAX_PENDING_SAVES = 4
const VALID_ID = /^[A-Za-z0-9_-]{1,100}$/

let pendingSaves = 0
let tail: Promise<unknown> = Promise.resolve()

// One process owns the store. Reads also serialize because they prune.
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = tail.then(operation)
  tail = result.catch(() => undefined)
  return result
}

function validateId(requestId: string): void {
  if (typeof requestId !== "string" || !VALID_ID.test(requestId)) {
    throw new Error("Invalid stream incident requestId")
  }
}

function isRecord(value: unknown): value is StreamIncidentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.requestId === "string"
    && VALID_ID.test(record.requestId)
    && typeof record.createdAt === "number"
    && Number.isFinite(record.createdAt)
    && record.createdAt >= 0
    && record.createdAt <= Date.now()
  )
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

async function prepareDirectory(directory: string): Promise<void> {
  assertWritableDataPath(directory, "maintain stream incidents in")
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Stream incident directory must not be a symlink")
  }
  await fs.chmod(directory, 0o700)
}

async function loadFile(
  file: string,
): Promise<StreamIncidentRecord | undefined> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) {
      return undefined
    }
    await handle.chmod(0o600)
    const value: unknown = JSON.parse(await handle.readFile("utf8"))
    return isRecord(value) ? value : undefined
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  } finally {
    await handle.close()
  }
}

async function removeEntry(
  directory: string,
  requestId: string,
): Promise<void> {
  const file = join(directory, `${requestId}.json`)
  assertWritableDataPath(file, "prune")
  await fs.unlink(file)
}

async function prune(directory: string): Promise<Array<IncidentEntry>> {
  await prepareDirectory(directory)
  const entries: Array<IncidentEntry> = []
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith(".json")) continue
    const requestId = name.slice(0, -5)
    if (!VALID_ID.test(requestId)) continue
    const file = join(directory, name)
    const stat = await fs.lstat(file)
    // Do not follow links, descend into directories or touch unrelated files.
    if (!stat.isFile() || stat.nlink !== 1) continue
    const record = await loadFile(file)
    if (
      !record
      || record.requestId !== requestId
      || record.createdAt <= Date.now() - TTL_MS
    ) {
      await removeEntry(directory, requestId)
      continue
    }
    entries.push({ requestId, createdAt: record.createdAt, bytes: stat.size })
  }
  entries.sort(
    (a, b) =>
      a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId),
  )
  await trim(directory, entries, MAX_ENTRIES, MAX_BYTES)
  return entries
}

async function trim(
  directory: string,
  entries: Array<IncidentEntry>,
  count: number,
  bytes: number,
): Promise<void> {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  while (entries.length > count || total > bytes) {
    const oldest = entries.shift()
    if (!oldest) break
    await removeEntry(directory, oldest.requestId)
    total -= oldest.bytes
  }
}

/** Rejects on invalid/oversized input, I/O failure or four outstanding saves.
 * At most four serialized JSON payloads are retained by the save queue.
 */
export async function saveStreamIncident(
  record: StreamIncidentRecord,
): Promise<void> {
  if (pendingSaves >= MAX_PENDING_SAVES) {
    throw new Error("Stream incident save queue is full")
  }
  validateId(record.requestId)
  if (!isRecord(record)) throw new Error("Invalid stream incident record")
  const json = JSON.stringify(record)
  const bytes = Buffer.byteLength(json)
  if (bytes > MAX_RECORD_BYTES) throw new Error("Stream incident exceeds 2 MiB")
  // Validate the actual serialized representation (including custom toJSON).
  const snapshot: unknown = JSON.parse(json)
  if (!isRecord(snapshot) || snapshot.requestId !== record.requestId) {
    throw new Error("Invalid serialized stream incident record")
  }
  const { requestId, createdAt } = snapshot
  const directory = join(PATHS.LOG_DIR, "stream-incidents")
  pendingSaves++
  return serialize(async () => {
    const entries = await prune(directory)
    if (createdAt <= Date.now() - TTL_MS) return
    const file = join(directory, `${requestId}.json`)
    const existing = entries.findIndex((entry) => entry.requestId === requestId)
    if (existing !== -1) {
      await removeEntry(directory, requestId)
      entries.splice(existing, 1)
    }
    // Reserve space before writing, so even the write itself stays bounded.
    await trim(directory, entries, MAX_ENTRIES - 1, MAX_BYTES - bytes)
    assertWritableDataPath(file, "save stream incident to")
    // Exclusive creation refuses symlinks and other foreign entries as targets.
    await fs.writeFile(file, json, { mode: 0o600, flag: "wx" })
  }).finally(() => {
    pendingSaves--
  })
}

export async function readStreamIncident(
  requestId: string,
): Promise<StreamIncidentRecord | undefined> {
  validateId(requestId)
  const directory = join(PATHS.LOG_DIR, "stream-incidents")
  return serialize(async () => {
    const entries = await prune(directory)
    if (!entries.some((entry) => entry.requestId === requestId))
      return undefined
    try {
      return await loadFile(join(directory, `${requestId}.json`))
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  })
}

export async function listStreamIncidents(): Promise<Array<IncidentEntry>> {
  const directory = join(PATHS.LOG_DIR, "stream-incidents")
  return serialize(async () => (await prune(directory)).reverse())
}

// TTL applies on every access; the reaper also removes expired files when no
// further anomalies occur. Resolve PATHS inside the callback, not at import.
setInterval(() => {
  void listStreamIncidents().catch(() => {
    logger.warn("[stream-diagnostics] could not prune expired incidents")
  })
}, 60 * 60_000).unref()
