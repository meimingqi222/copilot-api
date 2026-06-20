type BunFetchInit = RequestInit & { proxy?: string }

export interface OAuthFetchOptions {
  signal?: AbortSignal
  proxyUrl?: string
}

export function withProxyUrl(
  init: RequestInit,
  proxyUrl?: string,
): BunFetchInit {
  if (!proxyUrl) {
    return init
  }
  return { ...init, proxy: proxyUrl }
}

export async function oauthFetch(
  url: string,
  init: RequestInit,
  options?: OAuthFetchOptions,
): Promise<Response> {
  return fetch(
    url,
    withProxyUrl(
      { ...init, signal: options?.signal ?? init.signal },
      options?.proxyUrl,
    ),
  )
}
