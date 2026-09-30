/**
 * Qoder OAuth：PKCE 设备流登录 + 双 token 续期。
 *
 * **纯 HTTP** 流程（不依赖本机 CLI / SQLite / keychain）：
 *
 *   授权页   https://qoder.com/device/selectAccounts?challenge=&nonce=&machine_id=&client_id=&redirect_uri=qoder-app://
 *   轮询     GET  https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256
 *   job token POST https://openapi.qoder.sh/api/v1/me/jobToken  {clientId}
 *   userinfo GET  https://openapi.qoder.sh/api/v1/userinfo      Bearer <deviceToken>
 *
 * **双 token** 是本 provider 最特殊的地方：
 * - `device_token`（dt-）：userinfo / usage 用，直接 `Authorization: Bearer`
 * - job `token`（jt-）：chat 用，经 COSY 加密后进 `Authorization: Bearer COSY.<payload>.<sig>`
 * 两者各有独立 refresh 端点，且都会轮换 refresh token；有效期来自响应的
 * `expires_in`（**毫秒**），不是 JWT 的 `exp`。
 *
 * 落位（见 plan 的架构决策 3）：
 * - `credential.value`                    = job token（chat）
 * - `credential.context.refreshToken`     = job refresh token（OAuth 刷新调度直接可用）
 * - `credential.context.deviceToken` / `deviceRefreshToken` = 设备 token（quota/userinfo）
 * - `credential.context.{uid,machineId,name,email}`         = COSY 签名所需身份
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import {
  getCredentialContextString,
  setConnectionCredentialExtra,
  setCredentialContextField,
} from "~/lib/provider-connections"
import {
  QODER_CLIENT_ID,
  QODER_DEVICE_FLOW_HOST,
  QODER_DEVICE_SELECT_ACCOUNTS_PATH,
  QODER_DEVICE_TOKEN_POLL_PATH,
  QODER_DEVICE_TOKEN_REFRESH_PATH,
  QODER_JOB_TOKEN_PATH,
  QODER_JOB_TOKEN_REFRESH_PATH,
  QODER_OPENAPI_HOST,
  QODER_REDIRECT_URI,
  QODER_USERINFO_PATH,
} from "~/services/qoder/endpoints"
import { newQoderMachineId } from "~/services/qoder/ids"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import { generatePkceCodes } from "./pkce"

/** 设备流轮询间隔（2s）。 */
export const QODER_DEVICE_POLL_INTERVAL_MS = 2000

/** 设备流轮询上限（覆盖用户打开浏览器完成授权的时间）。 */
export const QODER_DEVICE_FLOW_DEADLINE_MS = 15 * 60 * 1000

/** job token 响应缺 `expires_in` 时的兜底寿命（兜底 24h）。 */
export const QODER_JOB_TOKEN_FALLBACK_MS = 24 * 60 * 60 * 1000

const JSON_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
} as const

export interface QoderDeviceTokenResponse {
  token: string
  refreshToken: string
  userId: string
}

export interface QoderJobTokenResponse {
  token: string
  refreshToken: string
  /** 毫秒；缺失或 ≤ 0 时由调用方兜 24h。 */
  expiresInMs?: number
}

export interface QoderUserInfo {
  id: string
  name: string
  email: string
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

/**
 * 设备授权第 1 步：生成 PKCE + machine_id + nonce，拼出要打开的授权页。
 *
 * machine_id 是账号身份，必须随登录一起保存（COSY 头用它），所以由调用方
 * 放到 flow 上、exchange 时再取回。
 */
export function createQoderAuthRequest(): {
  authUrl: string
  pkce: { codeVerifier: string; codeChallenge: string }
  nonce: string
  machineId: string
} {
  const pkce = generatePkceCodes()
  const machineId = newQoderMachineId()
  const nonce = newQoderMachineId()
  const params = new URLSearchParams({
    challenge: pkce.codeChallenge,
    challenge_method: "S256",
    nonce,
    machine_id: machineId,
    client_id: QODER_CLIENT_ID,
    redirect_uri: QODER_REDIRECT_URI,
  })
  return {
    authUrl: `${QODER_DEVICE_FLOW_HOST}${QODER_DEVICE_SELECT_ACCOUNTS_PATH}?${params.toString()}`,
    pkce,
    nonce,
    machineId,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mapDeviceToken(
  raw: Record<string, unknown>,
): QoderDeviceTokenResponse {
  return {
    // 兼容 `device_token` 拼写（refresh 响应里出现过）
    token: asString(raw.token) || asString(raw.device_token),
    refreshToken: asString(raw.refresh_token),
    userId: asString(raw.user_id),
  }
}

/**
 * 设备授权第 2 步：轮询 device token，直到用户确认、超时或被取消。
 *
 * Qoder 在“还没确认”时回非 200（或多半是空 token），所以轮询到 200 且带
 * token 才算成功；其余一律按“还没好”处理。
 */
export async function pollQoderDeviceToken(params: {
  nonce: string
  verifier: string
  intervalMs?: number
  deadlineMs?: number
  signal?: AbortSignal
  proxyUrl?: string
}): Promise<QoderDeviceTokenResponse> {
  // 0 是合法值（测试用来免等待），只有 undefined 才回落到默认间隔。
  const intervalMs =
    params.intervalMs !== undefined && params.intervalMs >= 0 ?
      params.intervalMs
    : QODER_DEVICE_POLL_INTERVAL_MS
  const deadline =
    Date.now() + (params.deadlineMs ?? QODER_DEVICE_FLOW_DEADLINE_MS)
  const options: OAuthFetchOptions = {
    signal: params.signal,
    proxyUrl: params.proxyUrl,
  }

  while (Date.now() < deadline) {
    if (params.signal?.aborted) {
      throw new Error("Qoder device authorization cancelled")
    }
    const params_ = new URLSearchParams({
      nonce: params.nonce,
      verifier: params.verifier,
      challenge_method: "S256",
    })
    const response = await oauthFetch(
      `${QODER_OPENAPI_HOST}${QODER_DEVICE_TOKEN_POLL_PATH}?${params_.toString()}`,
      { method: "GET", headers: { Accept: "application/json" } },
      options,
    )
    const body = await response.text()
    if (response.status === 200) {
      try {
        const token = mapDeviceToken(asRecord(JSON.parse(body)))
        if (token.token.trim()) return token
      } catch {
        // 非 JSON：还没好，继续轮询。
      }
    }
    await sleep(intervalMs)
  }

  throw new Error("Qoder device authorization timed out")
}

/** job token 交换：用 device token 换 chat 用的 job token。 */
export async function exchangeQoderJobToken(
  deviceToken: string,
  options?: OAuthFetchOptions,
): Promise<QoderJobTokenResponse> {
  const response = await oauthFetch(
    `${QODER_OPENAPI_HOST}${QODER_JOB_TOKEN_PATH}`,
    {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ clientId: QODER_CLIENT_ID }),
    },
    options,
  )
  const body = await response.text()
  if (!response.ok) {
    throw new Error(
      `Qoder job token exchange failed (${response.status}): ${body.slice(0, 300)}`,
    )
  }
  const raw = asRecord(safeJson(body))
  const token = asString(raw.token)
  if (!token) {
    throw new Error("Qoder job token exchange returned an empty token")
  }
  return {
    token,
    refreshToken: asString(raw.refresh_token),
    expiresInMs: numberOrUndefined(raw.expires_in),
  }
}

/**
 * job token 续期：refresh token 一次性轮换，必须把新值写回。
 *
 * 失败时抛 `HTTPError`（带原始响应体），让 refresh-scheduler 的终态判定
 * （invalid_grant / 401 等）能看到上游的错误码。
 */
export async function refreshQoderJobToken(
  refreshToken: string,
  options?: OAuthFetchOptions,
): Promise<QoderJobTokenResponse> {
  if (!refreshToken.trim()) {
    throw new Error(
      "Qoder job token refresh: missing refresh token; sign in again",
    )
  }
  const response = await oauthFetch(
    `${QODER_OPENAPI_HOST}${QODER_JOB_TOKEN_REFRESH_PATH}`,
    {
      method: "POST",
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
    options,
  )
  const body = await response.text()
  if (!response.ok) {
    throw new HTTPError(
      `Qoder job token refresh failed (${response.status})`,
      new Response(body, { status: response.status }),
      body,
    )
  }
  const raw = asRecord(safeJson(body))
  const token = asString(raw.token)
  const nextRefresh = asString(raw.refresh_token)
  if (!token || !nextRefresh) {
    throw new Error("Qoder job token refresh returned an incomplete token pair")
  }
  return {
    token,
    refreshToken: nextRefresh,
    expiresInMs: numberOrUndefined(raw.expires_in),
  }
}

/**
 * 设备 token 续期：只服务于账号页（userinfo / usage），**不影响 chat**。
 *
 * 因此它的失败绝不能把连接标成 `auth_error`（chat 走 job token，仍可用）：
 * 调用方只把错误如实报出去，不碰 credential.status。
 */
export async function refreshQoderDeviceToken(
  refreshToken: string,
  options?: OAuthFetchOptions,
): Promise<QoderDeviceTokenResponse> {
  if (!refreshToken.trim()) {
    throw new Error(
      "Qoder device token refresh: missing refresh token; sign in again",
    )
  }
  const response = await oauthFetch(
    `${QODER_OPENAPI_HOST}${QODER_DEVICE_TOKEN_REFRESH_PATH}`,
    {
      method: "POST",
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
    options,
  )
  const body = await response.text()
  if (!response.ok) {
    throw new HTTPError(
      `Qoder device token refresh failed (${response.status})`,
      new Response(body, { status: response.status }),
      body,
    )
  }
  const token = mapDeviceToken(asRecord(safeJson(body)))
  if (!token.token || !token.refreshToken) {
    throw new Error(
      "Qoder device token refresh returned an incomplete token pair",
    )
  }
  return token
}

/** 设备 token 轮换后写回 connection（同样不触碰 credential.status）。 */
export function applyQoderDeviceTokenRefresh(
  connection: ProviderConnection,
  token: QoderDeviceTokenResponse,
): void {
  setCredentialContextField(connection, "deviceToken", token.token)
  setCredentialContextField(
    connection,
    "deviceRefreshToken",
    token.refreshToken,
  )
}

/** 账号身份：设备 token 直接 Bearer（不经过 COSY）。 */
export async function fetchQoderUserInfo(
  deviceToken: string,
  options?: OAuthFetchOptions,
): Promise<QoderUserInfo> {
  const response = await oauthFetch(
    `${QODER_OPENAPI_HOST}${QODER_USERINFO_PATH}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${deviceToken}`,
      },
    },
    options,
  )
  const body = await response.text()
  if (!response.ok) {
    throw new Error(
      `Qoder userinfo failed (${response.status}): ${body.slice(0, 300)}`,
    )
  }
  const raw = asRecord(safeJson(body))
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    email: asString(raw.email),
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ?
      value
    : undefined
}

/** job token 寿命：响应的 `expires_in`（毫秒），缺失时兜 24h。 */
export function qoderJobTokenLifetimeMs(
  job: Pick<QoderJobTokenResponse, "expiresInMs">,
): number {
  return job.expiresInMs && job.expiresInMs > 0 ?
      job.expiresInMs
    : QODER_JOB_TOKEN_FALLBACK_MS
}

// ── connection 落库 ─────────────────────────────────────────────

export interface QoderOAuthBundle {
  jobToken: string
  jobRefreshToken: string
  expiresAt: number
  deviceToken: string
  deviceRefreshToken: string
  uid: string
  machineId: string
  name?: string
  email?: string
}

/**
 * 把登录产物写到 connection 上。
 *
 * MiniMax 那套通用 bundle 只覆盖 accessToken / refreshToken / expiresAt / email；
 * Qoder 额外固化 COSY 签名与配额所需的身份字段（uid / machineId / 设备 token）。
 */
export function applyQoderOAuthBundle(
  connection: ProviderConnection,
  bundle: QoderOAuthBundle,
): void {
  const credential = connection.credentials[0]
  if (credential) {
    credential.authMode = "bearer"
  }
  applyOAuthBundleToCredential(
    connection,
    {
      accessToken: bundle.jobToken,
      refreshToken: bundle.jobRefreshToken,
      expiresAt: bundle.expiresAt,
    },
    { email: bundle.email },
  )
  setCredentialContextField(connection, "uid", bundle.uid)
  setCredentialContextField(connection, "machineId", bundle.machineId)
  setCredentialContextField(connection, "deviceToken", bundle.deviceToken)
  setCredentialContextField(
    connection,
    "deviceRefreshToken",
    bundle.deviceRefreshToken,
  )
  if (bundle.name) {
    setCredentialContextField(connection, "name", bundle.name)
    setConnectionCredentialExtra(connection, "name", bundle.name)
  }
}

/** 续期只动 job token 三件套，设备 token 与身份字段原样保留。 */
export function applyQoderJobTokenRefresh(
  connection: ProviderConnection,
  job: QoderJobTokenResponse,
): void {
  applyOAuthBundleToCredential(connection, {
    accessToken: job.token,
    refreshToken: job.refreshToken,
    expiresAt: Date.now() + qoderJobTokenLifetimeMs(job),
  })
}

/** 从 connection 读回 COSY 签名所需的身份（缺失时 undefined）。 */
export function qoderUserFromConnection(connection: ProviderConnection):
  | {
      uid: string
      name: string
      email: string
      machineId: string
      deviceToken: string
      deviceRefreshToken: string
    }
  | undefined {
  const uid = getCredentialContextString(connection, "uid")
  const machineId = getCredentialContextString(connection, "machineId")
  if (!uid || !machineId) return undefined
  return {
    uid,
    name: getCredentialContextString(connection, "name") ?? "",
    email: getCredentialContextString(connection, "email") ?? "",
    machineId,
    deviceToken: getCredentialContextString(connection, "deviceToken") ?? "",
    deviceRefreshToken:
      getCredentialContextString(connection, "deviceRefreshToken") ?? "",
  }
}
