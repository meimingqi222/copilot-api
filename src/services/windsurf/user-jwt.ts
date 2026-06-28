/**
 * Mint and cache short-lived user_jwt for cloud-direct GetChatMessage.
 * Ported from opencode-windsurf-auth src/cloud-direct/auth.ts.
 */

import { logger } from "~/lib/logger"

import type { WindsurfClientSettings } from "./metadata"

import { buildWindsurfClientMetadata } from "./metadata"
import { parseMessage, ProtobufEncoder } from "./protobuf"

const MINT_TIMEOUT_MS = 30_000
const DEFAULT_HOST = "https://server.codeium.com"

interface CacheEntry {
  jwt: string
  expiresAt: number
}

interface MintedUserJwt {
  jwt: string
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<MintedUserJwt>>()

function anyAbortSignal(signals: Array<AbortSignal>): AbortSignal {
  const builtin = (
    AbortSignal as unknown as { any?: (s: Array<AbortSignal>) => AbortSignal }
  ).any
  if (typeof builtin === "function") return builtin(signals)
  const controller = new AbortController()
  const onAbort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  for (const s of signals) {
    if (s.aborted) {
      onAbort(s.reason)
      break
    }
    s.addEventListener("abort", () => onAbort(s.reason), { once: true })
  }
  return controller.signal
}

function flightKey(apiKey: string, host: string, sessionId: string): string {
  return `${host}\x1f${apiKey}\x1f${sessionId}`
}

function decodeJwtExpiry(jwt: string): number {
  try {
    const part = jwt.split(".")[1]
    if (!part) return Math.floor(Date.now() / 1000) + 600
    const pad = part + "=".repeat((4 - (part.length % 4)) % 4)
    const payload = JSON.parse(
      Buffer.from(
        pad.replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString("utf8"),
    ) as { exp?: number }
    if (typeof payload.exp === "number") return payload.exp
  } catch {
    // fall through
  }
  return Math.floor(Date.now() / 1000) + 600
}

function parseUserJwtFromResponse(buf: Uint8Array): string | null {
  const nodes = parseMessage(buf)
  for (const node of nodes) {
    if (node.field !== 1 || node.wire !== 2 || !node.raw) continue
    const jwt = new TextDecoder().decode(node.raw)
    if (/^eyJ[\w-]{10,}={0,2}\.[\w-]+={0,2}\.[\w-]+={0,2}$/.test(jwt)) {
      return jwt
    }
  }
  return null
}

async function mintUserJwt(
  apiKey: string,
  host: string,
  settings: WindsurfClientSettings,
  sessionId: string,
  signal?: AbortSignal,
): Promise<MintedUserJwt> {
  const outer = new ProtobufEncoder()
  outer.writeMessage(
    1,
    buildWindsurfClientMetadata({
      apiKey,
      settings,
      sessionId,
    }),
  )

  const timeoutSignal = AbortSignal.timeout(MINT_TIMEOUT_MS)
  const combined =
    signal ? anyAbortSignal([signal, timeoutSignal]) : timeoutSignal

  const resp = await fetch(
    `${host.replace(/\/$/, "")}/exa.auth_pb.AuthService/GetUserJwt`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        "Connect-Protocol-Version": "1",
      },
      body: outer.toUint8Array(),
      signal: combined,
    },
  )

  const buf = new Uint8Array(await resp.arrayBuffer())
  if (!resp.ok) {
    const text = new TextDecoder().decode(buf)
    throw new Error(`GetUserJwt HTTP ${resp.status}: ${text.slice(0, 400)}`)
  }

  const jwt = parseUserJwtFromResponse(buf)
  if (!jwt) {
    throw new Error(`GetUserJwt 200 but no field-1 JWT (${buf.length} bytes)`)
  }

  return { jwt, expiresAt: decodeJwtExpiry(jwt) }
}

/**
 * Returns cached user_jwt or mints a new one. Best-effort: callers may
 * fall back to api-key-only metadata when mint fails.
 */
export async function getCachedUserJwt(
  apiKey: string,
  host: string,
  settings: WindsurfClientSettings,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const normalizedHost = host.replace(/\/$/, "") || DEFAULT_HOST
  const now = Math.floor(Date.now() / 1000)
  const key = flightKey(apiKey, normalizedHost, sessionId)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now + 60) {
    return cached.jwt
  }

  const existing = inFlight.get(key)
  if (existing) return (await existing).jwt

  const promise = mintUserJwt(
    apiKey,
    normalizedHost,
    settings,
    sessionId,
    signal,
  )
  inFlight.set(key, promise)
  try {
    const minted = await promise
    cache.set(key, {
      jwt: minted.jwt,
      expiresAt: minted.expiresAt,
    })
    return minted.jwt
  } catch (err) {
    logger.warn("GetUserJwt failed — continuing with api_key only", {
      error: (err as Error).message,
    })
    return undefined
  } finally {
    inFlight.delete(key)
  }
}

export function clearCachedUserJwt(): void {
  cache.clear()
  inFlight.clear()
}
