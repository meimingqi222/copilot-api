import { createHash, randomUUID } from "node:crypto"

import type { ResponsesPayload } from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

const COMPOSER_MODEL_PREFIX = "grok-composer-"

/**
 * Resolves the xAI conversation/session ID for the upstream request.
 *
 * Mirrors CPA `xaiResolveComposerSessionID` / `xaiExecutionSessionID`:
 *   1. Sticky WS execution session (`ctx.executionSessionId`)
 *   2. Body-level `prompt_cache_key`
 *   3. `metadata.prompt_cache_key`
 *   4. `x-grok-conv-id` forwarded header
 *   5. `x-claude-code-session-id` forwarded header
 *   6. Claude Code session ID from `metadata.user_id`
 *   7. Composer-only isolation fallback (stable prefix hash, else fresh UUID)
 *
 * Non-composer models (including `grok-build-*`) stay **stateless** when no
 * explicit session is provided — no invented `x-grok-conv-id`.
 */
export function resolveXaiSessionId(
  payload: ResponsesPayload,
  model: string,
  ctx?: RequestExecutionContext,
): string | undefined {
  const executionSession = ctx?.executionSessionId?.trim()
  if (executionSession) {
    return executionSession
  }

  const bodyCacheKey = (payload as unknown as { prompt_cache_key?: unknown })
    .prompt_cache_key
  if (typeof bodyCacheKey === "string" && bodyCacheKey.trim()) {
    return bodyCacheKey.trim()
  }

  const metadataCacheKey = payload.metadata?.prompt_cache_key
  if (typeof metadataCacheKey === "string" && metadataCacheKey.trim()) {
    return metadataCacheKey.trim()
  }

  const forwarded = ctx?.forwardedHeaders
  const headerConvId = forwarded?.["x-grok-conv-id"]
  if (typeof headerConvId === "string" && headerConvId.trim()) {
    return headerConvId.trim()
  }

  const claudeSessionHeader = forwarded?.["x-claude-code-session-id"]
  if (typeof claudeSessionHeader === "string" && claudeSessionHeader.trim()) {
    return claudeSessionHeader.trim()
  }

  const claudeSessionFromPayload =
    extractClaudeCodeSessionIdFromPayload(payload)
  if (claudeSessionFromPayload) {
    return claudeSessionFromPayload
  }

  // CPA only forces an isolated conversation for composer models.
  if (!xaiRequiresIsolatedConversation(model)) {
    return undefined
  }

  const prefixHash = computePrefixHash(payload)
  if (prefixHash) {
    return prefixHash
  }
  return randomUUID()
}

/** CPA `xaiRequiresIsolatedConversation` — composer models need a stable key. */
export function xaiRequiresIsolatedConversation(model: string): boolean {
  return normalizeXaiModelBase(model).startsWith(COMPOSER_MODEL_PREFIX)
}

export function normalizeXaiModelBase(model: string): string {
  // Strip thinking suffixes like ":high" or "(high)".
  const withoutSuffix =
    model
      .split(":")[0]
      ?.replace(/\([^)]*\)$/, "")
      .toLowerCase()
      .trim() ?? ""
  return withoutSuffix.includes("/") ?
      withoutSuffix.slice(withoutSuffix.lastIndexOf("/") + 1)
    : withoutSuffix
}

/**
 * Extracts a Claude Code session ID from the payload's `metadata.user_id`
 * field. Claude Code encodes the session ID either as a JSON object
 * `{"session_id": "..."}` or as a suffix `_session_<uuid>`.
 */
function extractClaudeCodeSessionIdFromPayload(
  payload: ResponsesPayload,
): string | undefined {
  const userId = payload.metadata?.user_id
  if (typeof userId !== "string" || !userId.trim()) {
    return undefined
  }
  const suffixMatch = userId.match(/_session_([a-f0-9-]+)$/i)
  if (suffixMatch?.[1]) {
    return suffixMatch[1]
  }
  if (userId[0] === "{") {
    try {
      const parsed = JSON.parse(userId) as { session_id?: unknown }
      const sessionId = parsed.session_id
      if (typeof sessionId === "string" && sessionId.trim()) {
        return sessionId.trim()
      }
    } catch {
      // not valid JSON
    }
  }
  return undefined
}

/**
 * Stable hash of system instructions + first user message for composer
 * isolation when no explicit session is present.
 */
function computePrefixHash(payload: ResponsesPayload): string | undefined {
  const parts: Array<string> = []

  const instructions = payload.instructions?.trim()
  if (instructions) {
    parts.push(instructions)
  }

  const firstUserText = extractFirstUserMessageText(payload.input)
  if (firstUserText) {
    parts.push(firstUserText)
  }

  if (parts.length === 0) {
    return undefined
  }

  const hash = createHash("sha256")
    .update(parts.join("\n\n"))
    .digest("hex")
    .slice(0, 16)
  return `prefix:${hash}`
}

function extractFirstUserMessageText(
  input: ResponsesPayload["input"],
): string | undefined {
  if (typeof input === "string") {
    return input.trim() || undefined
  }
  if (!Array.isArray(input)) {
    return undefined
  }
  for (const item of input) {
    if (!("role" in item) || item.role !== "user") continue
    const content = item.content
    if (typeof content === "string") {
      return content.trim() || undefined
    }
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (part): part is { type: "input_text"; text: string } =>
            part.type === "input_text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("")
      return text.trim() || undefined
    }
  }
  return undefined
}
