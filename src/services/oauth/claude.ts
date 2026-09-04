import type { ProviderConnection } from "~/lib/provider-connections"

import { claudeCodeVersion } from "~/services/claude/fingerprint"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import { generateOAuthState, generatePkceCodes, type PkceCodes } from "./pkce"
import { parseExpiresAt } from "./token-resolver"

export const CLAUDE_AUTH_URL = "https://claude.ai/oauth/authorize"
export const CLAUDE_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token"
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const CLAUDE_REDIRECT_URI = "http://localhost:54545/callback"
export const CLAUDE_BOOTSTRAP_URL =
  "https://api.anthropic.com/api/claude_cli/bootstrap"
export const CLAUDE_OAUTH_SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

interface ClaudeTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  account?: { uuid?: string; email_address?: string }
  organization?: { uuid?: string; name?: string }
}

interface ClaudeBootstrapResponse {
  oauth_account?: {
    account_uuid?: string
    account_email?: string
    organization_uuid?: string
    organization_name?: string
  }
}

export interface ClaudeOAuthBundle {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  email?: string
  accountId?: string
  organizationId?: string
  organizationName?: string
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
        // CC omits Accept on OAuth token requests (oh-my-pi postJson line 55).
        "Content-Type": "application/json",
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
    accountId: token.account?.uuid,
    organizationId: token.organization?.uuid,
    organizationName: token.organization?.name,
  }
}

/**
 * Fetches account identity (account_uuid / email / org) from the CC bootstrap
 * endpoint. Called only at login to recover fields the token response doesn't
 * inline - notably `account_uuid`, which feeds `metadata.user_id.account_uuid`
 * in the request fingerprint. Best-effort: failures return an empty identity
 * rather than blocking login (mirrors oh-my-pi `resolveAccountIdentity`).
 *
 * Ported from oh-my-pi registry/oauth/anthropic.ts (141-176).
 */
export async function fetchClaudeBootstrapIdentity(
  accessToken: string,
  options?: OAuthFetchOptions,
): Promise<{
  accountId?: string
  email?: string
  organizationId?: string
  organizationName?: string
}> {
  try {
    const url = `${CLAUDE_BOOTSTRAP_URL}?entrypoint=cli&model=claude-opus-4-8`
    const response = await oauthFetch(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": `claude-code/${claudeCodeVersion}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(30_000),
      },
      options,
    )
    if (!response.ok) return {}
    const data = (await response.json()) as ClaudeBootstrapResponse
    const acct = data.oauth_account
    return {
      accountId: acct?.account_uuid?.trim() || undefined,
      email: acct?.account_email?.trim() || undefined,
      organizationId: acct?.organization_uuid?.trim() || undefined,
      organizationName: acct?.organization_name?.trim() || undefined,
    }
  } catch {
    // Bootstrap is identity enrichment only. Token exchange must still succeed
    // when the optional endpoint is unavailable or times out.
    return {}
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
        // CC sends these on refresh but NOT on the initial code exchange
        // (oh-my-pi registry/oauth/anthropic.ts line 317). The SDK UA (not the
        // claude-cli UA) + the oauth beta are the refresh-path fingerprint.
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "anthropic-sdk-typescript/0.94.0 userOAuthProvider",
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
    accountId: token.account?.uuid,
    organizationId: token.organization?.uuid,
    organizationName: token.organization?.name,
  }
}

export function applyClaudeOAuthBundle(
  connection: ProviderConnection,
  bundle: ClaudeOAuthBundle,
): void {
  applyOAuthBundleToCredential(connection, bundle, {
    email: bundle.email,
    accountId: bundle.accountId,
    organizationId: bundle.organizationId,
    organizationName: bundle.organizationName,
  })
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
