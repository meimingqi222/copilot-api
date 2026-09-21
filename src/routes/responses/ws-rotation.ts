/**
 * WS response.create rotation helpers.
 *
 * The Responses WebSocket path does not go through `executeWithFailover`, so it
 * owns its own account rotation. These two pieces live here to keep
 * `ws-handler.ts` within the file-size budget:
 *
 *   - `selectNextResponsesAdmission` — same-protocol, account-backed next target.
 *   - `resolveSaturatedCredential` — the local in-flight-cap rejection path.
 */

import type { RequestAdmission } from "~/lib/request-admission"

import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import {
  connectionProvider,
  isAccountManagedConnection,
} from "~/lib/provider-connections"
import {
  resolveConnectionFromTarget,
  selectNextResponsesWsTarget,
  targetKey,
} from "~/lib/route-target"
import { CredentialConcurrencyLimitError } from "~/services/dispatch/concurrency"

/**
 * Same-protocol, account-backed next-target selection for the rotation loop.
 * Returns a fully resolved admission for the next candidate, or null when the
 * candidate set is exhausted (or the pinned connection has no more accounts).
 */
export function selectNextResponsesAdmission(
  initial: RequestAdmission,
  current: RequestAdmission,
  modelId: string,
  tried: Set<string>,
  compact?: boolean,
): RequestAdmission | null {
  const next = selectNextResponsesWsTarget(initial.target, modelId, tried, {
    sessionId: current.sessionId,
    fallbackSessionId: current.fallbackSessionId,
    compact,
  })
  if (!next) return null
  const resolved = resolveConnectionFromTarget(next)
  if (!resolved || !isAccountManagedConnection(resolved.connection)) {
    return null
  }
  return {
    target: next,
    connection: resolved.connection,
    credential: resolved.credential,
    initiator: current.initiator,
    sessionId: current.sessionId,
    fallbackSessionId: current.fallbackSessionId,
  }
}

export interface SaturationOutcome {
  /** The error to surface when no other account is available. */
  error: CredentialConcurrencyLimitError
  /** The next account to try, or null when the candidate set is exhausted. */
  next: RequestAdmission | null
}

/**
 * The credential chosen for this attempt is at its in-flight cap.
 *
 * Local saturation is not an upstream failure, so the caller must not cool the
 * account — it is healthy, just busy, and cooling it would punish its other
 * clients. This marks the target tried, logs the rejected attempt via the
 * returned error, and picks the next same-protocol account. A null `next` means
 * the caller should surface a retryable 429 (mirroring the HTTP path's
 * `RateLimitQueueFullError` handling) rather than a 500.
 */
export function resolveSaturatedCredential(
  admission: RequestAdmission,
  current: RequestAdmission,
  options: {
    modelId: string
    tried: Set<string>
    memoryTraceId: string
    compact?: boolean
  },
): SaturationOutcome {
  const { modelId, tried, memoryTraceId, compact } = options
  const error = new CredentialConcurrencyLimitError(targetKey(current.target))
  // The error message is intentionally generic for clients; name the saturated
  // credential here so operators can still see which one hit the cap.
  logger.warn(
    `responses websocket: credential ${error.credentialKey} at in-flight cap, rotating to next account`,
  )
  tried.add(targetKey(current.target))
  const next = selectNextResponsesAdmission(
    admission,
    current,
    modelId,
    tried,
    compact,
  )
  if (next) {
    updateMemoryTrace(memoryTraceId, "provider_account_rotation", {
      provider: connectionProvider(next.connection),
      accountId: next.connection.id,
      reason: "local_saturation",
    })
  }
  return { error, next }
}
