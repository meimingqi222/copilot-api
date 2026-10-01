/**
 * 调用方的工具 → MCP 工具定义。
 *
 * 两个要点：
 *
 * - `tool_choice: "none"` 时不暴露任何工具；`tool_choice: {type:"tool", name}`
 *   时只暴露那一个。否则模型可能去调一个调用方明确禁止的工具。
 * - 输出**按名字稳定排序**。工具定义位于 token 流的 messages 之前，顺序抖动
 *   会让整段 prompt cache 失效（见 `docs/todo-claude-cli-transport.md` §6.1）。
 */

import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"

import { CLAUDE_WAIT_TOOL_NAME } from "./mcp-names"

/** MCP `tools/list` 里的一个工具。 */
interface BridgeTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** 没有 schema 的工具也要给一个合法的空对象 schema，否则 CLI 会拒绝。 */
const EMPTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
}

/**
 * 迟到结果的收集入口，只给 CLI 看(见 `CLAUDE_WAIT_TOOL_NAME`)。
 *
 * schema 与 magpie 的 `magpie_wait` 同形:模型把"还在跑"那条答复里给出的
 * tool_use id 原样填进 `call`。
 */
const WAIT_TOOL: BridgeTool = {
  name: CLAUDE_WAIT_TOOL_NAME,
  description:
    "Collect the result of a tool call that is still running in the user's "
    + 'environment. Call this only with the id from a "still running" reply, '
    + "and never repeat the original call.",
  inputSchema: {
    type: "object",
    properties: {
      call: {
        type: "string",
        description: "The tool_use id of the call that is still running.",
      },
    },
    required: ["call"],
  },
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
    // The Claude CLI executes client tools itself; upstream server tools
    // (e.g. web_search) have no bridge representation.
    if (!("input_schema" in tool)) continue
    out.push({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.input_schema ?? EMPTY_SCHEMA,
    })
  }
  // 只有存在调用方工具时才加:没有工具就没有"等调用方执行"这回事,而多一个
  // 工具定义会改变 prompt 前缀(§6.1 的 cache 约束)。
  if (out.length > 0) out.push(WAIT_TOOL)
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
interface BridgeToolResult {
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
