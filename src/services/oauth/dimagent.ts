/**
 * DimAgent (dimagent.cn) OAuth：授权码 + PKCE（固定 public client，固定
 * localhost:54321 回调）。
 *
 *   授权页  {base}/oauth/authorize?response_type=code&client_id=…
 *           &redirect_uri=http://localhost:54321/auth/callback&scope=…
 *           &code_challenge=…&code_challenge_method=S256&state=…&source=app
 *   换 token POST {base}/oauth/token  form: authorization_code
 *   刷新     POST {base}/oauth/token  form: refresh_token（上游会轮换）
 *
 * API（OpenAI 兼容）：chat `/v1/chat/completions`，模型 `/v1/models?type=dim`，
 * 用量 `/api/me/usage`。鉴权 `Authorization: Bearer <accessToken>`。
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import { generatePkceCodes, type PkceCodes } from "./pkce"

export const DIMAGENT_BASE = "https://dimagent.cn"
export const DIMAGENT_CLIENT_ID = "f025fda6d5014fd2b6d4aba45cd8b2b6"
export const DIMAGENT_REDIRECT_URI = "http://localhost:54321/auth/callback"
export const DIMAGENT_CALLBACK_PORT = 54321
export const DIMAGENT_CALLBACK_PATH = "/auth/callback"
export const DIMAGENT_SCOPE = "openid profile email market.read remote:delegate"
export const DIMAGENT_REFERER = "https://dimagent.com/"
export const DIMAGENT_DESKTOP_UA = "DimAgent-Desktop"
export const DIMAGENT_CHAT_UA = "DimAgent/0.9.21"

const DEFAULT_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function newDimagentPkce(): PkceCodes {
  return generatePkceCodes()
}

/** 授权页 URL。 */
export function buildDimagentAuthUrl(state: string, pkce: PkceCodes): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: DIMAGENT_CLIENT_ID,
    redirect_uri: DIMAGENT_REDIRECT_URI,
    scope: DIMAGENT_SCOPE,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    state,
    source: "app",
  })
  return `${DIMAGENT_BASE}/oauth/authorize?${q.toString()}`
}

export interface DimagentTokens {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

function expiryMs(tokens: DimagentTokens): number {
  const ttl =
    typeof tokens.expires_in === "number" && tokens.expires_in > 0 ?
      tokens.expires_in * 1000
    : DEFAULT_ACCESS_TTL_MS
  return Date.now() + ttl
}

/** 读 JWT 的 payload（不验签），拿账号信息。 */
function claims(token: string | undefined): Record<string, unknown> {
  if (!token) return {}
  const parts = token.split(".")
  if (parts.length < 2) return {}
  try {
    const json = Buffer.from(
      parts[1]!.replaceAll("-", "+").replaceAll("_", "/"),
      "base64",
    ).toString("utf8")
    return (JSON.parse(json) as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}

function claim(
  tokens: DimagentTokens,
  keys: Array<string>,
): string | undefined {
  for (const token of [tokens.access_token, tokens.id_token]) {
    const c = claims(token)
    for (const key of keys) {
      const value = c[key]
      if (typeof value === "string" && value.trim()) return value.trim()
    }
  }
  return undefined
}

async function dimagentToken(
  form: Record<string, string>,
  refresh: boolean,
  options?: OAuthFetchOptions,
): Promise<DimagentTokens> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "http-referer": DIMAGENT_REFERER,
  }
  if (refresh) {
    // 刷新看起来像 DimCode 的服务，不是登录页的 client。
    headers["x-title"] = "DimCode"
  } else {
    headers.accept = "*/*"
    headers["user-agent"] = DIMAGENT_DESKTOP_UA
    headers["x-title"] = "DimAgent"
  }
  const response = await oauthFetch(
    `${DIMAGENT_BASE}/oauth/token`,
    { method: "POST", headers, body: new URLSearchParams(form).toString() },
    options,
  )
  const text = await response.text()
  if (!response.ok) {
    throw new HTTPError(
      `DimAgent token request failed (${response.status})`,
      new Response(text || response.statusText, { status: response.status }),
      text,
    )
  }
  let tokens: DimagentTokens = {}
  try {
    tokens = JSON.parse(text) as DimagentTokens
  } catch {
    tokens = {}
  }
  if (!tokens.access_token) {
    throw new HTTPError(
      "DimAgent token request returned no access_token",
      new Response(null, { status: 502 }),
      text,
    )
  }
  return tokens
}

/** 用回调带回来的 code 换 token（PKCE verifier 证明）。 */
export function exchangeDimagentCode(
  code: string,
  pkce: PkceCodes,
  options?: OAuthFetchOptions,
): Promise<DimagentTokens> {
  return dimagentToken(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: DIMAGENT_REDIRECT_URI,
      client_id: DIMAGENT_CLIENT_ID,
      code_verifier: pkce.codeVerifier,
    },
    false,
    options,
  )
}

/** 刷新（上游会轮换 refresh token）。 */
export function refreshDimagentTokens(
  refreshToken: string,
  options?: OAuthFetchOptions,
): Promise<DimagentTokens> {
  return dimagentToken(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: DIMAGENT_CLIENT_ID,
    },
    true,
    options,
  )
}

export interface DimagentBundle {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  subject?: string
  plan?: string
  nickname?: string
  email?: string
}

/** 把 token 变成 bundle（含 JWT 里的账号信息）。 */
export function dimagentBundle(tokens: DimagentTokens): DimagentBundle {
  return {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token,
    expiresAt: expiryMs(tokens),
    subject: claim(tokens, ["sub", "account_id", "accountId"]),
    plan: claim(tokens, ["plan_type", "planType", "tier", "subscription_tier"]),
    nickname: claim(tokens, ["nickname", "name", "preferred_username"]),
    email: claim(tokens, ["email"]),
  }
}

/** 落库。 */
export function applyDimagentOAuthBundle(
  connection: ProviderConnection,
  bundle: DimagentBundle,
): void {
  applyOAuthBundleToCredential(
    connection,
    {
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      expiresAt: bundle.expiresAt,
    },
    {
      accountId: bundle.subject,
      email: bundle.email ?? bundle.nickname,
    },
  )
}
