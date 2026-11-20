import { HTTPError } from "~/lib/error"
import { asNumber, asRecord, asTrimmedString } from "~/lib/json-shape"
import {
  getConnectionOAuthAccessToken,
  getConnectionProxyUrl,
  type ProviderConnection,
} from "~/lib/provider-connections"
import type { ProviderQuotaSnapshot, QuotaWindow } from "~/lib/quota/types"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"
import { RACCOON_ORIGIN } from "~/services/raccoon/auth"

async function readRaccoon(
  path: string,
  token: string,
  options: OAuthFetchOptions,
) {
  const response = await oauthFetch(
    `${RACCOON_ORIGIN}/api/web/${path}`,
    {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "error",
    },
    options,
  )
  const payload = asRecord(await response.json().catch(() => undefined))
  const code = asNumber(payload?.code)
  if (!response.ok || (code !== undefined && code !== 0)) {
    const status =
      code === 200001 || code === 200003 ? 401
      : response.ok ? 502
      : response.status
    throw new HTTPError(
      `Raccoon usage read failed (${status})`,
      new Response(null, { status }),
    )
  }
  return asRecord(payload?.data) ?? payload
}

interface GrantSummary {
  granted: number
  expiresAtMs?: number
  expiring: number
}

function summarizeGrants(items: unknown, now: number) {
  const daily: GrantSummary = { granted: 0, expiring: 0 }
  const credits: GrantSummary = { granted: 0, expiring: 0 }
  const expired: Array<{ points: number; expiry: number }> = []
  for (const item of Array.isArray(items) ? (items as Array<unknown>) : []) {
    const row = asRecord(item)
    const points = asNumber(row?.points)
    if (points === undefined || points <= 0) continue
    const expiry = Date.parse(asTrimmedString(row?.expire_at) ?? "")
    if (expiry <= now) {
      expired.push({ points, expiry })
      continue
    }
    for (const summary of row?.biz_type === "daily_grant" ?
      [credits, daily]
    : [credits]) {
      summary.granted += points
      if (
        expiry > now
        && (!summary.expiresAtMs || expiry < summary.expiresAtMs)
      ) {
        summary.expiresAtMs = expiry
        summary.expiring = points
      } else if (expiry === summary.expiresAtMs) {
        summary.expiring += points
      }
    }
  }
  return { daily, credits, expired }
}

function maskPhone(value: unknown): string | undefined {
  const digits = (asTrimmedString(value) ?? "")
    .replace(/\D/g, "")
    .replace(/^(?:0086|86)(?=\d{11}$)/, "")
  return digits.length === 11 ?
      `${digits.slice(0, 3)}****${digits.slice(-4)}`
    : undefined
}

export async function fetchRaccoonQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot | undefined> {
  const token = getConnectionOAuthAccessToken(connection)
  if (!token) return undefined
  const fetchedAt = Date.now()
  const options = {
    proxyUrl: getConnectionProxyUrl(connection),
    signal: signal ?? AbortSignal.timeout(15_000),
  }
  // The vendor's setting_info endpoint may award daily credits even on GET.
  // Do not use it as a fallback: quota polling must never claim anything.
  const read = (path: string) => readRaccoon(path, token, options)
  const balance = await read("points/v1/balance")
  const [bills, entitlements, user] = await Promise.all([
    read("points/v1/bills?type=income&paging.limit=200&paging.offset=0").catch(
      () => undefined,
    ),
    read("auth/v1/entitlement_info").catch(() => undefined),
    read("auth/v1/user_info").catch(() => undefined),
  ])
  signal?.throwIfAborted()
  const remaining = asNumber(balance?.available_points)
  const dailyRemaining = asNumber(balance?.daily_points)
  const { credits, daily, expired } = summarizeGrants(bills?.items, fetchedAt)
  const windows: Array<QuotaWindow> = []
  const hasDaily =
    dailyRemaining !== undefined && dailyRemaining > 0 && remaining !== 0
  if (hasDaily) {
    windows.push({
      id: "daily-pool",
      remaining: dailyRemaining,
      total: Math.max(2100, daily.granted, dailyRemaining),
      unit: "credits",
      expiresAtMs: daily.expiresAtMs,
    })
  }
  if (remaining !== undefined && remaining >= 0) {
    let total = credits.granted
    // Expiration and the vendor's sweep are not atomic; use the most recent
    // expired grants only when the authoritative balance still needs them.
    for (const grant of expired.sort((a, b) => b.expiry - a.expiry)) {
      if (total >= remaining) break
      total += grant.points
    }
    windows.push({
      id: "credits",
      remaining,
      total: total > 0 && total >= remaining ? total : undefined,
      unit: "credits",
      aside: hasDaily,
      expiresAtMs: credits.expiresAtMs,
    })
  }
  const office =
    asRecord(entitlements?.office) ?? asRecord(entitlements?.["code"])
  const activePlan = asRecord(office?.active_plan)
  const type = asTrimmedString(activePlan?.type ?? office?.plan_type)
  const plan =
    office?.pro_enable === true ?
      type && type !== "none" ?
        type
      : "Pro"
    : office?.pro_enable === false ? "Free"
    : undefined
  return {
    provider: "raccoon",
    fetchedAt,
    unlimited: false,
    allowance: { state: windows.length ? "known" : "unknown", windows },
    details: {
      plan,
      user: maskPhone(user?.phone),
      until: asTrimmedString(
        office?.pro_expired_time ?? activePlan?.subscription_expired_at,
      ),
      dailyExpiring:
        hasDaily ? Math.min(dailyRemaining, daily.expiring) : undefined,
      creditsExpiring:
        remaining !== undefined && remaining >= 0 ?
          Math.min(remaining, credits.expiring)
        : undefined,
    },
  }
}
