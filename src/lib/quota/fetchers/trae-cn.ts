/**
 * Trae CN 配额拉取。
 *
 * 端点：`POST {authHost}/trae/api/v2/pay/ide_user_ent_usage`
 * （api.trae.cn，IDE 全套指纹头 + Cloud-IDE-JWT）。响应里
 * user_entitlement_pack_list 逐项是积分包：
 *
 *   entitlement_base_info.quota.credits_limit   -1 = 不限量，否则额度
 *   usage.credits_amount                        已用
 *   entitlement_base_info.end_time / expire_time 到期（秒/毫秒/ISO）
 *
 * is_credits_billing 说账号是不是积分计费（否则显示 Free）。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import {
  requireTraeCnProvider,
  TRAE_CN_AUTH_HOST,
  traeCnAccount,
  traeCnErrorOf,
  traeCnLapsed,
  traeWhenOf,
} from "~/services/oauth/trae-cn"
import { traeCnIdeHeaders } from "~/services/trae-cn/client"

interface TraeCreditPack {
  entitlement_base_info?: {
    quota?: { credits_limit?: number | string }
    end_time?: number | string
    expire_time?: number | string
  }
  usage?: { credits_amount?: number | string }
  end_time?: number | string
}

function packLimit(pack: TraeCreditPack): number | undefined {
  const n = Number(pack.entitlement_base_info?.quota?.credits_limit)
  return Number.isFinite(n) ? n : undefined
}

function packUsed(pack: TraeCreditPack): number {
  const n = Number(pack.usage?.credits_amount)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function packEnd(pack: TraeCreditPack): number {
  return (
    traeWhenOf(pack.entitlement_base_info?.end_time)
    || traeWhenOf(pack.entitlement_base_info?.expire_time)
    || traeWhenOf(pack.end_time)
  )
}

export async function fetchTraeCnQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  requireTraeCnProvider(connection)
  const credential = connection.credentials[0]
  if (!credential) {
    throw new Error(
      "Trae CN usage is unavailable: no credential — sign in again",
    )
  }
  const token = await ensureOAuthConnectionAccessToken(connection, credential)
  const account = traeCnAccount(connection, token)
  if (!account.token) {
    throw new Error(
      "Trae CN usage is unavailable: the saved sign-in carries no token — sign in again",
    )
  }

  const response = await fetchWithConnectionProxy(
    connection,
    `${TRAE_CN_AUTH_HOST}/trae/api/v2/pay/ide_user_ent_usage`,
    {
      method: "POST",
      headers: traeCnIdeHeaders(account, { Accept: "application/json" }),
      body: JSON.stringify({ require_usage: true, req_source: 0 }),
      signal,
    },
  )
  const text = await response.text()
  if (!response.ok) {
    const e = traeCnErrorOf(text)
    if (response.status === 401 || traeCnLapsed(e.code, e.message)) {
      throw new HTTPError(
        `Trae CN's sign-in has expired (${e.message || response.status}); sign in again`,
        new Response(text, { status: 401 }),
        text,
      )
    }
    throw new Error(
      `Trae CN usage request failed (HTTP ${response.status})${e.message ? ` ${e.message}` : ""}`,
    )
  }
  let v: Record<string, unknown> = {}
  try {
    v = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error("Trae CN usage response is not JSON")
  }
  const e = traeCnErrorOf(v)
  if (e.code && String(e.code) !== "0" && String(e.code) !== "200") {
    if (traeCnLapsed(e.code, e.message)) {
      throw new HTTPError(
        `Trae CN's sign-in has expired (${e.message}); sign in again`,
        new Response(text, { status: 401 }),
        text,
      )
    }
    throw new Error(`Trae CN usage: ${e.message || `code ${e.code}`}`)
  }

  let limit = 0
  let used = 0
  let unlimited = false
  let soonest = 0
  const packs =
    Array.isArray(v.user_entitlement_pack_list) ?
      (v.user_entitlement_pack_list as Array<TraeCreditPack>)
    : []
  for (const pack of packs) {
    const l = packLimit(pack)
    if (l === undefined) continue
    if (l === -1) unlimited = true
    else if (l >= 0) limit += l
    used += packUsed(pack)
    const end = packEnd(pack)
    if (end > 0 && (!soonest || end < soonest)) soonest = end
  }

  const plan = v.is_credits_billing ? "Credits" : "Free"
  const windows: Array<Record<string, unknown>> = []
  let remainingPercent: number | undefined
  if (!unlimited && limit > 0) {
    const remaining = Math.max(0, limit - used)
    remainingPercent = Math.max(0, Math.min(100, (100 * remaining) / limit))
    windows.push({
      name: "Credits",
      usedPercent: Math.max(0, Math.min(100, (100 * used) / limit)),
      display: `${Math.round(remaining * 100) / 100} / ${Math.round(limit * 100) / 100}`,
      // 这里其实是「最早到期的积分包过期时间」——UI/路由按窗口终止
      // 时间读，语义上就是额度作废日，用 resetsAt 让显示一致。
      ...(soonest > 0 ? { resetsAt: soonest } : {}),
    })
  }

  const base: QuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: "trae-cn",
    unlimited: unlimited || windows.length === 0,
    details: {
      "trae-cn": {
        host: TRAE_CN_AUTH_HOST,
        plan,
        user: account.name || account.uid,
        balance: unlimited ? "unlimited" : undefined,
        windows,
      },
    },
  }
  if (unlimited || remainingPercent === undefined) return base
  return {
    ...base,
    premiumInteractionsRemaining: Math.round(remainingPercent),
    premiumInteractionsTotal: 100,
    chatRemaining: Math.round(remainingPercent),
    chatTotal: 100,
  }
}
