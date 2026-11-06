/**
 * QuotaSnapshot 类型定义。
 *
 * Phase 5:从 provider-connections/types.ts 迁移到 lib/quota/types.ts,
 * 作为 quota 子系统的类型根。
 */

/** Provider-owned quota semantics. Labels and raw details are never scopes. */
export interface QuotaWindow {
  /** Stable within a provider. Optional only for legacy plan-cache entries. */
  id?: string
  /** Used share, 0..1; absent is unknown, not zero. */
  used?: number
  remaining?: number
  total?: number
  unit?: "percent" | "requests" | "tokens" | "credits" | "currency" | "units"
  spanMs?: number
  resetsAtMs?: number
  expiresAtMs?: number
  /** Exact native model ids; an empty set intentionally matches nothing. */
  scope?: { models: Array<string> }
  /** Legacy cache substring scope, never emitted by new providers. */
  model?: string
  aside?: boolean
  unlimited?: boolean
}

export interface QuotaAllowance {
  state: "known" | "unknown" | "unsupported" | "unlimited" | "not-included"
  windows: Array<QuotaWindow>
  /** Response events replace only the windows they measured. */
  partial?: boolean
}

/**
 * What a provider's quota fetch returns. `allowance` is the routing contract,
 * so it is required here: a fetcher that cannot measure says `unknown`.
 */
export type ProviderQuotaSnapshot = QuotaSnapshot & {
  allowance: QuotaAllowance
}

/** 上游配额快照。旧计数和 details 仅保留展示与历史兼容。 */
export interface QuotaSnapshot {
  fetchedAt: number
  allowance?: QuotaAllowance
  premiumInteractionsRemaining?: number
  premiumInteractionsTotal?: number
  chatRemaining?: number
  chatTotal?: number
  completionsRemaining?: number
  completionsTotal?: number
  unlimited: boolean
  provider?: string
  details?: Record<string, unknown>
}
