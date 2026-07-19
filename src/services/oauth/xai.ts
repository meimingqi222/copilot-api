import { randomBytes } from "node:crypto"

import type { OAuthAccount } from "~/lib/accounts"

import { applyOAuthBundle } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import { extractEmailFromIdToken } from "./jwt"
import { generateOAuthState, generatePkceCodes, type PkceCodes } from "./pkce"

export const XAI_API_BASE_URL = "https://api.x.ai/v1"
/**
 * Grok CLI chat-proxy base URL. Used for non-media HTTP chat when an xAI OAuth
 * account is in CLI mode (settings.useApi !== true, the default). WebSocket and
 * /responses/compact transports must NOT use this endpoint: cli-chat-proxy only
 * accepts HTTP POST chat and returns 405 for websocket upgrades / 404 for
 * compact.
 */
export const XAI_CLI_CHAT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1"
export const XAI_ISSUER = "https://auth.x.ai"
export const XAI_DISCOVERY_URL = `${XAI_ISSUER}/.well-known/openid-configuration`
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
export const XAI_SCOPE =
  "openid profile email offline_access grok-cli:access api:access"
export const XAI_REDIRECT_HOST = "127.0.0.1"
export const XAI_CALLBACK_PORT = 56121
export const XAI_REDIRECT_PATH = "/callback"
export const XAI_REDIRECT_URI = `http://${XAI_REDIRECT_HOST}:${XAI_CALLBACK_PORT}${XAI_REDIRECT_PATH}`
export const XAI_DEFAULT_TOKEN_ENDPOINT = `${XAI_ISSUER}/oauth2/token`

interface XaiDiscovery {
  authorization_endpoint: string
  token_endpoint: string
}

interface XaiTokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

export interface XaiOAuthBundle {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresAt?: number
  email?: string
  tokenEndpoint: string
  redirectUri: string
}

export function generateXaiNonce(): string {
  return randomBytes(16).toString("hex")
}

export async function discoverXaiOAuthEndpoints(
  options?: OAuthFetchOptions,
): Promise<XaiDiscovery> {
  const response = await oauthFetch(
    XAI_DISCOVERY_URL,
    { headers: { Accept: "application/json" } },
    options,
  )
  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `xAI OAuth discovery failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }
  const payload = (await response.json()) as Partial<XaiDiscovery>
  if (!payload.authorization_endpoint || !payload.token_endpoint) {
    throw new Error("xAI OAuth discovery returned incomplete endpoints")
  }
  return payload as XaiDiscovery
}

export function buildXaiAuthUrl(options: {
  authorizationEndpoint: string
  state: string
  nonce: string
  pkce: PkceCodes
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: XAI_CLIENT_ID,
    redirect_uri: XAI_REDIRECT_URI,
    scope: XAI_SCOPE,
    code_challenge: options.pkce.codeChallenge,
    code_challenge_method: "S256",
    state: options.state,
    nonce: options.nonce,
    plan: "generic",
    referrer: "cli-proxy-api",
  })
  return `${options.authorizationEndpoint}?${params.toString()}`
}

export function createXaiOAuthStart(
  discovery: XaiDiscovery,
  pkce = generatePkceCodes(),
): {
  state: string
  nonce: string
  pkce: PkceCodes
  authUrl: string
  tokenEndpoint: string
} {
  const state = generateOAuthState()
  const nonce = generateXaiNonce()
  return {
    state,
    nonce,
    pkce,
    tokenEndpoint: discovery.token_endpoint,
    authUrl: buildXaiAuthUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      state,
      nonce,
      pkce,
    }),
  }
}

function mapTokenResponse(
  token: XaiTokenResponse,
): Omit<XaiOAuthBundle, "tokenEndpoint" | "redirectUri"> {
  if (!token.access_token) {
    throw new Error("xAI token response missing access_token")
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    idToken: token.id_token,
    expiresAt:
      token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    email: extractEmailFromIdToken(token.id_token),
  }
}

async function postXaiTokenForm(
  tokenEndpoint: string,
  form: URLSearchParams,
  options?: OAuthFetchOptions,
): Promise<XaiTokenResponse> {
  const response = await oauthFetch(
    tokenEndpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    },
    options,
  )
  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `xAI token request failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }
  return (await response.json()) as XaiTokenResponse
}

export async function exchangeXaiCodeForTokens(
  code: string,
  pkce: PkceCodes,
  tokenEndpoint: string,
  options?: OAuthFetchOptions,
): Promise<XaiOAuthBundle> {
  const token = await postXaiTokenForm(
    tokenEndpoint,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: XAI_REDIRECT_URI,
      client_id: XAI_CLIENT_ID,
      code_verifier: pkce.codeVerifier,
    }),
    options,
  )
  return {
    ...mapTokenResponse(token),
    tokenEndpoint,
    redirectUri: XAI_REDIRECT_URI,
  }
}

export async function refreshXaiTokens(
  refreshToken: string,
  tokenEndpoint: string,
  options?: OAuthFetchOptions,
): Promise<XaiOAuthBundle> {
  const endpoint = await resolveTokenEndpoint(tokenEndpoint, options)
  const token = await postXaiTokenForm(
    endpoint,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: XAI_CLIENT_ID,
    }),
    options,
  )
  const bundle = mapTokenResponse(token)
  return {
    ...bundle,
    refreshToken: bundle.refreshToken ?? refreshToken,
    tokenEndpoint: endpoint,
    redirectUri: XAI_REDIRECT_URI,
  }
}

/**
 * Resolve the token endpoint. If the provided endpoint is empty or the
 * refresh request fails with 404, fall back to OIDC discovery so we
 * always use the current xAI token URL.
 */
async function resolveTokenEndpoint(
  tokenEndpoint: string,
  options?: OAuthFetchOptions,
): Promise<string> {
  const trimmed = tokenEndpoint.trim()
  if (trimmed) {
    return trimmed
  }
  const discovery = await discoverXaiOAuthEndpoints(options)
  return discovery.token_endpoint
}

export function applyXaiOAuthBundle(
  account: OAuthAccount,
  bundle: XaiOAuthBundle,
): void {
  applyOAuthBundle(account, bundle, {
    idToken: bundle.idToken,
    email: bundle.email,
  })
  account.settings = {
    ...account.settings,
    baseUrl: account.settings?.baseUrl ?? XAI_API_BASE_URL,
    tokenEndpoint: bundle.tokenEndpoint,
    redirectUri: bundle.redirectUri,
  }
}

export function getXaiTokenEndpoint(account: OAuthAccount): string | undefined {
  return account.settings?.tokenEndpoint
}
