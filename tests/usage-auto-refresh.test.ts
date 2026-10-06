import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface PollView {
  autoRefreshSeconds: number
  autoRefreshDue: number
  autoRefreshVisibilityHandler: () => void
  refreshCachedUsage: () => Promise<void>
  initAutoRefresh(): void
  pollUsageView(): Promise<void>
  setAutoRefresh(value: string): void
  destroy(): void
}

function fixture() {
  const document = {
    hidden: false,
    querySelector: () => ({}),
    addEventListener() {},
    removeEventListener() {},
  }
  const app = { currentView: "usage" }
  let saved: string | null = null
  let cleared = false
  let timers = 0
  const view: PollView = runInNewContext(
    readFileSync("pages/js/usage-auto-refresh.js", "utf8")
      + '\nusageAutoRefresh("usage")',
    {
      document,
      Alpine: { $data: () => app },
      localStorage: {
        getItem: () => saved,
        setItem: (_key: string, value: string) => {
          saved = value
        },
      },
      setInterval: () => ++timers,
      clearInterval: () => {
        cleared = true
      },
      console,
    },
  )
  return {
    view,
    document,
    app,
    saved: () => saved,
    cleared: () => cleared,
    timers: () => timers,
  }
}

test("visible-page polling pauses when hidden, inactive or disabled and respects cadence", async () => {
  const { view, document, app, saved, cleared, timers } = fixture()
  let reads = 0
  view.refreshCachedUsage = async () => {
    reads++
  }
  view.initAutoRefresh()
  view.initAutoRefresh()
  expect(timers()).toBe(1)
  expect(view.autoRefreshSeconds).toBe(5)
  await view.pollUsageView()
  await view.pollUsageView()
  expect(reads).toBe(1)
  view.autoRefreshDue = 0
  document.hidden = true
  await view.pollUsageView()
  document.hidden = false
  app.currentView = "quotas"
  await view.pollUsageView()
  expect(reads).toBe(1)
  app.currentView = "usage"
  view.setAutoRefresh("0")
  await view.pollUsageView()
  expect(reads).toBe(1)
  expect(saved()).toBe("0")
  view.setAutoRefresh("10")
  view.setAutoRefresh("-1")
  expect(view.autoRefreshSeconds).toBe(10)
  await view.pollUsageView()
  expect(reads).toBe(2)
  view.destroy()
  expect(cleared()).toBe(true)
})

test("slow cache requests do not overlap", async () => {
  const { view } = fixture()
  let reads = 0
  let release = () => {}
  view.refreshCachedUsage = () => {
    reads++
    return new Promise<void>((resolve) => {
      release = resolve
    })
  }
  const pending = view.pollUsageView()
  await view.pollUsageView()
  expect(reads).toBe(1)
  release()
  await pending
})

test("automatic view refresh reads only cached APIs and unchanged usage does not redraw", async () => {
  let quotaReads = 0
  let usageReads = 0
  let charts = 0
  const usageData = { totalRequests: 1 }
  const context = {
    ViewHelpers: {},
    document: { querySelector: () => ({}) },
    Alpine: { $data: () => ({ currentView: "usage" }) },
    refreshAdminIcons() {},
    API: {
      quota: {
        get: async () => {
          quotaReads++
          return { accounts: [] }
        },
      },
      usage: {
        summary: async () => {
          usageReads++
          return usageData
        },
      },
    },
    console,
  }
  const shared = readFileSync("pages/js/usage-auto-refresh.js", "utf8")
  const usage: {
    refreshCachedUsage(): Promise<void>
    renderChart(): void
    $nextTick(callback: () => void): void
    lastUpdatedAt: number
  } = runInNewContext(
    shared
      + "\n"
      + readFileSync("pages/js/views/usage.js", "utf8")
      + "\nusageView()",
    context,
  )
  usage.$nextTick = (callback) => callback()
  usage.renderChart = () => {
    charts++
  }
  await usage.refreshCachedUsage()
  await usage.refreshCachedUsage()
  expect(usageReads).toBe(2)
  expect(charts).toBe(1)
  expect(usage.lastUpdatedAt).toBeGreaterThan(0)
  const quotas: {
    refreshCachedUsage(): Promise<void>
    $nextTick(callback: () => void): void
    lastUpdatedAt: number
  } = runInNewContext(
    shared
      + "\n"
      + readFileSync("pages/js/views/quotas.js", "utf8")
      + "\nquotasView()",
    context,
  )
  quotas.$nextTick = (callback) => callback()
  await quotas.refreshCachedUsage()
  expect(quotaReads).toBe(1)
  expect(quotas.lastUpdatedAt).toBeGreaterThan(0)
})

test("a slow previous-range response cannot overwrite a newer usage range", async () => {
  const replies: Array<(value: { totalRequests: number }) => void> = []
  const usage: {
    dateRange: string
    loadUsageStats(): Promise<void>
    usageSummary: { totalRequests: number }
  } = runInNewContext(
    readFileSync("pages/js/usage-auto-refresh.js", "utf8")
      + "\n"
      + readFileSync("pages/js/views/usage.js", "utf8")
      + "\nusageView()",
    {
      ViewHelpers: {},
      API: {
        usage: {
          summary: () => new Promise((resolve) => replies.push(resolve)),
        },
      },
      console,
    },
  )
  const older = usage.loadUsageStats()
  usage.dateRange = "week"
  const newer = usage.loadUsageStats()
  replies[1]!({ totalRequests: 20 })
  await newer
  replies[0]!({ totalRequests: 1 })
  await older
  expect(usage.usageSummary.totalRequests).toBe(20)
})
