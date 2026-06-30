import { createHash } from "node:crypto"

import type { Account } from "~/lib/accounts"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { canonicalNativeModelId, isOAuthAccount } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import { XAI_API_BASE_URL } from "~/services/oauth/xai"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import { collectResponsesFromSseResponse } from "~/services/responses/sse-collector"

import { buildXaiHeaders } from "./headers"

/**
 * Resolves the xAI conversation/session ID for the upstream request.
 *
 * Priority:
 *   1. `prompt_cache_key` from the request body top-level field
 *      (matches CPA's xaiExecutionSessionID which checks req.Payload first).
 *   2. `prompt_cache_key` from `metadata.prompt_cache_key`
 *      (legacy OpenAI Responses API metadata location).
 *   3. `x-grok-conv-id` from forwarded headers (if a downstream client set it).
 *   4. `x-claude-code-session-id` from forwarded headers.
 *   5. Claude Code session ID extracted from `metadata.user_id` in the payload.
 *   6. Fallback: hash of system instructions + first user message.
 *      xAI prompt caching is prefix-based, so requests sharing the same
 *      system prompt and opening user turn will reuse the cached prefix.
 *      Composer models always get this fallback (matching CPA's
 *      `xaiRequiresIsolatedConversation`); other models only when we can
 *      extract a meaningful prefix.
 *
 * The xAI backend uses `x-grok-conv-id` to group requests within a
 * conversation and reuse cached prompt prefixes.
 */
function resolveXaiSessionId(
  payload: ResponsesPayload,
  ctx?: RequestExecutionContext,
): string | undefined {
  // 1. Body-level prompt_cache_key
  const bodyCacheKey = (payload as unknown as { prompt_cache_key?: unknown })
    .prompt_cache_key
  if (typeof bodyCacheKey === "string" && bodyCacheKey.trim()) {
    return bodyCacheKey.trim()
  }
  // 2. metadata.prompt_cache_key
  const metadataCacheKey = payload.metadata?.prompt_cache_key
  if (typeof metadataCacheKey === "string" && metadataCacheKey.trim()) {
    return metadataCacheKey.trim()
  }
  const forwarded = ctx?.forwardedHeaders
  // 3. x-grok-conv-id header
  const headerConvId = forwarded?.["x-grok-conv-id"]
  if (typeof headerConvId === "string" && headerConvId.trim()) {
    return headerConvId.trim()
  }
  // 4. x-claude-code-session-id header
  const claudeSessionHeader = forwarded?.["x-claude-code-session-id"]
  if (typeof claudeSessionHeader === "string" && claudeSessionHeader.trim()) {
    return claudeSessionHeader.trim()
  }
  // 5. Claude Code session ID from payload metadata.user_id
  const claudeSessionFromPayload =
    extractClaudeCodeSessionIdFromPayload(payload)
  if (claudeSessionFromPayload) {
    return claudeSessionFromPayload
  }
  // 6. Prefix-hash fallback: derive a stable cache key from the system
  //    prompt + first user message. xAI caching is prefix-based, so
  //    conversations with the same opening prefix share cache hits.
  //    Composer models always need a cache key (CPA behavior); other
  //    models benefit too when we have enough prefix to hash.
  const prefixHash = computePrefixHash(payload)
  if (prefixHash) {
    return prefixHash
  }
  return undefined
}

/**
 * Extracts a Claude Code session ID from the payload's `metadata.user_id`
 * field. Claude Code encodes the session ID either as a JSON object
 * `{"session_id": "..."}` or as a suffix `_session_<uuid>`.
 * Mirrors CPA's `extractClaudeCodeSessionIDFromPayload`.
 */
function extractClaudeCodeSessionIdFromPayload(
  payload: ResponsesPayload,
): string | undefined {
  const userId = payload.metadata?.user_id
  if (typeof userId !== "string" || !userId.trim()) {
    return undefined
  }
  // Suffix pattern: user_id ends with _session_<hex-uuid>
  const suffixMatch = userId.match(/_session_([a-f0-9-]+)$/)
  if (suffixMatch?.[1]) {
    return suffixMatch[1]
  }
  // JSON pattern: user_id is a JSON object with session_id
  if (userId[0] === "{") {
    try {
      const parsed = JSON.parse(userId) as { session_id?: unknown }
      const sessionId = parsed.session_id
      if (typeof sessionId === "string" && sessionId.trim()) {
        return sessionId.trim()
      }
    } catch {
      // not valid JSON, ignore
    }
  }
  return undefined
}

/**
 * Computes a stable hash from the conversation prefix (system instructions +
 * first user message) to use as a prompt_cache_key fallback.
 *
 * xAI's prompt caching is prefix-based: if two requests share the same
 * leading tokens (system prompt + opening user turn), the cached prefix
 * is reused. By hashing these two components we ensure:
 *   - Same conversation across turns → same cache key → cache hits
 *   - Different conversations → different cache keys → no cache pollution
 *
 * Returns a short hex string (first 16 chars of sha256) prefixed with
 * "prefix:", or undefined if there is not enough content to hash.
 */
function computePrefixHash(payload: ResponsesPayload): string | undefined {
  const parts: Array<string> = []

  // System instructions
  const instructions = payload.instructions?.trim()
  if (instructions) {
    parts.push(instructions)
  }

  // First user message from the input array
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

/**
 * Extracts the text content of the first user message from a Responses
 * payload's `input` field. Handles both string input and structured
 * input arrays with mixed content types.
 */
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

/**
 * xAI only accepts `reasoning.effort` on a subset of reasoning-capable models.
 * Forwarding it to other models triggers an upstream rejection. The set below
 * mirrors `xaiSupportsReasoningEffort` in CLIProxyAPI/xai_executor.go.
 */
function xaiSupportsReasoningEffort(model: string): boolean {
  // Strip any thinking suffix (e.g. ":high") and lowercase.
  const name = model.split(":")[0]?.toLowerCase().trim() ?? ""
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name
  return (
    base.startsWith("grok-3-mini")
    || base.startsWith("grok-4.20-multi-agent")
    || base.startsWith("grok-4.3")
  )
}

/**
 * Strips `reasoning.effort` (and the now-empty `reasoning` object) when the
 * target model does not support reasoning effort. Mirrors
 * `sanitizeXAIResponsesBody` in CLIProxyAPI/xai_executor.go.
 */
function sanitizeXaiReasoningEffort(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  if (xaiSupportsReasoningEffort(model)) {
    return body
  }
  const reasoning = body.reasoning
  if (!reasoning || typeof reasoning !== "object") {
    return body
  }
  const { effort: _effort, ...rest } = reasoning as Record<string, unknown>
  if (Object.keys(rest).length === 0) {
    const { reasoning: _r, ...withoutReasoning } = body
    return withoutReasoning
  }
  return { ...body, reasoning: rest }
}

/**
 * xAI rejects payloads that include `tool_choice` or `parallel_tool_calls`
 * without any `tools` defined. Drop them in that case. Mirrors
 * `normalizeXAIToolChoiceForTools` in CLIProxyAPI/xai_executor.go.
 */
function normalizeXaiToolChoiceForTools(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const tools = body.tools
  const hasTools = Array.isArray(tools) && tools.length > 0
  if (hasTools) {
    return body
  }
  const {
    tools: _t,
    tool_choice: _tc,
    parallel_tool_calls: _ptc,
    ...rest
  } = body
  return rest
}

export async function createXaiResponsesOnce(
  account: Account,
  payload: ResponsesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  if (!isOAuthAccount(account) || account.provider !== "xai") {
    throw new Error("xAI responses requires an xAI OAuth account")
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(`xAI access token missing for account "${account.label}"`)
  }

  const model = canonicalNativeModelId(payload.model)
  const baseUrl = account.settings?.baseUrl ?? XAI_API_BASE_URL
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`
  const clientStream = payload.stream === true
  const sessionId = resolveXaiSessionId(payload, ctx)

  const baseBody: Record<string, unknown> = {
    ...payload,
    model,
    stream: true,
    previous_response_id: undefined,
    prompt_cache_retention: undefined,
    safety_identifier: undefined,
    stream_options: undefined,
  }
  // Ensure prompt_cache_key is set in the body when we have a session ID,
  // matching CPA's behavior of mirroring the session ID into the body.
  if (sessionId && !baseBody.prompt_cache_key) {
    baseBody.prompt_cache_key = sessionId
  }
  const upstreamBody = normalizeXaiToolChoiceForTools(
    sanitizeXaiReasoningEffort(baseBody, model),
  )

  const response = await fetchWithOAuthProxy(account, url, {
    method: "POST",
    headers: buildXaiHeaders(accessToken, true, sessionId),
    body: JSON.stringify(upstreamBody),
    signal,
  })

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create xAI responses",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  if (clientStream) {
    const stream = await safeSseStream(response, detectResponsesStreamError)
    return normalizeResponsesStreamIds(
      stream as unknown as AsyncIterable<CopilotStreamEventLike>,
    )
  }

  return collectResponsesFromSseResponse(response, model)
}
