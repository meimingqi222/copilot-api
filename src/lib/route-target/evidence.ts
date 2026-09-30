// Route evidence: the signals the selector and the trace view weigh a
// candidate by — quota pressure, renewal times, tokens served lately, and any
// rest it is sitting out. Built once per candidate at routing time from
// in-memory state only (quota snapshots are pre-fetched by lib/quota, served
// counts are incremented at recordUsage); the selection path must never do I/O.
//
// Phase 1 produces and surfaces the evidence; Phase 2 makes the `quota` and
// `least-used` strategies consume it in selectRouteTarget.

import {
  getProviderConnection,
  isAccountManagedConnection,
  type ApiCredential,
  type ProviderConnection,
  type RouteTarget,
} from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"

import { servedTokensOf } from "./recent-serve"
import { restInfoForCredential, type RestInfo } from "./rest-reason"

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

/** The largest usage share across the snapshot's counters. */
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
  // Seconds and milliseconds epochs both appear across providers; treat
  // anything that can only be seconds as seconds.
  const ms = value < 1e12 ? value * 1000 : value
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
 * Evidence for one (connection, credential) pair. Cheap and synchronous.
 */
export function routeEvidenceFor(
  connectionId: string,
  credentialId: string,
): RouteEvidence {
  const connection = getProviderConnection(connectionId)
  const credential = connection?.credentials.find((c) => c.id === credentialId)
  return evidenceFrom(connection, credential)
}

function evidenceFrom(
  connection: ProviderConnection | undefined,
  credential: ApiCredential | undefined,
): RouteEvidence {
  const snapshot = credential?.quota
  const quota: QuotaEvidence | undefined =
    snapshot ?
      {
        usedFraction: usedFractionOf(snapshot),
        renewsAtMs: quotaRenewsAt(snapshot),
        staleMs: Math.max(0, Date.now() - snapshot.fetchedAt),
      }
    : undefined

  return {
    quota,
    servedTokens:
      connection && credential ?
        servedTokensOf(connection.id, credential.id)
      : 0,
    rest: restInfoForCredential(credential),
  }
}

// ── Quota-aware ordering (Phase 2) ───────────────────────────────
//
// The `quota` and `least-used` strategies order the same priority layer the
// other strategies do, but weigh it by what each credential's allowance has
// left. Mirrors magpie's weigh(): bands at 90% (low) and 98% (spent), the
// soonest-renewing big window first inside the fine band so an allowance is
// spent before it lapses, ties keep the incoming (cache-warm) order.

/** Past this share of the allowance an account is "low" (keep for backup). */
const LOW_SHARE = 0.9
/** Past this share an account is all but used up — only a last resort. */
const SPENT_SHARE = 0.98

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
  const evidence = evidenceFrom(connection, credential)
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
 * Order a priority layer by allowance pressure, magpie-style: plenty left
 * (soonest-renewing big window ahead), then nearly used, then spent.
 * Ties keep the incoming order so the vendor's prompt cache stays warm.
 */
export function orderByQuota(targets: Array<RouteTarget>): Array<RouteTarget> {
  if (targets.length < 2) return targets
  const rows = targets.map((target) => ({ target, row: weighRowOf(target) }))
  const bandOf = (row: WeighRow): 0 | 1 | 2 => {
    if (row.used === undefined) return 0
    if (row.used >= SPENT_SHARE) return 2
    if (row.used >= LOW_SHARE) return 1
    return 0
  }
  const fine: Array<(typeof rows)[number]> = []
  const low: Array<(typeof rows)[number]> = []
  const spent: Array<(typeof rows)[number]> = []
  for (const entry of rows) {
    const band = bandOf(entry.row)
    if (band === 2) spent.push(entry)
    else if (band === 1) low.push(entry)
    else fine.push(entry)
  }
  fine.sort((a, b) => compareFine(a.row, b.row))
  const ascending = (
    a: (typeof rows)[number],
    b: (typeof rows)[number],
  ): number => (a.row.used ?? 0) - (b.row.used ?? 0)
  low.sort(ascending)
  spent.sort(ascending)
  return [...fine, ...low, ...spent].map((entry) => entry.target)
}

/**
 * Order by allowance used, then by tokens served lately. Unknown allowances
 * count as unused (aligning magpie: one not known counts as unused).
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
