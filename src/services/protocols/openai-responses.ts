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
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { logger } from "~/lib/logger"
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

import {
  buildStatelessRequestInput,
  getStatelessTranscript,
  normalizeResponsesInputToItems,
  recordStatelessTranscript,
  snoopResponsesStreamForTranscript,
} from "./openai-responses-transcript"

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

    // 部分第三方 responses 实现不支持有状态链式调用:带
    // `previous_response_id` 直接 400(如 atria 的 `upstream_error`)。
    // 连接开启 `stripPreviousResponseId` 时:命中本地转录本就合并成自包含
    // input 再转发(记忆保留,见 openai-responses-transcript.ts),未命中则
    // 退化为无状态请求(只含本轮 input)。`previous_response_id` 是可选
    // 特性,官方 OpenAI / xAI 链路默认透传,不受影响。
    let recordedInput: Array<unknown> | undefined
    let recordedInstructions: string | undefined
    if (connection.stripPreviousResponseId) {
      const previousId =
        typeof payload.previous_response_id === "string" ?
          payload.previous_response_id.trim()
        : ""
      // 翻译链路(target.isTranslated,即 chat 客户端经 createChatViaResponses
      // 进来):chat 协议没有 previous_response_id,客户端拿到翻译后的 chat 响应
      // 后绝不会链式引用——不重放(避免污染 chat 自带的全量历史)、不记账(避免
      // 挤占真实 responses 会话的预算),只 strip 防上游 400。
      const replayable = target.isTranslated !== true
      if (previousId && replayable) {
        const cached = getStatelessTranscript(connection.id, previousId)
        if (cached) {
          upstreamPayload.input = buildStatelessRequestInput(
            cached.input,
            normalizeResponsesInputToItems(payload.input),
          ) as ResponsesPayload["input"]
          if (
            upstreamPayload.instructions === undefined
            && cached.instructions !== undefined
          ) {
            upstreamPayload.instructions = cached.instructions
          }
          logger.debug(
            `[openai-responses-compatible] replayed transcript for previous_response_id on connection "${connection.id}"`,
          )
        } else {
          logger.debug(
            `[openai-responses-compatible] no transcript for previous_response_id on connection "${connection.id}", sending stateless`,
          )
        }
      }
      upstreamPayload.previous_response_id = undefined
      if (replayable) {
        // 记下本轮实际发出的全量,供下一轮链式引用(成功才落盘,见下)。
        recordedInput = normalizeResponsesInputToItems(upstreamPayload.input)
        recordedInstructions = upstreamPayload.instructions
      }
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
      if (recordedInput) {
        return {
          credentialId: credential.id,
          response: snoopResponsesStreamForTranscript(
            stream as unknown as AsyncIterable<CopilotStreamEventLike>,
            {
              connectionId: connection.id,
              input: recordedInput,
              instructions: recordedInstructions,
            },
          ),
        } satisfies AdapterResponsesResult
      }
      return {
        credentialId: credential.id,
        response: stream as unknown as AsyncIterable<CopilotStreamEventLike>,
      } satisfies AdapterResponsesResult
    }

    const body = (await response.json()) as ResponsesResponse
    if (recordedInput) {
      const responseId = typeof body.id === "string" ? body.id.trim() : ""
      if (responseId) {
        recordStatelessTranscript({
          connectionId: connection.id,
          responseId,
          input: recordedInput,
          output: Array.isArray(body.output) ? body.output : [],
          instructions: recordedInstructions,
        })
      }
    }
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterResponsesResult
  },
}
