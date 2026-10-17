import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface UsageData {
  requests?: number
  totalTokens?: number
  cost?: number
}

type Groups = Record<string, UsageData>
type Entries = Array<[string, UsageData]>

interface UsageView {
  usageSummary: { byAccount: Groups; byProvider: Groups }
  sortedAccountUsage: Entries
  sortedProviderUsage: Entries
  sortedProviderAccounts(data?: { accounts: Groups }): Entries
  sortedAccountModels(models?: Groups): Entries
}

function createView(): UsageView {
  return runInNewContext(
    readFileSync("pages/js/views/usage.js", "utf8") + "\nusageView()",
    { ViewHelpers: {}, usageAutoRefresh: () => ({}) },
  )
}

describe("usage view grouping", () => {
  test("all account and provider layers retain consumption-only adjustments without mutating usage", () => {
    const view = createView()
    const groups: Groups = {
      empty: { requests: 0, totalTokens: 0, cost: 0 },
      missing: {},
      normal: { requests: 2, totalTokens: 100, cost: 0.02 },
      adjustment: { requests: 0, totalTokens: 200, cost: 0.0012 },
      tokensOnly: { requests: 0, totalTokens: 50, cost: 0 },
      costOnly: { requests: 0, totalTokens: 0, cost: 0.0001 },
      requestsOnly: { requests: 1, totalTokens: 0, cost: 0 },
    }
    view.usageSummary.byAccount = groups
    view.usageSummary.byProvider = groups
    const before = JSON.stringify(view.usageSummary)
    for (const entries of [
      view.sortedAccountUsage,
      view.sortedProviderUsage,
      view.sortedProviderAccounts({ accounts: groups }),
    ]) {
      expect(entries.map(([id]) => id)).toEqual([
        "adjustment",
        "normal",
        "tokensOnly",
        "costOnly",
        "requestsOnly",
      ])
      for (const [id, data] of entries) expect(data).toBe(groups[id]!)
      expect(entries.find(([id]) => id === "adjustment")?.[1].requests).toBe(0)
      expect(entries.find(([id]) => id === "costOnly")?.[1].cost).toBe(0.0001)
    }
    expect(JSON.stringify(view.usageSummary)).toBe(before)
    // Both account -> model and provider -> account -> model use this method.
    expect(
      view
        .sortedAccountModels({
          normal: groups.normal!,
          adjustment: groups.adjustment!,
        })
        .map(([id]) => id),
    ).toEqual(["adjustment", "normal"])
  })

  test("missing groups remain empty", () => {
    const view = createView()
    expect(view.sortedAccountUsage).toEqual([])
    expect(view.sortedProviderUsage).toEqual([])
    expect(view.sortedProviderAccounts()).toEqual([])
    expect(view.sortedAccountModels()).toEqual([])
  })
})

test("usage drilldown costs preserve four decimal places including small adjustments", () => {
  const html = readFileSync("pages/index.html", "utf8")
  const dashboard = runInNewContext(
    readFileSync("pages/js/views/dashboard.js", "utf8") + "\ndashboardView()",
    { ViewHelpers: {} },
  ) as { formatCost: (cost?: number) => string }
  const expressions = Array.from(
    html.matchAll(/x-text="([^"\n]*(?:modelData|accountData)\.cost[^"\n]*)"/g),
    (match) => match[1]!,
  )
  expect(expressions).toHaveLength(3)
  for (const expression of expressions) {
    for (const [cost, expected] of [
      [0.0001, "$0.0001"],
      [1.23456, "$1.2346"],
      [0, "$0.0000"],
      [undefined, "$0.0000"],
    ] as const) {
      expect(
        runInNewContext(expression, {
          modelData: { cost },
          accountData: { cost },
        }),
      ).toBe(expected)
      expect(dashboard.formatCost(cost)).toBe(expected)
    }
  }
})
