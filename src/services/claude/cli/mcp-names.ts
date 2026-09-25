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
