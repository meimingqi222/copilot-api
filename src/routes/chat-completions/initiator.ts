import type { Message } from "~/services/copilot/create-chat-completions"

type CopilotInitiator = "agent" | "user"

const CODEX_COMPACTION_SUMMARY_PREFIX =
  "Another language model started to solve this problem"

const CODEX_COMPACTION_PROMPT_MARKER = "CONTEXT CHECKPOINT COMPACTION"

function getMessageText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content
  }

  if (!Array.isArray(message.content)) {
    return ""
  }

  return message.content
    .map((part) => {
      if ("text" in part && typeof part.text === "string") {
        return part.text
      }
      if ("thinking" in part && typeof part.thinking === "string") {
        return part.thinking
      }
      if ("reasoning" in part && typeof part.reasoning === "string") {
        return part.reasoning
      }
      return ""
    })
    .join("\n\n")
}

function getLastConversationMessage(
  messages: Array<Message>,
): Message | undefined {
  return [...messages]
    .reverse()
    .find((message) => !["developer", "system"].includes(message.role))
}

function getPreviousConversationMessage(
  messages: Array<Message>,
  lastMessage: Message,
): Message | undefined {
  const conversationMessages = messages.filter(
    (message) => !["developer", "system"].includes(message.role),
  )

  const lastIndex = conversationMessages.lastIndexOf(lastMessage)
  if (lastIndex <= 0) {
    return undefined
  }

  return conversationMessages[lastIndex - 1]
}

function isLikelyCodexCompactionOrSyntheticUserMessage(
  text: string,
  previousMessage: Message | undefined,
  userAgent?: string,
): boolean {
  if (previousMessage?.role !== "assistant") {
    return false
  }

  const trimmed = text.trim()
  if (!trimmed) {
    return false
  }

  if (trimmed.startsWith(CODEX_COMPACTION_SUMMARY_PREFIX)) {
    return true
  }

  if (trimmed.includes(CODEX_COMPACTION_PROMPT_MARKER)) {
    return true
  }

  if (
    trimmed.includes("<environment_context>")
    || trimmed.includes("</environment_context>")
  ) {
    return true
  }

  const looksLikeCodexClient = userAgent?.toLowerCase().includes("codex")
  if (!looksLikeCodexClient) {
    return false
  }

  if (trimmed.length < 800) {
    return false
  }

  return /summary|summarize|compact(?:ion)?|context window|handoff/i.test(
    trimmed,
  )
}

export function inferInitiatorFromOpenAIMessages(
  messages: Array<Message>,
  userAgent?: string,
): CopilotInitiator {
  const lastMessage = getLastConversationMessage(messages)
  if (!lastMessage) {
    return "user"
  }

  if (["assistant", "tool"].includes(lastMessage.role)) {
    return "agent"
  }

  if (lastMessage.role !== "user") {
    return "user"
  }

  const previousMessage = getPreviousConversationMessage(messages, lastMessage)
  if (
    isLikelyCodexCompactionOrSyntheticUserMessage(
      getMessageText(lastMessage),
      previousMessage,
      userAgent,
    )
  ) {
    return "agent"
  }

  return "user"
}
