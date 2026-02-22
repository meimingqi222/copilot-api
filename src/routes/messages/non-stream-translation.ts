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
  return {
    model: translateModelName(payload.model),
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system,
    ),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
    thinking: payload.thinking,
    reasoning: translateAnthropicThinkingToOpenAI(payload.thinking),
  }
}

function translateModelName(model: string): string {
  // Subagent requests use a specific model number which Copilot doesn't support
  if (model.startsWith("claude-sonnet-4-")) {
    return model.replace(/^claude-sonnet-4-.*/, "claude-sonnet-4")
  } else if (model.startsWith("claude-opus-")) {
    return model.replace(/^claude-opus-4-.*/, "claude-opus-4")
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

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
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

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  const orderedTextContent = message.content
    .filter(
      (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
        block.type === "text" || block.type === "thinking",
    )
    .map((block) => (block.type === "text" ? block.text : block.thinking))
    .join("\n\n")

  return toolUseBlocks.length > 0 ?
      [
        {
          role: "assistant",
          content: orderedTextContent || null,
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
    : [
        {
          role: "assistant",
          content: mapContent(message.content),
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

function translateAnthropicThinkingToOpenAI(
  thinking: AnthropicMessagesPayload["thinking"],
): ChatCompletionsPayload["reasoning"] {
  if (!thinking) {
    return undefined
  }

  return {
    type: thinking.type,
    enabled: true,
    ...(thinking.type === "enabled"
      && thinking.budget_tokens !== undefined && {
        budget_tokens: thinking.budget_tokens,
      }),
  }
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

function getAnthropicContentBlocks(
  message: ChatCompletionResponse["choices"][number]["message"],
): Array<AnthropicTextBlock | AnthropicThinkingBlock> {
  const blocks: Array<AnthropicTextBlock | AnthropicThinkingBlock> = []
  const seenThinking = new Set<string>()

  const addThinkingBlock = (
    thinking: string | undefined,
    signature?: string,
  ) => {
    if (!thinking) {
      return
    }

    const dedupeKey = `${thinking}\u0000${signature ?? ""}`
    if (seenThinking.has(dedupeKey)) {
      return
    }

    seenThinking.add(dedupeKey)
    blocks.push({
      type: "thinking",
      thinking,
      ...(signature ? { signature } : {}),
    })
  }

  if (typeof message.content === "string") {
    blocks.push({ type: "text", text: message.content })
  } else if (Array.isArray(message.content)) {
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
          addThinkingBlock(
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
  }

  addThinkingBlock(
    message.thinking ?? message.reasoning ?? undefined,
    message.thinking_signature
      ?? message.reasoning_signature
      ?? message.signature
      ?? undefined,
  )

  if (Array.isArray(message.reasoning_details)) {
    for (const detail of message.reasoning_details) {
      addThinkingBlock(getReasoningText(detail), detail.signature)
    }
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
