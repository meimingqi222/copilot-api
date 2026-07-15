import type { OAuthAccount } from "~/lib/accounts"

import { applyOAuthBundle } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import { generateOAuthState } from "./pkce"

export function getAntigravityClientId(): string {
  const fromEnv = process.env.ANTIGRAVITY_CLIENT_ID?.trim()
  if (fromEnv) {
    return fromEnv
  }
  const projectNumber = "1071006060591"
  const clientSuffix = "tmhssin2h21lcre235vtolojh4g403ep"
  return `${projectNumber}-${clientSuffix}.apps.googleusercontent.com`
}

// Base64-encoded Antigravity IDE Google OAuth client secret (same fixed value as CPA).
const ANTIGRAVITY_CLIENT_SECRET_B64 =
  "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY="

export function getAntigravityClientSecret(): string {
  const fromEnv = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim()
  if (fromEnv) {
    return fromEnv
  }
  return Buffer.from(ANTIGRAVITY_CLIENT_SECRET_B64, "base64").toString("utf8")
}
export const ANTIGRAVITY_CALLBACK_PORT = 51121
export const ANTIGRAVITY_CALLBACK_PATH = "/oauth-callback"
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}${ANTIGRAVITY_CALLBACK_PATH}`
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const ANTIGRAVITY_AUTH_URL =
  "https://accounts.google.com/o/oauth2/v2/auth"
export const ANTIGRAVITY_USERINFO_URL =
  "https://www.googleapis.com/oauth2/v2/userinfo?alt=json"
export const ANTIGRAVITY_API_BASE_URL = "https://cloudcode-pa.googleapis.com"
export const ANTIGRAVITY_DAILY_API_BASE_URL =
  "https://daily-cloudcode-pa.googleapis.com"
export const ANTIGRAVITY_API_VERSION = "v1internal"

export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const

interface AntigravityTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
}

export interface AntigravityOAuthBundle {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  email?: string
  projectId?: string
  redirectUri: string
}

export function buildAntigravityAuthUrl(
  state: string,
  redirectUri = ANTIGRAVITY_REDIRECT_URI,
): string {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: getAntigravityClientId(),
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ANTIGRAVITY_SCOPES.join(" "),
    state,
  })
  return `${ANTIGRAVITY_AUTH_URL}?${params.toString()}`
}

export function createAntigravityOAuthStart(
  redirectUri = ANTIGRAVITY_REDIRECT_URI,
): {
  state: string
  authUrl: string
  redirectUri: string
} {
  const state = generateOAuthState()
  return {
    state,
    authUrl: buildAntigravityAuthUrl(state, redirectUri),
    redirectUri,
  }
}

function mapTokenResponse(
  token: AntigravityTokenResponse,
): Omit<AntigravityOAuthBundle, "email" | "projectId" | "redirectUri"> {
  if (!token.access_token) {
    throw new Error("Antigravity token response missing access_token")
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt:
      token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
  }
}

async function postAntigravityTokenForm(
  form: URLSearchParams,
  options?: OAuthFetchOptions,
): Promise<AntigravityTokenResponse> {
  const response = await oauthFetch(
    ANTIGRAVITY_TOKEN_URL,
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
      `Antigravity token request failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }
  return (await response.json()) as AntigravityTokenResponse
}

export async function exchangeAntigravityCodeForTokens(
  code: string,
  redirectUri: string,
  options?: OAuthFetchOptions,
): Promise<AntigravityOAuthBundle> {
  const token = await postAntigravityTokenForm(
    new URLSearchParams({
      code,
      client_id: getAntigravityClientId(),
      client_secret: getAntigravityClientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    options,
  )
  const bundle = mapTokenResponse(token)
  const email = await fetchAntigravityUserEmail(bundle.accessToken, options)
  const projectId = await fetchAntigravityProjectId(bundle.accessToken, options)
  return {
    ...bundle,
    email,
    projectId,
    redirectUri,
  }
}

export async function refreshAntigravityTokens(
  refreshToken: string,
  options?: OAuthFetchOptions,
): Promise<Omit<AntigravityOAuthBundle, "redirectUri">> {
  const token = await postAntigravityTokenForm(
    new URLSearchParams({
      client_id: getAntigravityClientId(),
      client_secret: getAntigravityClientSecret(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    options,
  )
  const bundle = mapTokenResponse(token)
  return {
    ...bundle,
    refreshToken: bundle.refreshToken ?? refreshToken,
  }
}

export async function fetchAntigravityUserEmail(
  accessToken: string,
  options?: OAuthFetchOptions,
): Promise<string | undefined> {
  const response = await oauthFetch(
    ANTIGRAVITY_USERINFO_URL,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
    options,
  )
  if (!response.ok) {
    return undefined
  }
  const payload = (await response.json()) as { email?: string }
  return typeof payload.email === "string" && payload.email.trim() ?
      payload.email.trim()
    : undefined
}

function extractProjectId(data: Record<string, unknown>): string | undefined {
  for (const key of [
    "cloudaicompanionProject",
    "projectId",
    "project",
  ] as const) {
    const value = data[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>).id
      if (typeof id === "string" && id.trim()) {
        return id.trim()
      }
    }
  }
  return undefined
}

function defaultAntigravityTierId(loadResp: Record<string, unknown>): string {
  const tiers = loadResp.allowedTiers
  if (Array.isArray(tiers)) {
    for (const rawTier of tiers) {
      if (!rawTier || typeof rawTier !== "object" || Array.isArray(rawTier)) {
        continue
      }
      const tier = rawTier as Record<string, unknown>
      if (tier.isDefault !== true) {
        continue
      }
      if (typeof tier.id === "string" && tier.id.trim()) {
        return tier.id.trim()
      }
    }
  }
  const currentTier = loadResp.currentTier
  if (
    currentTier
    && typeof currentTier === "object"
    && !Array.isArray(currentTier)
  ) {
    const id = (currentTier as Record<string, unknown>).id
    if (typeof id === "string" && id.trim()) {
      return id.trim()
    }
  }
  return "free-tier"
}

async function onboardAntigravityUser(
  accessToken: string,
  tierId: string,
  options?: OAuthFetchOptions,
): Promise<string | undefined> {
  const userAgent = buildAntigravityUserAgent()
  const body = JSON.stringify({
    tier_id: tierId,
    metadata: {
      ide_type: "ANTIGRAVITY",
      ide_version: "1.0.8",
      ide_name: "antigravity",
    },
  })

  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await oauthFetch(
      `${ANTIGRAVITY_DAILY_API_BASE_URL}/${ANTIGRAVITY_API_VERSION}:onboardUser`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "*/*",
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
        body,
      },
      options,
    )
    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `Antigravity onboardUser failed (${response.status}): ${text.slice(0, 200)}`,
      )
    }
    const payload = JSON.parse(text) as Record<string, unknown>
    if (payload.done === true) {
      const responseData = payload.response
      if (
        responseData
        && typeof responseData === "object"
        && !Array.isArray(responseData)
      ) {
        return extractProjectId(responseData as Record<string, unknown>)
      }
      return undefined
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error("Antigravity onboardUser did not complete")
}

export async function fetchAntigravityProjectId(
  accessToken: string,
  options?: OAuthFetchOptions,
): Promise<string | undefined> {
  const userAgent = buildAntigravityUserAgent()
  const response = await oauthFetch(
    `${ANTIGRAVITY_API_BASE_URL}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
        "Content-Type": "application/json",
        "User-Agent": userAgent,
      },
      body: JSON.stringify({
        metadata: { ideType: "ANTIGRAVITY" },
      }),
    },
    options,
  )
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `Antigravity loadCodeAssist failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }
  const payload = JSON.parse(text) as Record<string, unknown>
  const projectId = extractProjectId(payload)
  if (projectId) {
    return projectId
  }
  return onboardAntigravityUser(
    accessToken,
    defaultAntigravityTierId(payload),
    options,
  )
}

export function buildAntigravityUserAgent(version = "1.0.8"): string {
  return `antigravity/cli/${version} darwin/arm64`
}

export function applyAntigravityOAuthBundle(
  account: OAuthAccount,
  bundle: AntigravityOAuthBundle,
): void {
  applyOAuthBundle(account, bundle, {
    projectId: bundle.projectId,
    email: bundle.email,
  })
  account.settings = {
    ...account.settings,
    baseUrl: account.settings?.baseUrl ?? ANTIGRAVITY_API_BASE_URL,
    redirectUri: bundle.redirectUri,
  }
}
