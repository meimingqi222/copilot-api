import type { Context } from "hono"

import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"
import type { ResponsesPayload } from "~/services/protocols/responses/types"

export type CopilotInitiator = "agent" | "user"

interface OpenAIMessageLike {
  role: string
}

/**
 * 从客户端请求推断 initiator。
 *
 * 属于应用层的请求分类（哪些路由都会用到），不属于 Copilot provider ——
 * 放在这里与 header 解析同一处，provider 只消费结果。
 */
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

function normalizeInitiator(
  value: string | undefined,
): CopilotInitiator | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "agent" || normalized === "user") {
    return normalized
  }
  return undefined
}

export function resolveInitiatorWithClientHeader(
  c: Context,
  inferredInitiator: CopilotInitiator,
): {
  clientInitiator: CopilotInitiator | undefined
  initiator: CopilotInitiator
  trustedClientAgent: boolean
} {
  const clientInitiator = normalizeInitiator(c.req.header("x-initiator"))
  const { initiator, trustedClientAgent } = resolveInitiatorFromHeader(
    clientInitiator,
    inferredInitiator,
  )

  return {
    clientInitiator,
    initiator,
    trustedClientAgent,
  }
}

export function resolveInitiatorFromHeader(
  clientInitiator: CopilotInitiator | undefined,
  inferredInitiator: CopilotInitiator,
): {
  initiator: CopilotInitiator
  trustedClientAgent: boolean
} {
  const trustedClientAgent = clientInitiator === "agent"
  const initiator = trustedClientAgent ? "agent" : inferredInitiator
  return { initiator, trustedClientAgent }
}
