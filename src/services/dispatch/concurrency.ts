/**
 * Per-credential in-flight gate.
 *
 * copilot-api reacts to upstream 429/5xx by cooling a credential *after* the
 * fact, but nothing bounds how many concurrent turns may be sent to the same
 * upstream credential at once — under heavy client concurrency every turn can
 * reach the upstream before the first 429 arrives, producing a burst-flood
 * shape on one account.
 *
 * This is a preventive pre-send gate: a bounded lease per credential that the
 * dispatch loop must hold before executing a turn and release when the turn
 * finishes (for streaming, when the response stream is fully consumed). When a
 * credential is already at its in-flight cap, dispatch throws a
 * `CredentialConcurrencyLimitError` so the failover loop re-routes to the next
 * eligible credential without cooling the saturated one (the same local
 * treatment as a per-account concurrency rejection, not an upstream failure).
 *
 * The cap is intentionally modest and configurable via
 * `COPILOT_API_CREDENTIAL_MAX_CONCURRENCY`. `MAX_INFLIGHT_DEFAULT` only trips
 * on genuine bursts; normal sequential turns sit far below it.
 */

import type { RouteTarget } from "~/lib/provider-connections"

import { targetKey } from "~/lib/route-target"

export class CredentialConcurrencyLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CredentialConcurrencyLimitError"
  }
}

export interface CredentialLease {
  release: () => void
}

const MAX_INFLIGHT_DEFAULT = 4

function readMaxInflight(): number {
  const raw = process.env.COPILOT_API_CREDENTIAL_MAX_CONCURRENCY
  if (!raw) return MAX_INFLIGHT_DEFAULT
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : MAX_INFLIGHT_DEFAULT
}

const MAX_INFLIGHT = readMaxInflight()
const gates = new Map<string, { active: number }>()

/**
 * Acquire a lease for the given route target's credential, or return null when
 * the credential already has `MAX_INFLIGHT` turns in flight. A returned lease
 * must be released exactly once (hand the lease to `wrapLeaseStream` for
 * streaming results so it is released at stream end).
 */
export function tryAcquireCredentialLease(
  target: RouteTarget,
): CredentialLease | null {
  const key = targetKey(target)
  let gate = gates.get(key)
  if (!gate) {
    gate = { active: 0 }
    gates.set(key, gate)
  }
  if (gate.active >= MAX_INFLIGHT) return null
  gate.active += 1
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      const current = gates.get(key)
      if (current) current.active = Math.max(0, current.active - 1)
    },
  }
}

/** True when a value is an async iterable (a streaming response). */
export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(
    value
      && typeof value === "object"
      && (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
        !== undefined,
  )
}

/**
 * Passthrough wrapper that holds the lease for the full lifetime of a streamed
 * response, releasing it only when the stream ends (normal completion, client
 * break/close, or an error thrown mid-stream).
 */
export async function* wrapLeaseStream<T>(
  stream: AsyncIterable<T>,
  lease: CredentialLease,
): AsyncIterable<T> {
  try {
    for await (const item of stream) yield item
  } finally {
    lease.release()
  }
}
