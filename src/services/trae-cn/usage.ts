/**
 * Trae 计费的纯算法（美元额度 / 企业席位），ported from magpie packages/trae。
 * CN 个人积分的聚合留在 quota fetcher（受 provider-owned-quota-allowances 笔记
 * 与测试约束）；这里只加 Global 美元与企业席位两种读法。
 */

import { traeWhenOf } from "~/services/oauth/trae-cn"

export const traeRound = (n: number): number => Math.round(n * 100) / 100

/** CN console 的人民币。 */
export const traeYuan = (n: number): string =>
  "¥"
  + Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

/** Global console 的美元。 */
export const traeDollars = (n: number): string =>
  "$"
  + Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

interface TraeDollarUsage {
  plan: string
  basic: number | null
  bonus: number | null
  used: number | null
  usedBonus: number | null
  end: number
}

/** Global 美元额度：basic+bonus 限额与各自已用；无 pack 返回 null。 */
export function traeDollarUsageOf(v: unknown): TraeDollarUsage | null {
  const root = (v ?? {}) as Record<string, unknown>
  const packs =
    Array.isArray(root.user_entitlement_pack_list) ?
      (root.user_entitlement_pack_list as Array<Record<string, unknown>>)
    : []
  const pack = packs.find(
    (p) =>
      p?.usage
      || (p?.entitlement_base_info as Record<string, unknown> | undefined)
        ?.quota,
  )
  const base = pack?.entitlement_base_info as
    | Record<string, unknown>
    | undefined
  const quota = base?.quota as Record<string, unknown> | undefined
  if (!pack || !quota) return null
  const usage = (pack.usage ?? {}) as Record<string, unknown>
  const num = (x: unknown): number | null =>
    (
      (typeof x === "number" || typeof x === "string")
      && x !== ""
      && Number.isFinite(Number(x))
      && Number(x) >= 0
    ) ?
      Number(x)
    : null
  return {
    plan: String(pack.display_desc ?? ""),
    basic: num(quota.basic_usage_limit),
    bonus: num(quota.bonus_usage_limit),
    used: num(usage.basic_usage_amount),
    usedBonus: num(usage.bonus_usage_amount),
    end: traeWhenOf(base?.end_time),
  }
}

interface TraeSeatPool {
  limit: number
  unlimited: boolean
}

/** console 的「无上限」：paygo 池给 9999999999，不是该展示的限额。 */
const PAYGO_UNLIMITED = 1e9

/** 企业席位额度（seat_pool_currency_quota）；null/"" 是无池，不是 0。 */
export function traeSeatPoolOf(v: unknown): TraeSeatPool | null {
  const q = (v as Record<string, unknown> | undefined)?.user_model_quota as
    | Record<string, unknown>
    | undefined
  if (!q) return null
  const raw = q.seat_pool_currency_quota
  if (raw === null || raw === undefined || raw === "") return null
  const limit = Number(raw)
  if (!Number.isFinite(limit)) return null
  if (limit < 0 || limit >= PAYGO_UNLIMITED)
    return { limit: 0, unlimited: true }
  return { limit, unlimited: false }
}

/**
 * 企业席位已花：各模型 total_cost_currency 之和（console 不给总计）。
 * 只算账号自己的席位（user_model_quota.user_id）；多席位无从辨别时返回 null
 * （失败/不确定的读取不是「花了 0」）。
 */
export function traeSeatSpentOf(v: unknown, uid: unknown): number | null {
  const list = (v as Record<string, unknown> | undefined)?.user_usage_list
  if (!Array.isArray(list)) return null
  const me =
    uid === undefined || uid === null || uid === "" ? null : String(uid)
  const ids = new Set(
    list
      .map((u) =>
        (
          (u as Record<string, unknown>)?.user_id === undefined
          || (u as Record<string, unknown>)?.user_id === null
        ) ?
          ""
        : String((u as Record<string, unknown>).user_id),
      )
      .filter((s) => s !== ""),
  )
  let seats = list as Array<Record<string, unknown>>
  if (ids.size > 0) {
    const want = me ?? (ids.size === 1 ? [...ids][0]! : null)
    if (want === null) return null
    seats = seats.filter((u) => String(u?.user_id ?? "") === want)
    if (seats.length === 0) return null
  }
  let used = 0
  for (const u of seats) {
    const detail = (u?.in_seat_detail ?? {}) as Record<string, unknown>
    if (!Array.isArray(detail.chat_usage_details)) return null
    const chats = detail.chat_usage_details as Array<Record<string, unknown>>
    for (const m of chats) {
      if (
        m?.total_cost_currency === null
        || m?.total_cost_currency === undefined
        || m?.total_cost_currency === ""
      )
        return null
      const c = Number(m?.total_cost_currency)
      if (!Number.isFinite(c) || c < 0) return null
      used += c
    }
  }
  return used
}

/** 席位池重置时间（console 的 ResetTime），ISO 字符串；无则 null。 */
export function traeEntResetOf(v: unknown): string | null {
  const data = (v as Record<string, unknown> | undefined)?.Data as
    | Record<string, unknown>
    | undefined
  const t = traeWhenOf(data?.ResetTime)
  return t > 0 ? new Date(t).toISOString() : null
}
