/**
 * LobsterAI（有道龙虾）积分/配额拉取。
 *
 * LobsterAI 客户端把额度叫「积分」，有两个只读端点（与官方客户端同一套鉴权
 * 头 + keyfrom query）：
 *
 * 1. `GET {root}/api/user/profile-summary` —— 积分钱包总览：
 *      data.totalCreditsRemaining  剩余积分总额（客户端头部的那个数）
 *      data.nickname               账号昵称
 *      data.creditItems[]          逐项积分：{ type, label, labelEn,
 *                                  creditsRemaining, expiresAt }
 *                                  type ∈ subscription|boost|free|bonus|
 *                                  invitation|campaign
 *
 * 2. `GET {root}/api/user/quota` —— 套餐与免费额度窗口：
 *      data.planName               "免费" | "标准" | "进阶" | "专业"
 *      data.subscriptionStatus     "free" | "active" | "enterprise"
 *      data.freeCreditsTotal/Used/Remaining/ExpiresAt  免费额度窗口
 *      data.dailyCreditsUsed       当日已用
 *
 * 积分是一笔**余额**（没有总额上限），不是某个窗口的占比，所以不硬算百分比：
 * 余额由 `chatRemaining` 承载（归零即判耗尽，与客户端「0 分 = 无可用资源」一
 * 致），明细放在 details 里按余额展示。免费额度窗口有 total 时另算一个百分比
 * 行，供进度条显示。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import {
  lobsteraiClientVersion,
  lobsteraiServerRoot,
} from "~/services/lobsterai/config"
import { ensureLobsteraiAccessToken } from "~/services/lobsterai/token-refresh"

const PROFILE_SUMMARY_PATH = "/api/user/profile-summary"
const USER_QUOTA_PATH = "/api/user/quota"
const DEFAULT_KEYFROM = "official"

interface LobsteraiCreditItem {
  type?: string
  label?: string
  labelEn?: string
  creditsRemaining?: number
  expiresAt?: string | null
}

interface LobsteraiProfileSummary {
  nickname?: string
  totalCreditsRemaining?: number
  creditItems?: Array<LobsteraiCreditItem>
}

interface LobsteraiUserQuota {
  planName?: string
  subscriptionStatus?: string
  freeCreditsTotal?: number
  freeCreditsUsed?: number
  freeCreditsRemaining?: number
  freeCreditsExpiresAt?: string | null
  dailyCreditsUsed?: number
}

interface LobsteraiQuotaWindow {
  name: string
  usedPercent: number
  display: string
  resetsAt?: number
}

interface ParsedLobsteraiQuota {
  profile?: LobsteraiProfileSummary
  quota?: LobsteraiUserQuota
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** ISO / date 串或 epoch 毫秒 → 毫秒；其余 undefined。 */
function readWhen(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value.trim())
    if (!Number.isNaN(ms)) return ms
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

/** 解出响应体里 `data` 段（`{ code: 0, data: {...} }`）；code 非 0 或无 data 时 undefined。 */
function unwrapData(raw: unknown): Record<string, unknown> | undefined {
  const root = asRecord(raw)
  if (!root) return undefined
  const code = root.code
  if (code !== undefined && code !== 0 && code !== "0") return undefined
  return asRecord(root.data)
}

/** 把 creditItems 里最早到期的那个时间戳读出来（做钱包到期提示）。 */
function earliestCreditExpiry(
  items: Array<LobsteraiCreditItem> | undefined,
): number | undefined {
  if (!Array.isArray(items)) return undefined
  let soonest: number | undefined
  for (const item of items) {
    const at = readWhen(item?.expiresAt)
    if (at !== undefined && (soonest === undefined || at < soonest)) {
      soonest = at
    }
  }
  return soonest
}

/**
 * 从 profile-summary / user/quota 两个响应组装快照。
 * 两者都可能缺：任一可用即可出快照，全缺由调用方报错。
 */
export function buildLobsteraiSnapshot(
  parsed: ParsedLobsteraiQuota,
  host: string,
): QuotaSnapshot {
  const profile = parsed.profile
  const quota = parsed.quota

  const creditsRemainingRaw =
    finiteNumber(profile?.totalCreditsRemaining)
    ?? finiteNumber(quota?.freeCreditsRemaining)
  // 参考客户端 getCreditQuotaSnapshot 的 Math.max(0, ...)：余额为负时按 0 处理，
  // 避免把哨兵值/异常值当成「负数余额」显示或判耗尽。
  const creditsRemaining =
    creditsRemainingRaw === undefined ? undefined : (
      Math.max(0, creditsRemainingRaw)
    )
  const creditsExpiresAt = earliestCreditExpiry(profile?.creditItems)

  const windows: Array<LobsteraiQuotaWindow> = []
  const freeTotal = finiteNumber(quota?.freeCreditsTotal)
  if (freeTotal !== undefined && freeTotal > 0) {
    const used = finiteNumber(quota?.freeCreditsUsed) ?? 0
    const clampedUsed = Math.min(Math.max(used, 0), freeTotal)
    const remaining = Math.max(0, freeTotal - clampedUsed)
    windows.push({
      name: "Free",
      usedPercent: (100 * clampedUsed) / freeTotal,
      display: `${Math.round(remaining * 100) / 100} / ${Math.round(freeTotal * 100) / 100}`,
      resetsAt: readWhen(quota?.freeCreditsExpiresAt),
    })
  }

  const details = {
    host,
    plan: nonEmptyString(quota?.planName),
    subscriptionStatus: nonEmptyString(quota?.subscriptionStatus),
    user: nonEmptyString(profile?.nickname),
    credits:
      creditsRemaining === undefined ? undefined : (
        {
          remaining: creditsRemaining,
          ...(creditsExpiresAt === undefined ?
            {}
          : { expiresAt: creditsExpiresAt }),
        }
      ),
    windows,
  }

  const base: QuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: "lobsterai",
    // 积分余额会花光，不是「不限量」。
    unlimited: false,
    details: { lobsterai: details },
  }

  // 有余额时把它当作可花额度（整数计数）：归零即由 applyOAuthQuotaSnapshot
  // 的计数阈值判为耗尽。余额没有上限，故不设 premiumInteractions*。
  if (creditsRemaining !== undefined) {
    return { ...base, chatRemaining: Math.round(creditsRemaining) }
  }
  return base
}

async function getJson(
  connection: ProviderConnection,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown | undefined> {
  const response = await fetchWithConnectionProxy(connection, url, {
    method: "GET",
    headers,
    signal,
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `LobsterAI usage request rejected the credential (HTTP ${response.status})`,
    )
  }
  if (!response.ok) return undefined
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export async function fetchLobsteraiQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (getConnectionProvider(connection) !== "lobsterai") {
    throw new Error("fetchLobsteraiQuota requires a LobsterAI connection")
  }
  const credential = connection.credentials[0]
  if (!credential) {
    throw new Error(
      "LobsterAI usage is unavailable: no credential — sign in again",
    )
  }
  const token = await ensureLobsteraiAccessToken(connection, credential)
  if (!token) {
    throw new Error(
      "LobsterAI usage is unavailable: the saved sign-in carries no access token — sign in again",
    )
  }

  const ctx = (credential.context ?? {}) as Record<string, unknown>
  const firstKeyfrom = nonEmptyString(ctx.firstKeyfrom) ?? DEFAULT_KEYFROM
  const latestKeyfrom = nonEmptyString(ctx.latestKeyfrom) ?? DEFAULT_KEYFROM
  const query =
    `?firstKeyfrom=${encodeURIComponent(firstKeyfrom)}`
    + `&latestKeyfrom=${encodeURIComponent(latestKeyfrom)}`

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "x-lobsterai-client-version": lobsteraiClientVersion(connection),
  }

  const root = lobsteraiServerRoot(connection)
  const [profileResult, quotaResult] = await Promise.allSettled([
    getJson(
      connection,
      `${root}${PROFILE_SUMMARY_PATH}${query}`,
      headers,
      signal,
    ),
    getJson(connection, `${root}${USER_QUOTA_PATH}${query}`, headers, signal),
  ])

  // 401/403 是对凭证的判定，直接抛出（两个请求结论一致）。
  for (const result of [profileResult, quotaResult]) {
    if (result.status === "rejected") throw result.reason
  }

  const profileData =
    profileResult.status === "fulfilled" ?
      unwrapData(profileResult.value)
    : undefined
  const quotaData =
    quotaResult.status === "fulfilled" ?
      unwrapData(quotaResult.value)
    : undefined

  if (!profileData && !quotaData) {
    throw new Error(
      "LobsterAI usage response carried neither profile-summary nor quota data",
    )
  }

  return buildLobsteraiSnapshot(
    {
      profile: profileData as LobsteraiProfileSummary | undefined,
      quota: quotaData as LobsteraiUserQuota | undefined,
    },
    root,
  )
}
