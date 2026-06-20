import type { OAuthAccount } from "~/lib/accounts"

import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import { generateOAuthState, generatePkceCodes, type PkceCodes } from "./pkce"
import { parseExpiresAt } from "./token-resolver"

export const CLAUDE_AUTH_URL = "https://claude.ai/oauth/authorize"
export const CLAUDE_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token"
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const CLAUDE_REDIRECT_URI = "http://localhost:54545/callback"
export const CLAUDE_OAUTH_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

interface ClaudeTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  account?: { email_address?: string }
}

export interface ClaudeOAuthBundle {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  email?: string
}

export { generateOAuthState } from "./pkce"

export function buildClaudeAuthUrl(state: string, pkce: PkceCodes): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_CLIENT_ID,
    response_type: "code",
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: CLAUDE_OAUTH_SCOPE,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    state,
  })
  return `${CLAUDE_AUTH_URL}?${params.toString()}`
}

function parseCodeAndState(code: string): { code: string; state?: string } {
  const [parsedCode, parsedState] = code.split("#")
  return {
    code: parsedCode,
    state: parsedState || undefined,
  }
}

export async function exchangeClaudeCodeForTokens(
  code: string,
  state: string,
  pkce: PkceCodes,
  options?: OAuthFetchOptions,
): Promise<ClaudeOAuthBundle> {
  const parsed = parseCodeAndState(code)
  const body: Record<string, string> = {
    code: parsed.code,
    state,
    grant_type: "authorization_code",
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: CLAUDE_REDIRECT_URI,
    code_verifier: pkce.codeVerifier,
  }
  if (parsed.state) {
    body.state = parsed.state
  }

  const response = await oauthFetch(
    CLAUDE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    },
    options,
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Claude token exchange failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }

  const token = (await response.json()) as ClaudeTokenResponse
  if (!token.access_token) {
    throw new Error("Claude token exchange returned empty access_token")
  }

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt:
      token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    email: token.account?.email_address,
  }
}

export async function refreshClaudeTokens(
  refreshToken: string,
  options?: OAuthFetchOptions,
): Promise<ClaudeOAuthBundle> {
  const response = await oauthFetch(
    CLAUDE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: CLAUDE_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
    options,
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Claude token refresh failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }

  const token = (await response.json()) as ClaudeTokenResponse
  if (!token.access_token) {
    throw new Error("Claude token refresh returned empty access_token")
  }

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? refreshToken,
    expiresAt:
      token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    email: token.account?.email_address,
  }
}

export function applyClaudeOAuthBundle(
  account: OAuthAccount,
  bundle: ClaudeOAuthBundle,
): void {
  account.credentials = {
    ...account.credentials,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken ?? account.credentials?.refreshToken,
    expiresAt: bundle.expiresAt ?? account.credentials?.expiresAt,
    email: bundle.email ?? account.credentials?.email,
  }
  account.runtimeState = {
    ...account.runtimeState,
    authStatus: "ready",
    lastRefreshAt: Date.now(),
    lastError: undefined,
  }
}

export function createClaudeOAuthStart(pkce = generatePkceCodes()): {
  state: string
  pkce: PkceCodes
  authUrl: string
} {
  const state = generateOAuthState()
  return {
    state,
    pkce,
    authUrl: buildClaudeAuthUrl(state, pkce),
  }
}

export function expiresAtFromClaudeExpired(value: unknown): number | undefined {
  return parseExpiresAt(value)
}
