import type { Context } from "hono"

import { createHash, randomUUID } from "node:crypto"

import type { RequestAdmission } from "~/lib/request-admission"
import type {
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

import { HTTPError } from "~/lib/error"
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
import { targetKey } from "~/lib/route-target"
import { isAbortError } from "~/lib/utils"
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

interface ResponsesWebSocketMessage {
  type?: unknown
  response?: unknown
  [key: string]: unknown
}

export interface WebSocketSendTarget {
  readyState: number
  send: (data: string | ArrayBuffer | Uint8Array) => unknown
  getBufferedAmount?: () => number
}

const WS_READY_STATE_OPEN = 1
const WS_SEND_HIGH_WATER_BYTES = 1024 * 1024
const WS_SEND_BACKPRESSURE_TIMEOUT_MS = 30_000
const WS_SEND_POLL_MS = 5

export function createResponsesWebSocketSession(c: Context) {
  let inFlight = false
  let turnSequence = 0
  let activeController: AbortController | undefined
  // Sticky id for upstream WS connection reuse across multi-turn creates
  // on this client socket (CPA execution session / passthroughSessionID).
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

      void processResponseCreate({
        c,
        ws,
        payload,
        signal: controller.signal,
        executionSessionId,
        transcriptScopeId,
        memoryTraceId,
      })
        .then((outcome) => endMemoryTrace(memoryTraceId, outcome))
        .catch(() => endMemoryTrace(memoryTraceId, "error"))
        .finally(endActiveRequest)
    },

    onClose(event?: CloseEvent) {
      logger.info(
        `responses websocket: client session closed id=${executionSessionId} `
          + `code=${event?.code ?? 0} reason=${event?.reason || "(none)"}`,
      )
      activeController?.abort()
      endActiveRequest()
      // Tear down sticky upstream Codex/xAI sockets for this client session.
      const closed = closeUpstreamWebsocketSessionsByExecutionId(
        executionSessionId,
        "client_disconnect",
      )
      // Drop anonymous socket-scoped transcripts. Auth/session-scoped recovery
      // entries use a stable key and remain bounded by TTL/capacity eviction.
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
      endActiveRequest()
      closeUpstreamWebsocketSessionsByExecutionId(
        executionSessionId,
        "client_error",
      )
      clearResponsesTranscriptsByExecutionId(executionSessionId)
    },
  }
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

    let completedResponse: ResponsesResponse | undefined
    if (isNonStreaming(result.response)) {
      completedResponse = result.response
      if (!(await sendJson(ws, result.response, signal))) {
        throw new ClientAbortError()
      }
      state.committed = true
      updateMemoryTrace(memoryTraceId, "downstream_committed", {
        responseMode: "non_streaming",
      })
    } else {
      completedResponse = await pumpWithLeadingBuffer(ws, result.response, {
        onCommit: () => {
          state.committed = true
          updateMemoryTrace(memoryTraceId, "downstream_committed", {
            responseMode: "streaming",
          })
        },
      })
    }

    // Usage is recorded ONLY for the account that actually committed/completed;
    // failed accounts get cooldown via recordUpstreamFailure only.
    if (state.committed && completedResponse) {
      recordResponsesUsage({
        c,
        accountId: result.accountId,
        response: completedResponse,
      })
    }
    return { type: "done" }
  } catch (error) {
    const failure = classifyWsFailure(error)
    updateMemoryTrace(memoryTraceId, "provider_attempt_failed", {
      failureScope: failure.scope,
      failureKind: failure.kind,
      committed: state.committed,
    })

    // Client abort / closed downstream socket → stop silently.
    if (
      failure.scope === "abort"
      || error instanceof ClientAbortError
      || (isAbortError(error) && signal.aborted)
    ) {
      return { type: "stop" }
    }

    // Content already forwarded → committed; surface once, never retry.
    if (state.committed) {
      await handleResponseError(ws, error, signal)
      return { type: "stop" }
    }

    // Lazy connection failure → one same-account HTTP recovery, WS skipped.
    if (failure.scope === "connection" && !httpRecoveryTried) {
      return { type: "retry-http" }
    }

    // Request error / exhausted / repeat connection → surface once.
    if (failure.scope !== "credential") {
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
      await handleResponseError(ws, error, signal)
      return { type: "stop" }
    }
    return { type: "rotate", next }
  }
}

function resolveTranscriptScopeId(c: Context): string {
  const userId = c.get("userId" as never) as string | undefined
  if (userId?.trim()) return `user:${userId.trim()}`
  const credential =
    c.req.header("authorization") ?? c.req.header("x-api-key") ?? "anonymous"
  return createHash("sha256").update(credential).digest("hex").slice(0, 24)
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
const LEADING_CONTROL_TYPES = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
])

const TERMINAL_RESPONSE_TYPES = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
])

// Bounded buffer caps: overflow flushes + commits rather than buffering
// unbounded, trading a tiny failover window for a memory guarantee.
const MAX_BUFFERED_EVENTS = 32
const MAX_BUFFERED_BYTES = 64 * 1024

interface PumpHooks {
  /** Fired synchronously on the first successful forward to the client. */
  onCommit: () => void
}

/**
 * Commit-aware pump. Leading control frames are held in a bounded buffer while
 * uncommitted; a credential/request error thrown by the generator during this
 * window propagates with nothing forwarded (retryable). The first content
 * event / terminal (or buffer overflow) flushes the buffer, forwards, and
 * calls onCommit(). A failed `sendText` (client socket gone) throws
 * ClientAbortError so the caller treats it as an abort — never a rotation.
 */
async function pumpWithLeadingBuffer(
  ws: WebSocketSendTarget,
  response: AsyncIterable<CopilotStreamEventLike>,
  hooks: PumpHooks,
): Promise<ResponsesResponse | undefined> {
  let completedResponse: ResponsesResponse | undefined
  let sawTerminal = false
  // Mutable state object so control-flow analysis keeps `committed` a plain
  // boolean (it is only ever flipped inside the commit closure below).
  const state = { committed: false }
  const buffer: Array<string> = []
  let bufferedBytes = 0

  const forward = async (data: string) => {
    if (!(await sendText(ws, data))) {
      throw new ClientAbortError()
    }
  }

  // Flush buffered control frames, then mark committed.
  const commit = async () => {
    for (const data of buffer) await forward(data)
    buffer.length = 0
    bufferedBytes = 0
    state.committed = true
    hooks.onCommit()
  }

  for await (const event of response) {
    if (event.data === "[DONE]") {
      break
    }
    if (!event.data) {
      continue
    }

    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>
    } catch {
      // Ignore parse errors - malformed JSON will be sent as-is (as content).
    }

    if (
      parsed?.type === "response.completed"
      && parsed.response
      && typeof parsed.response === "object"
    ) {
      completedResponse = parsed.response as ResponsesResponse
    }

    const type = typeof parsed?.type === "string" ? parsed.type : undefined
    if (type && TERMINAL_RESPONSE_TYPES.has(type)) {
      sawTerminal = true
    }

    // Buffer leading control frames until content/terminal or overflow.
    if (
      !state.committed
      && type !== undefined
      && LEADING_CONTROL_TYPES.has(type)
    ) {
      buffer.push(event.data)
      bufferedBytes += event.data.length
      if (
        buffer.length >= MAX_BUFFERED_EVENTS
        || bufferedBytes >= MAX_BUFFERED_BYTES
      ) {
        await commit()
      }
      continue
    }

    // First content event / terminal → include it in the flush and commit.
    if (!state.committed) {
      buffer.push(event.data)
      await commit()
      continue
    }

    await forward(event.data)
  }

  // A clean EOF/[DONE] without a Responses terminal event is a truncated turn.
  // Do not flush leading control frames: while uncommitted the caller can still
  // retry the same account over HTTP or rotate credentials safely.
  if (!sawTerminal) {
    throw new Error("Upstream stream ended without a terminal response event")
  }

  return completedResponse
}

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

/**
 * Returns true only when the payload was actually handed to `ws.send()`.
 * The pump uses this so onCommit() fires on a real successful send: if the
 * client socket is gone the first flush returns false and is treated as abort.
 */
async function sendText(
  ws: WebSocketSendTarget,
  payload: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isSocketOpen(ws)) {
    return false
  }

  try {
    const deadline = Date.now() + WS_SEND_BACKPRESSURE_TIMEOUT_MS
    while (
      ws.getBufferedAmount
      && ws.getBufferedAmount() > WS_SEND_HIGH_WATER_BYTES
    ) {
      if (!isSocketOpen(ws) || signal?.aborted || Date.now() >= deadline) {
        return false
      }
      await waitForSendPoll(signal)
    }

    const status = ws.send(payload)
    // Bun returns 0 when it dropped the message, -1 when it accepted the
    // message but applied backpressure, and a positive byte count on success.
    // Browser-style/mocked sockets return void after accepting the message.
    return status !== 0
  } catch {
    // Connection may be closing — report failure so callers can stop.
    return false
  }
}

function isSocketOpen(ws: WebSocketSendTarget): boolean {
  return ws.readyState === WS_READY_STATE_OPEN
}

function waitForSendPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, WS_SEND_POLL_MS)
    signal?.addEventListener("abort", finish, { once: true })
  })
}

/** Test hook for Bun send-status/backpressure behavior. */
export const sendResponsesWebSocketTextForTest = sendText
