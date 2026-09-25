/**
 * CLI 传输层的错误类型。
 *
 * 分成三类，因为调用方对它们的处理完全不同：
 *
 * - `ClaudeCliUnavailableError`：CLI 没装 / 起不来 → 这是配置问题，
 *   不该冷却账号，也不该换账号重试（换哪个都一样）。
 * - `ClaudeCliQuotaError`：配额或限流 → 应该换下一个账号（failover）。
 * - `ClaudeCliError`：其余（非零退出、协议错乱）→ 按可重试处理。
 *
 * 参考 magpie 的 `quotaWords`（`internal/gateway/fallback.go:191`）。
 */

import {
  HTTPError,
  LocalConcurrencyLimitError,
  LocalUnavailableError,
} from "~/lib/error"

/**
 * 上游把"没额度"说成各种样子，有些连状态码都不给（400/403 + 文案）。
 * 命中即当作配额耗尽，让 failover 换账号。
 */
const QUOTA_WORDS =
  /quota|insufficient|balance|credit|billing|exceeded|rate.?limit|usage.?limit|limit.?reached|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i

/** CLI 传输层的基础错误。 */
export class ClaudeCliError extends Error {
  /** CLI 侧报出的原始文案，便于排查。 */
  readonly detail?: string

  constructor(message: string, detail?: string) {
    super(message)
    this.name = "ClaudeCliError"
    this.detail = detail
  }
}

/**
 * CLI 不可用（未安装、无法启动）。
 *
 * 继承 `LocalUnavailableError`：这是机器级条件，不是账号问题 —— 换任何
 * 账号都会同样失败。failover 循环据此跳过冷却、不重试，直接以 503 抛出。
 */
export class ClaudeCliUnavailableError extends LocalUnavailableError {
  /** CLI 侧报出的原始文案，便于排查。 */
  readonly detail?: string

  constructor(message: string, detail?: string) {
    const body = JSON.stringify({
      type: "error",
      error: { type: "api_error", message },
    })
    super(
      message,
      new Response(body, {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
      body,
    )
    this.name = "ClaudeCliUnavailableError"
    this.detail = detail
  }
}

/** 账号配额耗尽 / 被限流；换账号可能成功。 */
export class ClaudeCliQuotaError extends ClaudeCliError {
  constructor(message: string, detail?: string) {
    super(message, detail)
    this.name = "ClaudeCliQuotaError"
  }
}

/**
 * 本地饱和：这个 connection 活着（含挂起）的 CLI run 已达上限。
 *
 * 每个 run 是一个完整的 node 进程，所以必须封顶。这是**本地**拒绝，不是上游
 * 失败：调用方不得据此冷却账号，只能换账号或让客户端重试。
 * 形态照 `CredentialConcurrencyLimitError`（`~/services/dispatch/concurrency`）。
 */
export class ClaudeCliConcurrencyLimitError extends LocalConcurrencyLimitError {
  /** 饱和的 connection；只用于日志，不下发给客户端。 */
  readonly connectionId: string

  constructor(connectionId: string) {
    const message = "Claude Code concurrency limit reached; retry shortly"
    const body = JSON.stringify({
      error: {
        code: 429,
        message,
        retryable: true,
        type: "rate_limit_error",
      },
    })
    super(
      message,
      new Response(body, {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "1",
          "retry-after-ms": "1000",
        },
      }),
      body,
    )
    this.name = "ClaudeCliConcurrencyLimitError"
    this.connectionId = connectionId
  }
}

/** 文案是否像"没额度了"。 */
export function looksLikeQuota(text: string): boolean {
  return QUOTA_WORDS.test(text)
}

/**
 * 把 CLI 侧的失败翻译成 `HTTPError`，供 dispatch 的 failover 判定。
 *
 * 状态码的选择直接决定 failover 会不会换账号：
 * 429 / 5xx 会，4xx（非 429）不会。
 */
export function toHttpError(error: unknown): HTTPError {
  if (error instanceof HTTPError) return error
  const message =
    error instanceof Error ? error.message : "Claude Code request failed"
  const status =
    error instanceof ClaudeCliQuotaError ? 429
    : looksLikeQuota(message) ? 429
    : 502
  return new HTTPError(
    message,
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: status === 429 ? "rate_limit_error" : "api_error",
          message,
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    ),
    message,
  )
}
