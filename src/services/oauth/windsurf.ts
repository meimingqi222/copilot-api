import type { ProviderConnection } from "~/lib/provider-connections"

import { normalizeDevinApiKey } from "~/services/windsurf/metadata"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import { generateOAuthState, generatePkceCodes, type PkceCodes } from "./pkce"

export const WINDSURF_APP_BASE_URL = "https://app.devin.ai"
export const WINDSURF_API_BASE_URL = "https://api.devin.ai"
const WINDSURF_TOKEN_PATH = "/auth/cli/token"
const WINDSURF_SELF_PATH = "/v3/self"

const WINDSURF_SESSION_TOKEN_PREFIX = "devin-session-token$"

export interface WindsurfOAuthBundle {
  /** Formatted session token (`devin-session-token$...`), stored as credential value. */
  sessionToken: string
  userName?: string
  userId?: string
  orgId?: string
  email?: string
}

export function formatWindsurfSessionToken(rawToken: string): string {
  const trimmed = rawToken.trim()
  if (trimmed.startsWith(WINDSURF_SESSION_TOKEN_PREFIX)) return trimmed
  if (trimmed.startsWith("eyJ"))
    return `${WINDSURF_SESSION_TOKEN_PREFIX}${trimmed}`
  return trimmed
}

export function isWindsurfSessionToken(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.startsWith(WINDSURF_SESSION_TOKEN_PREFIX)) return true
  // Bare JWTs are JWT-shaped (`eyJ` + dot-separated segments). A plain
  // `eyJ` prefix alone is not enough: an opaque authorization code could
  // coincidentally share it, and misclassifying it would store a broken
  // credential without ever attempting the code exchange.
  return trimmed.startsWith("eyJ") && trimmed.includes(".")
}

/**
 * Build the PKCE authorization URL, mirroring CPA
 * `DevinAuthService.BuildAuthorizationURL` (headless manual mode):
 * exact query ordering `prompt, code_challenge, code_challenge_method`,
 * plus `cli_pkce_marker=1` when no redirect URI is used.
 */
export function buildWindsurfAuthUrl(
  codeChallenge: string,
  state: string,
  redirectUri?: string,
): string {
  const trimmedRedirect = redirectUri?.trim() ?? ""
  const parts: Array<string> = []
  if (trimmedRedirect) {
    parts.push(`redirect_uri=${encodeURIComponent(trimmedRedirect)}`)
  }
  if (state) {
    parts.push(`state=${encodeURIComponent(state)}`)
  }
  parts.push(
    "prompt=select_account",
    `code_challenge=${encodeURIComponent(codeChallenge)}`,
    "code_challenge_method=S256",
  )
  if (!trimmedRedirect) {
    parts.push("cli_pkce_marker=1")
  }
  const base = WINDSURF_APP_BASE_URL.replace(/\/+$/, "")
  return `${base}/auth/cli/continue?${parts.join("&")}`
}

export function createWindsurfOAuthStart(): {
  authUrl: string
  state: string
  pkce: PkceCodes
} {
  const pkce = generatePkceCodes()
  const state = generateOAuthState()
  return {
    authUrl: buildWindsurfAuthUrl(pkce.codeChallenge, state),
    state,
    pkce,
  }
}

interface WindsurfTokenResponse {
  token?: string
}

export async function exchangeWindsurfCodeForToken(
  code: string,
  codeVerifier: string,
  options?: OAuthFetchOptions,
): Promise<string> {
  const response = await oauthFetch(
    `${WINDSURF_API_BASE_URL}${WINDSURF_TOKEN_PATH}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        code: code.trim(),
        code_verifier: codeVerifier.trim(),
      }),
    },
    options,
  )
  const text = await response.text().catch(() => "")
  if (!response.ok) {
    throw new Error(
      `Windsurf OAuth token exchange failed with status ${response.status}: ${text.slice(0, 500)}`,
    )
  }
  let token: string
  try {
    token = (JSON.parse(text) as WindsurfTokenResponse).token?.trim() ?? ""
  } catch {
    token = ""
  }
  if (!token) {
    throw new Error("Windsurf OAuth token exchange did not return a token")
  }
  return token
}

interface WindsurfSelfResponse {
  user_name?: string
  user_id?: string
  org_id?: string
  email?: string
}

/**
 * Best-effort profile fetch for account labeling. Never throws: login must
 * succeed even when the profile endpoint is unreachable.
 *
 * Sends the formatted session token verbatim (CPA `CreateAuthRecord` passes
 * the `devin-session-token$`-prefixed token to `FetchSelfProfile`, which
 * forwards it as the Bearer value unchanged).
 */
export async function fetchWindsurfSelfProfile(
  sessionToken: string,
  options?: OAuthFetchOptions,
): Promise<
  Pick<WindsurfOAuthBundle, "userName" | "userId" | "orgId" | "email">
> {
  try {
    const response = await oauthFetch(
      `${WINDSURF_API_BASE_URL}${WINDSURF_SELF_PATH}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${sessionToken.trim()}`,
          Accept: "application/json",
        },
      },
      options,
    )
    if (!response.ok) return {}
    const body = (await response
      .json()
      .catch(() => null)) as WindsurfSelfResponse | null
    if (!body || typeof body !== "object") return {}
    return {
      ...(typeof body.user_name === "string" && body.user_name ?
        { userName: body.user_name }
      : {}),
      ...(typeof body.user_id === "string" && body.user_id ?
        { userId: body.user_id }
      : {}),
      ...(typeof body.org_id === "string" && body.org_id ?
        { orgId: body.org_id }
      : {}),
      ...(typeof body.email === "string" && body.email ?
        { email: body.email }
      : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Apply an OAuth session token to a windsurf-native connection.
 * Same credential shape as token-paste creation (`credential.value` =
 * `devin-session-token$...`), so OAuth and manual accounts fail over
 * together.
 */
export function applyWindsurfOAuthBundle(
  connection: ProviderConnection,
  bundle: WindsurfOAuthBundle,
): void {
  applyOAuthBundleToCredential(
    connection,
    { accessToken: bundle.sessionToken },
    {
      apiKey: normalizeDevinApiKey(bundle.sessionToken),
      accountId: bundle.userId,
      email: bundle.email,
      organizationId: bundle.orgId,
    },
  )
}
