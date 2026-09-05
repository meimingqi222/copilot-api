import type { Context } from "hono"

import { getConnInfo } from "hono/bun"

import type { Account, AccountModel } from "~/lib/legacy-accounts"
import type { ModelMapping } from "~/lib/provider-connections"
import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import { saveAccounts } from "~/lib/account-store"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  classifyUpstreamError,
  getProviderConnection,
  listAccountManagedConnections,
  migrateAccountsToConnections,
  persistProviderConnections,
  providerFromProtocol,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { listExposedPublicModels } from "~/lib/route-target/build"
import { onStateChange } from "~/lib/state-events"
import { globalTimers } from "~/lib/timer-registry"
import { getVSCodeVersion } from "~/services/get-vscode-version"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

import { state } from "./state"

const MODELS_REFRESH_INTERVAL_MS = 10 * 60 * 1000

function makeSleepAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeSleepAbortError(signal))
      return
    }

    const onAbort = (sig: AbortSignal) => {
      clearTimeout(id)
      sig.removeEventListener("abort", boundOnAbort)
      reject(makeSleepAbortError(sig))
    }

    const boundOnAbort = onAbort.bind(null, signal as AbortSignal)

    const id = setTimeout(() => {
      signal?.removeEventListener("abort", boundOnAbort)
      resolve()
    }, ms)

    signal?.addEventListener("abort", boundOnAbort, { once: true })
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export function cacheModels(): void {
  // 用 connection 字段直接构建模型列表（替代原 listAccounts 路径）
  const connectionModels = listAccountManagedConnections()
    .map((conn, originalIndex) => ({ conn, originalIndex }))
    .sort((left, right) => {
      if (left.conn.priority !== right.conn.priority) {
        return left.conn.priority - right.conn.priority
      }
      return left.originalIndex - right.originalIndex
    })
    .flatMap(({ conn }) =>
      (conn.models ?? []).map((model) => ({ model, conn })),
    )

  if (connectionModels.length > 0) {
    const merged = new Map<
      string,
      {
        model: (typeof connectionModels)[number]["model"]
        conn: (typeof connectionModels)[number]["conn"]
        publicId: string
      }
    >()
    for (const entry of connectionModels) {
      // Only the bare model id is exposed; routing/auto-LB across providers
      // happens transparently. Clients may still target a specific provider
      // by sending a prefixed id (prefix/model), resolved via
      // buildAccountModelAliases - but it is not listed here.
      const publicId = entry.model.publicId
      if (!merged.has(publicId)) {
        merged.set(publicId, {
          model: entry.model,
          conn: entry.conn,
          publicId,
        })
      }
    }

    state.models = {
      object: "list",
      data: Array.from(merged.values()).map(({ model, conn, publicId }) => ({
        id: publicId,
        object: "model",
        name: model.name ?? publicId,
        preview: false,
        vendor: model.vendor ?? "unknown",
        version: "1",
        model_picker_enabled: model.pickerEnabled ?? true,
        model_picker_category: model.pickerCategory,
        supported_endpoints: (model.endpoints ?? []).map((e) =>
          endpointToSupported(e),
        ),
        capabilities: {
          family:
            providerFromProtocol(conn.protocol)
            ?? (model.vendor ?? "unknown").toLowerCase(),
          object: "capabilities",
          supports: { streaming: true },
          tokenizer: "unknown",
          type: "chat",
        },
      })),
    }
    appendProviderConnectionModels()
    return
  }

  appendProviderConnectionModels()
  if (!state.models) {
    state.models = undefined
  }
}

// 注册 models-stale 监听:saveAccounts / persistProviderConnections 完成后
// 自动触发 cacheModels() 重建缓存,消除调用方的手动 cacheModels() 调用。
onStateChange("models-stale", cacheModels)

function endpointToSupported(endpoint: string): string {
  switch (endpoint) {
    case "chat": {
      return "/chat/completions"
    }
    case "messages": {
      return "/v1/messages"
    }
    case "responses": {
      return "/v1/responses"
    }
    case "embeddings": {
      return "/v1/embeddings"
    }
    default: {
      return `/${endpoint}`
    }
  }
}

type ExposedModel = ReturnType<typeof listExposedPublicModels>[number]

function buildConnectionModelEntry(
  id: string,
  entry: ExposedModel,
): NonNullable<typeof state.models>["data"][number] {
  const vendor = entry.vendor ?? entry.connectionId
  return {
    id,
    object: "model",
    name: entry.name ?? id,
    preview: false,
    vendor,
    version: "1",
    model_picker_enabled: entry.pickerEnabled,
    model_picker_category: entry.pickerCategory,
    supported_endpoints: entry.endpoints.map((e) => endpointToSupported(e)),
    capabilities: {
      family: vendor.toLowerCase(),
      object: "capabilities",
      supports: { streaming: true },
      tokenizer: "unknown",
      type: "chat",
    },
  }
}

function appendProviderConnectionModels(): void {
  const exposed = listExposedPublicModels()
  if (exposed.length === 0) return

  const existing = new Set((state.models?.data ?? []).map((m) => m.id))
  const additions: NonNullable<typeof state.models>["data"] = []
  const autoLbSeen = new Set<string>()

  for (const entry of exposed) {
    // Auto-LB entry: bare publicId (added once, load-balanced across all
    // providers). Provider-pinned ids (connectionId/publicId) are not listed;
    // clients may still send one to target a specific connection, resolved
    // via the route-target build path.
    if (!autoLbSeen.has(entry.publicId)) {
      autoLbSeen.add(entry.publicId)
      if (!existing.has(entry.publicId)) {
        existing.add(entry.publicId)
        additions.push(buildConnectionModelEntry(entry.publicId, entry))
      }
    }
  }

  if (additions.length === 0 && state.models) return
  state.models = {
    object: "list",
    data: [...(state.models?.data ?? []), ...additions],
  }
}

function modelEndpointToPath(e: string): string {
  switch (e) {
    case "chat": {
      return "/chat/completions"
    }
    case "messages": {
      return "/v1/messages"
    }
    case "responses": {
      return "/v1/responses"
    }
    case "embeddings": {
      return "/v1/embeddings"
    }
    case "images": {
      return "/v1/images/generations"
    }
    case "videos": {
      return "/v1/videos/generations"
    }
    default: {
      return "/chat/completions"
    }
  }
}

function modelMappingToAccountModel(
  m: ModelMapping,
  provider: Account["provider"],
): AccountModel {
  return {
    id: m.publicId,
    upstreamId: m.upstreamId,
    name: m.name ?? m.publicId,
    vendor: m.vendor ?? "unknown",
    pickerEnabled: m.pickerEnabled ?? true,
    pickerCategory: m.pickerCategory,
    supportedEndpoints: (m.endpoints ?? []).map((e) => modelEndpointToPath(e)),
    provider,
  }
}

/**
 * 遗留兼容函数：接收 Account 参数刷新模型列表。
 * 新代码应优先使用 refreshModelsForConnection（直接接收 ProviderConnection）。
 * 保留此函数是为了渐进式迁移调用点，避免一次性破坏所有调用方。
 */
export async function refreshModelsForAccount(account: Account): Promise<void> {
  initializeProviderRegistry()
  // Phase 3:通过 connection 调用 runtime.refreshModels
  const conn = getProviderConnection(account.id)
  if (!conn) return
  try {
    const models = await getProviderRuntime(account.provider).refreshModels(
      conn,
    )
    // 将 ModelMapping[] 转回 AccountModel[] 以保持 account.availableModels 兼容
    account.availableModels = models.map((m) =>
      modelMappingToAccountModel(m, account.provider),
    )
    logger.debug(
      `Models for "${account.label}": ${(account.availableModels ?? []).map((m) => m.id).join(", ")}`,
    )
    // Guard against background refresh re-adding accounts that were removed
    // by test cleanup (setTestAccounts([]) / removeProviderConnection).
    if (getProviderConnection(account.id)) {
      upsertProviderConnection(migrateAccountsToConnections([account])[0])
      await saveAccounts()
    }
  } catch (error) {
    logger.warn(
      `Failed to refresh models for account "${account.label}":`,
      error,
    )

    const fallbackModels = getProviderRuntime(
      account.provider,
    ).getFallbackModels?.(conn)
    if (!fallbackModels) {
      return
    }

    account.availableModels = fallbackModels.map((m) =>
      modelMappingToAccountModel(m, account.provider),
    )
    if (getProviderConnection(account.id)) {
      upsertProviderConnection(migrateAccountsToConnections([account])[0])
      await saveAccounts()
    }
  }
}

/**
 * Phase 3:直接从 ProviderConnection 刷新模型列表。
 * runtime.refreshModels 现在收 ProviderConnection,返回 ModelMapping[]。
 */
export async function refreshModelsForConnection(
  conn: import("~/lib/provider-connections").ProviderConnection,
): Promise<void> {
  // Note: ProviderConnection type imported via inline to avoid circular type issues
  initializeProviderRegistry()
  const provider = providerFromProtocol(conn.protocol)
  if (!provider) return
  try {
    const models = await getProviderRuntime(provider).refreshModels(conn)
    conn.models = models
    logger.debug(
      `Models for "${conn.name}": ${models.map((m) => m.publicId).join(", ")}`,
    )
    if (getProviderConnection(conn.id)) {
      upsertProviderConnection(conn)
      await persistProviderConnections()
    }
  } catch (error) {
    logger.warn(
      `Failed to refresh models for connection "${conn.name}":`,
      error,
    )

    const fallbackModels =
      getProviderRuntime(provider).getFallbackModels?.(conn)
    if (!fallbackModels) {
      return
    }

    conn.models = fallbackModels
    if (getProviderConnection(conn.id)) {
      upsertProviderConnection(conn)
      await persistProviderConnections()
    }
  }
}

export async function refreshModelsForAllAccounts(): Promise<void> {
  // 用 listAccountManagedConnections + refreshModelsForConnection 替代原
  // listAccounts + refreshModelsForAccount 路径，直接操作 connection
  const results = await Promise.allSettled(
    listAccountManagedConnections().map((conn) =>
      refreshModelsForConnection(conn),
    ),
  )
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("Failed to refresh models for connection:", result.reason)
    }
  }
}

export function scheduleModelsRefresh(): void {
  void refreshModelsForAllAccounts()
  globalTimers.interval(() => {
    void refreshModelsForAllAccounts()
  }, MODELS_REFRESH_INTERVAL_MS)
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  logger.info(`Using VSCode version: ${response}`)
}

/**
 * 取 baseUrl 的 origin(协议+host+端口),供请求日志记录上游来源。
 * 解析失败返回 undefined,避免把含 path/query 的原始串写进日志泄露信息。
 */
export function safeOrigin(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    return new URL(baseUrl).origin
  } catch {
    return undefined
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException)
    && error.name === "AbortError"
  )
}

export function isChatCompletionResponse(
  response: object,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}

export function shouldFailover(error: unknown): boolean {
  if (!(error instanceof HTTPError)) return false
  const classified = classifyUpstreamError({
    status: error.response.status,
    headers: error.response.headers,
    body: error.responseBody,
  })
  // A depleted credential cannot serve this request. Mark it exhausted in
  // dispatch, then rotate to another eligible credential/account.
  if (classified.kind === "quota_exhausted") return true
  if (classified.kind === "auth_error") return true
  if (classified.kind === "rate_limited") return true
  if (classified.kind === "server_error") return true
  return false
}

export function isValidIp(ip: string): boolean {
  if (!ip) return false
  const ipv4Regex = /^(?:\d{1,3}\.){3}\d{1,3}$/
  const ipv6Regex = /^(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i
  return ipv4Regex.test(ip) || ipv6Regex.test(ip)
}

export function isPrivateIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") {
    return true
  }
  // IPv4 Private Ranges
  if (ip.startsWith("0.")) {
    return true
  }
  if (ip.startsWith("10.")) {
    return true
  }
  if (ip.startsWith("169.254.")) {
    return true
  }
  if (ip.startsWith("192.168.")) {
    return true
  }
  if (ip.startsWith("172.")) {
    const parts = ip.split(".")
    if (parts.length >= 2) {
      const second = Number.parseInt(parts[1], 10)
      if (second >= 16 && second <= 31) {
        return true
      }
    }
  }
  // IPv6 Link-Local and Private Ranges
  const ipLower = ip.toLowerCase()
  if (
    ipLower.startsWith("fe80:")
    || ipLower.startsWith("fc00:")
    || ipLower.startsWith("fd00:")
  ) {
    return true
  }
  return false
}

function getIpFromProxyHeaders(c: Context): string | null {
  const cfIp = c.req.header("cf-connecting-ip")
  if (cfIp && isValidIp(cfIp) && !isPrivateIp(cfIp)) return cfIp

  const forwarded = c.req.header("x-forwarded-for")
  if (forwarded) {
    const parts = forwarded.split(",").map((ip) => ip.trim())
    for (let i = parts.length - 1; i >= 0; i--) {
      const ip = parts[i]
      if (ip && isValidIp(ip) && !isPrivateIp(ip)) {
        return ip
      }
    }
    const rightmostIp = parts.at(-1)
    if (rightmostIp && isValidIp(rightmostIp)) return rightmostIp
  }

  const realIp = c.req.header("x-real-ip")
  if (realIp && isValidIp(realIp) && !isPrivateIp(realIp)) return realIp

  return null
}

export function getClientIp(c: Context): string {
  const trustProxy =
    process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1"

  let remoteAddress = "127.0.0.1"
  try {
    const connInfo = getConnInfo(c)
    if (connInfo.remote.address) {
      remoteAddress = connInfo.remote.address
    }
  } catch {
    // Ignore error
  }

  const isLocalConnection =
    remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1"

  // When behind a reverse proxy on the same machine (connection is from localhost),
  // proxy headers are inherently trusted — the proxy is local and cannot be spoofed
  // by external clients. This is the common case for nginx/Caddy/Traefik setups.
  if (trustProxy || isLocalConnection) {
    const proxyIp = getIpFromProxyHeaders(c)
    if (proxyIp) return proxyIp
  }

  return remoteAddress
}
