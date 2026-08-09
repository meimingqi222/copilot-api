/**
 * OpenAI Chat Completions payload → Anthropic Messages payload translation.
 *
 * Used by the dispatch layer when a `/v1/chat/completions` request fails over
 * to a target whose adapter only implements `createMessages` (e.g. a
 * claude-native or anthropic-compatible connection), so cross-protocol
 * fallback is transparent.
 *
 * Known lossy/dropped fields (documented, v1 — see docs/refactor-v2.md):
 * - `n`, `seed`, `logprobs`, `logit_bias`, `frequency_penalty`,
 *   `presence_penalty`, `response_format`, `stream_options`: Anthropic has no
 *   equivalent, silently dropped.
 * - Historical assistant reasoning with no signature (any of the four
 *   spellings: `reasoning_content`/`reasoning_text`/`reasoning`/`thinking`):
 *   Claude rejects unsigned thinking blocks in history → stripped.
 * - Remote (non-base64) `image_url` parts: Anthropic only accepts base64 →
 *   skipped.
 * - `budget_tokens`-style `thinking` on the chat payload: not translated in
 *   v1 — reasoning is always mapped to `adaptive` + `output_config.effort`.
 */

import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"
import type {
  AnthropicAssistantContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
} from "~/services/protocols/anthropic"

import { sanitizeId } from "~/lib/id-sanitizer"
import {
  extractReasoningBlockText,
  extractReasoningTextAlias,
  extractSignatureAlias,
} from "~/lib/thinking"

/**
 * Anthropic requires `max_tokens`; OpenAI clients may omit it. Default mirrors
 * existing precedents: windsurf (`payload.max_tokens ?? 64000`) and the
 * Claude Code OAuth 64k output-token clamp.
 */
export const DEFAULT_VIA_MESSAGES_MAX_TOKENS = 64000

/**
 * Anthropic rejects empty content arrays and whitespace-only text blocks.
 * When translation strips everything from a turn (unsigned historical
 * reasoning, unsupported remote images), keep it structurally valid with a
 * single-space placeholder. Only used when the whole message would otherwise
 * be empty — never appended to a turn that already has real blocks.
 */
const EMPTY_TEXT_PLACEHOLDER = " "

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/** OpenAI reasoning_effort levels narrowed to Anthropic output_config.effort (3 tiers). */
const CHAT_REASONING_EFFORT_TO_CLAUDE: Record<
  string,
  "low" | "medium" | "high"
> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
}

export function translateChatPayloadToAnthropic(
  payload: ChatCompletionsPayload,
): AnthropicMessagesPayload {
  const { system, messages } = translateMessages(payload.messages)

  return {
    model: payload.model,
    messages,
    max_tokens: payload.max_tokens ?? DEFAULT_VIA_MESSAGES_MAX_TOKENS,
    ...(system.length > 0 && { system }),
    ...(payload.stop !== undefined
      && payload.stop !== null && {
        stop_sequences: normalizeStop(payload.stop),
      }),
    ...(payload.stream !== undefined
      && payload.stream !== null && { stream: payload.stream }),
    ...(payload.temperature !== undefined
      && payload.temperature !== null && { temperature: payload.temperature }),
    ...(payload.top_p !== undefined
      && payload.top_p !== null && { top_p: payload.top_p }),
    ...(payload.user !== undefined
      && payload.user !== null && { metadata: { user_id: payload.user } }),
    ...(payload.tools !== undefined
      && payload.tools !== null
      && payload.tools.length > 0 && {
        tools: payload.tools.map((tool) => translateTool(tool)),
      }),
    ...(payload.tool_choice !== undefined
      && payload.tool_choice !== null && {
        tool_choice: translateToolChoice(payload.tool_choice),
      }),
    ...translateThinkingConfig(payload),
  }
}

function normalizeStop(stop: string | Array<string>): Array<string> {
  return Array.isArray(stop) ? stop : [stop]
}

function translateTool(tool: Tool): AnthropicTool {
  return {
    name: tool.function.name,
    ...(tool.function.description !== undefined && {
      description: tool.function.description,
    }),
    input_schema: tool.function.parameters,
  }
}

function translateToolChoice(
  toolChoice: NonNullable<ChatCompletionsPayload["tool_choice"]>,
): NonNullable<AnthropicMessagesPayload["tool_choice"]> {
  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "none": {
        return { type: "none" }
      }
      case "required": {
        return { type: "any" }
      }
      default: {
        return { type: "auto" }
      }
    }
  }
  // Non-string tool_choice is always { type: "function" }.
  if (toolChoice.function.name) {
    return { type: "tool", name: toolChoice.function.name }
  }
  return { type: "auto" }
}

/**
 * Maps OpenAI `reasoning_effort` to Anthropic adaptive thinking + effort.
 * `"none"`/`"auto"` → omit so the upstream uses its default (most Claude 4.7+
 * models cannot disable thinking anyway). Explicit `thinking` budgets on the
 * chat payload are intentionally not translated in v1.
 */
function translateThinkingConfig(
  payload: ChatCompletionsPayload,
): Pick<AnthropicMessagesPayload, "thinking" | "output_config"> {
  const rawEffort = payload.reasoning_effort
  if (!rawEffort || rawEffort === "none" || rawEffort === "auto") {
    return {}
  }
  // After excluding none/auto, the remaining reasoning_effort union values
  // (minimal/low/medium/high/xhigh) all exist in the map.
  const effort = CHAT_REASONING_EFFORT_TO_CLAUDE[rawEffort]
  return {
    thinking: { type: "adaptive" },
    output_config: { effort },
  }
}

interface TranslatedMessages {
  system: string
  messages: Array<AnthropicMessage>
}

function translateMessages(messages: Array<Message>): TranslatedMessages {
  const systemParts: Array<string> = []
  const out: Array<AnthropicMessage> = []
  // Consecutive OpenAI `tool` messages become a single Anthropic user message
  // with one tool_result block each (Anthropic has no `tool` role). A
  // following user text message is merged into the same user turn to avoid
  // consecutive user messages (which Anthropic rejects).
  let pendingToolResults: Array<AnthropicToolResultBlock> = []

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return
    out.push({ role: "user", content: pendingToolResults })
    pendingToolResults = []
  }

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "developer": {
        pushSystemText(systemParts, msg)
        break
      }
      case "tool": {
        pendingToolResults.push(translateToolResult(msg))
        break
      }
      case "user": {
        const mapped = mapContentToAnthropicBlocks(msg.content)
        if (pendingToolResults.length > 0) {
          // Merge text/image into the open tool-result turn (results first).
          // The tool results already keep the turn non-empty, so empty
          // text/image content contributes nothing — no placeholder here.
          out.push({
            role: "user",
            content: [
              ...pendingToolResults,
              ...normalizeContentToBlocks(mapped),
            ],
          })
          pendingToolResults = []
        } else if (typeof mapped === "string" && mapped !== "") {
          // Keep the plain string form for the common case.
          out.push({ role: "user", content: mapped })
        } else {
          const contentBlocks = normalizeContentToBlocks(mapped)
          out.push({
            role: "user",
            content:
              contentBlocks.length > 0 ?
                contentBlocks
              : [{ type: "text", text: EMPTY_TEXT_PLACEHOLDER }],
          })
        }
        break
      }
      case "assistant": {
        flushToolResults()
        out.push(translateAssistantMessage(msg))
        break
      }
      default: {
        // Message.role union is exhaustive; unreachable.
        break
      }
    }
  }
  flushToolResults()

  return { system: systemParts.join("\n\n"), messages: out }
}

function normalizeContentToBlocks(
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>,
): Array<AnthropicTextBlock | AnthropicImageBlock> {
  if (typeof content === "string") {
    // Empty text contributes nothing to a merged turn — drop it.
    return content === "" ? [] : [{ type: "text", text: content }]
  }
  return content
}

function pushSystemText(parts: Array<string>, msg: Message): void {
  if (typeof msg.content === "string") {
    parts.push(msg.content)
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text" || part.type === "output_text") {
        parts.push(part.text)
      }
    }
  }
}

function translateToolResult(msg: Message): AnthropicToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: sanitizeId(msg.tool_call_id ?? ""),
    content: mapContentToAnthropicBlocks(msg.content),
  }
}

function translateAssistantMessage(msg: Message): AnthropicMessage {
  const thinkingBlocks: Array<AnthropicAssistantContentBlock> = []
  const textBlocks: Array<AnthropicAssistantContentBlock> = []
  const toolUseBlocks: Array<AnthropicAssistantContentBlock> = []
  const reasoningDetails = msg.reasoning_details ?? []

  const addSignedReasoning = (text: string, signature?: string): void => {
    if (!signature || !text) return
    if (
      thinkingBlocks.some(
        (block) => block.type === "thinking" && block.thinking === text,
      )
    ) {
      return
    }
    thinkingBlocks.push({ type: "thinking", thinking: text, signature })
  }

  const topLevelSignature = extractSignatureAlias(msg)
  const topLevelReasoning = extractReasoningTextAlias(msg)
  if (topLevelReasoning) {
    const signedDetails = reasoningDetails.filter(
      (item): item is typeof item & { text: string; signature: string } =>
        typeof item.text === "string"
        && typeof item.signature === "string"
        && topLevelReasoning.includes(item.text),
    )
    if (signedDetails.length > 0) {
      for (const detail of signedDetails) {
        addSignedReasoning(detail.text, detail.signature)
      }
    } else {
      const detail = reasoningDetails.find(
        (item) => item.text === topLevelReasoning && item.signature,
      )
      addSignedReasoning(
        topLevelReasoning,
        detail?.signature ?? topLevelSignature ?? undefined,
      )
    }
  }

  if (typeof msg.content === "string") {
    if (msg.content.length > 0)
      textBlocks.push({ type: "text", text: msg.content })
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      switch (part.type) {
        case "text":
        case "output_text": {
          textBlocks.push({ type: "text", text: part.text })
          break
        }
        case "reasoning":
        case "thinking": {
          // Only signed reasoning can round-trip to a valid thinking block;
          // unsigned historical reasoning is stripped (Claude rejects it).
          addSignedReasoning(
            extractReasoningBlockText(part) ?? "",
            part.signature,
          )
          break
        }
        case "image_url": {
          // Anthropic assistant messages do not carry images — skip.
          break
        }
        default: {
          // ContentPart union is exhaustive; unreachable.
          break
        }
      }
    }
  }

  for (const call of msg.tool_calls ?? []) {
    toolUseBlocks.push({
      type: "tool_use",
      id: sanitizeId(call.id),
      name: call.function.name,
      input: parseToolCallArguments(call.function.arguments),
    })
  }

  const content = [...thinkingBlocks, ...textBlocks, ...toolUseBlocks]
  return {
    role: "assistant",
    // Keep an assistant turn structurally valid after unsigned reasoning is
    // stripped. Anthropic rejects empty content arrays and whitespace-only
    // text blocks.
    content:
      content.length > 0 ?
        content
      : [{ type: "text", text: EMPTY_TEXT_PLACEHOLDER }],
  }
}

function mapContentToAnthropicBlocks(
  content: string | Array<ContentPart> | null,
): string | Array<AnthropicTextBlock | AnthropicImageBlock> {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }

  const blocks: Array<AnthropicTextBlock | AnthropicImageBlock> = []
  for (const part of content) {
    switch (part.type) {
      case "text":
      case "output_text": {
        blocks.push({
          type: "text",
          text: part.text,
          // OpenRouter-style breakpoint: the only way a chat client can place
          // one. `createChatViaMessages` defers to these before auto-placing.
          ...(part.cache_control && { cache_control: part.cache_control }),
        })
        break
      }
      case "image_url": {
        const image = dataUrlToAnthropicImage(part.image_url.url)
        if (image) blocks.push(image)
        // Non-base64 remote URLs skipped (Anthropic only accepts base64).
        break
      }
      case "reasoning":
      case "thinking": {
        // Reasoning parts in user/tool content are a protocol violation — skip.
        break
      }
      default: {
        // ContentPart union is exhaustive; unreachable.
        break
      }
    }
  }
  return blocks
}

function dataUrlToAnthropicImage(url: string): AnthropicImageBlock | undefined {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(url)
  if (!match) return undefined
  const mediaType = match[1]
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) return undefined
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType as AnthropicImageBlock["source"]["media_type"],
      data: match[2],
    },
  }
}

function parseToolCallArguments(
  argumentsJson: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Malformed arguments → empty input object (matches Anthropic tool_use).
  }
  return {}
}
