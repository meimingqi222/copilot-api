import type { Context } from "hono"

import { getConnInfo } from "hono/bun"

import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import { saveAccounts } from "~/lib/account-store"
import { listAccounts } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  classifyUpstreamError,
  getProviderConnection,
  migrateAccountsToConnections,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { listExposedPublicModels } from "~/lib/route-target/build"
import { onStateChange } from "~/lib/state-events"
import { globalTimers } from "~/lib/timer-registry"
import { getVSCodeVersion } from "~/services/get-vscode-version"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

import type { Account } from "./accounts"

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
  const accountModels = listAccounts()
    .map((account, originalIndex) => ({ account, originalIndex }))
    .sort((left, right) => {
      if (left.account.priority !== right.account.priority) {
        return left.account.priority - right.account.priority
      }
      return left.originalIndex - right.originalIndex
    })
    .flatMap(({ account }) =>
      (account.availableModels ?? []).map((model) => ({ model, account })),
    )

  if (accountModels.length > 0) {
    const merged = new Map<
      string,
      {
        model: (typeof accountModels)[number]["model"]
        publicId: string
      }
    >()
    for (const entry of accountModels) {
      // Only the bare model id is exposed; routing/auto-LB across providers
      // happens transparently. Clients may still target a specific provider
      // by sending a prefixed id (prefix/model), resolved via
      // buildAccountModelAliases - but it is not listed here.
      const publicId = entry.model.id
      if (!merged.has(publicId)) {
        merged.set(publicId, {
          model: entry.model,
          publicId,
        })
      }
    }

    state.models = {
      object: "list",
      data: Array.from(merged.values()).map(({ model, publicId }) => ({
        id: publicId,
        object: "model",
        name: model.name,
        preview: false,
        vendor: model.vendor,
        version: "1",
        model_picker_enabled: model.pickerEnabled,
        model_picker_category: model.pickerCategory,
        supported_endpoints: model.supportedEndpoints,
        capabilities: {
          family: model.provider || model.vendor.toLowerCase(),
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

export async function refreshModelsForAccount(account: Account): Promise<void> {
  initializeProviderRegistry()
  try {
    account.availableModels = await getProviderRuntime(
      account.provider,
    ).refreshModels(account)
    logger.debug(
      `Models for "${account.label}": ${account.availableModels.map((m) => m.id).join(", ")}`,
    )
    // Guard against background refresh re-adding accounts that were removed
    // by test cleanup (setTestAccounts([]) / removeProviderConnection).
    // Use migrateAccountsToConnections (accountToConnectionForPersistence)
    // to preserve credentialExtras and all metadata fields.
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
    ).getFallbackModels?.(account)
    if (!fallbackModels) {
      return
    }

    account.availableModels = fallbackModels
    if (getProviderConnection(account.id)) {
      upsertProviderConnection(migrateAccountsToConnections([account])[0])
      await saveAccounts()
    }
  }
}

export async function refreshModelsForAllAccounts(): Promise<void> {
  const results = await Promise.allSettled(
    listAccounts().map((account) => refreshModelsForAccount(account)),
  )
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("Failed to refresh models for account:", result.reason)
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
  // quota_exhausted (incl. Codex usage_limit_reached) should NOT
  // failover: the credential's plan quota is depleted, and switching
  // accounts breaks cache affinity. Let the client handle it.
  // NOTE: 402 (Payment Required) is classified as quota_exhausted but
  // historically triggered failover. Preserve that behavior.
  if (classified.kind === "quota_exhausted") {
    if (error.response.status === 402) return true
    return false
  }
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
