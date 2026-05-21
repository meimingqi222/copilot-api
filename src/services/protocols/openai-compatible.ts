/**
 * OpenAI-compatible Protocol Adapter。
 *
 * 适用于任何遵循 OpenAI v1 协议的上游(DeepSeek、OpenRouter、SiliconFlow、
 * 自建 vLLM 等)。Adapter 不感知具体服务商,只根据 ProviderConnection
 * 配置(baseUrl、headers)与 ApiCredential(authMode/value)构造请求。
 */

import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { EmbeddingResponse } from "~/services/copilot/create-embeddings"

import { HTTPError } from "~/lib/error"
import {
  classifyUpstreamError,
  markCredentialAuthError,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  persistProviderConnections,
  DEFAULTS,
  type ApiCredential,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"

import type {
  AdapterChatResult,
  AdapterEmbeddingsResult,
  ProtocolAdapter,
} from "./types"

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "")
  const trimmedPath = path.startsWith("/") ? path : `/${path}`
  return `${trimmedBase}${trimmedPath}`
}

function buildHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...connection.headers,
  }

  if (credential.authMode === "bearer") {
    headers["Authorization"] = `Bearer ${credential.value}`
  } else {
    const headerName = credential.headerName ?? "Authorization"
    headers[headerName] = credential.value
  }
  return headers
}

function classifyDiscoveredModelEndpoints(
  id: string,
): Array<"chat" | "embeddings"> {
  return /embed/i.test(id) ? ["embeddings"] : ["chat"]
}

/** 根据上游错误响应分类并更新 credential 状态。返回原始错误供路由层处理。 */
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

  await persistProviderConnections().catch((err: unknown) => {
    consola.warn(
      "[openai-compatible] failed to persist credential status:",
      (err as Error).message,
    )
  })

  throw new HTTPError(contextMessage, response, body)
}

export const openAICompatibleAdapter: ProtocolAdapter = {
  protocol: "openai-compatible",

  async discoverModels(connection, credential, signal) {
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

  // eslint-disable-next-line max-params
  async createChatCompletions(
    target,
    connection,
    credential,
    payload,
    signal,
    _ctx,
  ) {
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
      )
    }

    if (payload.stream) {
      const stream = events(
        response,
      ) as unknown as AsyncIterable<CopilotStreamEvent>
      return {
        credentialId: credential.id,
        response: stream,
      } satisfies AdapterChatResult
    }

    const body = (await response.json()) as ChatCompletionResponse
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterChatResult
  },

  async createEmbeddings(target, connection, credential, payload, signal) {
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
      )
    }

    const body = (await response.json()) as EmbeddingResponse
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterEmbeddingsResult
  },
}
