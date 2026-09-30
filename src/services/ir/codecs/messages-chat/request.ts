import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
} from "~/services/protocols/chat/types"
import type {
  AnthropicAssistantContentBlock,
  AnthropicImageBlock,
  AnthropicMessagesPayload,
  AnthropicServerTool,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicUserContentBlock,
  AnthropicWebSearchToolResultBlock,
} from "~/services/protocols/anthropic/types"
import type {
  IRImagePart,
  IRPart,
  IRTextPart,
  IRWebSearchResultPart,
  IRThinkingPart,
  IRToolResultContent,
  IRTurn,
  RequestIR,
} from "~/services/ir/types"

import { sanitizeId } from "~/lib/id-sanitizer"
import {
  budgetToLevel,
  extractReasoningBlockText,
  extractReasoningTextAlias,
  extractSignatureAlias,
} from "~/lib/thinking"

/**
 * Anthropic rejects empty content arrays and whitespace-only text blocks, so
 * turns that would encode empty get this non-whitespace placeholder instead
 * (see docs/protocol-translation-pitfalls.md §2.2). Exported for the
 * tokenizer drift guard (`tests/tokenizer.test.ts`).
 */
export const EMPTY_TEXT_PLACEHOLDER = "(no content)"
const MAX_TOKENS_DEFAULT = 64_000
const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

function imageFromChat(
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

function imageToChat(image: IRImagePart): ContentPart {
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

function imageFromMessages(block: AnthropicImageBlock): IRImagePart {
  return block.source.type === "url" ?
      { type: "image", source: { type: "url", url: block.source.url } }
    : {
        type: "image",
        source: {
          type: "base64",
          mediaType: block.source.media_type,
          data: block.source.data,
        },
      }
}

/**
 * Encodes an IR image as an Anthropic image block, or `undefined` when the
 * Messages wire cannot represent it (non-http(s) URL schemes such as `blob:`,
 * base64 media types outside Anthropic's accepted set). Unrepresentable
 * images are dropped rather than rejecting the whole request — a chat client
 * replaying a turn with e.g. a browser-local `blob:` image would otherwise
 * have its request fail.
 */
function imageToMessages(part: IRImagePart): AnthropicImageBlock | undefined {
  if (part.source.type === "url") {
    if (!/^https?:\/\//i.test(part.source.url)) return undefined
    return { type: "image", source: { type: "url", url: part.source.url } }
  }
  if (!IMAGE_MEDIA_TYPES.has(part.source.mediaType)) return undefined
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: part.source.mediaType as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp",
      data: part.source.data,
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

function messagesContentParts(
  content: string | Array<AnthropicUserContentBlock>,
): Array<IRPart> {
  if (typeof content === "string") return [{ type: "text", text: content }]
  return content.map((block): IRPart => {
    if (block.type === "text")
      return {
        type: "text",
        text: block.text,
        ...(block.cache_control && { cacheControl: block.cache_control }),
      }
    if (block.type === "image") return imageFromMessages(block)
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
      type: "tool_result",
      callId: block.tool_use_id,
      content:
        typeof block.content === "string" ?
          [{ type: "text", text: block.content }]
        : block.content.map(
            (item): IRToolResultContent =>
              item.type === "text" ?
                {
                  type: "text",
                  text: item.text,
                  ...(item.cache_control && {
                    cacheControl: item.cache_control,
                  }),
                }
              : imageFromMessages(item),
          ),
      ...(block.is_error && { isError: true }),
    }
  })
}

export function decodeMessagesRequest(
  payload: AnthropicMessagesPayload,
): RequestIR {
  const instructions =
    payload.system === undefined ?
      []
    : [
        {
          role: "system" as const,
          parts:
            typeof payload.system === "string" ?
              [{ type: "text" as const, text: payload.system }]
            : payload.system.map((part) => ({
                type: "text" as const,
                text: part.text,
                ...(part.cache_control && { cacheControl: part.cache_control }),
              })),
        },
      ]
  const turns: Array<IRTurn> = payload.messages.map((message) => ({
    role: message.role,
    parts:
      message.role === "user" ? messagesContentParts(message.content)
      : typeof message.content === "string" ?
        [{ type: "text" as const, text: message.content }]
      : message.content.map((block): IRPart => {
          if (block.type === "text")
            return {
              type: "text",
              text: block.text,
              ...(block.cache_control && { cacheControl: block.cache_control }),
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
              input: JSON.stringify(block.input ?? {}),
            }
          return {
            type: "tool_call",
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          }
        }),
    source: { wire: "messages" },
  }))
  const thinking = payload.thinking
  const serverTools = (payload.tools ?? []).filter(
    (tool): tool is AnthropicServerTool => !("input_schema" in tool),
  )
  const functionTools = (payload.tools ?? []).filter(
    (tool): tool is AnthropicTool => "input_schema" in tool,
  )
  const searchTool = serverTools.find((tool) => tool.name === "web_search")
  return {
    model: payload.model,
    source: { wire: "messages" },
    instructions,
    turns,
    ...(functionTools.length > 0 && {
      tools: functionTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      })),
    }),
    ...(payload.tool_choice && {
      toolChoice:
        payload.tool_choice.type === "tool" && payload.tool_choice.name ?
          { type: "tool" as const, name: payload.tool_choice.name }
        : {
            type:
              payload.tool_choice.type === "any" ? ("required" as const)
              : payload.tool_choice.type === "none" ? ("none" as const)
              : ("auto" as const),
          },
    }),
    generation: {
      maxOutputTokens: payload.max_tokens,
      temperature: payload.temperature,
      topP: payload.top_p,
      topK: payload.top_k,
      stopSequences: payload.stop_sequences,
      user: payload.metadata?.user_id,
      serviceTier: payload.service_tier,
      ...(searchTool && {
        webSearch: true,
        webSearchOptions: {
          wireType: searchTool.type,
          ...(searchTool.max_uses !== undefined && {
            maxUses: searchTool.max_uses,
          }),
          ...(searchTool.allowed_domains && {
            allowedDomains: searchTool.allowed_domains,
          }),
          ...(searchTool.blocked_domains && {
            blockedDomains: searchTool.blocked_domains,
          }),
        },
      }),
      ...(thinking && {
        reasoning: {
          mode:
            thinking.type === "enabled" ? ("enabled" as const)
            : thinking.type === "disabled" ? ("disabled" as const)
            : ("adaptive" as const),
          ...(thinking.type === "enabled" && {
            budgetTokens: thinking.budget_tokens,
          }),
          ...(thinking.type !== "disabled" && { display: thinking.display }),
          effort:
            payload.reasoning_effort
            ?? payload.output_config?.effort
            ?? undefined,
        },
      }),
    },
  }
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
    messages.push({
      role: "assistant",
      content: text || null,
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
    stop: generation?.stopSequences,
    stream: options.stream,
    temperature:
      effort && effort !== "none" && effort !== "auto" ?
        1
      : generation?.temperature,
    top_p: generation?.topP,
    user: generation?.user,
    ...chatToolConfig(ir),
    reasoning_effort:
      (
        effort === "auto"
        || (effort === "none" && generation?.reasoning?.mode !== "enabled")
      ) ?
        undefined
      : effort,
  }
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
      if (message.role === "assistant") {
        const alias = extractReasoningTextAlias(message)
        const details =
          message.reasoning_details?.filter((detail) =>
            extractReasoningBlockText(detail),
          ) ?? []
        if (
          details.length > 0
          && alias
          && details.every((detail) =>
            alias.includes(extractReasoningBlockText(detail) ?? ""),
          )
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
      // OpenRouter spells upstream web search as a plugin. It is an intent,
      // not a tool the client executes, so it never becomes an IR tool.
      ...(payload.plugins?.some((plugin) => plugin.id === "web") && {
        webSearch: true,
        webSearchOptions: { wireType: "web" },
      }),
    },
  }
}

/**
 * Anthropic `tool_use.input` must be an object, so malformed arguments (the
 * usual cause: a response truncated by the token limit mid-JSON) have no
 * faithful representation and become `{}` — the request must still go
 * through, matching `encodeMessagesResponse` on the response side.
 */
function parseArguments(value: string): Record<string, unknown> {
  if (!value.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {
    /* Truncated tool JSON has no valid object representation. */
  }
  return {}
}

function asMessagesContent(
  parts: Array<IRPart>,
): string | Array<AnthropicTextBlock | AnthropicImageBlock> {
  const content: Array<AnthropicTextBlock | AnthropicImageBlock> = []
  for (const part of parts) {
    if (part.type === "file")
      throw new Error("File content cannot be represented by Messages")
    if (part.type === "text")
      content.push({
        type: "text",
        text: part.text,
        ...(part.cacheControl && { cache_control: part.cacheControl }),
      })
    if (part.type === "image") {
      const image = imageToMessages(part)
      if (image) content.push(image)
    }
  }
  return (
      content.length === 1
        && content[0].type === "text"
        && !content[0].cache_control
    ) ?
      content[0].text
    : content
}

function webSearchResultBlock(
  part: IRWebSearchResultPart,
): AnthropicWebSearchToolResultBlock {
  return {
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
  }
}

/**
 * Anthropic's own search tool spellings (`web_search_20250305`). Responses'
 * `web_search` / `web_search_preview` must not leak in here.
 */
const ANTHROPIC_SEARCH_TOOL = /^web_search_\d{8}$/

function anthropicSearchWireType(
  value: string | undefined,
): string | undefined {
  return value && ANTHROPIC_SEARCH_TOOL.test(value) ? value : undefined
}

/** Server-tool declaration reconstructed from `generation.webSearch*`. */
function webSearchToolDeclaration(
  ir: RequestIR,
): AnthropicServerTool | undefined {
  if (!ir.generation?.webSearch) return undefined
  const options = ir.generation.webSearchOptions
  return {
    type: anthropicSearchWireType(options?.wireType) ?? "web_search_20250305",
    name: "web_search",
    ...(options?.maxUses !== undefined && { max_uses: options.maxUses }),
    ...(options?.allowedDomains && { allowed_domains: options.allowedDomains }),
    ...(options?.blockedDomains && {
      blocked_domains: options.blockedDomains,
    }),
  }
}

/**
 * Builds the content of a Messages user turn from IR parts.
 *
 * A plain text turn folds back to the string form (the common wire shape a
 * chat client sends); a turn that carried image parts keeps the block-array
 * form even after unrepresentable images are dropped. Tool results pending
 * from preceding Chat `tool` messages merge into the same turn (results
 * first); empty text contributes nothing to a merged tool-result turn.
 */
function userTurnContent(
  parts: Array<IRPart>,
  pendingResults: Array<AnthropicUserContentBlock>,
): string | Array<AnthropicUserContentBlock> {
  const blocks: Array<
    AnthropicTextBlock | AnthropicImageBlock | AnthropicWebSearchToolResultBlock
  > = []
  let carriedImages = false
  for (const part of parts) {
    if (part.type === "text") {
      blocks.push({
        type: "text",
        text: part.text,
        ...(part.cacheControl && { cache_control: part.cacheControl }),
      })
    } else if (part.type === "image") {
      carriedImages = true
      const image = imageToMessages(part)
      if (image) blocks.push(image)
    } else if (part.type === "web_search_result") {
      blocks.push(webSearchResultBlock(part))
    }
  }
  const foldableText =
    !carriedImages
    && blocks.length === 1
    && blocks[0].type === "text"
    && !blocks[0].cache_control
    && pendingResults.length === 0
  if (foldableText) {
    return (
      (blocks[0] as AnthropicTextBlock).text || [
        { type: "text", text: EMPTY_TEXT_PLACEHOLDER },
      ]
    )
  }
  const merged =
    pendingResults.length > 0 ?
      [
        ...pendingResults,
        ...blocks.filter(
          (block) => !(block.type === "text" && block.text === ""),
        ),
      ]
    : blocks
  return merged.length > 0 ?
      merged
    : [{ type: "text", text: EMPTY_TEXT_PLACEHOLDER }]
}

export function encodeMessagesRequest(
  ir: RequestIR,
  options: { stream?: boolean; issuer?: string } = {},
): AnthropicMessagesPayload {
  const systemParts = ir.instructions.flatMap(
    (instruction) => instruction.parts,
  )
  const systemText = systemParts.map((part) => part.text).join("\n\n")
  const system: AnthropicMessagesPayload["system"] =
    systemParts.some((part) => part.cacheControl) ?
      systemParts.map((part) => ({
        type: "text",
        text: part.text,
        ...(part.cacheControl && { cache_control: part.cacheControl }),
      }))
    : systemText
  const messages: AnthropicMessagesPayload["messages"] = []
  let pendingResults: Array<AnthropicUserContentBlock> = []
  const flush = (): void => {
    if (pendingResults.length > 0) {
      messages.push({ role: "user", content: pendingResults })
      pendingResults = []
    }
  }
  for (const turn of ir.turns) {
    if (turn.role === "tool") {
      for (const part of turn.parts)
        if (part.type === "tool_result")
          pendingResults.push({
            type: "tool_result",
            tool_use_id: sanitizeId(part.callId),
            content: asMessagesContent(part.content),
          })
      continue
    }
    if (turn.role === "user") {
      messages.push({
        role: "user",
        content: userTurnContent(turn.parts, pendingResults),
      })
      pendingResults = []
      continue
    }
    flush()
    const content: Array<AnthropicAssistantContentBlock> = []
    for (const part of turn.parts) {
      if (part.type === "image" || part.type === "file")
        throw new Error("Assistant media cannot be represented by Messages")
      if (
        part.type === "thinking"
        && part.signature
        && part.signedText === part.text
        && (!part.source.issuer
          || !options.issuer
          || part.source.issuer === options.issuer)
      )
        content.push({
          type: "thinking",
          thinking: part.text,
          signature: part.signature,
        })
      if (part.type === "text") content.push({ type: "text", text: part.text })
      if (part.type === "tool_call")
        content.push({
          type: "tool_use",
          id: sanitizeId(part.id),
          name: part.name,
          input: parseArguments(part.arguments),
        })
      if (part.type === "server_tool_use")
        content.push({
          type: "server_tool_use",
          id: sanitizeId(part.id),
          name: part.name,
          input: parseArguments(part.input),
        })
    }
    const last = messages.at(-1)
    if (last?.role === "assistant") {
      const previous =
        typeof last.content === "string" ?
          [{ type: "text" as const, text: last.content }]
        : last.content
      const existingIds = new Set(
        previous
          .filter((block) => block.type === "tool_use")
          .map((block) => block.id),
      )
      const appended = content.filter(
        (block) => block.type !== "tool_use" || !existingIds.has(block.id),
      )
      const meaningfulPrevious =
        (
          previous.length === 1
          && previous[0]?.type === "text"
          && previous[0].text === EMPTY_TEXT_PLACEHOLDER
        ) ?
          []
        : previous
      last.content =
        [...meaningfulPrevious, ...appended].length > 0 ?
          [...meaningfulPrevious, ...appended]
        : [{ type: "text", text: EMPTY_TEXT_PLACEHOLDER }]
    } else {
      messages.push({
        role: "assistant",
        content:
          content.length > 0 ?
            content
          : [{ type: "text", text: EMPTY_TEXT_PLACEHOLDER }],
      })
    }
  }
  flush()
  const generation = ir.generation
  const searchTool = webSearchToolDeclaration(ir)
  const effort = generation?.reasoning?.effort
  const claudeEffort =
    effort === "minimal" || effort === "low" ? "low"
    : effort === "medium" ? "medium"
    : effort === "high" || effort === "xhigh" || effort === "max" ? "high"
    : undefined
  return {
    model: ir.model,
    messages,
    max_tokens: generation?.maxOutputTokens ?? MAX_TOKENS_DEFAULT,
    ...(systemText && { system }),
    ...(generation?.stopSequences && {
      stop_sequences: generation.stopSequences,
    }),
    ...(options.stream !== undefined && { stream: options.stream }),
    ...(generation?.temperature !== undefined && {
      temperature: generation.temperature,
    }),
    ...(generation?.topP !== undefined && { top_p: generation.topP }),
    ...(generation?.user && { metadata: { user_id: generation.user } }),
    ...(ir.tools?.length || searchTool ?
      {
        tools: [
          ...(searchTool ? [searchTool] : []),
          ...(ir.tools ?? []).map((tool) => ({
            name: tool.name,
            ...(tool.description && { description: tool.description }),
            input_schema: tool.parameters,
          })),
        ],
      }
    : {}),
    ...(ir.toolChoice && {
      tool_choice:
        ir.toolChoice.type === "tool" ?
          { type: "tool" as const, name: ir.toolChoice.name }
        : {
            type:
              ir.toolChoice.type === "required" ? ("any" as const)
              : ir.toolChoice.type === "none" ? ("none" as const)
              : ("auto" as const),
          },
    }),
    ...(claudeEffort && {
      thinking: { type: "adaptive" as const },
      output_config: { effort: claudeEffort },
    }),
  }
}
