/**
 * Claude 传输方式的选择。
 *
 * 两套传输并存：
 *
 * - `"http"` —— v1，直接 HTTP 重放 OAuth token + 伪造 Claude Code 指纹
 *   （`src/services/claude/create-messages-once.ts`）。
 * - `"cli"` —— v2，驱动真正的 `claude` 二进制（`./bridge.ts`）。
 *
 * v1 仅在显式选择 HTTP 时使用，不因本机环境自动切换。
 *
 * 优先级（见 `docs/todo-claude-cli-transport.md` §4.1）：
 *
 * 1. `COPILOT_API_CLAUDE_TRANSPORT=http` —— 全局 kill-switch。
 * 2. `connection.metadata.claudeTransport` 显式取值。
 * 3. 缺省走 CLI；找不到二进制时报错。
 *
 * CLI 不可用时不静默切换到 HTTP，避免实际接入方式与卡片显示不一致。
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import { findClaudeBinary } from "./binary"
import { ClaudeCliUnavailableError } from "./errors"

type ClaudeTransport = "cli" | "http"

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
  if (!findClaudeBinary()) {
    throw new ClaudeCliUnavailableError(
      "Claude Code CLI is selected but no `claude` binary was found. "
        + "Install Claude Code, or select HTTP on the Claude account card.",
    )
  }
  return "cli"
}
