/**
 * LobsterAI（有道龙虾）积分/配额拉取。
 *
 * 与 auto-checkin 同一口径：客户端头部那个数来自
 * `GET {root}/api/user/profile-summary` 的 `data.totalCreditsRemaining`，
 * 不是 `/api/user/quota` 的免费额度窗口。后者是另一套计数，拿来当余额或
 * 进度条会把「还有几百积分」显示成 0/300。
 *
 * profile-summary 还带：
 *   data.nickname
 *   data.creditItems[]  { type, label, creditsRemaining, expiresAt }
 *                       expiresAt 是 epoch 毫秒（偶发 ISO 串）
 *
 * `/api/user/quota` 只用来读套餐名（planName / subscriptionStatus），
 * 不参与余额。积分是一笔没有总额上限的余额，由 `chatRemaining` 原样承载，
 * 归零才判耗尽。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { asRecord } from "~/lib/json-shape"
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
  expiresAt?: string | number | null
}

interface LobsteraiProfileSummary {
  nickname?: string
  totalCreditsRemaining?: number
  creditItems?: Array<LobsteraiCreditItem>
}

interface LobsteraiUserQuota {
  planName?: string
  subscriptionStatus?: string
}

interface ParsedLobsteraiQuota {
  profile?: LobsteraiProfileSummary
  quota?: LobsteraiUserQuota
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

/**
 * creditItems.expiresAt → epoch 毫秒。
 * 官方客户端与 auto-checkin 都按毫秒存；秒级时间戳（~1e9）乘 1000。
 */
function readMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim()
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n
    }
    const ms = Date.parse(trimmed)
    if (!Number.isNaN(ms)) return ms
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
    const at = readMillis(item?.expiresAt)
    if (at !== undefined && (soonest === undefined || at < soonest)) {
      soonest = at
    }
  }
  return soonest
}

/**
 * 从 profile-summary（余额）和可选的 user/quota（套餐名）组装快照。
 * 余额只认 totalCreditsRemaining，缺它就不报数，避免拿免费窗口冒充钱包。
 */
export function buildLobsteraiSnapshot(
  parsed: ParsedLobsteraiQuota,
  host: string,
): QuotaSnapshot {
  const profile = parsed.profile
  const quota = parsed.quota

  const creditsRemainingRaw = finiteNumber(profile?.totalCreditsRemaining)
  // 参考客户端 getCreditQuotaSnapshot 的 Math.max(0, ...)：余额为负时按 0 处理。
  // 保留两位小数（与 auto-checkin `round(rem, 2)` 一致），不要四舍五入成整数。
  const creditsRemaining =
    creditsRemainingRaw === undefined ? undefined : (
      Math.max(0, Math.round(creditsRemainingRaw * 100) / 100)
    )
  const creditsExpiresAt = earliestCreditExpiry(profile?.creditItems)

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
  }

  const base: QuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: "lobsterai",
    unlimited: false,
    details: { lobsterai: details },
  }

  // 有余额时原样承载；归零才判耗尽。不要设 premiumInteractions*，
  // 那会让卡片把积分编成百分比。
  if (creditsRemaining !== undefined) {
    return { ...base, chatRemaining: creditsRemaining }
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

  if (finiteNumber(profileData?.totalCreditsRemaining) === undefined) {
    throw new Error("LobsterAI usage response carried no totalCreditsRemaining")
  }

  return buildLobsteraiSnapshot(
    {
      profile: profileData as LobsteraiProfileSummary | undefined,
      quota: quotaData as LobsteraiUserQuota | undefined,
    },
    root,
  )
}
