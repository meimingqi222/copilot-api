import type {
  ContentPart,
  ChatCompletionsPayload,
  Message,
} from "~/services/protocols/chat/types"
import type {
  IRImagePart,
  IRPart,
  IRTextPart,
  IRThinkingPart,
  IRTurn,
  RequestIR,
} from "~/services/ir/types"

import { sanitizeId } from "~/lib/id-sanitizer"
import { readOpenAIServiceTier } from "~/lib/service-tier"
import {
  budgetToLevel,
  extractReasoningBlockText,
  extractReasoningTextAlias,
  extractSignatureAlias,
} from "~/lib/thinking"
import {
  decodeChatTextFormat,
  encodeChatTextFormat,
} from "~/services/ir/codecs/messages-chat/text-format"

export function imageFromChat(
  url: string,
  detail?: "low" | "high" | "auto",
): IRImagePart {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url)
  if (match)
    return {
      type: "image",
      source: { type: "base64", mediaType: match[1], data: match[2] },
    }
  return {
    type: "image",
    source: { type: "url", url, ...(detail && { detail }) },
  }
}

export function imageToChat(
  image: IRImagePart,
): Extract<ContentPart, { type: "image_url" }> {
  const url =
    image.source.type === "url" ?
      image.source.url
    : `data:${image.source.mediaType};base64,${image.source.data}`
  return {
    type: "image_url",
    image_url: {
      url,
      ...(image.source.type === "url"
        && image.source.detail && { detail: image.source.detail }),
    },
  }
}

function chatContentParts(
  content: Message["content"],
): Array<IRTextPart | IRImagePart> {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!content) return []
  const parts: Array<IRTextPart | IRImagePart> = []
  for (const part of content) {
    if (part.type === "text" || part.type === "output_text")
      parts.push({
        type: "text",
        text: part.text,
        ...(part.cache_control && { cacheControl: part.cache_control }),
      })
    else if (part.type === "image_url")
      parts.push(imageFromChat(part.image_url.url, part.image_url.detail))
  }
  return parts
}

function chatToolConfig(
  ir: RequestIR,
): Pick<ChatCompletionsPayload, "tools" | "tool_choice"> {
  const choice = ir.toolChoice
  const declaredTools = ir.tools ?? []
  let selectedTools = declaredTools
  if (choice?.type === "allowed") {
    const allowed = new Set(choice.names)
    const declared = new Set(declaredTools.map((tool) => tool.name))
    if (choice.names.some((name) => !declared.has(name)))
      throw new Error("Allowed tools include an undeclared name")
    selectedTools = declaredTools.filter((tool) => allowed.has(tool.name))
    if (choice.mode === "required" && selectedTools.length === 0)
      throw new Error("Required allowed tools set is empty")
  }
  return {
    tools:
      selectedTools.length > 0 ?
        selectedTools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            ...(tool.description && { description: tool.description }),
            parameters: tool.parameters,
          },
        }))
      : undefined,
    tool_choice:
      choice?.type === "tool" ?
        { type: "function", function: { name: choice.name } }
      : choice?.type === "allowed" ?
        selectedTools.length === 0 ?
          "none"
        : choice.mode
      : choice?.type === "required" ? "required"
      : choice?.type === "none" ? "none"
      : choice ? "auto"
      : undefined,
  }
}

export function encodeChatRequest(
  ir: RequestIR,
  options: { preserveHistoricalReasoning?: boolean; stream?: boolean } = {},
): ChatCompletionsPayload {
  const messages: Array<Message> = []
  for (const instruction of ir.instructions) {
    const text = instruction.parts
      .map((part) => part.text)
      .join("\n\n")
      .replace(/^x-anthropic-billing-header:[^\n]*\n\n?/, "")
      .trimStart()
    messages.push({ role: instruction.role, content: text })
  }
  for (const turn of ir.turns) {
    if (
      turn.parts.some(
        (part) =>
          part.type === "file"
          || (part.type === "tool_result"
            && part.content.some((content) => content.type === "file")),
      )
    ) {
      throw new Error("File content cannot be represented by Chat")
    }
    if (turn.role === "user") {
      const results = turn.parts.filter((part) => part.type === "tool_result")
      for (const result of results) {
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n\n")
        messages.push({
          role: "tool",
          tool_call_id: sanitizeId(result.callId),
          content: text,
        })
        const images = result.content
          .filter((part) => part.type === "image")
          .map(imageToChat)
        if (images.length > 0) messages.push({ role: "user", content: images })
      }
      const other = turn.parts.filter(
        (part) => part.type === "text" || part.type === "image",
      )
      const content = other.map(
        (part): ContentPart =>
          part.type === "image" ?
            imageToChat(part)
          : { type: "text", text: part.text },
      )
      if (content.length > 0 || results.length === 0)
        messages.push({
          role: "user",
          content:
            content.length === 1 && content[0].type === "text" ?
              content[0].text
            : content,
        })
      continue
    }
    if (turn.role === "tool") {
      for (const part of turn.parts)
        if (part.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: sanitizeId(part.callId),
            content: part.content
              .filter((entry) => entry.type === "text")
              .map((entry) => entry.text)
              .join("\n\n"),
          })
          const images = part.content
            .filter((entry) => entry.type === "image")
            .map(imageToChat)
          if (images.length > 0)
            messages.push({ role: "user", content: images })
        }
      continue
    }
    const text = turn.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
    const thinking =
      options.preserveHistoricalReasoning ?
        turn.parts.filter(
          (part): part is IRThinkingPart =>
            part.type === "thinking" && Boolean(part.text),
        )
      : []
    const toolCalls = turn.parts.filter((part) => part.type === "tool_call")
    const images = turn.parts
      .filter((part) => part.type === "image")
      .map(imageToChat)
    messages.push({
      role: "assistant",
      content: text || null,
      ...(images.length > 0 && { images }),
      ...(thinking.length > 0 && {
        reasoning_content: thinking.map((part) => part.text).join("\n\n"),
        ...(thinking.length > 1 && {
          reasoning_details: thinking.map((part) => ({
            type: "reasoning.text",
            text: part.text,
            ...(part.signature && { signature: part.signature }),
          })),
        }),
        ...(thinking.find((part) => part.signature)?.signature && {
          signature: thinking.find((part) => part.signature)?.signature,
        }),
      }),
      ...(toolCalls.length > 0 && {
        tool_calls: toolCalls.map((part) => ({
          id: sanitizeId(part.id),
          type: "function" as const,
          function: { name: part.name, arguments: part.arguments },
        })),
      }),
    })
  }
  const generation = ir.generation
  const effort =
    generation?.reasoning?.effort
    ?? ((
      generation?.reasoning?.mode === "enabled"
      && generation.reasoning.budgetTokens !== undefined
    ) ?
      budgetToLevel(generation.reasoning.budgetTokens)
    : undefined)
  return {
    model: ir.model.replace(/^(claude-(?:sonnet|opus)-4)-\d{8}$/, "$1"),
    messages,
    max_tokens: generation?.maxOutputTokens,
    service_tier: readOpenAIServiceTier(generation?.serviceTier),
    stop: generation?.stopSequences,
    stream: options.stream,
    temperature:
      effort && effort !== "none" && effort !== "auto" ?
        1
      : generation?.temperature,
    top_p: generation?.topP,
    user: generation?.user,
    ...chatToolConfig(ir),
    ...encodeChatTextFormat(generation?.textFormat),
    reasoning_effort:
      (
        effort === "auto"
        || (effort === "none" && generation?.reasoning?.mode !== "enabled")
      ) ?
        undefined
      : effort,
  }
}

export function chatRequestsWebSearch(
  payload: Pick<ChatCompletionsPayload, "plugins">,
): boolean {
  return payload.plugins?.some((plugin) => plugin.id === "web") ?? false
}

export function decodeChatRequest(payload: ChatCompletionsPayload): RequestIR {
  const instructions: RequestIR["instructions"] = []
  const turns: Array<IRTurn> = []
  for (const message of payload.messages) {
    if (message.role === "system" || message.role === "developer") {
      instructions.push({
        role: message.role,
        parts: chatContentParts(message.content).filter(
          (part): part is IRTextPart => part.type === "text",
        ),
      })
    } else if (message.role === "tool") {
      turns.push({
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: message.tool_call_id ?? "",
            content: chatContentParts(message.content),
          },
        ],
        source: { wire: "chat" },
      })
    } else {
      const parts: Array<IRPart> = chatContentParts(message.content)
      for (const image of message.images ?? [])
        parts.push(imageFromChat(image.image_url.url, image.image_url.detail))
      if (message.role === "assistant") {
        const alias = extractReasoningTextAlias(message)
        const details =
          message.reasoning_details?.filter((detail) =>
            extractReasoningBlockText(detail),
          ) ?? []
        if (
          details.length > 0
          && (!alias
            || details.every((detail) =>
              alias.includes(extractReasoningBlockText(detail) ?? ""),
            ))
        ) {
          parts.unshift(
            ...details.map((detail) => ({
              type: "thinking" as const,
              text: extractReasoningBlockText(detail) ?? "",
              ...(detail.signature && {
                signature: detail.signature,
                signedText: extractReasoningBlockText(detail),
              }),
              source: { wire: "chat" as const },
            })),
          )
        } else if (alias) {
          const signature = extractSignatureAlias(message)
          parts.unshift({
            type: "thinking",
            text: alias,
            ...(signature && { signature, signedText: alias }),
            source: { wire: "chat" },
          })
        }
        for (const part of message.content ?? []) {
          if (typeof part === "string") break
          if (part.type !== "reasoning" && part.type !== "thinking") continue
          const text = extractReasoningBlockText(part)
          if (
            text
            && !parts.some(
              (entry) => entry.type === "thinking" && entry.text === text,
            )
          )
            parts.unshift({
              type: "thinking",
              text,
              ...(part.signature && {
                signature: part.signature,
                signedText: text,
              }),
              source: { wire: "chat" },
            })
        }
        parts.push(
          ...(message.tool_calls ?? []).map((call) => ({
            type: "tool_call" as const,
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          })),
        )
      }
      turns.push({ role: message.role, parts, source: { wire: "chat" } })
    }
  }
  return {
    model: payload.model,
    source: { wire: "chat" },
    instructions,
    turns,
    ...(payload.tools && {
      tools: payload.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    }),
    ...(payload.tool_choice && {
      toolChoice:
        typeof payload.tool_choice === "string" ?
          { type: payload.tool_choice }
        : { type: "tool", name: payload.tool_choice.function.name },
    }),
    generation: {
      maxOutputTokens: payload.max_tokens ?? undefined,
      textFormat: decodeChatTextFormat(payload.response_format),
      serviceTier: readOpenAIServiceTier(payload.service_tier),
      temperature: payload.temperature ?? undefined,
      topP: payload.top_p ?? undefined,
      stopSequences:
        payload.stop ?
          Array.isArray(payload.stop) ?
            payload.stop
          : [payload.stop]
        : undefined,
      user: payload.user ?? undefined,
      ...(payload.reasoning_effort && {
        reasoning: { effort: payload.reasoning_effort },
      }),
      ...(chatRequestsWebSearch(payload) && {
        webSearch: true,
        webSearchOptions: { wireType: "web" },
      }),
    },
  }
}
