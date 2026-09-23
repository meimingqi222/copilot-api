/**
 * Streamed error frames must carry a numeric, status-like code so downstream
 * one-shot clients can classify a 200-streamed upstream failure as retryable.
 *
 * Background: providers such as CodeBuddy force `stream: true` and can return
 * HTTP 200 followed by an inline error body. Once copilot-api has committed
 * its own SSE response the failure cannot be surfaced as an HTTP status —
 * only as an in-stream error frame. ZCode reads `event: error` frames and maps
 * `code`/`status_code` into a 400–599 status (`>=500` ⇒ retryable); opencode
 * reads `error.code` as an HTTP status. A frame carrying only
 * `message`/`type` is classified as a non-retryable generic error by both.
 *
 * Dispatch now runs BEFORE the downstream SSE response is committed, so a
 * failure that arrives before the first chunk surfaces as a real HTTP status
 * (+ Retry-After headers) instead of `200 + event: error`. The error-frame
 * contract below still applies to failures that arrive MID-stream, after the
 * 200 is already committed.
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

  test("upstream 500 before the first chunk surfaces a real HTTP 500", async () => {
    // Dispatch runs before the downstream SSE response is committed, so a
    // pre-first-chunk failure keeps its HTTP status (previously this was
    // `200 + event: error`, which hid the status from header-reading clients).
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

    expect(response.status).toBe(500)
    const body = (await response.json()) as { code: number }
    expect(body.code).toBe(11134)
  })

  test("upstream 429 with Retry-After before the first chunk keeps status and headers", async () => {
    // The stepfun concurrency case: `429 concurrency reached` + Retry-After.
    // Header-reading clients (opencode/ZCode) need the real 429 + Retry-After
    // to back off for the full window; `200 + event: error` carried neither.
    const fetchMock = mock(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: "concurrency reached, current: 6, limit: 5",
              type: "rate_limited",
            },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "Retry-After": "60",
            },
          },
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

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
    expect(response.headers.get("retry-after-ms")).not.toBeNull()
    const body = (await response.json()) as {
      error: { message: string; type: string }
    }
    expect(body.error.message).toContain("concurrency reached")
  })

  test("mid-stream failure still emits a retryable error frame on the committed 200", async () => {
    // First chunk is fine (commits the downstream 200), the second chunk is
    // garbage: the failure can only travel inside the stream now.
    const fetchMock = mock(
      () =>
        new Response(
          'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: not-json\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
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

  test("CodeBuddy-style 400 surfaces the upstream overflow wording with a real 400", async () => {
    // CodeBuddy reports context overflows as HTTP 400 with a non-OpenAI
    // body shape (`code`/`msg`/`extError`). The failure now keeps its HTTP
    // status and the upstream wording passes through untouched: downstream
    // classifiers key overflow recovery off status 400 + `/prompt is too
    // long/i` / `context_length_exceeded`, which all survive here.
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

    expect(response.status).toBe(400)
    const body = (await response.json()) as { msg: string }
    expect(body.msg).toContain("prompt is too long")
  })
})

describe("messages/responses streamed pre-first-chunk failures (integration)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    statsStore.clearUsageStatsForTest()
    resetProtectedRouteGuardForTest()
    __resetProviderConnectionsForTest()
    await createConnection({
      id: "stream-err-conn",
      name: "stream-err",
      protocol: "openai-compatible",
      baseUrl: "https://upstream.test/v1",
      credentials: [{ id: "cred-1", value: "sk-test", authMode: "bearer" }],
      models: [
        {
          publicId: "stream-err-model",
          upstreamId: "stream-err-model",
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

  function mockConcurrency429() {
    globalThis.fetch = mock(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: "concurrency reached, current: 6, limit: 5",
              type: "rate_limited",
            },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "Retry-After": "60",
            },
          },
        ),
    ) as unknown as typeof fetch
  }

  test("messages streaming keeps 429 + Retry-After with an Anthropic body", async () => {
    mockConcurrency429()

    const response = await server.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "stream-err-model",
          stream: true,
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
    const body = (await response.json()) as {
      type: string
      error: { type: string; message: string }
    }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("rate_limit_error")
  })

  test("responses streaming keeps 429 + Retry-After", async () => {
    mockConcurrency429()

    const response = await server.fetch(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "stream-err-model",
          input: "hi",
          stream: true,
        }),
      }),
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
    const body = (await response.json()) as {
      error: { message: string }
    }
    expect(body.error.message).toContain("concurrency reached")
  })
})
