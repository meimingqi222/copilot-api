import { isRecord } from "~/lib/json-shape"
import type { ProviderQuotaSnapshot, QuotaWindow } from "~/lib/quota/types"

function capacity(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) ?
      Math.max(0, n)
    : undefined
}

function creditTotals(rows: Array<unknown>) {
  let total = 0
  let remaining = 0
  for (const row of rows) {
    if (!isRecord(row)) continue
    const limit = capacity(row.CycleTotalCapacity)
    if (!limit) continue
    const used = capacity(row.CycleUsedCapacity)
    const left = capacity(row.CycleRemainCapacity)
    if (used === undefined && left === undefined) continue
    total += limit
    remaining += Math.min(limit, left ?? Math.max(0, limit - (used ?? 0)))
  }
  return { total, remaining }
}

function creditWindow(
  id: string,
  remaining: number,
  total?: number,
): QuotaWindow {
  return {
    id,
    unit: "credits",
    remaining,
    ...(total ? { total, used: 1 - remaining / total } : {}),
  }
}

function snapshot(
  provider: string,
  windows: Array<QuotaWindow>,
  details: Record<string, unknown>,
): ProviderQuotaSnapshot {
  const routing = windows[0]
  return {
    provider,
    fetchedAt: Date.now(),
    unlimited: false,
    allowance: { state: routing ? "known" : "unknown", windows },
    chatRemaining: routing?.remaining,
    chatTotal: routing?.total,
    details: { ...details, remain: routing?.remaining, size: routing?.total },
  }
}

export function parseWorkbuddyUsageSummary(
  data: unknown,
  provider: string,
): ProviderQuotaSnapshot | undefined {
  if (!isRecord(data)) return undefined
  const packages = Array.isArray(data.Packages) ? data.Packages : []
  const groups =
    Array.isArray(data.CreditGroups) ? data.CreditGroups.filter(isRecord) : []
  const plan = creditTotals(groups.filter((row) => row.Kind === "plan_base"))
  const extra = creditTotals(groups.filter((row) => row.Kind !== "plan_base"))
  const grouped = plan.total + extra.total
  const finite =
    grouped ?
      { total: grouped, remaining: plan.remaining + extra.remaining }
    : creditTotals(packages)
  let prepaid: number | undefined
  for (const row of packages) {
    if (!isRecord(row) || capacity(row.CycleTotalCapacity) !== undefined)
      continue
    const balance = capacity(row.CycleRemainCapacity)
    if (balance !== undefined) prepaid = (prepaid ?? 0) + balance
  }
  if (!finite.total && prepaid === undefined) return undefined
  const remaining = finite.remaining + (prepaid ?? 0)
  // Parts are informational; routing must not stop when one pool is depleted.
  const windows = [
    creditWindow("credits", remaining, prepaid ? undefined : finite.total),
  ]
  if (plan.total && extra.total) {
    windows.push({
      ...creditWindow("plan-credits", plan.remaining, plan.total),
      aside: true,
    })
    windows.push({
      ...creditWindow("extra-credits", extra.remaining, extra.total),
      aside: true,
    })
  }
  if (prepaid !== undefined) {
    if (finite.total && prepaid)
      windows.push({
        ...creditWindow("cycle-credits", finite.remaining, finite.total),
        aside: true,
      })
    windows.push({ ...creditWindow("prepaid-credits", prepaid), aside: true })
  }
  return snapshot(provider, windows, {
    plan: data.IsPaidUser === true ? "Pro" : "Free plan",
    prepaid,
    totalCycleCredits: finite.total,
  })
}

function beijingTime(value: unknown): number | undefined {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value.trim())
  )
    return undefined
  const ms = Date.parse(`${value.trim().replace(" ", "T")}+08:00`)
  return Number.isFinite(ms) ? ms : undefined
}

export function parseWorkbuddyEnterpriseUsage(
  data: unknown,
  provider: string,
): ProviderQuotaSnapshot | undefined {
  if (!isRecord(data)) return undefined
  const total = capacity(data.limitNum)
  const used = capacity(data.credit)
  if (!total || used === undefined) return undefined
  const window = creditWindow("credits", Math.max(0, total - used), total)
  window.resetsAtMs = beijingTime(data.cycleResetTime)
  const start = beijingTime(data.cycleStartTime)
  if (window.resetsAtMs && start && window.resetsAtMs > start)
    window.spanMs = window.resetsAtMs - start
  return snapshot(provider, [window], { plan: "Enterprise", used })
}
