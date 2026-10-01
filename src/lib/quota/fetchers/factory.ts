/**
 * Factory 订阅配额拉取。
 *
 * 端点：`GET {factory}/api/billing/limits`（droid 的 `/status` 就是这么问的），
 * 用账号的 access token 直接 Bearer：
 *
 *   { limits: { standard: { fiveHour, weekly, monthly }, core: {...} },
 *     extraUsageBalanceCents, extraUsageAllowed }
 *
 * 每个窗口是 `{ usedPercent, windowEnd }`（windowEnd 可能是 ISO 时间或 epoch
 * 毫秒）。standard 计厂商模型，core（Droid Core，Factory 自托管的开源模型）
 * 有自己的窗口；extra usage 是美分余额。只填已用/总量，不编造 reset。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import {
  getConnectionProvider,
  getCredentialContextString,
} from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { FACTORY_CLI_VERSION, factoryApiBase } from "~/services/oauth/factory"

interface FactoryQuotaWindow {
  name: string
  usedPercent: number
  /** 窗口跨度（毫秒），用于展示。 */
  spanMs?: number
  resetsAt?: number
  display: string
}

interface ParsedFactoryQuota {
  windows: Array<FactoryQuotaWindow>
  extraBalanceCents?: number
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

/** windowEnd：ISO 时间串或 epoch 毫秒 → 毫秒；其余 undefined。 */
function readWindowEnd(value: unknown): number | undefined {
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
    return undefined
  }
  if (typeof value === "number" && value > 0) return value
  return undefined
}

const WINDOW_SPANS: Array<[string, string, number]> = [
  ["fiveHour", "5 hours", 5 * 60 * 60 * 1000],
  ["weekly", "7 days", 7 * 24 * 60 * 60 * 1000],
  ["monthly", "30 days", 30 * 24 * 60 * 60 * 1000],
]

function readPool(
  pool: Record<string, unknown> | undefined,
  prefix: string,
  out: Array<FactoryQuotaWindow>,
): void {
  if (!pool) return
  for (const [key, label, spanMs] of WINDOW_SPANS) {
    const win = asRecord(pool[key])
    if (!win) continue
    const used = num(win.usedPercent)
    if (used === undefined) continue
    const clamped = Math.min(Math.max(used, 0), 100)
    out.push({
      name: `${prefix}${label}`,
      usedPercent: clamped,
      spanMs,
      resetsAt: readWindowEnd(win.windowEnd),
      // 与 valueText/进度条的「剩余」口径一致：剩余%。
      display: `${(100 - clamped).toFixed(0)}%`,
    })
  }
}

/** 解析 /api/billing/limits 的响应体。 */
export function parseFactoryQuota(
  raw: unknown,
): ParsedFactoryQuota | undefined {
  const root = asRecord(raw)
  if (!root) return undefined
  const limits = asRecord(root.limits)
  const windows: Array<FactoryQuotaWindow> = []
  readPool(asRecord(limits?.standard), "", windows)
  readPool(asRecord(limits?.core), "Droid Core · ", windows)
  const extra = num(root.extraUsageBalanceCents)
  return {
    windows,
    extraBalanceCents:
      root.extraUsageAllowed === true && extra !== undefined && extra > 0 ?
        extra
      : undefined,
  }
}

function buildSnapshot(
  parsed: ParsedFactoryQuota,
  host: string,
): QuotaSnapshot {
  const base: QuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: "factory",
    unlimited: parsed.windows.length === 0,
    details: {
      factory: {
        host,
        windows: parsed.windows,
        extraBalanceCents: parsed.extraBalanceCents,
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

export async function fetchFactoryQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (getConnectionProvider(connection) !== "factory") {
    throw new Error("fetchFactoryQuota requires a Factory connection")
  }
  const token = connection.credentials[0]?.value
  if (!token) {
    throw new Error(
      "Factory usage is unavailable: the saved sign-in carries no access token — sign in again",
    )
  }
  const region = getCredentialContextString(connection, "region")
  const orgId = getCredentialContextString(connection, "organizationId")
  const base = factoryApiBase(region)

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "x-factory-client": "cli",
    "x-client-version": FACTORY_CLI_VERSION,
    "user-agent": `factory-cli/${FACTORY_CLI_VERSION}`,
  }
  if (orgId) headers["x-factory-org-id"] = orgId

  const response = await fetchWithConnectionProxy(
    connection,
    `${base}/api/billing/limits`,
    { method: "GET", headers, signal },
  )
  const body = await response.text()
  if (response.status !== 200) {
    throw new Error(`Factory usage request failed (HTTP ${response.status})`)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(body)
  } catch {
    throw new Error("Factory usage response is not JSON")
  }
  const parsed = parseFactoryQuota(parsedJson)
  if (!parsed) {
    throw new Error("Factory usage response carried no limits")
  }
  return buildSnapshot(parsed, base)
}
