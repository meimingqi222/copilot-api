/**
 * Zed OAuth：编辑器自己的登录。
 *
 * 流程（RSA + loopback 回调）：
 *
 *   1. magpie 生成一把 RSA-2048 私钥，公钥 = PKCS#1 DER 的 url-safe base64；
 *   2. 打开 https://zed.dev/native_app_signin?native_app_port=<port>
 *      &native_app_public_key=<pub>&system_id=<uuid>；
 *   3. 浏览器回到 loopback 的**任意路径**，query 带 `user_id` 与
 *      `access_token`（token 用公钥 RSA-OAEP-SHA256 加密），再被送去
 *      zed.dev/native_app_signin_succeeded；
 *   4. 私钥解密 access token，GET cloud.zed.dev/client/users/me 读账号，
 *      POST /client/llm_tokens {organization_id} 换短时模型 token。
 *
 * API：`https://cloud.zed.dev`，头 `Authorization: <user_id> <access_token>`。
 * 模型 token 短时有效，401 / x-zed-expired-token / x-zed-outdated-token 时重取。
 */

import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
} from "node:crypto"

import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import {
  getConnectionProxyUrl,
  setConnectionCredentialExtra,
  setCredentialContextField,
} from "~/lib/provider-connections"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"

export const ZED_SITE = "https://zed.dev"
export const ZED_CLOUD = "https://cloud.zed.dev"
export const ZED_VERSION = "1.23.0"
export const ZED_CALLBACK_PORT = 59655
export const ZED_SIGNIN_SUCCEEDED_URL = `${ZED_SITE}/native_app_signin_succeeded`

/** Zed 的 User-Agent：`Zed/<ver> (<os>; <arch>)`（Rust 命名）。 */
export function zedUserAgent(): string {
  const os = process.platform === "darwin" ? "macos" : process.platform
  const arch =
    process.arch === "arm64" ? "aarch64"
    : process.arch === "x64" ? "x86_64"
    : process.arch
  return `Zed/${ZED_VERSION} (${os}; ${arch})`
}

export interface ZedKey {
  privateKeyPem: string
  publicKeyB64: string
}

/** 生成登录用的 RSA-2048 密钥对（公钥 = PKCS#1 DER 的 url-safe base64）。 */
export function newZedKey(): ZedKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  return {
    privateKeyPem: privateKey as unknown as string,
    publicKeyB64: (publicKey as unknown as Buffer).toString("base64url"),
  }
}

/** 随机 UUID v4，Zed 叫它 machine id。 */
export function newZedSystemId(): string {
  return randomUUID()
}

/** 登录页 URL。 */
export function zedSignInUrl(
  port: number,
  publicKey: string,
  systemId: string,
): string {
  const q = new URLSearchParams({
    native_app_port: String(port),
    native_app_public_key: publicKey,
  })
  if (systemId) q.set("system_id", systemId)
  return `${ZED_SITE}/native_app_signin?${q.toString()}`
}

/** 用私钥解密回调带回来的 access token（OAEP-SHA256，回退 PKCS#1 v1.5）。 */
export function decryptZedToken(
  privateKeyPem: string,
  ciphertext: string,
): string {
  let ct: Buffer
  try {
    ct = Buffer.from(ciphertext, "base64url")
  } catch {
    throw new Error("the Zed access token isn't base64")
  }
  try {
    return privateDecrypt(
      {
        key: privateKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      ct,
    ).toString("utf8")
  } catch {
    try {
      return privateDecrypt(
        { key: privateKeyPem, padding: constants.RSA_PKCS1_PADDING },
        ct,
      ).toString("utf8")
    } catch {
      throw new Error("the Zed access token couldn't be decrypted")
    }
  }
}

export interface ZedMe {
  userId?: string
  login?: string
  name?: string
  org?: string
  plan?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

async function zedCloud(input: {
  path: string
  method: "GET" | "POST"
  uid: string
  token: string
  systemId: string
  body?: unknown
  options?: OAuthFetchOptions
}): Promise<unknown> {
  const { path, method, uid, token, systemId, body, options } = input
  const response = await oauthFetch(
    `${ZED_CLOUD}${path}`,
    {
      method,
      headers: {
        authorization: `${uid} ${token}`,
        "content-type": "application/json",
        "user-agent": zedUserAgent(),
        ...(systemId ? { "x-zed-system-id": systemId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    options,
  )
  const text = await response.text()
  if (!response.ok) {
    throw new HTTPError(
      `Zed request failed (${response.status})`,
      new Response(text || response.statusText, { status: response.status }),
      text,
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 读账号：登录名、机构、计划。 */
export async function fetchZedMe(
  uid: string,
  token: string,
  systemId: string,
  options?: OAuthFetchOptions,
): Promise<ZedMe> {
  const root = asRecord(
    await zedCloud({
      path: "/client/users/me",
      method: "GET",
      uid,
      token,
      systemId,
      options,
    }),
  )
  const user = asRecord(root?.user)
  const orgs = Array.isArray(root?.organizations) ? root!.organizations : []
  const defaultOrg = str(root?.default_organization_id)
  let org = ""
  for (const raw of orgs) {
    const o = asRecord(raw)
    if (!o) continue
    if (str(o.id) === defaultOrg) {
      org = defaultOrg
      break
    }
    if (!org) org = str(o.id)
  }
  const plans = asRecord(root?.plans_by_organization)
  const planObj = asRecord(root?.plan)
  return {
    userId: uid,
    login:
      str(user?.github_login)
      || str(user?.username)
      || str(user?.name)
      || undefined,
    name: str(user?.name) || undefined,
    org: org || defaultOrg || undefined,
    plan: (org ? str(plans?.[org]) : "") || str(planObj?.plan_v3) || undefined,
  }
}

/** 用账号 token 换短时模型 token。 */
export async function fetchZedLlmToken(
  uid: string,
  token: string,
  systemId: string,
  org: string,
  options?: OAuthFetchOptions,
): Promise<string> {
  const root = asRecord(
    await zedCloud({
      path: "/client/llm_tokens",
      method: "POST",
      uid,
      token,
      systemId,
      body: { organization_id: org },
      options,
    }),
  )
  const llm = str(root?.token)
  if (!llm) {
    throw new HTTPError(
      "Zed: no model token in the reply",
      new Response(null, { status: 502 }),
      "",
    )
  }
  return llm
}

export interface ZedOAuthBundle {
  userId: string
  accessToken: string
  systemId: string
  org?: string
  login?: string
  name?: string
  plan?: string
}

/** 落库：credential.value = access token；user_id / system_id / org 进 context。 */
export function applyZedOAuthBundle(
  connection: ProviderConnection,
  bundle: ZedOAuthBundle,
): void {
  applyOAuthBundleToCredential(
    connection,
    { accessToken: bundle.accessToken },
    { accountId: bundle.userId },
  )
  setCredentialContextField(connection, "zedUserId", bundle.userId)
  setCredentialContextField(connection, "systemId", bundle.systemId)
  if (bundle.org)
    setCredentialContextField(connection, "organizationId", bundle.org)
  if (bundle.plan) setConnectionCredentialExtra(connection, "plan", bundle.plan)
}

/** 供 adapter / quota 用：从 connection 读 user_id + token。 */
export function zedCredentials(connection: ProviderConnection): {
  uid?: string
  token?: string
  systemId?: string
  org?: string
} {
  return {
    uid: connection.credentials[0]?.context?.zedUserId as string | undefined,
    token: connection.credentials[0]?.value,
    systemId: connection.credentials[0]?.context?.systemId as
      | string
      | undefined,
    org: connection.credentials[0]?.context?.organizationId as
      | string
      | undefined,
  }
}

/** 供 adapter 用：connection 代理 URL。 */
export function zedProxyUrl(
  connection: ProviderConnection,
): string | undefined {
  return getConnectionProxyUrl(connection)
}
