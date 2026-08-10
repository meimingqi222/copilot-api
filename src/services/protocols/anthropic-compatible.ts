/**
 * Anthropic-compatible Protocol Adapter。
 *
 * 适用于任何遵循 Anthropic `/v1/messages` 协议的上游(官方 Anthropic、
 * 国内代理、企业 Bedrock 代理等)。Adapter 不做请求体翻译,只代理传输,
 * 上层(`src/routes/messages/handler.ts`)在调用前已经处理了路径分支。
 */

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import {
  buildBaseHeaders,
  detectAnthropicStreamError,
  handleUpstreamFailure,
  joinUrl,
  safeSseStream,
} from "~/services/protocols/shared"

import type { AdapterMessagesResult, ProtocolAdapter } from "./types"

function buildHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
  ctx?: {
    anthropicVersion?: string
    anthropicBeta?: string
    sessionId?: string
    promptCacheKey?: string
  },
): Record<string, string> {
  const headers = buildBaseHeaders(connection, credential)
  headers["anthropic-version"] = ctx?.anthropicVersion ?? "2023-06-01"
  if (ctx?.anthropicBeta) {
    headers["anthropic-beta"] = ctx.anthropicBeta
  }
  if (ctx?.sessionId) headers["x-claude-code-session-id"] = ctx.sessionId
  if (ctx?.promptCacheKey) headers["prompt_cache_key"] = ctx.promptCacheKey
  if (credential.authMode !== "bearer") {
    delete headers["Authorization"]
    const headerName = credential.headerName ?? "x-api-key"
    headers[headerName] = credential.value
  }
  return headers
}

export const anthropicCompatibleAdapter: ProtocolAdapter = {
  protocol: "anthropic-compatible",

  async createMessages({
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
  }) {
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
        sessionId:
          forwardedHeaders["x-claude-code-session-id"]
          ?? forwardedHeaders["session_id"]
          ?? forwardedHeaders["session-id"],
        promptCacheKey: forwardedHeaders["prompt_cache_key"],
      }),
      body: JSON.stringify(upstreamPayload),
      signal,
    })

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create messages",
        "anthropic-compatible",
      )
    }

    if (isStream) {
      const stream = await safeSseStream(response, detectAnthropicStreamError)
      return {
        credentialId: credential.id,
        response: stream as unknown as AsyncIterable<unknown>,
      } satisfies AdapterMessagesResult
    }
    const body = (await response.json()) as Record<string, unknown>
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterMessagesResult
  },

  async discoverModels({ connection, credential, signal }) {
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
        "anthropic-compatible",
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
