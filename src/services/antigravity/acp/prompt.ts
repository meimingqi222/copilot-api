/**
 * OpenAI ChatCompletions 消息/工具到 ACP prompt 与 MCP 工具定义的转换。
 */

import { createHash } from "node:crypto"

import type {
  ChatCompletionsPayload,
  Message,
  Tool,
} from "~/services/protocols/chat/types"

import type { AcpContentBlock } from "./client"

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

interface TrailingToolResult {
  toolCallId: string
  text: string
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
): Array<AcpContentBlock> {
  if (!Array.isArray(content)) return []
  const blocks: Array<AcpContentBlock> = []
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
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex")
}

export function hashMessages(messages: Array<Message>): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex")
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
    const text = extractTextFromContent(msg.content)
    results.unshift({
      toolCallId: msg.tool_call_id,
      text,
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

  const hasTools = Boolean(payload.tools?.length)
  if (startIndex === 0) {
    if (hasTools) {
      sections.push(
        "[Bridge Mode] You are acting as a stateless API backend. "
          + "Do NOT use local filesystem, shell, or workspace tools. "
          + "Only call the provided `mcp_bridge_*` tools when tools are needed, "
          + "otherwise respond directly.",
      )
    } else {
      sections.push(
        "[Bridge Mode] You are acting as a stateless API backend. "
          + "Respond directly without calling any local filesystem, shell, or workspace tools.",
      )
    }
  }

  for (const msg of slice) {
    const line = formatMessageLine(msg)
    if (line) sections.push(line)
    images.push(...extractImageBlocks(msg.content))
  }

  const blocks: Array<AcpContentBlock> = []
  const combinedText = sections.join("\n\n").trim()
  if (combinedText) {
    blocks.push({ type: "text", text: combinedText })
  }
  blocks.push(...images)
  return blocks
}
