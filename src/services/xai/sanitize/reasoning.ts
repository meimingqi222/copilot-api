/**
 * xAI reasoning 相关规范化：reasoning_effort 处理、
 * input 中 reasoning/compaction 条目清洗、加密内容校验。
 * 从 `sanitize-body.ts` 拆分而来，纯代码移动，无行为变更。
 */

import { xaiSupportsReasoningEffort } from "~/services/xai/model-metadata"

const MAX_XAI_ENCRYPTED_CONTENT_LENGTH = 8 * 1024 * 1024
const MIN_XAI_ENCRYPTED_CONTENT_BYTES = 32
const MIN_XAI_ENCRYPTED_CONTENT_ENTROPY_RATIO = 0.85
const KIMI_SIGNATURE_LENGTHS = new Set([4340, 12946])
const PROVIDER_CACHE_PREFIX = /^(?:claude|anthropic|gemini|openai|codex)#/
const STANDARD_BASE64 = /^[a-z0-9+/]+$/i

/**
 * Validate the transport shape of opaque Grok reasoning/compaction state.
 * This is deliberately not a provider classifier and does not prove that the
 * blob is decryptable. It rejects malformed, low-entropy and known foreign
 * shapes that xAI cannot replay.
 */
export function isValidXaiEncryptedContent(value: string): boolean {
  if (!value || value !== value.trim()) return false
  if (value.length > MAX_XAI_ENCRYPTED_CONTENT_LENGTH) return false
  if (value.includes("=") || !STANDARD_BASE64.test(value)) return false
  if (value.length % 4 === 1) return false
  if (value.startsWith("gAAAA") || PROVIDER_CACHE_PREFIX.test(value)) {
    return false
  }
  if (KIMI_SIGNATURE_LENGTHS.has(value.length)) return false

  let decoded: Buffer
  try {
    decoded = Buffer.from(value, "base64")
  } catch {
    return false
  }
  if (decoded.toString("base64").replace(/=+$/, "") !== value) return false
  if (decoded.length < MIN_XAI_ENCRYPTED_CONTENT_BYTES) return false
  return byteEntropyRatio(decoded) >= MIN_XAI_ENCRYPTED_CONTENT_ENTROPY_RATIO
}

export function sanitizeXaiInputReasoningItems(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body

  const sanitized: Array<unknown> = []
  for (const value of body.input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      sanitized.push(value)
      continue
    }
    const item = { ...(value as Record<string, unknown>) }
    if (item.type !== "reasoning" && item.type !== "compaction") {
      sanitized.push(value)
      continue
    }

    if (item.type === "reasoning" && item.content === null) {
      delete item.content
    }
    if (item.type === "reasoning" && item.encrypted_content === null) {
      delete item.encrypted_content
    } else if (
      "encrypted_content" in item
      && (typeof item.encrypted_content !== "string"
        || !isValidXaiEncryptedContent(item.encrypted_content))
    ) {
      if (item.type === "compaction") continue
      delete item.encrypted_content
    }
    sanitized.push(item)
  }

  return { ...body, input: mergeAdjacentXaiReasoningSummaries(sanitized) }
}

function mergeAdjacentXaiReasoningSummaries(
  input: Array<unknown>,
): Array<unknown> {
  const merged: Array<unknown> = []
  for (const value of input) {
    const current = getObject(value)
    const previous = getObject(merged.at(-1))
    if (
      previous?.type === "reasoning"
      && current?.type === "reasoning"
      && Array.isArray(previous.summary)
      && Array.isArray(current.summary)
      && current.summary.length > 0
      && Object.keys(current).every(
        (key) => key === "type" || key === "summary",
      )
    ) {
      const previousSummary = previous.summary as Array<unknown>
      const currentSummary = current.summary as Array<unknown>
      previous.summary = [...previousSummary, ...currentSummary]
      continue
    }
    merged.push(value)
  }
  return merged
}

function byteEntropyRatio(bytes: Uint8Array): number {
  const counts = new Uint32Array(256)
  for (const byte of bytes) counts[byte] += 1
  let entropy = 0
  for (const count of counts) {
    if (count === 0) continue
    const probability = count / bytes.length
    entropy -= probability * Math.log2(probability)
  }
  const maxSymbols = Math.min(bytes.length, 256)
  return maxSymbols <= 1 ? 0 : entropy / Math.log2(maxSymbols)
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

export function sanitizeXaiReasoningEffort(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  if (xaiSupportsReasoningEffort(model)) {
    return body
  }
  const reasoning = body.reasoning
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    return body
  }
  const { effort: _effort, ...rest } = reasoning as Record<string, unknown>
  if (Object.keys(rest).length === 0) {
    const { reasoning: _r, ...withoutReasoning } = body
    return withoutReasoning
  }
  return { ...body, reasoning: rest }
}
