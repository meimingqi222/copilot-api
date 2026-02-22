import type {
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicUserMessage,
} from "./anthropic-types"

import { hasClaudeCodeBeta } from "./anthropic-beta"

export type CopilotInitiator = "agent" | "user"

function hasToolResult(message: AnthropicUserMessage): boolean {
  return (
    Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_result")
  )
}

function hasToolUse(message: AnthropicAssistantMessage): boolean {
  return (
    Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_use")
  )
}

function getUserText(message: AnthropicUserMessage): string {
  if (typeof message.content === "string") {
    return message.content
  }

  if (!Array.isArray(message.content)) {
    return ""
  }

  return message.content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n\n")
}

function isLikelyClaudeCodeCompaction(
  lastMessage: AnthropicUserMessage,
  previousMessage: AnthropicMessage | undefined,
  anthropicBeta?: string,
): boolean {
  if (!hasClaudeCodeBeta(anthropicBeta)) {
    return false
  }

  if (previousMessage?.role !== "assistant") {
    return false
  }

  const text = getUserText(lastMessage).trim()
  if (text.length < 800) {
    return false
  }

  return /summary|summarize|compression?|context window|conversation/i.test(
    text,
  )
}

export function inferInitiatorFromAnthropicMessages(
  messages: Array<AnthropicMessage>,
  anthropicBeta?: string,
): CopilotInitiator {
  if (messages.length === 0) {
    return "user"
  }

  const lastMessage = messages.at(-1) as AnthropicMessage

  if (lastMessage.role === "assistant") {
    return "agent"
  }

  if (hasToolResult(lastMessage)) {
    return "agent"
  }

  const previousMessage = messages.at(-2)
  if (previousMessage?.role === "assistant" && hasToolUse(previousMessage)) {
    return "agent"
  }

  if (
    isLikelyClaudeCodeCompaction(lastMessage, previousMessage, anthropicBeta)
  ) {
    return "agent"
  }

  return "user"
}
