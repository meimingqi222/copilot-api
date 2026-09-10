import type { QuotaSnapshot } from "~/lib/legacy-accounts"
import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  getConnectionProvider,
  getConnectionSettings,
  getConnectionWindsurfApiKey,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
} from "~/lib/provider-connections"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { normalizeWindsurfBaseUrl } from "~/services/windsurf/base-url"
import {
  buildWindsurfClientMetadata,
  wrapWindsurfMetadataMessage,
} from "~/services/windsurf/metadata"
import { parseMessage } from "~/services/windsurf/protobuf"

function findVarint(
  nodes: Array<{ field: number; wire: number; varint?: number }>,
  field: number,
): number | undefined {
  return nodes.find((node) => node.field === field && node.wire === 0)?.varint
}

function findSubmessage(
  nodes: Array<{
    field: number
    wire: number
    raw?: Uint8Array
    sub?: Array<never>
  }>,
  field: number,
): Uint8Array | undefined {
  const node = nodes.find((candidate) => candidate.field === field)
  return node?.raw
}

function findString(data: Uint8Array, field: number): string | undefined {
  const nodes = parseMessage(data)
  const node = nodes.find(
    (candidate) => candidate.field === field && candidate.wire === 2,
  )
  if (!node?.raw) return undefined
  try {
    return new TextDecoder().decode(node.raw)
  } catch {
    return undefined
  }
}

export interface WindsurfQuotaWindows {
  dailyUsedPercent: number | undefined
  weeklyUsedPercent: number | undefined
  dailyResetAt: number | undefined
  weeklyResetAt: number | undefined
  overageCredits: number | undefined
  planName: string | undefined
}

export function parseWindsurfQuotaPayload(
  payload: Uint8Array,
): WindsurfQuotaWindows {
  const top = parseMessage(payload)
  const topNodes = top as Array<{
    field: number
    wire: number
    raw?: Uint8Array
  }>
  const userStatus = findSubmessage(topNodes, 1)
  if (!userStatus) {
    throw new Error("GetUserStatus response missing F1")
  }
  const quotaInfoRaw = parseMessage(userStatus)
  const quotaNodes = quotaInfoRaw as Array<{
    field: number
    wire: number
    raw?: Uint8Array
  }>
  const info = findSubmessage(quotaNodes, 13)
  if (!info) {
    throw new Error("GetUserStatus response missing F13 (quota)")
  }
  const fields = parseMessage(info)

  const asPercent = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : Math.max(0, 100 - value)

  const planRaw = findSubmessage(
    fields as Array<{ field: number; wire: number; raw?: Uint8Array }>,
    1,
  )
  const planName = planRaw ? findString(planRaw, 2)?.toLowerCase() : undefined

  return {
    dailyUsedPercent: asPercent(findVarint(fields, 14)),
    weeklyUsedPercent: asPercent(findVarint(fields, 15)),
    dailyResetAt: findVarint(fields, 17),
    weeklyResetAt: findVarint(fields, 18),
    overageCredits:
      findVarint(fields, 16) !== undefined ?
        (findVarint(fields, 16) as number) / 1_000_000
      : undefined,
    planName,
  }
}

export async function fetchWindsurfQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (getConnectionProvider(connection) !== "windsurf") {
    throw new Error("fetchWindsurfQuota requires a Windsurf connection")
  }

  const apiKey = getConnectionWindsurfApiKey(connection)
  if (!apiKey) {
    throw new Error("Windsurf quota request requires an apiKey")
  }

  const settings = getConnectionSettings(connection) as
    | { baseUrl?: string }
    | undefined
  const baseUrl = normalizeWindsurfBaseUrl(settings?.baseUrl)
  const metadata = buildWindsurfClientMetadata(apiKey)
  const body = wrapWindsurfMetadataMessage(metadata)

  const response = await fetch(
    `${baseUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${apiKey}-${apiKey}`,
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        accept: "*/*",
      },
      body,
      signal,
    },
  )

  if (!response.ok) {
    throw new HTTPError(
      "Failed to fetch Windsurf quota",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  const payload = new Uint8Array(await response.arrayBuffer())
  let parsed: WindsurfQuotaWindows
  try {
    parsed = parseWindsurfQuotaPayload(payload)
  } catch (error) {
    logger.warn(
      `Windsurf quota parse failed for "${connection.name}":`,
      (error as Error).message,
    )
    throw error
  }

  if (
    parsed.planName === undefined
    && parsed.dailyUsedPercent === undefined
    && parsed.weeklyUsedPercent === undefined
    && (parsed.overageCredits ?? 0) <= 0
  ) {
    throw new Error("GetUserStatus returned no quota fields")
  }

  let remainingPercent: number | undefined
  if (parsed.weeklyUsedPercent !== undefined) {
    remainingPercent = Math.max(0, 100 - parsed.weeklyUsedPercent)
  } else if (parsed.dailyUsedPercent !== undefined) {
    remainingPercent = Math.max(0, 100 - parsed.dailyUsedPercent)
  }

  return {
    fetchedAt: Date.now(),
    provider: "windsurf",
    unlimited: remainingPercent === undefined,
    premiumInteractionsRemaining:
      remainingPercent !== undefined ? Math.round(remainingPercent) : undefined,
    details: {
      plan: parsed.planName,
      dailyUsedPercent: parsed.dailyUsedPercent,
      weeklyUsedPercent: parsed.weeklyUsedPercent,
      dailyResetAt: parsed.dailyResetAt,
      weeklyResetAt: parsed.weeklyResetAt,
      overageCredits: parsed.overageCredits,
    },
  }
}

export async function refreshWindsurfQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  const snapshot = await fetchWindsurfQuota(connection, signal)
  setConnectionQuotaInfo(connection, snapshot)
  const remaining = snapshot.premiumInteractionsRemaining
  setConnectionQuotaState(
    connection,
    remaining !== undefined && remaining <= 0 ? "exhausted" : "available",
  )
  if (remaining === undefined || remaining > 0) {
    clearAccountRateLimitState(connection.id)
  }
  return snapshot
}
