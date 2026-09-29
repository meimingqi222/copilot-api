import { randomUUID } from "node:crypto"

import type { ProviderConnection } from "~/lib/provider-connections"

import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import { extractJwtExpiryMs } from "./jwt"

export const LOBSTERAI_CALLBACK_PORT = 18239
export const LOBSTERAI_CALLBACK_PATH = "/auth/callback"
export const LOBSTERAI_REDIRECT_URI = `http://127.0.0.1:${LOBSTERAI_CALLBACK_PORT}${LOBSTERAI_CALLBACK_PATH}`
const LOGIN_URL = "https://lobsterai.youdao.com/portal#/login"
const SERVER_URL = "https://lobsterai-server.youdao.com"
const CLIENT_VERSION_HEADER = "X-LobsterAI-Client-Version"
const LOGIN_URL_DISCOVERY =
  "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/login-url"
const AUTH_VERSION = "1.0.0"

export function lobsteraiCallbackStateMatches(
  callbackInput: string,
  expectedState: string,
): boolean {
  try {
    return new URL(callbackInput).searchParams.get("state") === expectedState
  } catch {
    return (
      new URLSearchParams(callbackInput.replace(/^\?/, "")).get("state")
      === expectedState
    )
  }
}

interface LobsteraiTokenResponse {
  code?: number
  message?: string
  data?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    expiresIn?: number
    userId?: string | number
  }
}

export async function createLobsteraiOAuthStart(
  options?: OAuthFetchOptions,
): Promise<{ authUrl: string; state: string; installationUuid: string }> {
  const state = randomUUID()
  const installationUuid = randomUUID()
  let loginUrl = LOGIN_URL
  try {
    const response = await oauthFetch(
      LOGIN_URL_DISCOVERY,
      { headers: { Accept: "application/json" } },
      options,
    )
    if (response.ok) {
      const body = (await response.json()) as { data?: { value?: unknown } }
      if (typeof body.data?.value === "string" && body.data.value.trim()) {
        loginUrl = body.data.value.trim()
      }
    }
  } catch {
    // The portal URL is a stable fallback when Overmind is unavailable.
  }
  const url = new URL(loginUrl)
  const [route, query = ""] = url.hash.slice(1).split("?", 2)
  const params = new URLSearchParams(query)
  params.set("source", "electron")
  params.set("redirect_uri", LOBSTERAI_REDIRECT_URI)
  params.set("state", state)
  url.hash = `${route || "/login"}?${params.toString()}`
  return { authUrl: url.toString(), state, installationUuid }
}

export async function exchangeLobsteraiCode(
  code: string,
  installationUuid: string,
  options?: OAuthFetchOptions,
): Promise<LobsteraiTokenResponse["data"]> {
  const response = await oauthFetch(
    `${SERVER_URL}/api/auth/exchange`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        authCode: code,
        firstKeyfrom: "official",
        latestKeyfrom: "official",
        uuid: installationUuid,
        version: AUTH_VERSION,
      }),
    },
    options,
  )
  if (!response.ok) {
    throw new Error(`LobsterAI code exchange failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as LobsteraiTokenResponse
  if (body.code !== 0 || !body.data?.accessToken) {
    throw new Error(
      `LobsterAI code exchange failed: ${body.message ?? `code=${body.code}`}`,
    )
  }
  return body.data
}

export function applyLobsteraiOAuthTokens(
  connection: ProviderConnection,
  tokens: NonNullable<LobsteraiTokenResponse["data"]>,
  installationUuid: string,
): void {
  const credential = connection.credentials[0]
  if (!credential || !tokens.accessToken) {
    throw new Error("LobsterAI exchange returned no access token")
  }
  credential.value = tokens.accessToken
  credential.authMode = "bearer"
  credential.refresherType = "lobsterai-token"
  credential.context = {
    ...credential.context,
    refreshToken: tokens.refreshToken,
    expiresAt:
      tokens.expiresAt
      ?? (tokens.expiresIn ?
        Date.now() + tokens.expiresIn * 1000
      : extractJwtExpiryMs(tokens.accessToken)),
    uuid: installationUuid,
    firstKeyfrom: "official",
    latestKeyfrom: "official",
    ...(tokens.userId ? { userId: String(tokens.userId) } : {}),
  }
  connection.baseUrl = SERVER_URL
  connection.headers = {
    ...connection.headers,
    [CLIENT_VERSION_HEADER]: AUTH_VERSION,
  }
}
