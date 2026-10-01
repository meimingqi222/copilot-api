/**
 * Known per-vendor balance endpoints and readers.
 *
 * Everything here tries to stay silent about "no balance": a reader returns
 * undefined rather than a bogus zero when the body does not carry a number,
 * so a caller can leave the field empty instead of showing "$0.00".
 */

import type { BalanceResult, BalanceSource } from "~/lib/balance/types"

import {
  currencySign,
  money,
  numberFrom,
  readDottedPath,
} from "~/lib/balance/parse"

/** Hosts a connection may be pointed at, split by protocol. */
export interface BalanceHosts {
  chat?: string
  responses?: string
  anthropic?: string
}

/** new-api style relays price a dollar as 500000 quota units. */
const NEW_API_QUOTA_PER_USD = 500000

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/** Build a normalized result for a plain amount/currency pair. */
function result(amount: number, currency: string, raw: unknown): BalanceResult {
  return {
    amount,
    currency,
    display: money(currencySign(currency), amount),
    raw,
  }
}

/** Read the first numeric candidate that yields a finite number. */
function firstNumber(...values: Array<unknown>): number | undefined {
  for (const value of values) {
    const parsed = numberFrom(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** Read a string field, or undefined when absent/blank. */
function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function recordField(
  root: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(root?.[key])
}

// -- Host matching -----------------------------------------------------------

/** Reduce a base URL, host or host:port to a bare lowercase hostname. */
export function normalizeHost(value: string | undefined): string | undefined {
  if (!value) return undefined
  let raw = value.trim()
  if (!raw) return undefined
  const scheme = raw.indexOf("://")
  if (scheme >= 0) raw = raw.slice(scheme + 3)
  raw = raw.split(/[/?#]/, 1)[0] ?? raw
  const at = raw.lastIndexOf("@")
  if (at >= 0) raw = raw.slice(at + 1)
  const colon = raw.indexOf(":")
  if (colon >= 0) raw = raw.slice(0, colon)
  const host = raw.toLowerCase()
  return host || undefined
}

function hostnames(hosts: BalanceHosts): Array<string> {
  const out: Array<string> = []
  for (const value of [hosts.chat, hosts.responses, hosts.anthropic]) {
    const host = normalizeHost(value)
    if (host && !out.includes(host)) out.push(host)
  }
  return out
}

function isAihubmixHost(hosts: BalanceHosts): boolean {
  return hostnames(hosts).includes("aihubmix.com")
}

// -- Readers -----------------------------------------------------------------

/**
 * DeepSeek returns `balance_infos: [{ currency, total_balance, ... }]`.
 * The account is single-currency in practice; the first entry wins.
 */
function readDeepSeek(body: string): BalanceResult | undefined {
  const root = asRecord(parseJson(body))
  const infos = root?.balance_infos
  const first = Array.isArray(infos) ? asRecord(infos[0]) : undefined
  const amount = firstNumber(
    first?.total_balance,
    first?.topped_up_balance,
    first?.granted_balance,
  )
  if (amount === undefined) return undefined
  const currency = stringField(first?.currency) ?? "CNY"
  return result(amount, currency, root)
}

/** Moonshot reports `data.available_balance`; the host decides the currency. */
function moonshotReader(currency: string) {
  return (body: string): BalanceResult | undefined => {
    const root = asRecord(parseJson(body))
    const data = recordField(root, "data") ?? root
    const amount = firstNumber(
      data?.available_balance,
      data?.cash_balance,
      data?.voucher_balance,
    )
    if (amount === undefined) return undefined
    return result(amount, currency, root)
  }
}

/** OpenRouter credits are a grant minus recorded usage, both in USD. */
function readOpenRouterCredits(body: string): BalanceResult | undefined {
  const root = asRecord(parseJson(body))
  const data = recordField(root, "data") ?? root
  const total = numberFrom(data?.total_credits)
  if (total === undefined) return undefined
  const used = numberFrom(data?.total_usage) ?? 0
  return result(Math.max(0, total - used), "USD", root)
}

/** SiliconFlow reports `data.totalBalance` (charged + granted), else balance. */
function siliconflowReader(currency: string) {
  return (body: string): BalanceResult | undefined => {
    const root = asRecord(parseJson(body))
    const data = recordField(root, "data") ?? root
    const amount = firstNumber(
      data?.totalBalance,
      data?.total_balance,
      data?.balance,
      data?.chargeBalance,
      data?.charge_balance,
    )
    if (amount === undefined) return undefined
    return result(amount, currency, root)
  }
}

/** StepFun reports the account balance at the top level; currency carries. */
function stepfunReader(currency: string) {
  return (body: string): BalanceResult | undefined => {
    const root = asRecord(parseJson(body))
    const data = recordField(root, "data") ?? root
    const amount = firstNumber(
      data?.balance,
      data?.available_balance,
      data?.availableBalance,
      data?.remain,
    )
    if (amount === undefined) return undefined
    const declared = stringField(data?.currency) ?? stringField(root?.currency)
    return result(amount, declared ?? currency, root)
  }
}

/**
 * Command Code reports plan/credit buckets rather than a wallet. The spendable
 * side is the topped-up plus free credits; the plan allowance is usage, not
 * money, so it is left out.
 */
function readCommandCodeCredits(body: string): BalanceResult | undefined {
  const root = asRecord(parseJson(body))
  const credits = recordField(root, "credits") ?? root
  const free = numberFrom(credits?.freeCredits)
  const purchased = numberFrom(credits?.purchasedCredits)
  if (free === undefined && purchased === undefined) return undefined
  return result((free ?? 0) + (purchased ?? 0), "USD", root)
}

/** aihubmix's dashboard summary is small and shape-shifts; stay permissive. */
function readRemain(body: string): BalanceResult | undefined {
  const parsed = parseJson(body)
  const direct = numberFrom(parsed)
  if (direct !== undefined) return result(direct, "USD", parsed)
  const root = asRecord(parsed)
  const data = recordField(root, "data")
  const amount = firstNumber(
    root?.remain,
    root?.balance,
    root?.quota,
    data?.remain,
    data?.balance,
    data?.quota,
    data?.available_balance,
  )
  if (amount === undefined) return undefined
  return result(amount, "USD", root)
}

/** new-api `/api/user/self`: account quota, 500000 units to the dollar. */
function readNewApiUserSelf(body: string): BalanceResult | undefined {
  const root = asRecord(parseJson(body))
  const data = recordField(root, "data") ?? root
  const quota = numberFrom(data?.quota)
  if (quota === undefined) return undefined
  return result(quota / NEW_API_QUOTA_PER_USD, "USD", root)
}

/** new-api `/api/usage/token`: the key's own remaining quota in the same unit. */
function readNewApiTokenUsage(body: string): BalanceResult | undefined {
  const root = asRecord(parseJson(body))
  const data = recordField(root, "data") ?? root
  const available = firstNumber(
    data?.total_available,
    data?.totalAvailable,
    data?.remain_quota,
  )
  if (available === undefined) return undefined
  return result(available / NEW_API_QUOTA_PER_USD, "USD", root)
}

/** Wrap a dotted read so a user-configured path becomes a reader. */
function dottedReader(
  path: string,
  options: { perUsdQuota?: boolean; currency?: string } = {},
) {
  return (body: string): BalanceResult | undefined => {
    const parsed = parseJson(body)
    const value = numberFrom(readDottedPath(parsed, path))
    if (value === undefined) return undefined
    const amount = options.perUsdQuota ? value / NEW_API_QUOTA_PER_USD : value
    return result(amount, options.currency ?? "USD", parsed)
  }
}

// -- Sources -----------------------------------------------------------------

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"
const MOONSHOT_CN_BALANCE_URL = "https://api.moonshot.cn/v1/users/me/balance"
const MOONSHOT_AI_BALANCE_URL = "https://api.moonshot.ai/v1/users/me/balance"
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"
const SILICONFLOW_CN_BALANCE_URL = "https://api.siliconflow.cn/v1/user/info"
const SILICONFLOW_COM_BALANCE_URL = "https://api.siliconflow.com/v1/user/info"
const STEPFUN_COM_BALANCE_URL = "https://api.stepfun.com/v1/accounts"
const STEPFUN_AI_BALANCE_URL = "https://api.stepfun.ai/v1/accounts"
const COMMANDCODE_CREDITS_URL =
  "https://api.commandcode.ai/alpha/billing/credits"
const AIHUBMIX_ACCOUNT_URL = "https://aihubmix.com/api/user/self"
const AIHUBMIX_REMAIN_URL = "https://aihubmix.com/dashboard/billing/remain"

/** aihubmix reads its account with a dedicated token, else its public summary. */
function aihubmixBalanceSource(token?: string): BalanceSource {
  if (token?.trim()) {
    return { url: AIHUBMIX_ACCOUNT_URL, token, read: readNewApiUserSelf }
  }
  return { url: AIHUBMIX_REMAIN_URL, read: readRemain }
}

/**
 * Resolve a known vendor from the hosts a connection uses. Checks chat,
 * responses and anthropic in turn and returns the first match.
 */
export function knownBalanceSource(
  hosts: BalanceHosts,
  token?: string,
): BalanceSource | undefined {
  for (const host of hostnames(hosts)) {
    if (host === "api.deepseek.com") {
      return { url: DEEPSEEK_BALANCE_URL, read: readDeepSeek }
    }
    if (host === "api.moonshot.cn") {
      return { url: MOONSHOT_CN_BALANCE_URL, read: moonshotReader("CNY") }
    }
    if (host === "api.moonshot.ai") {
      return { url: MOONSHOT_AI_BALANCE_URL, read: moonshotReader("USD") }
    }
    if (host === "openrouter.ai") {
      return { url: OPENROUTER_CREDITS_URL, read: readOpenRouterCredits }
    }
    if (host === "api.siliconflow.cn") {
      return {
        url: SILICONFLOW_CN_BALANCE_URL,
        read: siliconflowReader("CNY"),
      }
    }
    if (host === "api.siliconflow.com") {
      return {
        url: SILICONFLOW_COM_BALANCE_URL,
        read: siliconflowReader("USD"),
      }
    }
    if (host === "api.stepfun.com") {
      return { url: STEPFUN_COM_BALANCE_URL, read: stepfunReader("CNY") }
    }
    if (host === "api.stepfun.ai") {
      return { url: STEPFUN_AI_BALANCE_URL, read: stepfunReader("USD") }
    }
    if (host === "api.commandcode.ai") {
      return { url: COMMANDCODE_CREDITS_URL, read: readCommandCodeCredits }
    }
    if (host === "aihubmix.com") {
      return aihubmixBalanceSource(token)
    }
  }
  return undefined
}

function urlPathname(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    return withoutScheme.split(/[?#]/, 1)[0] ?? withoutScheme
  }
}

/**
 * A user-named balance URL. A dotted `path` reads a raw amount; when the URL
 * is a new-api relay (`/api/user/self` or `/api/usage/token`) the value is
 * read in quota units and converted to USD.
 */
export function customBalanceSource(input: {
  url: string
  path?: string
  token?: string
}): BalanceSource {
  const { url, token } = input
  const path = input.path?.trim()
  const pathname = urlPathname(url)
  const isUserSelf = pathname.endsWith("/api/user/self")
  const isTokenUsage = pathname.endsWith("/api/usage/token")
  const read =
    path ? dottedReader(path, { perUsdQuota: isUserSelf || isTokenUsage })
    : isUserSelf ? readNewApiUserSelf
    : isTokenUsage ? readNewApiTokenUsage
    : dottedReader("data.quota")
  return { url, token, read }
}

/**
 * Whether the vendor's balance needs a token of its own: a custom relay URL
 * always does, and so does aihubmix's account endpoint.
 */
export function takesBalanceToken(
  input: BalanceHosts | { hosts?: BalanceHosts; balanceUrl?: string },
  balanceUrl?: string,
): boolean {
  const probe = input as BalanceHosts & {
    hosts?: BalanceHosts
    balanceUrl?: string
  }
  const url =
    balanceUrl?.trim()
    || (typeof probe.balanceUrl === "string" ? probe.balanceUrl.trim() : "")
  if (url) return true
  return isAihubmixHost(probe.hosts ?? probe)
}
