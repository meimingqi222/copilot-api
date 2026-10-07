import { createHash } from "node:crypto"

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
} from "~/services/protocols/anthropic/types"

/** Stable keys compare complete content, including image bytes and tool inputs. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    )
  }
  return value
}

export function sessionKey(
  owner: string,
  payload: AnthropicMessagesPayload,
  messages = payload.messages,
): string {
  const { messages: _messages, stream: _stream, ...config } = payload
  delete config.reasoning_effort
  if (config.output_config) {
    const { effort: _effort, ...output } = config.output_config
    if (Object.keys(output).length) config.output_config = output
    else delete config.output_config
  }
  const history = messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string" ?
        [{ type: "text", text: message.content }]
      : message.content,
  }))
  return createHash("sha256")
    .update(JSON.stringify(stable({ owner, config, history })))
    .digest("hex")
}

/** Mixed continuations must replay so fresh instructions and images reach the CLI. */
export function hasFreshContent(payload: AnthropicMessagesPayload): boolean {
  const last = payload.messages.findLastIndex(
    (message) => message.role === "assistant",
  )
  return payload.messages
    .slice(last + 1)
    .some(
      (message) =>
        typeof message.content === "string"
        || message.content.some((block) => block.type !== "tool_result"),
    )
}

export function claudeEffort(payload: AnthropicMessagesPayload): string {
  const effort = payload.output_config?.effort ?? payload.reasoning_effort
  if (!effort || effort === "none" || effort === "auto") return ""
  return effort === "minimal" ? "low" : effort
}

/** Parked runs may add client tools, but cannot remove or rewrite existing tools. */
export function withOriginalTools(
  previous: AnthropicMessagesPayload,
  next: AnthropicMessagesPayload,
): AnthropicMessagesPayload | undefined {
  const before = previous.tools ?? []
  const after = next.tools ?? []
  const names = new Set(after.map((tool) => tool.name))
  if (names.size !== after.length) return undefined
  for (const tool of before) {
    const replacement = after.find((item) => item.name === tool.name)
    if (JSON.stringify(stable(tool)) !== JSON.stringify(stable(replacement)))
      return undefined
  }
  if (
    after.some(
      (tool) =>
        !before.some((old) => old.name === tool.name)
        && !("input_schema" in tool),
    )
  )
    return undefined
  return { ...next, tools: previous.tools }
}

/** Only a normal user continuation can check out an idle process. */
export function continuation(
  payload: AnthropicMessagesPayload,
):
  | { history: Array<AnthropicMessage>; since: Array<AnthropicMessage> }
  | undefined {
  const last = payload.messages.findLastIndex(
    (message) => message.role === "assistant",
  )
  if (last < 0 || last === payload.messages.length - 1) return undefined
  const since = payload.messages.slice(last + 1)
  if (
    since.some(
      (message) =>
        message.role !== "user"
        || (Array.isArray(message.content)
          && message.content.some((block) => block.type === "tool_result")),
    )
  )
    return undefined
  return { history: payload.messages.slice(0, last + 1), since }
}
