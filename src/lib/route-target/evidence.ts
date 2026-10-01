// Route evidence: the signals the selector and the trace view weigh a
// candidate by — quota pressure, renewal times, tokens served lately, and any
// rest it is sitting out. Built once per candidate at routing time from
// in-memory state only (quota snapshots are pre-fetched by lib/quota, served
// counts are incremented at recordUsage); the selection path must never do I/O.
//
// Phase 1 produces and surfaces the evidence; Phase 2 makes the `quota` and
// `least-used` strategies consume it in selectRouteTarget.
//
// Model-scoped windows: only the allowance windows that count the model
// being routed (by their scope) are weighed, so an Opus
// weekly allowance used up leaves Sonnet alone. copilot-api's quota snapshots
// carry those windows under `details._quotaWindows` (Claude's seven_day_opus /
// seven_day_sonnet, and every other provider's cycles). The window model itself
// lives in `~/lib/plan-quota` (parse, scope, biggest-window-first, advance by
// elapsed) and is imported here rather than re-implemented; this module keeps
// only the snapshot-wide fallbacks (top-level counters, heterogeneous resets)
// for providers that report no canonical window list.

import {
  planAccountFor,
  planAllowanceFor,
  planWindowsFromSnapshot,
} from "~/lib/plan-quota/apply"
import { allowanceFor, windowApplies } from "~/lib/plan-quota/windows"
import {
  getProviderConnection,
  isAccountManagedConnection,
  type ApiCredential,
  type ProviderConnection,
  type RouteTarget,
} from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"
import { state } from "~/lib/state"

import { servedTokensOf } from "./recent-serve"
import { type RestInfo } from "./rest-reason"
import { restingReasonFor } from "./resting"

export interface QuotaEvidence {
  /** Share of the allowance used, 0..1. Undefined when the provider reports none. */
  usedFraction?: number
  /** Reset instants of the allowance windows, biggest window first. */
  renewsAtMs: Array<number>
  /** Age of the quota snapshot. Only a display signal — never grounds for rejection. */
  staleMs: number
}

export interface RouteEvidence {
  quota?: QuotaEvidence
  servedTokens: number
  rest?: RestInfo
}

/** One allowance window, as routing weighs it. */
export interface QuotaWindow {
  /** Share of the window used, 0..1. */
  usedFraction?: number
  /** When the window renews (ms epoch), when the vendor said. */
  resetsAtMs?: number
  /** How long the window runs (ms), when known — the longest decides first. */
  spanMs?: number
  /**
   * The model family the window counts ("opus", "sonnet", …), or undefined
   * when the window counts every model (a five-hour window, a plan-wide one).
   */
  scope?: string
}

function normalizeResetMs(value: number): number {
  // Seconds and milliseconds epochs both appear; anything that can only be
  // seconds is seconds.
  return value < 1e12 ? value * 1000 : value
}

/** The largest usage share across the snapshot's top-level counters. */
function usedFractionOf(snapshot: QuotaSnapshot): number | undefined {
  const pairs: Array<[number | undefined, number | undefined]> = [
    [snapshot.premiumInteractionsRemaining, snapshot.premiumInteractionsTotal],
    [snapshot.chatRemaining, snapshot.chatTotal],
    [snapshot.completionsRemaining, snapshot.completionsTotal],
  ]
  let max = 0
  let seen = false
  for (const [remaining, total] of pairs) {
    if (total === undefined || total <= 0) continue
    seen = true
    const used = 1 - Math.min(Math.max(remaining ?? 0, 0), total) / total
    if (used > max) max = used
  }
  return seen ? max : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function pushReset(target: Array<number>, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return
  }
  const ms = normalizeResetMs(value)
  if (!target.includes(ms)) target.push(ms)
}

/** Collect renewal instants from the heterogeneous details shapes. */
export function quotaRenewsAt(snapshot: QuotaSnapshot): Array<number> {
  const out: Array<number> = []
  const details = snapshot.details
  if (!isRecord(details)) return out

  const scan = (value: unknown, depth: number): void => {
    if (depth <= 0 || value === null || value === undefined) return
    if (Array.isArray(value)) {
      for (const item of value) scan(item, depth - 1)
      return
    }
    if (!isRecord(value)) return
    // Known window end keys across providers (codex windows, factory pools,
    // cycle usage descriptors).
    pushReset(out, value["resetAtSeconds"])
    pushReset(out, value["resetsAt"])
    pushReset(out, value["reset_at"])
    pushReset(out, value["resetAt"])
    pushReset(out, value["resetsAtMs"])
    pushReset(out, value["windowEndMs"])
    pushReset(out, value["windowEnd"])
    for (const nested of Object.values(value)) {
      if (isRecord(nested) || Array.isArray(nested)) scan(nested, depth - 1)
    }
  }
  scan(details, 4)
  // Biggest window (furthest reset) first — that's the one that decides
  // "what's left expires when".
  return out.filter((t) => t > Date.now()).sort((a, b) => b - a)
}

/**
 * The canonical allowance windows a snapshot carries, as routing weighs them:
 * `details._quotaWindows` (built by lib/quota/cycles for Claude, Codex,
 * Antigravity, Kimi).
 *
 * Thin adapter over the one window implementation in `~/lib/plan-quota`
 * (`planWindowsFromSnapshot`); it renames the plan model's `used`/`model` to
 * this module's `usedFraction`/`scope`, so the selector and the trace view keep
 * the shape they already read.
 */
export function quotaWindowsOf(snapshot: QuotaSnapshot): Array<QuotaWindow> {
  return planWindowsFromSnapshot(snapshot).map((window) => ({
    usedFraction: window.used,
    resetsAtMs: window.resetsAtMs,
    spanMs: window.spanMs,
    scope: window.model,
  }))
}

/** Whether a window counts the model being routed. */
export function windowAppliesTo(
  window: QuotaWindow,
  model: string | undefined,
): boolean {
  // Same rule as the plan model (`window.model` is this shape's `scope`).
  return windowApplies(
    { used: window.usedFraction ?? 0, model: window.scope },
    model,
  )
}

/** The share used of the fullest window that counts `model`. */
export function usedFractionFor(
  snapshot: QuotaSnapshot,
  model?: string,
): number | undefined {
  const windows = planWindowsFromSnapshot(snapshot)
  if (!windows.some((window) => windowApplies(window, model))) {
    // No window counts the model (or none was measured): fall back to the whole
    // snapshot's counters, so providers that only report an aggregate still
    // weigh.
    return usedFractionOf(snapshot)
  }
  return allowanceFor(windows, model, Date.now()).used
}

/** Renewal instants of the windows that count `model`, biggest window first. */
export function renewsAtFor(
  snapshot: QuotaSnapshot,
  model?: string,
): Array<number> {
  const renews = allowanceFor(
    planWindowsFromSnapshot(snapshot),
    model,
    Date.now(),
  ).renews
  // No per-window reset (or no window list at all): fall back to the
  // heterogeneous details shapes some providers report instead.
  return renews.length > 0 ? renews : quotaRenewsAt(snapshot)
}

/**
 * Evidence for one (connection, credential) pair, optionally scoped to the
 * model being routed. Cheap and synchronous.
 */
export function routeEvidenceFor(
  connectionId: string,
  credentialId: string,
  model?: string,
): RouteEvidence {
  const connection = getProviderConnection(connectionId)
  const credential = connection?.credentials.find((c) => c.id === credentialId)
  return evidenceFrom(connection, credential, model)
}

/**
 * Past this age a credential's own snapshot stops being the better answer: the
 * world has moved on since it was taken, while a plan reading is advanced to
 * now every time it is read.
 */
const SNAPSHOT_STALE_MS = 30 * 60_000

/**
 * Allowance evidence from the account's last plan-quota reading — the
 * allowance as shares of a rolling window, advanced to `now`. Memory-only, so
 * the selection path stays I/O-free; undefined when this process has no
 * reading for the account.
 */
function planQuotaEvidenceFor(
  connection: ProviderConnection | undefined,
  model: string | undefined,
  now: number,
): QuotaEvidence | undefined {
  if (!connection) return undefined
  const account = planAccountFor(connection)
  if (!account) return undefined
  const reading = planAllowanceFor(account.provider, account.user, now)
  if (!reading) return undefined
  // Reporting-only windows are not weighed (same rule as the snapshot path).
  const windows = reading.windows.filter((window) => window.aside !== true)
  if (windows.length === 0) return undefined
  const { used, renews } = allowanceFor(windows, model, now)
  return {
    usedFraction: used,
    renewsAtMs: renews.filter((at) => at > now),
    staleMs: Math.max(0, now - (reading.asOf ?? now)),
  }
}

function evidenceFrom(
  connection: ProviderConnection | undefined,
  credential: ApiCredential | undefined,
  model?: string,
): RouteEvidence {
  const now = Date.now()
  const snapshot = credential?.quota
  const fromSnapshot: QuotaEvidence | undefined =
    snapshot ?
      {
        usedFraction: usedFractionFor(snapshot, model),
        renewsAtMs: renewsAtFor(snapshot, model),
        staleMs: Math.max(0, now - snapshot.fetchedAt),
      }
    : undefined
  // A missing or stale snapshot is exactly when the last known allowance is
  // worth more than the credential's own frozen counters — a refresh that
  // failed transiently replays it as stale instead of losing it. With a fresh
  // snapshot, the snapshot is the answer, as before.
  const snapshotStale =
    snapshot === undefined || now - snapshot.fetchedAt > SNAPSHOT_STALE_MS
  const quota =
    (snapshotStale ? planQuotaEvidenceFor(connection, model, now) : undefined)
    ?? fromSnapshot

  // One resting read: the registry's richer rest (by / failures / link) wins
  // over the coarse credential status when both know of a rest. Account scope
  // only — the trace view has always shown the credential-level rest, not a
  // model's.
  const rest =
    credential ?
      restingReasonFor({ credentialId: credential.id, credential })
    : undefined

  return {
    quota,
    servedTokens:
      connection && credential ?
        servedTokensOf(connection.id, credential.id)
      : 0,
    rest,
  }
}

// ── Quota-aware ordering (Phase 2) ───────────────────────────────
//
// The `quota` and `least-used` strategies order the same priority layer the
// other strategies do, but weigh it by what each credential's allowance has
// left: bands at 90% (low) and 98% (spent), the
// soonest-renewing big window first inside the fine band so an allowance is
// spent before it lapses, ties keep the incoming (cache-warm) order.

/** Past this share of the allowance an account is "low" (kept for backup). */
function lowShare(): number {
  const v = state.routing.quotaLowShare
  return typeof v === "number" && v > 0 && v < 1 ? v : 0.9
}

/** Past this share an account is all but used up — only a last resort. */
function spentShare(): number {
  const v = state.routing.quotaSpentShare
  return typeof v === "number" && v > 0 && v <= 1 ? v : 0.98
}

interface WeighRow {
  /** Allowance used, 0..1; undefined when the provider reports none. */
  used?: number
  /** Renewal instants, biggest window first. */
  renews: Array<number>
  served: number
  /** Subscription that reports its allowance only as it answers. */
  learning: boolean
}

function weighRowOf(target: RouteTarget): WeighRow {
  const connection = getProviderConnection(target.connectionId)
  const credential = connection?.credentials.find(
    (c) => c.id === target.credentialId,
  )
  const evidence = evidenceFrom(
    connection,
    credential,
    target.publicModelId || target.upstreamModelId,
  )
  return {
    used: evidence.quota?.usedFraction,
    renews: evidence.quota?.renewsAtMs ?? [],
    served: evidence.servedTokens,
    learning:
      evidence.quota?.usedFraction === undefined
      && Boolean(connection && isAccountManagedConnection(connection)),
  }
}

function hourOf(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000
}

/** Fine band: learners first once, then soonest-renewing big window first. */
function compareFine(a: WeighRow, b: WeighRow): number {
  if (a.learning !== b.learning) return a.learning ? -1 : 1
  const len = Math.max(a.renews.length, b.renews.length)
  for (let k = 0; k < len; k++) {
    const x = a.renews[k]
    const y = b.renews[k]
    if (x === undefined && y === undefined) break
    // An unknown window sits after a known one at the same rank.
    if (x === undefined) return 1
    if (y === undefined) return -1
    const hx = hourOf(x)
    const hy = hourOf(y)
    if (hx !== hy) return hx - hy
  }
  return 0
}

/**
 * Order a priority layer by allowance pressure: plenty left
 * (soonest-renewing big window ahead), then nearly used, then spent.
 * Ties keep the incoming order so the vendor's prompt cache stays warm.
 */
export function orderByQuota(targets: Array<RouteTarget>): Array<RouteTarget> {
  if (targets.length < 2) return targets
  const low = lowShare()
  const spent = spentShare()
  const rows = targets.map((target) => ({ target, row: weighRowOf(target) }))
  const bandOf = (row: WeighRow): 0 | 1 | 2 => {
    if (row.used === undefined) return 0
    if (row.used >= spent) return 2
    if (row.used >= low) return 1
    return 0
  }
  const fine: Array<(typeof rows)[number]> = []
  const lowBand: Array<(typeof rows)[number]> = []
  const spentBand: Array<(typeof rows)[number]> = []
  for (const entry of rows) {
    const band = bandOf(entry.row)
    if (band === 2) spentBand.push(entry)
    else if (band === 1) lowBand.push(entry)
    else fine.push(entry)
  }
  fine.sort((a, b) => compareFine(a.row, b.row))
  const ascending = (
    a: (typeof rows)[number],
    b: (typeof rows)[number],
  ): number => (a.row.used ?? 0) - (b.row.used ?? 0)
  lowBand.sort(ascending)
  spentBand.sort(ascending)
  return [...fine, ...lowBand, ...spentBand].map((entry) => entry.target)
}

/**
 * Order by allowance used, then by tokens served lately. Unknown allowances
 * count as unused (one not known counts as unused).
 */
export function orderByLeastUsed(
  targets: Array<RouteTarget>,
): Array<RouteTarget> {
  if (targets.length < 2) return targets
  const rows = targets.map((target) => ({ target, row: weighRowOf(target) }))
  rows.sort((a, b) => {
    const used = (a.row.used ?? 0) - (b.row.used ?? 0)
    if (used !== 0) return used
    return a.row.served - b.row.served
  })
  return rows.map((entry) => entry.target)
}
