import { describe, expect, test } from "bun:test"

import { isLlmRequest, shouldDumpRequest } from "~/lib/llm-request"
import {
  clearTraceBusForTest,
  publishTrace,
  recentTraces,
} from "~/lib/trace-bus"

describe("LLM request classification", () => {
  test.each([
    "/chat/completions",
    "/v1/chat/completions",
    "/v1/messages",
    "/responses",
    "/v1/responses",
    "/responses/compact",
    "/v1/responses/compact",
    "/v1beta/models/gemini-pro:generateContent",
    "/v1beta/models/gemini-pro:streamGenerateContent",
    "/v1beta/models/tunedModels/custom:generateContent",
  ])("keeps generation endpoint %s even before model admission", (path) => {
    expect(isLlmRequest({ method: "POST", path })).toBe(true)
  })

  test("keeps Responses WebSocket turns, not their GET handshake", () => {
    expect(isLlmRequest({ method: "WS", path: "/v1/responses" })).toBe(true)
    expect(isLlmRequest({ method: "GET", path: "/v1/responses" })).toBe(false)
    expect(
      isLlmRequest({ method: "POST", path: "/v1/messages/count_tokens" }),
    ).toBe(false)
  })

  test("trace publishers cannot inject non-generation records with a model", () => {
    clearTraceBusForTest()
    try {
      publishTrace(
        {
          requestId: "token-count",
          method: "POST",
          path: "/v1/messages/count_tokens",
          model: "claude-test",
        },
        "update",
      )
      publishTrace(
        {
          requestId: "models",
          method: "GET",
          path: "/v1/models",
          model: "fake-model",
        },
        "final",
      )
      expect(recentTraces()).toHaveLength(0)
    } finally {
      clearTraceBusForTest()
    }
  })
})

describe("request dump classification", () => {
  test.each([
    "/chat/completions",
    "/v1/chat/completions",
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/responses",
    "/v1/responses",
    "/responses/compact",
    "/v1/responses/compact",
    "/embeddings",
    "/v1/embeddings",
    "/v1beta/models/gemini-pro:generateContent",
    "/v1beta/models/gemini-pro:streamGenerateContent",
  ])("dumps the LLM endpoint %s", (path) => {
    expect(shouldDumpRequest({ method: "POST", path })).toBe(true)
  })

  /**
   * The drift this shared table exists to prevent: if the dump set ever stops
   * covering a wire the trace set covers, a request shows up in the log with
   * no matching dump, which is exactly when the dump is wanted.
   */
  test("dump set is a superset of the trace set", () => {
    for (const path of [
      "/chat/completions",
      "/v1/chat/completions",
      "/v1/messages",
      "/responses",
      "/v1/responses",
      "/responses/compact",
      "/v1/responses/compact",
      "/v1beta/models/gemini-pro:generateContent",
      "/v1beta/models/gemini-pro:streamGenerateContent",
    ]) {
      expect(isLlmRequest({ method: "POST", path })).toBe(true)
      expect(shouldDumpRequest({ method: "POST", path })).toBe(true)
    }
  })

  test("matches paths exactly instead of by prefix", () => {
    // A traversal used to satisfy `startsWith("/v1/chat/completions/")`.
    expect(
      shouldDumpRequest({
        method: "POST",
        path: "/v1/chat/completions/../../.env",
      }),
    ).toBe(false)
    expect(
      shouldDumpRequest({ method: "POST", path: "/v1/chat/completions/x" }),
    ).toBe(false)
    expect(shouldDumpRequest({ method: "POST", path: "/admin/api/logs" })).toBe(
      false,
    )
  })

  test("only dumps methods that carry a body", () => {
    expect(shouldDumpRequest({ method: "GET", path: "/v1/responses" })).toBe(
      false,
    )
    expect(shouldDumpRequest({ method: "WS", path: "/v1/responses" })).toBe(
      false,
    )
    expect(shouldDumpRequest({ method: "PUT", path: "/v1/responses" })).toBe(
      true,
    )
  })
})
