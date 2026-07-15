import type { OAuthAccount } from "~/lib/accounts"

import { applyOAuthBundle } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import {
  extractCodexAccountIdFromIdToken,
  extractEmailFromIdToken,
} from "./jwt"
import { generateOAuthState, generatePkceCodes, type PkceCodes } from "./pkce"

export const CODEX_AUTH_URL = "https://auth.openai.com/oauth/authorize"
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback"
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"

interface CodexTokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

export interface CodexOAuthBundle {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresAt?: number
  accountId?: string
  email?: string
}

export function buildCodexAuthUrl(state: string, pkce: PkceCodes): string {
  const params = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    response_type: "code",
    redirect_uri: CODEX_REDIRECT_URI,
    scope: "openid email profile offline_access",
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  })
  return `${CODEX_AUTH_URL}?${params.toString()}`
}

export function createCodexOAuthStart(pkce = generatePkceCodes()): {
  state: string
  pkce: PkceCodes
  authUrl: string
} {
  const state = generateOAuthState()
  return {
    state,
    pkce,
    authUrl: buildCodexAuthUrl(state, pkce),
  }
}

function mapTokenResponse(token: CodexTokenResponse): CodexOAuthBundle {
  if (!token.access_token) {
    throw new Error("Codex token response missing access_token")
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    idToken: token.id_token,
    expiresAt:
      token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    accountId: extractCodexAccountIdFromIdToken(token.id_token),
    email: extractEmailFromIdToken(token.id_token),
  }
}

export async function exchangeCodexCodeForTokens(
  code: string,
  pkce: PkceCodes,
  options?: OAuthFetchOptions,
): Promise<CodexOAuthBundle> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CODEX_CLIENT_ID,
    code,
    redirect_uri: CODEX_REDIRECT_URI,
    code_verifier: pkce.codeVerifier,
  })

  const response = await oauthFetch(
    CODEX_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    },
    options,
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Codex token exchange failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }

  return mapTokenResponse((await response.json()) as CodexTokenResponse)
}

export async function refreshCodexTokens(
  refreshToken: string,
  options?: OAuthFetchOptions,
): Promise<CodexOAuthBundle> {
  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "openid profile email",
  })

  const response = await oauthFetch(
    CODEX_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    },
    options,
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Codex token refresh failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }

  const bundle = mapTokenResponse((await response.json()) as CodexTokenResponse)
  return {
    ...bundle,
    refreshToken: bundle.refreshToken ?? refreshToken,
  }
}

export function applyCodexOAuthBundle(
  account: OAuthAccount,
  bundle: CodexOAuthBundle,
): void {
  applyOAuthBundle(account, bundle, {
    idToken: bundle.idToken,
    accountId: bundle.accountId,
    email: bundle.email,
  })
  account.settings = {
    ...account.settings,
    baseUrl: account.settings?.baseUrl ?? CODEX_API_BASE_URL,
  }
}
