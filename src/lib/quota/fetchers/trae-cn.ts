import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
/**
 * Trae 配额拉取（CN 积分 / Global 美元 / 企业席位）。
 *
 * 个人账号按站点计费页：
 *   CN     `POST {auth}/trae/api/v2/pay/ide_user_ent_usage`（积分包）
 *   Global `POST {pay}/trae/api/v1/pay/user_current_entitlement_list`（美元额度）
 * 企业（SaaS）账号在 console 上按席位计费（get_personal_quota /
 * get_user_model_usage / get_personal_core_data 三页），CN 另把消费积分页
 * 作为旁列（aside）展示——席位池才是请求真正花的额度。
 *
 * 积分包逐项：entitlement_base_info.quota.credits_limit（-1 不限量）、
 * usage.credits_amount（已用）、end_time/expire_time（到期）。
 * is_credits_billing 说账号是不是积分计费（否则显示 Free）。
 */

import type { QuotaWindow } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import {
  requireTraeCnProvider,
  traeCnAccount,
  traeCnErrorOf,
  traeCnLapsed,
  traeWhenOf,
  type TraeAccount,
} from "~/services/oauth/trae-cn"
import { traeCnIdeHeaders } from "~/services/trae-cn/client"
import {
  isTraeEnterprise,
  traeUsageHost,
  type TraeSite,
} from "~/services/trae-cn/sites"
import {
  traeDollarUsageOf,
  traeDollars,
  traeEntResetOf,
  traeRound,
  traeSeatPoolOf,
  traeSeatSpentOf,
  traeYuan,
} from "~/services/trae-cn/usage"

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
  const raw = pack.entitlement_base_info?.quota?.credits_limit
  if ((typeof raw !== "number" && typeof raw !== "string") || raw === "")
    return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function packUsed(pack: TraeCreditPack): number | undefined {
  const raw = pack.usage?.credits_amount
  if ((typeof raw !== "number" && typeof raw !== "string") || raw === "")
    return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, n) : undefined
}

function packEnd(pack: TraeCreditPack): number {
  return (
    traeWhenOf(pack.entitlement_base_info?.end_time)
    || traeWhenOf(pack.entitlement_base_info?.expire_time)
    || traeWhenOf(pack.end_time)
  )
}

async function postJson(
  connection: ProviderConnection,
  account: TraeAccount,
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; text: string; v: Record<string, unknown> }> {
  const response = await fetchWithConnectionProxy(connection, url, {
    method: "POST",
    headers: traeCnIdeHeaders(account, { Accept: "application/json" }),
    body: JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let v: Record<string, unknown> = {}
  try {
    v = JSON.parse(text) as Record<string, unknown>
  } catch {
    v = {}
  }
  return { status: response.status, text, v }
}

function lapsedError(site: TraeSite, message: string, text: string): HTTPError {
  return new HTTPError(
    `${site.realm}'s sign-in has expired (${message}); sign in again`,
    new Response(text, { status: 401 }),
    text,
  )
}

export async function fetchTraeCnQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  requireTraeCnProvider(connection)
  const credential = connection.credentials[0]
  if (!credential) {
    throw new Error("Trae usage is unavailable: no credential — sign in again")
  }
  const token = await ensureOAuthConnectionAccessToken(connection, credential)
  const account = traeCnAccount(connection, token)
  const site = account.site
  if (!account.token) {
    throw new Error(
      "Trae usage is unavailable: the saved sign-in carries no token — sign in again",
    )
  }
  if (isTraeEnterprise(account, site) && account.consoleChat !== false) {
    return fetchEnterpriseQuota(connection, account, signal)
  }
  if (site.usage.kind === "dollar") {
    return fetchDollarQuota(connection, account, signal)
  }
  return fetchCreditsQuota(connection, account, signal)
}

// ── CN 个人积分（受 provider-owned-quota-allowances 笔记与测试约束） ──

async function fetchCreditsQuota(
  connection: ProviderConnection,
  account: TraeAccount,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  const site = account.site
  const host = traeUsageHost(site, account)
  const { status, text, v } = await postJson(
    connection,
    account,
    `${host}${site.usage.path}`,
    site.usage.body,
    signal,
  )
  if (status !== 200) {
    const e = traeCnErrorOf(text)
    if (status === 401 || traeCnLapsed(e.code, e.message, site)) {
      throw lapsedError(site, e.message || String(status), text)
    }
    throw new Error(
      `Trae usage request failed (HTTP ${status})${e.message ? ` ${e.message}` : ""}`,
    )
  }
  const e = traeCnErrorOf(v)
  if (e.code && String(e.code) !== "0" && String(e.code) !== "200") {
    if (traeCnLapsed(e.code, e.message, site)) {
      throw lapsedError(site, e.message, text)
    }
    throw new Error(`Trae usage: ${e.message || `code ${e.code}`}`)
  }

  let limit = 0
  let used = 0
  let unlimited = false
  let measured = true
  const packWindows: Array<QuotaWindow> = []
  let soonest = 0
  const packs =
    Array.isArray(v.user_entitlement_pack_list) ?
      (v.user_entitlement_pack_list as Array<TraeCreditPack>)
    : []
  for (const pack of packs) {
    const l = packLimit(pack)
    if (l === undefined) {
      measured = false
      continue
    }
    if (l === -1) unlimited = true
    else if (l >= 0) {
      limit += l
      const u = packUsed(pack)
      if (u === undefined) measured = false
      else used += u
    }
    const end = packEnd(pack)
    packWindows.push({
      id: `pack:${end}:${l}`,
      total: l >= 0 ? l : undefined,
      unit: "credits",
      expiresAtMs: end > 0 ? end : undefined,
      unlimited: l === -1,
      aside: true,
    })
    if (end > 0 && (!soonest || end < soonest)) soonest = end
  }

  const plan = v.is_credits_billing ? "Credits" : "Free"
  const windows: Array<Record<string, unknown>> = []
  let remainingPercent: number | undefined
  // Zero-limit packs (e.g. Free accounts) are not a measured, spent balance.
  const counted = !unlimited && measured && limit > 0
  if (counted) {
    const remaining = Math.max(0, limit - used)
    remainingPercent = Math.max(0, Math.min(100, (100 * remaining) / limit))
    windows.push({
      name: "Credits",
      usedPercent: Math.max(0, Math.min(100, (100 * used) / limit)),
      display: `${Math.round(remaining * 100) / 100} / ${Math.round(limit * 100) / 100}`,
      ...(soonest > 0 ? { expiresAt: soonest } : {}),
    })
  }

  const base: ProviderQuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: site.id,
    unlimited,
    allowance: {
      state:
        unlimited ? "unlimited"
        : counted ? "known"
        : "unknown",
      windows: [
        ...(counted ?
          [
            {
              id: "credits",
              remaining: Math.max(0, limit - used),
              total: limit,
              used: Math.min(1, used / limit),
              unit: "credits" as const,
              // A single pack has one real expiry. Multiple complementary packs
              // retain their individual expiry hints below, not a fabricated reset.
              expiresAtMs:
                packWindows.length === 1 ?
                  packWindows[0]?.expiresAtMs
                : undefined,
            },
          ]
        : []),
        ...packWindows,
      ],
    },
    details: {
      [site.id]: {
        host,
        plan,
        user: account.name || account.uid,
        balance: unlimited ? "unlimited" : undefined,
        // Reporting may retain known totals even when routing usage is unknown.
        credits:
          !unlimited && packWindows.some((pack) => pack.total !== undefined) ?
            { total: limit }
          : undefined,
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

// ── Global 个人美元额度 ──

async function fetchDollarQuota(
  connection: ProviderConnection,
  account: TraeAccount,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  const site = account.site
  const host = traeUsageHost(site, account)
  const { status, text, v } = await postJson(
    connection,
    account,
    `${host}${site.usage.path}`,
    site.usage.body,
    signal,
  )
  const e = traeCnErrorOf(text)
  if (status === 401 || traeCnLapsed(e.code, e.message, site)) {
    throw lapsedError(site, e.message || String(status), text)
  }
  if (status !== 200 || (e.code && String(e.code) !== "0")) {
    throw new Error(
      `Trae ${site.usage.label}: ${e.message || `HTTP ${status}`}`,
    )
  }
  const d = traeDollarUsageOf(v)
  const total =
    d && d.basic !== null && d.bonus !== null ? d.basic + d.bonus : 0
  const measured = !!d && d.used !== null && d.usedBonus !== null
  const used = measured ? d.used! + d.usedBonus! : 0
  const counted = !!d && total > 0 && measured
  const remaining = Math.max(0, total - used)
  const remainingPercent =
    counted ? Math.max(0, Math.min(100, (100 * remaining) / total)) : undefined
  const base: ProviderQuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: site.id,
    unlimited: false,
    allowance: {
      state: counted ? "known" : "unknown",
      windows:
        counted ?
          [
            {
              id: "usage",
              remaining,
              total,
              used: Math.min(1, used / total),
              unit: "currency",
              ...(d?.end ? { expiresAtMs: d.end } : {}),
            },
          ]
        : [],
    },
    details: {
      [site.id]: {
        host,
        plan: d?.plan || "Free",
        user: account.name || account.uid,
        windows:
          total > 0 ?
            [
              {
                name: "Dollar Usage",
                ...(counted ?
                  {
                    usedPercent: Math.max(
                      0,
                      Math.min(100, (100 * used) / total),
                    ),
                  }
                : {}),
                display: `${measured ? traeDollars(used) : "?"} / ${traeDollars(total)}`,
                ...(d?.end ? { expiresAt: d.end } : {}),
              },
            ]
          : [],
      },
    },
  }
  if (remainingPercent === undefined) return base
  return {
    ...base,
    premiumInteractionsRemaining: Math.round(remainingPercent),
    premiumInteractionsTotal: 100,
    chatRemaining: Math.round(remainingPercent),
    chatTotal: 100,
  }
}

// ── 企业（SaaS）席位额度（console 三页；CN 另列消费积分） ──

async function fetchEnterpriseQuota(
  connection: ProviderConnection,
  account: TraeAccount,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  const site = account.site
  const ent = site.usage.ent!
  const money = site.usage.kind === "credits" ? traeYuan : traeDollars
  const unit = site.usage.kind === "credits" ? "CNY" : "usd"
  const ask = async (path: string) => {
    const r = await postJson(
      connection,
      account,
      `${site.hosts.console}${path}`,
      {},
      signal,
    )
    const e = traeCnErrorOf(r.v)
    if (r.status === 401 || traeCnLapsed(e.code, e.message, site)) {
      // 只有实测接受 IDE token 的 console（CN）才把 401 当登出；Global 未实测，
      // 其拒收只当读取失败，绝不标登出（否则会把整个域的企业账号误标过期）。
      return site.consoleTakesIdeToken ?
          { gone: true as const }
        : { error: e.message || `HTTP ${r.status}` }
    }
    if (r.status !== 200 || (e.code && String(e.code) !== "0")) {
      return { error: e.message || `HTTP ${r.status}` }
    }
    return { v: r.v }
  }

  const quota = await ask(ent.quota)
  if ("gone" in quota) {
    throw lapsedError(site, "console refused the sign-in", "")
  }
  if ("error" in quota) {
    throw new Error(`${site.realm} usage: ${quota.error}`)
  }
  const pool = traeSeatPoolOf(quota.v)
  if (!pool) {
    throw new Error(`${site.realm} usage: the console named no seat pool`)
  }
  // 花费页/周期页失败只丢对应信息，不丢额度（失败不是「花了 0」）。
  let spent: unknown = {}
  try {
    const got = await ask(ent.spent)
    if (!("gone" in got) && !("error" in got)) spent = got.v
  } catch {
    /* spend unknown */
  }
  let core: unknown = {}
  try {
    const got = await ask(ent.core)
    if (!("gone" in got) && !("error" in got)) core = got.v
  } catch {
    /* reset unknown */
  }
  const quotaUid = (
    (quota.v as Record<string, unknown>).user_model_quota as
      | Record<string, unknown>
      | undefined
  )?.user_id
  const used = traeSeatSpentOf(spent, quotaUid ?? account.uid)
  const reset = traeEntResetOf(core)
  const resetMs = reset ? Date.parse(reset) : undefined

  const seatWindow: QuotaWindow = {
    id: "seat",
    total: pool.unlimited ? undefined : pool.limit,
    unit: "currency",
    unlimited: pool.unlimited,
    ...((used !== null || pool.limit === 0) && !pool.unlimited ?
      {
        remaining: Math.max(0, pool.limit - (used ?? 0)),
        used: pool.limit > 0 ? Math.min(1, used! / pool.limit) : 1,
      }
    : {}),
    ...(resetMs ? { resetsAtMs: resetMs } : {}),
  }
  const windows: Array<Record<string, unknown>> = []
  if (!pool.unlimited && pool.limit > 0) {
    windows.push({
      name: "Seat Usage",
      usedPercent:
        used === null ? undefined : (
          Math.max(0, Math.min(100, (100 * used) / pool.limit))
        ),
      display:
        used === null ?
          `? / ${money(pool.limit)}`
        : `${money(used)} / ${money(pool.limit)}`,
      ...(reset ? { resetsAt: reset } : {}),
    })
  }

  // CN：消费积分页作为旁列（aside），不是路由额度。
  const asideWindows: Array<QuotaWindow> = []
  if (site.usage.kind === "credits") {
    try {
      const r = await postJson(
        connection,
        account,
        `${traeUsageHost(site, account)}${site.usage.path}`,
        site.usage.body,
        signal,
      )
      const e = traeCnErrorOf(r.v)
      if (r.status === 200 && (!e.code || String(e.code) === "0")) {
        const packs =
          Array.isArray(r.v.user_entitlement_pack_list) ?
            (r.v.user_entitlement_pack_list as Array<TraeCreditPack>)
          : []
        let limit = 0
        let used2 = 0
        let unlimited2 = false
        let measured2 = true
        for (const p of packs) {
          const l = packLimit(p)
          if (l === undefined) continue
          if (l === -1) unlimited2 = true
          else if (l >= 0) {
            limit += l
            const spend = packUsed(p)
            if (spend === undefined) measured2 = false
            else used2 += spend
          }
        }
        if (!unlimited2 && limit > 0) {
          asideWindows.push({
            id: "credits",
            total: limit,
            ...(measured2 ?
              {
                remaining: Math.max(0, limit - used2),
                used: Math.min(1, used2 / limit),
              }
            : {}),
            unit: "credits",
            aside: true,
          })
          windows.push({
            name: "Credits",
            ...(measured2 ?
              { usedPercent: Math.max(0, Math.min(100, (100 * used2) / limit)) }
            : {}),
            display: `${measured2 ? traeRound(used2) : "?"} / ${traeRound(limit)}`,
            aside: true,
          })
        }
      }
    } catch {
      /* credits page is reporting-only */
    }
  }

  const measurable = !pool.unlimited && (pool.limit === 0 || used !== null)
  const remainingPercent =
    measurable && pool.limit > 0 ?
      Math.max(0, Math.min(100, (100 * (pool.limit - used!)) / pool.limit))
    : pool.limit === 0 && !pool.unlimited ? 0
    : undefined
  const base: ProviderQuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: site.id,
    unlimited: pool.unlimited,
    allowance: {
      state:
        pool.unlimited ? "unlimited"
        : measurable ? "known"
        : "unknown",
      windows: [seatWindow, ...asideWindows],
    },
    details: {
      [site.id]: {
        host: site.hosts.console,
        plan: "Enterprise",
        user: account.name || account.uid,
        balance: pool.unlimited ? "unlimited" : undefined,
        unit,
        windows,
      },
    },
  }
  if (pool.unlimited || remainingPercent === undefined) return base
  return {
    ...base,
    premiumInteractionsRemaining: Math.round(remainingPercent),
    premiumInteractionsTotal: 100,
    chatRemaining: Math.round(remainingPercent),
    chatTotal: 100,
  }
}
