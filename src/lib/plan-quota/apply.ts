/**
 * Plan allowance readings, on the write path.
 *
 * A plan reports its allowance as shares of a rolling window (see
 * `~/lib/plan-quota/types`), which makes a reading replayable: the last good
 * one still describes the account after a transient fetch failure. This module
 * is how the rest of the app records readings — the quota subsystem hands it
 * what a refresh produced, or the error it hit — and how routing reads the
 * last known allowance back.
 *
 * The read side is deliberately synchronous and memory-only: selection must
 * never touch the disk, so every recorded reading is mirrored in memory beside
 * the durable copy the store keeps.
 */

import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"

import {
  getConnectionOAuthAccountId,
  getConnectionProvider,
  getConnectionUserId,
  getCredentialExtraString,
} from "~/lib/provider-connections"

import type { MergedPlanAllowance, PlanAllowance, PlanWindow } from "./types"

import { mergeWithLast } from "./store"
import { elapsed } from "./windows"

export interface PlanAccount {
  provider: string
  user: string
}

/**
 * Model-family words a window id/label may name. A window that names one counts
 * only the models whose id contains it; a window that names none counts every
 * model.
 */
const WINDOW_SCOPE_TOKENS: ReadonlyArray<string> = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "gpt",
  "o1",
  "o3",
  "o4",
  "gemini",
  "grok",
  "kimi",
  "deepseek",
  "qwen",
  "glm",
  "minimax",
  "doubao",
  "mimo",
  "llama",
  "mistral",
]

/**
 * The model family a window counts, read from its id/label — the canonical
 * definition for both the snapshot's own windows and the plan readings derived
 * from them, so the two never disagree about which account a model belongs to.
 */
export function scopeOfWindowText(text: string): string | undefined {
  const lower = text.toLowerCase()
  for (const token of WINDOW_SCOPE_TOKENS) {
    if (lower.includes(token)) return token
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** A finite number from a window descriptor field, or undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** The store's key convention, mirrored so both sides name a reading alike. */
function readingKey(provider: string, user: string): string {
  return `${provider}/${user.trim().toLowerCase()}`
}

/**
 * The store key for a connection: its provider, and the account the plan side
 * is keyed by — the sign-in's own id where there is one, else the credential.
 * One definition, so the write path and the router agree on which reading
 * belongs to which connection.
 */
export function planAccountFor(
  connection: ProviderConnection,
): PlanAccount | undefined {
  const provider = getConnectionProvider(connection)
  if (!provider) return undefined
  const credential = connection.credentials[0]
  const user =
    getCredentialExtraString(connection, "email")
    ?? getConnectionOAuthAccountId(connection)
    ?? getConnectionUserId(connection)
    ?? credential?.label?.trim()
    ?? credential?.id
  if (!user) return undefined
  return { provider, user }
}

/**
 * The allowance windows a quota snapshot carries, as plan windows.
 *
 * Only `details._quotaWindows` is read: it is the canonical window list (built
 * by lib/quota/cycles) and the only shape that carries a window's span beside
 * its share. A descriptor without a readable share is skipped rather than
 * recorded as empty — a window that was not measured is not a window at zero.
 */
export function planWindowsFromSnapshot(
  snapshot: QuotaSnapshot,
): PlanAllowance {
  const details = snapshot.details
  if (!isRecord(details)) return []
  const raw = details["_quotaWindows"]
  if (!Array.isArray(raw)) return []

  const out: PlanAllowance = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const usedPercent = finiteNumber(item["usedPercent"])
    if (usedPercent === undefined) continue

    const window: PlanWindow = {
      used: Math.min(Math.max(usedPercent / 100, 0), 1),
    }
    const startMs = finiteNumber(item["windowStartMs"])
    const endMs = finiteNumber(item["windowEndMs"])
    if (startMs !== undefined && endMs !== undefined && endMs > startMs) {
      window.spanMs = endMs - startMs
    }
    if (endMs !== undefined && endMs > 0) {
      window.resetsAtMs = endMs
    }
    const id = typeof item["id"] === "string" ? item["id"] : ""
    const labelKey =
      typeof item["labelKey"] === "string" ? item["labelKey"] : ""
    const scope = scopeOfWindowText(`${id} ${labelKey}`)
    if (scope) window.model = scope
    out.push(window)
  }
  return out
}

interface MirroredReading {
  windows: PlanAllowance
  asOf?: number
  stale: boolean
}

/** Last reading per account, for the synchronous read side. Memory-only. */
const mirror = new Map<string, MirroredReading>()

export interface AllowanceReadingInput {
  provider: string
  user: string
  /** A good reading: the windows as fetched. */
  windows?: PlanAllowance
  /** What the refresh hit instead of windows, when it hit something. */
  error?: string
}

/**
 * Record what a plan refresh produced and return the allowance to use.
 *
 * A good reading is stored and returned unstale; a transient error returns the
 * last reading, advanced to `now` and marked stale, which is exactly what a
 * caller needs to keep rendering or routing on; a terminal error leaves the
 * stored reading alone and returns nothing.
 */
export async function recordAllowanceReading(
  input: AllowanceReadingInput,
  now: number = Date.now(),
): Promise<MergedPlanAllowance> {
  const merged = await mergeWithLast(input, now)
  const key = readingKey(input.provider, input.user)
  if (merged.windows.length > 0) {
    mirror.set(key, {
      windows: merged.windows,
      asOf: merged.asOf,
      stale: merged.stale,
    })
  } else {
    mirror.delete(key)
  }
  return merged
}

/**
 * The last reading for an account, advanced to `now`. Synchronous by design —
 * the selection path reads this while routing — and undefined when this process
 * has not recorded one.
 */
export function planAllowanceFor(
  provider: string,
  user: string,
  now: number = Date.now(),
): MergedPlanAllowance | undefined {
  const entry = mirror.get(readingKey(provider, user))
  if (!entry) return undefined
  return {
    windows: elapsed(entry.windows, now),
    asOf: entry.asOf,
    stale: entry.stale,
  }
}

/**
 * Note what a quota refresh produced. Called from the (synchronous) quota write
 * path, so the store's own write queue is left to do the disk work.
 */
export function noteSnapshotReading(
  connection: ProviderConnection,
  snapshot: QuotaSnapshot,
): void {
  const account = planAccountFor(connection)
  if (!account) return
  const windows = planWindowsFromSnapshot(snapshot)
  // Nothing window-shaped to remember; never overwrite a good reading with it.
  if (windows.length === 0) return
  void recordAllowanceReading({ ...account, windows }).catch(() => undefined)
}

/**
 * Note that a plan refresh failed.
 *
 * A transient failure (a rate limit, a 5xx, a dead socket) replays the last
 * reading, so a momentary upstream hiccup no longer loses the last known
 * allowance; a terminal one clears it, because the reading no longer describes
 * the account.
 */
export async function noteReadingFailure(
  connection: ProviderConnection,
  error: unknown,
): Promise<MergedPlanAllowance | undefined> {
  const account = planAccountFor(connection)
  if (!account) return undefined
  return recordAllowanceReading({
    ...account,
    error: error instanceof Error ? error.message : String(error),
  })
}

/** Forget the in-memory mirror (tests; the durable store has its own reset). */
export function __resetPlanAllowanceMirrorForTest(): void {
  mirror.clear()
}
