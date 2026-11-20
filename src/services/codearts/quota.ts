import { asNumber, asRecordOrEmpty, asTrimmedString } from "~/lib/json-shape"
import type { ProviderConnection } from "~/lib/provider-connections"
import type { ProviderQuotaSnapshot, QuotaWindow } from "~/lib/quota/types"
import {
  codeArtsKeys,
  readCodeArts,
  type CodeArtsKeys,
} from "~/services/codearts/client"
import { codeArtsStations } from "~/services/codearts/stations"

const DAY = 86_400_000
const BEIJING = 8 * 3_600_000
const TOTAL = "usageTotalPackageCredit"
const BUCKETS = {
  basic: "usageBasicPackageCredit",
  ondemand: "usageOnDemandPackageCredit",
  bonus: "usageBonusPackageCredit",
} as const

function vendorDate(raw: unknown): number | undefined {
  const epoch = asNumber(raw)
  if (epoch !== undefined)
    return (
      epoch > 0 ?
        epoch < 1e11 ?
          epoch * 1000
        : epoch
      : undefined
    )
  const text = asTrimmedString(raw)
  if (!text) return undefined
  const local = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(
    text,
  )
  const parsed = Date.parse(
    local ? `${local[1]}T${local[2] ?? "00:00:00"}+08:00` : text,
  )
  return Number.isFinite(parsed) ? parsed : undefined
}

function successfulData(raw: Record<string, unknown> | undefined) {
  if (raw?.code !== undefined && asNumber(raw.code) !== 0) return {}
  return asRecordOrEmpty(raw?.data ?? raw)
}

const rows = (value: unknown) =>
  Array.isArray(value) ? value.map(asRecordOrEmpty) : []
const nonnegative = (value: unknown) => {
  const number = asNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

interface CreditBatch {
  bucket: string
  remaining?: number
  expiresAtMs: number
}

async function readBatches(
  connection: ProviderConnection,
  keys: CodeArtsKeys,
  signal?: AbortSignal,
): Promise<Array<CreditBatch>> {
  const { snap, locale } = codeArtsStations[keys.station]
  const headers = { "Agent-Type": "PromptCenter", "X-Language": locale }
  const [packages, bonus, overview] = await Promise.all(
    [
      {
        pageNum: 1,
        pageSize: 100,
        sortField: "created_time",
        sortOrder: "desc",
        packageTypes: ["basic", "ondemand"],
      },
      { pageNum: 1, pageSize: 100, packageTypes: ["bonus"] },
    ]
      .map((query) =>
        readCodeArts(connection, keys, {
          url: new URL("/snap-manager/v1/package/credit/page", snap),
          // This POST is a paginated list, not a credit claim or mutation.
          method: "POST",
          body: JSON.stringify(query),
          signal,
          headers,
        }),
      )
      .concat(
        readCodeArts(connection, keys, {
          url: new URL("/v1/ops/credit/overview", snap),
          signal,
          headers,
        }),
      ),
  )

  const packageRows = [packages, bonus].flatMap((result) =>
    rows(successfulData(result).list),
  )
  const batches = packageRows.flatMap((row) => {
    const kind = row.packageType
    const expiresAtMs = vendorDate(row.expiredTime)
    if (
      (kind !== "basic" && kind !== "bonus" && kind !== "ondemand")
      || expiresAtMs === undefined
    )
      return []
    const amount = nonnegative(row.creditAmount)
    const used = nonnegative(row.creditUsed)
    return [
      {
        bucket: BUCKETS[kind],
        expiresAtMs,
        remaining:
          amount !== undefined && used !== undefined ?
            Math.max(0, amount - used)
          : undefined,
      },
    ]
  })
  const campaigns = rows(successfulData(overview).items).slice(0, 30)
  const reads = await Promise.all(
    campaigns.map(async (campaign) => {
      const id =
        asTrimmedString(campaign.campaignId) ?? asNumber(campaign.campaignId)
      const left =
        (asNumber(campaign.totalClaimed) ?? 0)
        - (asNumber(campaign.totalConsumed) ?? 0)
        - (asNumber(campaign.totalExpired) ?? 0)
      if (id === undefined || left <= 0 || !/^[\w-]+$/.test(String(id)))
        return []
      const url = new URL(
        `/v1/ops/credit/campaign/${id}?pageNum=1&pageSize=100`,
        snap,
      )
      const result = await readCodeArts(connection, keys, {
        url,
        signal,
        headers,
      })
      return rows(successfulData(result).benefits).flatMap((row) => {
        const expiresAtMs = vendorDate(row.expireAt)
        const amount = nonnegative(row.claimedAmount)
        const used = nonnegative(row.consumedAmount)
        const expired = nonnegative(row.expiredAmount)
        return expiresAtMs === undefined ?
            []
          : [
              {
                bucket: BUCKETS.bonus,
                expiresAtMs,
                remaining:
                  (
                    amount !== undefined
                    && used !== undefined
                    && expired !== undefined
                  ) ?
                    Math.max(0, amount - used - expired)
                  : undefined,
              },
            ]
      })
    }),
  )
  return [...batches, ...reads.flat()]
}

function creditWindows(
  metrics: Array<Record<string, unknown>>,
  reset: number | undefined,
) {
  const windows: Array<QuotaWindow> = []
  for (const id of [TOTAL, ...Object.values(BUCKETS)]) {
    const row = metrics.find((metric) => metric.name === id)
    const total = nonnegative(row?.package_credit_amount)
    const remaining = nonnegative(row?.package_credit_remain)
    if (remaining === undefined || (total === 0 && remaining === 0)) continue
    windows.push({
      id,
      remaining,
      total,
      unit: "credits",
      aside: id !== TOTAL,
      resetsAtMs: id === TOTAL || id === BUCKETS.basic ? reset : undefined,
    })
  }
  return windows
}

function tokenWindows(
  metrics: Array<Record<string, unknown>>,
  data: Record<string, unknown>,
  aside: boolean,
) {
  const expiresAtMs = vendorDate(data.end_date)
  const start = vendorDate(data.start_date)
  return metrics.flatMap((row): Array<QuotaWindow> => {
    const id = asTrimmedString(row.name)
    const total = nonnegative(row.package_token_amount)
    const used = nonnegative(row.usage_token_num)
    if (!id || !total || used === undefined) return []
    return [
      {
        id,
        unit: "tokens",
        total,
        remaining: Math.max(0, total - used),
        expiresAtMs,
        aside,
        spanMs:
          start && expiresAtMs && expiresAtMs > start ?
            expiresAtMs - start
          : undefined,
      },
    ]
  })
}

export async function fetchCodeArtsQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  const keys = codeArtsKeys(connection.credentials[0])
  const station = codeArtsStations[keys.station]
  const [raw, balance] = await Promise.all([
    readCodeArts(connection, keys, {
      url: new URL("/snap-manager/v1/statistics/plugin", station.snap),
      signal,
      headers: {
        "Content-Type": "application/json",
        "Agent-Type": "PromptCenter",
        "X-Language": station.locale,
      },
    }),
    station.gateway ?
      readCodeArts(connection, keys, {
        url: new URL("/api/v1/user/tokens/balance", station.gateway),
        signal,
      })
    : undefined,
  ])
  const data = successfulData(raw)
  const pkg = asRecordOrEmpty(data.package)
  const metrics = rows(data.metrics)
  const now = Date.now()
  const batches =
    keys.station === "mainland" && metrics.some((m) => m.name === TOTAL) ?
      await readBatches(connection, keys, signal)
    : []
  const basicEnds = batches
    .filter((b) => b.bucket === BUCKETS.basic && b.expiresAtMs > now)
    .map((b) => b.expiresAtMs)
  const reset =
    basicEnds.length ? Math.min(...basicEnds) : vendorDate(data.end_date)
  const windows = creditWindows(metrics, reset)
  if (pkg.is_token_package === true)
    windows.push(
      ...tokenWindows(
        metrics,
        data,
        windows.some((w) => !w.aside),
      ),
    )
  const daily = asRecordOrEmpty(balance?.result ?? balance?.data ?? balance)
  const total = nonnegative(daily.daily_token_limit)
  const used = nonnegative(daily.daily_tokens_used)
  if (total && used !== undefined)
    windows.push({
      id: "daily-benefit",
      unit: "tokens",
      total,
      remaining: Math.max(0, total - used),
      aside: true,
      spanMs: DAY,
      resetsAtMs: Math.floor((now + BEIJING) / DAY + 1) * DAY - BEIJING,
    })
  return {
    provider: "codearts",
    fetchedAt: now,
    unlimited: false,
    allowance: {
      state: windows.some((w) => !w.aside) ? "known" : "unknown",
      windows,
    },
    details: {
      plan:
        keys.station === "mainland" ?
          (pkg.package_name_cn ?? pkg.package_name_en)
        : (pkg.package_name_en ?? pkg.package_name_cn),
      creditBatches: batches,
    },
  }
}
