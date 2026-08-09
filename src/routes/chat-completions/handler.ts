import type { Context } from "hono"

import { randomUUID } from "node:crypto"

import type { RequestAdmission } from "~/lib/request-admission"

import { canonicalModelId } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  beginMemoryTrace,
  endMemoryTrace,
  updateMemoryTrace,
} from "~/lib/memory-diagnostics"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { readJsonBody } from "~/lib/request-body"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import { handleSseStream, writeSseEvent } from "~/lib/sse"
import { state } from "~/lib/state"
import {
  parseThinkingModel,
  thinkingConfigToReasoningEffort,
} from "~/lib/thinking"
import { computeStreamingTiming } from "~/lib/timing"
import { getTokenCount } from "~/lib/tokenizer"
import { applyUsageIdentity, recordUsage } from "~/lib/usage"
import { isChatCompletionResponse, isNullish } from "~/lib/utils"
import {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  extractMessageContentFromChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { dispatchChatCompletions } from "~/services/dispatch/chat-completions"

import { inferInitiatorFromOpenAIMessages } from "./initiator"
import { normalizeChunk, normalizeResponse } from "./normalize"

type CopilotStream = AsyncIterable<{ data?: string }>
type CachedModel = NonNullable<typeof state.models>["data"][number]

/**
 * Extracts session-related headers from the incoming request for forwarding
 * to upstream providers. Different providers use different session header
 * conventions:
 * - Antigravity/Gemini: `session_id`, `x-antigravity-session-id`
 * - Windsurf: `x-windsurf-session-id`, `session_id`
 * - xAI: `x-grok-conv-id`
 * - Claude (via chat→messages translation): `x-claude-code-session-id`
 */
function extractChatForwardedHeaders(
  c: Context,
): Record<string, string | undefined> {
  return {
    session_id: c.req.header("session_id") ?? c.req.header("session-id"),
    "x-antigravity-session-id": c.req.header("x-antigravity-session-id"),
    "x-windsurf-session-id": c.req.header("x-windsurf-session-id"),
    "x-grok-conv-id": c.req.header("x-grok-conv-id"),
    "x-claude-code-session-id": c.req.header("x-claude-code-session-id"),
    prompt_cache_key: c.req.header("prompt_cache_key"),
  }
}

interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
}

interface StreamUsageInput {
  c: Context
  accountId?: string
  model?: string
  lastUsage?: UsageInfo
  estimatedInputTokens: number
  onlyWhenUsageExists?: boolean
  timing?: { ttftMs: number; tps: number }
  finishReason?: string
}

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
    provider: admission.account?.provider ?? admission.target.protocol,
    accountId: admission.account?.id ?? admission.target.credentialId,
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

    return handleStreamingResponse(
      c,
      result.response,
      estimatedInputTokens,
      memoryTraceId,
    )
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

async function calculateTokens(
  payload: ChatCompletionsPayload,
  selectedModel: CachedModel | undefined,
): Promise<number> {
  try {
    if (!selectedModel) {
      logger.warn("No model selected, skipping token count calculation")
      return 0
    }

    const tokenCount = await getTokenCount(payload, selectedModel)
    // Local estimate only — not upstream billing. `input` includes all
    // messages (assistant history included); `history` is the assistant
    // subset of that total.
    logger.info(
      `Estimated input tokens: ${tokenCount.input} (history: ${tokenCount.history})`,
    )
    return tokenCount.input
  } catch (error) {
    logger.warn("Failed to calculate token count:", error)
    return 0
  }
}

function applyMaxTokens(
  payload: ChatCompletionsPayload,
  selectedModel: CachedModel | undefined,
): ChatCompletionsPayload {
  if (isNullish(payload.max_tokens)) {
    const newPayload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits?.max_output_tokens,
    }
    logger.debug("Set max_tokens to:", JSON.stringify(newPayload.max_tokens))
    return newPayload
  }
  return payload
}

function handleNonStreamingResponse(
  c: Context,
  response: ChatCompletionResponse,
  estimatedInputTokens: number,
  elapsedMs?: number,
): void {
  if (logger.level >= 4) {
    logger.debug("Non-streaming response:", JSON.stringify(response))
  }
  const normalized = normalizeResponse(response)
  const usage = normalized.usage
  const model = c.get("model")
  const accountId = c.get("accountId")

  if (usage && model && accountId) {
    // prompt_tokens is the total input, including cache reads and cache
    // creation. The repo extends prompt_tokens_details with
    // cache_creation_input_tokens (Anthropic's cache-write concept), so
    // subtract both from the total when reporting non-cached prompt tokens.
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
    const cacheWriteTokens =
      usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0
    const tps =
      elapsedMs && elapsedMs > 0 ?
        usage.completion_tokens / (elapsedMs / 1000)
      : undefined
    recordUsage({
      c,
      accountId,
      model,
      promptTokens: Math.max(
        usage.prompt_tokens - cacheReadTokens - cacheWriteTokens,
        0,
      ),
      completionTokens: usage.completion_tokens,
      totalTokens: calculateTotalTokens(usage),
      cacheReadTokens,
      cacheWriteTokens,
      tps,
      streaming: false,
      finishReason: normalized.choices[0]?.finish_reason,
    })
  } else if (model && accountId) {
    recordUsage({
      c,
      accountId,
      model,
      promptTokens: estimatedInputTokens,
      completionTokens: 0,
      totalTokens: estimatedInputTokens,
      tps: 0,
      streaming: false,
    })
  }

  Object.assign(response, normalized)
}

function handleStreamingResponse(
  c: Context,
  response: CopilotStream,
  estimatedInputTokens: number,
  memoryTraceId: string,
) {
  logger.debug("Streaming response")
  const model = c.get("model")
  const accountId = c.get("accountId")

  // Guard: if the upstream returned a non-iterable object (e.g. an error
  // body without a `choices` field that failed isChatCompletionResponse),
  // surface it as an explicit error instead of crashing with
  // "undefined is not a function" on `for await`.
  const respAny = response as unknown as
    | AsyncIterable<unknown>
    | { [Symbol.asyncIterator]?: unknown }
    | null
    | undefined
  if (
    respAny === null
    || typeof respAny === "undefined"
    || typeof respAny[Symbol.asyncIterator] !== "function"
  ) {
    const body =
      typeof response === "object" ? JSON.stringify(response) : String(response)
    logger.error(
      `Upstream returned a non-iterable response in non-stream path: ${body.slice(0, 500)}`,
    )
    return c.json(
      {
        error: {
          message:
            "Upstream returned an unexpected response format (no choices and not a stream). See server logs for details.",
          type: "upstream_response_error",
          upstream_body: body.slice(0, 1000),
        },
      },
      502,
    )
  }

  let lastUsage: UsageInfo | undefined
  let usageRecorded = false
  let firstChunkTs: number | undefined
  let downstreamCommitted = false
  let lastFinishReason: string | undefined
  const streamStart = Date.now()

  return handleSseStream(
    c,
    async (stream) => {
      let outcome = "completed"
      try {
        updateMemoryTrace(memoryTraceId, "chat_sse_open")
        for await (const rawEvent of response) {
          if (rawEvent.data === "[DONE]") {
            break
          }
          if (!rawEvent.data) {
            continue
          }

          if (!firstChunkTs) {
            firstChunkTs = Date.now()
            updateMemoryTrace(memoryTraceId, "chat_first_chunk")
          }

          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
          if (logger.level >= 4) {
            logger.debug("Streaming raw event:", JSON.stringify(rawEvent))
          }
          if (chunk.usage) {
            lastUsage = chunk.usage
          }
          const chunkFinishReason = chunk.choices[0]?.finish_reason
          if (chunkFinishReason) {
            lastFinishReason = chunkFinishReason
          }
          await writeSseEvent(stream, JSON.stringify(normalizeChunk(chunk)))
          if (!downstreamCommitted) {
            downstreamCommitted = true
            updateMemoryTrace(memoryTraceId, "chat_downstream_committed", {
              responseMode: "streaming",
            })
          }
        }
      } catch (error) {
        outcome = signalOutcome(c.req.raw.signal)
        throw error
      } finally {
        if (!usageRecorded) {
          usageRecorded = recordStreamingUsage({
            c,
            accountId,
            model,
            lastUsage,
            estimatedInputTokens,
            onlyWhenUsageExists: true,
            timing: computeStreamingTiming(
              streamStart,
              firstChunkTs,
              lastUsage?.completion_tokens ?? 0,
            ),
            finishReason: lastFinishReason,
          })
        }
        endMemoryTrace(memoryTraceId, outcome)
      }
    },
    {
      onAbort: () => {
        usageRecorded = recordStreamingUsage({
          c,
          accountId,
          model,
          lastUsage,
          estimatedInputTokens,
          onlyWhenUsageExists: true,
          timing: computeStreamingTiming(
            streamStart,
            firstChunkTs,
            lastUsage?.completion_tokens ?? 0,
          ),
          finishReason: lastFinishReason ?? "aborted",
        })
      },
    },
  )
}

function recordStreamingUsage(input: StreamUsageInput): boolean {
  const {
    c,
    accountId,
    model,
    lastUsage,
    estimatedInputTokens,
    onlyWhenUsageExists = false,
    timing,
    finishReason,
  } = input
  if (!accountId || !model) {
    return false
  }

  if (lastUsage) {
    const cacheReadTokens = lastUsage.prompt_tokens_details?.cached_tokens ?? 0
    const cacheWriteTokens =
      lastUsage.prompt_tokens_details?.cache_creation_input_tokens ?? 0
    recordUsage({
      c,
      accountId,
      model,
      promptTokens: Math.max(
        lastUsage.prompt_tokens - cacheReadTokens - cacheWriteTokens,
        0,
      ),
      completionTokens: lastUsage.completion_tokens,
      totalTokens: calculateTotalTokens(lastUsage),
      cacheReadTokens,
      cacheWriteTokens,
      ttftMs: timing?.ttftMs,
      tps: timing?.tps,
      streaming: true,
      finishReason,
    })
    return true
  }

  if (onlyWhenUsageExists) {
    return false
  }

  recordUsage({
    c,
    accountId,
    model,
    promptTokens: estimatedInputTokens,
    completionTokens: 0,
    totalTokens: estimatedInputTokens,
    tps: 0,
    ttftMs: timing?.ttftMs,
    streaming: true,
    finishReason,
  })
  return true
}

function calculateTotalTokens(usage: UsageInfo): number {
  return usage.total_tokens
}

interface StreamingCompletionOptions {
  payload: ChatCompletionsPayload
  admission: RequestAdmission
  signal: AbortSignal | undefined
  selectedModel: CachedModel | undefined
  estimatedInputTokens: number
  memoryTraceId: string
}

function handleStreamingCompletion(
  c: Context,
  options: StreamingCompletionOptions,
) {
  let lastUsage: UsageInfo | undefined
  let usageRecorded = false
  let accountId: string | undefined
  let firstChunkTs: number | undefined
  let downstreamCommitted = false
  let lastFinishReason: string | undefined
  let streamStart = 0
  return handleSseStream(
    c,
    async (stream) => {
      const { payload, admission, signal, estimatedInputTokens } = options
      const model = payload.model
      let outcome = "completed"

      try {
        updateMemoryTrace(options.memoryTraceId, "chat_sse_open")
        const dispatchStart = Date.now()
        updateMemoryTrace(options.memoryTraceId, "chat_dispatch_start")
        const result = await dispatchChatCompletions(
          payload,
          admission,
          signal,
          c,
          {
            forwardedHeaders: extractChatForwardedHeaders(c),
            memoryTraceId: options.memoryTraceId,
          },
        )
        updateMemoryTrace(
          options.memoryTraceId,
          "chat_provider_response_open",
          {
            provider: result.identity.provider,
            streaming: !isChatCompletionResponse(result.response),
          },
        )
        accountId = result.accountId
        applyUsageIdentity(c, result.identity)

        c.set("accountId", accountId)
        c.set("model", model)

        if (isChatCompletionResponse(result.response)) {
          const elapsed = Date.now() - dispatchStart
          handleNonStreamingResponse(
            c,
            result.response,
            estimatedInputTokens,
            elapsed,
          )
          await writeSseEvent(stream, JSON.stringify(result.response))
          usageRecorded = true
          updateMemoryTrace(
            options.memoryTraceId,
            "chat_downstream_committed",
            {
              responseMode: "non_streaming",
            },
          )
          return
        }

        streamStart = dispatchStart
        for await (const rawEvent of result.response) {
          if (rawEvent.data === "[DONE]") {
            break
          }
          if (!rawEvent.data) {
            continue
          }

          if (!firstChunkTs) {
            firstChunkTs = Date.now()
            updateMemoryTrace(options.memoryTraceId, "chat_first_chunk")
          }

          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
          if (logger.level >= 4) {
            logger.debug("Streaming raw event:", JSON.stringify(rawEvent))
          }
          if (chunk.usage) {
            lastUsage = chunk.usage
          }
          const chunkFinishReason = chunk.choices[0]?.finish_reason
          if (chunkFinishReason) {
            lastFinishReason = chunkFinishReason
          }
          await writeSseEvent(stream, JSON.stringify(normalizeChunk(chunk)))
          if (!downstreamCommitted) {
            downstreamCommitted = true
            updateMemoryTrace(
              options.memoryTraceId,
              "chat_downstream_committed",
              { responseMode: "streaming" },
            )
          }
        }
      } catch (error) {
        outcome = signalOutcome(signal)
        logger.error("Streaming error:", error)
        const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
        if (knownError?.status === 499) {
          return
        }
        const errorMessage =
          knownError?.message
          ?? (error instanceof Error ? error.message : "Internal server error")
        const errorType =
          knownError?.type
          ?? (error instanceof HTTPError && error.response.status === 429 ?
            "rate_limit_error"
          : "error")
        await writeSseEvent(
          stream,
          JSON.stringify({
            error: {
              message: errorMessage,
              type: errorType,
            },
          }),
        )
        throw error
      } finally {
        if (!usageRecorded) {
          recordStreamingUsage({
            c,
            accountId,
            model,
            lastUsage,
            estimatedInputTokens,
            onlyWhenUsageExists: true,
            timing: computeStreamingTiming(
              streamStart,
              firstChunkTs,
              lastUsage?.completion_tokens ?? 0,
            ),
            finishReason: lastFinishReason,
          })
        }
        endMemoryTrace(options.memoryTraceId, outcome)
      }
    },
    {
      onAbort: () => {
        usageRecorded = recordStreamingUsage({
          c,
          accountId,
          model: options.payload.model,
          lastUsage,
          estimatedInputTokens: options.estimatedInputTokens,
          onlyWhenUsageExists: true,
          timing: computeStreamingTiming(
            streamStart,
            firstChunkTs,
            lastUsage?.completion_tokens ?? 0,
          ),
          finishReason: lastFinishReason ?? "aborted",
        })
      },
    },
  )
}

function signalOutcome(signal: AbortSignal | undefined): string {
  return signal?.aborted ? "aborted" : "error"
}
