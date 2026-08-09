/**
 * OpenAI-compatible Protocol Adapter。
 *
 * 适用于任何遵循 OpenAI v1 协议的上游(DeepSeek、OpenRouter、SiliconFlow、
 * 自建 vLLM 等)。Adapter 不感知具体服务商,只根据 ProviderConnection
 * 配置(baseUrl、headers)与 ApiCredential(authMode/value)构造请求。
 */

import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { EmbeddingResponse } from "~/services/copilot/create-embeddings"

import {
  type ApiCredential,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  buildBaseHeaders,
  detectOpenAIStreamError,
  handleUpstreamFailure,
  joinUrl,
  safeSseStream,
} from "~/services/protocols/shared"

import type {
  AdapterChatResult,
  AdapterEmbeddingsResult,
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
): Array<"chat" | "embeddings"> {
  return /embed/i.test(id) ? ["embeddings"] : ["chat"]
}

export const openAICompatibleAdapter: ProtocolAdapter = {
  protocol: "openai-compatible",

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
        "openai-compatible",
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
        "openai-compatible",
      )
    }

    if (payload.stream) {
      const stream = await safeSseStream(response, detectOpenAIStreamError)
      return {
        credentialId: credential.id,
        response: stream as unknown as AsyncIterable<CopilotStreamEvent>,
      } satisfies AdapterChatResult
    }

    const raw = (await response.json()) as Record<string, unknown>
    // Some upstreams (e.g. Cline Pass) wrap the standard OpenAI response
    // in a `data` envelope. Unwrap it so downstream code sees a normal
    // ChatCompletionResponse with top-level `choices`.
    const body = (raw.data ?? raw) as ChatCompletionResponse
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterChatResult
  },

  async createEmbeddings({ target, connection, credential, payload, signal }) {
    const upstreamPayload = {
      ...payload,
      model: target.upstreamModelId,
    }

    const response = await fetch(joinUrl(connection.baseUrl, "/embeddings"), {
      method: "POST",
      headers: buildHeaders(connection, credential),
      body: JSON.stringify(upstreamPayload),
      signal,
    })

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create embeddings",
        "openai-compatible",
      )
    }

    const rawEmb = (await response.json()) as Record<string, unknown>
    const body = (rawEmb.data ?? rawEmb) as EmbeddingResponse
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterEmbeddingsResult
  },
}
