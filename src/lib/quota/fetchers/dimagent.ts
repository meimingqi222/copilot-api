/**
 * DimAgent 配额拉取。
 *
 * 端点：`GET https://dimagent.cn/api/me/usage`，`Authorization: Bearer`。
 * 响应形状由上游定义（桌面端「用量」页读的就是它）；这里只做宽松解析：
 * 若给出数字型的已用/总量或百分比就填窗口，否则只报计划、标为 unlimited，
 * 不编造 reset。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import {
  DIMAGENT_BASE,
  DIMAGENT_CHAT_UA,
  DIMAGENT_REFERER,
} from "~/services/oauth/dimagent"

interface DimagentQuotaWindow {
  name: string
  usedPercent: number
  display: string
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

/** 宽松解析：从常见字段里找 used/total/percent。 */
export function parseDimagentQuota(raw: unknown): {
  plan?: string
  windows: Array<DimagentQuotaWindow>
} {
  const root = asRecord(raw) ?? {}
  const data = asRecord(root.data) ?? root
  const plan =
    (typeof data.plan === "string" && data.plan)
    || (typeof data.plan_type === "string" && data.plan_type)
    || (typeof data.subscription === "string" && data.subscription)
    || undefined

  const used = num(data.used) ?? num(data.used_amount) ?? num(data.usedCredits)
  const total = num(data.total) ?? num(data.total_amount) ?? num(data.quota)
  const percent =
    num(data.used_percent) ?? num(data.percentage) ?? num(data.percent)

  const windows: Array<DimagentQuotaWindow> = []
  if (percent !== undefined) {
    windows.push({
      name: "usage",
      usedPercent: Math.min(Math.max(percent, 0), 100),
      display: `${(100 - percent).toFixed(0)}%`,
    })
  } else if (used !== undefined && total !== undefined && total > 0) {
    const p = (100 * used) / total
    windows.push({
      name: "usage",
      usedPercent: Math.min(Math.max(p, 0), 100),
      display: `${Math.max(0, total - used)} / ${total}`,
    })
  }
  return { plan, windows }
}

export async function fetchDimagentQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (getConnectionProvider(connection) !== "dimagent") {
    throw new Error("fetchDimagentQuota requires a DimAgent connection")
  }
  const token = connection.credentials[0]?.value
  if (!token) {
    throw new Error(
      "DimAgent usage is unavailable: the saved sign-in carries no access token — sign in again",
    )
  }
  const response = await fetchWithConnectionProxy(
    connection,
    `${DIMAGENT_BASE}/api/me/usage`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": DIMAGENT_CHAT_UA,
        "x-title": "DimCode",
        "http-referer": DIMAGENT_REFERER,
      },
      signal,
    },
  )
  if (!response.ok) {
    throw new Error(`DimAgent usage request failed (HTTP ${response.status})`)
  }
  const parsed = parseDimagentQuota(await response.json())
  const base: QuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: "dimagent",
    unlimited: parsed.windows.length === 0,
    details: {
      dimagent: {
        host: DIMAGENT_BASE,
        plan: parsed.plan,
        windows: parsed.windows,
      },
    },
  }
  if (parsed.windows.length === 0) return base
  const usedPercent = Math.max(...parsed.windows.map((w) => w.usedPercent))
  return {
    ...base,
    premiumInteractionsRemaining: Math.round(Math.max(0, 100 - usedPercent)),
    premiumInteractionsTotal: 100,
  }
}
