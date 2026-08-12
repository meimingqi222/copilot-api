import type { Context } from "hono"

import { randomUUID } from "node:crypto"

import type { RequestAdmission } from "~/lib/request-admission"
import type {
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { HTTPError } from "~/lib/error"
import { logStore } from "~/lib/log-store"
import { logger } from "~/lib/logger"
import {
  beginMemoryTrace,
  endMemoryTrace,
  updateMemoryTrace,
} from "~/lib/memory-diagnostics"
import {
  prepareRequestAdmission,
  resolveConnectionFromTarget,
  selectNextResponsesWsTarget,
} from "~/lib/request-admission"
import { MAX_JSON_BODY_BYTES } from "~/lib/request-body"
import {
  ClientAbortError,
  getKnownRouteErrorDetails,
} from "~/lib/request-lifecycle"
import {
  bindRequestLogContext,
  createDetachedRequestLog,
  finalizeRequestLogContext,
  getRequestLogContext,
  markStreamTerminal,
  recordTraceError,
  restoreRequestLogContext,
} from "~/lib/request-log"
import { appendRequestLogSync } from "~/lib/request-log-persist"
import { resolveTranscriptScopeId } from "~/lib/request-scope"
import { targetKey } from "~/lib/route-target"
import { getClientIp, isAbortError } from "~/lib/utils"
import { clearResponsesTranscriptsByExecutionId } from "~/services/codex/ws-transcript-cache"
import { createResponses } from "~/services/copilot/create-responses"
import { inferInitiatorFromResponsesPayload } from "~/services/copilot/initiator"
import { extractMessageContentFromResponsesPayload } from "~/services/copilot/responses-api"
import { recordUpstreamFailure } from "~/services/dispatch/failover"
import { closeUpstreamWebsocketSessionsByExecutionId } from "~/services/responses/upstream-ws"
import { classifyWsFailure } from "~/services/responses/ws-failure"

import {
  createResponsesErrorPayload,
  isNonStreaming,
  recordResponsesUsage,
} from "./handler"
import { getResponsesStatusOutcome, hasResponsesOutput } from "./logging"
import {
  getResponsesTerminalOutcome,
  getResponsesWsErrorSnippet,
  recordResponsesWsAttemptIfMissing,
} from "./ws-attempt-log"
import {
  pumpWithLeadingBuffer,
  sendText,
  type WebSocketSendTarget,
} from "./ws-pump"

export type { WebSocketSendTarget } from "./ws-pump"

interface ResponsesWebSocketMessage {
  type?: unknown
  response?: unknown
  [key: string]: unknown
}

export { sendResponsesWebSocketTextForTest } from "./ws-pump"

export function createResponsesWebSocketSession(c: Context) {
  let inFlight = false
  let turnSequence = 0
  let activeController: AbortController | undefined
  let activeTurn: ReturnType<typeof createDetachedRequestLog> | undefined
  const executionSessionId = randomUUID()
  const transcriptScopeId = resolveTranscriptScopeId(c)
  logger.info(
    `responses websocket: client session opened id=${executionSessionId}`,
  )

  const endActiveRequest = () => {
    inFlight = false
    activeController = undefined
  }

  return {
    onMessage(
      event: MessageEvent<string | ArrayBuffer>,
      ws: WebSocketSendTarget,
    ) {
      if (typeof event.data !== "string") {
        void sendError(ws, "Invalid request. Expected text JSON message.")
        return
      }

      const inputBytes = Buffer.byteLength(event.data)
      const memoryTraceId = `${executionSessionId}:${++turnSequence}`
      beginMemoryTrace({
        traceId: memoryTraceId,
        kind: "responses_websocket",
        stage: "downstream_frame_received",
        details: { inputBytes },
      })

      if (inputBytes > MAX_JSON_BODY_BYTES) {
        void sendError(
          ws,
          `Request exceeds the ${MAX_JSON_BODY_BYTES}-byte WebSocket message limit.`,
          "request_too_large",
        )
        endMemoryTrace(memoryTraceId, "rejected_too_large")
        return
      }

      let message: ResponsesWebSocketMessage
      try {
        message = JSON.parse(event.data) as ResponsesWebSocketMessage
      } catch {
        void sendError(ws, "Invalid request. Expected valid JSON payload.")
        endMemoryTrace(memoryTraceId, "rejected_invalid_json")
        return
      }

      updateMemoryTrace(memoryTraceId, "payload_parsed", {
        requestType:
          typeof message.type === "string" ? message.type : "unknown",
      })

      if (message.type !== "response.create") {
        void sendError(ws, 'Invalid request type. Expected "response.create".')
        endMemoryTrace(memoryTraceId, "rejected_invalid_type")
        return
      }

      if (inFlight) {
        void sendError(
          ws,
          "Connection is busy processing another response.create request.",
          "busy",
        )
        endMemoryTrace(memoryTraceId, "rejected_busy")
        return
      }

      const payload = parseResponsePayload(message)
      if (!payload) {
        void sendError(ws, "Invalid request. Missing response payload object.")
        endMemoryTrace(memoryTraceId, "rejected_invalid_payload")
        return
      }

      updateMemoryTrace(memoryTraceId, "payload_ready", {
        model: payload.model,
        inputItems: Array.isArray(payload.input) ? payload.input.length : 1,
      })

      inFlight = true
      const controller = new AbortController()
      activeController = controller
      const handshakeCtx = getRequestLogContext(c)
      const turnCtx = createDetachedRequestLog({
        parentRequestId: handshakeCtx?.requestId,
        method: "WS",
        path: c.req.path,
        endpoint: "responses",
        apiKind: "responses",
        clientIp: getClientIp(c),
        userAgent: c.req.header("user-agent") || undefined,
        userId: c.get("userId"),
        username: c.get("username"),
        modelRequested: payload.model,
        model: payload.model,
        streaming: true,
        outcome: "incomplete",
      })
      activeTurn = turnCtx
      const previousCtx = bindRequestLogContext(c, turnCtx)

      const finishTurn = (status: number) => {
        if (turnCtx.finished) return
        turnCtx.finished = true
        const finalized = finalizeRequestLogContext(turnCtx, status, {
          method: "WS",
          path: c.req.path,
        })
        logStore.push(finalized)
        appendRequestLogSync(finalized)
      }
      turnCtx.finish = () => finishTurn(turnCtx.entry.statusCode ?? 500)

      void processResponseCreate({
        c,
        ws,
        payload,
        signal: controller.signal,
        executionSessionId,
        transcriptScopeId,
        memoryTraceId,
      })
        .then((outcome) => {
          endMemoryTrace(memoryTraceId, outcome)
          if (outcome === "completed") finishTurn(200)
          else if (outcome === "aborted") finishTurn(499)
          else finishTurn(turnCtx.entry.upstreamStatus ?? 500)
        })
        .catch((error: unknown) => {
          recordTraceError(c, error)
          endMemoryTrace(memoryTraceId, "error")
          finishTurn(error instanceof HTTPError ? error.response.status : 500)
        })
        .finally(() => {
          restoreRequestLogContext(c, turnCtx, previousCtx)
          if (activeTurn === turnCtx) activeTurn = undefined
          endActiveRequest()
        })
    },

    onClose(event?: CloseEvent) {
      logger.info(
        `responses websocket: client session closed id=${executionSessionId} `
          + `code=${event?.code ?? 0} reason=${event?.reason || "(none)"}`,
      )
      activeController?.abort()
      if (activeTurn) recordTraceError(c, new ClientAbortError())
      cancelActiveTurn(activeTurn)
      endActiveRequest()
      const closed = closeUpstreamWebsocketSessionsByExecutionId(
        executionSessionId,
        "client_disconnect",
      )
      clearResponsesTranscriptsByExecutionId(executionSessionId)
      if (closed > 0) {
        logger.info(
          `responses websocket: closed ${closed} upstream session(s) for id=${executionSessionId}`,
        )
      }
    },

    onError(event?: Event) {
      logger.warn(
        `responses websocket: client session error id=${executionSessionId} `
          + `event=${event?.type ?? "unknown"}`,
      )
      activeController?.abort()
      if (activeTurn) recordTraceError(c, new ClientAbortError())
      cancelActiveTurn(activeTurn)
      endActiveRequest()
      closeUpstreamWebsocketSessionsByExecutionId(
        executionSessionId,
        "client_error",
      )
      clearResponsesTranscriptsByExecutionId(executionSessionId)
    },
  }
}

function cancelActiveTurn(
  turn: ReturnType<typeof createDetachedRequestLog> | undefined,
): void {
  if (!turn || turn.finished) return
  Object.assign(turn.entry, {
    outcome: "cancelled",
    protocolTerminal: "client.closed",
    statusCode: 499,
  })
  turn.finish?.()
}

function parseResponsePayload(
  message: ResponsesWebSocketMessage,
): ResponsesPayload | null {
  const rawPayload =
    typeof message.response === "object" && message.response ?
      message.response
    : message

  if (typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return null
  }

  const payloadCandidate = { ...(rawPayload as Record<string, unknown>) }
  delete payloadCandidate.type

  if (
    typeof payloadCandidate.model !== "string"
    || !payloadCandidate.model
    || !Object.hasOwn(payloadCandidate, "input")
  ) {
    return null
  }

  return payloadCandidate as unknown as ResponsesPayload
}

interface ProcessResponseCreateOptions {
  c: Context
  ws: WebSocketSendTarget
  payload: ResponsesPayload
  signal: AbortSignal
  executionSessionId: string
  transcriptScopeId: string
  memoryTraceId: string
}

/**
 * Same-protocol, account-backed next-target selection for the rotation loop.
 * Returns a fully resolved admission for the next candidate, or null when the
 * candidate set is exhausted (or the pinned connection has no more accounts).
 */
function selectNextResponsesAdmission(
  initial: RequestAdmission,
  current: RequestAdmission,
  modelId: string,
  tried: Set<string>,
): RequestAdmission | null {
  const next = selectNextResponsesWsTarget(initial.target, modelId, tried, {
    sessionId: current.sessionId,
    fallbackSessionId: current.fallbackSessionId,
  })
  if (!next) return null
  const resolved = resolveConnectionFromTarget(next)
  if (!resolved?.account) return null
  return {
    target: next,
    connection: resolved.connection,
    credential: resolved.credential,
    account: resolved.account,
    initiator: current.initiator,
    sessionId: current.sessionId,
    fallbackSessionId: current.fallbackSessionId,
  }
}

async function processResponseCreate(
  options: ProcessResponseCreateOptions,
): Promise<"aborted" | "completed" | "error"> {
  const {
    c,
    ws,
    payload,
    signal,
    executionSessionId,
    transcriptScopeId,
    memoryTraceId,
  } = options

  const sessionHeaders = extractResponsesSessionHeaders(c)
  let admission: RequestAdmission
  try {
    admission = await prepareResponsesAdmission(c, payload, sessionHeaders)
  } catch (error) {
    recordTraceError(c, error)
    updateMemoryTrace(memoryTraceId, "admission_error")
    await handleResponseError(ws, error, signal)
    return signal.aborted ? "aborted" : "error"
  }
  updateMemoryTrace(memoryTraceId, "admission_ready", {
    provider: admission.account?.provider ?? "unknown",
    accountId: admission.account?.id ?? "unknown",
  })

  // Commit-aware, account-rotating loop. Each attempt buffers leading control
  // frames and only "commits" when the first real frame reaches the client;
  // before that a credential-scoped failure silently fails over to the next
  // same-protocol account, and a connection-scoped failure gets one same-
  // account HTTP recovery.
  let current = admission
  let httpRecoveryTried = false
  const tried = new Set<string>()

  while (true) {
    const outcome = await runResponsesAttempt({
      c,
      ws,
      payload,
      signal,
      executionSessionId,
      transcriptScopeId,
      sessionHeaders,
      admission,
      current,
      tried,
      httpRecoveryTried,
      memoryTraceId,
    })
    if (outcome.type === "retry-http") {
      updateMemoryTrace(memoryTraceId, "provider_http_recovery")
      httpRecoveryTried = true
      continue
    }
    if (outcome.type === "rotate") {
      updateMemoryTrace(memoryTraceId, "provider_account_rotation", {
        provider: outcome.next.account?.provider ?? "unknown",
        accountId: outcome.next.account?.id ?? "unknown",
      })
      current = outcome.next
      httpRecoveryTried = false
      continue
    }
    // "done" | "stop": the attempt already forwarded the response or surfaced
    // the error / stopped silently on abort.
    if (outcome.type === "done") return "completed"
    return signal.aborted ? "aborted" : "error"
  }
}

interface RunResponsesAttemptParams {
  c: Context
  ws: WebSocketSendTarget
  payload: ResponsesPayload
  signal: AbortSignal
  executionSessionId: string
  transcriptScopeId: string
  sessionHeaders: Record<string, string | undefined>
  admission: RequestAdmission
  current: RequestAdmission
  tried: Set<string>
  httpRecoveryTried: boolean
  memoryTraceId: string
}

/**
 * A single create + pump attempt. Returns a directive for the rotation loop:
 *   - `done`       — response forwarded (or fully surfaced); stop.
 *   - `stop`       — abort / committed error / non-retryable error; stop.
 *   - `retry-http` — lazy connection failure; retry same account over HTTP.
 *   - `rotate`     — credential failure; continue on the returned admission.
 * Usage is recorded here (only for the account that actually completed).
 */
async function runResponsesAttempt(
  params: RunResponsesAttemptParams,
): Promise<
  | { type: "done" }
  | { type: "stop" }
  | { type: "retry-http" }
  | { type: "rotate"; next: RequestAdmission }
> {
  const {
    c,
    ws,
    payload,
    signal,
    executionSessionId,
    transcriptScopeId,
    sessionHeaders,
    admission,
    current,
    tried,
    httpRecoveryTried,
    memoryTraceId,
  } = params

  // Rotation is account-managed; the selector only returns account-backed
  // candidates and the initial admission is validated as account-backed.
  const account = current.account
  if (!account) {
    await handleResponseError(
      ws,
      new HTTPError(
        "Responses API requires an Account-based admission",
        new Response("Not Implemented", { status: 501 }),
      ),
      signal,
    )
    return { type: "stop" }
  }

  const state = { committed: false }
  const attemptStarted = Date.now()
  const attemptsBefore = getRequestLogContext(c)?.entry.attempts?.length ?? 0

  try {
    updateMemoryTrace(memoryTraceId, "provider_request_start", {
      provider: account.provider,
      accountId: account.id,
      httpRecovery: httpRecoveryTried,
    })
    const result = await createResponses(payload, {
      signal,
      initiatorOverride: current.initiator,
      account,
      forwardedHeaders: sessionHeaders,
      c,
      downstreamWebsocket: true,
      // Same-account HTTP recovery for a lazy connection failure: skip WS.
      forceUpstreamHttp: httpRecoveryTried,
      executionSessionId,
      transcriptScopeId,
      memoryTraceId,
    })
    updateMemoryTrace(memoryTraceId, "provider_response_open", {
      provider: account.provider,
      accountId: result.accountId,
      streaming: !isNonStreaming(result.response),
    })
    c.set("accountId" as never, result.accountId)
    const turn = getRequestLogContext(c)
    if (turn) turn.entry.accountId = result.accountId

    let completedResponse: ResponsesResponse | undefined
    // Performance metrics for the usage_stats row (TTFT/TPS). The SSE handler
    // computes these; the WS handler must too, or the performance view
    // (WHERE ttft_ms IS NOT NULL OR tps IS NOT NULL) filters WS turns out.
    let usageTps: number | undefined
    let usageTtftMs: number | undefined
    let usageStreaming = false
    if (isNonStreaming(result.response)) {
      completedResponse = result.response
      const elapsed = Date.now() - attemptStarted
      const completionTokens = completedResponse.usage?.output_tokens ?? 0
      usageTps = elapsed > 0 ? completionTokens / (elapsed / 1000) : 0
      usageStreaming = false
      if (!(await sendJson(ws, result.response, signal))) {
        throw new ClientAbortError()
      }
      state.committed = true
      updateMemoryTrace(memoryTraceId, "downstream_committed", {
        responseMode: "non_streaming",
      })
      const terminal = `response.${result.response.status ?? "completed"}`
      markStreamTerminal(
        c,
        terminal,
        getResponsesStatusOutcome(result.response.status),
        hasResponsesOutput(result.response),
      )
    } else {
      const pumped = await pumpWithLeadingBuffer(ws, result.response, {
        onCommit: () => {
          state.committed = true
          updateMemoryTrace(memoryTraceId, "downstream_committed", {
            responseMode: "streaming",
          })
        },
      })
      completedResponse = pumped.completedResponse
      usageStreaming = true
      const elapsed = Date.now() - attemptStarted
      const completionTokens = completedResponse?.usage?.output_tokens ?? 0
      usageTps = elapsed > 0 ? completionTokens / (elapsed / 1000) : 0
      usageTtftMs =
        pumped.firstContentAt ?
          pumped.firstContentAt - attemptStarted
        : undefined
      markStreamTerminal(
        c,
        pumped.terminal,
        getResponsesTerminalOutcome(pumped.terminal),
        pumped.outputObserved,
      )
    }

    if (state.committed && completedResponse) {
      recordResponsesUsage({
        c,
        accountId: result.accountId,
        response: completedResponse,
        tps: usageTps,
        streaming: usageStreaming,
        ttftMs: usageTtftMs,
      })
    }
    recordResponsesWsAttemptIfMissing(
      c,
      current,
      attemptsBefore,
      attemptStarted,
      {
        status: 200,
      },
    )
    return { type: "done" }
  } catch (error) {
    const failure = classifyWsFailure(error)
    const failureStatus =
      error instanceof HTTPError ? error.response.status : undefined
    recordResponsesWsAttemptIfMissing(
      c,
      current,
      attemptsBefore,
      attemptStarted,
      {
        status: failureStatus,
        errorCode: failure.kind,
        errorSnippet: getResponsesWsErrorSnippet(error),
        retryAfterMs: failure.retryAfterMs,
      },
    )
    updateMemoryTrace(memoryTraceId, "provider_attempt_failed", {
      failureScope: failure.scope,
      failureKind: failure.kind,
      committed: state.committed,
    })

    if (
      failure.scope === "abort"
      || error instanceof ClientAbortError
      || (isAbortError(error) && signal.aborted)
    ) {
      recordTraceError(c, new ClientAbortError())
      return { type: "stop" }
    }

    if (state.committed) {
      recordTraceError(c, error)
      await handleResponseError(ws, error, signal)
      return { type: "stop" }
    }

    if (failure.scope === "connection" && !httpRecoveryTried) {
      return { type: "retry-http" }
    }

    if (failure.scope !== "credential") {
      recordTraceError(c, error)
      await handleResponseError(ws, error, signal)
      return { type: "stop" }
    }

    // Credential failure → mark the current target BEFORE selecting the next
    // (mirrors executeWithFailover ordering) so it isn't re-picked and the last
    // candidate's failure is still recorded when next is null.
    tried.add(targetKey(current.target))
    await recordUpstreamFailure(current, failure)
    const next = selectNextResponsesAdmission(
      admission,
      current,
      payload.model,
      tried,
    )
    if (!next) {
      recordTraceError(c, error)
      await handleResponseError(ws, error, signal)
      return { type: "stop" }
    }
    return { type: "rotate", next }
  }
}

function extractResponsesSessionHeaders(
  c: Context,
): Record<string, string | undefined> {
  return {
    session_id: c.req.header("session_id") ?? c.req.header("session-id"),
    thread_id: c.req.header("thread_id") ?? c.req.header("thread-id"),
    "x-codex-turn-metadata": c.req.header("x-codex-turn-metadata"),
    "x-codex-window-id": c.req.header("x-codex-window-id"),
    "x-codex-beta-features": c.req.header("x-codex-beta-features"),
    // Responses Lite marker — forwarded so the upstream/parallel_tool_calls
    // invariant is preserved end-to-end.
    "x-openai-internal-codex-responses-lite": c.req.header(
      "x-openai-internal-codex-responses-lite",
    ),
    version: c.req.header("version"),
    originator: c.req.header("originator"),
    "x-grok-conv-id": c.req.header("x-grok-conv-id"),
    "x-claude-code-session-id": c.req.header("x-claude-code-session-id"),
    prompt_cache_key: c.req.header("prompt_cache_key"),
  }
}

async function prepareResponsesAdmission(
  c: Context,
  payload: ResponsesPayload,
  sessionHeaders: Record<string, string | undefined>,
): Promise<RequestAdmission> {
  const messageContent = extractMessageContentFromResponsesPayload(payload)
  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: payload.model,
    endpoint: "responses",
    maxTokens:
      typeof payload.max_output_tokens === "number" ?
        payload.max_output_tokens
      : undefined,
    // WS responses are always event-streamed on the client socket.
    stream: true,
    inferredInitiator: inferInitiatorFromResponsesPayload(payload),
    messageContent,
    sessionHeaders,
    sessionPayload: payload,
  })
  if (!admission.account) {
    throw new HTTPError(
      "Responses API requires an Account-based admission",
      new Response("Not Implemented", { status: 501 }),
    )
  }
  return admission
}

/**
 * Leading control-frame types that carry no user-visible content. They are
 * buffered (uncommitted) until the first content event or a terminal, so a
 * `response.created → response.failed(usage_limit_reached)` quota turn can
 * still fail over silently (nothing was forwarded).
 */
// Bounded buffer caps: overflow flushes + commits rather than buffering
// unbounded, trading a tiny failover window for a memory guarantee.

/**
 * Commit-aware pump. Leading control frames are held in a bounded buffer while
 * uncommitted; a credential/request error thrown by the generator during this
 * window propagates with nothing forwarded (retryable). The first content
 * event / terminal (or buffer overflow) flushes the buffer, forwards, and
 * calls onCommit(). A failed `sendText` (client socket gone) throws
 * ClientAbortError so the caller treats it as an abort — never a rotation.
 */

async function handleResponseError(
  ws: WebSocketSendTarget,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (isAbortError(error) && signal.aborted) {
    return
  }

  if (error instanceof ClientAbortError) {
    return
  }

  const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
  if (knownError) {
    await sendJson(
      ws,
      {
        type: "error",
        error: {
          message: knownError.message,
          type: knownError.type,
          code: knownError.type,
          ...(knownError.retryAfterSeconds > 0 ?
            { retry_after: knownError.retryAfterSeconds }
          : {}),
        },
      },
      signal,
    )
    return
  }

  await sendJson(ws, createResponsesErrorPayload(error), signal)
}

async function sendError(
  ws: WebSocketSendTarget,
  message: string,
  code?: string,
): Promise<void> {
  await sendJson(ws, {
    type: "error",
    error: {
      message,
      type: "error",
      ...(code ? { code } : {}),
    },
  })
}

async function sendJson(
  ws: WebSocketSendTarget,
  payload: unknown,
  signal?: AbortSignal,
): Promise<boolean> {
  return sendText(ws, JSON.stringify(payload), signal)
}
