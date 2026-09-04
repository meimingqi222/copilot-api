/**
 * QuotaSnapshot 类型定义。
 *
 * Phase 5:从 provider-connections/types.ts 迁移到 lib/quota/types.ts,
 * 作为 quota 子系统的类型根。provider-connections/types.ts 和 accounts.ts
 * 保留 re-export 以向后兼容。
 */

/**
 * 上游配额快照。记录某次 quota 刷新获取的配额信息。
 */
export interface QuotaSnapshot {
  fetchedAt: number
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
