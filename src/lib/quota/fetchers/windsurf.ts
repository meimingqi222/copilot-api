import type { QuotaSnapshot } from "~/lib/legacy-accounts"
import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
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
import { parseMessage, type ProtobufNode } from "~/services/windsurf/protobuf"

function findField(
  nodes: Array<ProtobufNode>,
  field: number,
): ProtobufNode | undefined {
  return nodes.find((node) => node.field === field)
}

function findVarint(
  nodes: Array<ProtobufNode>,
  field: number,
): number | undefined {
  const node = findField(nodes, field)
  return node?.wire === 0 ? node.varint : undefined
}

function findSubmessage(
  data: Uint8Array,
  field: number,
): Uint8Array | undefined {
  const node = findField(parseMessage(data), field)
  return node?.wire === 2 ? node.raw : undefined
}

function findString(data: Uint8Array, field: number): string | undefined {
  const raw = findSubmessage(data, field)
  if (!raw) return undefined
  try {
    const text = new TextDecoder().decode(raw)
    return text || undefined
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
  const userStatus = requireSubmessage(
    payload,
    1,
    "GetUserStatus response missing F1",
  )
  const quotaInfo = requireSubmessage(
    userStatus,
    13,
    "GetUserStatus response missing F13 (quota)",
  )
  const fields = parseMessage(quotaInfo)
  const plan = findSubmessage(quotaInfo, 1)
  const planName = plan ? findString(plan, 2)?.toLowerCase() : undefined

  const overageMicros = findVarint(fields, 16)

  return {
    dailyUsedPercent: toUsedPercent(findVarint(fields, 14)),
    weeklyUsedPercent: toUsedPercent(findVarint(fields, 15)),
    dailyResetAt: findVarint(fields, 17),
    weeklyResetAt: findVarint(fields, 18),
    overageCredits:
      overageMicros !== undefined ? overageMicros / 1_000_000 : undefined,
    planName,
  }
}

function requireSubmessage(
  data: Uint8Array,
  field: number,
  message: string,
): Uint8Array {
  const raw = findSubmessage(data, field)
  if (!raw) throw new Error(message)
  return raw
}

function toUsedPercent(remaining: number | undefined): number | undefined {
  return remaining === undefined ? undefined : Math.max(0, 100 - remaining)
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
  const parsed = parseWindsurfQuotaPayload(payload)
  const hasData =
    parsed.planName !== undefined
    || parsed.dailyUsedPercent !== undefined
    || parsed.weeklyUsedPercent !== undefined
    || (parsed.overageCredits ?? 0) > 0
  if (!hasData) {
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
  const exhausted = remaining !== undefined && remaining <= 0
  setConnectionQuotaState(connection, exhausted ? "exhausted" : "available")
  if (!exhausted) {
    clearAccountRateLimitState(connection.id)
  }
  return snapshot
}
