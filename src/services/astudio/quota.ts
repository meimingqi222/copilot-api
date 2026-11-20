import { asNumber, asRecord, asTrimmedString } from "~/lib/json-shape"
import {
  getConnectionProxyUrl,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import type { ProviderQuotaSnapshot, QuotaWindow } from "~/lib/quota/types"
import { studioJson, studioSession } from "~/services/astudio/auth"
import { studioFallbackModels } from "~/services/astudio/catalog"

type ReadStudio = (path: string) => ReturnType<typeof studioJson>

function parseCst(value: unknown): number | undefined {
  const raw = asTrimmedString(value)
  if (!raw) return undefined
  const stamp = Date.parse(
    /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : (
      `${raw.replace(" ", "T")}+08:00`
    ),
  )
  return Number.isFinite(stamp) ? stamp : undefined
}

function cstStamp(ms: number): string {
  return new Date(ms + 8 * 3600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ")
}

async function sparkExpiry(read: ReadStudio, now: number, cap: number) {
  const seen = new Set<string>()
  let at: number | undefined
  let amount = 0
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({
      pageNum: String(page),
      pageSize: "50",
      direction: "CREDIT",
      startTime: cstStamp(now - 60 * 86400_000),
      endTime: cstStamp(now),
    })
    const data = await read(`points/details?${query}`)
    const rows =
      Array.isArray(data?.items) ? (data.items as Array<unknown>) : []
    for (const raw of rows) {
      const item = asRecord(raw)
      const credits = asNumber(item?.amount)
      const expiry = parseCst(item?.expireTime)
      if (
        item?.assetCode !== "SPARK_POINTS"
        || !credits
        || credits < 0
        || !expiry
        || expiry <= now
      )
        continue
      const key = JSON.stringify(raw)
      if (seen.has(key)) continue
      seen.add(key)
      if (!at || expiry < at) {
        at = expiry
        amount = credits
      } else if (at === expiry) amount += credits
    }
    if (rows.length < 50) break
  }
  return { at, amount: Math.min(cap, amount) }
}

function poolModels(
  models: Array<ModelMapping>,
  spark: boolean,
): Array<string> {
  return [
    ...new Set(
      models
        .filter(
          (m) =>
            m.enabled
            && m.metadata?.free !== true
            && /^spark-/i.test(m.upstreamId) === spark,
        )
        .map((m) => m.upstreamId),
    ),
  ]
}

export async function fetchStudioQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  const fetchedAt = Date.now()
  const snapshot: ProviderQuotaSnapshot = {
    provider: "astudio",
    fetchedAt,
    unlimited: false,
    allowance: { state: "unknown", windows: [] },
  }
  const session = studioSession(connection.credentials[0]?.context)
  if (!session) return snapshot
  const bounded = AbortSignal.timeout(15_000)
  const options = {
    proxyUrl: getConnectionProxyUrl(connection),
    signal: signal ? AbortSignal.any([signal, bounded]) : bounded,
  }
  const read: ReadStudio = (path) => studioJson(path, session, options)
  const [balance, membership] = await Promise.all([
    read("points/balance"),
    read("membership/me").catch(() => undefined),
  ])
  const details: Record<string, unknown> = {
    plan: asTrimmedString(membership?.planName),
    until: asTrimmedString(membership?.endTime),
  }
  const models = connection.models ?? studioFallbackModels()
  const windows: Array<QuotaWindow> = []
  const general = asNumber(balance?.totalBalance)
  if (general !== undefined && general >= 0) {
    const expiring = asNumber(balance?.activityBalance)
    const expiresAtMs =
      expiring && expiring > 0 ?
        parseCst(balance?.activityNextExpireTime)
      : undefined
    const scope = { models: poolModels(models, false) }
    windows.push({
      id: "general-credits",
      unit: "credits",
      remaining: general,
      expiresAtMs,
      scope,
    })
    if (expiresAtMs && expiring !== undefined)
      details.generalExpiring = Math.min(general, expiring)
  }
  const spark = asNumber(balance?.sparkTotalBalance)
  if (spark !== undefined && spark >= 0) {
    const expiry =
      spark > 0 ?
        await sparkExpiry(read, fetchedAt, spark).catch(() => undefined)
      : undefined
    const scope = { models: poolModels(models, true) }
    windows.push({
      id: "spark-credits",
      unit: "credits",
      remaining: spark,
      expiresAtMs: expiry?.at,
      scope,
    })
    if (expiry?.at) details.sparkExpiring = expiry.amount
  }
  signal?.throwIfAborted()
  return {
    ...snapshot,
    details,
    allowance: { state: windows.length ? "known" : "unknown", windows },
  }
}
