import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import {
  applyIdentityConfuseBody,
  applyIdentityConfuseHeaders,
  restoreIdentityConfuseResponse,
  type IdentityConfuseState,
} from "~/lib/cache/identity-confuse"
import {
  cacheReasoningReplayItems,
  deleteReasoningReplayItems,
  getReasoningReplayItems,
  injectReasoningReplayItems,
} from "~/lib/cache/reasoning-replay-cache"
import { HTTPError } from "~/lib/error"
import { canonicalNativeModelId } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import {
  getCredentialContextString,
  getConnectionSettings,
} from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { sanitizeCodexInput } from "~/services/codex/sanitize-input"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import {
  COMPACTION_TRIGGER_ITEM_TYPE,
  hasCompactionTrigger,
  stripCompactionTrigger,
} from "~/services/responses/compact"
import {
  collectResponsesFromEventStream,
  collectResponsesFromSseResponse,
} from "~/services/responses/sse-collector"
import {
  applyCodexWebsocketHeaders,
  destroyUpstreamWebsocketSession,
  isAbortLikeError,
  openUpstreamResponsesWebsocketTurn,
  shouldUseUpstreamResponsesWebsocket,
} from "~/services/responses/upstream-ws"
import { isChainedTurnUpstreamError } from "~/services/responses/upstream-ws-error"
import { classifyWsFailure } from "~/services/responses/ws-failure"

import { buildCodexHeaders } from "./headers"
import {
  resolveCodexExtraHeaders,
  resolveCodexSessionHeaders,
} from "./session-headers"
import {
  assertChainedHttpReplayAvailable,
  buildCodexUpstreamBody,
  chainedHttpCodexRequestError,
  convertSystemRoleToDeveloper,
  isResponsesLiteRequest,
  stripReasoningItems,
} from "./upstream-body"
import {
  appendCodexTranscript,
  buildResponsesTranscriptInput,
  codexTranscriptKey,
  getCodexTranscript,
  resolveResponsesTranscriptSessionId,
  type TranscriptStoreResult,
} from "./ws-transcript-cache"

/** Reads a single trimmed forwarded header, if the downstream sent one. */
function readForwardedHeader(
  ctx: RequestExecutionContext | undefined,
  name: string,
): string | undefined {
  const value = ctx?.forwardedHeaders?.[name]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** Transport a finalized Codex body is about to be sent over. */
type CodexOutboundTransport = "http" | "ws"

/**
 * Single normalization boundary every body sent to the Codex upstream must
 * pass through last, regardless of which path assembled it (the primary
 * request, the WS `previous_response_id` turn, or a transcript-replay
 * rebuild). Before this existed, `input`-level normalization was applied at
 * `buildCodexUpstreamBody` time and the replay path (which rebuilds `input`
 * from the raw client delta + transcript, bypassing that) had to remember to
 * re-apply it separately — exactly the bug fixed above at the `input:`
 * assignment in the replay body (a replayed turn sent role "system" upstream
 * and was rejected with "Codex API does not accept 'system' role in the
 * input array"). Centralizing here means a future input-level transform only
 * has to be added in one place.
 */
export function finalizeCodexOutboundBody(
  body: Record<string, unknown>,
  transport: CodexOutboundTransport,
): Record<string, unknown> {
  const finalized: Record<string, unknown> = {
    ...body,
    input: convertSystemRoleToDeveloper(body.input),
  }
  if (transport === "http") {
    // `generate` is WebSocket-only (CPA deletes it on the HTTP path): a
    // spawn-agent turn over plain HTTP would be rejected/orphaned upstream.
    finalized.generate = undefined
    // The codex HTTP backend rejects stream_options.include_usage (CPA
    // drops the whole stream_options there, keeping only
    // reasoning_summary_delivery). include_usage is WS-only. Copy before
    // deleting: `stream_options` may be a shared reference with the WS body.
    const streamOptions = finalized.stream_options as
      | Record<string, unknown>
      | undefined
    if (streamOptions && typeof streamOptions === "object") {
      const httpStreamOptions = { ...streamOptions }
      delete httpStreamOptions.include_usage
      finalized.stream_options =
        Object.keys(httpStreamOptions).length === 0 ?
          undefined
        : httpStreamOptions
    }
  }
  return sanitizeCodexInput(finalized)
}

/**
 * Codex 上游 `/responses/compact` 一元调用（服务端上下文压缩）。
 *
 * 客户端（Codex CLI）已经按 compact 端口的契约构造好 body
 * （`ApiCompactionInput`：model/input/instructions/tools/…），这里只做
 * 最小干预：模型名映射、session/身份头、签名清洗、透传。刻意不走
 * `buildCodexUpstreamBody`（那是 `/responses` 专用，会加 stream 相关字段），
 * 不走 WebSocket、不读写 transcript/replay 缓存（input 本来就是全量历史）。
 */
export async function createCodexCompactOnce(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  body: Record<string, unknown>,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<ResponsesResponse> {
  if (connection.protocol !== "codex-native") {
    throw new Error("Codex compact requires a Codex OAuth connection")
  }

  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `Codex access token missing for connection "${connection.name}"`,
    )
  }

  const rawModel = body.model
  if (typeof rawModel !== "string" || !rawModel.trim()) {
    throw new HTTPError(
      "Codex compact request is missing model",
      new Response("Bad Request", { status: 400 }),
    )
  }
  const model = canonicalNativeModelId(rawModel)
  const settingsBase = getConnectionSettings(connection)?.baseUrl
  const baseUrl = (
    typeof settingsBase === "string" ? settingsBase : (
      CODEX_API_BASE_URL
    )).replace(/\/+$/, "")
  const url = `${baseUrl}/responses/compact`
  const { sessionId, threadId } = resolveCodexSessionHeaders(
    body as unknown as ResponsesPayload,
    ctx,
  )
  const extraHeaders = resolveCodexExtraHeaders(ctx)

  const compactBody = sanitizeCodexInput({
    model,
    // legacy 端口不认 trigger：显式路径理论上不带，防御性剥离。
    input: stripCompactionTrigger(body.input),
    // CPA 用例里 instructions 可能为 null，上游接受缺省。
    instructions:
      typeof body.instructions === "string" ? body.instructions : undefined,
    tools: body.tools,
    parallel_tool_calls: body.parallel_tool_calls,
    reasoning: body.reasoning,
    service_tier: body.service_tier,
    prompt_cache_key:
      sessionId
      ?? (typeof body.prompt_cache_key === "string" ?
        body.prompt_cache_key
      : undefined),
    text: body.text,
  })

  // 身份混淆与普通 turn 保持一致（prompt_cache_key 重映射），保证压缩
  // 请求命中同一前缀缓存。
  const identityState = applyIdentityConfuseBody(
    connection.id,
    body,
    compactBody,
  )
  const headers: Record<string, string> = {
    ...buildCodexHeaders(accessToken, true, {
      sessionId,
      threadId,
      accountId: getCredentialContextString(connection, "oauthAccountId"),
    }),
    ...extraHeaders,
  }
  applyIdentityConfuseHeaders(headers, identityState)

  logger.debug("[codex] compact upstream request", {
    model,
    inputItems: countArrayItems(compactBody.input),
  })
  const response = await postCodexResponses({
    connection,
    url,
    headers,
    upstreamBody: compactBody,
    signal,
    memoryTraceId: readMemoryTraceId(ctx),
  })
  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Codex compact response",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }
  return (await response.json()) as ResponsesResponse
}

/**
 * 显式 `/responses/compact` 入口：先调 legacy 端口，404 时回退内联。
 *
 * legacy 端口是旧形态（gpt-5.4 时代）；新模型（如 gpt-5.6 系列）直接
 * 404 `{"detail":"Not Found"}`。404 是路由级“不支持”，与账号无关，
 * 所以同账号补上 trigger 按内联（V2）重试一次，而不是 failover 切账号。
 * 内联再失败则原样抛出（404 归类为 client_error，failover 不切账号）。
 */
async function runLegacyCompactEntry(
  subject: { connection: ProviderConnection; credential: ApiCredential },
  record: Record<string, unknown>,
  payload: ResponsesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  try {
    return await createCodexCompactOnce(subject, record, signal, ctx)
  } catch (error) {
    if (!(error instanceof HTTPError) || error.response.status !== 404) {
      throw error
    }
    const modelName =
      typeof record.model === "string" ? record.model : payload.model
    logger.warn(
      `[codex] legacy /responses/compact 404 for model "${modelName}", retrying inline (V2) on the same account`,
    )
    const items = Array.isArray(record.input) ? record.input : []
    const inlinePayload = {
      ...payload,
      input: [...items, { type: COMPACTION_TRIGGER_ITEM_TYPE }],
      stream: false,
    } as ResponsesPayload
    return await createCodexResponsesOnce(subject, inlinePayload, signal, ctx)
  }
}

export async function createCodexResponsesOnce(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  payload: ResponsesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  if (connection.protocol !== "codex-native") {
    throw new Error("Codex responses requires a Codex OAuth connection")
  }

  // Compact 双形态（见 services/responses/compact.ts）：
  // - 内联 trigger（V2）：新模型（如 gpt-5.6 系列）只认这种，原样透传
  //   走普通 HTTP 流程；不注入 replay（历史自带）、不记 transcript
  //   （压缩结果不能污染链式恢复）、不链 previous_response_id（自包含）。
  // - 无 trigger（显式 /responses/compact）：调 legacy 端口；
  //   404（新模型不支持旧端口）时补上 trigger、同账号按内联重试一次。
  //   内联再失败则直接抛给 failover（404 归类为 client_error，不切账号）。
  if (ctx?.compact) {
    const record = payload as unknown as Record<string, unknown>
    if (!hasCompactionTrigger(record.input)) {
      return await runLegacyCompactEntry(
        { connection, credential },
        record,
        payload,
        signal,
        ctx,
      )
    }
  }
  // 内联压缩 turn 的标记：explicit-legacy-404 回退进来的请求同样带有 trigger。
  const compactInline =
    ctx?.compact === true
    && hasCompactionTrigger(
      (payload as unknown as Record<string, unknown>).input,
    )

  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `Codex access token missing for connection "${connection.name}"`,
    )
  }

  const model = canonicalNativeModelId(payload.model)
  const memoryTraceId = readMemoryTraceId(ctx)
  const settingsBase = getConnectionSettings(connection)?.baseUrl
  const baseUrl = (
    typeof settingsBase === "string" ? settingsBase : (
      CODEX_API_BASE_URL
    )).replace(/\/+$/, "")
  const url = `${baseUrl}/responses`
  const clientStream = payload.stream === true
  const useUpstreamWs =
    !compactInline
    && !ctx?.forceUpstreamHttp
    && shouldUseUpstreamResponsesWebsocket(connection, "codex", ctx)
  const { sessionId, threadId, sessionIdIsStable } = resolveCodexSessionHeaders(
    payload,
    ctx,
  )
  const extraHeaders = resolveCodexExtraHeaders(ctx)
  const responsesLite = isResponsesLiteRequest(payload, ctx)

  // previous_response_id is WS-only (CPA). HTTP body always strips it.
  // 压缩 turn 自包含全量历史，从不链式：有 trigger 时强制丢弃，避免
  // transcript 恢复把旧 trigger 重放进上游造成重复压缩。
  let previousResponseId: string | undefined
  if (!compactInline) {
    const previousResponseIdRaw = (
      payload as { previous_response_id?: unknown }
    ).previous_response_id
    if (
      typeof previousResponseIdRaw === "string"
      && previousResponseIdRaw.trim()
    ) {
      previousResponseId = previousResponseIdRaw.trim()
    }
  }

  const upstreamBody = buildCodexUpstreamBody(payload, model, responsesLite)

  // ── Reasoning Replay Cache ───────────────────────────────────────────
  // Resolve the replay session key BEFORE identity confuse remaps
  // prompt_cache_key. The replay cache must be independent from the
  // selected credential so auth failover can preserve replay (CPA design).
  const originalCacheKey = (
    payload as unknown as { prompt_cache_key?: unknown }
  ).prompt_cache_key
  const replaySessionKey =
    typeof originalCacheKey === "string" && originalCacheKey.trim() ?
      originalCacheKey.trim()
    : sessionId
  const transcriptScopeId = ctx?.transcriptScopeId?.trim()
  const scopedReplaySessionKey =
    transcriptScopeId && replaySessionKey ?
      `${transcriptScopeId}::${replaySessionKey}`
    : undefined

  // ── Identity Confuse ────────────────────────────────────────────────
  // Remap prompt_cache_key to a per-account deterministic UUID so that
  // multi-account load balancing doesn't break cache affinity.
  const identityState = applyIdentityConfuseBody(
    connection.id,
    payload as unknown as Record<string, unknown>,
    upstreamBody,
  )

  // Inject cached reasoning items from previous turns in this session.
  // 压缩 turn 跳过：input 本来就是全量历史，再注就是重复。
  if (scopedReplaySessionKey && !compactInline) {
    const replayItems = await getReasoningReplayItems(
      model,
      scopedReplaySessionKey,
    )
    if (replayItems && replayItems.length > 0) {
      injectReasoningReplayItems(upstreamBody, replayItems)
    }
  }

  // Debug: surface the reasoning-related fields we actually send upstream,
  // to diagnose cases where the client never sees thinking/reasoning output.
  logger.debug("[codex] outbound reasoning params", {
    model,
    stream: clientStream,
    useUpstreamWs,
    responsesLite,
    reasoning: upstreamBody.reasoning,
    include: upstreamBody.include,
    inputReasoningItemCount:
      Array.isArray(upstreamBody.input) ?
        (upstreamBody.input as Array<unknown>).filter(
          (item) =>
            item !== null
            && typeof item === "object"
            && (item as { type?: unknown }).type === "reasoning",
        ).length
      : 0,
  })

  // ── Build headers (HTTP-safe base; WS path clones + rewrites) ────────
  const httpHeaders: Record<string, string> = {
    ...buildCodexHeaders(accessToken, true, {
      sessionId,
      threadId,
      accountId: getCredentialContextString(connection, "oauthAccountId"),
    }),
    ...extraHeaders,
  }
  // Apply identity confuse to headers (remaps Session_id, turn metadata, etc.)
  applyIdentityConfuseHeaders(httpHeaders, identityState)

  // ── Upstream WebSocket path (CPA CodexWebsocketsExecutor) ────────────
  // Set when a chained turn falls back to HTTP: the HTTP POST must send the
  // full self-contained input (not the client's delta), or a tool-result turn
  // arrives as an orphan custom_tool_call_output and upstream rejects it with
  // "No tool call found for custom tool call output with call_id ...".
  const executionSessionId =
    ctx?.executionSessionId?.trim()
    || sessionId
    || replaySessionKey
    || connection.id
  // Transcript recovery is gated on a client-supplied stable session id —
  // never the turn-1 content-hash fallback (two different conversations that
  // open with an identical first turn would hash to the same id and collide
  // on the same transcript, leaking one tenant's turns into another's replay)
  // and never `account.id` (shared by every caller routed to this credential).
  // `transcriptKey` is therefore only ever built from `sessionId` once we know
  // it is stable, so `resolveResponsesTranscriptSessionId`'s empty-preferred
  // fallback (which would key on `executionSessionId`, bottoming out at
  // `account.id`) is never reached for a key that is actually read or
  // written — making an account-scoped transcript key structurally
  // impossible rather than merely coincidentally absent.
  //
  // A tenant scope is equally required, and for the same reason: a stable
  // session id is only unique *within* a principal. Not every entry point
  // establishes one — the chat→responses bridge (`dispatch/shared.ts`
  // responsesExecutor, whose executionContext is built in
  // `routes/chat-completions/handler.ts`) forwards `session_id` /
  // `prompt_cache_key` but no `transcriptScopeId` — so without this guard two
  // principals sending the same id would share one transcript entry and
  // replay each other's turns. Fail closed: no scope means no transcript, and
  // a chained turn degrades to the documented 409 instead. Any future entry
  // point that forgets to pass a scope loses recovery rather than isolation.
  // 压缩 turn 不记 transcript：压缩输出是替换历史而不是追加，重放会
  // 把旧 trigger 带回上游造成重复压缩；且压缩 turn 从不链式。
  let transcriptKey: string | undefined
  if (!compactInline && transcriptScopeId && sessionIdIsStable && sessionId) {
    transcriptKey = codexTranscriptKey(
      resolveResponsesTranscriptSessionId(
        executionSessionId,
        sessionId,
        transcriptScopeId,
      ),
    )
  }
  // Use the *raw* client input delta (not upstreamBody.input, which may have
  // reasoning-replay items injected) so full replay never double-injects it.
  const rawDelta =
    Array.isArray(payload.input) ? (payload.input as Array<unknown>) : []
  // Apply the same gate to reads as to writes: a transcript keyed on an
  // unstable/account-scoped id could never legitimately have been written
  // under the rules above, so it must never be consulted either.
  const cachedFull =
    previousResponseId && transcriptKey ?
      getCodexTranscript(transcriptKey)
    : undefined
  const transcriptTrackable = !previousResponseId || Boolean(cachedFull)
  const fullInputThisTurn = buildResponsesTranscriptInput(
    cachedFull,
    rawDelta,
    Boolean(transcriptKey),
  )
  const fallbackFullInputBody =
    previousResponseId && cachedFull ?
      {
        ...upstreamBody,
        // The replay input is rebuilt from the *raw* client delta + transcript,
        // so it bypasses `buildCodexUpstreamBody`'s per-field normalization.
        // `input` itself is normalized once, at send time, by
        // `finalizeCodexOutboundBody` (see below) — not here — so this stays
        // in sync with the primary body's normalization automatically.
        input: stripReasoningItems(fullInputThisTurn),
        previous_response_id: undefined,
      }
    : undefined
  const httpFallbackBody = fallbackFullInputBody

  // A forced HTTP retry can recover a chained turn only when the socket-scoped
  // delta can be expanded from the transcript cache.
  assertChainedHttpReplayAvailable(
    previousResponseId,
    useUpstreamWs,
    httpFallbackBody,
    memoryTraceId,
  )

  // Upstream WebSocket attempt. Returns the completed turn when the WS path
  // succeeds, or undefined when the socket is unusable and the caller should
  // fall through to a same-account HTTP POST.
  if (useUpstreamWs) {
    const wsTurn = await attemptCodexUpstreamWsTurn({
      connection,
      url,
      httpHeaders,
      upstreamBody,
      previousResponseId,
      fallbackFullInputBody,
      executionSessionId,
      signal,
      model,
      clientStream,
      scopedReplaySessionKey,
      identityState,
      transcriptKey,
      transcriptTrackable,
      fullInputThisTurn,
      memoryTraceId,
      timingMetricsHeader: readForwardedHeader(
        ctx,
        "x-responsesapi-include-timing-metrics",
      ),
    })
    if (wsTurn !== undefined) {
      return wsTurn
    }
  }

  const response = await postCodexResponses({
    connection,
    url,
    headers: httpHeaders,
    upstreamBody,
    httpFallbackBody,
    signal,
    memoryTraceId,
  })

  if (!response.ok) {
    // Clear reasoning replay cache on thinking_signature_invalid errors.
    const errorBody = await response.text().catch(() => "")
    if (
      response.status === 400
      && errorBody.includes("thinking_signature_invalid")
      && scopedReplaySessionKey
    ) {
      await deleteReasoningReplayItems(model, scopedReplaySessionKey)
    }
    throw new HTTPError(
      "Failed to create Codex responses",
      response,
      errorBody || "(unreadable)",
    )
  }

  if (clientStream) {
    const stream = await safeSseStream(response, detectResponsesStreamError)
    const normalized = normalizeResponsesStreamIds(
      stream as unknown as AsyncIterable<CopilotStreamEventLike>,
    )
    // Gate on a client-supplied stable session id (transcriptKey), not on
    // transport: an HTTP-only client with a stable prompt_cache_key is just
    // as entitled to recovery as a WebSocket client (P1 — previously this
    // required ctx.downstreamWebsocket, so pure-HTTP chained clients like
    // Crush always hit the 409 path even when they supplied a stable id).
    const tracked =
      transcriptKey && transcriptTrackable ?
        recordCodexTranscript(
          normalized,
          transcriptKey,
          fullInputThisTurn,
          memoryTraceId,
        )
      : normalized
    return wrapCodexStream(
      tracked,
      model,
      scopedReplaySessionKey,
      identityState,
    )
  }

  const result = await collectResponsesFromSseResponse(response, model)
  if (transcriptKey && transcriptTrackable) {
    recordTranscriptCheckpoint(
      memoryTraceId,
      appendCodexTranscript(
        transcriptKey,
        fullInputThisTurn,
        Array.isArray(result.output) ? result.output : [],
      ),
    )
  }
  // Debug: same reasoning-summary check as the streaming path, for the
  // non-streaming (clientStream=false) response.
  logCodexReasoningSummary(
    "[codex] non-stream response reasoning summary",
    result.output as Array<Record<string, unknown>> | undefined,
  )
  // Cache reasoning items from the completed response.
  // `result` is the response object itself (has `output`), so we pass it
  // directly — cacheReasoningReplayItems checks both `.response.output`
  // (SSE event shape) and `.output` (collected response shape).
  if (scopedReplaySessionKey) {
    void cacheReasoningReplayItems(
      model,
      scopedReplaySessionKey,
      result as unknown as Record<string, unknown>,
    )
  }
  // Restore original identifiers in the response.
  if (identityState.enabled) {
    const restored = restoreIdentityConfuseResponse(
      JSON.stringify(result),
      identityState,
    )
    return JSON.parse(restored) as ResponsesResponse
  }
  return result
}

/**
 * Passthrough generator that, on each successful terminal response, appends the
 * completed response's output items to the running full-input transcript and
 * stores it. This lets a later turn that lands on a fresh upstream socket
 * replay a self-contained request (full input, no previous_response_id)
 * instead of failing with "Previous response with id ... not found.".
 *
 * Runs on the *normalized* stream so recorded output-item ids match what the
 * codex client sees (and later chains from).
 */
async function* recordCodexTranscript(
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
            appendCodexTranscript(transcriptKey, fullInputThisTurn, output),
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

function countArrayItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function readMemoryTraceId(
  ctx: RequestExecutionContext | undefined,
): string | undefined {
  return ctx?.memoryTraceId
}

async function postCodexResponses(options: {
  connection: ProviderConnection
  url: string
  headers: Record<string, string>
  upstreamBody: Record<string, unknown>
  httpFallbackBody?: Record<string, unknown>
  signal?: AbortSignal
  memoryTraceId?: string
}): Promise<Response> {
  const effectiveBody = finalizeCodexOutboundBody(
    options.httpFallbackBody ?? options.upstreamBody,
    "http",
  )
  updateMemoryTrace(options.memoryTraceId, "upstream_http_stringify_start", {
    provider: "codex",
    inputItems: countArrayItems(effectiveBody.input),
  })
  const body = JSON.stringify(effectiveBody)
  updateMemoryTrace(options.memoryTraceId, "upstream_http_send", {
    provider: "codex",
    wireBytes: Buffer.byteLength(body),
  })
  return fetchWithConnectionProxy(options.connection, options.url, {
    method: "POST",
    headers: options.headers,
    // HTTP never sends previous_response_id. A chained WS fallback uses the
    // full self-contained body so the tool-result turn is not orphaned.
    body,
    signal: options.signal,
  })
}

/**
 * Wraps a Codex SSE stream to:
 * 1. Cache reasoning items from `response.completed` events.
 * 2. Restore original identifiers (identity confuse) in all events.
 */
/**
 * Debug: confirm whether a completed Codex response actually contains
 * reasoning output items (and a non-empty summary) before it's forwarded to
 * the client. Helps diagnose cases where thinking output silently vanishes.
 */
function logCodexReasoningSummary(
  label: string,
  output: Array<Record<string, unknown>> | undefined,
): void {
  const reasoningItems = output?.filter((item) => item.type === "reasoning")
  logger.debug(label, {
    outputTypes: output?.map((item) => item.type),
    reasoningItemCount: reasoningItems?.length ?? 0,
    reasoningHasSummary: reasoningItems?.some(
      (item) => Array.isArray(item.summary) && item.summary.length > 0,
    ),
  })
}

/** Handles a successful terminal SSE frame: cache + debug-log. */
function handleCodexStreamCompletion(
  parsed: Record<string, unknown>,
  model: string,
  replaySessionKey: string | undefined,
): void {
  if (
    parsed.type !== "response.completed"
    && parsed.type !== "response.incomplete"
  ) {
    return
  }
  if (replaySessionKey) {
    void cacheReasoningReplayItems(model, replaySessionKey, parsed)
  }
  const output = (
    parsed.response as { output?: Array<Record<string, unknown>> }
  ).output
  logCodexReasoningSummary(`[codex] ${parsed.type} reasoning summary`, output)
}

async function* wrapCodexStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  model: string,
  replaySessionKey: string | undefined,
  identityState: IdentityConfuseState,
): AsyncIterable<CopilotStreamEventLike> {
  for await (const event of stream) {
    let data = event.data
    if (!data || data === "[DONE]") {
      yield event
      continue
    }

    // Cache reasoning items on successful terminal response events.
    if (
      data.includes('"response.completed"')
      || data.includes('"response.incomplete"')
    ) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        handleCodexStreamCompletion(parsed, model, replaySessionKey)
      } catch {
        // Best-effort caching.
      }
    }

    // Restore original identifiers.
    if (identityState.enabled) {
      data = restoreIdentityConfuseResponse(data, identityState)
    }

    yield { ...event, data }
  }
}

interface CodexWsTurnOptions {
  connection: ProviderConnection
  url: string
  httpHeaders: Record<string, string>
  upstreamBody: Record<string, unknown>
  previousResponseId?: string
  fallbackFullInputBody?: Record<string, unknown>
  executionSessionId: string
  signal?: AbortSignal
  model: string
  clientStream: boolean
  scopedReplaySessionKey?: string
  identityState: IdentityConfuseState
  transcriptKey?: string
  transcriptTrackable: boolean
  fullInputThisTurn: Array<unknown>
  memoryTraceId?: string
  /**
   * Downstream `x-responsesapi-include-timing-metrics` value. Applied to the
   * WebSocket handshake only (the official client never sends it on HTTP).
   */
  timingMetricsHeader?: string
}

/**
 * Run one Codex turn over the upstream WebSocket. Returns the completed turn
 * (stream or collected response) on success, or undefined when the socket is
 * unusable and the caller should fall through to a same-account HTTP POST.
 */
async function attemptCodexUpstreamWsTurn(
  options: CodexWsTurnOptions,
): Promise<
  AsyncIterable<CopilotStreamEventLike> | ResponsesResponse | undefined
> {
  const {
    connection,
    url,
    httpHeaders,
    upstreamBody,
    previousResponseId,
    fallbackFullInputBody,
    executionSessionId,
    signal,
    model,
    clientStream,
    scopedReplaySessionKey,
    identityState,
    transcriptKey,
    transcriptTrackable,
    fullInputThisTurn,
    memoryTraceId,
    timingMetricsHeader,
  } = options
  const wsBody = finalizeCodexOutboundBody(
    { ...upstreamBody, previous_response_id: previousResponseId },
    "ws",
  )
  // `generate` must survive on the WS transport (see finalizeCodexOutboundBody);
  // finalize the replay fallback the same way so a fresh-socket recovery turn
  // does not silently drop it either.
  const wsFallbackFullInputBody =
    fallbackFullInputBody
    && finalizeCodexOutboundBody(fallbackFullInputBody, "ws")
  const wsHeaders = applyCodexWebsocketHeaders({ ...httpHeaders })
  if (timingMetricsHeader) {
    wsHeaders["x-responsesapi-include-timing-metrics"] = timingMetricsHeader
  }
  try {
    // Eager open+send so handshake failures hit this catch (streaming-safe).
    const wsStream = await openUpstreamResponsesWebsocketTurn({
      provider: "codex",
      accountId: connection.id,
      httpResponsesUrl: url,
      headers: wsHeaders,
      body: wsBody,
      executionSessionId,
      signal,
      previousResponseId,
      fallbackFullInputBody: wsFallbackFullInputBody,
      memoryTraceId,
    })
    const normalized = normalizeResponsesStreamIds(wsStream)
    // Record on the normalized stream so recorded output-item ids match what
    // the codex client sees (and later chains from). Gated the same as the
    // HTTP paths below: a client-supplied stable session id, not merely
    // "this transport is a WebSocket".
    const tracked =
      transcriptKey && transcriptTrackable ?
        recordCodexTranscript(
          normalized,
          transcriptKey,
          fullInputThisTurn,
          memoryTraceId,
        )
      : normalized
    if (clientStream) {
      return wrapCodexStream(
        tracked,
        model,
        scopedReplaySessionKey,
        identityState,
      )
    }
    return await collectResponsesFromEventStream(
      // wrapCodexStream restores confused identifiers before collection, so
      // the returned object must not be restored a second time.
      wrapCodexStream(tracked, model, scopedReplaySessionKey, identityState),
      model,
    )
  } catch (error) {
    if (isAbortLikeError(error) || signal?.aborted) throw error
    const failure = classifyWsFailure(error)
    // A chained turn the upstream rejected because its server-side chain is
    // gone (account switch / fresh socket with no transcript to replay):
    // signal the client to resend the full conversation. Codex CLI/Desktop
    // and waku recognize `previous_response_not_found` and retry with a
    // self-contained replay. The in-turn auto-retry (upstream-ws.ts) already
    // exhausted the transcript path before this error surfaced.
    if (isChainedTurnUpstreamError(error) && previousResponseId) {
      throw chainedHttpCodexRequestError()
    }
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
      destroyUpstreamWebsocketSession(
        "codex",
        connection.id,
        executionSessionId,
      )
    }
    logger.warn(
      `codex websockets: falling back to HTTP: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  return undefined
}
