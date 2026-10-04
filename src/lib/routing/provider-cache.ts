/**
 * L0 routing defaults for multi-account prompt-cache utilization.
 *
 * L1 (provider-specific cache rewrites — Claude session headers, Codex
 * prompt_cache_key / identity confuse, x-grok-conv-id, Windsurf session
 * buckets, …) live directly in each provider's own service under
 * services/<provider>/. There is deliberately no central capability table:
 * a declarative profile that nothing on the request path consults drifts
 * from the behavior it describes (a previous one did, and was removed).
 */

/**
 * Shared routing defaults balance allowance with prompt-cache reuse (L0).
 *
 * - quota: new sessions use allowance pressure and renewal times within the
 *   primary priority tier, using a healthy backup when the primary is spent.
 * - sessionAffinity: known sessions stick across turns (including failover
 *   rebind when the bound credential is unavailable).
 * - 2h sliding TTL: long agent sessions keep binding without re-scatter.
 * - identityConfuse off: does not improve hit rate (Codex TOS paranoia only).
 */
export const CACHE_UTILIZATION_DEFAULTS: {
  strategy: "round-robin" | "fill-first" | "quota"
  sessionAffinity: boolean
  sessionAffinityTtlMs: number
  identityConfuse: boolean
  affinity: "session" | "turn" | "auto" | "off"
  quotaLowShare: number
  quotaSpentShare: number
} = {
  strategy: "quota",
  sessionAffinity: true,
  sessionAffinityTtlMs: 2 * 60 * 60_000,
  identityConfuse: false,
  affinity: "session",
  // Bands where a subscription's allowance stops being "fine": past `low` it
  // is kept for backup, past `spent` it is a last resort only.
  quotaLowShare: 0.9,
  quotaSpentShare: 0.98,
}
