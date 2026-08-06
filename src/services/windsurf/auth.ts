/**
 * Windsurf/Devin two-stage authentication.
 *
 * Real Windsurf (and oh-my-pi) does NOT send the long-lived session token
 * directly as the chat credential. It first exchanges the session token for a
 * short-lived `userJwt` via the `GetUserJwt` RPC, then carries that `userJwt`
 * in `Metadata.user_jwt` (field 21) of every chat request. This two-stage flow
 * is part of the wire fingerprint - omitting it (sending only the session
 * token) is detectable.
 *
 * Ported from oh-my-pi packages/ai/src/providers/devin.ts (441-491).
 */

import { createHash } from "node:crypto"

import { readResponseBytes } from "~/lib/request-body"

import { normalizeWindsurfBaseUrl } from "./base-url"
import { getWindsurfUserJwtCacheTtlMs } from "./config"
import { buildWindsurfClientMetadata } from "./metadata"
import { ProtobufEncoder, parseMessage } from "./protobuf"

const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt"
const MAX_AUTH_RESPONSE_BYTES = 1024 * 1024

export interface DevinAuthMetadata {
  /** Short-lived JWT carried in Metadata.user_jwt (field 21) on chat requests. */
  userJwt: string
  /** Optional region-routed base URL; when present, chat requests go here. */
  baseUrl?: string
  /** Runtime diagnostic only; never serialized into Windsurf metadata. */
  cacheStatus?: "hit" | "miss" | "shared"
}

interface CachedDevinAuth {
  value: DevinAuthMetadata
  expiresAt: number
}

const JWT_EXPIRY_SKEW_MS = 30_000
const authCache = new Map<string, CachedDevinAuth>()

function authCacheKey(apiKey: string, baseUrl: string): string {
  return createHash("sha256")
    .update(`${normalizeWindsurfBaseUrl(baseUrl)}\0${apiKey}`)
    .digest("hex")
}

function readJwtExpiryMs(jwt: string): number | undefined {
  const payload = jwt.split(".")[1]
  if (!payload) return undefined
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { exp?: unknown }
    return typeof decoded.exp === "number" && Number.isFinite(decoded.exp) ?
        decoded.exp * 1000
      : undefined
  } catch {
    return undefined
  }
}

function cacheAuthResult(
  key: string,
  value: DevinAuthMetadata,
  ttlMs: number,
): void {
  if (ttlMs <= 0) return
  const now = Date.now()
  const jwtExpiry = readJwtExpiryMs(value.userJwt)
  const expiresAt = Math.min(
    now + ttlMs,
    jwtExpiry ? jwtExpiry - JWT_EXPIRY_SKEW_MS : Number.POSITIVE_INFINITY,
  )
  if (expiresAt <= now) return
  authCache.set(key, {
    value: {
      userJwt: value.userJwt,
      ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}),
    },
    expiresAt,
  })
}

export function invalidateDevinUserJwtCache(opts: {
  apiKey: string
  baseUrl: string
}): void {
  authCache.delete(authCacheKey(opts.apiKey, opts.baseUrl))
}

export function clearDevinUserJwtCacheForTest(): void {
  authCache.clear()
}

/** Decodes a `GetUserJwtResponse` proto: { user_jwt=1, custom_api_server_url=2 }. */
function decodeGetUserJwtResponse(payload: Uint8Array): {
  userJwt?: string
  customApiServerUrl?: string
} {
  const nodes = parseMessage(payload)
  const decoder = new TextDecoder()
  let userJwt: string | undefined
  let customApiServerUrl: string | undefined
  for (const node of nodes) {
    if (node.field === 1 && node.raw) {
      userJwt = decoder.decode(node.raw)
    } else if (node.field === 2 && node.raw) {
      customApiServerUrl = decoder.decode(node.raw)
    }
  }
  return { userJwt, customApiServerUrl }
}

/**
 * Exchanges the session token for a short-lived `userJwt` via GetUserJwt.
 *
 * The auth request wraps the same Windsurf client Metadata (ideName/version/
 * apiKey/locale) as the chat request, just without userJwt. The response is a
 * protobuf (possibly gzip-compressed - we retry gunzipped on parse failure,
 * matching oh-my-pi `decodeDevinUserJwtResponse`). Returns the userJwt and an
 * optional region-routed `baseUrl` (`customApiServerUrl`).
 */
async function fetchDevinUserJwtUncached(opts: {
  apiKey: string
  baseUrl: string
  signal?: AbortSignal
}): Promise<DevinAuthMetadata> {
  const { apiKey, signal } = opts
  const baseUrl = normalizeWindsurfBaseUrl(opts.baseUrl)
  // The auth request body is a GetUserJwtRequest { metadata = 1 (Metadata) }.
  const requestMetadata = buildWindsurfClientMetadata(apiKey)
  const outer = new ProtobufEncoder()
  outer.writeMessage(1, requestMetadata)
  const requestBody = outer.toUint8Array()

  const response = await fetch(`${baseUrl}${DEVIN_AUTH_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: requestBody,
    signal,
  })

  const payload = await readResponseBytes(response, MAX_AUTH_RESPONSE_BYTES)
  if (!response.ok) {
    throw new Error(
      `Devin auth error ${response.status} ${response.statusText}: ${new TextDecoder().decode(payload)}`,
    )
  }

  let decoded = decodeGetUserJwtResponse(payload)
  if (!decoded.userJwt) {
    // oh-my-pi retries with gunzip on parse failure - the response may be
    // gzip-compressed.
    try {
      const decompressed = await decompressGzip(payload)
      decoded = decodeGetUserJwtResponse(decompressed)
    } catch {
      // fall through with the original (empty) decode
    }
  }

  if (!decoded.userJwt) {
    throw new Error("Devin auth error: GetUserJwt returned an empty user JWT")
  }

  const customBaseUrl = decoded.customApiServerUrl?.trim()
  return {
    userJwt: decoded.userJwt,
    ...(customBaseUrl ? { baseUrl: customBaseUrl.replace(/\/+$/, "") } : {}),
  }
}

export async function fetchDevinUserJwt(opts: {
  apiKey: string
  baseUrl: string
  signal?: AbortSignal
}): Promise<DevinAuthMetadata> {
  const ttlMs = getWindsurfUserJwtCacheTtlMs()
  if (ttlMs <= 0) {
    const value = await fetchDevinUserJwtUncached(opts)
    return { ...value, cacheStatus: "miss" }
  }

  const key = authCacheKey(opts.apiKey, opts.baseUrl)
  const cached = authCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cacheStatus: "hit" }
  }
  if (cached) authCache.delete(key)

  const value = await fetchDevinUserJwtUncached(opts)
  cacheAuthResult(key, value, ttlMs)
  return { ...value, cacheStatus: "miss" }
}

async function decompressGzip(payload: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(payload).body
  if (!stream) throw new Error("empty body")
  const decompressed = stream.pipeThrough(new DecompressionStream("gzip"))
  return readResponseBytes(new Response(decompressed), MAX_AUTH_RESPONSE_BYTES)
}

/** Re-exported so callers can normalize without importing metadata directly. */

export { normalizeDevinApiKey } from "./metadata"
