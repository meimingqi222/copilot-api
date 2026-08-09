import { createHash, randomUUID } from "node:crypto"

import type {
  ChatCompletionsPayload,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"

import {
  extractReasoningBlockText,
  extractReasoningPartsText,
  extractReasoningTextAlias,
  extractSignatureAlias,
} from "~/lib/thinking"

import { buildWindsurfClientMetadata } from "./metadata"
import { ProtobufEncoder, encodeConnectFrame } from "./protobuf"

// ── Enum constants (aligned with oh-my-pi generated protobuf) ──────────────────

const ChatMessageSource = {
  UNSPECIFIED: 0,
  USER: 1,
  SYSTEM: 2,
  UNKNOWN: 3,
  TOOL: 4,
  SYSTEM_PROMPT: 5,
} as const

const ChatMessageRequestType = {
  UNSPECIFIED: 0,
  GENERAL: 1,
  CONTEXT_CHECK: 2,
  PLAN: 3,
  COMMAND: 4,
  CASCADE: 5,
  EVAL: 6,
  WINDSURF_REVIEW: 7,
  VIBE_AND_REPLACE: 8,
  DEEPWIKI: 9,
} as const

const ConversationalPlannerMode = {
  UNSPECIFIED: 0,
  DEFAULT: 1,
  READ_ONLY: 2,
  NO_TOOL: 3,
  EXPLORE: 4,
  PLANNING: 5,
  AUTO: 6,
} as const

const CacheControlType = {
  UNSPECIFIED: 0,
  EPHEMERAL: 1,
} as const

const DEFAULT_WINDSURF_SYSTEM_PROMPT =
  "You are Cascade, a powerful coding assistant."

const DEVIN_DEFAULT_STOP_PATTERNS = [
  "<|user|>",
  "<|bot|>",
  "<|context_request|>",
  "<|endoftext|>",
  "<|end_of_turn|>",
]

// ── Deterministic message ids (mirrors oh-my-pi) ───────────────────────────────

function deterministicUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex")
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${["8", "9", "a", "b"][Number.parseInt(hash.slice(16, 17), 16) % 4]}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-")
}

// ── Message content serialisation ────────────────────────────────────────────

function extractImageBase64(url: string): string | undefined {
  const match = url.match(/^data:[^;]+;base64,(.+)$/)
  return match?.[1]
}

function extractImageMimeType(url: string): string | undefined {
  const match = url.match(/^data:([^;]+);base64,/)
  return match?.[1]
}

function serializeMessageContent(content: Message["content"]): {
  text: string
  images: Array<{ base64: string; mimeType: string }>
} {
  if (typeof content === "string") return { text: content, images: [] }

  const parts = content ?? []
  let text = ""
  const images: Array<{ base64: string; mimeType: string }> = []

  for (const item of parts) {
    switch (item.type) {
      case "text":
      case "output_text": {
        text += item.text
        break
      }
      case "image_url": {
        const base64 = extractImageBase64(item.image_url.url)
        if (base64) {
          images.push({
            base64,
            mimeType: extractImageMimeType(item.image_url.url) ?? "image/png",
          })
        }
        break
      }
      case "reasoning":
      case "thinking": {
        // reasoning/thinking parts are handled separately for assistant messages
        break
      }
      default: {
        break
      }
    }
  }
  return { text, images }
}

// ── Request-side message builders ─────────────────────────────────────────────

/**
 * Rough upper bound on the encoded request, used only to pre-size the encoder
 * so it does not double its way up (which leaves the final buffer at up to 2x
 * the payload with two copies briefly live). Cheap and approximate on purpose:
 * `String.length` under-counts multi-byte text, and growth still covers a miss.
 */
function estimateRequestBytes(payload: ChatCompletionsPayload): number {
  let bytes = 4096 // metadata, config, tool choice, cache options, ids
  for (const message of payload.messages) {
    bytes += 128 // per-turn ids, enums, framing
    const { content } = message
    if (typeof content === "string") {
      bytes += content.length
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text" || part.type === "output_text") {
          bytes += part.text.length
        } else if (part.type === "image_url") {
          bytes += part.image_url.url.length
        }
      }
    }
    // Only the alias `resolveAssistantReasoning` would actually pick, so the
    // estimate tracks what gets written rather than summing every spelling.
    bytes += (extractReasoningTextAlias(message) ?? "").length
    for (const tc of message.tool_calls ?? []) {
      bytes += tc.function.arguments.length + tc.function.name.length + 64
    }
  }
  for (const tool of payload.tools ?? []) {
    bytes += JSON.stringify(tool.function.parameters).length + 256
  }
  return bytes
}

/**
 * Non-blank test that does not allocate. `text.trim()` copies the whole string
 * just to check emptiness, which on a long conversation means one throwaway
 * copy of every message body.
 */
const NON_WHITESPACE = /\S/
function hasText(value: string): boolean {
  return NON_WHITESPACE.test(value)
}

function writeImages(
  prompt: ProtobufEncoder,
  images: Array<{ base64: string; mimeType: string }>,
): void {
  for (const image of images) {
    prompt.writeNested(10, (img) => {
      img.writeString(1, image.base64)
      img.writeString(2, image.mimeType)
    })
  }
}

/**
 * Appends one ChatMessagePrompt to `request` in place, returning false when the
 * message carries nothing worth sending.
 *
 * Writes straight into the request buffer rather than building a per-turn
 * encoder: on a long agent history the child encoders were the dominant
 * allocation, since every turn's bytes were built once and then copied again
 * into the parent.
 */
function writeChatMessagePrompt(
  request: ProtobufEncoder,
  opts: {
    message: Message
    index: number
    cascadeId: string
  },
): boolean {
  const { message, index, cascadeId } = opts

  if (message.role === "user" || message.role === "developer") {
    const { text, images } = serializeMessageContent(message.content)
    if (!hasText(text) && images.length === 0) return false

    request.writeNested(3, (prompt) => {
      prompt.writeString(
        1,
        deterministicUuid(`${cascadeId}\0${index}\0${message.role}`),
      )
      prompt.writeVarint(2, ChatMessageSource.USER)
      if (text) prompt.writeString(3, text)
      writeImages(prompt, images)
    })
    return true
  }

  if (message.role === "assistant") {
    const content = serializeMessageContent(message.content)
    const toolCalls = message.tool_calls ?? []
    const reasoningText = resolveAssistantReasoning(message)
    const reasoningSignature = resolveAssistantSignature(message, reasoningText)
    // `reasoningSignature` is only ever set alongside `reasoningText`, so it
    // cannot on its own keep an otherwise empty turn alive.
    if (!hasText(content.text) && !reasoningText && toolCalls.length === 0) {
      return false
    }

    request.writeNested(3, (prompt) => {
      prompt.writeString(
        1,
        `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
      )
      prompt.writeVarint(2, ChatMessageSource.SYSTEM)
      if (content.text) prompt.writeString(3, content.text)

      for (const tc of toolCalls) {
        prompt.writeNested(6, (tcMsg) => {
          tcMsg.writeString(1, tc.id)
          tcMsg.writeString(2, tc.function.name)
          tcMsg.writeString(3, tc.function.arguments)
        })
      }

      if (reasoningText) {
        prompt.writeString(11, reasoningText)
      }
      if (reasoningSignature) {
        prompt.writeString(12, reasoningSignature)
      }
    })
    return true
  }

  if (message.role === "tool") {
    const { text, images } = serializeMessageContent(message.content)
    const toolCallId = message.tool_call_id
    if ((!hasText(text) && images.length === 0) || !toolCallId) {
      return false
    }

    request.writeNested(3, (prompt) => {
      prompt.writeString(
        1,
        deterministicUuid(`${cascadeId}\0${index}\0tool\0${toolCallId}`),
      )
      prompt.writeVarint(2, ChatMessageSource.TOOL)
      if (text) prompt.writeString(3, text)
      prompt.writeString(7, toolCallId)
      writeImages(prompt, images)
    })
    return true
  }

  return false
}

function resolveAssistantReasoning(message: Message): string {
  // `||`, not `??`: an upstream that emits an empty top-level alias alongside
  // real reasoning in content parts must still fall through to the parts.
  return (
    extractReasoningTextAlias(message)
    || extractReasoningPartsText(message.content)
  )
}

/**
 * Signature covering the whole of `reasoningText`, or undefined.
 *
 * Windsurf carries reasoning as a single pair — field 11 text, field 12
 * signature — so a signature may only be sent when it signs the entire string
 * written to field 11. History that arrives as several separately signed
 * segments (an Anthropic client with interleaved thinking and tool use, via
 * `protocols/openai/messages-to-chat.ts`) has no such signature: `reasoningText`
 * is their concatenation, and attaching the first segment's signature to it
 * yields a pair the upstream rejects. Dropping the signature degrades
 * gracefully; mismatching it does not.
 *
 * A top-level signature must provably pair with the whole of `reasoningText`
 * to be trusted: it needs its own top-level text, and the message must not
 * carry independently-signed segments that show the reasoning was assembled
 * from several signed blocks. `reasoning_opaque` is exempt — it is the full
 * accumulated signature this proxy's own Windsurf collector writes
 * (`collect-response.ts`), covering the stream by construction.
 */
function resolveAssistantSignature(
  message: Message,
  reasoningText: string,
): string | undefined {
  // Nothing to sign — never emit a signature-only assistant prompt.
  if (!reasoningText) return undefined

  // Top-level signature, trusted only when it provably pairs with the whole of
  // `reasoningText`. Two conditions, both required:
  //  1. `reasoningText` is exactly the message's top-level reasoning text —
  //     otherwise the signature has no paired text and would be signing the
  //     concatenation of content parts instead.
  //  2. The message carries no independently-signed segments (`reasoning_details`
  //     entries or reasoning/thinking content parts) — those indicate the
  //     reasoning was assembled from several signed blocks, so no single
  //     top-level signature can be shown to cover the concatenation.
  // `reasoning_opaque` is exempt from (2): it is the spelling this proxy's own
  // Windsurf collector emits as the full accumulated signature of the whole
  // stream, so it covers `reasoning_text` by construction.
  const topLevel = extractSignatureAlias(message)
  if (topLevel && reasoningText === extractReasoningTextAlias(message)) {
    const hasSignedSegments =
      (message.reasoning_details?.some((detail) => detail.signature) ?? false)
      || (Array.isArray(message.content)
        && message.content.some(
          (part) =>
            (part.type === "reasoning" || part.type === "thinking")
            && part.signature,
        ))
    if (!hasSignedSegments || message.reasoning_opaque) {
      return topLevel
    }
  }

  const detailSignature = message.reasoning_details?.find(
    (detail) => detail.text === reasoningText && detail.signature,
  )?.signature
  if (detailSignature) return detailSignature

  if (!Array.isArray(message.content)) return undefined
  for (const part of message.content) {
    if (part.type !== "reasoning" && part.type !== "thinking") continue
    if (!part.signature) continue
    const partText = extractReasoningBlockText(part) ?? ""
    if (partText === reasoningText) return part.signature
  }
  return undefined
}

export function resolveSystemPrompt(payload: ChatCompletionsPayload): string {
  const texts = payload.messages
    .filter((m) => m.role === "system")
    .map((m) => serializeMessageContent(m.content).text)
    .filter((text) => hasText(text))
  return texts.join("\n\n") || DEFAULT_WINDSURF_SYSTEM_PROMPT
}

// ── Tool-definition builder ────────────────────────────────────────────────────

/** Cloud rejects tool descriptions ≥7000 chars with a misleading MCP error. */
const MAX_TOOL_DESC_LEN = 6998

function buildToolDef(tool: Tool): ProtobufEncoder {
  const rawDesc = tool.function.description ?? ""
  const desc =
    rawDesc.length > MAX_TOOL_DESC_LEN ?
      `${rawDesc.slice(0, MAX_TOOL_DESC_LEN - 24)}\n…(truncated for cloud)`
    : rawDesc
  const t = new ProtobufEncoder()
  t.writeString(1, tool.function.name)
  t.writeString(2, desc)
  t.writeString(3, JSON.stringify(tool.function.parameters))
  t.writeBool(12, false)
  return t
}

// ── Configuration block (oh-my-pi CompletionConfiguration) ─────────────────────

function buildConfiguration(payload: ChatCompletionsPayload): ProtobufEncoder {
  let stopPatterns: Array<string>
  if (payload.stop && typeof payload.stop === "string") {
    stopPatterns = [payload.stop, ...DEVIN_DEFAULT_STOP_PATTERNS]
  } else if (Array.isArray(payload.stop) && payload.stop.length > 0) {
    stopPatterns = [...payload.stop, ...DEVIN_DEFAULT_STOP_PATTERNS]
  } else {
    stopPatterns = DEVIN_DEFAULT_STOP_PATTERNS
  }

  const cfg = new ProtobufEncoder()
  cfg.writeVarint(1, 1) // num_completions
  cfg.writeVarint(2, payload.max_tokens ?? 64000) // max_tokens
  cfg.writeVarint(3, 200) // max_newlines
  cfg.writeDouble(5, payload.temperature ?? 0.4) // temperature
  cfg.writeDouble(6, payload.temperature ?? 0.4) // first_temperature
  cfg.writeVarint(7, 50) // top_k
  cfg.writeDouble(8, payload.top_p ?? 1) // top_p
  for (const pattern of stopPatterns) {
    cfg.writeString(9, pattern)
  }
  cfg.writeDouble(11, 1) // fim_eot_prob_threshold
  return cfg
}

function buildToolChoice(): ProtobufEncoder {
  const choice = new ProtobufEncoder()
  choice.writeString(1, "auto")
  return choice
}

function buildSystemPromptCacheOptions(): ProtobufEncoder {
  const opts = new ProtobufEncoder()
  opts.writeVarint(1, CacheControlType.EPHEMERAL)
  return opts
}

// ── Full request builder ───────────────────────────────────────────────────────

export function buildRequest(opts: {
  payload: ChatCompletionsPayload
  apiKey: string
  requestModel: string
  /** Stable cascade_id (field 16) - reuse across turns for prompt cache. */
  cascadeId: string
  /** Stable per-conversation prompt_id (field 17). */
  promptId?: string
  /**
   * Short-lived userJwt from the GetUserJwt exchange, carried in
   * Metadata.user_jwt (field 21). Real Windsurf sends it on every chat
   * request (oh-my-pi devin.ts line 514); omitting it is detectable.
   */
  userJwt?: string
  onEncoded?: (metrics: { protobufBytes: number; wireBytes: number }) => void
}): Uint8Array {
  const { payload, apiKey, requestModel, cascadeId, promptId, userJwt } = opts
  const request = new ProtobufEncoder(estimateRequestBytes(payload))

  request.writeMessage(1, buildWindsurfClientMetadata(apiKey, userJwt))
  request.writeString(2, resolveSystemPrompt(payload))

  for (const [messageIndex, message] of payload.messages.entries()) {
    if (message.role === "system") continue
    writeChatMessagePrompt(request, {
      message,
      index: messageIndex,
      cascadeId,
    })
  }

  request.writeVarint(7, ChatMessageRequestType.CASCADE)
  request.writeMessage(8, buildConfiguration(payload))

  const tools = payload.tools?.filter(Boolean) ?? []
  for (const tool of tools) {
    request.writeMessage(10, buildToolDef(tool))
  }

  request.writeBool(11, true) // disable_parallel_tool_calls
  request.writeMessage(12, buildToolChoice())
  request.writeMessage(13, buildSystemPromptCacheOptions())
  request.writeString(16, cascadeId)
  if (promptId) {
    request.writeString(17, promptId)
  }
  request.writeVarint(20, ConversationalPlannerMode.DEFAULT)
  request.writeString(21, requestModel)
  request.writeString(22, randomUUID())

  // Connect frame is gzip-compressed to match oh-my-pi.
  const protobuf = request.toUint8Array()
  const framed = encodeConnectFrame(protobuf, true)
  opts.onEncoded?.({
    protobufBytes: protobuf.byteLength,
    wireBytes: framed.byteLength,
  })
  return framed
}
