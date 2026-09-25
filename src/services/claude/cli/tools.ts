/**
 * 调用方的工具 → MCP 工具定义。
 *
 * 直译 magpie 的 `bridgeTools()`（`internal/gateway/cursor_subscription.go:150`，
 * Claude 路径复用同一个）。
 *
 * 两个要点：
 *
 * - `tool_choice: "none"` 时不暴露任何工具；`tool_choice: {type:"tool", name}`
 *   时只暴露那一个。否则模型可能去调一个调用方明确禁止的工具。
 * - 输出**按名字稳定排序**。工具定义位于 token 流的 messages 之前，顺序抖动
 *   会让整段 prompt cache 失效（见 `docs/todo-claude-cli-transport.md` §6.1）。
 */

import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"

/** MCP `tools/list` 里的一个工具。 */
export interface BridgeTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** 没有 schema 的工具也要给一个合法的空对象 schema，否则 CLI 会拒绝。 */
const EMPTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
}

export function bridgeTools(
  payload: AnthropicMessagesPayload,
): Array<BridgeTool> {
  const choice = payload.tool_choice
  const only = choice?.type === "tool" ? choice.name : undefined
  const out: Array<BridgeTool> = []
  for (const tool of payload.tools ?? []) {
    if (choice?.type === "none") continue
    if (only && tool.name !== only) continue
    out.push({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.input_schema ?? EMPTY_SCHEMA,
    })
  }
  out.sort((a, b) =>
    a.name < b.name ? -1
    : a.name > b.name ? 1
    : 0,
  )
  return out
}

/** 从调用方的 messages 里收集所有 `tool_result` 的 `tool_use_id`。 */
export function toolResultIds(
  payload: AnthropicMessagesPayload,
): Array<string> {
  const ids: Array<string> = []
  for (const message of payload.messages) {
    if (typeof message.content === "string") continue
    for (const block of message.content) {
      if (block.type === "tool_result") ids.push(block.tool_use_id)
    }
  }
  return ids
}

/** 从调用方的 messages 里取出 `tool_result`，供唤醒挂起的 run。 */
export interface BridgeToolResult {
  toolUseId: string
  text: string
  isError: boolean
}

export function toolResults(
  payload: AnthropicMessagesPayload,
): Array<BridgeToolResult> {
  const out: Array<BridgeToolResult> = []
  for (const message of payload.messages) {
    if (typeof message.content === "string") continue
    for (const block of message.content) {
      if (block.type !== "tool_result") continue
      out.push({
        toolUseId: block.tool_use_id,
        text: toolResultText(block.content),
        isError: block.is_error === true,
      })
    }
  }
  return out
}

function toolResultText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : "[image]"))
    .join("")
}
