import { createHash, createHmac } from "node:crypto"

import { HTTPError } from "~/lib/error"
import { asRecord } from "~/lib/json-shape"
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { connectionFetch } from "~/services/protocols/shared"
import {
  CODEARTS_IAM,
  codeArtsStations,
  type CodeArtsStation,
} from "~/services/codearts/stations"

export interface CodeArtsKeys {
  accessKey: string
  secretKey: string
  securityToken: string
  station: CodeArtsStation
}

export function codeArtsKeys(credential?: ApiCredential): CodeArtsKeys {
  const accessKey = credential?.value
  const { secretAccessKey, securityToken, codeartsStation } =
    credential?.context ?? {}
  if (
    !accessKey
    || typeof secretAccessKey !== "string"
    || !secretAccessKey
    || typeof securityToken !== "string"
    || !securityToken
    || (codeartsStation !== "mainland" && codeartsStation !== "international")
  ) {
    throw new HTTPError(
      "CodeArts sign-in is incomplete; sign in again",
      new Response(null, { status: 401 }),
    )
  }
  return {
    accessKey,
    secretKey: secretAccessKey,
    securityToken,
    station: codeartsStation,
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
const compare = (a: string, b: string) =>
  a < b ? -1
  : a > b ? 1
  : 0

interface SignedRequest {
  url: URL
  method?: "GET" | "POST" | "DELETE"
  body?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

export function signCodeArts(
  keys: CodeArtsKeys,
  request: SignedRequest,
  now = new Date(),
): Headers {
  const { url, method = "GET", body = "" } = request
  const date = now.toISOString().replace(/[-:]|\.\d{3}/g, "")
  const hash = sha256(body)
  const headers = new Headers({
    host: url.host,
    "x-sdk-date": date,
    "x-sdk-content-sha256": hash,
    "x-security-token": keys.securityToken,
    ...(method !== "GET" ? { "content-type": "application/json" } : {}),
  })
  const names = [...headers.keys()].sort()
  const canonical = [
    method,
    url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`,
    [...url.searchParams]
      .sort(([a, x], [b, y]) => compare(a, b) || compare(x, y))
      .map(([k, v]) => `${encode(k)}=${encode(v)}`)
      .join("&"),
    ...names.map((name) => `${name}:${headers.get(name)}`),
    "",
    names.join(";"),
    hash,
  ].join("\n")
  const signature = createHmac("sha256", keys.secretKey)
    .update(`SDK-HMAC-SHA256\n${date}\n${sha256(canonical)}`)
    .digest("hex")
  headers.set(
    "authorization",
    `SDK-HMAC-SHA256 Access=${keys.accessKey},SignedHeaders=${names.join(";")},Signature=${signature}`,
  )
  return headers
}

export function codeArtsFetch(
  connection: ProviderConnection,
  keys: CodeArtsKeys,
  request: SignedRequest,
): Promise<Response> {
  const { url, method = "GET", body, signal } = request
  const { snap, gateway } = codeArtsStations[keys.station]
  const iamUserRead =
    keys.station === "mainland"
    && url.origin === CODEARTS_IAM
    && method === "GET"
    && /^\/v3\.0\/OS-USER\/users\/[A-Za-z0-9_-]+$/.test(url.pathname)
    && !url.search
  if (
    url.username
    || url.password
    || url.hash
    || !(url.origin === snap || url.origin === gateway || iamUserRead)
  ) {
    throw new HTTPError(
      "CodeArts credentials may only be sent to their own station",
      new Response(null, { status: 400 }),
    )
  }
  const headers = signCodeArts(keys, request)
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return connectionFetch(connection)(url.href, {
    method,
    body,
    headers,
    signal,
    redirect: "error",
  })
}

/** Optional metadata reads must not turn a partial outage into an empty catalog or balance. */
export async function readCodeArts(
  connection: ProviderConnection,
  keys: CodeArtsKeys,
  request: SignedRequest,
): Promise<Record<string, unknown> | undefined> {
  const timeout = AbortSignal.timeout(12_000)
  try {
    const response = await codeArtsFetch(connection, keys, {
      ...request,
      signal:
        request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
    })
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    return asRecord(await response.json())
  } catch {
    request.signal?.throwIfAborted()
    return undefined
  }
}
