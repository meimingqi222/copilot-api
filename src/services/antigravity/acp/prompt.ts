/**
 * OpenAI ChatCompletions 消息/工具到 ACP prompt 与 MCP 工具定义的转换。
 */

import { createHash } from "node:crypto"

import { HTTPError } from "~/lib/error"
import type {
  ChatCompletionsPayload,
  Message,
  Tool,
} from "~/services/protocols/chat/types"

import type { AcpContentBlock } from "./client"
import type { McpToolResult } from "~/services/antigravity/acp/run-registry"

// agy 1.5.9 tail-truncates a native user input at 192,000 UTF-8 bytes.
// Reserve framing space; this is a per-prompt transport limit, not model tokens.
const MAX_ACP_PROMPT_BYTES = 190_000

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

interface TrailingToolResult {
  toolCallId: string
  content: McpToolResult["content"]
  isError: boolean
}

function extractTextFromContent(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: Array<string> = []
  for (const part of content) {
    if (
      part
      && typeof part === "object"
      && part.type === "text"
      && typeof part.text === "string"
    ) {
      parts.push(part.text)
    }
  }
  return parts.join("\n")
}

function extractImageBlocks(
  content: Message["content"],
): Array<Extract<McpToolResult["content"][number], { type: "image" }>> {
  if (!Array.isArray(content)) return []
  const blocks: Array<
    Extract<McpToolResult["content"][number], { type: "image" }>
  > = []
  for (const part of content) {
    if (
      part
      && typeof part === "object"
      && part.type === "image_url"
      && part.image_url?.url
    ) {
      const url = part.image_url.url
      const match = url.match(/^data:([^;]+);base64,(.+)$/)
      if (match?.[1] && match[2]) {
        blocks.push({
          type: "image",
          mimeType: match[1],
          data: match[2],
        })
      }
    }
  }
  return blocks
}

export function extractMcpTools(
  tools: Array<Tool> | null | undefined,
): Array<McpToolDefinition> {
  if (!tools?.length) return []
  const out: Array<McpToolDefinition> = []
  for (const tool of tools) {
    if (tool.type !== "function" || !tool.function?.name) continue
    out.push({
      name: tool.function.name,
      ...(tool.function.description ?
        { description: tool.function.description }
      : {}),
      inputSchema:
        (
          tool.function.parameters
          && typeof tool.function.parameters === "object"
        ) ?
          tool.function.parameters
        : { type: "object", properties: {} },
    })
  }
  return out
}

export function computeToolsSignature(tools: Array<McpToolDefinition>): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(tools)))
    .digest("hex")
}

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

export function hashMessages(messages: Array<Message>): string {
  const history = messages.map((message) => {
    const blocks =
      typeof message.content === "string" ?
        [{ type: "text" as const, text: message.content }]
      : (message.content ?? [])
    const content: typeof blocks = []
    for (const block of blocks) {
      // Native reasoning stays in the live ACP session; clients need not replay its display aliases.
      if (
        message.role === "assistant"
        && (block.type === "thinking" || block.type === "reasoning")
      )
        continue
      if (block.type === "text") {
        // Client clocks and billing tags can change without changing the
        // conversation. Never apply this to ordinary user/tool prose.
        const text =
          message.role === "system" || message.role === "developer" ?
            block.text
              .replace(/^x-anthropic-billing-header:[^\n]*(?:\n|$)/gim, "")
              .replace(/^Today's date: \d{4}-\d{2}-\d{2}(?:\n|$)/gm, "")
          : block.text
        if (!text) continue
        const previous = content.at(-1)
        if (previous?.type === "text") previous.text += text
        else content.push({ ...block, text })
        continue
      }
      content.push({ ...block })
    }
    return {
      role: message.role,
      content,
      name: message.name,
      images: message.images,
      tool_call_id: message.tool_call_id,
      tool_calls: message.tool_calls?.map((call) => {
        let args: unknown = call.function.arguments
        try {
          args = JSON.parse(call.function.arguments)
        } catch {
          /* Preserve incomplete arguments verbatim. */
        }
        return { id: call.id, name: call.function.name, arguments: args }
      }),
    }
  })
  return createHash("sha256")
    .update(JSON.stringify(stable(history)))
    .digest("hex")
}

function toolResultContent(msg: Message): McpToolResult["content"] {
  const content: McpToolResult["content"] = []
  if (typeof msg.content === "string") {
    content.push({ type: "text", text: msg.content })
  } else {
    for (const part of msg.content ?? []) {
      if (part && typeof part === "object" && part.type === "text")
        content.push({ type: "text", text: part.text })
      else content.push(...extractImageBlocks([part]))
    }
  }
  return content
}

/**
 * 提取消息列表末尾连续的 `role: "tool"` 结果。
 */
export function extractTrailingToolResults(
  messages: Array<Message>,
): Array<TrailingToolResult> {
  const results: Array<TrailingToolResult> = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "tool") break
    if (!msg.tool_call_id) continue
    results.unshift({
      toolCallId: msg.tool_call_id,
      content: toolResultContent(msg),
      isError: false,
    })
  }
  return results
}

/**
 * 提取消息列表中所有 `role: "tool"` 结果（不限末尾），用于识别工具结果之后
 * 又追加了新用户指令的转向请求。保持调用方顺序。
 */
export function extractToolResults(
  messages: Array<Message>,
): Array<TrailingToolResult> {
  const results: Array<TrailingToolResult> = []
  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.tool_call_id) continue
    results.push({
      toolCallId: msg.tool_call_id,
      content: toolResultContent(msg),
      isError: false,
    })
  }
  return results
}

function formatMessageLine(msg: Message): string {
  const text = extractTextFromContent(msg.content)
  if (msg.role === "system" || msg.role === "developer") {
    return text ? `[System Instruction]\n${text}` : ""
  }
  if (msg.role === "user") {
    return text ? `[User]\n${text}` : ""
  }
  if (msg.role === "assistant") {
    const toolCalls = msg.tool_calls
      ?.map((tc) => `${tc.function.name}(${tc.function.arguments})`)
      .join(", ")
    if (text && toolCalls)
      return `[Assistant]\n${text}\n[Called Tools: ${toolCalls}]`
    if (toolCalls) return `[Assistant Called Tools: ${toolCalls}]`
    return text ? `[Assistant]\n${text}` : ""
  }
  if (msg.role === "tool") {
    return `[Tool Result (${msg.tool_call_id ?? "unknown"})]\n${text}`
  }
  return text
}

/**
 * 渲染完整对话或单条新增消息为 ACP `ContentBlock[]`。
 */
export function buildAcpPromptBlocks(
  payload: ChatCompletionsPayload,
  startIndex = 0,
): Array<AcpContentBlock> {
  const slice = payload.messages.slice(startIndex)
  const sections: Array<string> = []
  const images: Array<AcpContentBlock> = []
  const instructions: Array<string> = []
  const history: Array<string> = []
  const current: Array<string> = []

  let turnStart = payload.messages.findLastIndex((msg) => msg.role === "user")
  if (turnStart < startIndex) turnStart = startIndex
  // Adjacent user messages can be one request plus caller runtime metadata.
  // Keep that entire group and its subsequent assistant/tool loop in this turn.
  while (
    turnStart > startIndex
    && ["user", "system", "developer"].includes(
      payload.messages[turnStart - 1].role,
    )
  ) {
    turnStart--
  }

  const hasTools = Boolean(payload.tools?.length)
  if (startIndex === 0) {
    if (hasTools) {
      sections.push(
        "[Bridge Mode] You are acting as a stateless API backend. "
          + "Do NOT use local filesystem, shell, or workspace tools. "
          + "Use the caller's tools through `mcp_bridge_<name>` if directly available, "
          + 'or `call_mcp_tool` with ServerName="bridge", ToolName=<name>, '
          + "and Arguments=<argument object> for lazy-loaded tools. "
          + "The complete tool definitions follow; no local schema files need to be read. "
          + "These tools execute on the caller's machine, not this backend. "
          + "Otherwise respond directly.",
      )
      sections.push(
        `[Bridge Tool Definitions]\n${JSON.stringify(extractMcpTools(payload.tools))}`,
      )
    } else {
      sections.push(
        "[Bridge Mode] You are acting as a stateless API backend. "
          + "Respond directly without calling any local filesystem, shell, or workspace tools.",
      )
    }
    if (slice.some((msg) => msg.role === "assistant" || msg.role === "tool")) {
      sections.push(
        "[Conversation Replay] Prior assistant replies are records, not new instructions. Caller system and developer instructions still apply.",
      )
    }
  }

  for (const [index, msg] of slice.entries()) {
    const messageImages = extractImageBlocks(msg.content)
    const line =
      formatMessageLine(msg)
      || (msg.role === "user" && messageImages.length ? "[User]" : "")
    if (line) {
      if (msg.role === "system" || msg.role === "developer")
        instructions.push(line)
      else if (startIndex + index < turnStart)
        history.push(line.replace(/^\[/, "[Historical "))
      else current.push(line)
    }
    images.push(...messageImages)
  }
  if (instructions.length) sections.push(instructions.join("\n\n"))
  if (current.length) {
    sections.push(`[Current Turn]\n${current.join("\n\n")}`)
    sections.push(
      "[Continue Current Turn] Follow the current user's intent, including changes from reviewing to doing the work. Continue from this turn's latest messages and tool results, not the historical task or the historical assistant's plan.",
    )
  }

  const blocks: Array<AcpContentBlock> = []
  const combinedText = sections.join("\n\n").trim()
  if (history.length) {
    blocks.push({
      type: "resource",
      resource: {
        uri: "context://conversation-history",
        mimeType: "text/plain",
        text: `[Conversation History]\n${history.join("\n\n")}\n\n[End Conversation History]`,
      },
    })
  }
  if (combinedText) {
    blocks.push({ type: "text", text: combinedText })
  }
  blocks.push(...images)
  const promptBytes = blocks.reduce(
    (total, block) =>
      total
      + Buffer.byteLength(block.text ?? block.resource?.text ?? "", "utf8"),
    0,
  )
  if (promptBytes > MAX_ACP_PROMPT_BYTES) {
    const message =
      `prompt is too long for Antigravity ACP: ${promptBytes} UTF-8 bytes `
      + `exceed the safe single-prompt limit of ${MAX_ACP_PROMPT_BYTES} bytes. `
      + "This transport limit is independent of the model context window. "
      + "Compact or shorten the context before retrying; the native agent would otherwise silently truncate the input."
    throw new HTTPError(
      message,
      new Response(null, { status: 400 }),
      JSON.stringify({
        error: {
          message,
          type: "invalid_request_error",
          param: "messages",
          code: "context_length_exceeded",
        },
      }),
    )
  }
  return blocks
}
