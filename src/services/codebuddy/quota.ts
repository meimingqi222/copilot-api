/**
 * CodeBuddy 配额查询（积分余额）。
 *
 * 对齐 workbuddy2api 的 `get-user-resource` 口径：
 *   - 国内版（codebuddy-cn）：`POST https://www.codebuddy.cn/v2/billing/meter/get-user-resource`
 *   - 国际版（codebuddy）：`POST https://www.workbuddy.ai/v2/billing/meter/get-user-resource`，
 *     404 时回退 `/billing/meter/get-user-resource`（workbuddy 域同款路径候选）。
 *   - 单套餐聚合逐字移植 `packageRemainUsed`：Cycle 期套餐优先，
 *     remain 钳 [0, size]，used 取 CycleUsed 与 size-remain 的较大者。
 */

import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"

import { HTTPError } from "~/lib/error"
import {
  getConnectionProvider,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
} from "~/lib/provider-connections"
import { persistProviderConnections } from "~/lib/provider-connections/state"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { getHeader } from "~/services/protocols/shared"

import {
  ensureCodebuddyAccessToken,
  resolveCodebuddyDomain,
} from "./token-refresh"

const CODEBUDDY_CN_BILLING_BASE = "https://www.codebuddy.cn"
const CODEBUDDY_INTL_BILLING_BASE = "https://www.workbuddy.ai"
const CODEBUDDY_RESOURCE_PATH = "/v2/billing/meter/get-user-resource"
const CODEBUDDY_RESOURCE_FALLBACK_PATH = "/billing/meter/get-user-resource"
const CODEBUDDY_USER_AGENT = "CLI/2.148.0 CodeBuddy/2.148.0"

/**
 * 按连接解析 billing base：metadata.provider 优先（codebuddy 双版本共用协议，
 * protocol 反查恒得 codebuddy-cn），无 metadata 的旧连接按 chat baseUrl 嗅探。
 */
function resolveCodebuddyBillingBase(connection: ProviderConnection): {
  base: string
  intl: boolean
} {
  const provider = getConnectionProvider(connection)
  if (provider === "codebuddy") {
    return { base: CODEBUDDY_INTL_BILLING_BASE, intl: true }
  }
  if (provider === "codebuddy-cn") {
    return { base: CODEBUDDY_CN_BILLING_BASE, intl: false }
  }
  const intlBase = connection.baseUrl ?? ""
  if (intlBase.includes("workbuddy.ai") || intlBase.includes("codebuddy.ai")) {
    return { base: CODEBUDDY_INTL_BILLING_BASE, intl: true }
  }
  return { base: CODEBUDDY_CN_BILLING_BASE, intl: false }
}

function decodeJwtSub(token: string): string | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    const json = Buffer.from(
      parts[1].replaceAll("-", "+").replaceAll("_", "/"),
      "base64",
    ).toString("utf8")
    const payload = JSON.parse(json) as { sub?: unknown }
    return typeof payload.sub === "string" ? payload.sub : undefined
  } catch {
    return undefined
  }
}

/** 上游时间格式 "2006-01-02 15:04:05"（UTC+8 墙钟，与官网展示时区一致）。 */
function formatUpstreamWallClock(date: Date): string {
  return new Date(date.getTime() + 8 * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ")
}

function toInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ?
      Math.trunc(value)
    : 0
}

interface CodebuddyResourceAccount {
  CapacitySize: number
  CapacityRemain: number
  CapacityUsed: number
  CycleCapacitySize: number
  CycleCapacityRemain: number
  CycleCapacityUsed: number
}

/**
 * 单套餐 remain/used/size 聚合（移植 workbuddy2api `packageRemainUsed`）。
 */
export function summarizeCodebuddyPackage(account: CodebuddyResourceAccount): {
  remain: number
  used: number
  size: number
} {
  if (account.CycleCapacitySize > 0) {
    let remain = account.CycleCapacityRemain
    const size = account.CycleCapacitySize
    if (remain < 0) remain = 0
    if (remain > size) remain = size
    let used = size - remain
    if (account.CycleCapacityUsed > used) {
      used = account.CycleCapacityUsed
      if (size >= used) {
        remain = size - used
      }
    }
    return { remain, used, size }
  }
  const remain = account.CapacityRemain
  const size = account.CapacitySize
  let used = account.CapacityUsed
  if (used === 0 && size > remain) {
    used = size - remain
  }
  return { remain, used, size }
}

export interface CodebuddyResourceSummary {
  remain: number
  used: number
  size: number
  packs: number
  totalDosage: number
}

function readAccount(raw: unknown): CodebuddyResourceAccount {
  const obj = (raw ?? {}) as Record<string, unknown>
  return {
    CapacitySize: toInt(obj.CapacitySize),
    CapacityRemain: toInt(obj.CapacityRemain),
    CapacityUsed: toInt(obj.CapacityUsed),
    CycleCapacitySize: toInt(obj.CycleCapacitySize),
    CycleCapacityRemain: toInt(obj.CycleCapacityRemain),
    CycleCapacityUsed: toInt(obj.CycleCapacityUsed),
  }
}

/**
 * 解析 get-user-resource 响应 body（已解 `{code,msg,data}` 信封的 data 段，
 * 即 `{Response:{Data:{TotalDosage,Accounts}}}`）。
 */
export function parseCodebuddyResourceData(
  data: unknown,
): CodebuddyResourceSummary {
  const root = (data ?? {}) as Record<string, unknown>
  const response = (root.Response ?? {}) as Record<string, unknown>
  const inner = (response.Data ?? {}) as Record<string, unknown>
  const accounts = Array.isArray(inner.Accounts) ? inner.Accounts : []
  const totalDosage = toInt(inner.TotalDosage)

  let remain = 0
  let used = 0
  let size = 0
  for (const raw of accounts) {
    const part = summarizeCodebuddyPackage(readAccount(raw))
    remain += part.remain
    used += part.used
    size += part.size
  }
  // TotalDosage 作 size 下限（已消耗的不该比总剂量小）。
  let finalSize = size
  let finalUsed = used
  if (totalDosage > finalSize) {
    finalSize = totalDosage
    const derived = finalSize - remain
    if (derived > finalUsed) {
      finalUsed = derived
    }
  }
  return {
    remain,
    used: finalUsed,
    size: finalSize,
    packs: accounts.length,
    totalDosage,
  }
}

interface CodebuddyEnvelope {
  code?: number
  msg?: string
  data?: unknown
}

export async function fetchCodebuddyQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  const provider = getConnectionProvider(connection)
  if (provider !== "codebuddy" && provider !== "codebuddy-cn") {
    // 无 metadata 的旧连接：chat baseUrl 指向 codebuddy 系同样放行。
    const base = connection.baseUrl ?? ""
    if (
      !base.includes("workbuddy.ai")
      && !base.includes("codebuddy.ai")
      && !base.includes("tencent.com")
    ) {
      throw new Error("fetchCodebuddyQuota requires a CodeBuddy connection")
    }
  }

  const credential = connection.credentials[0]
  if (!credential) {
    throw new Error("CodeBuddy quota request requires an access token")
  }
  const accessToken = await ensureCodebuddyAccessToken(
    connection,
    credential,
    signal,
  )
  if (!accessToken) {
    throw new Error("CodeBuddy quota request requires an access token")
  }

  const domain = resolveCodebuddyDomain(connection)
  const userId =
    getHeader(connection.headers, "x-user-id") ?? decodeJwtSub(accessToken)
  const enterpriseId = getHeader(connection.headers, "x-enterprise-id")
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Domain": domain,
    "X-Product": "SaaS",
    "x-codebuddy-request": "1",
    "Accept-Language":
      (
        domain.toLowerCase().endsWith("codebuddy.cn")
        || domain.includes("tencent.com")
      ) ?
        "zh-CN"
      : "en-US",
    "User-Agent": CODEBUDDY_USER_AGENT,
  }
  if (userId) headers["X-User-Id"] = userId
  if (enterpriseId) {
    headers["X-Enterprise-Id"] = enterpriseId
    headers["X-Tenant-Id"] = enterpriseId
  }

  const now = new Date()
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatUpstreamWallClock(now),
    PackageEndTimeRangeEnd: formatUpstreamWallClock(
      new Date(now.getTime() + 365 * 101 * 24 * 3_600_000),
    ),
  })

  const { base, intl } = resolveCodebuddyBillingBase(connection)
  const paths =
    intl ?
      [CODEBUDDY_RESOURCE_PATH, CODEBUDDY_RESOURCE_FALLBACK_PATH]
    : [CODEBUDDY_RESOURCE_PATH]

  let summary: CodebuddyResourceSummary | undefined
  for (const [index, path] of paths.entries()) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body,
      signal,
    })
    // 国际版路径候选：404 则换下一候选（workbuddy 域同款回退语义）。
    if (response.status === 404 && index < paths.length - 1) {
      continue
    }
    if (!response.ok) {
      throw new HTTPError(
        "Failed to fetch CodeBuddy quota",
        response,
        await response.text().catch(() => "(unreadable)"),
      )
    }
    let envelope: CodebuddyEnvelope
    try {
      envelope = (await response.json()) as CodebuddyEnvelope
    } catch {
      throw new Error("CodeBuddy quota response was not valid JSON")
    }
    if (envelope.code !== 0 || envelope.data === undefined) {
      throw new Error(
        `CodeBuddy quota request failed: code=${envelope.code ?? "?"} msg=${envelope.msg ?? ""}`,
      )
    }
    summary = parseCodebuddyResourceData(envelope.data)
    break
  }
  if (!summary) {
    throw new Error("CodeBuddy quota request returned no usable endpoint")
  }

  return {
    fetchedAt: Date.now(),
    provider: provider ?? "codebuddy-cn",
    unlimited: false,
    chatRemaining: summary.remain,
    chatTotal: summary.size,
    details: {
      remain: summary.remain,
      used: summary.used,
      size: summary.size,
      packs: summary.packs,
      totalDosage: summary.totalDosage,
    },
  }
}

export async function refreshCodebuddyQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  const snapshot = await fetchCodebuddyQuota(connection, signal)
  setConnectionQuotaInfo(connection, snapshot)
  // 余额耗尽（有套餐但剩余为 0）→ exhausted；空套餐不断言（trial/免费模型或可照常用）。
  const details = snapshot.details as { remain?: unknown; packs?: unknown }
  const remain = typeof details.remain === "number" ? details.remain : 0
  const packs = typeof details.packs === "number" ? details.packs : 0
  const exhausted = remain <= 0 && packs > 0
  setConnectionQuotaState(connection, exhausted ? "exhausted" : "available")
  if (!exhausted) {
    clearAccountRateLimitState(connection.id)
  }
  await persistProviderConnections()
  return snapshot
}
