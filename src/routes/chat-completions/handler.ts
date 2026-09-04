import type { Context } from "hono"

import { randomUUID } from "node:crypto"

import { canonicalModelId } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import {
  beginMemoryTrace,
  endMemoryTrace,
  updateMemoryTrace,
} from "~/lib/memory-diagnostics"
import { connectionProvider } from "~/lib/provider-connections"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { readJsonBody } from "~/lib/request-body"
import { patchRequestLog } from "~/lib/request-log"
import { state } from "~/lib/state"
import {
  parseThinkingModel,
  thinkingConfigToReasoningEffort,
} from "~/lib/thinking"
import { applyUsageIdentity } from "~/lib/usage"
import { isChatCompletionResponse } from "~/lib/utils"
import {
  type ChatCompletionsPayload,
  extractMessageContentFromChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { dispatchChatCompletions } from "~/services/dispatch/chat-completions"

import { inferInitiatorFromOpenAIMessages } from "./initiator"
import { handleNonStreamingResponse } from "./non-streaming"
import {
  extractChatForwardedHeaders,
  handleStreamingResponse,
  handleStreamingCompletion,
} from "./streaming"
import { applyMaxTokens, calculateTokens } from "./usage"

// 重新导出以保持公共 API 不变（测试从 handler 导入 hasChatChunkOutput）
export { hasChatChunkOutput } from "./streaming"

export async function handleCompletion(c: Context) {
  const memoryTraceId = randomUUID()
  const declaredBytes = Number(c.req.header("content-length"))
  beginMemoryTrace({
    traceId: memoryTraceId,
    kind: "chat_completions_http",
    stage: "chat_body_read_start",
    details: {
      declaredBytes:
        Number.isFinite(declaredBytes) && declaredBytes >= 0 ?
          declaredBytes
        : undefined,
    },
  })

  try {
    return await handleCompletionWithTrace(c, memoryTraceId)
  } catch (error) {
    endMemoryTrace(memoryTraceId, "error")
    throw error
  }
}

async function handleCompletionWithTrace(c: Context, memoryTraceId: string) {
  const signal = c.req.raw.signal
  let payload = await readJsonBody<ChatCompletionsPayload>(c.req.raw)
  updateMemoryTrace(memoryTraceId, "chat_payload_parsed", {
    model: payload.model,
    messageCount: payload.messages.length,
    toolCount: payload.tools?.length ?? 0,
    streaming: Boolean(payload.stream),
  })
  if (logger.level >= 4) {
    logger.debug("Request payload summary:", {
      model: payload.model,
      messageCount: payload.messages.length,
      toolCount: payload.tools?.length ?? 0,
      stream: payload.stream === true,
    })
  }

  const parsedThinkingModel = parseThinkingModel(payload.model)
  const suffixEffort =
    parsedThinkingModel.config ?
      thinkingConfigToReasoningEffort(parsedThinkingModel.config)
    : undefined
  const normalizedModel =
    payload.model ? canonicalModelId(parsedThinkingModel.model) : ""
  payload = {
    ...payload,
    model: normalizedModel || "gpt-5-mini",
    ...(parsedThinkingModel.config ? { reasoning_effort: suffixEffort } : {}),
  }

  const messageContent =
    extractMessageContentFromChatCompletionsPayload(payload)
  const sessionHeaders = extractChatForwardedHeaders(c)
  updateMemoryTrace(memoryTraceId, "chat_admission_start")
  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: payload.model,
    endpoint: "chat",
    maxTokens:
      typeof payload.max_tokens === "number" ? payload.max_tokens : undefined,
    stream: payload.stream === true ? true : undefined,
    inferredInitiator: inferInitiatorFromOpenAIMessages(
      payload.messages,
      c.req.header("user-agent"),
    ),
    messageContent,
    sessionHeaders,
    sessionPayload: payload,
  })
  updateMemoryTrace(memoryTraceId, "chat_admission_ready", {
    provider: connectionProvider(admission.connection),
    accountId: admission.connection.id,
  })

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  payload = applyMaxTokens(payload, selectedModel)

  if (!payload.stream) {
    updateMemoryTrace(memoryTraceId, "chat_token_estimate_start")
    const estimatedInputTokens = await calculateTokens(payload, selectedModel)
    updateMemoryTrace(memoryTraceId, "chat_token_estimated", {
      estimatedInputTokens,
    })
    const nonStreamStart = Date.now()
    updateMemoryTrace(memoryTraceId, "chat_dispatch_start")
    const result = await dispatchChatCompletions(
      payload,
      admission,
      signal,
      c,
      { forwardedHeaders: sessionHeaders, memoryTraceId },
    )
    updateMemoryTrace(memoryTraceId, "chat_provider_response_open", {
      provider: result.identity.provider,
      streaming: !isChatCompletionResponse(result.response),
    })

    applyUsageIdentity(c, result.identity)
    c.set("model", payload.model)
    patchRequestLog(c, { streaming: false })

    if (isChatCompletionResponse(result.response)) {
      const elapsed = Date.now() - nonStreamStart
      handleNonStreamingResponse(
        c,
        result.response,
        estimatedInputTokens,
        elapsed,
      )
      endMemoryTrace(memoryTraceId, "completed")
      return c.json(result.response)
    }

    return handleStreamingResponse({
      c,
      response: result.response,
      estimatedInputTokens,
      memoryTraceId,
      streamStartTs: nonStreamStart,
    })
  }

  updateMemoryTrace(memoryTraceId, "chat_token_estimate_start")
  const estimatedInputTokens = await calculateTokens(payload, selectedModel)
  updateMemoryTrace(memoryTraceId, "chat_token_estimated", {
    estimatedInputTokens,
  })

  return handleStreamingCompletion(c, {
    payload,
    admission,
    signal,
    selectedModel,
    estimatedInputTokens,
    memoryTraceId,
  })
}
