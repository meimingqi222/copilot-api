import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import {
  getConnectionProvider,
  getConnectionSettings,
  getConnectionWindsurfApiKey,
  markCredentialQuotaExhausted,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
} from "~/lib/provider-connections"
import { DEFAULTS } from "~/lib/provider-connections/types"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { normalizeWindsurfBaseUrl } from "~/services/windsurf/base-url"
import {
  buildWindsurfClientMetadata,
  WINDSURF_CONNECT_USER_AGENT,
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

interface WindsurfQuotaWindows {
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

/** 用尽窗口里最后的重置时刻（epoch ms）；没有可用信息时 undefined。 */
function exhaustedWindowResetMs(
  dailyRemainingPercent: number | undefined,
  dailyResetSeconds: number | undefined,
  weeklyRemainingPercent: number | undefined,
  weeklyResetSeconds: number | undefined,
): number | undefined {
  const candidates: Array<number> = []
  if (dailyRemainingPercent === 0 && dailyResetSeconds !== undefined) {
    candidates.push(dailyResetSeconds * 1000)
  }
  if (weeklyRemainingPercent === 0 && weeklyResetSeconds !== undefined) {
    candidates.push(weeklyResetSeconds * 1000)
  }
  return candidates.length > 0 ? Math.max(...candidates) : undefined
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
        // Same UA as the chat and catalog calls: a missing UA here would make
        // the quota probe the odd one out in the account's fingerprint.
        "user-agent": WINDSURF_CONNECT_USER_AGENT,
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

  // 两个窗口都算，取更紧张的那个。
  //
  // 日额度是周额度的子窗口：任一窗口用尽就会立刻挡住请求，所以"还能用多少"必须由
  // 剩余更少的窗口决定；恢复到什么时候由"用尽的那个窗口"的重置时刻决定。旧实现只要
  // weekly 有值就忽略 daily，于是日额度打满、周还有余时会被判成"可用"继续派请求，
  // 然后被上游拒（这是上次相反方向的错判）。
  const dailyRemainingPercent =
    parsed.dailyUsedPercent !== undefined ?
      Math.max(0, 100 - parsed.dailyUsedPercent)
    : undefined
  const weeklyRemainingPercent =
    parsed.weeklyUsedPercent !== undefined ?
      Math.max(0, 100 - parsed.weeklyUsedPercent)
    : undefined
  const definedRemaining = [
    dailyRemainingPercent,
    weeklyRemainingPercent,
  ].filter((value): value is number => value !== undefined)
  const remainingPercent =
    definedRemaining.length > 0 ? Math.min(...definedRemaining) : undefined

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
  if (exhausted) {
    // 恢复时间对齐到"用尽窗口"的重置时刻，而不是默认 24h 猜测（日额度的重置可能只有
    // 几小时，猜 24h 会白白停摆）。夹在 1min~24h 之间，防上游字段异常把账号停摆过久。
    // 窗口信息从 snapshot.details 读（refreshWindsurfQuota 不再持有解析中间量）。
    const details = (snapshot.details ?? {}) as {
      dailyUsedPercent?: number
      weeklyUsedPercent?: number
      dailyResetAt?: number
      weeklyResetAt?: number
    }
    const windowRemaining = (used: number | undefined) =>
      used === undefined ? undefined : Math.max(0, 100 - used)
    const resetMs = exhaustedWindowResetMs(
      windowRemaining(details.dailyUsedPercent),
      details.dailyResetAt,
      windowRemaining(details.weeklyUsedPercent),
      details.weeklyResetAt,
    )
    const recoveryMs =
      resetMs === undefined ?
        DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS
      : Math.min(
          Math.max(resetMs - Date.now(), 60_000),
          DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS,
        )
    const credential = connection.credentials[0]
    if (credential) {
      markCredentialQuotaExhausted(
        credential,
        "windsurf quota exhausted",
        recoveryMs,
      )
    }
  } else {
    clearAccountRateLimitState(connection.id)
  }
  return snapshot
}
