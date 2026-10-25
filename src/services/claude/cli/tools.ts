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

import type {
  AnthropicMessagesPayload,
  AnthropicToolResultBlock,
} from "~/services/protocols/anthropic/types"

import type { McpToolResult } from "~/services/claude/cli/run-registry"

import { CLAUDE_WAIT_TOOL_NAME } from "./mcp-names"

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

/**
 * 迟到结果的收集入口，只给 CLI 看(见 `CLAUDE_WAIT_TOOL_NAME`)。
 *
 * schema：模型把"还在跑"那条答复里给出的
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

/**
 * 调用方声明的工具名 → 交给 Claude Code 的名字。
 *
 * Claude Code 只保留 MCP 工具名里的 `[A-Za-z0-9_-]`：调用方的 `spawn.agent`
 * 会被它叫成 `spawn_agent`，原样回传的话调用方根本没有这个工具。所以先由
 * 我们换成合法名字（撞名时加 `_2`…），回传时再换回声明的名字。
 * 按 payload 里的顺序确定，同一份工具表每轮得到同样的名字（prompt cache）。
 */
export function bridgeToolNames(
  payload: AnthropicMessagesPayload,
): Map<string, string> {
  const names = new Map<string, string>()
  const taken = new Set<string>([CLAUDE_WAIT_TOOL_NAME])
  for (const tool of payload.tools ?? []) {
    if (!("input_schema" in tool) || names.has(tool.name)) continue
    const base = tool.name.replaceAll(/[^\w-]/g, "_") || "tool"
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`
    taken.add(name)
    names.set(tool.name, name)
  }
  return names
}

/** 交给 Claude Code 的名字 → 调用方声明的名字。 */
export function declaredToolNames(
  payload: AnthropicMessagesPayload,
): Map<string, string> {
  return new Map(
    [...bridgeToolNames(payload)].map(([declared, bridge]) => [
      bridge,
      declared,
    ]),
  )
}

export function bridgeTools(
  payload: AnthropicMessagesPayload,
): Array<BridgeTool> {
  const choice = payload.tool_choice
  const only = choice?.type === "tool" ? choice.name : undefined
  const names = bridgeToolNames(payload)
  const out: Array<BridgeTool> = []
  for (const tool of payload.tools ?? []) {
    if (choice?.type === "none") continue
    if (only && tool.name !== only) continue
    // The Claude CLI executes client tools itself; upstream server tools
    // (e.g. web_search) have no bridge representation.
    if (!("input_schema" in tool)) continue
    out.push({
      name: names.get(tool.name) ?? tool.name,
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
  for (const message of freshResultMessages(payload)) {
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
  content: McpToolResult["content"]
  isError: boolean
}

export function toolResults(
  payload: AnthropicMessagesPayload,
): Array<BridgeToolResult> {
  const out: Array<BridgeToolResult> = []
  const notices: Array<string> = []
  for (const message of freshResultMessages(payload)) {
    if (typeof message.content === "string") {
      notices.push(...sideNotices(message.content))
      continue
    }
    for (const block of message.content) {
      if (block.type === "text") notices.push(...sideNotices(block.text))
      if (block.type !== "tool_result") continue
      out.push({
        toolUseId: block.tool_use_id,
        content: toolResultContent(block.content),
        isError: block.is_error === true,
      })
    }
  }
  // A running Claude Code only hears what arrives as a tool result, so what
  // came beside the results rides on the last one, as Claude Code itself
  // attaches a notice that lands mid-turn.
  const last = out.at(-1)
  if (last && notices.length)
    last.content = [...last.content, { type: "text", text: notices.join("\n") }]
  return out
}

const TASK_NOTIFICATION = /<task-notification>[\s\S]*?<\/task-notification>/g
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/**
 * What a text beside the tool results must still reach the run with.
 *
 * - `<task-notification>`: a background sub-agent finished (Claude Code
 *   2.1.310 runs Agent sub-agents in the background). Dropped, the model
 *   never hears it and keeps waiting.
 * - The user's own words typed while the agent worked.
 * - Other `<system-reminder>`s (hook notices, token counts) are the client
 *   Claude Code's own bookkeeping; the run makes its own, so they are left out.
 */
function sideNotices(text: string): Array<string> {
  const out = [...text.matchAll(TASK_NOTIFICATION)].map(
    (match) => `<system-reminder>\n${match[0]}\n</system-reminder>`,
  )
  // Notifications were taken above, also those wrapped in a reminder.
  const words = text
    .replaceAll(SYSTEM_REMINDER, "")
    .replaceAll(TASK_NOTIFICATION, "")
    .trim()
  if (words)
    out.push(
      `<system-reminder>\nThe user sent a new message while you were working:\n${words}\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.\n</system-reminder>`,
    )
  return out
}

function freshResultMessages(payload: AnthropicMessagesPayload) {
  const last = payload.messages.findLastIndex(
    (message) => message.role === "assistant",
  )
  return payload.messages
    .slice(last + 1)
    .filter((message) => message.role === "user")
}

function toolResultContent(
  content: AnthropicToolResultBlock["content"],
): McpToolResult["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text }
    if (block.source.type === "base64") {
      return {
        type: "image",
        data: block.source.data,
        mimeType: block.source.media_type,
      }
    }
    return { type: "text", text: `[image: ${block.source.url}]` }
  })
}
