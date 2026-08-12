import type {
  CopilotStreamEventLike,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { ClientAbortError } from "~/lib/request-lifecycle"

import {
  TERMINAL_RESPONSE_TYPES,
  hasResponsesOutput,
  isResponsesOutputEvent,
} from "./logging"

/** Bounded buffer caps: overflow flushes + commits rather than buffering
 * unbounded, trading a tiny failover window for a memory guarantee. */
const MAX_BUFFERED_EVENTS = 32
const MAX_BUFFERED_BYTES = 64 * 1024

export interface PumpHooks {
  /** Fired synchronously on the first successful forward to the client. */
  onCommit: () => void
}

export async function pumpWithLeadingBuffer(
  ws: WebSocketSendTarget,
  response: AsyncIterable<CopilotStreamEventLike>,
  hooks: PumpHooks,
): Promise<{
  completedResponse?: ResponsesResponse
  terminal: string
  outputObserved: boolean
  /** Wall-clock ms when the first output event was observed (TTFT). */
  firstContentAt?: number
}> {
  let completedResponse: ResponsesResponse | undefined
  let sawTerminal = false
  let terminal = "error"
  let outputObserved = false
  let firstContentAt: number | undefined
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

  const markOutputObserved = () => {
    outputObserved = true
    firstContentAt ??= Date.now()
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

    const type = typeof parsed?.type === "string" ? parsed.type : undefined
    const meaningfulOutput = parsed ? isResponsesOutputEvent(parsed) : false
    if (type && TERMINAL_RESPONSE_TYPES.has(type)) {
      sawTerminal = true
      terminal = type
      if (parsed?.response && typeof parsed.response === "object") {
        const terminalResponse = parsed.response as ResponsesResponse
        completedResponse = terminalResponse
        if (hasResponsesOutput(terminalResponse)) markOutputObserved()
      }
    }
    if (type && !TERMINAL_RESPONSE_TYPES.has(type) && meaningfulOutput)
      markOutputObserved()

    // Keep every non-output lifecycle frame buffered until the first
    // meaningful output or a terminal event. Codex commonly emits empty
    // output_item/content_part scaffolding before any text. Forwarding that
    // scaffolding would commit the downstream turn and prevent the caller
    // from recovering a subsequent upstream socket drop over HTTP.
    if (
      !state.committed
      && type !== undefined
      && !TERMINAL_RESPONSE_TYPES.has(type)
      && !meaningfulOutput
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

    // First meaningful output / terminal → include it in the flush and
    // commit. A malformed or untyped frame is conservatively committed because
    // it may already be user-visible content.
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

  return { completedResponse, terminal, outputObserved, firstContentAt }
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

/**
 * Returns true only when the payload was actually handed to `ws.send()`.
 * The pump uses this so onCommit() fires on a real successful send: if the
 * client socket is gone the first flush returns false and is treated as abort.
 */
export async function sendText(
  ws: WebSocketSendTarget,
  payload: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isSocketOpen(ws) || signal?.aborted) {
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

    // The signal can flip after the backpressure loop exits. Recheck at the
    // actual send boundary so an aborted turn never queues a late frame.
    if (!isSocketOpen(ws) || signal?.aborted) return false
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
