/**
 * Anthropic-compatible Protocol Adapter。
 *
 * 适用于任何遵循 Anthropic `/v1/messages` 协议的上游(官方 Anthropic、
 * 国内代理、企业 Bedrock 代理等)。Adapter 不做请求体翻译,只代理传输,
 * 上层(`src/routes/messages/handler.ts`)在调用前已经处理了路径分支。
 */

import { events } from "fetch-event-stream"

import { HTTPError } from "~/lib/error"
import {
  classifyUpstreamError,
  markCredentialAuthError,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  persistProviderConnections,
  DEFAULTS,
  type ApiCredential,
  type ProviderConnection,
} from "~/lib/provider-connections"

import type { AdapterMessagesResult, ProtocolAdapter } from "./types"

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "")
  const trimmedPath = path.startsWith("/") ? path : `/${path}`
  return `${trimmedBase}${trimmedPath}`
}

function buildHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
  ctx?: { anthropicVersion?: string; anthropicBeta?: string },
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "anthropic-version": ctx?.anthropicVersion ?? "2023-06-01",
    ...connection.headers,
  }
  if (ctx?.anthropicBeta) {
    headers["anthropic-beta"] = ctx.anthropicBeta
  }
  if (credential.authMode === "bearer") {
    headers["Authorization"] = `Bearer ${credential.value}`
  } else {
    // 多数 Anthropic 兼容服务使用 `x-api-key`
    const headerName = credential.headerName ?? "x-api-key"
    headers[headerName] = credential.value
  }
  return headers
}

async function handleUpstreamFailure(
  response: Response,
  credential: ApiCredential,
  contextMessage: string,
): Promise<never> {
  const body = await response
    .clone()
    .text()
    .catch(() => "")
  const classified = classifyUpstreamError({
    status: response.status,
    retryAfterHeader: response.headers.get("retry-after"),
    body,
  })
  switch (classified.kind) {
    case "rate_limited": {
      markCredentialCooldown(credential, {
        retryAfterMs: classified.retryAfterMs,
        reason: `HTTP ${response.status}`,
      })
      break
    }
    case "auth_error": {
      markCredentialAuthError(
        credential,
        `HTTP ${response.status}: ${body.slice(0, 200)}`,
      )
      break
    }
    case "quota_exhausted": {
      markCredentialQuotaExhausted(
        credential,
        `HTTP ${response.status}: ${body.slice(0, 200)}`,
      )
      break
    }
    case "server_error": {
      markCredentialCooldown(credential, {
        retryAfterMs: classified.retryAfterMs ?? DEFAULTS.COOLDOWN_5XX_MS,
        reason: `HTTP ${response.status}`,
      })
      break
    }
    default: {
      break
    }
  }
  await persistProviderConnections().catch(() => {})
  throw new HTTPError(contextMessage, response, body)
}

export const anthropicCompatibleAdapter: ProtocolAdapter = {
  protocol: "anthropic-compatible",

  // eslint-disable-next-line max-params
  async createMessages(target, connection, credential, payload, signal, ctx) {
    const upstreamPayload = {
      ...payload,
      model: target.upstreamModelId,
    }
    const isStream = Boolean(payload.stream)

    const forwardedHeaders = ctx?.forwardedHeaders ?? {}

    const response = await fetch(joinUrl(connection.baseUrl, "/messages"), {
      method: "POST",
      headers: buildHeaders(connection, credential, {
        anthropicVersion: forwardedHeaders["anthropic-version"],
        anthropicBeta: forwardedHeaders["anthropic-beta"],
      }),
      body: JSON.stringify(upstreamPayload),
      signal,
    })

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create messages",
      )
    }

    if (isStream) {
      return {
        credentialId: credential.id,
        response: events(response) as unknown as AsyncIterable<unknown>,
      } satisfies AdapterMessagesResult
    }
    const body = (await response.json()) as Record<string, unknown>
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterMessagesResult
  },

  async discoverModels(connection, credential, signal) {
    // Anthropic 没有统一模型发现端点;只有当用户配置了自定义 endpoint 才尝试。
    if (!connection.modelDiscovery?.endpoint) return []
    const endpoint = connection.modelDiscovery.endpoint
    const url =
      /^https?:/i.test(endpoint) ? endpoint : (
        joinUrl(connection.baseUrl, endpoint)
      )
    const response = await fetch(url, {
      headers: buildHeaders(connection, credential),
      signal,
    })
    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to discover models",
      )
    }
    const body = (await response.json()) as {
      data?: Array<{ id: string }>
      models?: Array<{ id: string }>
    }
    const ids = body.data ?? body.models ?? []
    return ids
      .filter((m) => typeof m.id === "string")
      .map((m) => ({
        publicId: m.id,
        upstreamId: m.id,
        endpoints: ["messages"] as Array<"messages">,
        enabled: true,
        pickerEnabled: true,
      }))
  },
}

export { type AnthropicMessagesPayload } from "./types"
