import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { parseMessage } from "~/services/windsurf/protobuf"
import {
  buildRequest,
  resolveSystemPrompt,
} from "~/services/windsurf/request-builders"
import { fingerprintWindsurfRequest } from "~/services/windsurf/request-fingerprint"

function decodeFramedPayload(framed: Uint8Array): Uint8Array {
  if (framed.length < 5) return framed
  const flags = framed[0]
  const payload = framed.subarray(5)
  if (flags === 1 || flags === 3) {
    return new Uint8Array(Bun.gunzipSync(Buffer.from(payload)))
  }
  return payload
}

function topLevelFields(payload: Uint8Array): Array<number> {
  return parseMessage(payload, 0, 6)
    .map((n) => n.field)
    .sort((a, b) => a - b)
}

function metadataFields(payload: Uint8Array): Array<number> {
  const meta = parseMessage(payload, 0, 6).find((n) => n.field === 1 && n.sub)
  return (meta?.sub ?? []).map((n) => n.field).sort((a, b) => a - b)
}

function assistantMessageFields(payload: Uint8Array): Array<number> {
  const message = parseMessage(payload, 0, 6).find(
    (n) => n.field === 3 && n.sub,
  )
  return (message?.sub ?? []).map((n) => n.field).sort((a, b) => a - b)
}

function assistantMessageId(payload: Uint8Array): string | undefined {
  const message = parseMessage(payload, 0, 6).find(
    (n) => n.field === 3 && n.sub,
  )
  const id = message?.sub?.find((n) => n.field === 1)
  return id?.raw ? new TextDecoder().decode(id.raw) : undefined
}

function messageNodeCount(payload: Uint8Array): number {
  return parseMessage(payload, 0, 6).filter((n) => n.field === 3 && n.sub)
    .length
}

/** Reads a string subfield off the first ChatMessagePrompt. */
function assistantMessageString(
  payload: Uint8Array,
  field: number,
): string | undefined {
  const message = parseMessage(payload, 0, 6).find(
    (n) => n.field === 3 && n.sub,
  )
  const node = message?.sub?.find((n) => n.field === field)
  return node?.raw ? new TextDecoder().decode(node.raw) : undefined
}

describe("Windsurf proto — buildRequest fingerprint", () => {
  const basePayload: ChatCompletionsPayload = {
    model: "swe-1-6",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    stream: true,
  }

  test("produces oh-my-pi aligned top-level and metadata fields", () => {
    const built = buildRequest({
      payload: basePayload,
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
      promptId: "b0f93684-49e4-4b6a-b5ed-02242d37b9ba",
    })

    const builtPayload = decodeFramedPayload(built)
    const top = topLevelFields(builtPayload)
    const meta = metadataFields(builtPayload)
    const fp = fingerprintWindsurfRequest(built)

    expect(top).toEqual([1, 2, 3, 7, 8, 10, 11, 12, 13, 16, 17, 20, 21, 22])
    expect(meta).toEqual([1, 2, 3, 4, 7, 12])

    expect(fp.requestType).toBe(5) // CASCADE
    expect(fp.plannerMode).toBe(1) // DEFAULT
    expect(fp.model).toBe("MODEL_PRIVATE_11")
    expect(fp.cascadeId).toBe("cc232f62-2495-407a-bd78-502af5ece433")
    expect(fp.promptId).toBe("b0f93684-49e4-4b6a-b5ed-02242d37b9ba")
    expect(fp.executionId).toBeDefined()
    expect(fp.toolCount).toBe(1)
    expect(fp.messageCount).toBe(1)
    expect(fp.hasSystemPrompt).toBe(true)
    expect(fp.configurationFields).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 11])

    expect(fp.metadata.f1).toBe("windsurf")
    expect(fp.metadata.f12).toBe("windsurf")
    expect(fp.metadata.f4).toBe("en")
    expect(fp.metadata.f3).toMatch(/^devin-session-token\$test/)
    expect(fp.metadata.f5).toBeUndefined()
    expect(fp.metadata.f8).toBeUndefined()
    expect(fp.metadata.f21).toBeUndefined()
    expect(fp.metadata.f28).toBeUndefined()
    expect(fp.metadata.f31).toBeUndefined()
  })

  test("omits prompt_id field when not provided", () => {
    const built = buildRequest({
      payload: basePayload,
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    const top = topLevelFields(decodeFramedPayload(built))
    expect(top).not.toContain(17)
  })

  test("omits tools when no tools are provided", () => {
    const payload: ChatCompletionsPayload = {
      model: "swe-1-6",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }

    const built = buildRequest({
      payload,
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    const fp = fingerprintWindsurfRequest(built)
    expect(fp.toolCount).toBe(0)
  })

  test("forwards historical reasoning_content as reasoning_text", () => {
    const payload: ChatCompletionsPayload = {
      ...basePayload,
      messages: [
        {
          role: "assistant",
          content: "answer",
          reasoning_content: "private reasoning",
        },
      ],
    }

    const built = buildRequest({
      payload,
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    expect(assistantMessageFields(decodeFramedPayload(built))).toContain(11)
    expect(assistantMessageId(decodeFramedPayload(built))).toMatch(/^bot-/)
  })

  test("keeps reasoning-only assistant history", () => {
    const built = buildRequest({
      payload: {
        ...basePayload,
        messages: [
          {
            role: "assistant",
            content: null,
            reasoning_content: "private reasoning",
          },
        ],
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    expect(assistantMessageFields(decodeFramedPayload(built))).toContain(11)
  })

  test("forwards historical reasoning signatures in the correct field", () => {
    const built = buildRequest({
      payload: {
        ...basePayload,
        messages: [
          {
            role: "assistant",
            content: "answer",
            reasoning_content: "private reasoning",
            signature: "sig-1",
          },
        ],
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    expect(assistantMessageFields(decodeFramedPayload(built))).toEqual([
      1, 2, 3, 11, 12,
    ])
  })

  test("extracts signatures from reasoning content parts", () => {
    const built = buildRequest({
      payload: {
        ...basePayload,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "private reasoning",
                signature: "sig-2",
              },
              { type: "text", text: "answer" },
            ],
          },
        ],
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    expect(assistantMessageFields(decodeFramedPayload(built))).toContain(12)
  })

  test("round-trips its own reply: reasoning_opaque returns as field 12", () => {
    // The exact assistant message shape `collect-response.ts` hands back, fed
    // straight into the next request. Windsurf emits the signature as
    // `reasoning_opaque`, so the request side has to accept that spelling or
    // every multi-turn conversation loses its signatures.
    const built = buildRequest({
      payload: {
        ...basePayload,
        messages: [
          {
            role: "assistant",
            content: "the answer",
            reasoning_text: "private reasoning",
            reasoning_opaque: "sig-from-windsurf",
          },
        ],
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    const decoded = decodeFramedPayload(built)
    expect(assistantMessageString(decoded, 11)).toBe("private reasoning")
    expect(assistantMessageString(decoded, 12)).toBe("sig-from-windsurf")
  })

  test("forwards top-level `reasoning` (OpenRouter spelling)", () => {
    const built = buildRequest({
      payload: {
        ...basePayload,
        messages: [
          { role: "assistant", content: "answer", reasoning: "private" },
        ],
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    expect(assistantMessageString(decodeFramedPayload(built), 11)).toBe(
      "private",
    )
  })

  test("drops the signature when it cannot cover the merged reasoning", () => {
    // Two separately signed thinking blocks — what an Anthropic client sends
    // back after interleaved reasoning. Field 11 is their concatenation, which
    // neither signature signs, so field 12 must be omitted rather than carry
    // the first block's signature.
    const built = buildRequest({
      payload: {
        ...basePayload,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "first half", signature: "sig-a" },
              { type: "reasoning", text: "second half", signature: "sig-b" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    const decoded = decodeFramedPayload(built)
    expect(assistantMessageString(decoded, 11)).toBe("first halfsecond half")
    expect(assistantMessageFields(decoded)).not.toContain(12)
  })

  test("drops a reasoning_details signature that only signs a fragment", () => {
    const built = buildRequest({
      payload: {
        ...basePayload,
        messages: [
          {
            role: "assistant",
            content: "answer",
            reasoning_text: "first halfsecond half",
            reasoning_details: [
              { text: "first half", signature: "sig-a" },
              { text: "second half", signature: "sig-b" },
            ],
          },
        ],
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    expect(assistantMessageFields(decodeFramedPayload(built))).not.toContain(12)
  })

  test("drops a top-level signature that cannot cover merged reasoning", () => {
    // `reasoning_content` concatenates several signed blocks (the shape
    // `messages-to-chat.ts` emits), and the client re-attaches only the first
    // block's signature at the top level. Field 11 is the concatenation, which
    // that signature does not cover, so field 12 must be omitted.
    const built = buildRequest({
      payload: {
        ...basePayload,
        messages: [
          {
            role: "assistant",
            content: "answer",
            reasoning_content: "first halfsecond half",
            signature: "sig-a",
            reasoning_details: [
              { text: "first half", signature: "sig-a" },
              { text: "second half", signature: "sig-b" },
            ],
          },
        ],
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    const decoded = decodeFramedPayload(built)
    expect(assistantMessageString(decoded, 11)).toBe("first halfsecond half")
    expect(assistantMessageFields(decoded)).not.toContain(12)
  })

  test("round-trips interleaved reasoning via reasoning_opaque", () => {
    // An interleaved Windsurf reply carries both per-part signatures and the
    // accumulated `reasoning_opaque`. Only the latter covers the whole
    // reasoning text, so it — not the part signature — must be field 12.
    const built = buildRequest({
      payload: {
        ...basePayload,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "first half", signature: "part-sig" },
              { type: "text", text: "answer" },
            ],
            reasoning_text: "first half",
            reasoning_opaque: "full-stream-sig",
          },
        ],
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    const decoded = decodeFramedPayload(built)
    expect(assistantMessageString(decoded, 11)).toBe("first half")
    expect(assistantMessageString(decoded, 12)).toBe("full-stream-sig")
  })

  test("skips an assistant turn carrying only a signature", () => {
    const built = buildRequest({
      payload: {
        ...basePayload,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: null, signature: "sig-orphan" },
        ],
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    const decoded = decodeFramedPayload(built)
    expect(messageNodeCount(decoded)).toBe(1)
    expect(assistantMessageFields(decoded)).not.toContain(12)
  })

  test("normalizes bare apiKey to devin-session-token$ prefix", () => {
    const built = buildRequest({
      payload: basePayload,
      apiKey: "bare-token",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    const fp = fingerprintWindsurfRequest(built)
    expect(fp.metadata.f3).toMatch(/^devin-session-token\$bare/)
  })

  test("keeps apiKey unchanged when prefix already present", () => {
    const built = buildRequest({
      payload: basePayload,
      apiKey: "devin-session-token$jwt",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    const fp = fingerprintWindsurfRequest(built)
    expect(fp.metadata.f3).toMatch(/^devin-session-token\$jwt/)
  })

  test("counts multiple messages and tools", () => {
    const payload: ChatCompletionsPayload = {
      model: "swe-1-6",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "a",
            description: "A",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "function",
          function: {
            name: "b",
            description: "B",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      stream: true,
    }

    const built = buildRequest({
      payload,
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
    })

    const fp = fingerprintWindsurfRequest(built)
    expect(fp.messageCount).toBe(3)
    expect(fp.toolCount).toBe(2)
  })

  test("resolveSystemPrompt falls back to default when no system message", () => {
    const payload: ChatCompletionsPayload = {
      model: "swe-1-6",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }

    expect(resolveSystemPrompt(payload)).toBe(
      "You are Cascade, a powerful coding assistant.",
    )
  })

  test("resolveSystemPrompt joins multiple system messages", () => {
    const payload: ChatCompletionsPayload = {
      model: "swe-1-6",
      messages: [
        { role: "system", content: "First." },
        { role: "system", content: "Second." },
        { role: "user", content: "hello" },
      ],
      stream: true,
    }

    expect(resolveSystemPrompt(payload)).toBe("First.\n\nSecond.")
  })
})
