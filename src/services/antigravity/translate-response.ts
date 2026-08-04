import { randomUUID } from "node:crypto"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import { cacheSignature } from "~/lib/cache/signature-cache"

const MAX_ACCUMULATED_THINKING_BYTES = 32 * 1024 * 1024

export interface AntigravityStreamState {
  created: number
  responseId: string
  functionIndex: number
  sawToolCall: boolean
  upstreamFinishReason: string
  /** Accumulated thinking text across stream chunks for signature caching. */
  accumulatedThinkingText: string
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function getArray(value: unknown): Array<unknown> | undefined {
  return Array.isArray(value) ? value : undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function createChunkTemplate(
  model: string,
  state: AntigravityStreamState,
): ChatCompletionChunk {
  return {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
}

function mapFinishReason(
  upstream: string,
  sawToolCall: boolean,
): "stop" | "length" | "tool_calls" {
  if (sawToolCall) {
    return "tool_calls"
  }
  if (upstream === "MAX_TOKENS") {
    return "length"
  }
  return "stop"
}

function applyUsage(
  chunk: ChatCompletionChunk,
  usage: Record<string, unknown> | undefined,
): void {
  if (!usage) {
    return
  }
  const promptTokens = getNumber(usage.promptTokenCount) ?? 0
  const completionTokens = getNumber(usage.candidatesTokenCount) ?? 0
  const totalTokens =
    getNumber(usage.totalTokenCount) ?? promptTokens + completionTokens
  const thoughtsTokens = getNumber(usage.thoughtsTokenCount)
  const cachedTokens = getNumber(usage.cachedContentTokenCount)

  chunk.usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  }
  if (thoughtsTokens && thoughtsTokens > 0) {
    chunk.usage.completion_tokens_details = { reasoning_tokens: thoughtsTokens }
  }
  if (cachedTokens && cachedTokens > 0) {
    chunk.usage.prompt_tokens_details = { cached_tokens: cachedTokens }
  }
}

export function createAntigravityStreamState(
  _model?: string,
): AntigravityStreamState {
  return {
    created: Math.floor(Date.now() / 1000),
    responseId: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    functionIndex: 0,
    sawToolCall: false,
    upstreamFinishReason: "",
    accumulatedThinkingText: "",
  }
}

export function convertAntigravityStreamChunk(
  event: Record<string, unknown>,
  model: string,
  state: AntigravityStreamState,
): Array<ChatCompletionChunk> {
  // Cache thoughtSignatures from response parts for replay in future turns.
  void cacheResponseSignatures(event, model, state)
  const response = getRecord(event.response)
  if (!response) {
    return []
  }

  const modelVersion = getString(response.modelVersion)
  const resolvedModel = modelVersion ?? model
  const chunk = createChunkTemplate(resolvedModel, state)

  const createTime = getString(response.createTime)
  if (createTime) {
    const parsed = Date.parse(createTime)
    if (Number.isFinite(parsed)) {
      state.created = Math.floor(parsed / 1000)
      chunk.created = state.created
    }
  }

  const responseId = getString(response.responseId)
  if (responseId) {
    state.responseId = responseId
    chunk.id = responseId
  }

  const candidates = getArray(response.candidates)
  const candidate = candidates?.[0]
  const candidateRecord = getRecord(candidate)
  const finishReason = getString(candidateRecord?.finishReason)
  if (finishReason) {
    state.upstreamFinishReason = finishReason.toUpperCase()
  }

  const parts = getArray(getRecord(candidateRecord?.content)?.parts)
  for (const rawPart of parts ?? []) {
    const part = getRecord(rawPart)
    if (!part) {
      continue
    }

    const thoughtSignature = getString(
      part.thoughtSignature ?? part.thought_signature,
    )
    const hasText = getString(part.text) !== undefined
    const hasFunction =
      getRecord(part.functionCall ?? part.function_call) !== undefined
    if (thoughtSignature && !hasText && !hasFunction) {
      continue
    }

    const text = getString(part.text)
    if (text) {
      chunk.choices[0].delta.role = "assistant"
      if (part.thought === true) {
        chunk.choices[0].delta.reasoning_content = text
      } else {
        chunk.choices[0].delta.content = text
      }
    }

    const functionCall = getRecord(part.functionCall ?? part.function_call)
    if (functionCall) {
      state.sawToolCall = true
      chunk.choices[0].delta.role = "assistant"
      const name = getString(functionCall.name) ?? "function"
      const args = functionCall.args
      chunk.choices[0].delta.tool_calls = [
        {
          index: state.functionIndex,
          id: `${name}-${Date.now()}-${state.functionIndex}`,
          type: "function",
          function: {
            name,
            arguments:
              args && typeof args === "object" ? JSON.stringify(args) : "{}",
          },
        },
      ]
      state.functionIndex += 1
    }
  }

  const usage = getRecord(response.usageMetadata ?? response.usage_metadata)
  const isFinal = state.upstreamFinishReason !== "" && usage !== undefined
  if (isFinal) {
    chunk.choices[0].finish_reason = mapFinishReason(
      state.upstreamFinishReason,
      state.sawToolCall,
    )
    applyUsage(chunk, usage)
  }

  return [chunk]
}

export function convertAntigravityNonStreamResponse(
  event: Record<string, unknown>,
  model: string,
): ChatCompletionResponse {
  // Cache thoughtSignatures from response parts for replay in future turns.
  // Non-stream: use a temporary state since all parts are in one event.
  void cacheResponseSignatures(
    event,
    model,
    createAntigravityStreamState(model),
  )

  const response = getRecord(event.response) ?? event
  const modelVersion = getString(response.modelVersion) ?? model
  const responseId =
    getString(response.responseId)
    ?? `chatcmpl-${randomUUID().replaceAll("-", "")}`
  const createTime = getString(response.createTime)
  const created =
    createTime ?
      Math.floor(Date.parse(createTime) / 1000)
    : Math.floor(Date.now() / 1000)

  let content = ""
  let reasoning = ""
  const toolCalls: ChatCompletionResponse["choices"][number]["message"]["tool_calls"] =
    []
  let finishReason: "stop" | "length" | "tool_calls" = "stop"

  const candidates = getArray(response.candidates)
  const candidate = getRecord(candidates?.[0])
  const upstreamFinish =
    getString(candidate?.finishReason)?.toUpperCase() ?? "STOP"
  if (upstreamFinish === "MAX_TOKENS") {
    finishReason = "length"
  }

  const parts = getArray(getRecord(candidate?.content)?.parts)
  for (const rawPart of parts ?? []) {
    const part = getRecord(rawPart)
    if (!part) {
      continue
    }
    const text = getString(part.text)
    if (text) {
      if (part.thought === true) {
        reasoning += text
      } else {
        content += text
      }
    }
    const functionCall = getRecord(part.functionCall ?? part.function_call)
    if (functionCall) {
      const name = getString(functionCall.name) ?? "function"
      const args = functionCall.args
      toolCalls.push({
        id: `${name}-${Date.now()}-${toolCalls.length}`,
        type: "function",
        function: {
          name,
          arguments:
            args && typeof args === "object" ? JSON.stringify(args) : "{}",
        },
      })
    }
  }

  if (toolCalls.length > 0) {
    finishReason = "tool_calls"
  }

  const usageRecord = getRecord(
    response.usageMetadata ?? response.usage_metadata,
  )
  const usage =
    usageRecord ?
      {
        prompt_tokens: getNumber(usageRecord.promptTokenCount) ?? 0,
        completion_tokens: getNumber(usageRecord.candidatesTokenCount) ?? 0,
        total_tokens: getNumber(usageRecord.totalTokenCount) ?? 0,
        ...(getNumber(usageRecord.thoughtsTokenCount) ?
          {
            completion_tokens_details: {
              reasoning_tokens: getNumber(usageRecord.thoughtsTokenCount),
            },
          }
        : {}),
        ...(getNumber(usageRecord.cachedContentTokenCount) ?
          {
            prompt_tokens_details: {
              cached_tokens: getNumber(usageRecord.cachedContentTokenCount),
            },
          }
        : {}),
      }
    : undefined

  return {
    id: responseId,
    object: "chat.completion",
    created,
    model: modelVersion,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

/**
 * Extracts thoughtSignature + thinking text pairs from an Antigravity
 * response event and caches them for replay in future requests.
 */
async function cacheResponseSignatures(
  event: Record<string, unknown>,
  model: string,
  state: AntigravityStreamState,
): Promise<void> {
  const response = getRecord(event.response) ?? event
  const candidates = getArray(response.candidates)
  const candidate = getRecord(candidates?.[0])
  if (!candidate) return
  const parts = getArray(getRecord(candidate.content)?.parts)
  if (!parts) return

  for (const rawPart of parts) {
    const part = getRecord(rawPart)
    if (!part) continue

    // Accumulate thinking text across stream chunks
    const text = getString(part.text)
    if (text && part.thought) {
      const next = state.accumulatedThinkingText + text
      if (Buffer.byteLength(next) > MAX_ACCUMULATED_THINKING_BYTES) {
        throw new Error("Antigravity thinking exceeds the maximum size")
      }
      state.accumulatedThinkingText = next
    }

    // Cache signature when we have both accumulated text and signature
    const sig = getString(part.thoughtSignature ?? part.thought_signature)
    if (
      sig
      && sig !== "skip_thought_signature_validator"
      && state.accumulatedThinkingText
    ) {
      await cacheSignature(model, state.accumulatedThinkingText, sig)
      state.accumulatedThinkingText = "" // Reset after caching
    }
  }
}
