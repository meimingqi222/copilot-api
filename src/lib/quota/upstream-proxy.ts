import type { ProviderConnection } from "~/lib/provider-connections"
import type {
  UpstreamProxyRequest,
  UpstreamProxyResponse,
} from "~/services/oauth/types"

import { HTTPError } from "~/lib/error"
import { getConnectionProxyUrl } from "~/lib/provider-connections"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import { oauthFetch, withProxyUrl } from "~/services/oauth/fetch"
import { substituteTokenInHeaders } from "~/services/oauth/token-resolver"

/**
 * Connection 原生的 OAuth 代理 fetch。
 * 代理地址经 getConnectionProxyUrl(metadata 顶层 proxyUrl,由 settings.proxyUrl
 * 迁移时同步写入)。
 */
export async function fetchWithConnectionProxy(
  connection: ProviderConnection,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return oauthFetch(url, init ?? {}, {
    proxyUrl: getConnectionProxyUrl(connection),
  })
}

/** withProxyUrl 的 connection 版本(读取 metadata 顶层 proxyUrl)。 */
export function withConnectionProxy(
  connection: ProviderConnection,
  init: RequestInit = {},
): ReturnType<typeof withProxyUrl> {
  return withProxyUrl(init, getConnectionProxyUrl(connection))
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    result[key] = value
  }
  return result
}

function connectionRefreshToken(
  connection: ProviderConnection,
): string | undefined {
  const token = connection.credentials[0]?.context?.refreshToken
  return typeof token === "string" && token ? token : undefined
}

/** 读取静态 api key(context.apiKey,等价旧 getOAuthApiKey)。 */
function readStaticApiKey(connection: ProviderConnection): string | undefined {
  const key = connection.credentials[0]?.context?.apiKey
  return typeof key === "string" && key ? key : undefined
}

async function sendUpstreamProxyRequest(
  connection: ProviderConnection,
  request: Omit<UpstreamProxyRequest, "accountId">,
  token: string | undefined,
): Promise<Response> {
  const headers = substituteTokenInHeaders(request.headers, token)
  const init: RequestInit = {
    method: request.method.toUpperCase(),
    headers,
    signal: request.signal,
  }

  if (
    request.body
    && request.method.toUpperCase() !== "GET"
    && request.method.toUpperCase() !== "HEAD"
  ) {
    init.body = request.body
  }

  return fetchWithConnectionProxy(connection, request.url, init)
}

export async function executeUpstreamProxyCall(
  connection: ProviderConnection,
  request: Omit<UpstreamProxyRequest, "accountId">,
): Promise<UpstreamProxyResponse> {
  const credential = connection.credentials[0]
  if (!credential) {
    throw new Error(
      `Upstream proxy request requires a credential on connection "${connection.name}"`,
    )
  }

  // Prefer a fresh OAuth access token (matching CPA's request-path behavior:
  // access_token first, static api_key only as fallback). The ensure helper
  // refreshes when needed and returns undefined for connections that only
  // carry a static key, so `?? apiKey` covers the static-key-only case.
  const apiKey = readStaticApiKey(connection)
  let token =
    (await ensureOAuthConnectionAccessToken(connection, credential)) ?? apiKey
  let response = await sendUpstreamProxyRequest(connection, request, token)

  // xAI and other OAuth providers can invalidate an access token before its
  // advertised expiry. If the connection has a refreshable OAuth token,
  // refresh once on 401 and retry the original request, matching CPA's
  // request-path recovery behavior.
  if (response.status === 401 && connectionRefreshToken(connection)) {
    await response.text()
    token =
      (await ensureOAuthConnectionAccessToken(connection, credential, {
        forceRefresh: true,
        failedAccessToken: token,
      })) ?? apiKey
    response = await sendUpstreamProxyRequest(connection, request, token)
  }

  if (!response.ok && response.status >= 500) {
    const body = await response.text()
    throw new HTTPError("Upstream proxy request failed", response, body)
  }

  return {
    statusCode: response.status,
    headers: headersToRecord(response.headers),
    body: await response.text(),
  }
}
