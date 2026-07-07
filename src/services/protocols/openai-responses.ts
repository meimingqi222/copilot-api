/**
 * OpenAI Responses-compatible Protocol Adapter。
 *
 * 适用于任何遵循 OpenAI Responses API(`/v1/responses`)协议的上游
 * (OpenAI 官方、以及兼容该协议的第三方服务)。同时支持 Chat Completions
 * 端点,便于在同一 connection 上为不同模型分别启用 `chat` / `responses`。
 *
 * 与 `openai-compatible` 的区别:本 adapter 额外实现 `createResponses`,
 * 让 `/v1/responses` 客户端请求可直接路由到外部 Provider Connection,无需
 * Account 路径或 chat→responses 翻译。
 */

import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type {
  CopilotStreamEventLike,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import {
  type ApiCredential,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  buildBaseHeaders,
  detectOpenAIStreamError,
  detectResponsesStreamError,
  handleUpstreamFailure,
  joinUrl,
  safeSseStream,
} from "~/services/protocols/shared"

import type {
  AdapterChatResult,
  AdapterResponsesResult,
  ProtocolAdapter,
} from "./types"

function buildHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
): Record<string, string> {
  return buildBaseHeaders(connection, credential)
}

function classifyDiscoveredModelEndpoints(
  id: string,
): Array<"chat" | "responses" | "embeddings"> {
  if (/embed/i.test(id)) return ["embeddings"]
  // Default: expose both chat and responses so /v1/chat/completions and
  // /v1/responses clients can both route to discovered models. Users can
  // trim endpoints per-model in the admin UI if the upstream lacks one.
  return ["chat", "responses"]
}

export const openAIResponsesCompatibleAdapter: ProtocolAdapter = {
  protocol: "openai-responses-compatible",

  async discoverModels({ connection, credential, signal }) {
    const endpoint =
      connection.modelDiscovery?.endpoint
      ?? joinUrl(connection.baseUrl, "/models")
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
        "openai-responses-compatible",
      )
    }

    const body = (await response.json()) as {
      data?: Array<{ id: string; object?: string; owned_by?: string }>
    }
    if (!body.data || !Array.isArray(body.data)) {
      return []
    }
    return body.data
      .filter((m) => typeof m.id === "string")
      .map<ModelMapping>((m) => ({
        publicId: m.id,
        upstreamId: m.id,
        vendor: m.owned_by,
        endpoints: classifyDiscoveredModelEndpoints(m.id),
        enabled: true,
        pickerEnabled: true,
      }))
  },

  async createChatCompletions({
    target,
    connection,
    credential,
    payload,
    signal,
  }) {
    const upstreamPayload = {
      ...payload,
      model: target.upstreamModelId,
    }

    const response = await fetch(
      joinUrl(connection.baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: buildHeaders(connection, credential),
        body: JSON.stringify(upstreamPayload),
        signal,
      },
    )

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create chat completions",
        "openai-responses-compatible",
      )
    }

    if (payload.stream) {
      const stream = await safeSseStream(response, detectOpenAIStreamError)
      return {
        credentialId: credential.id,
        response: stream as unknown as AsyncIterable<CopilotStreamEvent>,
      } satisfies AdapterChatResult
    }

    const body = (await response.json()) as ChatCompletionResponse
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterChatResult
  },

  async createResponses({ target, connection, credential, payload, signal }) {
    const upstreamPayload = {
      ...payload,
      model: target.upstreamModelId,
    }

    const response = await fetch(joinUrl(connection.baseUrl, "/responses"), {
      method: "POST",
      headers: buildHeaders(connection, credential),
      body: JSON.stringify(upstreamPayload),
      signal,
    })

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create responses",
        "openai-responses-compatible",
      )
    }

    if (payload.stream) {
      const stream = await safeSseStream(response, detectResponsesStreamError)
      return {
        credentialId: credential.id,
        response: stream as unknown as AsyncIterable<CopilotStreamEventLike>,
      } satisfies AdapterResponsesResult
    }

    const body = (await response.json()) as ResponsesResponse
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterResponsesResult
  },
}
