/**
 * CLI 传输层的 MCP 工具命名。
 *
 * Claude Code 把 MCP 工具命名为 `mcp__<server>__<tool>`。网关返回给调用方的
 * `tool_use.name` 必须剥掉这个前缀，否则调用方在自己的工具表里找不到它。
 *
 * 注意这**不是** v1 的 `tool-prefix.ts`（那是 Claude Code 线上指纹用的 `_`
 * 前缀）。两套命名互不相干，不要复用。
 */

/** 我们在 `--mcp-config` 里给工具桥起的服务器名。 */
export const CLAUDE_MCP_SERVER_NAME = "copilotapi"

export function mcpToolNamePrefix(
  serverName: string = CLAUDE_MCP_SERVER_NAME,
): string {
  return `mcp__${serverName}__`
}

/** 剥掉 MCP 服务器前缀；没有前缀时原样返回。 */
export function stripMcpToolPrefix(
  name: string,
  serverName: string = CLAUDE_MCP_SERVER_NAME,
): string {
  const prefix = mcpToolNamePrefix(serverName)
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/**
 * 收集"迟到结果"用的合成工具名。
 *
 * 一次工具调用的结果可能晚于 `patience` 才回到网关。此时 MCP 调用已经被
 * 答复("还在跑")，而 CLI 的 MCP 客户端对单次调用有约一分钟的上限 —— 所以
 * 不能靠继续阻塞来等，只能让模型自己回来取:它调这个工具，我们再挂一次
 * (同样不超过 patience)，拿到结果就交付。
 *
 * 这个工具**不是调用方的工具**，只存在于给 CLI 的 MCP 工具表里；调用方
 * 永远看不到它(translate 会把它的块整段滤掉)。
 */
export const CLAUDE_WAIT_TOOL_NAME = "wait_for_tool"
