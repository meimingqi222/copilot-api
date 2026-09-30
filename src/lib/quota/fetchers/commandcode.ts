/**
 * Command Code Plan 配额拉取。
 *
 * 端点：`GET https://api.commandcode.ai/alpha/billing/credits`，key 同时进
 * `Authorization: Bearer` 与 `x-api-key`。响应（CLI 的 /usage 就是这么读的）：
 *
 *   { credits: { planId, monthlyCredits, purchasedCredits, freeCredits },
 *     windowLimits: { limited, fiveHour: {used, cap, resetAt},
 *                     weekly: {used, cap, resetAt} } }
 *
 * resetAt 是毫秒。used / cap 只做除法还原百分比。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { COMMANDCODE_API } from "~/services/oauth/commandcode"

export interface CommandCodeQuotaWindow {
  name: string
  usedPercent: number
  resetsAt?: number
  display: string
}

export interface ParsedCommandCodeQuota {
  planId?: string
  windows: Array<CommandCodeQuotaWindow>
  monthlyCredits?: number
  purchasedCredits?: number
  freeCredits?: number
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

function readWindow(
  raw: unknown,
  name: string,
  out: Array<CommandCodeQuotaWindow>,
): void {
  const w = asRecord(raw)
  if (!w) return
  const used = num(w.used) ?? 0
  const cap = num(w.cap) ?? 0
  const percent = cap > 0 ? (100 * used) / cap : 0
  const reset = num(w.resetAt)
  out.push({
    name,
    usedPercent: Math.min(Math.max(percent, 0), 100),
    resetsAt: reset !== undefined && reset > 0 ? reset : undefined,
    // 与 valueText/进度条的「剩余」口径一致：剩余 / 总量。
    display:
      cap > 0 ?
        `${Math.max(0, cap - used).toFixed(1)} / ${cap.toFixed(1)}`
      : `${used.toFixed(1)}`,
  })
}

/** 解析 /alpha/billing/credits。 */
export function parseCommandCodeQuota(
  raw: unknown,
): ParsedCommandCodeQuota | undefined {
  const root = asRecord(raw)
  if (!root) return undefined
  const credits = asRecord(root.credits)
  const windows: Array<CommandCodeQuotaWindow> = []
  const limits = asRecord(root.windowLimits)
  readWindow(limits?.fiveHour, "5 hours", windows)
  readWindow(limits?.weekly, "7 days", windows)
  return {
    planId: typeof credits?.planId === "string" ? credits.planId : undefined,
    windows,
    monthlyCredits: num(credits?.monthlyCredits),
    purchasedCredits: num(credits?.purchasedCredits),
    freeCredits: num(credits?.freeCredits),
  }
}

function buildSnapshot(parsed: ParsedCommandCodeQuota): QuotaSnapshot {
  const base: QuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: "commandcode-plan",
    unlimited: parsed.windows.length === 0,
    details: {
      commandcode: {
        planId: parsed.planId,
        windows: parsed.windows,
        monthlyCredits: parsed.monthlyCredits,
        purchasedCredits: parsed.purchasedCredits,
        freeCredits: parsed.freeCredits,
      },
    },
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

export async function fetchCommandCodeQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (getConnectionProvider(connection) !== "commandcode-plan") {
    throw new Error("fetchCommandCodeQuota requires a Command Code connection")
  }
  const key = connection.credentials[0]?.value
  if (!key) {
    throw new Error(
      "Command Code usage is unavailable: the saved sign-in carries no API key — sign in again",
    )
  }
  const response = await fetchWithConnectionProxy(
    connection,
    `${COMMANDCODE_API}/alpha/billing/credits`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${key}`,
        "x-api-key": key,
        accept: "application/json",
      },
      signal,
    },
  )
  const body = await response.text()
  if (response.status !== 200) {
    throw new Error(
      `Command Code usage request failed (HTTP ${response.status})`,
    )
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(body)
  } catch {
    throw new Error("Command Code usage response is not JSON")
  }
  const parsed = parseCommandCodeQuota(parsedJson)
  if (!parsed) {
    throw new Error("Command Code usage response carried no credits")
  }
  return buildSnapshot(parsed)
}
