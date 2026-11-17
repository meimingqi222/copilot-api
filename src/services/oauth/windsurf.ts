import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderConnection } from "~/lib/provider-connections"
import { setConnectionSetting } from "~/lib/provider-connections"

import {
  DEVIN_CLI_IDENTITY,
  normalizeDevinApiKey,
} from "~/services/windsurf/metadata"

import { applyOAuthBundleToCredential } from "~/services/oauth/apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"
import {
  generateOAuthState,
  generatePkceCodes,
  type PkceCodes,
} from "~/services/oauth/pkce"

const WINDSURF_APP_BASE_URL = "https://app.devin.ai"
const WINDSURF_API_BASE_URL = "https://api.devin.ai"
const WINDSURF_SERVER = "https://server.codeium.com"
const WINDSURF_TOKEN_PATH =
  "/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode"

/**
 * Loopback callback the Devin CLI itself listens on (oh-my-pi
 * `packages/catalog/src/compat/rules/auth/devin.kdl`), which is also the only
 * redirect shape Devin's authorization page accepts: `http` scheme,
 * `127.0.0.1` host, `/callback` path.
 */
export const WINDSURF_CALLBACK_PORT = 59653
export const WINDSURF_CALLBACK_PATH = "/callback"
export const WINDSURF_REDIRECT_URI = `http://127.0.0.1:${WINDSURF_CALLBACK_PORT}${WINDSURF_CALLBACK_PATH}`

const WINDSURF_SESSION_TOKEN_PREFIX = "devin-session-token$"

interface WindsurfOAuthBundle {
  /** Formatted session token (`devin-session-token$...`), stored as credential value. */
  sessionToken: string
  userName?: string
  userId?: string
  orgId?: string
  email?: string
  baseUrl?: string
  devinWebappHost?: string
  devinApiUrl?: string
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
  if (trimmed.startsWith("cog_")) return true
  if (trimmed.startsWith(WINDSURF_SESSION_TOKEN_PREFIX)) return true
  // Bare JWTs are JWT-shaped (`eyJ` + dot-separated segments). A plain
  // `eyJ` prefix alone is not enough: an opaque authorization code could
  // coincidentally share it, and misclassifying it would store a broken
  // credential without ever attempting the code exchange.
  return trimmed.startsWith("eyJ") && trimmed.includes(".")
}

/**
 * Build the PKCE authorization URL, mirroring CPA
 * `DevinAuthService.BuildAuthorizationURL`: `redirect_uri` and `state` first,
 * then the exact ordering `prompt, code_challenge, code_challenge_method`, and
 * `cli_pkce_marker=1` only when no redirect URI is supplied (the headless
 * variant that prints the code on the page instead of redirecting).
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

export function createWindsurfOAuthStart(
  redirectUri: string = WINDSURF_REDIRECT_URI,
): {
  authUrl: string
  state: string
  pkce: PkceCodes
  redirectUri: string
} {
  const pkce = generatePkceCodes()
  const state = generateOAuthState()
  return {
    authUrl: buildWindsurfAuthUrl(pkce.codeChallenge, state, redirectUri),
    state,
    pkce,
    redirectUri,
  }
}

interface WindsurfTokenResponse {
  sessionToken?: string
  session_token?: string
  devinWebappHost?: string
  devinApiUrl?: string
}

export async function exchangeWindsurfCodeForToken(
  code: string,
  codeVerifier: string,
  options?: OAuthFetchOptions,
  redirectUri: string = WINDSURF_REDIRECT_URI,
): Promise<WindsurfOAuthBundle> {
  const response = await oauthFetch(
    `${WINDSURF_SERVER}${WINDSURF_TOKEN_PATH}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        code: code.trim(),
        code_verifier: codeVerifier.trim(),
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(30_000),
    },
    options,
  )
  const text = await response.text().catch(() => "")
  if (!response.ok) {
    throw new Error(
      `Windsurf OAuth token exchange failed with status ${response.status}: ${text.slice(0, 500)}`,
    )
  }
  let result: WindsurfTokenResponse
  try {
    result = JSON.parse(text) as WindsurfTokenResponse
  } catch {
    result = {}
  }
  const rawToken = result?.sessionToken || result?.session_token
  const token = typeof rawToken === "string" ? rawToken.trim() : ""
  if (!token) {
    throw new Error("Windsurf OAuth token exchange did not return a token")
  }
  return {
    sessionToken: formatWindsurfSessionToken(token),
    devinWebappHost:
      typeof result.devinWebappHost === "string" ?
        result.devinWebappHost
      : undefined,
    devinApiUrl:
      typeof result.devinApiUrl === "string" ? result.devinApiUrl : undefined,
  }
}

interface WindsurfSelfResponse {
  name?: string
  userId?: string
  teamId?: string
  teamName?: string
  email?: string
  planStatus?: {
    planInfo?: {
      teamName?: string
      devinInfo?: { orgId?: string; accountDisplayName?: string }
    }
  }
}

/**
 * Ask Devin for the key's own identity, never the CLI's current account.
 * Transient failures get a stable private fingerprint; rejected keys fail.
 */
export async function fetchWindsurfSelfProfile(
  sessionToken: string,
  options?: OAuthFetchOptions,
  baseUrl: string = WINDSURF_SERVER,
): Promise<
  Pick<WindsurfOAuthBundle, "userName" | "userId" | "orgId" | "email">
> {
  const fallback = {
    userName: `Devin · ${createHash("sha256").update(baseUrl.replace(/\/+$/, "")).update("\0").update(sessionToken).digest("hex").slice(0, 12)}`,
  }
  try {
    const response = await oauthFetch(
      `${baseUrl.replace(/\/+$/, "")}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          Accept: "application/json",
        },
        body: JSON.stringify({
          metadata: {
            ideName: "devin-cli",
            ideVersion: DEVIN_CLI_IDENTITY.ideVersion,
            extensionName: "devin-cli",
            extensionVersion: DEVIN_CLI_IDENTITY.extensionVersion,
            apiKey: normalizeDevinApiKey(sessionToken),
            locale: "en",
            os: DEVIN_CLI_IDENTITY.os,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
      options,
    )
    if (response.status === 401) throw new WindsurfRejectedCredential()
    const text = await response.text()
    if (
      !response.ok
      && /unauthenticated|invalid api key|invalid token/i.test(text)
    )
      throw new WindsurfRejectedCredential()
    // Enterprise seats can deny the CLI identity while allowing the editor;
    // permission alone must not reject an otherwise usable credential.
    if (!response.ok) return fallback
    const result = JSON.parse(text) as {
      userStatus?: WindsurfSelfResponse
    } | null
    const body = result?.userStatus
    if (!body || typeof body !== "object") return fallback
    const info = body.planStatus?.planInfo
    const orgId = info?.devinInfo?.orgId || body.teamId
    const rawOrgName =
      info?.devinInfo?.accountDisplayName || info?.teamName || body.teamName
    const orgName = typeof rawOrgName === "string" ? rawOrgName.trim() : ""
    const rawName = body.email || body.name
    const name = typeof rawName === "string" ? rawName.trim() : ""
    return {
      userName:
        name ?
          `${name}${orgName && orgName.toLowerCase() !== name.toLowerCase() ? ` · ${orgName}` : ""}`
        : fallback.userName,
      ...(typeof body.userId === "string" && body.userId ?
        { userId: body.userId }
      : {}),
      ...(typeof orgId === "string" && orgId ? { orgId } : {}),
      ...(typeof body.email === "string" && body.email ?
        { email: body.email }
      : {}),
    }
  } catch (error) {
    if (error instanceof WindsurfRejectedCredential) throw error
    return fallback
  }
}

class WindsurfRejectedCredential extends Error {
  constructor() {
    super("Devin rejected the credential")
  }
}

/** Read the server's CLI sign-in only; no caller-supplied paths or CLI execution. */
export async function readWindsurfCliCredentials(): Promise<WindsurfOAuthBundle> {
  const data =
    process.platform === "win32" && process.env.APPDATA ?
      process.env.APPDATA
    : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const parsed: unknown = Bun.TOML.parse(
    await readFile(join(data, "devin", "credentials.toml"), "utf8"),
  )
  const values = parsed as Record<string, unknown>
  const key = values.windsurf_api_key
  if (typeof key !== "string" || !key.trim())
    throw new Error("Devin CLI credentials contain no windsurf_api_key")
  return {
    sessionToken: formatWindsurfSessionToken(key),
    baseUrl:
      typeof values.api_server_url === "string" ?
        values.api_server_url
      : WINDSURF_SERVER,
    devinWebappHost:
      typeof values.devin_webapp_host === "string" ?
        values.devin_webapp_host
      : undefined,
    devinApiUrl:
      typeof values.devin_api_url === "string" ?
        values.devin_api_url
      : WINDSURF_API_BASE_URL,
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
  if (bundle.baseUrl)
    setConnectionSetting(connection, "baseUrl", bundle.baseUrl)
  if (bundle.devinWebappHost)
    setConnectionSetting(connection, "devinWebappHost", bundle.devinWebappHost)
  if (bundle.devinApiUrl)
    setConnectionSetting(connection, "devinApiUrl", bundle.devinApiUrl)
  if (bundle.userName) connection.name = bundle.userName
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
