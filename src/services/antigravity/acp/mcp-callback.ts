/**
 * Antigravity ACP 内部 MCP 回调处理逻辑。
 */

import { runRegistry, type McpToolResult } from "./run-registry"

export class AntigravityMcpCallbackError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "AntigravityMcpCallbackError"
    this.status = status
  }
}

export async function handleAntigravityMcpCallback(
  token: string,
  body: unknown,
): Promise<McpToolResult> {
  const run = runRegistry.find(token)
  if (!run) {
    throw new AntigravityMcpCallbackError(
      "unknown or expired Antigravity ACP run",
      404,
    )
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AntigravityMcpCallbackError("invalid tool call body", 400)
  }
  const typed = body as Record<string, unknown>
  const name = typeof typed.name === "string" ? typed.name : ""
  if (!name) {
    throw new AntigravityMcpCallbackError("tool name is required", 400)
  }
  return run.parkMcpToolCall(name, typed.arguments ?? {})
}
