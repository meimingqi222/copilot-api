/**
 * Shared helper for serving Anthropic Messages requests via a Chat Completions
 * upstream. Mirrors `chat-via-responses.ts`: converts an Anthropic Messages
 * payload -> Chat Completions payload, delegates to the adapter's
 * `createChatCompletions`, then converts the Chat result back to Anthropic
 * format (streaming or non-streaming).
 *
 * Used by the dispatch layer when a `/v1/messages` request fails over to a
 * target whose adapter only implements `createChatCompletions` (e.g. an
 * openai-compatible connection), so cross-protocol fallback is transparent.
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"
import { LocalPayloadUnsupportedError } from "~/lib/error"
import { planTranslation, recordTranslationLosses } from "~/services/ir"
import {
  decodeChatResponse,
  decodeChatStream,
  decodeMessagesRequest,
  encodeChatRequest,
  encodeMessagesResponse,
  encodeMessagesStream,
} from "~/services/ir/codecs/messages-chat"
import {
  needsSearchOrchestration,
  runSearchAwareResult,
  runSearchAwareStream,
} from "~/services/search/orchestrate"
import { listSearchers } from "~/services/search/searcher"

import { wireSpec } from "./wire-pairs"

import type { AdapterChatResult, AdapterMessagesResult } from "./types"

import type { AnthropicMessagesPayload } from "./anthropic"

interface ChatExecutorParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}

type ChatExecutor = (params: ChatExecutorParams) => Promise<AdapterChatResult>

interface MessagesViaChatParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: AnthropicMessagesPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  chatExecutor: ChatExecutor
}

/** A non-streaming ChatCompletionResponse is a plain object; a stream has asyncIterator. */
function isChatCompletionResponse(
  value: unknown,
): value is ChatCompletionResponse {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(Symbol.asyncIterator in value)
  )
}

export async function createMessagesViaChat(
  params: MessagesViaChatParams,
): Promise<AdapterMessagesResult> {
  const { target, connection, credential, payload, signal, ctx, chatExecutor } =
    params

  // Preserve historical thinking for non-Copilot upstreams: DeepSeek thinking
  // mode + tool calls REQUIRES reasoning_content round-trip (else 400), and
  // Kimi/Qwen/xAI accept it. copilot-native rejects reasoning in history,
  // but it never reaches this path (it implements createMessages natively) —
  // the guard keeps the behavior explicit and future-proof.
  const request = decodeMessagesRequest(payload)
  const searchers = listSearchers()
  const orchestrate =
    searchers.length > 0 && needsSearchOrchestration(request, "chat")
  const plan = planTranslation(request, {
    wire: "chat",
    providerId: connection.protocol,
    model: target.upstreamModelId,
    issuer: connection.id,
    ...(orchestrate && { orchestratedWebSearch: true }),
  })
  recordTranslationLosses(ctx?.c, plan.losses)
  if (!plan.accepted) {
    throw new LocalPayloadUnsupportedError(
      plan.losses.records
        .filter((record) => record.action === "reject")
        .map((record) => record.reason)
        .join("; ") || "Chat target cannot preserve the request",
    )
  }
  // Ask the producer for its structured delta twin so the stream translator
  // below can skip re-parsing SSE JSON it just serialized (per-token win on
  // long streams; other adapters ignore the hint and stay on the JSON path).
  const executeChat = (chatPayload: ChatCompletionsPayload) =>
    chatExecutor({
      target,
      connection,
      credential,
      payload: chatPayload,
      signal,
      ctx: { ...ctx, collectChatStreamTwin: true },
    })

  if (orchestrate) {
    const searchParams = {
      request,
      spec: wireSpec("chat"),
      searchers,
      execute: (chatPayload: unknown) =>
        executeChat(chatPayload as ChatCompletionsPayload),
      signal,
      initiator: ctx?.initiator,
    }
    if (payload.stream === true) {
      const anthropicStream = (async function* (): AsyncIterable<{
        data: string
        event: string
      }> {
        for await (const event of encodeMessagesStream(
          runSearchAwareStream(searchParams),
          estimateInputTokens(payload),
        ))
          yield { data: JSON.stringify(event), event: event.type }
      })()
      return { credentialId: credential.id, response: anthropicStream }
    }
    const { credentialId, result: orchestrated } =
      await runSearchAwareResult(searchParams)
    return {
      credentialId,
      response: encodeMessagesResponse(orchestrated) as unknown as Record<
        string,
        unknown
      >,
    }
  }

  let openAIPayload: ChatCompletionsPayload
  try {
    openAIPayload = encodeChatRequest(request, {
      preserveHistoricalReasoning: target.protocol !== "copilot-native",
      stream: payload.stream,
    })
  } catch (error) {
    throw new LocalPayloadUnsupportedError(
      error instanceof Error ?
        error.message
      : "Chat target cannot encode the request",
    )
  }
  const result = await executeChat(openAIPayload)

  if (isChatCompletionResponse(result.response)) {
    const anthropicResponse = encodeMessagesResponse(
      decodeChatResponse(result.response),
    )
    return {
      credentialId: result.credentialId,
      response: anthropicResponse as unknown as Record<string, unknown>,
    }
  }

  // Streaming: translate each Chat chunk into Anthropic events and yield them
  // as SSE frames ({data, event}) — the shape every messages-protocol
  // consumer (connection-handler) and sibling adapters (safeSseStream) use.
  // Yielding raw event objects instead silently drops every frame at the
  // consumer's `if (!event.data) continue` guard.
  const upstream = result.response as AsyncIterable<CopilotStreamEvent>
  const anthropicStream = (async function* (): AsyncIterable<{
    data: string
    event: string
  }> {
    for await (const event of encodeMessagesStream(
      decodeChatStream(upstream),
      estimateInputTokens(payload),
    )) {
      yield { data: JSON.stringify(event), event: event.type }
    }
  })()
  return { credentialId: result.credentialId, response: anthropicStream }
}

/** Rough input-token estimate for message_start fallback (char/4 heuristic). */
export function estimateInputTokens(payload: AnthropicMessagesPayload): number {
  let chars = 0
  if (payload.system) {
    if (typeof payload.system === "string") chars += payload.system.length
    else for (const block of payload.system) chars += block.text.length
  }
  for (const message of payload.messages) {
    if (typeof message.content === "string") chars += message.content.length
    else
      for (const block of message.content)
        if ("text" in block) chars += block.text.length
  }
  return Math.ceil(chars / 4)
}
