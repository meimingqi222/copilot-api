import { isRecord } from "~/lib/json-shape"
import {
  getConnectionProxyUrl,
  type ProviderConnection,
} from "~/lib/provider-connections"
import type { ProviderQuotaSnapshot, QuotaWindow } from "~/lib/quota/types"
import { nonnegative, readConsole } from "~/services/inkstone/client"

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined
  const raw = String(value).trim()
  if (!raw) return undefined
  const number = Number(raw)
  if (Number.isFinite(number)) {
    const ms = number < 1e12 ? number * 1000 : number
    return ms > 0 && ms <= 8.64e15 ? ms : undefined
  }
  const ms = Date.parse(raw.replace(" ", "T"))
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

function creditWindows(
  balance: Record<string, unknown>,
  models: Array<string>,
): Array<QuotaWindow> {
  const windows = balance.usage_windows
  if (!isRecord(windows)) return []
  return (
    [
      ["5h", 5 * 3600_000],
      ["7d", 7 * 86400_000],
    ] as const
  ).flatMap(([id, spanMs]) => {
    const window = windows[id]
    if (!isRecord(window) || window.enabled === false) return []
    const total = nonnegative(window.limit_credits)
    const reportedUsed = nonnegative(window.used_credits)
    if (!total) return []
    const remaining =
      reportedUsed === undefined ?
        nonnegative(window.remaining_credits)
      : Math.max(0, total - reportedUsed)
    if (remaining === undefined) return []
    return [
      {
        id,
        unit: "credits",
        used: Math.max(0, 1 - remaining / total),
        total,
        remaining: Math.min(remaining, total),
        spanMs,
        resetsAtMs: timestamp(window.next_recover_at),
        scope: { models },
      },
    ]
  })
}

function creditPackages(data: unknown) {
  const rows = isRecord(data) ? (data.packages ?? data.items) : data
  if (!Array.isArray(rows)) return []
  return rows.flatMap((item: unknown) => {
    if (!isRecord(item)) return []
    const status =
      typeof item.status === "string" ? item.status.toLowerCase() : ""
    const remaining = nonnegative(item.remaining_credits)
    if (!remaining || (status && status !== "available" && status !== "unused"))
      return []
    const name = [item.remark, item.remark_en].find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    return [
      {
        name: name?.trim() ?? "Credit pack",
        remaining,
        total: nonnegative(item.total_credits) || undefined,
        expiresAtMs:
          isRecord(item.current_cycle) ?
            timestamp(item.current_cycle.end_at)
          : undefined,
      },
    ]
  })
}

export async function fetchInkstoneQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot | undefined> {
  const token = connection.credentials[0]?.context?.uaaToken
  if (typeof token !== "string" || !token) return undefined
  const options = { proxyUrl: getConnectionProxyUrl(connection), signal }
  const [balanceRead, packagesRead] = await Promise.allSettled([
    readConsole("credits/balance", token, options),
    readConsole("credits/packages", token, options),
  ])
  signal?.throwIfAborted()
  const data =
    balanceRead.status === "fulfilled" ? balanceRead.value : undefined
  const balance = isRecord(data) ? data : {}
  // Free and unpriced chat models are not known to consume these metered windows.
  const paidModels = (connection.models ?? [])
    .filter((model) => model.metadata?.isFree === false)
    .map((model) => model.upstreamId)
  const windows = creditWindows(balance, paidModels)
  return {
    provider: "inkstone",
    fetchedAt: Date.now(),
    unlimited: false,
    allowance: {
      state: windows.length ? "known" : "unknown",
      windows,
      ...(!isRecord(data) && { partial: true }),
    },
    details: {
      plan: "InkStone Token Plan",
      availableCredits: nonnegative(balance.available_credits),
      activePackageCount: nonnegative(balance.active_package_count),
      rpmLimit: nonnegative(balance.rpm_limit),
      tpmLimit: nonnegative(balance.tpm_limit),
      windows,
      ...(packagesRead.status === "fulfilled" ?
        { packages: creditPackages(packagesRead.value) }
      : { packagesError: "Credit packs could not be read." }),
      ...(!isRecord(data) && {
        balanceError:
          "Credit balance could not be read. If the console session expired, paste a fresh uaa-token.",
      }),
    },
  }
}
