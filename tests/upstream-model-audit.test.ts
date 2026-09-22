import { describe, expect, test } from "bun:test"

import {
  canonicalRuntimeModelAlias,
  compareUpstreamModels,
  createUpstreamModelObservation,
  extractResponseModel,
  isTerminalResponseEvent,
  normalizeModelForAudit,
  observedResponseModel,
  observeUpstreamModel,
  upstreamResponseSelfReportsModel,
} from "~/lib/upstream-model-audit"

describe("extractResponseModel", () => {
  test("reads OpenAI Responses and Chat Completions shapes", () => {
    expect(extractResponseModel({ response: { model: "gpt-5.5" } })).toBe(
      "gpt-5.5",
    )
    expect(extractResponseModel({ model: "gpt-5.4" })).toBe("gpt-5.4")
  })

  test("reads Anthropic message shape", () => {
    expect(
      extractResponseModel({
        type: "message_start",
        message: { model: "claude-sonnet-4-20250514" },
      }),
    ).toBe("claude-sonnet-4-20250514")
  })

  test("reads Gemini modelVersion, including the antigravity wrapper", () => {
    expect(extractResponseModel({ modelVersion: "gemini-2.5-pro" })).toBe(
      "gemini-2.5-pro",
    )
    expect(
      extractResponseModel({ response: { modelVersion: "gemini-2.5-pro" } }),
    ).toBe("gemini-2.5-pro")
    expect(
      extractResponseModel({
        response: { response: { modelVersion: "gemini-inner" } },
      }),
    ).toBe("gemini-inner")
  })

  test("prefers the outer declaration when both are present", () => {
    expect(
      extractResponseModel({
        modelVersion: "gemini-outer",
        response: { modelVersion: "gemini-inner" },
      }),
    ).toBe("gemini-outer")
    expect(
      extractResponseModel({
        model: "outer-model",
        response: { model: "inner-model" },
      }),
    ).toBe("outer-model")
  })

  test("returns undefined for absent, blank, or malformed declarations", () => {
    expect(extractResponseModel({})).toBeUndefined()
    expect(extractResponseModel({ model: "" })).toBeUndefined()
    expect(extractResponseModel({ model: "   " })).toBeUndefined()
    expect(extractResponseModel({ model: 42 })).toBeUndefined()
    expect(extractResponseModel({ model: null })).toBeUndefined()
    expect(extractResponseModel(null)).toBeUndefined()
    expect(extractResponseModel("gpt-5.5")).toBeUndefined()
    expect(extractResponseModel([{ model: "gpt-5.5" }])).toBeUndefined()
  })
})

describe("isTerminalResponseEvent", () => {
  test("recognizes terminal OpenAI/Anthropic events", () => {
    for (const type of [
      "response.completed",
      "response.done",
      "response.failed",
      "response.incomplete",
      "response.cancelled",
      "response.canceled",
      "message_stop",
    ]) {
      expect(isTerminalResponseEvent(type, { type })).toBe(true)
    }
  })

  test("treats non-terminal and typeless payloads correctly", () => {
    expect(
      isTerminalResponseEvent("response.created", { type: "response.created" }),
    ).toBe(false)
    expect(
      isTerminalResponseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
      }),
    ).toBe(false)
    // Typeless = non-stream body or a Gemini chunk: treated as terminal.
    expect(isTerminalResponseEvent(undefined, { model: "gpt-5.5" })).toBe(true)
    expect(isTerminalResponseEvent(undefined, {})).toBe(true)
  })

  /**
   * Real Copilot Responses SSE frames carry the type in the JSON body and NO
   * `event:` line, so `fetch-event-stream` never populates `event.event` and
   * the observer receives eventType === undefined. Falling back to the body
   * `type` is what keeps `response.completed` authoritative — without it the
   * audit would keep the requested-model echo from `response.created`.
   */
  test("falls back to the body type when the SSE event name is absent", () => {
    const created = { type: "response.created", response: { model: "echo" } }
    const completed = {
      type: "response.completed",
      response: { model: "actual" },
    }

    expect(isTerminalResponseEvent(undefined, created)).toBe(false)
    expect(isTerminalResponseEvent(undefined, completed)).toBe(true)

    const observation = createUpstreamModelObservation()
    for (const payload of [created, completed]) {
      observeUpstreamModel(
        observation,
        extractResponseModel(payload),
        isTerminalResponseEvent(undefined, payload),
      )
    }
    expect(observedResponseModel(observation)).toBe("actual")
  })

  test("an explicit event name still takes precedence over the body type", () => {
    // A frame mislabelled as non-terminal must not be promoted by its body.
    expect(
      isTerminalResponseEvent("response.created", {
        type: "response.completed",
      }),
    ).toBe(false)
  })
})

describe("observeUpstreamModel", () => {
  test("terminal declaration wins over an earlier one and records conflict", () => {
    const observation = createUpstreamModelObservation()
    observeUpstreamModel(observation, "gpt-5.5", false)
    observeUpstreamModel(observation, "gpt-5.4", true)

    expect(observedResponseModel(observation)).toBe("gpt-5.4")
    expect(observation.conflict).toBe(true)
  })

  test("keeps the first declaration when it is repeated", () => {
    const observation = createUpstreamModelObservation()
    observeUpstreamModel(observation, "gpt-5.5", false)
    observeUpstreamModel(observation, "GPT-5.5", false)

    expect(observedResponseModel(observation)).toBe("gpt-5.5")
    expect(observation.conflict).toBe(false)
  })

  test("ignores empty declarations and bounds untrusted names", () => {
    const observation = createUpstreamModelObservation()
    observeUpstreamModel(observation, "  ", false)
    observeUpstreamModel(observation, undefined, false)
    expect(observedResponseModel(observation)).toBeUndefined()

    observeUpstreamModel(observation, "x".repeat(500), false)
    expect(observedResponseModel(observation)?.length).toBe(200)
  })

  test("returns undefined when nothing was observed", () => {
    expect(observedResponseModel(undefined)).toBeUndefined()
    expect(
      observedResponseModel(createUpstreamModelObservation()),
    ).toBeUndefined()
  })
})

describe("upstreamResponseSelfReportsModel", () => {
  test("excludes protocols whose response model is a local echo", () => {
    expect(upstreamResponseSelfReportsModel("windsurf-native")).toBe(false)
  })

  test("treats every other protocol as self-reporting", () => {
    expect(upstreamResponseSelfReportsModel("copilot-native")).toBe(true)
    expect(upstreamResponseSelfReportsModel("openai-compatible")).toBe(true)
    expect(upstreamResponseSelfReportsModel("anthropic-compatible")).toBe(true)
    expect(upstreamResponseSelfReportsModel(undefined)).toBe(true)
  })
})

describe("compareUpstreamModels", () => {
  test("is case-insensitive and ignores provider path prefixes", () => {
    expect(compareUpstreamModels("gpt-5.5", "GPT-5.5")).toBe("match")
    expect(compareUpstreamModels("openai/gpt-5.5", "gpt-5.5")).toBe("match")
    expect(compareUpstreamModels("gpt-5.5", "OPENAI/GPT-5.5")).toBe("match")
  })

  test("ignores reasoning-effort suffixes and date snapshots", () => {
    expect(compareUpstreamModels("gpt-5.5(high)", "gpt-5.5")).toBe("match")
    expect(
      compareUpstreamModels("claude-sonnet-4-20250514", "claude-sonnet-4"),
    ).toBe("variant")
    expect(compareUpstreamModels("gpt-5.5", "gpt-5.5-latest")).toBe("variant")
    expect(compareUpstreamModels("gpt-5.5", "gpt-5.5-20260101")).toBe("variant")
  })

  test("treats xAI grok runtime build ids as the same model", () => {
    expect(compareUpstreamModels("grok-4.6", "grok-4.6-build")).toBe("match")
    expect(compareUpstreamModels("grok-4.5-latest", "grok-4.5-build")).toBe(
      "match",
    )
    expect(compareUpstreamModels("grok-4.5", "GROK-4.5-BUILD")).toBe("match")
    expect(canonicalRuntimeModelAlias("grok-4.6-build")).toBe("grok-4.6-build")
    expect(canonicalRuntimeModelAlias("gpt-5.5")).toBeUndefined()
  })

  test("does not collapse genuinely different models", () => {
    expect(compareUpstreamModels("gpt-5.6-sol", "gpt-5.4")).toBe("mismatch")
    expect(compareUpstreamModels("gpt-5.5", "gpt-5.5-build")).toBe("mismatch")
    expect(compareUpstreamModels("grok-4.5", "grok-4.6-build")).toBe("mismatch")
    expect(compareUpstreamModels("claude-opus-4", "claude-sonnet-4")).toBe(
      "mismatch",
    )
  })

  test("normalization only strips suffixes that cannot change identity", () => {
    expect(normalizeModelForAudit("OpenAI/GPT-5.5(low)")).toBe("gpt-5.5")
    expect(normalizeModelForAudit("gpt-5.5-build")).toBe("gpt-5.5-build")
  })
})
