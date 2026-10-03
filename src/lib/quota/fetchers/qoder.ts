/**
 * Qoder 订阅配额拉取。
 *
 * 端点：`GET https://openapi.qoder.sh/sash/api/v2/me/usage`，用 **设备 token**
 * 直接 Bearer（不是 chat 用的 job token）：
 *
 *   { displayMode: "qoder" | "enterprise", qoderUsage: { ... } }
 *
 * `qoderUsage` 里的窗口：`userQuota` / `addOnQuota` / `orgResourcePackage`
 * 以及 `dedicatedResourcePackages[]`，每个是
 * `{ total|cap, used|remaining, name, unit(默认 credits) }`。
 * 这里也只填已用/总量，不编造 reset 窗口。
 *
 * 设备 token 过期只影响账号页（用量），不影响 chat：401 时惰性续期一次，
 * 续期失败如实报错，**不**把连接标成 auth_error。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import {
  getConnectionProvider,
  getConnectionProxyUrl,
  getCredentialContextString,
} from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import {
  applyQoderDeviceTokenRefresh,
  refreshQoderDeviceToken,
} from "~/services/oauth/qoder"
import {
  QODER_ACCOUNT_USAGE_PATH,
  qoderSiteForConnection,
  QODER_USER_AGENT,
  type QoderSite,
} from "~/services/qoder/endpoints"

interface QoderQuotaWindow {
  name: string
  used: number
  total: number
  unit: string
  usedPercent: number
  display: string
}

interface ParsedQoderQuota {
  displayMode: string
  plan?: string
  windows: Array<QoderQuotaWindow>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

/** JSON number（也容忍数字字符串）；其余返回 undefined。 */
function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 双拼写字段查找（`userQuota` / `user_quota`）。 */
function field(
  usage: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  const value = usage[camel]
  return value === undefined || value === null ? usage[snake] : value
}

function pushWindow(
  out: Array<QoderQuotaWindow>,
  raw: unknown,
  fallbackName: string,
): void {
  const block = asRecord(raw)
  if (!block) return
  const total = num(block.total) ?? num(block.cap)
  const usedRaw = num(block.used)
  const remaining = num(block.remaining)
  if (total === undefined || total <= 0) return
  if (usedRaw === undefined && remaining === undefined) return
  const used = usedRaw ?? total - (remaining ?? 0)
  if (used < 0) return
  const unit =
    typeof block.unit === "string" && block.unit ? block.unit : "credits"
  const name =
    typeof block.name === "string" && block.name ? block.name : fallbackName
  out.push({
    name,
    used,
    total,
    unit,
    usedPercent: Math.min(100, (100 * used) / total),
    // 与 valueText/进度条的「剩余」口径一致：剩余 / 总量 单位。
    display: `${Math.max(0, total - used)} / ${total} ${unit}`,
  })
}

/**
 * 解析 usage 文档。`displayMode` 不是 qoder / enterprise 时返回 undefined。
 * enterprise 模式没有窗口。
 */
export function parseQoderQuota(raw: unknown): ParsedQoderQuota | undefined {
  const envelope = asRecord(raw)
  if (!envelope) return undefined
  const displayMode =
    typeof envelope.displayMode === "string" ? envelope.displayMode : ""
  if (displayMode !== "qoder" && displayMode !== "enterprise") return undefined
  if (displayMode === "enterprise") {
    return { displayMode, windows: [] }
  }

  const usage = asRecord(envelope.qoderUsage)
  if (!usage) return { displayMode, windows: [] }

  const windows: Array<QoderQuotaWindow> = []
  const plan = field(usage, "userType", "user_type")
  const planText = typeof plan === "string" && plan ? plan : undefined

  pushWindow(windows, field(usage, "userQuota", "user_quota"), "Credits")
  pushWindow(
    windows,
    field(usage, "addOnQuota", "add_on_quota"),
    "Add-on credits",
  )
  pushWindow(
    windows,
    field(usage, "orgResourcePackage", "org_resource_package"),
    "Shared credits",
  )
  const dedicated = field(
    usage,
    "dedicatedResourcePackages",
    "dedicated_resource_packages",
  )
  if (Array.isArray(dedicated)) {
    for (const pack of dedicated) {
      pushWindow(windows, pack, "Dedicated credits")
    }
  }

  return { displayMode, plan: planText, windows }
}

function buildSnapshot(parsed: ParsedQoderQuota, host: string): QuotaSnapshot {
  const base: QuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: "qoder",
    unlimited: parsed.windows.length === 0,
    details: {
      qoder: {
        displayMode: parsed.displayMode,
        plan: parsed.plan,
        host,
        windows: parsed.windows,
      },
    },
  }
  if (parsed.windows.length === 0) return base

  // 头号百分比取最紧的那个窗口：任一窗口见底就该停止路由。
  const usedPercent = Math.max(...parsed.windows.map((w) => w.usedPercent))
  const primary = parsed.windows[0]!
  return {
    ...base,
    premiumInteractionsRemaining: Math.round(Math.max(0, 100 - usedPercent)),
    premiumInteractionsTotal: 100,
    chatRemaining: Math.max(0, Math.round(primary.total - primary.used)),
    chatTotal: Math.round(primary.total),
  }
}

async function requestUsage(
  connection: ProviderConnection,
  site: QoderSite,
  deviceToken: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchWithConnectionProxy(
    connection,
    `${site.openapiHost}${QODER_ACCOUNT_USAGE_PATH}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${deviceToken}`,
        "Cosy-ClientType": "10",
        "User-Agent": QODER_USER_AGENT,
      },
      signal,
    },
  )
}

export async function fetchQoderQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  const provider = getConnectionProvider(connection)
  if (provider !== "qoder" && provider !== "qoder-cn") {
    throw new Error("fetchQoderQuota requires a Qoder connection")
  }
  // 站点优先按 connection.baseUrl 判：qoder / qoder-cn 共用 qoder-native
  // 协议，裸 connection 的 protocol → provider 反查会推错站。
  const site = qoderSiteForConnection(connection)
  const deviceToken = getCredentialContextString(connection, "deviceToken")
  if (!deviceToken) {
    throw new Error(
      "Qoder usage is unavailable: the saved sign-in carries no device token — sign in again to see usage",
    )
  }

  let response = await requestUsage(connection, site, deviceToken, signal)
  if (response.status === 401 || response.status === 403) {
    await response.text()
    const deviceRefresh = getCredentialContextString(
      connection,
      "deviceRefreshToken",
    )
    if (deviceRefresh) {
      try {
        const refreshed = await refreshQoderDeviceToken(
          deviceRefresh,
          {
            proxyUrl: getConnectionProxyUrl(connection),
            signal,
          },
          site,
        )
        applyQoderDeviceTokenRefresh(connection, refreshed)
        response = await requestUsage(connection, site, refreshed.token, signal)
      } catch (error: unknown) {
        throw new Error(
          "Qoder usage is unavailable: Qoder refused the account-page sign-in "
            + "(chat still works) — sign in again to see usage "
            + `(${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }
  }

  const body = await response.text()
  if (response.status !== 200) {
    throw new Error(`Qoder usage request failed (HTTP ${response.status})`)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(body)
  } catch {
    throw new Error("Qoder usage response is not JSON")
  }
  const parsed = parseQoderQuota(parsedJson)
  if (!parsed) {
    throw new Error("Qoder usage response carried an unknown display mode")
  }
  return buildSnapshot(parsed, site.openapiHost)
}
