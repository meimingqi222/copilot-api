import {
  performanceFetch as fetch,
  readUpstreamJson,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"

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
  connectionFetchInit,
  detectAnthropicStreamError,
  handleUpstreamFailure,
  joinUrl,
  removeHeader,
  safeSseStream,
  setHeader,
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
  setHeader(headers, "anthropic-version", ctx?.anthropicVersion ?? "2023-06-01")
  if (ctx?.anthropicBeta) {
    setHeader(headers, "anthropic-beta", ctx.anthropicBeta)
  }
  if (ctx?.sessionId)
    setHeader(headers, "x-claude-code-session-id", ctx.sessionId)
  if (ctx?.promptCacheKey)
    setHeader(headers, "prompt_cache_key", ctx.promptCacheKey)
  if (credential.authMode !== "bearer") {
    removeHeader(headers, "Authorization")
    const headerName = credential.headerName ?? "x-api-key"
    setHeader(headers, headerName, credential.value)
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

    const response = await fetch(
      joinUrl(connection.baseUrl, "/messages"),
      connectionFetchInit(connection, {
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
        body: serializeUpstreamBody(upstreamPayload),
        signal,
      }),
    )

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
    const body = (await readUpstreamJson(response)) as Record<string, unknown>
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterMessagesResult
  },

  async discoverModels({ connection, credential, signal }) {
    // Anthropic 没有统一模型发现端点:配置了自定义 endpoint 就用它;
    // 没配时使用 `/models`，由 joinUrl 按需补 /v1，避免版本后缀重复。
    //
    // 官方 Anthropic 与兼容供应商（Kimi Coding 等）都在 /v1 下提供该
    // 列表,而预设声明了 fetchable:true 就该真的能拉模型。不支持的上游
    // 会 404/405,由调用方把状态码报给用户,好过静默返回空列表。
    const endpoint = connection.modelDiscovery?.endpoint || "/models"
    const url =
      /^https?:/i.test(endpoint) ? endpoint : (
        joinUrl(connection.baseUrl, endpoint)
      )
    const response = await fetch(
      url,
      connectionFetchInit(connection, {
        headers: buildHeaders(connection, credential),
        signal,
      }),
    )
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
