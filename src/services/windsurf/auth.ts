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

import { readResponseBytes } from "~/lib/request-body"

import { normalizeWindsurfBaseUrl } from "./base-url"
import { buildWindsurfClientMetadata } from "./metadata"
import { ProtobufEncoder, parseMessage } from "./protobuf"

const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt"
const MAX_AUTH_RESPONSE_BYTES = 1024 * 1024

export interface DevinAuthMetadata {
  /** Short-lived JWT carried in Metadata.user_jwt (field 21) on chat requests. */
  userJwt: string
  /** Optional region-routed base URL; when present, chat requests go here. */
  baseUrl?: string
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
export async function fetchDevinUserJwt(opts: {
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

async function decompressGzip(payload: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(payload).body
  if (!stream) throw new Error("empty body")
  const decompressed = stream.pipeThrough(new DecompressionStream("gzip"))
  return readResponseBytes(new Response(decompressed), MAX_AUTH_RESPONSE_BYTES)
}

/** Re-exported so callers can normalize without importing metadata directly. */

export { normalizeDevinApiKey } from "./metadata"
