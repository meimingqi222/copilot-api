import { randomUUID } from "node:crypto"
import { hostname } from "node:os"

import type { OAuthAccount } from "~/lib/accounts"

import { applyOAuthBundle } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"

export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
export const KIMI_OAUTH_HOST = "https://auth.kimi.com"
export const KIMI_DEVICE_CODE_URL = `${KIMI_OAUTH_HOST}/api/oauth/device_authorization`
export const KIMI_TOKEN_URL = `${KIMI_OAUTH_HOST}/api/oauth/token`
export const KIMI_API_BASE_URL = "https://api.kimi.com/coding"

const DEFAULT_POLL_INTERVAL_MS = 5000
const MAX_POLL_DURATION_MS = 15 * 60 * 1000

export interface KimiDeviceCodeResponse {
  device_code: string
  user_code?: string
  verification_uri?: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

export interface KimiOAuthBundle {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
  deviceId: string
}

function kimiDeviceHeaders(deviceId: string): Record<string, string> {
  return {
    "X-Msh-Platform": "cli-proxy-api",
    "X-Msh-Version": "1.0.0",
    "X-Msh-Device-Name": hostname() || "unknown",
    "X-Msh-Device-Model": `${process.platform} ${process.arch}`,
    "X-Msh-Device-Id": deviceId,
  }
}

export function createKimiDeviceId(existing?: string): string {
  const trimmed = existing?.trim()
  return trimmed || randomUUID()
}

export async function startKimiDeviceFlow(
  deviceId: string,
  options?: OAuthFetchOptions,
): Promise<KimiDeviceCodeResponse> {
  const response = await oauthFetch(
    KIMI_DEVICE_CODE_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...kimiDeviceHeaders(deviceId),
      },
      body: new URLSearchParams({ client_id: KIMI_CLIENT_ID }).toString(),
    },
    options,
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Kimi device flow start failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }

  return (await response.json()) as KimiDeviceCodeResponse
}

interface KimiTokenExchangeResponse {
  error?: string
  error_description?: string
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

async function exchangeKimiDeviceCode(
  deviceCode: string,
  deviceId: string,
  options?: OAuthFetchOptions,
): Promise<KimiOAuthBundle | null> {
  const response = await oauthFetch(
    KIMI_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...kimiDeviceHeaders(deviceId),
      },
      body: new URLSearchParams({
        client_id: KIMI_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    },
    options,
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Kimi device token exchange failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }

  const body = (await response.json()) as KimiTokenExchangeResponse
  if (body.error) {
    if (body.error === "authorization_pending" || body.error === "slow_down") {
      return null
    }
    throw new Error(
      `Kimi OAuth error: ${body.error}${body.error_description ? ` - ${body.error_description}` : ""}`,
    )
  }

  if (!body.access_token) {
    throw new Error("Kimi token exchange returned empty access_token")
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt:
      body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    scope: body.scope,
    deviceId,
  }
}

export async function pollKimiDeviceAuthorization(
  deviceCode: KimiDeviceCodeResponse,
  deviceId: string,
  options?: OAuthFetchOptions,
): Promise<KimiOAuthBundle> {
  const intervalMs =
    deviceCode.interval === undefined ?
      DEFAULT_POLL_INTERVAL_MS
    : Math.max(deviceCode.interval * 1000, 0)
  const deadline =
    Date.now()
    + Math.min(
      MAX_POLL_DURATION_MS,
      (deviceCode.expires_in ?? MAX_POLL_DURATION_MS / 1000) * 1000,
    )

  while (Date.now() < deadline) {
    if (options?.signal?.aborted) {
      throw new Error("Kimi device authorization cancelled")
    }

    const bundle = await exchangeKimiDeviceCode(
      deviceCode.device_code,
      deviceId,
      options,
    )
    if (bundle) {
      return bundle
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error("Kimi device authorization timed out")
}

export async function refreshKimiTokens(
  refreshToken: string,
  deviceId: string,
  options?: OAuthFetchOptions,
): Promise<KimiOAuthBundle> {
  const response = await oauthFetch(
    KIMI_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...kimiDeviceHeaders(deviceId),
      },
      body: new URLSearchParams({
        client_id: KIMI_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    },
    options,
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Kimi token refresh failed (${response.status}): ${text.slice(0, 200)}`,
    )
  }

  const body = (await response.json()) as KimiTokenExchangeResponse
  if (!body.access_token) {
    throw new Error("Kimi token refresh returned empty access_token")
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
    expiresAt:
      body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    scope: body.scope,
    deviceId,
  }
}

export function applyKimiOAuthBundle(
  account: OAuthAccount,
  bundle: KimiOAuthBundle,
): void {
  applyOAuthBundle(account, bundle, { deviceId: bundle.deviceId })
}

export function stripKimiModelPrefix(model: string): string {
  const trimmed = model.trim()
  if (trimmed.toLowerCase().startsWith("kimi-")) {
    return trimmed.slice(5)
  }
  return trimmed
}
