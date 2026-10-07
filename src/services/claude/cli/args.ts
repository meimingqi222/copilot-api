/**
 * `claude` 子进程的命令行参数构造。
 *
 * 几个参数不是可选的：
 *
 * - `--include-partial-messages`：没有它只能拿到整块消息，没有 token 级流。
 * - `--tools ""`：默认禁用 CLI 的内置工具；请求原生搜索时只启用 WebSearch。
 *   调用方的工具通过 MCP 桥接，
 *   否则模型可能去用 CLI 自带的 Read/Bash，而调用方根本收不到那些调用。
 * - `--strict-mcp-config`：只用我们给的那份 MCP 配置。
 * - `--setting-sources ""`：不读 `settings.json` / `CLAUDE.md`，
 *   避免工作目录里的用户配置漏进 system prompt。
 * - 搜索通过 stdio 权限协议执行调用方限制；其他请求跳过权限交互。
 */

interface ClaudeCliArgsOptions {
  /** 上游模型 id（已规范化）。 */
  model: string
  /** `--mcp-config` 指向的 JSON 文件路径。 */
  mcpConfigPath: string
  /** 推理强度；空值表示不传。 */
  effort?: string
  webSearch?: boolean
  jsonSchema?: Record<string, unknown>
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
    options.webSearch ? "WebSearch" : "",
    "--strict-mcp-config",
    "--mcp-config",
    options.mcpConfigPath,
    "--setting-sources",
    "",
    "--no-session-persistence",
  ]
  if (options.webSearch)
    args.push(
      "--permission-mode",
      "manual",
      "--permission-prompt-tool",
      "stdio",
    )
  else args.push("--dangerously-skip-permissions")
  const effort = options.effort?.trim()
  if (effort) {
    args.push("--effort", effort, "--thinking-display", "summarized")
  }
  if (options.jsonSchema)
    args.push("--json-schema", JSON.stringify(options.jsonSchema))
  return args
}
