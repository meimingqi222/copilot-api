import { expect, test } from "bun:test"
import { z } from "zod"

import { HTTPError } from "~/lib/error"
import { RedactionError } from "~/lib/redaction/context"
import { handleResponseError, sendError } from "~/routes/responses/ws-error"
import type { WebSocketSendTarget } from "~/routes/responses/ws-pump"

// Codex WrappedWebsocketErrorEvent: status is u16 and code/message are Option<String>.
const codexErrorFrame = z.object({
  type: z.literal("error"),
  status: z.number().int().min(400).max(599),
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
  },
)

test("WebSocket errors preserve upstream string codes and retry advice", async () => {
  const { ws, frames } = socketCapture()
  await handleResponseError(
    ws,
    new HTTPError(
      "busy",
      new Response(null, { status: 503 }),
      JSON.stringify({
        error: { code: "provider_busy", message: "try later", retryable: true },
      }),
    ),
    new AbortController().signal,
  )
  const frame = codexErrorFrame.parse(JSON.parse(frames[0]))
  expect(frame.error.code).toBe("provider_busy")
  expect(JSON.parse(frames[0]).error.retryable).toBe(true)
})

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
