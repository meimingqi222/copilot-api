import { Hono } from "hono"

import { logStore } from "~/lib/log-store"
import {
  getConnectionQuotaInfo,
  isConnectionAvailable,
  listAccountManagedConnections,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"

export const dashboardApiRoutes = new Hono()

interface AggregatedQuota {
  allAccountsUnlimited: boolean
  totalChatRemaining: number
  totalChatTotal: number
  totalPremiumRemaining: number
  totalPremiumTotal: number
}

// Aggregate quota info across all enabled accounts
function aggregateQuotaInfo(): AggregatedQuota {
  const result: AggregatedQuota = {
    allAccountsUnlimited: true,
    totalChatRemaining: 0,
    totalChatTotal: 0,
    totalPremiumRemaining: 0,
    totalPremiumTotal: 0,
  }

  // 使用 connection 原生列表读取配额(替代 listAccounts())
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

// Get active account quota info
function getActiveQuotaInfo() {
  // 按 priority 排序取第一个 enabled connection 的配额(替代 listAccounts())
  const enabled = listAccountManagedConnections()
    .filter((c) => c.enabled)
    .sort((a, b) => a.priority - b.priority)
  return enabled[0] ? getConnectionQuotaInfo(enabled[0]) : undefined
}

// Build active account quota response
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

// Build total quota response
function buildTotalQuota(aggregated: AggregatedQuota) {
  return {
    unlimited: aggregated.allAccountsUnlimited,
    premiumRemaining: aggregated.totalPremiumRemaining || null,
    premiumTotal: aggregated.totalPremiumTotal || null,
    chatRemaining: aggregated.totalChatRemaining || null,
    chatTotal: aggregated.totalChatTotal || null,
  } as const
}

// Build dashboard response
function buildDashboardResponse(aggregated: AggregatedQuota) {
  const activeQuotaInfo = getActiveQuotaInfo()
  const activeUsers = state.users.filter((u) => u.enabled).length
  const totalUsers = state.users.length
  const totals = statsStore.getTodayTotals()
  // 使用 connection 原生列表统计账号数(替代 listAccounts())
  const connections = listAccountManagedConnections()
  const activeAccounts = connections.filter((conn) =>
    isConnectionAvailable(conn),
  ).length
  const totalAccounts = connections.length

  return {
    activeUsers,
    totalUsers,
    requestsToday: totals.requests,
    errorsToday: totals.errors,
    activeAccounts,
    totalAccounts,
    bufferSize: logStore.count(),
    activeAccountQuota: buildActiveAccountQuota(activeQuotaInfo),
    totalQuota: buildTotalQuota(aggregated),
  }
}

dashboardApiRoutes.get("/", (c) => {
  const aggregated = aggregateQuotaInfo()
  return c.json(buildDashboardResponse(aggregated))
})
