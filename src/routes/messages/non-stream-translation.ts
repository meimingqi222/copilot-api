import { sanitizeId } from "~/lib/id-sanitizer"
import {
  type ChatCompletionReasoningDetail,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type ReasoningContentPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Payload translation

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const reasoningEffort = translateAnthropicThinkingToReasoningEffort(
    payload.thinking,
  )
  const maxTokens = normalizeMaxTokens(payload.max_tokens)
  return {
    model: translateModelName(payload.model),
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system,
    ),
    // Copilot API enforces an output token limit; cap to avoid premature stream cuts.
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    stop: payload.stop_sequences,
    stream: payload.stream,
    // Copilot requires temperature=1 when reasoning is enabled
    temperature: reasoningEffort !== undefined ? 1 : payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
    reasoning_effort: reasoningEffort,
  }
}

function normalizeMaxTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined
  }

  return Math.min(Math.max(value, 0), 16384)
}

function translateModelName(model: string): string {
  // Normalize date-like snapshots only (e.g. -20250514), keep semantic versions like -6.
  if (/^claude-sonnet-4-\d{8}$/.test(model)) {
    return "claude-sonnet-4"
  } else if (/^claude-opus-4-\d{8}$/.test(model)) {
    return "claude-opus-4"
  }
  return model
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)

  const otherMessages = anthropicMessages.flatMap((message) =>
    message.role === "user" ?
      handleUserMessage(message)
    : handleAssistantMessage(message),
  )

  return [...systemMessages, ...otherMessages]
}

function stripBillingHeader(text: string): string {
  return text.replace(/^x-anthropic-billing-header:[^\n]*\n\n?/, "").trimStart()
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: stripBillingHeader(system) }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: stripBillingHeader(systemText) }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const seenResultIds = new Set<string>()
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock => {
        if (block.type !== "tool_result") return false
        if (seenResultIds.has(block.tool_use_id)) return false
        seenResultIds.add(block.tool_use_id)
        return true
      },
    )
    const otherBlocks = message.content.filter(
      (block) => block.type !== "tool_result",
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: sanitizeId(block.tool_use_id),
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
      },
    ]
  }

  const seenToolIds = new Set<string>()
  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => {
      if (block.type !== "tool_use") return false
      if (seenToolIds.has(block.id)) return false
      seenToolIds.add(block.id)
      return true
    },
  )

  const textContent = message.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")

  const thinkingContent = message.content
    .filter(
      (block): block is AnthropicThinkingBlock => block.type === "thinking",
    )
    .map((block) => block.thinking)
    .join("\n\n")

  const baseMessage = {
    role: "assistant" as const,
    content: textContent || null,
    ...(thinkingContent ? { reasoning_text: thinkingContent } : {}),
  }

  if (toolUseBlocks.length === 0) {
    return [baseMessage]
  }

  // Copilot API rejects assistant messages that have both reasoning_text and tool_calls.
  // Strip reasoning_text when tool_calls are present.
  const { reasoning_text: _dropped, ...baseMessageWithoutReasoning } =
    baseMessage
  return [
    {
      ...baseMessageWithoutReasoning,
      tool_calls: toolUseBlocks.map((toolUse) => ({
        id: sanitizeId(toolUse.id),
        type: "function",
        function: {
          name: toolUse.name,
          arguments: JSON.stringify(toolUse.input),
        },
      })),
    },
  ]
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .filter(
        (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
          block.type === "text" || block.type === "thinking",
      )
      .map((block) => (block.type === "text" ? block.text : block.thinking))
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })

        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })

        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })

        break
      }
      // No default
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

// Maps Anthropic thinking config to Copilot's reasoning_effort parameter.
// Copilot proxy (api.githubcopilot.com) uses OpenAI-compatible format with
// reasoning_effort instead of Anthropic's budget_tokens.
// Budget mapping:
// - minimal: 512 (低成本推理)
// - low: 1024 (快速推理)
// - medium: 8192 (默认推理深度)
// - high: 24576 (深度推理)
// - xhigh: 32768 (更深推理)
function translateAnthropicThinkingToReasoningEffort(
  thinking: AnthropicMessagesPayload["thinking"],
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!thinking) {
    return undefined
  }

  if (thinking.type === "enabled") {
    const budget = thinking.budget_tokens ?? 8192 // default to medium
    // Map budget_tokens to effort levels
    if (budget >= 32768) return "xhigh"
    if (budget >= 24576) return "high"
    if (budget >= 8192) return "medium"
    if (budget >= 1024) return "low"
    return "minimal"
  }

  // adaptive: let the model decide, default to high
  return "high"
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: anthropicToolChoice.name },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
): AnthropicResponse {
  const primaryChoice = response.choices[0]
  const contentBlocks = getAnthropicContentBlocks(primaryChoice.message)
  const toolUseBlocks = getAnthropicToolUseBlocks(
    primaryChoice.message.tool_calls,
  )

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...contentBlocks, ...toolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(primaryChoice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens
        !== undefined && {
        cache_read_input_tokens:
          response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
}

type CopilotResponseMessage =
  ChatCompletionResponse["choices"][number]["message"]
type ThinkingCollector = {
  blocks: Array<AnthropicTextBlock | AnthropicThinkingBlock>
  seenThinking: Set<string>
}

function addThinkingBlockUnique(
  collector: ThinkingCollector,
  thinking: string | undefined,
  signature?: string,
): void {
  if (!thinking) {
    return
  }

  const dedupeKey = `${thinking}\u0000${signature ?? ""}`
  if (collector.seenThinking.has(dedupeKey)) {
    return
  }

  collector.seenThinking.add(dedupeKey)
  collector.blocks.push({
    type: "thinking",
    thinking,
    ...(signature ? { signature } : {}),
  })
}

function addTopLevelReasoningBlocks(
  message: CopilotResponseMessage,
  collector: ThinkingCollector,
): void {
  addThinkingBlockUnique(
    collector,
    message.reasoning_text
      ?? message.thinking
      ?? message.reasoning
      ?? undefined,
    message.reasoning_opaque
      ?? message.thinking_signature
      ?? message.reasoning_signature
      ?? message.signature
      ?? undefined,
  )

  if (Array.isArray(message.reasoning_details)) {
    for (const detail of message.reasoning_details) {
      addThinkingBlockUnique(
        collector,
        getReasoningText(detail),
        detail.signature,
      )
    }
  }
}

function getAnthropicContentBlocks(
  message: CopilotResponseMessage,
): Array<AnthropicTextBlock | AnthropicThinkingBlock> {
  const blocks: Array<AnthropicTextBlock | AnthropicThinkingBlock> = []
  const seenThinking = new Set<string>()
  const collector = { blocks, seenThinking }

  if (typeof message.content === "string") {
    // For Copilot proxy responses: reasoning_text comes before content in generation order.
    // Anthropic protocol requires thinking blocks to appear before text blocks.
    addTopLevelReasoningBlocks(message, collector)
    blocks.push({ type: "text", text: message.content })
  } else if (Array.isArray(message.content)) {
    // For array content: preserve original order (may be interleaved thinking/text).
    for (const part of message.content) {
      switch (part.type) {
        case "text": {
          blocks.push({ type: "text", text: part.text })
          break
        }
        case "output_text": {
          blocks.push({ type: "text", text: part.text })
          break
        }
        case "reasoning":
        case "thinking": {
          addThinkingBlockUnique(
            collector,
            getReasoningText(part),
            "signature" in part ? part.signature : undefined,
          )
          break
        }
        default: {
          break
        }
      }
    }

    // Also check top-level fields; deduplication prevents double-counting.
    addTopLevelReasoningBlocks(message, collector)
  } else {
    // message.content can be null for tool-call-only responses; keep reasoning blocks.
    addTopLevelReasoningBlocks(message, collector)
  }

  return blocks
}

function getReasoningText(
  source: ChatCompletionReasoningDetail | ReasoningContentPart,
): string | undefined {
  return source.thinking ?? source.reasoning ?? source.text
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: sanitizeId(toolCall.id),
    name: toolCall.function.name,
    input: parseToolCallArguments(toolCall.function.arguments),
  }))
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
    return {}
  }

  return {}
}
