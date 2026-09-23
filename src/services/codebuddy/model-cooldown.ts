/**
 * CodeBuddy 模型级限流（6004）判定与落库。
 *
 * 上游用业务码 6004 表达“该模型的使用量超限”（msg 带“将在 … 重置”，
 * 对齐 workbuddy2api `IsModelRateLimit`），而不是账号整体被限流——账号
 * 健康，只是这个模型此刻被限。命中时只冷却 (credential, model)，账号
 * 本身不标记，dispatch 选路时跳过该模型即可。
 *
 * 判定收紧到 HTTP 429 / 流错误码 6004 + body 业务码双条件：6004 码只在
 * 限流语义下豁免账号级惩罚，5xx 等其它语义保持原有账号级处理。
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
    (status === 429 || status === 6004 || status === 500)
    && !!body
    && MODEL_RATE_LIMIT_CODE_PATTERN.test(body)
  )
}

/**
 * 6004 冷却时长：复用上游明示的重置时间（中文“将在 … 重置”已由
 * classifyUpstreamError 解析），无明示时间回落 429 默认冷却。
 */
export function resolveCodebuddyModelCooldownMs(body: string): number {
  const parsed = classifyUpstreamError({ status: 429, body }).retryAfterMs
  return parsed && parsed > 0 ? parsed : DEFAULTS.COOLDOWN_429_FALLBACK_MS
}

export interface RecordCodebuddyModelCooldownInput {
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
