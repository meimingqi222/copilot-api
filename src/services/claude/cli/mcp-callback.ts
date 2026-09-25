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
 *
 * 参考 magpie 的 `mcpCall()`（`internal/gateway/claude_subscription.go:502`）。
 */

import { logger } from "~/lib/logger"

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

export interface ClaudeMcpCallbackBody {
  toolCallId: string
  name: string
  args: unknown
}

export function parseClaudeMcpCallbackBody(
  body: unknown,
): ClaudeMcpCallbackBody {
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
  const { toolCallId, name } = parseClaudeMcpCallbackBody(body)
  logger.debug(
    `claude-cli: tool call ${name} (${toolCallId}) parked, waiting for the caller`,
  )
  return run.awaitToolCall(toolCallId, name)
}
