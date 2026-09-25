/**
 * MCP 回调用的服务地址。
 *
 * CLI 的 stdio helper 需要把 `tools/call` 送回网关，所以它必须知道网关监听
 * 在哪里。这个值在 `Bun.serve()` 之后由 `start.ts` 注入 —— 只有那里知道
 * 真正绑定成功的端口（`--port 0` 时尤其重要）。
 *
 * 固定用 `127.0.0.1` 而不是 `localhost`：后者在部分机器上先解析到 `::1`，
 * 而服务可能只绑了 IPv4，会白白多一次连接失败。
 */

let callbackBaseUrl: string | undefined

/** 由 `start.ts` 在服务启动后调用。 */
export function setClaudeCallbackBaseUrl(url: string): void {
  callbackBaseUrl = url.replace(/\/+$/, "")
}

/** 网关自身的 base URL；未注入时按环境变量兜底。 */
export function claudeCallbackBaseUrl(): string {
  if (callbackBaseUrl) return callbackBaseUrl
  const port = process.env.PORT?.trim() || "4141"
  return `http://127.0.0.1:${port}`
}

/** 测试用：复位。 */
export function resetClaudeCallbackBaseUrlForTest(): void {
  callbackBaseUrl = undefined
}
