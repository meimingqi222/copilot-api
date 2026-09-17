/**
 * Streamed error frames must carry a numeric, status-like code so downstream
 * one-shot clients can classify a 200-streamed upstream failure as retryable.
 *
 * Background: providers such as CodeBuddy force `stream: true` and can return
 * HTTP 200 followed by an inline error body. copilot-api already committed the
 * SSE response by then, so the failure cannot be surfaced as an HTTP status —
 * only as an in-stream error frame. ZCode reads `event: error` frames and maps
 * `code`/`status_code` into a 400–599 status (`>=500` ⇒ retryable); opencode
 * reads `error.code` as an HTTP status. A frame carrying only
 * `message`/`type` is classified as a non-retryable generic error by both.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import {
  extractUpstreamErrorMessage,
  resolveRetryableCode,
} from "~/lib/error-builder"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"
import { createResponsesErrorPayload } from "~/routes/responses/handler"
import { server } from "~/server"
import { translateErrorToAnthropicErrorEvent } from "~/services/protocols/anthropic"

const jsonError = (status: number, body: unknown) =>
  new HTTPError(
    "upstream failed",
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
    JSON.stringify(body),
  )

describe("resolveRetryableCode", () => {
  test("reuses a real upstream HTTP status in the 4xx–5xx range", () => {
    expect(resolveRetryableCode(jsonError(500, { error: {} }))).toBe(500)
    expect(resolveRetryableCode(jsonError(429, { error: {} }))).toBe(429)
    expect(resolveRetryableCode(jsonError(400, { error: {} }))).toBe(400)
  })

  test("falls back to 500 for non-HTTP failures", () => {
    // A bare Error has no status at all — retryable is the safe default.
    expect(resolveRetryableCode(new Error("boom"))).toBe(500)
    expect(resolveRetryableCode(undefined)).toBe(500)
  })

  test("normalizes out-of-range statuses to 500", () => {
    // A provider code is not a valid HTTP status, so it must not leak through
    // as-is (clients only accept 400–599).
    expect(resolveRetryableCode(jsonError(200, { error: {} }))).toBe(500)
  })
})

describe("extractUpstreamErrorMessage", () => {
  test("prefers CodeBuddy extError.message", () => {
    expect(
      extractUpstreamErrorMessage(
        jsonError(400, {
          code: 11115,
          msg: "prompt is too long: 1522332 tokens > 1048576 maximum",
          extError: {
            code: "context_length_exceeded",
            message: "prompt is too long: 1522332 tokens > 1048576 maximum",
          },
        }),
      ),
    ).toBe("prompt is too long: 1522332 tokens > 1048576 maximum")
  })

  test("falls back to msg, then displayMsg.en", () => {
    expect(
      extractUpstreamErrorMessage(jsonError(400, { code: 11115, msg: "oops" })),
    ).toBe("oops")
    expect(
      extractUpstreamErrorMessage(
        jsonError(400, { displayMsg: { en: "limit hit" } }),
      ),
    ).toBe("limit hit")
  })

  test("reads OpenAI-shaped error.message", () => {
    expect(
      extractUpstreamErrorMessage(
        jsonError(400, { error: { message: "bad request" } }),
      ),
    ).toBe("bad request")
  })

  test("keeps the adapter message for non-JSON and unknown-shape bodies", () => {
    const plain = new HTTPError(
      "Failed to create chat completions",
      new Response("nope", { status: 400 }),
      "not json",
    )
    expect(extractUpstreamErrorMessage(plain)).toBe(
      "Failed to create chat completions",
    )
    expect(extractUpstreamErrorMessage(jsonError(400, { code: 11115 }))).toBe(
      "upstream failed",
    )
  })

  test("passes through plain errors", () => {
    expect(extractUpstreamErrorMessage(new Error("boom"))).toBe("boom")
    expect(extractUpstreamErrorMessage(undefined)).toBe("Internal server error")
  })
})

describe("translateErrorToAnthropicErrorEvent", () => {
  test("carries a numeric code and status for a 5xx upstream failure", () => {
    const event = translateErrorToAnthropicErrorEvent(
      jsonError(500, { error: { message: "provider unavailable" } }),
    )
    expect(event).toMatchObject({
      type: "error",
      error: { type: "api_error", code: 500, status: 500 },
    })
  })

  test("maps 429 to rate_limit_error", () => {
    const event = translateErrorToAnthropicErrorEvent(
      jsonError(429, { error: { message: "slow down" } }),
    )
    expect(event).toMatchObject({
      type: "error",
      error: { type: "rate_limit_error", code: 429, status: 429 },
    })
  })

  test("a stream ending without an error still yields a retryable 500", () => {
    // Used for "upstream closed the stream before finish_reason", which is an
    // incomplete stream and must be retryable.
    const event = translateErrorToAnthropicErrorEvent()
    expect(event).toMatchObject({
      type: "error",
      error: { code: 500, status: 500 },
    })
  })
})

describe("createResponsesErrorPayload", () => {
  test("a plain 5xx carries a numeric code and the retryable flag", () => {
    const payload = createResponsesErrorPayload(
      jsonError(500, { error: { message: "provider unavailable" } }),
    )
    expect(payload.status).toBe(500)
    expect(payload.error).toMatchObject({ code: 500, retryable: true })
  })

  test("a 4xx stays non-retryable", () => {
    const payload = createResponsesErrorPayload(
      jsonError(400, { error: { message: "bad request" } }),
    )
    expect(payload.error).not.toHaveProperty("retryable")
  })

  test("preserves an upstream structured code and explicit retryable", () => {
    const payload = createResponsesErrorPayload(
      jsonError(400, {
        error: { code: "provider_busy", message: "busy", retryable: true },
      }),
    )
    expect(payload.error).toMatchObject({
      code: "provider_busy",
      retryable: true,
    })
  })
})

describe("chat-completions streamed error frame (integration)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    statsStore.clearUsageStatsForTest()
    resetProtectedRouteGuardForTest()
    __resetProviderConnectionsForTest()
    await createConnection({
      id: "chat-stream-conn",
      name: "chat-stream",
      protocol: "openai-compatible",
      baseUrl: "https://upstream.test/v1",
      credentials: [{ id: "cred-1", value: "sk-test", authMode: "bearer" }],
      models: [
        {
          publicId: "deepseek-v4.1-flash",
          upstreamId: "deepseek-v4.1-flash",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    })
  })

  afterEach(() => {
    statsStore.clearUsageStatsForTest()
    globalThis.fetch = originalFetch
    __resetProviderConnectionsForTest()
  })

  test("upstream 500 after a 200 stream commit emits a retryable error frame", async () => {
    // The upstream rejects before any SSE data, exactly like CodeBuddy's
    // `code: 11134` provider_unavailable response.
    const fetchMock = mock(
      () =>
        new Response(
          JSON.stringify({
            code: 11134,
            msg: "the model provider is temporarily unavailable",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )

    // Once the SSE response is committed the status is always 200; the failure
    // has to travel inside the stream.
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("event: error")

    const frame = text
      .split("\n")
      .find((line) => line.startsWith("data: ") && line.includes('"code"'))
    expect(frame).toBeDefined()
    const payload = JSON.parse((frame as string).slice("data: ".length)) as {
      error: { code: number; status: number }
    }
    // `>=500` is what makes ZCode/opencode treat it as retryable.
    expect(payload.error.code).toBe(500)
    expect(payload.error.status).toBe(500)
  })

  test("CodeBuddy-style 400 surfaces the upstream overflow wording in the error frame", async () => {
    // CodeBuddy reports context overflows as HTTP 400 with a non-OpenAI
    // body shape (`code`/`msg`/`extError`). The streamed error frame must
    // carry that wording: downstream classifiers key overflow recovery off
    // `/prompt is too long/i` / `context_length_exceeded`, and a generic
    // adapter message degrades the failure to request_rejected, so no
    // compaction or image-omission recovery ever runs.
    const overflowBody = {
      code: 11115,
      msg: "prompt is too long: 1522332 tokens > 1048576 maximum",
      requestId: "test-request-id-11115",
      extError: {
        code: "context_length_exceeded",
        message: "prompt is too long: 1522332 tokens > 1048576 maximum",
        param: "",
        type: "invalid_request_error",
        StatusCode: 400,
      },
      displayMsg: {
        en: "The request exceeds the model context limit. Please shorten the conversation or remove attachments.",
        zh: "对话内容超出模型长度上限，请精简对话或减少附件后重试。",
      },
    }
    const fetchMock = mock(
      () =>
        new Response(JSON.stringify(overflowBody), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("event: error")

    const frame = text
      .split("\n")
      .find((line) => line.startsWith("data: ") && line.includes('"error"'))
    expect(frame).toBeDefined()
    const payload = JSON.parse((frame as string).slice("data: ".length)) as {
      error: { message: string; code: number; status: number }
    }
    expect(payload.error.message).toContain("prompt is too long")
    // Numeric status-like code is preserved: 400 stays non-retryable
    // (overflow recovery compacts instead of retrying).
    expect(payload.error.code).toBe(400)
    expect(payload.error.status).toBe(400)
  })
})
