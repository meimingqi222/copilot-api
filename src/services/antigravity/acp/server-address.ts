/**
 * Antigravity ACP 内部 MCP 回调的服务地址。
 *
 * 与 Claude CLI 传输层一致，由 `start.ts` 在 `Bun.serve()` 之后注入真实端口，
 * 固定使用 `127.0.0.1` 避免 `localhost` 解析到 IPv6 导致额外连接失败。
 */

let callbackBaseUrl: string | undefined

/** 由 `start.ts` 在服务启动后调用。 */
export function setAntigravityCallbackBaseUrl(url: string): void {
  callbackBaseUrl = url.replace(/\/+$/, "")
}

/** 网关自身的 base URL；未注入时按环境变量兜底。 */
export function antigravityCallbackBaseUrl(): string {
  if (callbackBaseUrl) return callbackBaseUrl
  const port = process.env.PORT?.trim() || "4141"
  return `http://127.0.0.1:${port}`
}
