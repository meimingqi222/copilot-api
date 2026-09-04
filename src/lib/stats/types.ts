// 统计存储相关的类型定义（从 stats-store.ts 拆分而来，纯类型，无逻辑变更）

export interface DailyStats {
  date: string
  accountId: string
  requests: number
  errors: number
}

export interface UsageStats {
  date: string
  accountId: string
  userId?: string
  model: string
  provider?: string
  connectionId?: string
  credentialId?: string
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens: number
  cost?: number
  timestamp: number
  ttftMs?: number
  tps?: number
  streaming?: boolean
}

export type UsageModelStats = {
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
}

export type UsageDayStats = {
  date: string
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
  models: Record<string, UsageModelStats>
}

export type UsageIntervalStats = {
  slotTs: number
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
  models: Record<string, UsageModelStats>
}

export type TimestampRangeUsage = {
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
  models: Record<string, UsageModelStats>
}

export type UsageDayRow = {
  date: string
  requests: number
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  cost: number
}

export type UsageModelRow = {
  model: string
  requests: number
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  cost: number
}

export type UsageProviderRow = {
  provider: string | null
  account_id: string
  model: string
  requests: number
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  cost: number
}

/** Per-account rollup nested under a provider, for by-provider aggregation. */
export type ProviderAccountUsage = {
  label: string
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
  models: Record<string, UsageModelStats>
}

/** By-provider aggregation: provider id -> provider totals + nested accounts. */
export type UsageProviderStats = {
  label: string
  requests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
  accounts: Record<string, ProviderAccountUsage>
}
