/**
 * Claude 传输方式的选择。
 *
 * 两套传输并存：
 *
 * - `"http"` —— v1，直接 HTTP 重放 OAuth token + 伪造 Claude Code 指纹
 *   （`src/services/claude/create-messages-once.ts`）。
 * - `"cli"` —— v2，驱动真正的 `claude` 二进制（`./bridge.ts`）。
 *
 * v1 保留为 fallback：没装 CLI 的机器、以及需要快速回滚时都靠它。
 *
 * 优先级（见 `docs/todo-claude-cli-transport.md` §4.1）：
 *
 * 1. `COPILOT_API_CLAUDE_TRANSPORT=http` —— 全局 kill-switch。
 * 2. `connection.metadata.claudeTransport` 显式取值。
 * 3. auto：找得到 `claude` 二进制就走 CLI，否则回落 v1。
 *
 * ⚠️ 显式指定 `"cli"` 但找不到二进制时**抛错**，不静默回落。
 * 静默回落是最危险的失败模式：用户以为在用安全路径，实际在跑会被风控的 v1。
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import { findClaudeBinary } from "./binary"
import { ClaudeCliUnavailableError } from "./errors"

export type ClaudeTransport = "cli" | "http"

/** connection.metadata 里的开关键名。 */
const METADATA_KEY = "claudeTransport"

function explicitTransport(
  connection: ProviderConnection,
): ClaudeTransport | undefined {
  const raw = connection.metadata?.[METADATA_KEY]
  return raw === "cli" || raw === "http" ? raw : undefined
}

export function resolveClaudeTransport(
  connection: ProviderConnection,
): ClaudeTransport {
  if (
    process.env.COPILOT_API_CLAUDE_TRANSPORT?.trim().toLowerCase() === "http"
  ) {
    return "http"
  }
  const explicit = explicitTransport(connection)
  if (explicit === "http") return "http"
  if (explicit === "cli") {
    if (!findClaudeBinary()) {
      throw new ClaudeCliUnavailableError(
        "This Claude connection is set to use the Claude Code CLI "
          + '(metadata.claudeTransport = "cli") but no `claude` binary was found. '
          + 'Install Claude Code, or set it back to "http".',
      )
    }
    return "cli"
  }
  return findClaudeBinary() ? "cli" : "http"
}
