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
 * credential is already at its cap, callers first rotate to idle candidates,
 * then join the bounded shared queue when every eligible candidate is busy.
 *
 * The cap is intentionally modest and configurable via
 * `COPILOT_API_CREDENTIAL_MAX_CONCURRENCY`. The default cap only trips
 * on genuine bursts; normal sequential turns sit far below it.
 */

import type { RequestAdmission } from "~/lib/request-admission"

import type { RouteTarget } from "~/lib/provider-connections"
import { isCredentialAvailable } from "~/lib/provider-connections"

import { getSystemSettings } from "~/lib/system-config"

import { LocalConcurrencyLimitError } from "~/lib/error"
import { targetKey, resolveConnectionFromTarget } from "~/lib/route-target"
import {
  acquireRouteTargetSlot,
  hasRouteTargetCapacity,
  resetRouteTargetLoadForTest,
  onRouteTargetSlotReleased,
} from "~/lib/route-target/load"

/**
 * A local pre-send rejection: the credential is at its in-flight cap.
 *
 * `HTTPError` (429) on purpose, mirroring `WindsurfConcurrencyLimitError`. Two
 * callers depend on that shape:
 *
 * - The HTTP failover loop must not cool the credential and must surface a
 *   retryable 429 when no target is left, not a 500. `executeWithFailover`
 *   already special-cases this class; the status makes the generic
 *   `forwardError` path correct too.
 * - The WS handler's `handleResponseError` would otherwise serialize a plain
 *   `Error` as a non-retryable 500.
 *
 * It is *not* an upstream failure, so callers must never treat it as one: see
 * the `LocalConcurrencyLimitError` marker (which also keeps the request trace
 * from labelling it `origin: upstream`) and `classifyWsFailure`'s
 * `local_saturation` scope.
 */
export class CredentialConcurrencyLimitError extends LocalConcurrencyLimitError {
  /** Routing key of the saturated credential; kept for logs, not for clients. */
  readonly credentialKey: string

  constructor(
    credentialKey: string,
    reason = "Credential concurrency limit reached; retry shortly",
  ) {
    // Generic client-facing copy: the credential key is a routing identity
    // (connection::credential::endpoint) and must not leak downstream. It
    // stays on `credentialKey` for logs; mirrors `WindsurfConcurrencyLimitError`,
    // whose `accountId` is likewise a field rather than part of the message.
    const message = reason
    const headers = new Headers({
      "Retry-After": "1",
      "retry-after-ms": "1000",
    })
    // JSON body so both `forwardError` (HTTP) and
    // `createResponsesErrorPayload` (WS) forward a typed retryable 429 instead
    // of a generic error.
    const body = JSON.stringify({
      error: {
        code: 429,
        message,
        retryable: true,
        type: "rate_limit_error",
      },
    })
    super(
      message,
      new Response(body, {
        status: 429,
        headers: {
          ...Object.fromEntries(headers),
          "Content-Type": "application/json",
        },
      }),
      body,
    )
    this.name = "CredentialConcurrencyLimitError"
    this.credentialKey = credentialKey
  }
}

export interface CredentialLease {
  release: () => void
}

/** Test-only: drop all per-credential in-flight counters. */
export function __resetCredentialGatesForTest(): void {
  for (const waiter of waiters.slice())
    waiter.fail(new Error("Concurrency queue reset"))
  resetRouteTargetLoadForTest()
}

/**
 * Acquire a lease for the given route target's credential, or return null when
 * the credential is at its reserved/active-turn cap. A returned lease
 * must be released exactly once (hand the lease to `wrapLeaseStream` for
 * streaming results so it is released at stream end).
 */
export function tryAcquireCredentialLease(
  target: RouteTarget,
): CredentialLease | null {
  if (
    waiters.some((waiter) =>
      waiter.targets.some(
        (candidate) => targetKey(candidate) === targetKey(target),
      ),
    )
  )
    return null
  const release = acquireRouteTargetSlot(targetKey(target))
  return release ? { release } : null
}

interface QueuedLease {
  target: RouteTarget
  lease: CredentialLease
}
interface Waiter {
  targets: readonly RouteTarget[]
  grant: (result: QueuedLease) => void
  fail: (error: unknown) => void
}
// One bounded queue shared by HTTP and WebSocket turns. Disjoint lanes can
// proceed independently; overlapping lanes retain arrival order.
const waiters: Waiter[] = []

function drainQueue(): void {
  const blocked = new Set<string>()
  for (const waiter of waiters.slice()) {
    const eligible = waiter.targets.filter((candidate) => {
      const resolved = resolveConnectionFromTarget(candidate)
      return (
        resolved?.connection.enabled
        && isCredentialAvailable(resolved.credential)
      )
    })
    if (eligible.length === 0) {
      waiter.fail(
        new CredentialConcurrencyLimitError(
          targetKey(waiter.targets[0]),
          "Queued connections are no longer available; retry shortly",
        ),
      )
      continue
    }
    const target = eligible.find(
      (candidate) =>
        !blocked.has(targetKey(candidate))
        && hasRouteTargetCapacity(targetKey(candidate)),
    )
    const release = target && acquireRouteTargetSlot(targetKey(target))
    if (target && release) waiter.grant({ target, lease: { release } })
    else
      for (const candidate of waiter.targets) blocked.add(targetKey(candidate))
  }
}
onRouteTargetSlotReleased(drainQueue)

/** Wait only after callers have tried every eligible idle target. */
export async function waitForCredentialLease(
  targets: readonly RouteTarget[],
  signal?: AbortSignal,
): Promise<QueuedLease> {
  signal?.throwIfAborted()
  const settings = getSystemSettings()
  if (
    targets.length === 0
    || waiters.length >= settings.concurrencyQueueLimit
  ) {
    return Promise.reject(
      new CredentialConcurrencyLimitError(
        targets[0] ? targetKey(targets[0]) : "",
        "Concurrency queue is full; retry shortly",
      ),
    )
  }
  const granted = await new Promise<QueuedLease>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      const index = waiters.indexOf(waiter)
      if (index !== -1) waiters.splice(index, 1)
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
    const waiter: Waiter = {
      targets,
      grant: (result) => {
        cleanup()
        // Release immediately if cancellation raced with a grant.
        if (signal?.aborted) {
          result.lease.release()
          reject(signal.reason)
        } else resolve(result)
      },
      fail: (error) => {
        cleanup()
        reject(error)
        queueMicrotask(drainQueue)
      },
    }
    const abort = () => waiter.fail(signal?.reason)
    waiters.push(waiter)
    signal?.addEventListener("abort", abort, { once: true })
    timer = setTimeout(
      () =>
        waiter.fail(
          new CredentialConcurrencyLimitError(
            targetKey(targets[0]),
            "Concurrency queue wait timed out; retry shortly",
          ),
        ),
      settings.concurrencyQueueWaitSeconds * 1000,
    )
    drainQueue()
  })
  if (signal?.aborted) {
    granted.lease.release()
    signal.throwIfAborted()
  }
  return granted
}

/** Restore the live credential after an asynchronous wait, not its old snapshot. */
export async function waitForAdmissionLease(
  candidates: readonly RequestAdmission[],
  signal?: AbortSignal,
): Promise<{ admission: RequestAdmission; lease: CredentialLease }> {
  const granted = await waitForCredentialLease(
    candidates.map((candidate) => candidate.target),
    signal,
  )
  const admission = candidates.find(
    (candidate) => targetKey(candidate.target) === targetKey(granted.target),
  )
  const resolved = resolveConnectionFromTarget(granted.target)
  if (
    !admission
    || !resolved
    || !resolved.connection.enabled
    || !isCredentialAvailable(resolved.credential)
    || signal?.aborted
  ) {
    granted.lease.release()
    signal?.throwIfAborted()
    throw new CredentialConcurrencyLimitError(
      targetKey(granted.target),
      "Queued connection is no longer available; retry shortly",
    )
  }
  return {
    admission: {
      ...admission,
      connection: resolved.connection,
      credential: resolved.credential,
    },
    lease: granted.lease,
  }
}

/** True when a value is an async iterable (a streaming response). */
export { isAsyncIterable } from "~/services/protocols/result-shape"

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
