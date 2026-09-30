/**
 * MiniMax Code OAuth 设备码登录（RFC 8628 + PKCE）与 token 续期。
 *
 * 客户端常量来自 MiniMax Code 桌面端 `@mavis/oauth-core`
 * （`client_id=mcode-public`、`scope=agent.default`、`audience=agent-backend`）：
 *
 *   POST {account}/oauth2/device/code   client_id / scope / audience / code_challenge(S256)
 *   POST {account}/oauth2/token         grant_type=urn:ietf:params:oauth:grant-type:device_code
 *                                        device_code / client_id / code_verifier
 *   POST {account}/oauth2/token         grant_type=refresh_token（refreshToken 一次性轮换）
 *
 * 拿到 token 后，MiniMax Code 的模型面是 Anthropic Messages 协议：
 *
 *   POST {agent}/mavis/api/v1/llm/v1/messages
 *     authorization: Bearer <accessToken>   ← 必须用 Bearer，x-api-key 会被 401
 *
 * 两个区域（**凭证互不通用**，登录前就得选）：
 *
 *   cn（国内版，默认）: account.minimax.cn  + agent.minimax.cn
 *   en（国际版）      : account.minimax.io  + agent.minimax.io
 *
 * 两套域名接口路径与响应结构完全一致（实测），所以换区域 = 同时换两个 host。
 * 注意 access token 只有 1 小时（实测 `expires_in=3600`），且 refreshToken
 * 是一次性轮换的——续期成功后必须落库新值，否则下次必失败。
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import {
  setConnectionSetting,
  setCredentialContextField,
} from "~/lib/provider-connections"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"

export const MINIMAX_CLIENT_ID = "mcode-public"
export const MINIMAX_SCOPE = "agent.default"
export const MINIMAX_AUDIENCE = "agent-backend"
export const MINIMAX_DEVICE_CODE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code"

/** `{agent}` 之后到 Messages 端点的固定前缀（自带 `/v1`，不要再补一层）。 */
export const MINIMAX_LLM_PREFIX = "/mavis/api/v1/llm/v1"

/**
 * 第三方客户端的自述 UA。
 *
 * 刻意**不**冒充官方 MiniMax Code 客户端（`User-Agent: MiniMaxCode` 以及
 * `yy` / `x-timestamp` / `x-signature` 那组“第一方客户端标识头”）：那些头是把请求
 * 标记成官方客户端的字面量。Messages 链路只需要 Bearer，实测裸 UA 即可。
 */
export const MINIMAX_USER_AGENT = "copilot-api"

export type MinimaxRegion = "cn" | "en"

export const MINIMAX_DEFAULT_REGION: MinimaxRegion = "cn"

interface MinimaxRegionConfig {
  /** OAuth 账号域（设备码 / token / revoke）。 */
  account: string
  /** 模型面（Messages）域。 */
  agent: string
  /** 订阅用量端点所在域，按优先级排列。 */
  quotaHosts: ReadonlyArray<string>
}

export const MINIMAX_REGIONS: Record<MinimaxRegion, MinimaxRegionConfig> = {
  cn: {
    account: "https://account.minimax.cn",
    agent: "https://agent.minimax.cn",
    quotaHosts: ["https://api.minimax.cn", "https://api.minimaxi.com"],
  },
  en: {
    account: "https://account.minimax.io",
    agent: "https://agent.minimax.io",
    quotaHosts: ["https://api.minimax.io", "https://api.minimaxi.com"],
  },
}

const REGION_ALIASES: Record<string, MinimaxRegion> = {
  cn: "cn",
  china: "cn",
  mainland: "cn",
  minimax: "cn",
  en: "en",
  io: "en",
  global: "en",
  intl: "en",
  international: "en",
  overseas: "en",
  minimaxi: "cn",
}

/** 把 region 的各种写法归一到 `cn` / `en`；认不出来时按国内版处理。 */
export function normalizeMinimaxRegion(value: unknown): MinimaxRegion {
  const key = String(value ?? "")
    .trim()
    .toLowerCase()
  return REGION_ALIASES[key] ?? MINIMAX_DEFAULT_REGION
}

/** 从域名反查区域；不是 MiniMax 域名返回 undefined。 */
export function minimaxRegionFromHost(
  value: unknown,
): MinimaxRegion | undefined {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
  if (text.includes("minimax.io")) return "en"
  if (text.includes("minimax.cn") || text.includes("minimaxi.com")) return "cn"
  return undefined
}

/**
 * 解析一个 connection 所属的区域。
 *
 * 顺序：credential.context.region（登录时写入）→ settings.region →
 * baseUrl 反查（自定义域名会被忽略）→ 默认国内版。
 * 存量数据里 region 与 baseUrl 冲突时以 credential context 为准（那里是
 * 签发凭证的那个区域，凭证跨区域必 401）。
 */
export function resolveMinimaxRegion(
  connection: ProviderConnection,
): MinimaxRegion {
  const fromContext = connection.credentials[0]?.context?.region
  if (typeof fromContext === "string" && fromContext.trim()) {
    return normalizeMinimaxRegion(fromContext)
  }
  const fromSettings = connection.metadata?.settings
  if (
    fromSettings
    && typeof fromSettings === "object"
    && typeof (fromSettings as Record<string, unknown>).region === "string"
  ) {
    return normalizeMinimaxRegion(
      (fromSettings as Record<string, unknown>).region,
    )
  }
  return minimaxRegionFromHost(connection.baseUrl) ?? MINIMAX_DEFAULT_REGION
}

export function minimaxAccountHost(region: MinimaxRegion): string {
  return MINIMAX_REGIONS[region].account
}

export function minimaxDeviceCodeUrl(region: MinimaxRegion): string {
  return `${minimaxAccountHost(region)}/oauth2/device/code`
}

export function minimaxTokenUrl(region: MinimaxRegion): string {
  return `${minimaxAccountHost(region)}/oauth2/token`
}

/** Anthropic Messages 的 baseUrl（`.../llm/v1`，adapter 再拼 `/messages`）。 */
export function minimaxMessagesBaseUrl(region: MinimaxRegion): string {
  return `${MINIMAX_REGIONS[region].agent}${MINIMAX_LLM_PREFIX}`
}

async function readJsonBody(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ?
        (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

const MINIMAX_JSON_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
  "User-Agent": MINIMAX_USER_AGENT,
} as const

// ── 设备码登录 ──────────────────────────────────────────────────

export interface MinimaxDeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

/**
 * 设备授权第 1 步：取 device_code + user_code。
 *
 * PKCE 是必需的（token 请求要带 code_verifier），Rust/Python 端都一样。
 */
export async function startMinimaxDeviceFlow(
  region: MinimaxRegion,
  pkce: { codeChallenge: string },
  options?: OAuthFetchOptions,
): Promise<MinimaxDeviceCodeResponse> {
  const response = await oauthFetch(
    minimaxDeviceCodeUrl(region),
    {
      method: "POST",
      headers: { ...MINIMAX_JSON_HEADERS },
      body: formBody({
        client_id: MINIMAX_CLIENT_ID,
        scope: MINIMAX_SCOPE,
        audience: MINIMAX_AUDIENCE,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: "S256",
      }),
    },
    options,
  )

  const body = await readJsonBody(response)
  if (!response.ok) {
    throw new Error(
      `MiniMax device flow start failed (${response.status}): ${JSON.stringify(body).slice(0, 300)}`,
    )
  }

  const deviceCode =
    typeof body.device_code === "string" ? body.device_code : ""
  const userCode = typeof body.user_code === "string" ? body.user_code : ""
  const verificationUri =
    typeof body.verification_uri === "string" ? body.verification_uri
    : typeof body.verification_url === "string" ? body.verification_url
    : ""
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(
      `MiniMax device code response is incomplete: ${JSON.stringify(body).slice(0, 300)}`,
    )
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete:
      typeof body.verification_uri_complete === "string" ?
        body.verification_uri_complete
      : `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    expires_in:
      typeof body.expires_in === "number" ? body.expires_in : undefined,
    interval: typeof body.interval === "number" ? body.interval : undefined,
  }
}

export interface MinimaxOAuthBundle {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  region: MinimaxRegion
  accountId?: string
}

interface MinimaxTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  account_id?: string
  sub?: string
  /** 账号模式：服务端可能回 200 + `status` 而不是 400 + `error`。 */
  status?: string
  error?: string
  error_description?: string
}

type MinimaxPollOutcome =
  | { kind: "tokens"; tokens: MinimaxTokenResponse }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "terminal"; message: string }

const TERMINAL_DEVICE_ERRORS = new Set([
  "access_denied",
  "expired_token",
  "invalid_grant",
  "invalid_device_code",
])

function classifyDeviceTokenResponse(
  response: Response,
  body: MinimaxTokenResponse,
): MinimaxPollOutcome {
  if (body.access_token) {
    return { kind: "tokens", tokens: body }
  }
  // 账号模式：HTTP 200 + status 字段（实测 CN 版走标准分支，这里只做兼容）。
  switch (body.status) {
    case "pending": {
      return { kind: "pending" }
    }
    case "slow_down": {
      return { kind: "slow_down" }
    }
    case "denied":
    case "access_denied": {
      return { kind: "terminal", message: "MiniMax 授权被拒绝" }
    }
    case "expired":
    case "expired_token": {
      return {
        kind: "terminal",
        message: "MiniMax 设备码已过期，请重新发起登录",
      }
    }
    default: {
      break
    }
  }
  if (body.error === "authorization_pending") return { kind: "pending" }
  if (body.error === "slow_down") return { kind: "slow_down" }
  if (body.error && TERMINAL_DEVICE_ERRORS.has(body.error)) {
    return {
      kind: "terminal",
      message: `MiniMax OAuth error: ${body.error}`,
    }
  }
  const detail =
    body.error_description ?? body.error ?? `HTTP ${response.status}`
  return { kind: "terminal", message: `MiniMax OAuth error: ${detail}` }
}

function bundleFromTokens(
  tokens: MinimaxTokenResponse,
  region: MinimaxRegion,
): MinimaxOAuthBundle {
  const accountId = tokens.account_id ?? tokens.sub
  return {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token,
    expiresAt:
      typeof tokens.expires_in === "number" ?
        Date.now() + tokens.expires_in * 1000
      : undefined,
    region,
    accountId: typeof accountId === "string" ? accountId : undefined,
  }
}

const DEFAULT_POLL_INTERVAL_MS = 5000
const MAX_POLL_DURATION_MS = 15 * 60 * 1000

/** 轮询一次 token 端点（RFC 8628 设备码授权）。 */
async function exchangeDeviceCodeOnce(
  deviceCode: string,
  pkce: { codeVerifier: string },
  region: MinimaxRegion,
  options?: OAuthFetchOptions,
): Promise<MinimaxPollOutcome> {
  const response = await oauthFetch(
    minimaxTokenUrl(region),
    {
      method: "POST",
      headers: { ...MINIMAX_JSON_HEADERS },
      body: formBody({
        grant_type: MINIMAX_DEVICE_CODE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: MINIMAX_CLIENT_ID,
        code_verifier: pkce.codeVerifier,
      }),
    },
    options,
  )
  return classifyDeviceTokenResponse(
    response,
    (await readJsonBody(response)) as MinimaxTokenResponse,
  )
}

/**
 * 设备授权第 2 步：轮询直到用户确认（或超时）。
 *
 * 轮询间隔与总时长都以设备码响应为准（`interval` / `expires_in`），
 * 服务端回 `slow_down` 时把间隔翻倍（RFC 8628 §3.5）。
 */
export async function pollMinimaxDeviceAuthorization(
  deviceCode: MinimaxDeviceCodeResponse,
  pkce: { codeVerifier: string },
  region: MinimaxRegion,
  options?: OAuthFetchOptions,
): Promise<MinimaxOAuthBundle> {
  let intervalMs = Math.max((deviceCode.interval ?? 5) * 1000, 0)
  const deadline =
    Date.now()
    + Math.min(
      MAX_POLL_DURATION_MS,
      (deviceCode.expires_in ?? MAX_POLL_DURATION_MS / 1000) * 1000,
    )

  while (Date.now() < deadline) {
    if (options?.signal?.aborted) {
      throw new Error("MiniMax device authorization cancelled")
    }

    const outcome = await exchangeDeviceCodeOnce(
      deviceCode.device_code,
      pkce,
      region,
      options,
    )
    if (outcome.kind === "tokens") {
      const bundle = bundleFromTokens(outcome.tokens, region)
      if (!bundle.accessToken) {
        throw new Error("MiniMax token exchange returned empty access_token")
      }
      return bundle
    }
    if (outcome.kind === "terminal") {
      throw new Error(outcome.message)
    }
    if (outcome.kind === "slow_down") {
      intervalMs = Math.max(intervalMs, DEFAULT_POLL_INTERVAL_MS) + 5000
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error("MiniMax device authorization timed out")
}

// ── 续期 ────────────────────────────────────────────────────────

/**
 * 用 refreshToken 续期。
 *
 * refreshToken **一次性轮换**：响应里的新值必须覆盖旧值，否则下一次必失败。
 */
export async function refreshMinimaxTokens(
  refreshToken: string,
  region: MinimaxRegion,
  options?: OAuthFetchOptions,
): Promise<MinimaxOAuthBundle> {
  const response = await oauthFetch(
    minimaxTokenUrl(region),
    {
      method: "POST",
      headers: { ...MINIMAX_JSON_HEADERS },
      body: formBody({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: MINIMAX_CLIENT_ID,
        scope: MINIMAX_SCOPE,
        audience: MINIMAX_AUDIENCE,
      }),
    },
    options,
  )

  const body = (await readJsonBody(response)) as MinimaxTokenResponse
  if (!response.ok || !body.access_token) {
    // 不截太狠：terminal 判定（invalid_grant / refresh_token_reused 等）
    // 依赖错误码出现在错误体里。
    throw new Error(
      `MiniMax token refresh failed (${response.status}): ${JSON.stringify(body).slice(0, 1000)}`,
    )
  }

  const bundle = bundleFromTokens(body, region)
  bundle.refreshToken = bundle.refreshToken ?? refreshToken
  return bundle
}

// ── connection 落库 ─────────────────────────────────────────────

/**
 * 把 token bundle 写到 connection 上。
 *
 * 除了通用字段（accessToken / refreshToken / expiresAt），这里还固化三件
 * 只属于 MiniMax 的事实：
 * - `credential.authMode = "bearer"`：Messages 端点只认 Bearer，`x-api-key` 会 401
 * - `credential.context.region`：续期与用量接口都要按签发区域打域名
 * - `connection.baseUrl`：模型面地址（含区域），协议适配器直接用它拼 `/messages`
 */
export function applyMinimaxOAuthBundle(
  connection: ProviderConnection,
  bundle: MinimaxOAuthBundle,
): void {
  const credential = connection.credentials[0]
  if (credential) {
    credential.authMode = "bearer"
  }
  applyOAuthBundleToCredential(connection, bundle, {
    accountId: bundle.accountId,
  })
  if (!connection.baseUrl) {
    connection.baseUrl = minimaxMessagesBaseUrl(bundle.region)
  }
  setCredentialContextField(connection, "region", bundle.region)
  setConnectionSetting(connection, "region", bundle.region)
}
