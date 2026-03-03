import { Hono } from "hono"

import { logStore } from "~/lib/log-store"
import { state } from "~/lib/state"

export const dashboardApiRoutes = new Hono()

dashboardApiRoutes.get("/", (c) => {
  const activeUsers = state.users.filter((u) => u.enabled).length
  const totalUsers = state.users.length
  const requestsToday = logStore.todayCount()
  const errorsToday = logStore.todayCount("error")
  const activeAccounts = state.accounts.filter((a) => !a.isExhausted).length
  const totalAccounts = state.accounts.length

  // Aggregate quota across active accounts
  const activeAccount = state.accounts[state.activeAccountIndex]
  const quotaInfo = activeAccount.quotaInfo

  return c.json({
    activeUsers,
    totalUsers,
    requestsToday,
    errorsToday,
    activeAccounts,
    totalAccounts,
    bufferSize: logStore.count(),
    quota: {
      unlimited: quotaInfo?.unlimited ?? false,
      premiumRemaining: quotaInfo?.premiumInteractionsRemaining ?? null,
      premiumTotal: quotaInfo?.premiumInteractionsTotal ?? null,
    },
  })
})
