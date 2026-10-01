// Rest registry: the richer, in-memory side of a candidate's rest.
//
// A credential's own `status` / `cooldownUntil` (persisted on the connection)
// still says *that* and *until when* a candidate is out. This registry adds
// what a rest carries beside it — what set the duration (`by`), how
// many times it failed in a row (so a backoff can lengthen), where the vendor
// said to verify the account (a `verify` link), and the short window in which
// a `verify` refusal is answered from memory without asking upstream again —
// plus a way to lift a rest by hand (`unrest`, e.g. once the account is
// verified).
//
// Keyed by credential id (globally unique) and, when a rest is model-scoped
// for a free-model rate limit, by `credentialId::model`. The registry is
// deliberately memory-only: a rest is transient (minutes to a couple of days),
// a restart forgetting it costs at most one extra upstream probe, and it must
// never block the request path on I/O.

import type { RestBy, RestInfo, RestReason } from "./rest-reason"

interface RestEntry {
  reason: RestReason
  by: RestBy
  /** Absolute instant the rest lifts, ms epoch. */
  untilMs: number
  /** Failures in a row, for a backoff. */
  failures: number
  /** When it was last (re)recorded. */
  at: number
  /** Where the vendor said to verify the account, for `verify`. */
  link?: string
  /** The error text to answer with, for a held verify refusal. */
  said?: string
  /** Until when the held error is answered without asking again. */
  holdUntil?: number
  /** `createdAt` of the credential instance that took this rest, when known. */
  credentialCreatedAt?: number
}

const rests = new Map<string, RestEntry>()

/** The base of a backoff: a minute, doubling per failure. */
const BASE_BACKOFF_MS = 60_000
/** The most a backoff reaches, failing again and again. */
const MAX_BACKOFF_MS = 10 * 60_000
/** How long a held verify refusal is answered without asking upstream again. */
const VERIFY_HOLD_MS = 60_000

function entryKey(credentialId: string, model?: string): string {
  const base = credentialId
  return model ? `${base}::${model}` : base
}

/**
 * Whether an entry still describes the credential in hand.
 *
 * A rest belongs to the credential instance that took it, and a credential id
 * can be reused — delete a key and add it again — so an entry recorded for one
 * instance must not keep a later instance of the same id out. When either side
 * names no instance (`createdAt` unknown), the entry is taken to apply, which
 * keeps every existing id-only caller and test behaving as before.
 */
function instanceMatches(
  entry: RestEntry,
  credentialCreatedAt?: number,
): boolean {
  if (
    entry.credentialCreatedAt === undefined
    || credentialCreatedAt === undefined
  ) {
    return true
  }
  return entry.credentialCreatedAt === credentialCreatedAt
}

/** A backoff's length for `failures` consecutive failures, capped. */
export function restBackoffMs(failures: number): number {
  const n = Math.max(1, Math.trunc(failures))
  const shifted = BASE_BACKOFF_MS * 2 ** Math.min(n - 1, 10)
  return Math.min(shifted, MAX_BACKOFF_MS)
}

/** Reasons whose duration is a backoff rather than the vendor's own words. */
function isBackoffReason(reason: RestReason): boolean {
  return reason === "network" || reason === "unknown"
}

interface RecordRestInput {
  credentialId: string
  reason: RestReason
  by: RestBy
  /** Absolute instant the rest lifts, ms epoch. Zero means no rest. */
  untilMs: number
  /** Model the rest is scoped to (a free-model rate limit, say). */
  model?: string
  /** Where to verify the account, for a `verify` rest. */
  link?: string
  /** The vendor's own error text, held for a short while. */
  said?: string
  /**
   * `createdAt` of the credential instance this rest is about, when known.
   * Credential ids can be reused (delete a key, add it again), so a rest only
   * describes the instance that took it — see `instanceMatches`.
   */
  credentialCreatedAt?: number
  now?: number
}

/**
 * Record (or refresh) a rest. Returns the effective `RestInfo`, whose
 * duration for a backoff reason grows with the number of failures in a row.
 * A zero `untilMs` clears the entry instead — nothing to rest for.
 */
export function recordRest(input: RecordRestInput): RestInfo {
  const now = input.now ?? Date.now()
  const key = entryKey(input.credentialId, input.model)
  // A rest belongs to the credential instance that took it. An id can be
  // re-used (delete a key, add it again under the same id), so a stored entry
  // for a different instance describes a credential that is gone: it must not
  // bleed its failure streak into the newcomer.
  const stored = rests.get(key)
  const previous =
    stored && instanceMatches(stored, input.credentialCreatedAt) ? stored : (
      undefined
    )
  if (stored && !previous) rests.delete(key)
  const failures = previous ? previous.failures + 1 : 1

  if (!(input.untilMs > now)) {
    // Reasons that don't rest (refused / canceled / foreign / proxy / shape /
    // floor) still bump the failure streak for a later backoff, but leave no
    // rest behind.
    if (previous) {
      previous.failures = failures
      previous.at = now
    }
    return {
      reason: input.reason,
      by: input.by,
      untilMs: 0,
      failures,
      key,
      link: input.link,
    }
  }

  const untilMs =
    isBackoffReason(input.reason) ?
      Math.min(input.untilMs, now + restBackoffMs(failures))
    : input.untilMs

  const entry: RestEntry = {
    reason: input.reason,
    by: isBackoffReason(input.reason) ? "backoff" : input.by,
    untilMs,
    failures,
    at: now,
    link: input.link,
    said: input.said,
    holdUntil: input.reason === "verify" ? now + VERIFY_HOLD_MS : undefined,
    credentialCreatedAt: input.credentialCreatedAt,
  }
  rests.set(key, entry)
  return {
    reason: entry.reason,
    by: entry.by,
    untilMs: entry.untilMs,
    retryAfterMs: Math.max(0, entry.untilMs - now),
    failures,
    key,
    link: entry.link,
  }
}

/** Lift a rest (a success, a quota renewal, or a manual `unrest`). */
export function clearRest(credentialId: string, model?: string): void {
  rests.delete(entryKey(credentialId, model))
}

/** Lift a rest by key, returning whether there was one to lift. */
export function unrest(key: string): boolean {
  return rests.delete(key)
}

/** The live rest of a credential (and model), if any, without clearing it. */
export function restInfoFor(
  credentialId: string,
  model?: string,
  credentialCreatedAt?: number,
): RestInfo | undefined {
  const key = entryKey(credentialId, model)
  const entry = rests.get(key)
  if (!entry || !instanceMatches(entry, credentialCreatedAt)) return undefined
  const now = Date.now()
  return {
    reason: entry.reason,
    by: entry.by,
    untilMs: entry.untilMs > now ? entry.untilMs : undefined,
    retryAfterMs:
      entry.untilMs > now ? Math.max(0, entry.untilMs - now) : undefined,
    failures: entry.failures,
    key,
    link: entry.link,
  }
}

/**
 * The error to answer with, without asking upstream, for a candidate its
 * vendor refused a moment ago until the account is verified — so an agent's
 * reconnects don't all land on an account the vendor has stopped.
 */
export function verifyHeldError(
  credentialId: string,
  model?: string,
  now = Date.now(),
  credentialCreatedAt?: number,
): string | undefined {
  const entry = rests.get(entryKey(credentialId, model))
  if (!entry || !instanceMatches(entry, credentialCreatedAt)) return undefined
  if (entry.reason !== "verify" || !entry.said) return undefined
  if (entry.holdUntil === undefined || now >= entry.holdUntil) return undefined
  return entry.said
}

/** Every live rest, for the admin view. */
export function listRests(): Array<RestInfo & { credentialId: string }> {
  const now = Date.now()
  const out: Array<RestInfo & { credentialId: string }> = []
  for (const [key, entry] of rests) {
    const credentialId =
      key.includes("::") ? key.slice(0, key.indexOf("::")) : key
    out.push({
      credentialId,
      reason: entry.reason,
      by: entry.by,
      untilMs: entry.untilMs > now ? entry.untilMs : undefined,
      retryAfterMs:
        entry.untilMs > now ? Math.max(0, entry.untilMs - now) : undefined,
      failures: entry.failures,
      key,
      link: entry.link,
    })
  }
  out.sort((a, b) => (a.untilMs ?? 0) - (b.untilMs ?? 0))
  return out
}

/** Test seam: drop all rests. */
export function clearRestRegistryForTest(): void {
  rests.clear()
}
