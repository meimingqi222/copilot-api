/**
 * 启动 `claude` 子进程时的环境变量构造。
 *
 * 两个目的：
 *
 * 1. **切断回环**：copilot-api 自己可能带着 `ANTHROPIC_BASE_URL` /
 *    `ANTHROPIC_AUTH_TOKEN`（例如用户把本机 Claude Code 指向了 copilot-api）。
 *    这些变量如果漏进子进程，真 Claude Code 会反过来打 copilot-api，
 *    形成自环；`CLAUDECODE*` 那组则会让 CLI 以为自己在嵌套会话里。
 *
 * 2. **注入账号**：`CLAUDE_CODE_OAUTH_TOKEN` 是 CLI 的"直接给定 OAuth token、
 *    绕过凭证存储"开关。旁挂账号靠它注入，CLI 因此不读也不写 `~/.claude`
 *    里的凭证 —— refresh token 的唯一持有者仍然是 copilot-api 的刷新链路。
 *
 * 参考 magpie 的 `cleanClaudeEnv()`（`internal/gateway/claude_subscription.go:225`）。
 */

/** 必须从子进程环境里剔除的变量。 */
const BLOCKED_ENV_KEYS: ReadonlyArray<string> = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  // 先删再按需注入：否则用户环境里的 token 会盖过连接自己的凭证。
  "CLAUDE_CODE_OAUTH_TOKEN",
]

/** 无条件追加的变量。 */
const FORCED_ENV: Readonly<Record<string, string>> = {
  // 不要拉起用户自己的 Claude.ai MCP servers，工具集只由 --mcp-config 决定。
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  // 上下文压缩由调用方负责；CLI 自己压缩会打乱我们渲染的 transcript。
  DISABLE_AUTO_COMPACT: "1",
  // 关闭遥测等非必要流量。
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
}

export interface CleanClaudeEnvOptions {
  /** 注入 `CLAUDE_CODE_OAUTH_TOKEN`。空值表示不注入（沿用 CLI 自己的登录态）。 */
  oauthToken?: string
  /** 最后应用的覆盖项；值为 undefined 表示删除该键。 */
  overrides?: Record<string, string | undefined>
}

/**
 * 返回一份**完整**的子进程环境。
 *
 * 返回完整对象而不是增量，是因为 Bun 的 `spawn({ env })` 是覆盖式而非合并式：
 * 传增量会让子进程只剩这几个变量。
 *
 * `base` 不会被修改。
 */
export function cleanClaudeEnv(
  base: Record<string, string | undefined>,
  options: CleanClaudeEnvOptions = {},
): Record<string, string> {
  const blocked = new Set(BLOCKED_ENV_KEYS)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (blocked.has(key)) continue
    out[key] = value
  }
  Object.assign(out, FORCED_ENV)
  const token = options.oauthToken?.trim()
  if (token) out.CLAUDE_CODE_OAUTH_TOKEN = token
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (value === undefined) {
      delete out[key]
      continue
    }
    out[key] = value
  }
  return out
}
