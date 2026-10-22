/**
 * CodeBuddy 模型级限流（6004）判定与落库。
 *
 * 上游用业务码 6004 表达“该模型的使用量超限”（msg 带“将在 … 重置”，
 * 对齐 workbuddy2api `IsModelRateLimit`），而不是账号整体被限流——账号
 * 健康，只是这个模型此刻被限。命中时只冷却 (credential, model)，账号
 * 本身不标记，dispatch 选路时跳过该模型即可。
 *
 * 判定收紧到 HTTP 429 / 流错误码 6004 + body 业务码双条件；400 还需明确
 * 的模型使用量限流文案。只有明确的模型限流才豁免账号级惩罚。
 * 其它错误仍按原有账号级规则处理。
 *
 * 注意流错误路径：detectOpenAIStreamError 构造 HTTPError 时把越界业务码
 * （6004 > 599，Response 构造器不接受）回落为 HTTP 500，因此这里同时
 * 接受 status 500 + body code 6004 的组合——500 只是传输层回落值，6004
 * 的限流语义由 body 业务码承载。
 */

import { classifyUpstreamError, DEFAULTS } from "~/lib/provider-connections"
import { recordModelCooldown } from "~/lib/model-cooldown"

/** 模型级限流业务码判定（JSON 空格/引号容差，与 workbuddy2api 同口径）。 */
const MODEL_RATE_LIMIT_CODE_PATTERN = /"code"\s*:\s*"?6004"?/

export function isCodebuddyModelRateLimit(
  status: number,
  body?: string,
): boolean {
  return (
    // 500 是流错误码 6004 越界后的回落值（见模块头注释）。
    (status === 429
      || status === 6004
      || status === 500
      || (status === 400 && !!body && /使用量.*(?:频率限制|超限)/.test(body)))
    && !!body
    && MODEL_RATE_LIMIT_CODE_PATTERN.test(body)
  )
}

/**
 * 6004 冷却时长：解析中文重置文案，再复用通用重置时间解析。
 * 无明示时间回落 429 默认冷却。
 */
export function resolveCodebuddyModelCooldownMs(body: string): number {
  // WorkBuddy displays CN wall-clock timestamps without an offset. Keep this
  // provider-specific default out of the shared parser (English resets use UTC).
  const reset = body.match(
    /(?:将在|可在)\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\s*(?:UTC\s*)?([+-]\d{1,2}(?::?\d{2})?)?\s*重置/,
  )
  if (reset) {
    const offset = reset[2]?.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/)
    const zone =
      offset ?
        `${offset[1]}${offset[2].padStart(2, "0")}:${offset[3] ?? "00"}`
      : "+08:00"
    const remaining =
      Date.parse(`${reset[1].replace(" ", "T")}${zone}`) - Date.now()
    if (remaining > 0)
      return Math.min(remaining, DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS)
  }
  const parsed = classifyUpstreamError({ status: 429, body }).retryAfterMs
  return parsed && parsed > 0 ? parsed : DEFAULTS.COOLDOWN_429_FALLBACK_MS
}

interface RecordCodebuddyModelCooldownInput {
  connectionId: string
  credentialId: string
  model: string
  body: string
}

/**
 * 落库 (credential, model) 冷却，返回冷却截止时间戳（幂等复写取最晚）。
 */
export function recordCodebuddyModelCooldown(
  input: RecordCodebuddyModelCooldownInput,
): number {
  const untilMs = Date.now() + resolveCodebuddyModelCooldownMs(input.body)
  recordModelCooldown({
    credentialId: input.credentialId,
    connectionId: input.connectionId,
    model: input.model,
    untilMs,
    reason: "codebuddy 6004 model rate limit",
  })
  return untilMs
}

/** Require both the vendor code and its model-service wording, not any 400. */
export function isCodebuddyModelUnavailable(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      code?: unknown
      msg?: unknown
      error?: { code?: unknown; message?: unknown }
    }
    const code = parsed.error?.code ?? parsed.code
    const message = parsed.error?.message ?? parsed.msg
    return (
      String(code) === "11102"
      && typeof message === "string"
      && /model\s*\[.*?\]\s*service info not found/i.test(message)
    )
  } catch {
    return false
  }
}
