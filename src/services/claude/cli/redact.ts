/**
 * 密钥脱敏。
 *
 * 用途：把**外部进程**（Claude Code、MCP helper、包装脚本）的输出写进日志前
 * 先擦掉看起来像凭证的东西。日志是给运维排查用的，不该变成第二个泄露面。
 *
 * 注意这是**尽力而为**，不是保证：目标是挡住最常见的几种形态
 * （Anthropic/OpenAI key、Bearer token、query 里的 token、JWT），
 * 不能替代"不要把秘密交给外部进程"这一原则。
 */

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // sk-ant-… / sk-… （Anthropic、OpenAI 及大多数中转）
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED:api-key]"],
  // Authorization: Bearer <token>
  [/\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  // query / form / JSON 里的 token 字段。
  //
  // 必须允许键名后先出现一个引号：JSON 是 `"refresh_token":"…"`，
  // 键名与冒号之间有关闭引号。只处理 `key=value` 会漏掉 JSON，
  // 而 JSON 恰恰是最容易藏 token 的地方。
  [
    /\b((?:access|refresh|oauth|id)_?token|api_?key|client_?secret)\b(["']?)(\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\4/gi,
    "$1$2$3$4[REDACTED]$4",
  ],
  // JWT：三段 base64url
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED:jwt]",
  ],
]

/** 擦掉文本里看起来像凭证的片段。 */
export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * 脱敏 + 截断，用于把外部输出放进日志或错误消息。
 *
 * 截断放在脱敏之后：先擦掉秘密，再切长度，避免把一个 token 切成两半后
 * 残留一半仍然可读。
 */
export function redactAndTruncate(text: string, maxLength = 2000): string {
  const redacted = redactSecrets(text)
  if (redacted.length <= maxLength) return redacted
  return `${redacted.slice(0, maxLength)}… [truncated, ${redacted.length - maxLength} more chars]`
}
