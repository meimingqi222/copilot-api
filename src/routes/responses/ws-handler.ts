import type { Context } from "hono"

import { randomUUID } from "node:crypto"

import type {
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { prepareRequestAdmission } from "~/lib/request-admission"
import {
  ClientAbortError,
  getKnownRouteErrorDetails,
} from "~/lib/request-lifecycle"
import { isAbortError } from "~/lib/utils"
import { createResponses } from "~/services/copilot/create-responses"
import { inferInitiatorFromResponsesPayload } from "~/services/copilot/initiator"
import { extractMessageContentFromResponsesPayload } from "~/services/copilot/responses-api"
import { closeUpstreamWebsocketSessionsByExecutionId } from "~/services/responses/upstream-ws"

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
  send: (data: string | ArrayBuffer | Uint8Array) => void
}

const WS_READY_STATE_OPEN = 1

export function createResponsesWebSocketSession(c: Context) {
  let inFlight = false
  let activeController: AbortController | undefined
  // Sticky id for upstream WS connection reuse across multi-turn creates
  // on this client socket (CPA execution session / passthroughSessionID).
  const executionSessionId = randomUUID()
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
        sendError(ws, "Invalid request. Expected text JSON message.")
        return
      }

      let message: ResponsesWebSocketMessage
      try {
        message = JSON.parse(event.data) as ResponsesWebSocketMessage
      } catch {
        sendError(ws, "Invalid request. Expected valid JSON payload.")
        return
      }

      if (message.type !== "response.create") {
        sendError(ws, 'Invalid request type. Expected "response.create".')
        return
      }

      if (inFlight) {
        sendError(
          ws,
          "Connection is busy processing another response.create request.",
          "busy",
        )
        return
      }

      const payload = parseResponsePayload(message)
      if (!payload) {
        sendError(ws, "Invalid request. Missing response payload object.")
        return
      }

      inFlight = true
      const controller = new AbortController()
      activeController = controller

      void processResponseCreate({
        c,
        ws,
        payload,
        signal: controller.signal,
        executionSessionId,
      }).finally(endActiveRequest)
    },

    onClose() {
      logger.info(
        `responses websocket: client session closed id=${executionSessionId}`,
      )
      activeController?.abort()
      endActiveRequest()
      // Tear down sticky upstream Codex/xAI sockets for this client session.
      const closed = closeUpstreamWebsocketSessionsByExecutionId(
        executionSessionId,
        "client_disconnect",
      )
      if (closed > 0) {
        logger.info(
          `responses websocket: closed ${closed} upstream session(s) for id=${executionSessionId}`,
        )
      }
    },

    onError() {
      activeController?.abort()
      endActiveRequest()
      closeUpstreamWebsocketSessionsByExecutionId(
        executionSessionId,
        "client_error",
      )
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
}

async function processResponseCreate(
  options: ProcessResponseCreateOptions,
): Promise<void> {
  const { c, ws, payload, signal, executionSessionId } = options
  let accountId: string | undefined
  let completedResponse: ResponsesResponse | undefined

  try {
    const result = await executeResponseCreate(
      c,
      payload,
      signal,
      executionSessionId,
    )
    accountId = result.accountId

    if (isNonStreaming(result.response)) {
      completedResponse = result.response
      sendJson(ws, result.response)
      return
    }

    completedResponse = await streamResponseEvents(ws, result.response)
  } catch (error) {
    handleResponseError(ws, error, signal)
    return
  } finally {
    if (completedResponse && accountId) {
      recordResponsesUsage({
        c,
        accountId,
        response: completedResponse,
      })
    }
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
    version: c.req.header("version"),
    originator: c.req.header("originator"),
    "x-grok-conv-id": c.req.header("x-grok-conv-id"),
    "x-claude-code-session-id": c.req.header("x-claude-code-session-id"),
    prompt_cache_key: c.req.header("prompt_cache_key"),
  }
}

async function executeResponseCreate(
  c: Context,
  payload: ResponsesPayload,
  signal: AbortSignal,
  executionSessionId: string,
): Promise<{
  accountId: string
  response: ResponsesResponse | AsyncIterable<CopilotStreamEventLike>
}> {
  const sessionHeaders = extractResponsesSessionHeaders(c)
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

  const result = await createResponses(payload, {
    signal,
    initiatorOverride: admission.initiator,
    account: admission.account,
    forwardedHeaders: sessionHeaders,
    c,
    downstreamWebsocket: true,
    executionSessionId,
  })
  c.set("accountId" as never, result.accountId)

  return result
}

async function streamResponseEvents(
  ws: WebSocketSendTarget,
  response: AsyncIterable<CopilotStreamEventLike>,
): Promise<ResponsesResponse | undefined> {
  let completedResponse: ResponsesResponse | undefined

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
      // Ignore parse errors - malformed JSON will be sent as-is
    }

    if (
      parsed?.type === "response.completed"
      && parsed.response
      && typeof parsed.response === "object"
    ) {
      completedResponse = parsed.response as ResponsesResponse
    }

    sendText(ws, event.data)
  }

  return completedResponse
}

function handleResponseError(
  ws: WebSocketSendTarget,
  error: unknown,
  signal: AbortSignal,
): void {
  if (isAbortError(error) && signal.aborted) {
    return
  }

  if (error instanceof ClientAbortError) {
    return
  }

  const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
  if (knownError) {
    sendJson(ws, {
      type: "error",
      error: {
        message: knownError.message,
        type: knownError.type,
        code: knownError.type,
        ...(knownError.retryAfterSeconds > 0 ?
          { retry_after: knownError.retryAfterSeconds }
        : {}),
      },
    })
    return
  }

  sendJson(ws, createResponsesErrorPayload(error))
}

function sendError(
  ws: WebSocketSendTarget,
  message: string,
  code?: string,
): void {
  sendJson(ws, {
    type: "error",
    error: {
      message,
      type: "error",
      ...(code ? { code } : {}),
    },
  })
}

function sendJson(ws: WebSocketSendTarget, payload: unknown): void {
  sendText(ws, JSON.stringify(payload))
}

function sendText(ws: WebSocketSendTarget, payload: string): void {
  if (ws.readyState !== WS_READY_STATE_OPEN) {
    return
  }

  try {
    ws.send(payload)
  } catch {
    // Ignore send errors - connection may be closing
  }
}
