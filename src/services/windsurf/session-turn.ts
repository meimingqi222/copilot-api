/**
 * Per-session monotonic turn counter for Windsurf/Devin field 15.2.
 *
 * Matches native devin-cli semantics (see CPA
 * `NextDevinSessionTurnIndex`): process-scoped per session, first request
 * returns 0 (omitted on the wire), subsequent requests return 1, 2, 3...
 * Bounded LRU so long-running processes cannot grow the map without limit.
 */

const MAX_SESSION_TURN_COUNTERS = 5000

const sessionTurnCounters = new Map<string, number>()

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim()
}

export function nextWindsurfSessionTurnIndex(sessionId: string): number {
  const cleanId = normalizeSessionId(sessionId)
  if (!cleanId) return 0
  const current = sessionTurnCounters.get(cleanId) ?? 0
  // Refresh recency on hit so eviction is LRU, not FIFO (Map.set on an
  // existing key preserves its original insertion position).
  if (sessionTurnCounters.has(cleanId)) {
    sessionTurnCounters.delete(cleanId)
  } else if (sessionTurnCounters.size >= MAX_SESSION_TURN_COUNTERS) {
    // Evict oldest entry when at capacity (Map preserves insertion order).
    const oldest = sessionTurnCounters.keys().next()
    if (!oldest.done) sessionTurnCounters.delete(oldest.value)
  }
  sessionTurnCounters.set(cleanId, current + 1)
  return current
}

export function resetWindsurfSessionTurnIndex(sessionId: string): void {
  sessionTurnCounters.delete(normalizeSessionId(sessionId))
}

/** Test hook: drop all turn counters. */
export function clearWindsurfSessionTurnCountersForTest(): void {
  sessionTurnCounters.clear()
}
