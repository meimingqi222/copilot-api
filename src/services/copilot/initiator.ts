import type { CopilotInitiator } from "~/lib/initiator-header"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import type { ResponsesPayload } from "./responses-api"

interface OpenAIMessageLike {
  role: string
}

export function inferInitiatorFromChatMessages(
  messages: Array<OpenAIMessageLike>,
): CopilotInitiator {
  const lastConversationMessage = [...messages]
    .reverse()
    .find((message) => !["developer", "system"].includes(message.role))

  if (!lastConversationMessage) {
    return "user"
  }

  return ["assistant", "tool"].includes(lastConversationMessage.role) ? "agent"
    : "user"
}

export function inferInitiatorFromAnthropicPayload(
  payload: Pick<AnthropicMessagesPayload, "messages">,
): CopilotInitiator {
  const lastMessage = payload.messages.at(-1)
  if (!lastMessage) {
    return "user"
  }

  if (lastMessage.role === "assistant") {
    return "agent"
  }

  if (
    Array.isArray(lastMessage.content)
    && lastMessage.content.some((block) => block.type === "tool_result")
  ) {
    return "agent"
  }

  return "user"
}

export function inferInitiatorFromResponsesPayload(
  payload: Pick<ResponsesPayload, "input">,
): CopilotInitiator {
  if (typeof payload.input === "string") {
    return "user"
  }

  const lastInput = payload.input.at(-1)
  if (!lastInput) {
    return "user"
  }

  if ("role" in lastInput) {
    return lastInput.role === "assistant" ? "agent" : "user"
  }

  return "agent"
}
