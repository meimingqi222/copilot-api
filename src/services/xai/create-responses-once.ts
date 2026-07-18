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
import { logger } from "~/lib/logger"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import { resolveXaiModelId } from "~/services/oauth/model-catalog"
import { XAI_API_BASE_URL } from "~/services/oauth/xai"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import { collectResponsesFromSseResponse } from "~/services/responses/sse-collector"
import {
  applyXaiWebsocketHeaders,
  destroyUpstreamWebsocketSession,
  isAbortLikeError,
  openUpstreamResponsesWebsocketTurn,
  shouldUseUpstreamResponsesWebsocket,
} from "~/services/responses/upstream-ws"
import { classifyWsFailure } from "~/services/responses/ws-failure"

import {
  getResponsesTranscript,
  setResponsesTranscript,
  xaiTranscriptKey,
} from "../codex/ws-transcript-cache"
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
 *   6. L1 xAI prefix-hash fallback (system + first user). Always applied
 *      when possible for max cache utilization; Composer models especially
 *      need a stable key (CPA `xaiRequiresIsolatedConversation`).
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
 * Computes a short hash of a string for cache-prefix diagnostics.
 * Returns the first 12 hex chars of a sha256, enough to spot changes.
 */
function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12)
}

/**
 * Logs a cache-prefix diagnostic for xAI Responses requests. By comparing
 * the instructions hash, tools hash, and input-prefix hash across requests
 * within the same session (prompt_cache_key), you can identify which
 * component is breaking the cache prefix.
 *
 * Format:
 *   [xAI cache-diag] session=xxx instr=abc12345(8192) tools=def67890(4096)
 *   input_prefix=ghi13579 types=[user,reasoning,function_call,...] input_count=15
 *
 * If `instr` or `tools` hash changes between turns of the same session,
 * the system prompt or tool definitions are not stable — this is the
 * primary cause of cache misses.
 */
function logCachePrefixDiag(
  sessionId: string | undefined,
  payload: ResponsesPayload,
): void {
  const instructions = payload.instructions ?? ""
  const instrHash = instructions ? shortHash(instructions) : "(none)"
  const instrLen = instructions.length

  const toolsJson = payload.tools ? JSON.stringify(payload.tools) : ""
  const toolsHash = toolsJson ? shortHash(toolsJson) : "(none)"
  const toolsLen = toolsJson.length

  // Summarize the input array: item types and a hash of the first ~2KB
  // of the serialized input (the prefix that should be cached).
  let inputCount = 0
  let inputTypes: Array<string> = []
  let inputPrefixHash = "(none)"
  if (typeof payload.input === "string") {
    inputCount = 1
    inputTypes = ["string"]
    inputPrefixHash = shortHash(payload.input.slice(0, 2048))
  } else if (Array.isArray(payload.input)) {
    inputCount = payload.input.length
    inputTypes = payload.input.slice(0, 20).map((item) => {
      if (typeof item === "string") return "string"
      if ("type" in item) return item.type
      if ("role" in item) return item.role
      return "unknown"
    })
    // Hash the serialized first 4KB of the input array for prefix comparison.
    const inputPrefix = JSON.stringify(payload.input.slice(0, 10)).slice(
      0,
      4096,
    )
    inputPrefixHash = shortHash(inputPrefix)
  }

  logger.debug(
    `[xAI cache-diag] session=${sessionId ?? "(none)"} `
      + `instr=${instrHash}(${instrLen}) tools=${toolsHash}(${toolsLen}) `
      + `input_prefix=${inputPrefixHash} `
      + `types=[${inputTypes.join(",")}] input_count=${inputCount}`,
  )
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

  const model = resolveXaiModelId(canonicalNativeModelId(payload.model))
  const baseUrl = account.settings?.baseUrl ?? XAI_API_BASE_URL
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`
  const clientStream = payload.stream === true
  const useUpstreamWs =
    !ctx?.forceUpstreamHttp
    && shouldUseUpstreamResponsesWebsocket(account, "xai", ctx)
  const sessionId = resolveXaiSessionId(payload, ctx)

  // Log cache-prefix diagnostic so we can compare prefix stability across
  // turns within the same session. If instr/tools hash changes between
  // requests with the same session ID, the cache prefix is broken.
  logCachePrefixDiag(sessionId, payload)

  // previous_response_id is WS-only (xAI WS Mode + CPA). HTTP strips it.
  const previousResponseIdRaw = (payload as { previous_response_id?: unknown })
    .previous_response_id
  const previousResponseId =
    typeof previousResponseIdRaw === "string" ?
      previousResponseIdRaw.trim() || undefined
    : undefined

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

  // ── Upstream WebSocket path (CPA XAIWebsocketsExecutor) ──────────────
  // Set when a chained turn falls back to HTTP: the HTTP POST must send the
  // full self-contained input (not the client's delta) so the tool-result turn
  // is not an orphan.
  let httpFallbackBody: Record<string, unknown> | undefined
  if (useUpstreamWs) {
    const headers = applyXaiWebsocketHeaders(
      buildXaiHeaders(accessToken, true, sessionId),
    )
    const executionSessionId =
      ctx?.executionSessionId?.trim() || sessionId || account.id
    const transcriptKey = xaiTranscriptKey(executionSessionId, model)
    const rawDelta =
      Array.isArray(payload.input) ? (payload.input as Array<unknown>) : []
    const cachedFull =
      previousResponseId ? getResponsesTranscript(transcriptKey) : undefined
    // A chained turn (previous_response_id set) with no cached transcript means
    // the wire input is only a delta we cannot expand — skip recording so we
    // never poison the transcript with a partial input.
    const transcriptTrackable = !previousResponseId || Boolean(cachedFull)
    const fullInputThisTurn =
      cachedFull ? [...cachedFull, ...rawDelta] : rawDelta
    // On a *different credential's* fresh socket, this account's
    // previous_response_id is not in that connection's in-memory cache and is
    // not cross-credential resolvable, so drop it and replay the full input.
    // xAI keeps store=true unchanged; this is a per-connection recovery, not a
    // store-policy change. Reused as the connection-scope HTTP fallback body.
    const fallbackFullInputBody =
      previousResponseId && cachedFull ?
        {
          ...upstreamBody,
          input: fullInputThisTurn,
          previous_response_id: undefined,
        }
      : undefined
    httpFallbackBody = fallbackFullInputBody
    const wsBody: Record<string, unknown> = {
      ...upstreamBody,
      previous_response_id: previousResponseId,
    }
    try {
      // Eager open+send so handshake failures hit this catch (streaming-safe).
      const wsStream = await openUpstreamResponsesWebsocketTurn({
        provider: "xai",
        account,
        httpResponsesUrl: url,
        headers,
        body: wsBody,
        executionSessionId,
        signal,
        previousResponseId,
        fallbackFullInputBody,
      })
      const normalized = normalizeResponsesStreamIds(wsStream)
      const tracked =
        transcriptTrackable ?
          recordXaiTranscript(normalized, transcriptKey, fullInputThisTurn)
        : normalized
      if (clientStream) {
        return tracked
      }
      return await collectResponsesFromWsStream(tracked)
    } catch (error) {
      if (isAbortLikeError(error) || signal?.aborted) throw error
      const failure = classifyWsFailure(error)
      // credential (quota/auth/rate/server) and request (bad body) failures are
      // the handler's concern — an account switch or a surfaced error. Never
      // silently re-POST them on the same account.
      if (failure.scope === "credential" || failure.scope === "request") {
        throw error
      }
      // connection scope: this socket is unusable. On a connection-limit frame,
      // destroy the stale session so the next turn redials; then fall through
      // to a same-account HTTP POST for the current turn.
      if (failure.kind === "connection_limit") {
        destroyUpstreamWebsocketSession("xai", account.id, executionSessionId)
      }
      logger.warn(
        `xai websockets: falling back to HTTP: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const response = await fetchWithOAuthProxy(account, url, {
    method: "POST",
    headers: buildXaiHeaders(accessToken, true, sessionId),
    // HTTP: no previous_response_id. On a chained-turn WS fallback, send the
    // full self-contained input (httpFallbackBody) so the turn is not orphaned.
    body: JSON.stringify(httpFallbackBody ?? upstreamBody),
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

async function collectResponsesFromWsStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
): Promise<ResponsesResponse> {
  let completed: ResponsesResponse | undefined
  for await (const event of stream) {
    if (!event.data || event.data === "[DONE]") continue
    try {
      const parsed = JSON.parse(event.data) as Record<string, unknown>
      if (
        parsed.type === "response.completed"
        && parsed.response
        && typeof parsed.response === "object"
      ) {
        completed = parsed.response as ResponsesResponse
      }
    } catch {
      // ignore
    }
  }
  if (!completed) {
    throw new Error("xAI websockets: missing response.completed event")
  }
  return completed
}

/**
 * Passthrough generator that, on each `response.completed`, appends the
 * completed response's output items to the running full-input transcript and
 * stores it. This lets a later turn that lands on a *different credential's*
 * fresh upstream socket replay a self-contained request (full input, no
 * previous_response_id) instead of failing because that connection's in-memory
 * cache does not hold this account's previous_response_id.
 */
async function* recordXaiTranscript(
  stream: AsyncIterable<CopilotStreamEventLike>,
  transcriptKey: string,
  fullInputThisTurn: Array<unknown>,
): AsyncIterable<CopilotStreamEventLike> {
  for await (const event of stream) {
    const data = event.data
    if (data && data !== "[DONE]" && data.includes('"response.completed"')) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (parsed.type === "response.completed") {
          const response = parsed.response as { output?: unknown } | undefined
          const output: Array<unknown> =
            response && Array.isArray(response.output) ?
              (response.output as Array<unknown>)
            : []
          setResponsesTranscript(transcriptKey, [
            ...fullInputThisTurn,
            ...output,
          ])
        }
      } catch {
        // Best-effort transcript recording.
      }
    }
    yield event
  }
}
