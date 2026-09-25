/**
 * `claude` 子进程的命令行参数构造。
 *
 * 直译 magpie 的 `claudeCLIArgs()`
 * （`internal/gateway/claude_subscription.go:209`）。
 *
 * 几个参数不是可选的：
 *
 * - `--include-partial-messages`：没有它只能拿到整块消息，没有 token 级流。
 * - `--tools ""`：禁用 CLI 的全部内置工具。调用方的工具才是唯一的工具，
 *   否则模型可能去用 CLI 自带的 Read/Bash，而调用方根本收不到那些调用。
 * - `--strict-mcp-config`：只用我们给的那份 MCP 配置。
 * - `--setting-sources ""`：不读 `settings.json` / `CLAUDE.md`，
 *   避免工作目录里的用户配置漏进 system prompt。
 * - `--dangerously-skip-permissions`：headless 下不能有权限交互。
 */

export interface ClaudeCliArgsOptions {
  /** 上游模型 id（已规范化）。 */
  model: string
  /** `--mcp-config` 指向的 JSON 文件路径。 */
  mcpConfigPath: string
  /** 推理强度；空值表示不传。 */
  effort?: string
}

/** 我们的 effort 取值与 CLI 的对应关系。 */
const EFFORT_ALIASES: Readonly<Record<string, string>> = {
  xhigh: "max",
}

/** 把我们的 effort 取值翻译成 CLI 认识的值。 */
export function mapClaudeEffort(effort: string): string {
  return EFFORT_ALIASES[effort] ?? effort
}

export function claudeCliArgs(options: ClaudeCliArgsOptions): Array<string> {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model",
    options.model,
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    options.mcpConfigPath,
    "--setting-sources",
    "",
    "--dangerously-skip-permissions",
  ]
  const effort = options.effort?.trim()
  if (effort) {
    args.push(
      "--effort",
      mapClaudeEffort(effort),
      "--thinking-display",
      "summarized",
    )
  }
  return args
}
