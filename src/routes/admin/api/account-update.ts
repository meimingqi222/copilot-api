import type { ProviderConnection } from "~/lib/provider-connections"

import { isOAuthProviderId } from "~/lib/provider-config"
import {
  ensureLegacyMetadata,
  setConnectionCredentialExtra,
  setConnectionSetting,
  setCredentialContextField,
  setCredentialValue,
} from "~/lib/provider-connections"
import { providerFromProtocol } from "~/lib/provider-connections/protocol-provider"

export interface UpdateAccountBody {
  label?: string
  enabled?: boolean
  priority?: number
  authToken?: string
  apiKey?: string
  githubToken?: string
  serviceToken?: string
  xiaomichatbotPh?: string
  credentials?: Record<string, unknown>
  settings?: Record<string, unknown>
}

/**
 * Connection 级别的补丁(与原 AccountConnectionPatch 形状一致)。
 */
export interface ConnectionPatch {
  label?: string
  enabled?: boolean
  priority?: number
  credentialValue?: string
  credentialExtras?: Record<string, string | undefined>
  settings?: Record<string, unknown>
}

/**
 * 将 admin 请求体解析为 connection 级别的补丁。
 * provider-specific 的字段提取集中在此函数内。
 */
export function parseBodyToPatch(
  conn: ProviderConnection,
  body: UpdateAccountBody,
): ConnectionPatch {
  const provider = providerFromProtocol(conn.protocol)
  const patch: ConnectionPatch = {
    label: body.label,
    enabled: body.enabled,
    priority: body.priority,
    settings: body.settings,
  }

  if (provider === "copilot") {
    const githubToken =
      typeof body.credentials?.githubToken === "string" ?
        body.credentials.githubToken
      : body.githubToken
    if (
      Object.hasOwn(body, "githubToken")
      || Object.hasOwn(body.credentials ?? {}, "githubToken")
    ) {
      patch.credentialValue = githubToken ?? ""
    }
    return patch
  }

  if (provider === "codebuff") {
    const authToken =
      typeof body.credentials?.authToken === "string" ?
        body.credentials.authToken
      : body.authToken
    if (
      Object.hasOwn(body, "authToken")
      || Object.hasOwn(body.credentials ?? {}, "authToken")
    ) {
      patch.credentialValue = authToken ?? ""
    }
    return patch
  }

  if (provider === "windsurf") {
    const apiKey =
      typeof body.credentials?.apiKey === "string" ?
        body.credentials.apiKey
      : body.apiKey
    if (
      Object.hasOwn(body, "apiKey")
      || Object.hasOwn(body.credentials ?? {}, "apiKey")
    ) {
      patch.credentialValue = apiKey ?? ""
    }
    return patch
  }

  if (provider === "mimo-aistudio") {
    const serviceToken =
      typeof body.credentials?.serviceToken === "string" ?
        body.credentials.serviceToken
      : (body.serviceToken
        ?? (typeof body.settings?.serviceToken === "string" ?
          body.settings.serviceToken
        : undefined))
    const xiaomichatbotPh =
      typeof body.credentials?.xiaomichatbotPh === "string" ?
        body.credentials.xiaomichatbotPh
      : (body.xiaomichatbotPh
        ?? (typeof body.settings?.xiaomichatbotPh === "string" ?
          body.settings.xiaomichatbotPh
        : undefined))

    const extras: Record<string, string | undefined> = {}
    if (
      Object.hasOwn(body, "serviceToken")
      || Object.hasOwn(body.credentials ?? {}, "serviceToken")
      || Object.hasOwn(body.settings ?? {}, "serviceToken")
    ) {
      patch.credentialValue = serviceToken ?? ""
    }
    if (
      Object.hasOwn(body, "xiaomichatbotPh")
      || Object.hasOwn(body.credentials ?? {}, "xiaomichatbotPh")
      || Object.hasOwn(body.settings ?? {}, "xiaomichatbotPh")
    ) {
      extras.xiaomichatbotPh = xiaomichatbotPh
    }
    if (body.settings && typeof body.settings.userId === "string") {
      extras.userId = body.settings.userId
    }
    if (Object.hasOwn(body.settings ?? {}, "proxy")) {
      const proxy =
        typeof body.settings?.proxy === "string" ?
          body.settings.proxy
        : undefined
      extras.proxy = proxy
    }
    if (Object.keys(extras).length > 0) {
      patch.credentialExtras = extras
    }
    return patch
  }

  if (provider && isOAuthProviderId(provider)) {
    return patch
  }

  return patch
}

/**
 * Phase 4:将补丁直接应用到 ProviderConnection(不经过 Account 中转)。
 *
 * - label → conn.name
 * - enabled → conn.enabled + credential.enabled
 * - priority → clamp 0-100
 * - credentialValue → credential.value + context(provider-specific)
 * - credentialExtras → metadata.credentialExtras / context
 * - settings → metadata.settings + routing 字段(proxyUrl/modelPrefix 等)
 */
export function applyConnectionPatchToConnection(
  conn: ProviderConnection,
  patch: ConnectionPatch,
): void {
  if (patch.label !== undefined) {
    conn.name = patch.label
  }
  if (patch.enabled !== undefined) {
    conn.enabled = patch.enabled
    const cred = conn.credentials[0]
    if (cred) cred.enabled = patch.enabled
  }
  if (patch.priority !== undefined) {
    conn.priority = Math.max(0, Math.min(100, patch.priority))
  }
  if (patch.credentialValue !== undefined) {
    applyCredentialValueToConnection(conn, patch.credentialValue)
  }
  if (patch.credentialExtras) {
    applyCredentialExtrasToConnection(conn, patch.credentialExtras)
  }
  if (patch.settings) {
    applySettingsPatchToConnection(conn, patch.settings)
  }
}

/**
 * 是否需要根据补丁内容触发 model 刷新。
 */
export function patchRequiresModelRefresh(patch: ConnectionPatch): boolean {
  return patch.credentialValue !== undefined || Boolean(patch.settings)
}

function applyCredentialValueToConnection(
  conn: ProviderConnection,
  value: string,
): void {
  const trimmed = value.trim() || undefined
  const provider = providerFromProtocol(conn.protocol)
  const cred = conn.credentials[0]
  if (!cred) return

  // copilot 的 primary token(credential.value)是 copilot JWT,
  // 由 githubToken(context.githubToken)刷新得到。更新 githubToken 时
  // 绝不能把 githubToken 写入 credential.value —— 否则 ensureCopilotToken
  // 看到非空 value 不会触发刷新,请求会用 githubToken 当 JWT 发往上游。
  // 正确做法:只写 context.githubToken,并清空 credential.value,
  // 让下次请求的 ensureCopilotToken 惰性刷新出新的 copilot JWT。
  if (provider === "copilot") {
    setCredentialContextField(conn, "githubToken", trimmed ?? "")
    setCredentialValue(conn, "")
    return
  }

  // 其他 provider 的 primary token 直接就是 credential.value
  if (trimmed) {
    setCredentialValue(conn, trimmed)
  } else {
    setCredentialValue(conn, "")
  }

  switch (provider) {
    case "codebuff": {
      // codebuff 的 primary token 就是 authToken,已写入 credential.value
      break
    }
    case "windsurf": {
      // windsurf 的 primary token 就是 apiKey,已写入 credential.value
      break
    }
    case "mimo-aistudio": {
      // mimo 的 primary token 就是 serviceToken,已写入 credential.value
      break
    }
    default: {
      if (provider && isOAuthProviderId(provider)) {
        // OAuth:accessToken 写入 credential.value + context.accessToken
        setCredentialContextField(conn, "accessToken", trimmed ?? "")
      }
      break
    }
  }
}

function applyCredentialExtrasToConnection(
  conn: ProviderConnection,
  extras: Record<string, string | undefined>,
): void {
  const provider = providerFromProtocol(conn.protocol)
  if (provider !== "mimo-aistudio") return

  if ("xiaomichatbotPh" in extras) {
    const value = extras.xiaomichatbotPh?.trim() || undefined
    setConnectionCredentialExtra(conn, "xiaomichatbotPh", value)
  }
  if ("userId" in extras) {
    const value = extras.userId?.trim() || undefined
    setConnectionSetting(conn, "userId", value)
  }
  if ("proxy" in extras) {
    const value = extras.proxy?.trim() || undefined
    setConnectionSetting(conn, "proxy", value)
  }
}

function applySettingsPatchToConnection(
  conn: ProviderConnection,
  settings: Record<string, unknown>,
): void {
  const provider = providerFromProtocol(conn.protocol)
  const meta = ensureLegacyMetadata(conn)

  if (provider && isOAuthProviderId(provider)) {
    // OAuth settings 有字段白名单 + 空字符串清除为 undefined 的语义
    for (const key of [
      "baseUrl",
      "proxyUrl",
      "modelPrefix",
      "tokenEndpoint",
      "redirectUri",
    ]) {
      if (typeof settings[key] === "string") {
        const value = (settings[key] as string).trim() || undefined
        setConnectionSetting(conn, key, value)
        // routing 字段同步到 metadata 顶层
        switch (key) {
          case "proxyUrl": {
            meta.proxyUrl = value
            break
          }
          case "modelPrefix": {
            meta.modelPrefix = value
            break
          }
          case "tokenEndpoint": {
            meta.tokenEndpoint = value
            break
          }
          case "redirectUri": {
            meta.redirectUri = value
            break
          }
          default: {
            break
          }
        }
      }
    }
    // useApi 是布尔开关
    if ("useApi" in settings) {
      const raw = settings.useApi
      let value: boolean | undefined
      if (typeof raw === "boolean") {
        value = raw
      } else if (typeof raw === "string") {
        value = raw.trim().toLowerCase() === "true"
      }
      meta.settings = { ...meta.settings, useApi: value }
    }
  } else {
    // 其他 provider:直接合并 settings
    meta.settings = { ...meta.settings, ...settings }
  }
}
