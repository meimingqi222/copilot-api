// In-memory recent-serve counter per (connectionId, credentialId).
//
// Feeds the `least-used` routing policy and the trace view's "served lately"
// column. Tokens decay with a 1h half-life so a burst an hour ago weighs half
// as much as the same burst now.
// Memory-only on purpose: a restart relearns within a few requests, and this
// counter must never block the request path on persistence.

const HALF_LIFE_MS = 60 * 60 * 1000

const served = new Map<string, { tokens: number; atMs: number }>()

function decayedTokens(
  entry: { tokens: number; atMs: number },
  nowMs: number,
): number {
  return entry.tokens * Math.pow(0.5, (nowMs - entry.atMs) / HALF_LIFE_MS)
}

function recentServeKey(connectionId: string, credentialId: string): string {
  return `${connectionId}::${credentialId}`
}

/** Record tokens served by a credential. `0` counts as an answer (min 1). */
export function recordServedTokens(
  connectionId: string,
  credentialId: string,
  tokens: number,
): void {
  if (!connectionId || !credentialId) return
  const n = Math.max(1, Math.trunc(tokens))
  const now = Date.now()
  const prev = served.get(recentServeKey(connectionId, credentialId))
  const total = (prev ? decayedTokens(prev, now) : 0) + n
  served.set(recentServeKey(connectionId, credentialId), {
    tokens: total,
    atMs: now,
  })
}

/** Current decayed served-token count for a credential. */
export function servedTokensOf(
  connectionId: string,
  credentialId: string,
): number {
  const entry = served.get(recentServeKey(connectionId, credentialId))
  return entry ? decayedTokens(entry, Date.now()) : 0
}

/** Test seam: drop all counters. */
export function clearRecentServeForTest(): void {
  served.clear()
}
