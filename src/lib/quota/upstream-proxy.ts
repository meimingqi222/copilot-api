import type { Account } from "~/lib/accounts"
import type {
  UpstreamProxyRequest,
  UpstreamProxyResponse,
} from "~/services/oauth/types"

import {
  getOAuthApiKey,
  getOAuthProxyUrl,
  getOAuthRefreshToken,
} from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import { oauthFetch, withProxyUrl } from "~/services/oauth/fetch"
import { substituteTokenInHeaders } from "~/services/oauth/token-resolver"

export function withOAuthProxy(
  account: Account,
  init: RequestInit = {},
): ReturnType<typeof withProxyUrl> {
  return withProxyUrl(init, getOAuthProxyUrl(account))
}

export async function fetchWithOAuthProxy(
  account: Account,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return oauthFetch(url, init ?? {}, { proxyUrl: getOAuthProxyUrl(account) })
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    result[key] = value
  }
  return result
}

async function sendUpstreamProxyRequest(
  account: Account,
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

  return fetchWithOAuthProxy(account, request.url, init)
}

export async function executeUpstreamProxyCall(
  account: Account,
  request: Omit<UpstreamProxyRequest, "accountId">,
): Promise<UpstreamProxyResponse> {
  // Prefer a fresh OAuth access token (matching CPA's request-path behavior:
  // access_token first, static api_key only as fallback). ensureOAuthAccessToken
  // refreshes when needed and returns undefined for accounts that only carry a
  // static key, so `?? apiKey` covers the static-key-only case.
  const apiKey = getOAuthApiKey(account)
  let token = (await ensureOAuthAccessToken(account)) ?? apiKey
  let response = await sendUpstreamProxyRequest(account, request, token)

  // xAI and other OAuth providers can invalidate an access token before its
  // advertised expiry. If the account has a refreshable OAuth token, refresh
  // once on 401 and retry the original request, matching CPA's request-path
  // recovery behavior.
  if (response.status === 401 && getOAuthRefreshToken(account)) {
    await response.text()
    token =
      (await ensureOAuthAccessToken(account, {
        forceRefresh: true,
        failedAccessToken: token,
      })) ?? apiKey
    response = await sendUpstreamProxyRequest(account, request, token)
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
