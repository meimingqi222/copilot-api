import { expect, test } from "bun:test"
import { z } from "zod"

import { HTTPError } from "~/lib/error"
import { RedactionError } from "~/lib/redaction/context"
import { RouteRateLimitError } from "~/lib/request-lifecycle"
import { handleResponseError, sendError } from "~/routes/responses/ws-error"
import type { WebSocketSendTarget } from "~/routes/responses/ws-pump"

// Codex WrappedWebsocketErrorEvent: status is u16 and code/message are Option<String>.
const codexErrorFrame = z.object({
  type: z.literal("error"),
  status: z.number().int().min(400).max(599),
  headers: z.record(z.string(), z.string()).optional(),
  error: z.object({
    code: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
  }),
})

function socketCapture(): { ws: WebSocketSendTarget; frames: Array<string> } {
  const frames: Array<string> = []
  return {
    frames,
    ws: {
      readyState: 1,
      send(payload) {
        frames.push(String(payload))
        return 1
      },
      getBufferedAmount: () => 0,
    },
  }
}

test.each([422, 503])(
  "local redaction %i is immediately parseable by Codex",
  async (status) => {
    const { ws, frames } = socketCapture()
    await handleResponseError(
      ws,
      new RedactionError("redaction replay unavailable", status),
      new AbortController().signal,
    )
    expect(frames).toHaveLength(1)
    const frame = codexErrorFrame.parse(JSON.parse(frames[0]))
    expect(frame.status).toBe(status)
    expect(frame.error.code).toBe(String(status))
    expect(frame.error.message).toBe("redaction replay unavailable")
    expect(frame.headers).toBeUndefined()
  },
)

test.each([
  { status: 503, code: "server_error", retryAfter: "17" },
  { status: 429, code: "rate_limit_exceeded", retryAfter: "29" },
  {
    status: 503,
    code: "server_error",
    retryAfter: "Wed, 14 Oct 2026 12:00:00 GMT",
  },
  { status: 429, code: "insufficient_quota", retryAfter: "41" },
])(
  "WebSocket errors preserve upstream codes and Codex retry headers: %j",
  async ({ status, code, retryAfter }) => {
    const { ws, frames } = socketCapture()
    await handleResponseError(
      ws,
      new HTTPError(
        "busy",
        new Response(null, { status, headers: { "Retry-After": retryAfter } }),
        JSON.stringify({
          error: { code, message: "try later", retryable: true },
        }),
      ),
      new AbortController().signal,
    )
    const frame = codexErrorFrame.parse(JSON.parse(frames[0]))
    expect(frame.status).toBe(status)
    expect(frame.error.code).toBe(code)
    expect(frame.headers?.["Retry-After"]).toBe(retryAfter)
    expect(JSON.parse(frames[0]).error.retryable).toBe(true)
  },
)

test.each([0, 23])(
  "local rate limits expose a Codex retry header only when a delay is known (%i)",
  async (seconds) => {
    const { ws, frames } = socketCapture()
    await handleResponseError(
      ws,
      new RouteRateLimitError("wait for admission", seconds),
      new AbortController().signal,
    )
    const frame = codexErrorFrame.parse(JSON.parse(frames[0]))
    expect(frame.status).toBe(429)
    expect(frame.error.code).toBe("rate_limit_error")
    expect(frame.headers?.["Retry-After"]).toBe(
      seconds > 0 ? String(seconds) : undefined,
    )
    expect(JSON.parse(frames[0]).error.retry_after).toBe(
      seconds > 0 ? seconds : undefined,
    )
  },
)

test.each([
  { code: undefined, status: 400 },
  { code: "busy", status: 409 },
  { code: "request_too_large", status: 413 },
])(
  "local validation error %j carries a terminal status",
  async ({ code, status }) => {
    const { ws, frames } = socketCapture()
    await sendError(ws, "invalid request", code)
    const frame = codexErrorFrame.parse(JSON.parse(frames[0]))
    expect(frame.status).toBe(status)
    expect(frame.error.message).toBe("invalid request")
  },
)
