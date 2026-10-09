import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface TrendData {
  series: Array<{
    slotTs: number
    avgDecodeTps: number
    avgStreamingTps: number
  }>
}

interface TrendView {
  dateRange: string
  expandedRows: Record<string, boolean>
  renderTrendChart(key: string, canvasId: string, data: TrendData): void
  updateOrRenderTrendChart(key: string, canvasId: string, data: TrendData): void
  refreshCachedUsage(): Promise<void>
  toggleModelTrend(model: string): void
  toggleProviderTrend(row: { provider: string; model: string }): void
  destroyTrendCharts(): void
}

// Alpine deeply proxies objects read from component state, including class instances.
function reactive<T extends object>(target: T): T {
  const proxies = new WeakMap<object, object>()
  function wrap<V extends object>(value: V): V {
    const cached = proxies.get(value)
    if (cached) return cached as V
    const proxy = new Proxy(value, {
      get(object, key, receiver) {
        const result: unknown = Reflect.get(object, key, receiver)
        return result && typeof result === "object" ? wrap(result) : result
      },
    })
    proxies.set(value, proxy)
    return proxy
  }
  return wrap(target)
}

function setup() {
  const charts: TestChart[] = []
  const warnings: unknown[][] = []
  const canvas = { offsetParent: {}, getContext: () => ({}) }
  let trend: TrendData = {
    series: [{ slotTs: 1, avgDecodeTps: 10, avgStreamingTps: 20 }],
  }
  class TestChart {
    ctx: object
    data: { labels: string[]; datasets: Array<{ data: number[] }> }
    updates: string[] = []
    destroyed = false

    constructor(ctx: object, config: { data: TestChart["data"] }) {
      this.ctx = ctx
      this.data = config.data
      charts.push(this)
    }

    update(mode: string) {
      expect(charts.includes(this)).toBe(true)
      this.updates.push(mode)
    }

    destroy() {
      expect(charts.includes(this)).toBe(true)
      this.destroyed = true
    }
  }
  const factory = runInNewContext(
    readFileSync("pages/js/usage-auto-refresh.js", "utf8")
      + "\n"
      + readFileSync("pages/js/views/performance.js", "utf8")
      + "\nperformanceView",
    {
      ViewHelpers: {},
      I18n: { t: (key: string) => key },
      Chart: TestChart,
      document: { getElementById: () => canvas, documentElement: {} },
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
      API: {
        usage: {
          performance: async () => ({}),
          performanceTrend: async () => trend,
        },
      },
      console: {
        warn: (...args: unknown[]) => {
          warnings.push(args)
        },
      },
    },
  ) as () => TrendView
  return {
    charts,
    warnings,
    createView: () => reactive(factory()),
    get trend() {
      return trend
    },
    setTrend: (data: TrendData) => {
      trend = data
    },
  }
}

describe("performance trend chart lifecycle", () => {
  test("silent refresh updates the original chart outside reactive state", async () => {
    const env = setup()
    const view = env.createView()
    const key = "model::gpt-6.1-sol"
    view.expandedRows[key] = true
    view.renderTrendChart(key, "chart", env.trend)
    env.setTrend({
      series: [{ slotTs: 2, avgDecodeTps: 30, avgStreamingTps: 40 }],
    })

    await view.refreshCachedUsage()
    await view.refreshCachedUsage()

    expect(env.warnings).toEqual([])
    expect(env.charts).toHaveLength(1)
    expect(env.charts[0].updates).toEqual(["none", "none"])
    expect(env.charts[0].data.datasets.map((dataset) => dataset.data)).toEqual([
      [30],
      [40],
    ])
  })

  test("redraw, row collapse and view cleanup destroy original instances", () => {
    const env = setup()
    const view = env.createView()
    const modelKey = "model::gpt-6.1-sol"
    const providerKey = "prov::copilot::gpt-6.1-sol"
    view.expandedRows[modelKey] = true
    view.expandedRows[providerKey] = true
    view.renderTrendChart(modelKey, "chart", env.trend)
    view.renderTrendChart(modelKey, "chart", env.trend)
    expect(env.charts[0].destroyed).toBe(true)
    view.toggleModelTrend("gpt-6.1-sol")
    expect(env.charts[1].destroyed).toBe(true)

    view.renderTrendChart(providerKey, "chart", env.trend)
    view.toggleProviderTrend({ provider: "copilot", model: "gpt-6.1-sol" })
    expect(env.charts[2].destroyed).toBe(true)
    view.renderTrendChart(modelKey, "chart", env.trend)
    view.destroyTrendCharts()
    expect(env.charts[3].destroyed).toBe(true)
    view.updateOrRenderTrendChart(modelKey, "chart", env.trend)
    expect(env.charts).toHaveLength(5)
  })

  test("chart storage is isolated between view instances", () => {
    const env = setup()
    const first = env.createView()
    const second = env.createView()
    first.renderTrendChart("model::same", "first", env.trend)
    second.renderTrendChart("model::same", "second", env.trend)
    first.destroyTrendCharts()
    expect(env.charts[0].destroyed).toBe(true)
    expect(env.charts[1].destroyed).toBe(false)
    second.destroyTrendCharts()
  })

  test("live rolling ranges auto-refresh; historical ranges stay frozen", async () => {
    const env = setup()
    const view = env.createView()
    const key = "model::gpt-6.1-sol"
    view.expandedRows[key] = true
    view.renderTrendChart(key, "chart", env.trend)

    // Historical range: no traffic flows in, so auto-refresh must skip it.
    view.dateRange = "last30d"
    await view.refreshCachedUsage()
    expect(env.charts[0].updates).toEqual([])

    // Rolling live window: updates in place every poll.
    view.dateRange = "last1h"
    await view.refreshCachedUsage()
    expect(env.charts[0].updates).toEqual(["none"])
  })
})
