import fs from "node:fs/promises"
import path from "node:path"

import { logger } from "~/lib/logger"
import { PATHS, assertWritableDataPath } from "~/lib/paths"

import type {
  MergedPlanAllowance,
  PlanAllowance,
  PlanReading,
  PlanWindow,
} from "./types"

import { elapsed } from "./windows"

/**
 * Last-known plan allowance per account.
 *
 * A plan reading is cheap to replay — windows are shares against a reset
 * instant — so the last good reading is kept on disk and re-served, advanced
 * to the current time, whenever the upstream fetch fails for a transient
 * reason. A terminal failure (a sign-in that went bad) is reported as such
 * instead, because the reading is no longer meaningful.
 */

const FILE_NAME = "plan-quota.json"
const FILE_VERSION = 1

const RENAME_ATTEMPTS = 3
const RENAME_RETRY_DELAY_MS = 50
const RENAME_RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"])

interface StoredReading {
  windows: PlanAllowance
  asOf: number
}

interface PersistedFile {
  version: number
  readings: Record<string, StoredReading>
}

/** Test seam: `undefined` means "use the app data dir". */
let filePathOverride: string | undefined
/** Lazy cache; `undefined` means "not loaded yet", `{}` means "loaded, empty". */
let readings: Record<string, StoredReading> | undefined
/** Serializes writes so two concurrent saves cannot interleave. */
let writeQueue: Promise<unknown> = Promise.resolve()

/** Path of the allowance file (override-aware, so it is stable under tests). */
export function planQuotaFilePath(): string {
  return filePathOverride ?? path.join(PATHS.APP_DIR, FILE_NAME)
}

/** Point the store at a specific file (tests) and drop the cache. */
export function setPlanQuotaFilePath(filePath: string | undefined): void {
  filePathOverride = filePath
  readings = undefined
}

/** Restore the default path and forget cached state. */
export function resetPlanQuotaStore(): void {
  filePathOverride = undefined
  readings = undefined
}

function readingKey(provider: string, user: string): string {
  return `${provider}/${user.trim().toLowerCase()}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeWindow(value: unknown): PlanWindow | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  if (typeof value.used !== "number" || !Number.isFinite(value.used)) {
    return undefined
  }
  const window: PlanWindow = { used: value.used }
  if (typeof value.spanMs === "number" && Number.isFinite(value.spanMs)) {
    window.spanMs = value.spanMs
  }
  if (
    typeof value.resetsAtMs === "number"
    && Number.isFinite(value.resetsAtMs)
  ) {
    window.resetsAtMs = value.resetsAtMs
  }
  if (typeof value.model === "string" && value.model.trim()) {
    window.model = value.model
  }
  if (value.aside === true) {
    window.aside = true
  }
  return window
}

function normalizeReading(value: unknown): StoredReading | undefined {
  if (!isRecord(value) || !Array.isArray(value.windows)) {
    return undefined
  }
  if (typeof value.asOf !== "number" || !Number.isFinite(value.asOf)) {
    return undefined
  }
  const windows = value.windows
    .map((window) => normalizeWindow(window))
    .filter((window): window is PlanWindow => window !== undefined)
  return { windows, asOf: value.asOf }
}

function normalizeFile(parsed: unknown): Record<string, StoredReading> {
  if (!isRecord(parsed) || !isRecord(parsed.readings)) {
    return {}
  }
  const out: Record<string, StoredReading> = {}
  for (const [key, value] of Object.entries(parsed.readings)) {
    const reading = normalizeReading(value)
    if (reading) {
      out[key] = reading
    }
  }
  return out
}

/**
 * Load the file once and cache it. A missing file is an empty store; an
 * unreadable or corrupt file is logged and treated as empty, because a stale
 * allowance is a cache and must never take the caller down with it.
 */
async function loadReadings(): Promise<Record<string, StoredReading>> {
  if (readings) {
    return readings
  }
  const filePath = planQuotaFilePath()
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch {
    readings = {}
    return readings
  }
  try {
    readings = normalizeFile(JSON.parse(raw))
  } catch (error) {
    logger.warn(
      `[plan-quota] Ignoring unreadable ${path.basename(filePath)}: ${(error as Error).message}`,
    )
    readings = {}
  }
  return readings
}

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(task, task)
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function isRetryableRenameError(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined
  return typeof code === "string" && RENAME_RETRYABLE_CODES.has(code)
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt === RENAME_ATTEMPTS) {
        throw error
      }
      await new Promise((resolve) =>
        setTimeout(resolve, RENAME_RETRY_DELAY_MS * attempt),
      )
    }
  }
}

/** Atomic write: temp file in the same directory, then rename over the target. */
async function persist(store: Record<string, StoredReading>): Promise<void> {
  const filePath = planQuotaFilePath()
  assertWritableDataPath(filePath)
  const tmpPath = `${filePath}.tmp.${process.pid}`

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(
    tmpPath,
    JSON.stringify(
      { version: FILE_VERSION, readings: store } satisfies PersistedFile,
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  )

  try {
    await renameWithRetry(tmpPath, filePath)
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined)
    throw error
  }

  try {
    await fs.chmod(filePath, 0o600)
  } catch {
    // chmod is a no-op on some platforms (Windows); not worth failing over.
  }
}

/**
 * Remember a reading that came back good. Persistence failures are logged and
 * swallowed: the in-memory reading stays usable for this process, and the next
 * good reading retries the write.
 */
export async function keepReading(
  provider: string,
  user: string,
  windows: PlanAllowance,
  now: number,
): Promise<void> {
  const store = await loadReadings()
  store[readingKey(provider, user)] = { windows, asOf: now }
  await enqueueWrite(() => persist(store)).catch((error: unknown) => {
    logger.warn(
      `[plan-quota] Failed to persist allowance: ${(error as Error).message}`,
    )
  })
}

/**
 * The last reading for an account, advanced to `now`, or undefined when the
 * account has never been read.
 */
export async function lastReading(
  provider: string,
  user: string,
  now: number,
): Promise<PlanReading | undefined> {
  const store = await loadReadings()
  const stored = store[readingKey(provider, user)]
  if (!stored) {
    return undefined
  }
  return { windows: elapsed(stored.windows, now), asOf: stored.asOf }
}

/**
 * Errors that only mean "the reading could not be taken right now" — the last
 * known allowance still describes the account, so it is served instead.
 * Anything else (a sign-in that went bad, a plan that is gone) is terminal.
 */
const PASSING_ERROR_PATTERNS: Array<RegExp> = [
  /not read yet/i,
  /rate limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b5\d\d\b/,
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway time-?out/i,
  /\btimed?\s?[ -]?out\b/i,
  /\bETIMEDOUT\b/i,
  /connection (?:refused|reset)/i,
  /no such host/i,
  /\bEOF\b/,
  /fetch failed/i,
  /\bECONN[A-Z]*/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /socket hang up/i,
]

/** Is this fetch error transient (the stored reading is still meaningful)? */
export function isPassingError(message: string): boolean {
  return PASSING_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * Turn a fetch outcome into a usable allowance:
 *
 * - a good reading (`windows`) is stored and returned unstale;
 * - a transient error (`error`) returns the last reading advanced to `now`,
 *   marked stale, with its original `asOf`;
 * - a terminal error returns that error's own (empty) result unstale, leaving
 *   the stored reading untouched.
 */
export async function mergeWithLast(
  input: {
    provider: string
    user: string
    error?: string
    windows?: PlanAllowance
  },
  now: number,
): Promise<MergedPlanAllowance> {
  const { provider, user, error, windows } = input

  if (windows) {
    await keepReading(provider, user, windows, now)
    return { windows: elapsed(windows, now), asOf: now, stale: false }
  }

  if (error && isPassingError(error)) {
    const last = await lastReading(provider, user, now)
    if (!last) {
      return { windows: [], stale: true }
    }
    return { windows: last.windows, asOf: last.asOf, stale: true }
  }

  return { windows: [], stale: false }
}
