/**
 * MCP 回调端点的逻辑。
 *
 * stdio helper 把 CLI 的 `tools/call` 转成一次对网关的 HTTP POST，然后就
 * **阻塞**等结果。这个模块负责：找到那个挂起的 run、把调用登记进去、
 * 等调用方的 `tool_result` 回来、再答复 helper。
 *
 * 请求体是网关自定义的简化形态（不是 MCP 协议本身）：
 *
 * ```jsonc
 * {"tool_call_id":"toolu_...","name":"get_weather","arguments":{...}}
 * ```
 */

import { logger } from "~/lib/logger"

import { CLAUDE_WAIT_TOOL_NAME } from "./mcp-names"
import { runRegistry, type McpToolResult } from "./run-registry"

/** 回调请求体解析失败 / run 不存在时抛这个，由路由层转成 HTTP 状态码。 */
export class ClaudeMcpCallbackError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ClaudeMcpCallbackError"
    this.status = status
  }
}

interface ClaudeMcpCallbackBody {
  toolCallId: string
  name: string
  args: unknown
}

function parseClaudeMcpCallbackBody(body: unknown): ClaudeMcpCallbackBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ClaudeMcpCallbackError("invalid tool call body", 400)
  }
  const typed = body as Record<string, unknown>
  const toolCallId = typed.tool_call_id
  if (typeof toolCallId !== "string" || !toolCallId) {
    throw new ClaudeMcpCallbackError("tool_call_id is required", 400)
  }
  return {
    toolCallId,
    name: typeof typed.name === "string" ? typed.name : "",
    args: typed.arguments ?? {},
  }
}

/**
 * 从 `wait_for_tool` 的参数里取出它要等的那条调用 id。
 *
 * 注意**不能**用回调自己的 `tool_call_id` —— 那是 `wait_for_tool` 这次调用
 * 自己的 id，跟它要收集的那条调用无关(那条在 `arguments.call` 里)。
 */
function waitTarget(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined
  const call = (args as Record<string, unknown>).call
  return typeof call === "string" && call.trim() ? call.trim() : undefined
}

/**
 * 处理一次 `tools/call`。返回 MCP 形状的结果。
 *
 * 会一直阻塞到调用方把 `tool_result` 送回来、run 结束、或耐心耗尽。
 */
export async function handleClaudeMcpCallback(
  token: string,
  body: unknown,
): Promise<McpToolResult> {
  const run = runRegistry.find(token)
  if (!run) {
    throw new ClaudeMcpCallbackError("unknown or expired Claude run", 404)
  }
  const { toolCallId, name, args } = parseClaudeMcpCallbackBody(body)
  // 网关自己的工具：它不交付给调用方，只去取一条"还在跑"的调用的结果。
  if (name === CLAUDE_WAIT_TOOL_NAME) {
    const target = waitTarget(args)
    if (!target) {
      return {
        is_error: true,
        content: [
          {
            type: "text",
            text: 'wait_for_tool needs {"call": "<tool_use id>"}.',
          },
        ],
      }
    }
    logger.debug(`claude-cli: wait_for_tool collecting ${target}`)
    const result = await run.awaitWaitRequest(target)
    return { ...result, tools: run.toolDefinitions?.() }
  }
  logger.debug(
    `claude-cli: tool call ${name} (${toolCallId}) parked, waiting for the caller`,
  )
  const result = await run.awaitToolCall(toolCallId, name)
  return { ...result, tools: run.toolDefinitions?.() }
}
