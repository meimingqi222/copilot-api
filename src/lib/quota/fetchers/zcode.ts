/**
 * ZCode 配额拉取。
 *
 * - GLM Coding Plan：`GET {siteRoot}/api/monitor/usage/quota/limit`，key
 *   裸放 `Authorization`（不是 Bearer）。响应 { level, limits: [...] }，
 *   unit 3 = 五小时窗口，6 = 周窗口。用百分比或「总量 - 剩余」还原已用。
 * - Start Plan（体验套餐 / 临时领的积分）：账号没有 Coding Plan 时走
 *   `GET {zcodeApi}/api/v1/zcode-plan/billing/balance`，ZCode 会话 JWT
 *   作 Bearer + X-Device-Mid。每个余额桶一个窗口，过期 plan 及其桶已被
 *   parseZcodeStartBalance 剔除（临时积分到期不显示）。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import {
  getConnectionProvider,
  getCredentialContextString,
} from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import {
  ZCODE_APP_VERSION,
  ZCODE_BIGMODEL_BIZ_API,
  ZCODE_ZAI_BIZ_API,
  type ZcodeSite,
} from "~/services/oauth/zcode"
import {
  resolveZcodeRoute,
  zcodeActiveStartPlan,
  zcodeStartBalance,
  type ZcodeStartBalance,
} from "~/services/zcode/start-plan"

interface ZcodeQuotaWindow {
  name: string
  usedPercent: number
  resetsAt?: number
  display: string
}

interface ParsedZcodeQuota {
  level?: string
  windows: Array<ZcodeQuotaWindow>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function zcodeSiteRoot(site: string | undefined): string {
  return site === "bigmodel" ? ZCODE_BIGMODEL_BIZ_API : ZCODE_ZAI_BIZ_API
}

function windowName(unit: number, number: number): string {
  if (unit === 3) return "5 hours"
  if (unit === 6) return "7 days"
  if (number > 0) return `${number} units`
  return "window"
}

/** 解析 /api/monitor/usage/quota/limit 的 data 部分。 */
export function parseZcodeQuota(raw: unknown): ParsedZcodeQuota | undefined {
  const root = asRecord(raw)
  if (!root) return undefined
  const limits = Array.isArray(root.limits) ? root.limits : []
  const windows: Array<ZcodeQuotaWindow> = []
  for (const item of limits) {
    const x = asRecord(item)
    if (!x) continue
    const unit = num(x.unit) ?? 0
    const number = num(x.number) ?? 0
    const total = num(x.usage)
    const remaining = num(x.remaining)
    const current = num(x.currentValue)
    const percent = num(x.percentage)
    let used = percent ?? 0
    // 与 valueText/进度条的「剩余」口径一致：剩余 / 总量（或剩余%）。
    let display = `${(100 - used).toFixed(0)}%`
    if (total !== undefined && total > 0) {
      if (remaining !== undefined) {
        const usedAbs = total - remaining
        used = (100 * usedAbs) / total
        display = `${Math.max(0, remaining).toFixed(0)} / ${total.toFixed(0)}`
      } else if (current !== undefined) {
        if (percent === undefined) used = (100 * current) / total
        display = `${Math.max(0, total - current).toFixed(0)} / ${total.toFixed(0)}`
      }
    }
    const reset = num(x.nextResetTime)
    windows.push({
      name: windowName(unit, number),
      usedPercent: Math.min(Math.max(used, 0), 100),
      resetsAt: reset !== undefined && reset > 0 ? reset : undefined,
      display,
    })
  }
  const level = typeof root.level === "string" ? root.level : undefined
  return { level, windows }
}

function buildSnapshot(parsed: ParsedZcodeQuota, host: string): QuotaSnapshot {
  const plan =
    parsed.level ?
      `GLM Coding ${parsed.level.charAt(0).toUpperCase()}${parsed.level.slice(1)}`
    : undefined
  const base: QuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: "zcode",
    unlimited: parsed.windows.length === 0,
    details: { zcode: { host, plan, windows: parsed.windows } },
  }
  if (parsed.windows.length === 0) return base
  const usedPercent = Math.max(...parsed.windows.map((w) => w.usedPercent))
  const primary = parsed.windows[0]!
  return {
    ...base,
    premiumInteractionsRemaining: Math.round(Math.max(0, 100 - usedPercent)),
    premiumInteractionsTotal: 100,
    chatRemaining: Math.max(0, Math.round(100 - primary.usedPercent)),
    chatTotal: 100,
  }
}

// ── Start Plan（billing/balance → 余额桶窗口） ──────────────────

function periodLabel(ms: number): string {
  const days = ms / 86_400_000
  if (days >= 28) return "Monthly"
  if (Math.abs(days - 7) < 1) return "Weekly"
  if (Math.abs(days - 1) < 1) return "Daily"
  return days > 1 ? `${Math.round(days)} days` : "Credits"
}

function bucketPeriodMs(
  bucket: ZcodeStartBalance["balances"][number],
  balance: ZcodeStartBalance,
): number {
  const plan = balance.plans.find(
    (p) =>
      (bucket.userPlanId !== ""
        && p.userPlanId !== ""
        && bucket.userPlanId === p.userPlanId)
      || ((bucket.userPlanId === "" || p.userPlanId === "")
        && bucket.planId === p.planId),
  )
  const period =
    bucket.entitlement ?
      plan?.entitlementPeriods.get(bucket.entitlement)
    : undefined
  const p = (period ?? "").toLowerCase()
  if (p.includes("day") || p.includes("daily")) return 86_400_000
  if (p.includes("week")) return 7 * 86_400_000
  if (p.includes("month")) return 30 * 86_400_000
  if (
    bucket.periodStart !== undefined
    && bucket.periodEnd !== undefined
    && bucket.periodEnd > bucket.periodStart
  ) {
    return (bucket.periodEnd - bucket.periodStart) * 1000
  }
  return 0
}

/** Start Plan 余额 → 配额快照：每个余额桶一个窗口。 */
function buildStartSnapshot(balance: ZcodeStartBalance): QuotaSnapshot {
  const active = zcodeActiveStartPlan(balance)
  if (!active) {
    throw new Error(
      "this account has no GLM Coding Plan, and ZCode's Start Plan has ended or was never started",
    )
  }
  const windows: Array<ZcodeQuotaWindow> = []
  for (const bucket of balance.balances) {
    const total = bucket.total
    let used = bucket.used
    const left = bucket.remaining
    if (total === undefined && used === undefined && left === undefined)
      continue
    if (used === undefined && total !== undefined && left !== undefined) {
      used = total - left
    }
    const models = bucket.capabilities
      .map((c) =>
        c
          .trim()
          .replace(/^model:/, "")
          .trim(),
      )
      .filter(Boolean)
    const name = bucket.showName || models.join(", ") || "Credits"
    const w: ZcodeQuotaWindow = { name, usedPercent: 0, display: "" }
    if (total !== undefined && total > 0 && used !== undefined) {
      w.usedPercent = Math.min(100, Math.max(0, (100 * used) / total))
      const remaining = Math.max(0, total - used)
      w.display = `${remaining.toFixed(0)} / ${total.toFixed(0)}`
    }
    if (bucket.expiresAt !== undefined && bucket.expiresAt > 0) {
      w.resetsAt = bucket.expiresAt * 1000 // 余额接口给的是秒
    }
    const periodMs = bucketPeriodMs(bucket, balance)
    if (periodMs > 0) w.name = `${name} · ${periodLabel(periodMs)}`
    windows.push(w)
  }
  const base: QuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: "zcode",
    unlimited: windows.length === 0,
    details: {
      zcode: {
        host: "zcode.z.ai",
        plan: active.name,
        until: active.untilMs,
        windows,
      },
    },
  }
  if (windows.length === 0) return base
  const usedPercent = Math.max(...windows.map((w) => w.usedPercent))
  const primary = windows[0]!
  return {
    ...base,
    premiumInteractionsRemaining: Math.round(Math.max(0, 100 - usedPercent)),
    premiumInteractionsTotal: 100,
    chatRemaining: Math.max(0, Math.round(100 - primary.usedPercent)),
    chatTotal: 100,
  }
}

export async function fetchZcodeQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (getConnectionProvider(connection) !== "zcode") {
    throw new Error("fetchZcodeQuota requires a ZCode connection")
  }
  const credential = connection.credentials[0]
  const key = credential?.value ?? ""
  const jwt = getCredentialContextString(connection, "zcodeJwt") ?? ""

  // 只有 JWT（纯积分账号）或路由判定走 Start Plan：读 zcode.z.ai 的余额。
  if (
    credential
    && jwt
    && (!key
      || (await resolveZcodeRoute(connection, credential, { signal }))
        === "start")
  ) {
    const balance = await zcodeStartBalance(connection, jwt, signal)
    return buildStartSnapshot(balance)
  }

  if (!key) {
    throw new Error(
      "ZCode usage is unavailable: the saved sign-in carries no API key — sign in again",
    )
  }
  const site = (getCredentialContextString(connection, "site")
    ?? "zai") as ZcodeSite
  const host = zcodeSiteRoot(site)

  const response = await fetchWithConnectionProxy(
    connection,
    `${host}/api/monitor/usage/quota/limit`,
    {
      method: "GET",
      headers: {
        // key 裸放 Authorization（不是 Bearer）。
        authorization: key,
        accept: "application/json",
        "user-agent": `ZCode/${ZCODE_APP_VERSION}`,
      },
      signal,
    },
  )
  const body = await response.text()
  if (response.status !== 200) {
    throw new Error(`ZCode usage request failed (HTTP ${response.status})`)
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(body)
  } catch {
    throw new Error("ZCode usage response is not JSON")
  }
  // 包在 {code,msg,data}
  const envelope = asRecord(parsedJson)
  const data = envelope && "data" in envelope ? envelope.data : parsedJson
  const parsed = parseZcodeQuota(data)
  if (!parsed) {
    throw new Error("ZCode usage response carried no limits")
  }
  return buildSnapshot(parsed, host)
}
