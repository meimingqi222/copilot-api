import type {
  ChatCompletionResponse,
  ContentPart,
} from "~/services/protocols/chat/types"
import type { AnthropicResponse } from "~/services/protocols/anthropic/types"
import type {
  IRPart,
  IRStop,
  IRThinkingPart,
  ResultIR,
} from "~/services/ir/types"

import { sanitizeId } from "~/lib/id-sanitizer"
import {
  imagePartToChat,
  imagePartToMessages,
} from "~/services/ir/image-generation"
import {
  extractReasoningBlockText,
  extractReasoningTextAlias,
  extractSignatureAlias,
} from "~/lib/thinking"
import {
  anthropicUsageToOpenAI,
  openAIUsageToAnthropic,
} from "~/lib/usage-translation"

function stopFromChat(
  reason: ChatCompletionResponse["choices"][number]["finish_reason"] | null,
): IRStop {
  if (reason === null) return { reason: "unknown" }
  switch (reason) {
    case "length":
      return { reason: "max_tokens", raw: reason }
    case "tool_calls":
      return { reason: "tool_calls", raw: reason }
    case "content_filter":
      return { reason: "refusal", raw: reason }
    default:
      return { reason: "complete", raw: reason }
  }
}

function stopFromMessages(reason: AnthropicResponse["stop_reason"]): IRStop {
  switch (reason) {
    case "max_tokens":
      return { reason: "max_tokens", raw: reason }
    case "tool_use":
      return { reason: "tool_calls", raw: reason }
    case "stop_sequence":
      return { reason: "stop_sequence", raw: reason }
    case "pause_turn":
      return { reason: "pause", raw: reason }
    case "refusal":
      return { reason: "refusal", raw: reason }
    case "end_turn":
      return { reason: "complete", raw: reason }
    default:
      return { reason: "unknown" }
  }
}

function chatFinishReason(
  stop?: IRStop,
): ChatCompletionResponse["choices"][number]["finish_reason"] {
  if (stop?.reason === "max_tokens") return "length"
  if (stop?.reason === "tool_calls") return "tool_calls"
  if (stop?.reason === "refusal" && stop.raw === "content_filter")
    return "content_filter"
  return "stop"
}

function messagesStopReason(stop?: IRStop): AnthropicResponse["stop_reason"] {
  if (stop?.reason === "max_tokens") return "max_tokens"
  if (stop?.reason === "tool_calls") return "tool_use"
  if (stop?.reason === "stop_sequence" && stop.raw === "stop_sequence")
    return "stop_sequence"
  if (stop?.reason === "pause" && stop.raw === "pause_turn") return "pause_turn"
  if (stop?.reason === "refusal" && stop.raw === "refusal") return "refusal"
  return "end_turn"
}

function reasoningFromChat(
  message: ChatCompletionResponse["choices"][number]["message"],
): Array<IRThinkingPart> {
  const parts: Array<IRThinkingPart> = []
  const append = (text: string | undefined, signature?: string): void => {
    if (
      !text
      || parts.some(
        (part) => part.text === text && part.signature === signature,
      )
    )
      return
    parts.push({
      type: "thinking",
      text,
      ...(signature && { signature, signedText: text }),
      source: { wire: "chat" },
    })
  }
  const content = message.content
  if (Array.isArray(content))
    for (const part of content) {
      if (part.type === "reasoning" || part.type === "thinking")
        append(
          extractReasoningBlockText(part),
          part.signature ?? extractSignatureAlias(message),
        )
    }
  const alias = extractReasoningTextAlias(message)
  const details = (message.reasoning_details ?? [])
    .map((detail) => ({
      text: extractReasoningBlockText(detail),
      signature: detail.signature,
    }))
    .filter((detail) => detail.text)
  if (
    parts.length === 0
    && details.length > 0
    && (details.map((detail) => detail.text).join("") === alias
      || details.map((detail) => detail.text).join("\n\n") === alias)
  ) {
    for (const detail of details) append(detail.text, detail.signature)
  } else {
    if (alias && parts.map((part) => part.text).join("") !== alias)
      append(alias, extractSignatureAlias(message))
    for (const detail of details) append(detail.text, detail.signature)
  }
  return parts
}

export function decodeChatResponse(response: ChatCompletionResponse): ResultIR {
  const choice = response.choices[0]
  if (!choice)
    throw new Error(
      `Unexpected empty choices in OpenAI response (id: ${response.id})`,
    )
  const message = choice.message
  const parts: Array<IRPart> = []
  const reasoning = reasoningFromChat(message)
  if (typeof message.content === "string") {
    parts.push(...reasoning, { type: "text", text: message.content })
  } else if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (item.type === "text" || item.type === "output_text")
        parts.push({ type: "text", text: item.text })
      if (item.type === "reasoning" || item.type === "thinking") {
        const text = extractReasoningBlockText(item)
        const found = reasoning.find(
          (part) => part.text === text && part.signature === item.signature,
        )
        if (found) parts.push(found)
      }
    }
    for (const item of reasoning) if (!parts.includes(item)) parts.unshift(item)
  } else {
    parts.push(...reasoning)
  }
  for (const call of message.tool_calls ?? [])
    parts.push({
      type: "tool_call",
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })
  const usage = response.usage
  return {
    id: response.id,
    model: response.model,
    source: { wire: "chat" },
    parts,
    stop: stopFromChat(choice.finish_reason),
    createdAt: response.created,
    ...(usage && {
      usage: {
        source: "reported",
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
        cacheWriteTokens:
          usage.prompt_tokens_details?.cache_creation_input_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      },
    }),
  }
}

/** Anthropic requires an object here; truncated JSON degrades to `{}`. */
function parseToolInput(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {
    /* Truncated tool JSON has no valid object representation. */
  }
  return {}
}

export function encodeMessagesResponse(ir: ResultIR): AnthropicResponse {
  const content: AnthropicResponse["content"] = []
  for (const part of ir.parts) {
    if (part.type === "thinking")
      content.push({
        type: "thinking",
        thinking: part.text,
        ...(part.signature && { signature: part.signature }),
      })
    else if (part.type === "text")
      content.push({ type: "text", text: part.text })
    else if (part.type === "image") {
      const image = imagePartToMessages(part)
      if (image) content.push(image)
    } else if (part.type === "server_tool_use")
      content.push({
        type: "server_tool_use",
        id: sanitizeId(part.id),
        name: part.name,
        input: parseToolInput(part.input),
      })
    else if (part.type === "web_search_result")
      content.push({
        type: "web_search_tool_result",
        tool_use_id: part.toolUseId,
        content: part.results.map((result) => ({
          type: "web_search_result",
          url: result.url,
          ...(result.title && { title: result.title }),
          ...(result.pageAge && { page_age: result.pageAge }),
          ...(result.encryptedContent && {
            encrypted_content: result.encryptedContent,
          }),
        })),
      })
    else if (part.type === "tool_call") {
      content.push({
        type: "tool_use",
        id: sanitizeId(part.id),
        name: part.name,
        input: parseToolInput(part.arguments),
      })
    }
  }
  const usage = openAIUsageToAnthropic({
    prompt_tokens: ir.usage?.inputTokens ?? 0,
    completion_tokens: ir.usage?.outputTokens ?? 0,
    prompt_tokens_details: {
      cached_tokens: ir.usage?.cacheReadTokens,
      cache_creation_input_tokens: ir.usage?.cacheWriteTokens,
    },
  })
  return {
    id: ir.id,
    type: "message",
    role: "assistant",
    model: ir.model,
    content,
    stop_reason: messagesStopReason(ir.stop),
    stop_sequence: null,
    usage,
  }
}

export function decodeMessagesResponse(response: AnthropicResponse): ResultIR {
  const parts: Array<IRPart> = response.content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text }
    if (block.type === "image") {
      if (block.source.type === "url")
        return { type: "image", source: { type: "url", url: block.source.url } }
      return {
        type: "image",
        source: {
          type: "base64",
          mediaType: block.source.media_type,
          data: block.source.data,
        },
      }
    }
    if (block.type === "thinking")
      return {
        type: "thinking",
        text: block.thinking,
        ...(block.signature && {
          signature: block.signature,
          signedText: block.thinking,
        }),
        source: { wire: "messages" },
      }
    if (block.type === "server_tool_use")
      return {
        type: "server_tool_use",
        id: block.id,
        name: block.name,
        input: JSON.stringify(block.input),
      }
    if (block.type === "web_search_tool_result")
      return {
        type: "web_search_result",
        toolUseId: block.tool_use_id,
        results: block.content.map((result) => ({
          url: result.url,
          ...(result.title && { title: result.title }),
          ...(result.page_age && { pageAge: result.page_age }),
          ...(result.encrypted_content && {
            encryptedContent: result.encrypted_content,
          }),
        })),
      }
    return {
      type: "tool_call",
      id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input),
    }
  })
  const usage = response.usage
  return {
    id: response.id,
    model: response.model,
    source: { wire: "messages" },
    parts,
    stop: stopFromMessages(response.stop_reason),
    usage: {
      source: "reported",
      inputTokens:
        usage.input_tokens
        + (usage.cache_read_input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
    },
  }
}

export function encodeChatResponse(ir: ResultIR): ChatCompletionResponse {
  const text = ir.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
  const images = ir.parts
    .filter((part) => part.type === "image")
    .map((part) => imagePartToChat(part))
  const thinking = ir.parts.filter((part) => part.type === "thinking")
  const hasThinkingAfterText = ir.parts.some(
    (part, index) =>
      part.type === "thinking"
      && ir.parts.slice(0, index).some((previous) => previous.type === "text"),
  )
  const ordered: Array<ContentPart> = ir.parts.flatMap(
    (part): Array<ContentPart> => {
      if (part.type === "text") return [{ type: "text", text: part.text }]
      if (part.type === "image") return [imagePartToChat(part)]
      if (part.type === "thinking")
        return [
          {
            type: "reasoning",
            text: part.text,
            ...(part.signature && { signature: part.signature }),
          },
        ]
      return []
    },
  )
  const usage = anthropicUsageToOpenAI({
    input_tokens: Math.max(
      0,
      (ir.usage?.inputTokens ?? 0)
        - (ir.usage?.cacheReadTokens ?? 0)
        - (ir.usage?.cacheWriteTokens ?? 0),
    ),
    output_tokens: ir.usage?.outputTokens ?? 0,
    cache_read_input_tokens: ir.usage?.cacheReadTokens,
    cache_creation_input_tokens: ir.usage?.cacheWriteTokens,
  })
  return {
    id: ir.id,
    object: "chat.completion",
    created: ir.createdAt ?? Math.floor(Date.now() / 1000),
    model: ir.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            hasThinkingAfterText ? ordered
            : images.length > 0 ?
              [...(text ? [{ type: "text" as const, text }] : []), ...images]
            : text || null,
          ...(thinking.length > 0 && {
            reasoning_content: thinking.map((part) => part.text).join(""),
            ...(thinking.length > 1 && {
              reasoning_details: thinking.map((part) => ({
                type: "reasoning.text",
                text: part.text,
                ...(part.signature && { signature: part.signature }),
              })),
            }),
            ...(thinking.length === 1
              && thinking[0]?.signature && {
                signature: thinking[0].signature,
              }),
          }),
          ...(ir.parts.some((part) => part.type === "tool_call") && {
            tool_calls: ir.parts
              .filter((part) => part.type === "tool_call")
              .map((part) => ({
                type: "function" as const,
                id: sanitizeId(part.id),
                function: { name: part.name, arguments: part.arguments },
              })),
          }),
        },
        finish_reason: chatFinishReason(ir.stop),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
      ...(usage.prompt_tokens_details && {
        prompt_tokens_details: usage.prompt_tokens_details,
      }),
    },
  }
}
