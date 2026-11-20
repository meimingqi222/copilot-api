import { createHash } from "node:crypto"
import { HTTPError } from "~/lib/error"
import { asNumber, asRecord, asString } from "~/lib/json-shape"
import { readResponseBytes } from "~/lib/request-body"
import {
  getConnectionProxyUrl,
  type ProviderConnection,
} from "~/lib/provider-connections"
import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"
import { parseDuMateCookie } from "~/services/dumate/import"

const CONSOLE = "https://console.bce.baidu.com"
export const DUMATE_GATEWAY = "https://dumate-svc.baidu.com/gateway/apis/v1"
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DuMate/1.0.82 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36"
const HOUR_MS = 60 * 60_000

export async function duMateConsoleGet(
  path:
    | "/api/dumate/user/info"
    | "/api/dumate/app/token/get"
    | "/api/dumate/points/quota_overview?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true"
    | "/api/dumate/points/loginBonusInfo",
  cookie: string,
  options: OAuthFetchOptions,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(20_000)
  const res = await oauthFetch(
    `${CONSOLE}${path}`,
    {
      redirect: "manual",
      headers: {
        Cookie: parseDuMateCookie(cookie),
        "User-Agent": UA,
        Accept: "application/json",
        Referer: `${CONSOLE}/`,
      },
    },
    {
      ...options,
      signal:
        options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    },
  )
  const text = new TextDecoder().decode(
    await readResponseBytes(res, 1024 * 1024),
  )
  if (
    res.status === 401
    || res.status === 403
    || (res.status >= 300 && res.status < 400)
    || (res.ok
      && (res.headers.get("content-type")?.includes("text/html")
        || /^\s*<(?:!doctype\s+html|html\b)/i.test(text)))
  ) {
    throw new HTTPError(
      "DuMate console session expired; sign in again.",
      new Response(null, { status: 401 }),
    )
  }
  if (!res.ok)
    throw new HTTPError(
      "DuMate console request failed.",
      new Response(null, { status: res.status }),
    )
  const payload = asRecord(JSON.parse(text))
  if (payload?.code !== 0 || payload.success === false) {
    const expired = /登录凭证|重新登录|login/i.test(
      asString(payload?.message) ?? "",
    )
    throw new HTTPError(
      "DuMate console rejected the request.",
      new Response(null, { status: expired ? 401 : 502 }),
    )
  }
  const result = asRecord(payload.result)
  if (!result) throw new Error("Invalid DuMate console response.")
  return result
}

interface GatewayToken {
  token: string
  refreshAt: number
}

interface TokenEntry {
  current?: GatewayToken
  pending?: Promise<GatewayToken>
}

const tokens = new Map<string, TokenEntry>()

function tokenKey(cookie: string, proxyUrl: string | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify([cookie, proxyUrl]))
    .digest("hex")
}

async function mintToken(
  cookie: string,
  proxyUrl?: string,
): Promise<GatewayToken> {
  const result = await duMateConsoleGet("/api/dumate/app/token/get", cookie, {
    proxyUrl,
  })
  const token = asString(result.token)
  if (!token || !/^[\x21-\x7e]+$/.test(token))
    throw new Error("DuMate did not return a valid gateway token.")
  const now = Date.now()
  const expiry = Date.parse(asString(result.expired_at) ?? "")
  if (Number.isFinite(expiry) && expiry <= now)
    throw new Error("DuMate returned an expired gateway token.")
  // Refresh hourly even when the server grants the usual much longer lifetime.
  const refreshAt =
    Number.isFinite(expiry) ?
      Math.min(now + HOUR_MS, now + (expiry - now) * 0.9)
    : now + HOUR_MS
  return { token, refreshAt }
}

function cachedDuMateGatewayToken(
  cookie: string,
  proxyUrl?: string,
): Promise<GatewayToken> {
  const key = tokenKey(cookie, proxyUrl)
  const entry = tokens.get(key) ?? {}
  if (entry.current && entry.current.refreshAt > Date.now())
    return Promise.resolve(entry.current)
  if (entry.pending) return entry.pending
  if (!tokens.has(key) && tokens.size >= 512) {
    for (const [id, old] of tokens) {
      if (!old.pending) {
        tokens.delete(id)
        break
      }
    }
    if (tokens.size >= 512)
      throw new Error("Too many concurrent DuMate sign-ins.")
  }
  tokens.set(key, entry)
  entry.pending = mintToken(cookie, proxyUrl)
    .then((fresh) => {
      entry.current = fresh
      return fresh
    })
    .finally(() => {
      entry.pending = undefined
      if (!entry.current || entry.current.refreshAt <= Date.now())
        tokens.delete(key)
    })
  return entry.pending
}

export async function duMateGatewayToken(
  cookie: string,
  proxyUrl?: string,
  signal?: AbortSignal,
): Promise<GatewayToken> {
  signal?.throwIfAborted()
  const pending = cachedDuMateGatewayToken(cookie, proxyUrl)
  if (!signal) return pending
  // The exchange is shared; disconnecting a caller must not abort other callers' token mint.
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

export function invalidateDuMateToken(
  cookie: string,
  proxyUrl: string | undefined,
  token: GatewayToken,
): void {
  const key = tokenKey(cookie, proxyUrl)
  const entry = tokens.get(key)
  if (entry?.current !== token) return
  entry.current = undefined
  if (!entry.pending) tokens.delete(key)
}

export async function fetchDuMateQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  const cookie = connection.credentials[0]?.value ?? ""
  const options = { proxyUrl: getConnectionProxyUrl(connection), signal }
  const [overview, bonus] = await Promise.all([
    duMateConsoleGet(
      "/api/dumate/points/quota_overview?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true",
      cookie,
      options,
    ),
    duMateConsoleGet(
      "/api/dumate/points/loginBonusInfo",
      cookie,
      options,
    ).catch(() => undefined),
  ])
  const total = asNumber(overview.totalPoints)
  const used = asNumber(overview.usedPoints)
  const remaining =
    total !== undefined && used !== undefined && total >= 0 && used >= 0 ?
      Math.max(0, total - used)
    : undefined
  let expiresAtMs: number | undefined
  for (const pack of [overview.subscription, overview.incremental].flatMap(
    (value): Array<unknown> => (Array.isArray(value) ? value : []),
  )) {
    const item = asRecord(pack)
    const date = (asNumber(item?.expireDate) ?? 0) * 1000
    if (
      item?.status === "active"
      && date > 0
      && (!expiresAtMs || date < expiresAtMs)
    )
      expiresAtMs = date
  }
  return {
    provider: "dumate",
    fetchedAt: Date.now(),
    unlimited: false,
    allowance:
      remaining === undefined ?
        { state: "unknown", windows: [] }
      : {
          state: "known",
          windows: [{ id: "points", unit: "credits", total, remaining }],
        },
    // One pack lapsing does not expire the aggregate wallet.
    details: {
      pointsUsed: used,
      loginBonusDays: asNumber(bonus?.totalTimes),
      nextPackExpiryMs: expiresAtMs,
    },
  }
}
