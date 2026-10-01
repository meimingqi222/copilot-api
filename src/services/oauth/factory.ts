/**
 * Factory (factory.ai / Droid CLI) OAuth：WorkOS 设备流登录 + 刷新。
 *
 * droid 的登录就是 WorkOS 的设备流（droid 自己的 client）：
 *
 *   设备码  POST {workos}/authorize/device      form: client_id
 *   轮询    POST {workos}/authenticate          grant_type=device_code
 *   刷新    POST {workos}/authenticate          grant_type=refresh_token
 *   身份    GET  {factory}/api/cli/whoami       X-Factory-Whoami-Extended: true
 *
 * `{workos}` = https://api.workos.com/user_management，
 * `{factory}` = https://api.factory.ai（EU 账号域 https://api.eu.factory.ai）。
 *
 * 落位：
 * - `credential.value`                = WorkOS accessToken（chat 用，Bearer）
 * - `credential.context.refreshToken` = WorkOS refresh token（刷新调度直接用）
 * - `credential.context.organizationId` = 活动 org（X-Factory-Org-Id）
 * - `credential.context.region`       = "eu" 时请求走 EU 域
 * - `credential.context.accountId`    = Factory userId
 * - `credential.context.email`        = 账号邮箱
 *
 * WorkOS 每次刷新都会轮换 refresh token（和 CPA 的 devin 一样），所以刷新
 * 必须串行、且把新值写回。
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import {
  setConnectionCredentialExtra,
  setCredentialContextField,
} from "~/lib/provider-connections"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"

const FACTORY_WORKOS_BASE = "https://api.workos.com/user_management"
export const FACTORY_API_BASE = "https://api.factory.ai"
export const FACTORY_API_EU_BASE = "https://api.eu.factory.ai"

/** droid 的 WorkOS client（生产）。 */
const FACTORY_CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB"
/** 请求自称的 droid 版本。 */
export const FACTORY_CLI_VERSION = "0.229.0"

const FACTORY_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

interface FactoryDeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  interval?: number
  expires_in?: number
}

interface FactoryTokens {
  access_token?: string
  refresh_token?: string
  organization_id?: string
  user?: { id?: string; email?: string }
  error?: string
  error_description?: string
}

interface FactoryOAuthBundle {
  accessToken: string
  refreshToken?: string
  /** 活动 org（Factory 自己的 id，X-Factory-Org-Id）。 */
  organizationId?: string
  /** WorkOS org（org_…），仅记录，不发给 Factory API。 */
  workosOrgId?: string
  email?: string
  userId?: string
  /** "eu" 表示账号由 Factory EU 域服务。 */
  region?: string
}

export function factoryApiBase(region: string | undefined): string {
  return region === "eu" ? FACTORY_API_EU_BASE : FACTORY_API_BASE
}

/** access token 的 exp（秒）→ 毫秒；无法解析返回 0。 */
function factoryExpiryMs(accessToken: string): number {
  const parts = accessToken.split(".")
  if (parts.length !== 3) return 0
  try {
    const b64 = parts[1].replaceAll("-", "+").replaceAll("_", "/")
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      exp?: number
    }
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

function readString(
  obj: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = obj?.[key]
  return typeof value === "string" ? value : ""
}

/** POST 表单到 WorkOS。 */
async function workosPost(
  path: string,
  form: Record<string, string>,
  options?: OAuthFetchOptions,
): Promise<FactoryTokens> {
  const response = await oauthFetch(
    `${FACTORY_WORKOS_BASE}${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    },
    options,
  )
  const text = await response.text()
  let parsed: FactoryTokens = {}
  try {
    parsed = JSON.parse(text) as FactoryTokens
  } catch {
    parsed = {}
  }
  if (!response.ok && !parsed.error) {
    throw new HTTPError(
      `Factory sign-in failed (${response.status})`,
      new Response(text || response.statusText, { status: response.status }),
      text,
    )
  }
  return parsed
}

/** 向 WorkOS 要一个设备码。 */
export async function startFactoryDeviceFlow(
  options?: OAuthFetchOptions,
): Promise<FactoryDeviceCodeResponse> {
  const tokens = await workosPost(
    "/authorize/device",
    { client_id: FACTORY_CLIENT_ID },
    options,
  )
  // 设备码端点在 2xx 时直接返回设备码字段；错误时走 error。
  const record = tokens as unknown as Record<string, unknown>
  const deviceCode = readString(record, "device_code")
  if (!deviceCode) {
    throw new HTTPError(
      "Factory sign-in gave no device code",
      new Response(null, { status: 502 }),
      JSON.stringify(tokens),
    )
  }
  return {
    device_code: deviceCode,
    user_code: readString(record, "user_code"),
    verification_uri: readString(record, "verification_uri"),
    verification_uri_complete:
      readString(record, "verification_uri_complete") || undefined,
    interval: typeof record.interval === "number" ? record.interval : undefined,
    expires_in:
      typeof record.expires_in === "number" ? record.expires_in : undefined,
  }
}

const MAX_POLL_DURATION_MS = 15 * 60 * 1000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new Error("aborted"))
      },
      { once: true },
    )
  })
}

/**
 * 轮询 WorkOS 直到用户确认设备码。返回 token bundle（含 whoami 身份）。
 * 边界：authorization_pending 继续、slow_down 拉长间隔、expired_token /
 * access_denied 终止。
 */
export async function pollFactoryDeviceAuthorization(
  device: FactoryDeviceCodeResponse,
  options?: OAuthFetchOptions & { signal?: AbortSignal },
): Promise<FactoryOAuthBundle> {
  let intervalMs = Math.max(device.interval ?? 5, 1) * 1000
  const deadline =
    Date.now()
    + Math.min(
      (device.expires_in ?? 0) > 0 ?
        device.expires_in! * 1000
      : MAX_POLL_DURATION_MS,
      MAX_POLL_DURATION_MS,
    )

  for (;;) {
    if (options?.signal?.aborted) throw new Error("aborted")
    if (Date.now() > deadline) {
      throw new HTTPError(
        "Factory sign-in timed out",
        new Response(null, { status: 408 }),
        "",
      )
    }
    await sleep(intervalMs, options?.signal)

    const tokens = await workosPost(
      "/authenticate",
      {
        grant_type: FACTORY_DEVICE_GRANT,
        device_code: device.device_code,
        client_id: FACTORY_CLIENT_ID,
      },
      options,
    )
    const error = tokens.error ?? ""
    if (error === "authorization_pending") continue
    if (error === "slow_down") {
      intervalMs += 1000
      continue
    }
    if (error === "expired_token") {
      throw new HTTPError(
        "Factory device code expired — start again",
        new Response(null, { status: 410 }),
        "",
      )
    }
    if (error === "access_denied") {
      throw new HTTPError(
        "Factory sign-in was declined",
        new Response(null, { status: 403 }),
        "",
      )
    }
    if (error || !tokens.access_token) {
      throw new HTTPError(
        `Factory sign-in failed: ${error || "no token came back"}`,
        new Response(null, { status: 502 }),
        JSON.stringify(tokens),
      )
    }
    return finalizeFactoryBundle(tokens, options)
  }
}

/** 用 refresh token 换一对新 token（WorkOS 会轮换 refresh token）。 */
export async function refreshFactoryTokens(
  refreshToken: string,
  options?: OAuthFetchOptions,
): Promise<FactoryTokens> {
  const tokens = await workosPost(
    "/authenticate",
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: FACTORY_CLIENT_ID,
    },
    options,
  )
  if (tokens.error) {
    throw new HTTPError(
      `Factory refresh failed: ${tokens.error} ${tokens.error_description ?? ""}`.trim(),
      new Response(null, { status: 401 }),
      JSON.stringify(tokens),
    )
  }
  if (!tokens.access_token) {
    throw new HTTPError(
      "Factory refresh gave no access token",
      new Response(null, { status: 502 }),
      JSON.stringify(tokens),
    )
  }
  return tokens
}

interface FactoryWhoami {
  userId?: string
  orgId?: string
  email?: string
  region?: string
}

/** Factory 自己的身份接口：给出活动 org（X-Factory-Org-Id）与所在区域。 */
async function fetchFactoryWhoami(
  accessToken: string,
  region: string | undefined,
  options?: OAuthFetchOptions,
): Promise<FactoryWhoami> {
  const response = await oauthFetch(
    `${factoryApiBase(region)}/api/cli/whoami`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "x-factory-whoami-extended": "true",
        "x-factory-client": "cli",
        "x-client-version": FACTORY_CLI_VERSION,
        "user-agent": `factory-cli/${FACTORY_CLI_VERSION}`,
      },
    },
    options,
  )
  if (!response.ok) {
    return {}
  }
  return (await response.json()) as FactoryWhoami
}

/** 把 WorkOS token 变成完整 bundle（含 whoami 身份，best-effort）。 */
async function finalizeFactoryBundle(
  tokens: FactoryTokens,
  options?: OAuthFetchOptions,
): Promise<FactoryOAuthBundle> {
  const accessToken = tokens.access_token ?? ""
  const bundle: FactoryOAuthBundle = {
    accessToken,
    refreshToken: tokens.refresh_token,
    workosOrgId: tokens.organization_id,
    email: tokens.user?.email,
    userId: tokens.user?.id,
  }
  try {
    const who = await fetchFactoryWhoami(accessToken, undefined, options)
    bundle.organizationId = who.orgId || undefined
    bundle.email = who.email || bundle.email
    bundle.userId = who.userId || bundle.userId
    bundle.region = who.region || undefined
  } catch {
    // whoami 失败不影响登录：没有活动 org 时请求不带 X-Factory-Org-Id。
  }
  return bundle
}

/** 把 bundle 落到 connection（credential.value = accessToken）。 */
export function applyFactoryOAuthBundle(
  connection: ProviderConnection,
  bundle: FactoryOAuthBundle,
): void {
  applyOAuthBundleToCredential(
    connection,
    {
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      expiresAt: factoryExpiryMs(bundle.accessToken) || undefined,
    },
    {
      accountId: bundle.userId,
      email: bundle.email,
      organizationId: bundle.organizationId,
    },
  )
  if (bundle.region) {
    setCredentialContextField(connection, "region", bundle.region)
    setConnectionCredentialExtra(connection, "region", bundle.region)
  }
  // 活动 org 必须落在 credential.context：adapter 从 context 读它拼
  // X-Factory-Org-Id（applyOAuthBundleToCredential 只把它写进 extras）。
  if (bundle.organizationId) {
    setCredentialContextField(
      connection,
      "organizationId",
      bundle.organizationId,
    )
  }
  if (bundle.workosOrgId) {
    setCredentialContextField(connection, "workosOrgId", bundle.workosOrgId)
  }
}

/** 刷新后写回：保留其余上下文，只更新 token / 到期 / 活动 org。 */
export function applyFactoryTokenRefresh(
  connection: ProviderConnection,
  tokens: FactoryTokens,
): void {
  const accessToken = tokens.access_token ?? ""
  applyOAuthBundleToCredential(connection, {
    accessToken,
    refreshToken: tokens.refresh_token,
    expiresAt: factoryExpiryMs(accessToken) || undefined,
  })
}
