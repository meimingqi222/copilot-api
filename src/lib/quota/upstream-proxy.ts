import type { Account } from "~/lib/accounts"
import type {
  UpstreamProxyRequest,
  UpstreamProxyResponse,
} from "~/services/oauth/types"

import { getOAuthProxyUrl } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { oauthFetch, withProxyUrl } from "~/services/oauth/fetch"
import {
  resolveAccountAccessToken,
  substituteTokenInHeaders,
} from "~/services/oauth/token-resolver"

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

export async function executeUpstreamProxyCall(
  account: Account,
  request: Omit<UpstreamProxyRequest, "accountId">,
): Promise<UpstreamProxyResponse> {
  const token = resolveAccountAccessToken(account)
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

  const response = await fetchWithOAuthProxy(account, request.url, init)

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
