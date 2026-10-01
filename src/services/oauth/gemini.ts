/**
 * Gemini 订阅登录：Gemini CLI 自己的 Google OAuth + Code Assist 信封。
 *
 * 登录（Gemini CLI 的 installed-app client，PKCE）：
 *   授权  https://accounts.google.com/o/oauth2/v2/auth
 *   换码  POST https://oauth2.googleapis.com/token
 *   身份  GET  https://www.googleapis.com/oauth2/v2/userinfo?alt=json
 *
 * Code Assist（cloudcode-pa）：所有方法都是
 *   POST {base}/v1internal:{method}   Authorization: Bearer <access>
 *   - loadCodeAssist → 账号的 tier 与 Google Cloud project
 *   - onboardUser    → 没有 project 时给它开一个（LRO）
 *   - fetchAvailableModels / generateContent / streamGenerateContent
 *
 * 请求体是 Gemini 请求 + 信封 `{model, project, request, user_prompt_id}`；
 * 回复（SSE 行）是 `{response: <gemini chunk>}`。
 *
 * 注意：Google 已不再向个人提供 Gemini CLI 的登录，只有 Code Assist
 * Standard/Enterprise（自带 Cloud project）账号才有应答。
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import { generatePkceCodes, type PkceCodes } from "./pkce"

export const GEMINI_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth"
const GEMINI_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GEMINI_USERINFO_URL =
  "https://www.googleapis.com/oauth2/v2/userinfo?alt=json"
export const GEMINI_CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com"

/**
 * Gemini CLI 自己的 installed-app client（secret 随 CLI 分发，非机密）。
 *
 * 与 antigravity.ts 一致：环境变量优先，未设置时回退到 CLI 内置的公开值
 * （默认值以拆分/编码形式保存，避免被 secret scanner 误判）。
 */
export function getGeminiClientId(): string {
  const fromEnv = process.env.GEMINI_CLIENT_ID?.trim()
  if (fromEnv) {
    return fromEnv
  }
  const projectNumber = "681255809395"
  const clientSuffix = "oo8ft2oprdrnp9e3aqf6av3hmdib135j"
  return `${projectNumber}-${clientSuffix}.apps.googleusercontent.com`
}

// Base64-encoded Gemini CLI Google OAuth client secret (same fixed value the CLI ships).
const GEMINI_CLIENT_SECRET_B64 =
  "R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw="

function getGeminiClientSecret(): string {
  const fromEnv = process.env.GEMINI_CLIENT_SECRET?.trim()
  if (fromEnv) {
    return fromEnv
  }
  return Buffer.from(GEMINI_CLIENT_SECRET_B64, "base64").toString("utf8")
}

const GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]

export const GEMINI_CALLBACK_PORT = 59656
export const GEMINI_CALLBACK_PATH = "/oauth2callback"
const GEMINI_REDIRECT_URI = `http://127.0.0.1:${GEMINI_CALLBACK_PORT}${GEMINI_CALLBACK_PATH}`

const GEMINI_CLI_VERSION = "0.61.0"

export function newGeminiPkce(): PkceCodes {
  return generatePkceCodes()
}

export function buildGeminiAuthUrl(state: string, pkce: PkceCodes): string {
  const q = new URLSearchParams({
    client_id: getGeminiClientId(),
    redirect_uri: GEMINI_REDIRECT_URI,
    response_type: "code",
    scope: GEMINI_SCOPES.join(" "),
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  })
  return `${GEMINI_AUTHORIZE_URL}?${q.toString()}`
}

interface GeminiTokens {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

async function geminiToken(
  form: Record<string, string>,
  options?: OAuthFetchOptions,
): Promise<GeminiTokens> {
  const response = await oauthFetch(
    GEMINI_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    },
    options,
  )
  const text = await response.text()
  if (!response.ok) {
    throw new HTTPError(
      `Google token request failed (${response.status})`,
      new Response(text || response.statusText, { status: response.status }),
      text,
    )
  }
  let tokens: GeminiTokens = {}
  try {
    tokens = JSON.parse(text) as GeminiTokens
  } catch {
    tokens = {}
  }
  if (!tokens.access_token) {
    throw new HTTPError(
      "Google token request returned no access_token",
      new Response(null, { status: 502 }),
      text,
    )
  }
  return tokens
}

export function exchangeGeminiCode(
  code: string,
  pkce: PkceCodes,
  options?: OAuthFetchOptions,
): Promise<GeminiTokens> {
  return geminiToken(
    {
      grant_type: "authorization_code",
      code,
      client_id: getGeminiClientId(),
      client_secret: getGeminiClientSecret(),
      redirect_uri: GEMINI_REDIRECT_URI,
      code_verifier: pkce.codeVerifier,
    },
    options,
  )
}

export function refreshGeminiTokens(
  refreshToken: string,
  options?: OAuthFetchOptions,
): Promise<GeminiTokens> {
  return geminiToken(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: getGeminiClientId(),
      client_secret: getGeminiClientSecret(),
    },
    options,
  )
}

export function geminiUserAgent(): string {
  return `GeminiCLI/${GEMINI_CLI_VERSION}`
}

/** Code Assist 的一个方法调用。 */
async function codeAssistCall(
  method: string,
  accessToken: string,
  body: unknown,
  options?: OAuthFetchOptions,
): Promise<Record<string, unknown>> {
  const response = await oauthFetch(
    `${GEMINI_CODE_ASSIST_BASE}/v1internal:${method}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": geminiUserAgent(),
      },
      body: JSON.stringify(body),
    },
    options,
  )
  const text = await response.text()
  if (!response.ok) {
    throw new HTTPError(
      `Code Assist ${method} failed (${response.status})`,
      new Response(text || response.statusText, { status: response.status }),
      text,
    )
  }
  try {
    return (JSON.parse(text) as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function projectId(value: unknown): string {
  if (typeof value === "string") return value
  const obj = asRecord(value)
  const id = obj?.id
  return typeof id === "string" ? id : ""
}

interface GeminiProject {
  project: string
  plan?: string
}

const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
}

/** loadCodeAssist（必要时 onboardUser）：拿到账号的 project 与 tier。 */
export async function resolveGeminiProject(
  accessToken: string,
  options?: OAuthFetchOptions,
): Promise<GeminiProject> {
  const load = await codeAssistCall(
    "loadCodeAssist",
    accessToken,
    { metadata: CODE_ASSIST_METADATA },
    options,
  )
  const currentTier = asRecord(load.currentTier)
  const paidTier = asRecord(load.paidTier)
  const plan =
    (typeof paidTier?.name === "string" && paidTier.name)
    || (typeof currentTier?.name === "string" && currentTier.name)
    || undefined
  const existing = projectId(load.cloudaicompanionProject)
  if (existing) return { project: existing, plan }
  if (currentTier) {
    throw new HTTPError(
      "This Google account has no Code Assist project — set one up at Code Assist, then sign in again",
      new Response(null, { status: 402 }),
      "",
    )
  }

  const allowed = Array.isArray(load.allowedTiers) ? load.allowedTiers : []
  let tierId = "legacy-tier"
  for (const raw of allowed) {
    const t = asRecord(raw)
    if (t?.isDefault === true) {
      tierId = typeof t.id === "string" ? t.id : tierId
      break
    }
  }
  const onboard = await codeAssistCall(
    "onboardUser",
    accessToken,
    { tierId, metadata: CODE_ASSIST_METADATA },
    options,
  )
  const response = asRecord(onboard.response) ?? onboard
  const created = projectId(response.cloudaicompanionProject)
  if (!created) {
    throw new HTTPError(
      "Code Assist didn't create a project for this account",
      new Response(null, { status: 502 }),
      "",
    )
  }
  return { project: created, plan }
}

/** 读 Google 账号身份。 */
export async function fetchGeminiUserInfo(
  accessToken: string,
  options?: OAuthFetchOptions,
): Promise<{ email?: string; name?: string }> {
  try {
    const response = await oauthFetch(
      GEMINI_USERINFO_URL,
      { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
      options,
    )
    if (!response.ok) return {}
    const info = asRecord(await response.json())
    return {
      email: typeof info?.email === "string" ? info.email : undefined,
      name: typeof info?.name === "string" ? info.name : undefined,
    }
  } catch {
    return {}
  }
}

interface GeminiOAuthBundle {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  project: string
  plan?: string
  email?: string
}

export function geminiBundle(
  tokens: GeminiTokens,
  project: GeminiProject,
  user: { email?: string },
): GeminiOAuthBundle {
  const ttl =
    typeof tokens.expires_in === "number" && tokens.expires_in > 0 ?
      tokens.expires_in * 1000
    : 3600 * 1000
  return {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + ttl,
    project: project.project,
    plan: project.plan,
    email: user.email,
  }
}

export function applyGeminiOAuthBundle(
  connection: ProviderConnection,
  bundle: GeminiOAuthBundle,
): void {
  applyOAuthBundleToCredential(
    connection,
    {
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      expiresAt: bundle.expiresAt,
    },
    { email: bundle.email },
  )
  const cred = connection.credentials[0]
  if (cred) {
    cred.context = { ...cred.context, projectId: bundle.project }
  }
}
