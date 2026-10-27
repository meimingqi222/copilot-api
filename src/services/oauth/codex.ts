import type { ProviderConnection } from "~/lib/provider-connections"

import {
  applyOAuthBundleToCredential,
  applyOAuthConnectionSettings,
} from "./apply-bundle"
import type { OAuthFetchOptions } from "./fetch"
import {
  extractCodexAccountIdFromIdToken,
  extractCodexPlanTypeFromIdToken,
  extractEmailFromIdToken,
} from "./jwt"
import { generateOAuthState, generatePkceCodes, type PkceCodes } from "./pkce"
import {
  oauthTokenBundle,
  postOAuthTokenForm,
  readSettingString,
} from "./token-response"

const CODEX_AUTH_URL = "https://auth.openai.com/oauth/authorize"
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback"
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"

const CODEX_REFRESH_TIMEOUT_MS = 30_000

interface CodexTokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

interface CodexOAuthBundle {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresAt?: number
  accountId?: string
  email?: string
  /** ChatGPT plan type from the id token (free/plus/team/…), lowercase. */
  planType?: string
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
  return oauthTokenBundle(
    token,
    "Codex token response missing access_token",
    (payload) => ({
      idToken: payload.id_token,
      accountId: extractCodexAccountIdFromIdToken(payload.id_token),
      email: extractEmailFromIdToken(payload.id_token),
      planType: extractCodexPlanTypeFromIdToken(payload.id_token),
    }),
  )
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

  return mapTokenResponse(
    await postOAuthTokenForm<CodexTokenResponse>({
      url: CODEX_TOKEN_URL,
      form: body,
      options,
      errorMessage: (status, text) =>
        `Codex token exchange failed (${status}): ${text.slice(0, 200)}`,
    }),
  )
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

  const bundle = mapTokenResponse(
    await postOAuthTokenForm<CodexTokenResponse>({
      url: CODEX_TOKEN_URL,
      form: body,
      options: {
        ...options,
        // Refresh must outlive the downstream request that triggered it, but it
        // must not hang forever. This matches CPA's independent 30s refresh ctx.
        signal: AbortSignal.timeout(CODEX_REFRESH_TIMEOUT_MS),
      },
      errorMessage: (status, text) =>
        // 不要截太狠：上游把错误码放在 JSON 尾部（如
        // `"code":"refresh_token_invalidated"`），截断会让终态判定漏判成瞬态错误。
        `Codex token refresh failed (${status}): ${text.slice(0, 1000)}`,
    }),
  )
  return {
    ...bundle,
    refreshToken: bundle.refreshToken ?? refreshToken,
  }
}

export function applyCodexOAuthBundle(
  connection: ProviderConnection,
  bundle: CodexOAuthBundle,
): void {
  applyOAuthBundleToCredential(connection, bundle, {
    idToken: bundle.idToken,
    accountId: bundle.accountId,
    email: bundle.email,
    planType: bundle.planType,
  })
  applyOAuthConnectionSettings(connection, {
    baseUrl: readSettingString(connection, "baseUrl") ?? CODEX_API_BASE_URL,
  })
}
