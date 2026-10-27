import type { Context } from "hono"

import { getConnInfo } from "hono/bun"

import type { ChatCompletionResponse } from "~/services/protocols/chat/types"

import { HTTPError, UpstreamModelUnavailableError } from "~/lib/error"
import { createLogger } from "~/lib/logger"
import {
  accountManagedProvider,
  classifyUpstreamError,
  getProviderConnection,
  listAccountManagedConnections,
  mergeProviderRefreshedModels,
  persistProviderConnections,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { hasEnabledCredential } from "~/lib/provider-connections/anonymous-credential"
import type { ModelEndpoint } from "~/lib/provider-connections/types"
import {
  listExposedPublicModels,
  type ExposedPublicModel,
} from "~/lib/route-target/build"
import { onStateChange } from "~/lib/state-events"
import { everyMs, runJob } from "~/lib/jobs"
import { globalTimers } from "~/lib/timer-registry"
import { getVSCodeVersion } from "~/services/get-vscode-version"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"
import {
  listWindsurfSupportedEfforts,
  windsurfContextWindow,
} from "~/services/windsurf/variant-collapse"

import { state } from "./state"

const logger = createLogger("models")

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
  // 只收录手动可用的 connection:conn.enabled + 至少一个 credential.enabled。
  // 瞬时 status(cooldown/quota/auth_error)不影响列表,避免限流抖动导致闪烁;
  // 它们的调度过滤由 buildRouteTargets(onlyAvailable) 负责。
  const connectionModels = listAccountManagedConnections()
    .filter((conn) => conn.enabled && hasEnabledCredential(conn))
    .map((conn, originalIndex) => ({ conn, originalIndex }))
    .sort((left, right) => {
      if (left.conn.priority !== right.conn.priority) {
        return left.conn.priority - right.conn.priority
      }
      return left.originalIndex - right.originalIndex
    })
    .flatMap(({ conn }) =>
      (conn.models ?? [])
        .filter((model) => model.enabled !== false && !model.hidden)
        .map((model) => ({ model, conn })),
    )

  // 全量重建:account 部分 + 端点连接部分合并为一次写入。
  // appendProviderConnectionModels 的增量追加语义会导致禁用/删除后的模型
  // 残留在 state.models 里(尤其纯端点连接场景下 connectionModels
  // 为空,旧逻辑直接 early-return,从不收缩列表)。
  let accountData: NonNullable<typeof state.models>["data"] = []
  if (connectionModels.length > 0) {
    const merged = new Map<
      string,
      {
        model: (typeof connectionModels)[number]["model"]
        conn: (typeof connectionModels)[number]["conn"]
        publicId: string
        /** 同一 publicId 各连接档位的交集;任一连接未知时按“未知”处理。 */
        efforts?: Array<string>
      }
    >()
    for (const entry of connectionModels) {
      // Only the bare model id is exposed; routing/auto-LB across providers
      // happens transparently. Clients may still target a specific provider
      // by sending a prefixed id (prefix/model), resolved via
      // buildAccountModelAliases - but it is not listed here.
      const publicId = entry.model.publicId
      // 折叠变体的连接(历史上)只在 metadata 里记档位,没有 efforts 字段。
      const levels =
        entry.model.efforts ?? listWindsurfSupportedEfforts(entry.model)
      const existing = merged.get(publicId)
      if (!existing) {
        merged.set(publicId, {
          model: entry.model,
          conn: entry.conn,
          publicId,
          efforts: levels && levels.length > 0 ? [...levels] : undefined,
        })
        continue
      }
      existing.efforts = intersectEfforts(existing.efforts, levels)
    }

    accountData = Array.from(merged.values()).map(
      ({ model, conn, publicId, efforts }) =>
        buildModelEntry({
          id: publicId,
          name: model.name ?? publicId,
          vendor: model.vendor ?? "unknown",
          family: accountManagedProvider(conn),
          pickerEnabled: model.pickerEnabled ?? true,
          pickerCategory: model.pickerCategory,
          endpoints: model.endpoints ?? [],
          contextWindow: windsurfContextWindow(model),
          efforts,
        }),
    )
  }

  const endpointData = buildProviderConnectionEntries(
    new Set(accountData.map((m) => m.id)),
  )
  const combined = [...accountData, ...endpointData]
  state.models =
    combined.length > 0 ? { object: "list", data: combined } : undefined
}

// 注册 models-stale 监听:persistProviderConnections 完成后
// 自动触发 cacheModels() 重建缓存,消除调用方的手动 cacheModels() 调用。
onStateChange("models-stale", cacheModels)

/** `/v1/models` 的 `capabilities.supports`，档位未知时不写该字段。 */
function modelSupports(efforts: Array<string> | undefined) {
  return {
    streaming: true,
    ...(efforts ? { reasoning_effort: efforts } : {}),
  }
}

/**
 * 同一 publicId 背后多个连接时，对外的档位取交集：这样无论路由落到哪个
 * target，客户端要的档位都被接受。任一侧未知则沿用已知的那一侧——未知只是
 * “上游没说”，按原样转发请求的行为与旧版本一致。
 */
function intersectEfforts(
  current: Array<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): Array<string> | undefined {
  if (!next || next.length === 0) return current
  if (!current) return [...next]
  const kept = current.filter((level) => next.includes(level))
  // 交集为空说明各连接没有一个共同档位：不公布，也不钳制（按旧行为原样转发）。
  return kept.length > 0 ? kept : undefined
}

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

/**
 * `/v1/models` 的一条模型条目。account 连接与 endpoint 连接只在 family、
 * 上下文窗口来源上不同，条目本身的形状只在这里写一次。
 */
function buildModelEntry(input: {
  id: string
  name: string
  vendor: string
  family: string
  pickerEnabled: boolean
  pickerCategory?: string
  endpoints: Array<ModelEndpoint>
  /** 目录点名的上下文窗口（Windsurf 的 `1m` 档）；未知时不写 limits。 */
  contextWindow?: number
  /** 该 publicId 背后所有连接都能接受的档位（provider 声明的交集）。 */
  efforts?: Array<string>
}): NonNullable<typeof state.models>["data"][number] {
  return {
    id: input.id,
    object: "model",
    name: input.name,
    preview: false,
    vendor: input.vendor,
    version: "1",
    model_picker_enabled: input.pickerEnabled,
    model_picker_category: input.pickerCategory,
    supported_endpoints: input.endpoints.map((endpoint) =>
      endpointToSupported(endpoint),
    ),
    capabilities: {
      family: input.family,
      object: "capabilities",
      ...(input.contextWindow === undefined ?
        {}
      : { limits: { max_context_window_tokens: input.contextWindow } }),
      supports: modelSupports(input.efforts),
      tokenizer: "unknown",
      type: "chat",
    },
  }
}

/**
 * 基于当前已过滤的 exposed 列表构建端点连接条目(纯函数,不读写
 * state.models)。调用方传入已占用的 id 集合用于去重,返回新增条目。
 */
function buildProviderConnectionEntries(
  existing: Set<string>,
): NonNullable<typeof state.models>["data"] {
  // Auto-LB entry: bare publicId (added once, load-balanced across all
  // providers). Provider-pinned ids (connectionId/publicId) are not listed;
  // clients may still send one to target a specific connection, resolved
  // via the route-target build path. 同一 publicId 的档位取交集后再公布。
  const byPublicId = new Map<
    string,
    { entry: ExposedPublicModel; efforts?: Array<string> }
  >()
  for (const entry of listExposedPublicModels()) {
    const merged = byPublicId.get(entry.publicId)
    if (!merged) {
      byPublicId.set(entry.publicId, {
        entry,
        efforts: entry.efforts ? [...entry.efforts] : undefined,
      })
      continue
    }
    merged.efforts = intersectEfforts(merged.efforts, entry.efforts)
  }

  const additions: NonNullable<typeof state.models>["data"] = []
  for (const [publicId, { entry, efforts }] of byPublicId) {
    if (existing.has(publicId)) continue
    existing.add(publicId)
    const vendor = entry.vendor ?? entry.connectionId
    additions.push(
      buildModelEntry({
        id: publicId,
        name: entry.name ?? publicId,
        vendor,
        family: vendor.toLowerCase(),
        pickerEnabled: entry.pickerEnabled,
        pickerCategory: entry.pickerCategory,
        endpoints: entry.endpoints,
        efforts,
      }),
    )
  }
  return additions
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
  // codebuddy / codebuddy-cn 共用协议，必须用 metadata 优先的派生，否则
  // 国际版连接会拿到国内版 fallback 模型
  const provider = accountManagedProvider(conn)
  try {
    const models = await getProviderRuntime(provider).refreshModels(conn)
    // provider 全量覆盖时保留用户层配置(改名/禁用/别名),见
    // mergeProviderRefreshedModels。
    conn.models = mergeProviderRefreshedModels(conn.models, models)
    logger.debug(
      `Models for "${conn.name}": ${(conn.models ?? []).map((m) => m.publicId).join(", ")}`,
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

    conn.models = mergeProviderRefreshedModels(conn.models, fallbackModels)
    if (getProviderConnection(conn.id)) {
      upsertProviderConnection(conn)
      await persistProviderConnections()
    }
  }
}

export async function refreshModelsForAllAccounts(): Promise<void> {
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
  const refresh = () =>
    runJob("models-refresh", () => refreshModelsForAllAccounts(), {
      label: "Model list refresh",
      schedule: everyMs(MODELS_REFRESH_INTERVAL_MS),
    }).catch(() => {})
  void refresh()
  globalTimers.interval(() => void refresh(), MODELS_REFRESH_INTERVAL_MS)
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
  if (error instanceof UpstreamModelUnavailableError) return true
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

function isValidIp(ip: string): boolean {
  if (!ip) return false
  const ipv4Regex = /^(?:\d{1,3}\.){3}\d{1,3}$/
  const ipv6Regex = /^(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i
  return ipv4Regex.test(ip) || ipv6Regex.test(ip)
}

function isPrivateIp(ip: string): boolean {
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
