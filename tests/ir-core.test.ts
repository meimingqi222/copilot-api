import { describe, expect, test } from "bun:test"

import {
  getTranslationLossMetricsSnapshot,
  getTranslationLossesForContext,
  inspectRequestFeatures,
  planTranslation,
  recordTranslationLossesForContext,
  resetTranslationLossMetricsForTest,
} from "~/services/ir"
import type { RequestIR } from "~/services/ir"
import {
  createDetachedRequestLog,
  finalizeRequestLogContext,
} from "~/lib/request-log"

const source = { wire: "responses" as const, issuer: "provider-a" }

function request(turns: RequestIR["turns"]): RequestIR {
  return { model: "test-model", source, instructions: [], turns }
}

describe("translation IR preflight", () => {
  test("detects tool-result image and plans the Chat placement transform", () => {
    const input = request([
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: "call-1",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://example.com/image.png" },
              },
            ],
          },
        ],
      },
    ])
    expect(inspectRequestFeatures(input)).toContainEqual({
      kind: "tool_result_image",
      path: "turns[0].parts[0].content[0]",
      current: true,
    })
    const plan = planTranslation(input, { wire: "chat" })
    expect(plan.accepted).toBe(true)
    expect(plan.losses.records).toContainEqual(
      expect.objectContaining({
        feature: "tool_result_image",
        action: "transform",
      }),
    )
  })

  test("rejects a file ID without a matching issuer", () => {
    const input = request([
      {
        role: "user",
        parts: [
          {
            type: "file",
            source: { type: "file_id", fileId: "file-1", issuer: "provider-a" },
          },
        ],
      },
    ])
    expect(planTranslation(input, { wire: "chat" }).accepted).toBe(false)
    expect(
      planTranslation(input, { wire: "responses", issuer: "provider-b" })
        .accepted,
    ).toBe(false)
    expect(
      planTranslation(input, { wire: "responses", issuer: "provider-a" })
        .accepted,
    ).toBe(true)
  })

  test("rejects a URL file sent to a wire without a file representation", () => {
    const input = request([
      {
        role: "user",
        parts: [
          {
            type: "file",
            source: { type: "url", url: "https://example.com/document.pdf" },
          },
        ],
      },
    ])
    expect(planTranslation(input, { wire: "chat" }).accepted).toBe(false)
    expect(planTranslation(input, { wire: "messages" }).accepted).toBe(false)
    expect(planTranslation(input, { wire: "responses" }).accepted).toBe(true)
  })

  test("detects a namespace collision using the final outgoing tool name", () => {
    const input = {
      ...request([]),
      tools: [
        { name: "web__search", parameters: {} },
        {
          name: "web__search",
          namespace: "web",
          originalName: "search",
          parameters: {},
        },
      ],
    }
    expect(
      planTranslation(input, { wire: "chat" }).losses.records,
    ).toContainEqual(
      expect.objectContaining({
        feature: "namespace_tool",
        action: "reject",
      }),
    )
  })

  test("reports effort mapping instead of silently accepting a lower level", () => {
    const input = {
      ...request([]),
      generation: { reasoning: { effort: "max" as const } },
    }
    const messages = planTranslation(input, { wire: "messages" })
    expect(messages.accepted).toBe(true)
    expect(messages.losses.records).toContainEqual(
      expect.objectContaining({
        feature: "reasoning_effort",
        action: "transform",
      }),
    )
    expect(planTranslation(input, { wire: "responses" }).accepted).toBe(false)
  })

  test("keeps unknown-issuer signatures for target validation but rejects changed text", () => {
    const signed = request([
      {
        role: "assistant",
        parts: [
          {
            type: "thinking",
            text: "original",
            signedText: "original",
            signature: "opaque-signature",
            source: { wire: "messages" },
          },
        ],
      },
    ])
    expect(
      planTranslation(signed, { wire: "messages", issuer: "provider-b" })
        .accepted,
    ).toBe(true)
    expect(
      planTranslation(signed, { wire: "messages", issuer: "provider-b" }).losses
        .records,
    ).toEqual([])

    signed.turns[0]!.parts[0] = {
      type: "thinking",
      text: "modified",
      signedText: "original",
      signature: "opaque-signature",
      source: { wire: "messages" },
    }
    expect(
      planTranslation(signed, { wire: "messages", issuer: "provider-b" }).losses
        .records,
    ).toContainEqual(
      expect.objectContaining({
        feature: "signed_thinking",
        action: "drop",
      }),
    )
  })

  test("rejects an empty required allowed-tools set", () => {
    const input = {
      ...request([]),
      tools: [],
      toolChoice: {
        type: "allowed" as const,
        mode: "required" as const,
        names: [],
      },
    }
    expect(planTranslation(input, { wire: "responses" }).accepted).toBe(false)
  })

  test("allows a required subset of multiple tools only where the encoder enforces it", () => {
    const input: RequestIR = {
      ...request([]),
      tools: [
        { name: "one", parameters: {} },
        { name: "two", parameters: {} },
        { name: "three", parameters: {} },
      ],
      toolChoice: { type: "allowed", mode: "required", names: ["one", "two"] },
    }
    const chatPlan = planTranslation(input, { wire: "chat" })
    expect(chatPlan.accepted).toBe(true)
    expect(chatPlan.losses.records).toContainEqual(
      expect.objectContaining({
        feature: "allowed_tools",
        action: "transform",
      }),
    )
    expect(planTranslation(input, { wire: "messages" }).accepted).toBe(false)
  })
})

describe("IR loss logging", () => {
  test("keeps only structural metadata outside the public request log entry", () => {
    resetTranslationLossMetricsForTest()
    const ctx = createDetachedRequestLog()
    const report = {
      records: [
        {
          path: "turns[0].parts[0].password=my-secret",
          feature: "my-secret",
          action: "reject" as const,
          reason: "my-secret",
          target: "chat" as const,
          stage: "preflight" as const,
        },
      ],
    }
    recordTranslationLossesForContext(ctx, report)
    recordTranslationLossesForContext(ctx, report)
    expect(getTranslationLossesForContext(ctx)).toEqual([
      {
        path: "unknown",
        feature: "unknown",
        action: "reject",
        reason: "unspecified",
        target: "chat",
        stage: "preflight",
      },
    ])
    expect(getTranslationLossMetricsSnapshot()).toEqual([
      {
        feature: "unknown",
        action: "reject",
        reason: "unspecified",
        target: "chat",
        count: 1,
      },
    ])
    const entry = finalizeRequestLogContext(ctx, 400, {
      method: "POST",
      path: "/v1/chat/completions",
    })
    expect(JSON.stringify(entry)).not.toContain("my-secret")
    expect(Object.keys(entry)).not.toContain("translationLosses")
    expect(getTranslationLossesForContext(ctx)).toEqual([])
  })
})
