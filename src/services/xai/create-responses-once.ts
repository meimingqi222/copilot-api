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
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import { resolveXaiModelId } from "~/services/oauth/model-catalog"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import {
  collectResponsesFromEventStream,
  collectResponsesFromSseResponse,
} from "~/services/responses/sse-collector"
import {
  applyXaiWebsocketHeaders,
  destroyUpstreamWebsocketSession,
  isAbortLikeError,
  openUpstreamResponsesWebsocketTurn,
  shouldUseUpstreamResponsesWebsocket,
} from "~/services/responses/upstream-ws"
import { classifyWsFailure } from "~/services/responses/ws-failure"

import {
  appendResponsesTranscript,
  buildResponsesTranscriptInput,
  getResponsesTranscript,
  resolveSocketResponsesTranscriptSessionId,
  type TranscriptStoreResult,
  xaiTranscriptKey,
} from "../codex/ws-transcript-cache"
import {
  isXaiCliChatProxyBaseUrl,
  xaiChatBaseUrl,
  xaiWsBaseUrl,
} from "./endpoint"
import { buildXaiHeaders } from "./headers"
import {
  restoreXaiNamespaceToolCalls,
  sanitizeXaiResponsesBodyWithRefs,
  type XaiNamespaceToolRef,
} from "./sanitize-body"
import { resolveXaiSessionId } from "./session"

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
  // WebSocket always uses the official API (cli-chat-proxy rejects WS with 405).
  // HTTP chat uses the resolved chat endpoint: Grok CLI chat-proxy in CLI mode
  // (the default) or the official API when settings.useApi is true.
  const wsUrl = `${xaiWsBaseUrl(account).replace(/\/+$/, "")}/responses`
  const chatBaseUrl = xaiChatBaseUrl(account)
  const chatUrl = `${chatBaseUrl.replace(/\/+$/, "")}/responses`
  const useCliIdentity = isXaiCliChatProxyBaseUrl(chatBaseUrl)
  const clientStream = payload.stream === true
  const useUpstreamWs =
    !ctx?.forceUpstreamHttp
    && shouldUseUpstreamResponsesWebsocket(account, "xai", ctx)
  const sessionId = resolveXaiSessionId(payload, model, ctx)

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
  const sanitized = sanitizeXaiResponsesBodyWithRefs(baseBody, model)
  const upstreamBody = sanitized.body
  const namespaceToolRefs = sanitized.namespaceToolRefs

  // ── Upstream WebSocket path (CPA XAIWebsocketsExecutor) ──────────────
  // Set when a chained turn falls back to HTTP: the HTTP POST must send the
  // full self-contained input (not the client's delta) so the tool-result turn
  // is not an orphan.
  const executionSessionId =
    ctx?.executionSessionId?.trim() || sessionId || account.id
  const transcriptSessionId = resolveSocketResponsesTranscriptSessionId(
    executionSessionId,
    sessionId,
    ctx?.transcriptScopeId,
  )
  const transcriptKey = xaiTranscriptKey(transcriptSessionId)
  const rawDelta =
    Array.isArray(payload.input) ? (payload.input as Array<unknown>) : []
  const cachedFull =
    previousResponseId ? getResponsesTranscript(transcriptKey) : undefined
  const transcriptTrackable = !previousResponseId || Boolean(cachedFull)
  const fullInputThisTurn = buildResponsesTranscriptInput(
    cachedFull,
    rawDelta,
    Boolean(ctx?.downstreamWebsocket),
  )
  const fallbackFullInputBody =
    previousResponseId && cachedFull ?
      sanitizeXaiResponsesBodyWithRefs(
        {
          ...upstreamBody,
          input: fullInputThisTurn,
          previous_response_id: undefined,
        },
        model,
      ).body
    : undefined
  const httpFallbackBody = fallbackFullInputBody

  if (previousResponseId && !useUpstreamWs && !httpFallbackBody) {
    throw new HTTPError(
      "previous_response_not_found: chained xAI request requires full replay",
      new Response(null, { status: 409 }),
    )
  }

  if (useUpstreamWs) {
    const headers = applyXaiWebsocketHeaders(
      buildXaiHeaders(accessToken, true, sessionId),
    )
    const wsBody: Record<string, unknown> = {
      ...upstreamBody,
      previous_response_id: previousResponseId,
    }
    try {
      // Eager open+send so handshake failures hit this catch (streaming-safe).
      const wsStream = await openUpstreamResponsesWebsocketTurn({
        provider: "xai",
        account,
        httpResponsesUrl: wsUrl,
        headers,
        body: wsBody,
        executionSessionId,
        signal,
        previousResponseId,
        fallbackFullInputBody,
        memoryTraceId: ctx?.memoryTraceId,
      })
      const normalized = normalizeResponsesStreamIds(wsStream)
      const restored = restoreXaiNamespaceCallsInStream(
        normalized,
        namespaceToolRefs,
      )
      const tracked =
        transcriptTrackable ?
          recordXaiTranscript(
            restored,
            transcriptKey,
            fullInputThisTurn,
            ctx?.memoryTraceId,
          )
        : restored
      if (clientStream) {
        return tracked
      }
      return await collectResponsesFromEventStream(tracked, model)
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

  const effectiveHttpBody = httpFallbackBody ?? upstreamBody
  updateMemoryTrace(ctx?.memoryTraceId, "upstream_http_stringify_start", {
    provider: "xai",
    inputItems:
      Array.isArray(effectiveHttpBody.input) ?
        effectiveHttpBody.input.length
      : 0,
  })
  const httpBody = JSON.stringify(effectiveHttpBody)
  updateMemoryTrace(ctx?.memoryTraceId, "upstream_http_send", {
    provider: "xai",
    wireBytes: Buffer.byteLength(httpBody),
  })
  const response = await fetchWithOAuthProxy(account, chatUrl, {
    method: "POST",
    headers: buildXaiHeaders(accessToken, true, sessionId, useCliIdentity),
    // HTTP: no previous_response_id. On a chained-turn WS fallback, send the
    // full self-contained input (httpFallbackBody) so the turn is not orphaned.
    body: httpBody,
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
    const normalized = normalizeResponsesStreamIds(
      stream as unknown as AsyncIterable<CopilotStreamEventLike>,
    )
    const restored = restoreXaiNamespaceCallsInStream(
      normalized,
      namespaceToolRefs,
    )
    return ctx?.downstreamWebsocket && transcriptTrackable ?
        recordXaiTranscript(
          restored,
          transcriptKey,
          fullInputThisTurn,
          ctx.memoryTraceId,
        )
      : restored
  }

  const result = await collectResponsesFromSseResponse(response, model)
  restoreXaiNamespaceToolCallsInResponse(result, namespaceToolRefs)
  if (ctx?.downstreamWebsocket && transcriptTrackable) {
    recordTranscriptCheckpoint(
      ctx.memoryTraceId,
      appendResponsesTranscript(
        transcriptKey,
        fullInputThisTurn,
        Array.isArray(result.output) ? result.output : [],
      ),
    )
  }
  return result
}

/**
 * Passthrough generator that, on each successful terminal response, appends the
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
  memoryTraceId?: string,
): AsyncIterable<CopilotStreamEventLike> {
  for await (const event of stream) {
    const data = event.data
    if (
      data
      && data !== "[DONE]"
      && (data.includes('"response.completed"')
        || data.includes('"response.incomplete"'))
    ) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (
          parsed.type === "response.completed"
          || parsed.type === "response.incomplete"
        ) {
          const response = parsed.response as { output?: unknown } | undefined
          const output: Array<unknown> =
            response && Array.isArray(response.output) ?
              (response.output as Array<unknown>)
            : []
          recordTranscriptCheckpoint(
            memoryTraceId,
            appendResponsesTranscript(transcriptKey, fullInputThisTurn, output),
          )
        }
      } catch {
        // Best-effort transcript recording.
      }
    }
    yield event
  }
}

function recordTranscriptCheckpoint(
  memoryTraceId: string | undefined,
  result: TranscriptStoreResult,
): void {
  updateMemoryTrace(
    memoryTraceId,
    result.stored ? "transcript_stored" : "transcript_dropped",
    {
      transcriptEntryBytes: result.entryBytes,
      transcriptTotalBytes: result.totalBytes,
      transcriptEntries: result.entries,
    },
  )
}

/**
 * Passthrough generator that restores namespace-qualified function_call names
 * in every upstream SSE data payload before it reaches the client or the
 * transcript recorder. Mirrors CPA's restore on HTTP SSE and WS frames.
 */
async function* restoreXaiNamespaceCallsInStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  refs: Map<string, XaiNamespaceToolRef>,
): AsyncIterable<CopilotStreamEventLike> {
  if (refs.size === 0) {
    yield* stream
    return
  }
  for await (const event of stream) {
    if (event.data && event.data !== "[DONE]") {
      const restored = restoreXaiNamespaceToolCalls(event.data, refs)
      yield restored === event.data ? event : { ...event, data: restored }
    } else {
      yield event
    }
  }
}

/** Restore namespace-qualified function_call names in a completed response. */
function restoreXaiNamespaceToolCallsInResponse(
  response: ResponsesResponse,
  refs: Map<string, XaiNamespaceToolRef>,
): void {
  if (refs.size === 0 || !Array.isArray(response.output)) return
  for (const item of response.output) {
    if (typeof item !== "object") continue
    const record = item as unknown as Record<string, unknown>
    if (record.type !== "function_call") continue
    const qualified = typeof record.name === "string" ? record.name.trim() : ""
    const ref = refs.get(qualified)
    if (!ref) continue
    record.name = ref.name
    record.namespace = ref.namespace
  }
}
