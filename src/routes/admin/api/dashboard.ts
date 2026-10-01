import { Hono } from "hono"

import { logStore } from "~/lib/log-store"
import {
  getConnectionAuthError,
  getConnectionAuthStatus,
  getConnectionCooldownUntil,
  getConnectionExhaustedAt,
  getConnectionLastRateLimitReason,
  getConnectionProvider,
  getConnectionQuotaInfo,
  isAccountManagedConnection,
  isConnectionAvailable,
  listAccountManagedConnections,
  listProviderConnections,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import {
  resolveTimeZone,
  startOfDayMs,
  todayInTimeZone,
} from "~/lib/stats/timezone"
import { recentTraces } from "~/lib/trace-bus"

export const dashboardApiRoutes = new Hono()

interface AggregatedQuota {
  allAccountsUnlimited: boolean
  totalChatRemaining: number
  totalChatTotal: number
  totalPremiumRemaining: number
  totalPremiumTotal: number
}

// Aggregate quota info across all enabled accounts (legacy Copilot compat)
function aggregateQuotaInfo(): AggregatedQuota {
  const result: AggregatedQuota = {
    allAccountsUnlimited: true,
    totalChatRemaining: 0,
    totalChatTotal: 0,
    totalPremiumRemaining: 0,
    totalPremiumTotal: 0,
  }

  for (const conn of listAccountManagedConnections()) {
    if (!conn.enabled) continue
    const qi = getConnectionQuotaInfo(conn)
    if (!qi) continue

    if (!qi.unlimited) {
      result.allAccountsUnlimited = false
    }
    if (
      typeof qi.chatRemaining === "number"
      && typeof qi.chatTotal === "number"
    ) {
      result.totalChatRemaining += qi.chatRemaining
      result.totalChatTotal += qi.chatTotal
    }
    if (
      typeof qi.premiumInteractionsRemaining === "number"
      && typeof qi.premiumInteractionsTotal === "number"
    ) {
      result.totalPremiumRemaining += qi.premiumInteractionsRemaining
      result.totalPremiumTotal += qi.premiumInteractionsTotal
    }
  }

  return result
}

// Get active account quota info (legacy Copilot compat)
function getActiveQuotaInfo() {
  const enabled = listAccountManagedConnections()
    .filter((c) => c.enabled)
    .sort((a, b) => a.priority - b.priority)
  return enabled[0] ? getConnectionQuotaInfo(enabled[0]) : undefined
}

function buildActiveAccountQuota(
  activeQuotaInfo: ReturnType<typeof getActiveQuotaInfo>,
) {
  return {
    unlimited: activeQuotaInfo?.unlimited ?? false,
    premiumRemaining: activeQuotaInfo?.premiumInteractionsRemaining ?? null,
    premiumTotal: activeQuotaInfo?.premiumInteractionsTotal ?? null,
    chatRemaining: activeQuotaInfo?.chatRemaining ?? null,
    chatTotal: activeQuotaInfo?.chatTotal ?? null,
    completionsRemaining: activeQuotaInfo?.completionsRemaining ?? null,
    completionsTotal: activeQuotaInfo?.completionsTotal ?? null,
  } as const
}

function buildTotalQuota(aggregated: AggregatedQuota) {
  return {
    unlimited: aggregated.allAccountsUnlimited,
    premiumRemaining: aggregated.totalPremiumRemaining || null,
    premiumTotal: aggregated.totalPremiumTotal || null,
    chatRemaining: aggregated.totalChatRemaining || null,
    chatTotal: aggregated.totalChatTotal || null,
  } as const
}

interface DashboardAlert {
  id: string
  type: "cooldown" | "auth_error" | "exhausted"
  level: "error" | "warning" | "info"
  actionable: boolean
  connectionId: string
  connectionName: string
  provider: string
  isAccountManaged: boolean
  targetView: "accounts" | "connections" | "quotas"
  title: string
  message: string
  cooldownRemainingMs?: number
}

interface DashboardFleetItem {
  id: string
  name: string
  provider: string
  protocol: string
  enabled: boolean
  status: "healthy" | "cooldown" | "error" | "exhausted" | "disabled"
  statusMessage?: string
  cooldownRemainingMs?: number
  modelsCount: number
  todayRequests: number
  quotaInfo?: {
    unlimited?: boolean
    chatRemaining?: number | null
    chatTotal?: number | null
    premiumRemaining?: number | null
    premiumTotal?: number | null
  } | null
}

function collectFleetAndAlerts(now: number) {
  const connections = listProviderConnections()
  const alerts: Array<DashboardAlert> = []
  const fleetItems: Array<DashboardFleetItem> = []

  let healthyCount = 0
  let cooldownCount = 0
  let errorCount = 0
  let disabledCount = 0

  for (const conn of connections) {
    const cred = conn.credentials?.[0]
    const cooldownUntil = getConnectionCooldownUntil(conn)
    const authStatus = getConnectionAuthStatus(conn)
    const authError = getConnectionAuthError(conn)
    const exhaustedAt = getConnectionExhaustedAt(conn)
    const reason =
      cred?.lastError
      ?? cred?.lastRateLimitReason
      ?? getConnectionLastRateLimitReason(conn)
    const provider = (getConnectionProvider(conn) ?? conn.protocol) as string
    const quotaInfo = getConnectionQuotaInfo(conn)
    const accountStats = statsStore.getTodayStats(conn.id)
    const isAccountManaged = isAccountManagedConnection(conn)

    let status: DashboardFleetItem["status"] = "healthy"
    let statusMessage: string | undefined
    let cooldownRemainingMs: number | undefined

    if (!conn.enabled) {
      status = "disabled"
      disabledCount += 1
    } else if (cooldownUntil && cooldownUntil > now) {
      status = "cooldown"
      cooldownRemainingMs = cooldownUntil - now
      const seconds = Math.max(1, Math.ceil(cooldownRemainingMs / 1000))
      statusMessage =
        reason ?
          `${reason} (冷却剩余 ${seconds}s)`
        : `限流冷却中 (剩余 ${seconds}s)`
      cooldownCount += 1
      alerts.push({
        id: `cooldown-${conn.id}`,
        type: "cooldown",
        level: "warning",
        actionable: false,
        connectionId: conn.id,
        connectionName: conn.name,
        provider,
        isAccountManaged,
        targetView: isAccountManaged ? "accounts" : "connections",
        title: `${conn.name} 限流冷却中`,
        message: statusMessage,
        cooldownRemainingMs,
      })
    } else if (
      authError
      || authStatus === "failed"
      || cred?.status === "auth_error"
    ) {
      status = "error"
      statusMessage = authError || "鉴权失败 (401/403)"
      errorCount += 1
      alerts.push({
        id: `auth-${conn.id}`,
        type: "auth_error",
        level: "error",
        actionable: true,
        connectionId: conn.id,
        connectionName: conn.name,
        provider,
        isAccountManaged,
        targetView: isAccountManaged ? "accounts" : "connections",
        title: `${conn.name} 鉴权失败`,
        message: statusMessage,
      })
    } else if (exhaustedAt || cred?.status === "quota_exhausted") {
      status = "exhausted"
      statusMessage = "配额已耗尽"
      errorCount += 1
      alerts.push({
        id: `exhausted-${conn.id}`,
        type: "exhausted",
        level: "info",
        actionable: false,
        connectionId: conn.id,
        connectionName: conn.name,
        provider,
        isAccountManaged,
        targetView: "quotas",
        title: `${conn.name} 配额耗尽`,
        message: statusMessage,
      })
    } else {
      healthyCount += 1
    }

    fleetItems.push({
      id: conn.id,
      name: conn.name,
      provider,
      protocol: conn.protocol,
      enabled: conn.enabled,
      status,
      statusMessage,
      cooldownRemainingMs,
      modelsCount: conn.models?.length ?? 0,
      todayRequests: accountStats.requests,
      quotaInfo:
        quotaInfo ?
          {
            unlimited: quotaInfo.unlimited,
            chatRemaining: quotaInfo.chatRemaining,
            chatTotal: quotaInfo.chatTotal,
            premiumRemaining: quotaInfo.premiumInteractionsRemaining,
            premiumTotal: quotaInfo.premiumInteractionsTotal,
          }
        : null,
    })
  }

  // 真正需要处理的异常排在最前，状态提醒排在后
  alerts.sort((a, b) => {
    if (a.actionable !== b.actionable) {
      return a.actionable ? -1 : 1
    }
    return 0
  })

  return {
    alerts,
    fleet: {
      total: connections.length,
      healthy: healthyCount,
      cooldown: cooldownCount,
      error: errorCount,
      disabled: disabledCount,
      items: fleetItems,
    },
  }
}

dashboardApiRoutes.get("/", (c) => {
  const now = Date.now()
  const tz = resolveTimeZone(c.req.query("tz"))
  const todayStr = todayInTimeZone(tz)
  const startOfDay = startOfDayMs(todayStr, tz)

  // 1. 基础汇总数据 (兼容旧版)
  const aggregated = aggregateQuotaInfo()
  const activeQuotaInfo = getActiveQuotaInfo()
  const activeUsers = state.users.filter((u) => u.enabled).length
  const totalUsers = state.users.length
  const todayTotals = statsStore.getTodayTotals()
  const connections = listAccountManagedConnections()
  const activeAccounts = connections.filter((conn) =>
    isConnectionAvailable(conn),
  ).length
  const totalAccounts = connections.length

  // 2. 上游健康矩阵与告警
  const { alerts, fleet } = collectFleetAndAlerts(now)

  // 3. 实时并发与请求追踪
  const recentTraceRecords = recentTraces(10)
  const inFlightRequests = recentTraceRecords.filter((t) => t.inFlight).length
  const recentLiveTraces = recentTraceRecords
    .slice(-6)
    .reverse()
    .map((t) => ({
      requestId: t.requestId,
      timestamp: t.timestamp ?? now,
      inFlight: Boolean(t.inFlight),
      ok: t.ok,
      statusCode: t.statusCode,
      method: t.method ?? "POST",
      endpoint: t.endpoint,
      modelRequested: t.modelRequested ?? t.model ?? "unknown",
      modelUpstream: t.modelUpstream ?? t.modelResponse,
      connectionName: t.connectionName,
      provider: t.provider,
      latencyMs: t.latencyMs,
      ttftMs: t.ttftMs,
      generationTps: t.generationTps,
      isTranslated: Boolean(t.isTranslated),
    }))

  // 4. 今日 Token、成本与热门模型聚合
  const dayStats = statsStore.getUsageStatsByTimeRange({
    startMs: startOfDay,
    endMs: now + 60_000,
    tz,
  })

  let promptTokens = 0
  let completionTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let totalTokens = 0
  let cost = 0
  const modelUsageMap = new Map<
    string,
    { requests: number; totalTokens: number; cost: number }
  >()

  for (const day of dayStats) {
    promptTokens += day.promptTokens
    completionTokens += day.completionTokens
    cacheReadTokens += day.cacheReadTokens
    cacheWriteTokens += day.cacheWriteTokens
    totalTokens += day.totalTokens
    cost += day.cost

    for (const [model, s] of Object.entries(day.models)) {
      const existing = modelUsageMap.get(model) || {
        requests: 0,
        totalTokens: 0,
        cost: 0,
      }
      existing.requests += s.requests
      existing.totalTokens += s.totalTokens
      existing.cost += s.cost
      modelUsageMap.set(model, existing)
    }
  }

  const inputTokens = promptTokens + cacheReadTokens
  const cacheHitRate =
    inputTokens > 0 ?
      Number(((cacheReadTokens / inputTokens) * 100).toFixed(1))
    : null

  const topModels = [...modelUsageMap.entries()]
    .sort((left, right) => right[1].requests - left[1].requests)
    .slice(0, 5)
    .map(([model, s]) => ({
      model,
      requests: s.requests,
      totalTokens: s.totalTokens,
      cost: Number(s.cost.toFixed(4)),
      percentage:
        todayTotals.requests > 0 ?
          Number(((s.requests / todayTotals.requests) * 100).toFixed(1))
        : 0,
    }))

  // 5. 今日性能均值 (TTFT, TPS)
  const perfRows = statsStore.getPerformanceByModelInRange({
    startMs: startOfDay,
    endMs: now + 60_000,
  })
  let weightedTtftSum = 0
  let ttftCount = 0
  let weightedTpsSum = 0
  let tpsCount = 0

  for (const row of perfRows) {
    if (row.avgTtftMs !== null && row.requests > 0) {
      weightedTtftSum += row.avgTtftMs * row.requests
      ttftCount += row.requests
    }
    const tps = row.avgStreamingTps ?? row.avgNonStreamingTps
    if (tps !== null && row.requests > 0) {
      weightedTpsSum += tps * row.requests
      tpsCount += row.requests
    }
  }

  const avgTtftMs =
    ttftCount > 0 ? Math.round(weightedTtftSum / ttftCount) : null
  const avgTps =
    tpsCount > 0 ? Number((weightedTpsSum / tpsCount).toFixed(1)) : null

  // 6. 过去 24 小时走势
  const past24hMs = now - 24 * 60 * 60 * 1000
  const hourlySlots = statsStore.getUsageStatsByIntervalInRange({
    intervalMinutes: 60,
    startMs: past24hMs,
    endMs: now,
  })
  const hourlyTrend = hourlySlots.map((slot) => {
    const d = new Date(slot.slotTs)
    const hourStr = `${String(d.getHours()).padStart(2, "0")}:00`
    return {
      slotTs: slot.slotTs,
      hour: hourStr,
      requests: slot.requests,
      totalTokens: slot.totalTokens,
      cost: Number(slot.cost.toFixed(4)),
    }
  })

  const successRate =
    todayTotals.requests > 0 ?
      Number(
        (
          ((todayTotals.requests - todayTotals.errors) / todayTotals.requests)
          * 100
        ).toFixed(1),
      )
    : 100

  return c.json({
    // 旧字段保持 100% 兼容
    activeUsers,
    totalUsers,
    requestsToday: todayTotals.requests,
    errorsToday: todayTotals.errors,
    activeAccounts,
    totalAccounts,
    bufferSize: logStore.count(),
    activeAccountQuota: buildActiveAccountQuota(activeQuotaInfo),
    totalQuota: buildTotalQuota(aggregated),

    // 新增增强态势指标
    metrics: {
      requestsToday: todayTotals.requests,
      errorsToday: todayTotals.errors,
      successRate,
      inFlightRequests,
      todayTokens: {
        promptTokens,
        completionTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        cost: Number(cost.toFixed(4)),
        cacheHitRate,
      },
      performance: {
        avgTtftMs,
        avgTps,
      },
    },
    alerts,
    fleet,
    hourlyTrend,
    topModels,
    recentTraces: recentLiveTraces,
  })
})
