/**
 * Non-streaming Windsurf responses: drains the same generator the streaming
 * path uses and folds it into one ChatCompletionResponse.
 *
 * Split out of `create-chat-completions.ts` to keep that file under the
 * max-lines cap; nothing here is used by the streaming path.
 */

import { randomUUID } from "node:crypto"

import type {
  ChatCompletionResponse,
  ContentPart,
  CopilotStreamEvent,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"

/**
 * Ceiling for a single non-streaming response held in memory. The default
 * suits a normal host; on a small one (1GB VPS) a couple of concurrent
 * requests at this size are enough to push the process into swap, so it is
 * tunable.
 *
 * `WINDSURF_MAX_RESPONSE_MB` only lowers the ceiling — values above the 32MB
 * default are clamped away, since the point of the knob is to cap worst-case
 * memory, not to raise it. It lowers the ordered-parts budget below with it;
 * that budget covers the same data kept a second time to preserve block order,
 * and has its own 4MB cap that the env var cannot lift. Overflowing it is not
 * lossy: `orderedPartsComplete` flips to false and the response falls back to
 * flat text, losing only the reasoning/content interleaving.
 */
function readResponseLimitBytes(): number {
  const raw = process.env.WINDSURF_MAX_RESPONSE_MB?.trim()
  const fallback = 32 * 1024 * 1024
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(fallback, parsed * 1024 * 1024)
}

const MAX_COLLECTED_RESPONSE_BYTES = readResponseLimitBytes()
const MAX_ORDERED_PARTS = 8192
const MAX_ORDERED_RESPONSE_BYTES = Math.min(
  4 * 1024 * 1024,
  MAX_COLLECTED_RESPONSE_BYTES,
)

type OrderedResponsePart = {
  kind: "content" | "reasoning"
  text: string
  signature?: string
}

function appendOrderedResponsePart(
  parts: Array<OrderedResponsePart>,
  kind: OrderedResponsePart["kind"],
  text: string,
  currentBytes: number,
): number | undefined {
  const nextBytes = currentBytes + Buffer.byteLength(text)
  if (nextBytes > MAX_ORDERED_RESPONSE_BYTES) return undefined
  const previous = parts.at(-1)
  if (previous?.kind === kind) {
    previous.text += text
    return nextBytes
  }
  if (parts.length >= MAX_ORDERED_PARTS) return undefined
  parts.push({ kind, text })
  return nextBytes
}

// ── Non-streaming collector ────────────────────────────────────────────────────

/**
 * Structured twin of an emitted SSE chunk, attached so the non-streaming
 * collector never has to parse the JSON back out.
 *
 * `collectChatCompletion` consumes the same generator the streaming path uses.
 * Re-parsing every `event.data` it had just serialized cost ~9 MiB of churn per
 * 8k deltas, of which `JSON.parse` was ~8.5 MiB — for a response whose actual
 * text was 0.2 MiB. Serializing stays (the streaming path needs it); only the
 * parse is removed.
 */
interface CollectedDelta {
  content?: string
  reasoningText?: string
  reasoningOpaque?: string
  toolCalls?: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter"
  usage?: ChatCompletionResponse["usage"]
}

export type WindsurfStreamEvent = CopilotStreamEvent & {
  collected?: CollectedDelta
}

interface CollectedToolCall {
  id: string
  name: string
  arguments: string
  /** Running UTF-8 size of `arguments`, to avoid re-measuring it per delta. */
  argumentBytes: number
}

function updateToolCalls(
  toolCallMap: Map<number, CollectedToolCall>,
  deltaToolCalls: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>,
): void {
  for (const tc of deltaToolCalls) {
    if (tc.id && tc.function?.name !== undefined) {
      const args = tc.function.arguments ?? ""
      const argumentBytes = Buffer.byteLength(args)
      if (argumentBytes > MAX_COLLECTED_RESPONSE_BYTES) {
        throw new Error("Windsurf tool arguments exceed the maximum size")
      }
      toolCallMap.set(tc.index, {
        id: tc.id,
        name: tc.function.name ?? "",
        arguments: args,
        argumentBytes,
      })
    } else if (tc.function?.arguments !== undefined) {
      const existing = toolCallMap.get(tc.index)
      if (existing) {
        const nextBytes =
          existing.argumentBytes + Buffer.byteLength(tc.function.arguments)
        if (nextBytes > MAX_COLLECTED_RESPONSE_BYTES) {
          throw new Error("Windsurf tool arguments exceed the maximum size")
        }
        existing.arguments += tc.function.arguments
        existing.argumentBytes = nextBytes
      }
    }
  }
}

/**
 * Reads one event's deltas without touching `event.data`.
 *
 * `streamToOpenAI` attaches `collected`; the JSON fallback exists only for
 * events produced elsewhere (e.g. a replayed first frame from a different
 * producer) and for forward-compatibility if a new yield site forgets it.
 */
function readCollectedDelta(event: WindsurfStreamEvent): CollectedDelta {
  if (event.collected) return event.collected
  const chunk = JSON.parse(event.data ?? "{}") as {
    choices?: Array<{
      delta?: {
        content?: string
        reasoning_text?: string
        reasoning_opaque?: string
        tool_calls?: Array<{
          index: number
          id?: string
          type?: string
          function?: { name?: string; arguments?: string }
        }>
      }
      finish_reason?: string | null
    }>
    usage?: ChatCompletionResponse["usage"]
  }
  const delta = chunk.choices?.[0]?.delta
  const finish = chunk.choices?.[0]?.finish_reason
  return {
    ...(delta?.content !== undefined && { content: delta.content }),
    ...(delta?.reasoning_text !== undefined && {
      reasoningText: delta.reasoning_text,
    }),
    ...(delta?.reasoning_opaque !== undefined && {
      reasoningOpaque: delta.reasoning_opaque,
    }),
    ...(delta?.tool_calls && { toolCalls: delta.tool_calls }),
    ...((
      finish === "tool_calls"
      || finish === "length"
      || finish === "content_filter"
      || finish === "stop"
    ) ?
      { finishReason: finish }
    : {}),
    ...(chunk.usage && { usage: chunk.usage }),
  }
}

export async function collectChatCompletion(
  response: AsyncIterable<WindsurfStreamEvent>,
  model: string,
  memoryTraceId?: string,
): Promise<ChatCompletionResponse> {
  let text = ""
  let reasoningText = ""
  let reasoningOpaque = ""
  // Running total of the three accumulators above. Calling Buffer.byteLength on
  // them once per chunk flattens each rope, which turns a long reasoning stream
  // into O(n^2) allocation.
  let collectedBytes = 0
  let sawContentPart = false
  let hasReasoningAfterContent = false
  let orderedPartsComplete = true
  let orderedPartsBytes = 0
  const orderedParts: Array<OrderedResponsePart> = []
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" = "stop"
  let usage: ChatCompletionResponse["usage"] | undefined

  const toolCallMap = new Map<number, CollectedToolCall>()

  updateMemoryTrace(memoryTraceId, "windsurf_collect_start")
  for await (const event of response) {
    if (!event.data || event.data === "[DONE]") continue

    const chunk = readCollectedDelta(event)

    const contentDelta = chunk.content ?? ""
    const reasoningDelta = chunk.reasoningText ?? ""
    text += contentDelta
    reasoningText += reasoningDelta
    collectedBytes +=
      Buffer.byteLength(contentDelta) + Buffer.byteLength(reasoningDelta)
    if (contentDelta) {
      sawContentPart = true
    }
    if (reasoningDelta && sawContentPart) {
      hasReasoningAfterContent = true
    }
    if (contentDelta && orderedPartsComplete) {
      const nextBytes = appendOrderedResponsePart(
        orderedParts,
        "content",
        contentDelta,
        orderedPartsBytes,
      )
      if (nextBytes === undefined) orderedPartsComplete = false
      else orderedPartsBytes = nextBytes
    }
    if (reasoningDelta && orderedPartsComplete) {
      const nextBytes = appendOrderedResponsePart(
        orderedParts,
        "reasoning",
        reasoningDelta,
        orderedPartsBytes,
      )
      if (nextBytes === undefined) orderedPartsComplete = false
      else orderedPartsBytes = nextBytes
    }
    const signatureDelta = chunk.reasoningOpaque ?? ""
    reasoningOpaque += signatureDelta
    collectedBytes += Buffer.byteLength(signatureDelta)
    if (signatureDelta && orderedPartsComplete) {
      const previous = orderedParts.at(-1)
      if (
        previous?.kind === "reasoning"
        && orderedPartsBytes + Buffer.byteLength(signatureDelta)
          <= MAX_ORDERED_RESPONSE_BYTES
      ) {
        previous.signature = `${previous.signature ?? ""}${signatureDelta}`
        orderedPartsBytes += Buffer.byteLength(signatureDelta)
      }
    }
    if (collectedBytes > MAX_COLLECTED_RESPONSE_BYTES) {
      throw new Error("Windsurf response exceeds the maximum size")
    }
    usage = chunk.usage ?? usage

    const finReason = chunk.finishReason
    switch (finReason) {
      case "tool_calls": {
        finishReason = "tool_calls"
        break
      }
      case "length": {
        finishReason = "length"
        break
      }
      case "content_filter": {
        finishReason = "content_filter"
        break
      }
      case "stop": {
        finishReason = "stop"
        break
      }
      default: {
        break
      }
    }

    updateToolCalls(toolCallMap, chunk.toolCalls ?? [])
  }

  const toolCalls: Array<ToolCall> =
    toolCallMap.size > 0 ?
      [...toolCallMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }))
    : []

  const textLen = text.length
  const toolCallsLen = toolCalls.length
  const orderedContent: Array<ContentPart> = orderedParts.map((part) =>
    part.kind === "content" ?
      { type: "text", text: part.text }
    : {
        type: "reasoning",
        text: part.text,
        ...(part.signature ? { signature: part.signature } : {}),
      },
  )
  logger.info(
    `[windsurf] collect result for ${model}: textLen=${textLen} toolCalls=${toolCallsLen} finishReason=${finishReason} usage=${JSON.stringify(usage)}`,
  )
  updateMemoryTrace(memoryTraceId, "windsurf_collect_complete", {
    collectedBytes,
    orderedPartsBytes,
    orderedParts: orderedParts.length,
    toolCalls: toolCallsLen,
  })
  if (textLen === 0 && toolCallsLen === 0) {
    logger.warn(
      `[windsurf] EMPTY response for ${model} finishReason=${finishReason}`,
    )
  }

  return {
    id: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            (
              orderedPartsComplete
              && hasReasoningAfterContent
              && orderedContent.length > 0
            ) ?
              orderedContent
            : text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          reasoning_text: reasoningText || null,
          reasoning_opaque: reasoningOpaque || null,
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage,
  }
}
