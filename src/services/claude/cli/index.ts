/**
 * Claude CLI 传输层（v2）的公共出口。
 *
 * 上层（protocol adapter / 路由）只需要 `streamClaudeCliMessages` 与
 * `collectClaudeCliMessages`，其余是实现细节。
 */

export { claudeCliArgs, mapClaudeEffort } from "./args"
export {
  claudeConfigDir,
  claudeHome,
  claudeVersion,
  findClaudeBinary,
  parseClaudeVersion,
  setClaudeCliTestHooks,
} from "./binary"
export {
  ClaudeCliConcurrencyLimitError,
  ClaudeCliError,
  ClaudeCliQuotaError,
  ClaudeCliUnavailableError,
  looksLikeQuota,
  toHttpError,
} from "./errors"
export { cleanClaudeEnv } from "./env"
export { runClaudeMcpHelper } from "./mcp-helper"
export {
  ClaudeMcpCallbackError,
  handleClaudeMcpCallback,
  parseClaudeMcpCallbackBody,
} from "./mcp-callback"
export {
  CLAUDE_MCP_SERVER_NAME,
  mcpToolNamePrefix,
  stripMcpToolPrefix,
} from "./mcp-names"
export { renderClaudePrompt } from "./prompt"
export { redactAndTruncate, redactSecrets } from "./redact"
export {
  runRegistry,
  RunRegistry,
  type BridgeRun,
  type McpToolResult,
  type ParkedMatch,
} from "./run-registry"
export {
  claudeCallbackBaseUrl,
  resetClaudeCallbackBaseUrlForTest,
  setClaudeCallbackBaseUrl,
} from "./server-address"
export {
  parseStreamJsonLine,
  readStreamJsonLines,
  type ClaudeCliUsage,
  type ClaudeStreamJsonEvent,
  type ClaudeStreamJsonLine,
} from "./stream-json"
export {
  bridgeTools,
  toolResultIds,
  toolResults,
  type BridgeTool,
  type BridgeToolResult,
} from "./tools"
export {
  claudeTranscriptTtlDays,
  pruneClaudeTranscripts,
  resetClaudeTranscriptPruneForTest,
} from "./transcripts"
export { resolveClaudeTransport, type ClaudeTransport } from "./transport"
export {
  collectAnthropicResponse,
  translateClaudeStreamJson,
  type ClaudeStreamTranslationOptions,
} from "./translate"
export {
  ClaudeCliRun,
  collectClaudeCliMessages,
  streamClaudeCliMessages,
  type ClaudeCliRunContext,
} from "./bridge"
