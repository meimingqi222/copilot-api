import { describe, expect, test } from "bun:test"

import { isLlmRequest } from "~/lib/llm-request"
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
