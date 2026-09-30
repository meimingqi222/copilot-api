import { describe, expect, test } from "bun:test"

import {
  decodeGeminiRequest,
  encodeGeminiRequest,
} from "~/services/ir/codecs/gemini/request"
import {
  decodeGeminiResult,
  encodeGeminiResult,
} from "~/services/ir/codecs/gemini/result"
import {
  decodeGeminiStream,
  encodeGeminiStream,
} from "~/services/ir/codecs/gemini/stream"
import type { StreamEvent } from "~/services/ir/types"
import type { GeminiGenerateContentRequest } from "~/services/protocols/gemini"

describe("gemini request codec", () => {
  test("decodes system instruction, contents and generation config", () => {
    const ir = decodeGeminiRequest({
      model: "gemini-3-pro",
      systemInstruction: { parts: [{ text: "be brief" }] },
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        {
          role: "model",
          parts: [
            { text: "step one", thought: true, thoughtSignature: "sig_1" },
            { text: "hello" },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 128,
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        stopSequences: ["END"],
        thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
      },
    })

    expect(ir.model).toBe("gemini-3-pro")
    expect(ir.source.wire).toBe("gemini")
    expect(ir.instructions).toEqual([
      {
        role: "system",
        parts: [{ type: "text", text: "be brief" }],
        source: { wire: "gemini" },
      },
    ])
    expect(ir.turns).toHaveLength(2)
    expect(ir.turns[0]).toEqual({
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      source: { wire: "gemini" },
    })
    expect(ir.turns[1].role).toBe("assistant")
    expect(ir.turns[1].parts[0]).toEqual({
      type: "thinking",
      text: "step one",
      signature: "sig_1",
      signedText: "step one",
      source: { wire: "gemini" },
    })
    expect(ir.turns[1].parts[1]).toEqual({ type: "text", text: "hello" })
    expect(ir.generation).toMatchObject({
      maxOutputTokens: 128,
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      stopSequences: ["END"],
      reasoning: { budgetTokens: 1024, display: "summarized" },
    })
  })

  test("decodes tools, allowed function names and google_search grounding", () => {
    const ir = decodeGeminiRequest({
      model: "gemini-3-pro",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "lookup",
              description: "d",
              parameters: { type: "object" },
            },
          ],
        },
        { google_search: {} },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: ["lookup"],
        },
      },
    })

    expect(ir.tools).toEqual([
      { name: "lookup", description: "d", parameters: { type: "object" } },
    ])
    expect(ir.toolChoice).toEqual({ type: "tool", name: "lookup" })
    expect(ir.generation?.webSearch).toBe(true)
  })

  test("decodes functionCall and functionResponse parts", () => {
    const ir = decodeGeminiRequest({
      model: "gemini-3-pro",
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        {
          role: "model",
          parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "lookup",
                response: { result: "found" },
              },
            },
          ],
        },
      ],
    })

    expect(ir.turns[1].parts[0]).toEqual({
      type: "tool_call",
      id: "lookup",
      name: "lookup",
      arguments: JSON.stringify({ q: "x" }),
    })
    expect(ir.turns[2].parts[0]).toEqual({
      type: "tool_result",
      callId: "lookup",
      content: [{ type: "text", text: JSON.stringify({ result: "found" }) }],
    })
  })

  test("round-trips a Gemini request without losing the thought signature", () => {
    const source: GeminiGenerateContentRequest = {
      model: "gemini-3-pro",
      systemInstruction: { parts: [{ text: "sys" }] },
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        {
          role: "model",
          parts: [
            { text: "reasoning", thought: true, thoughtSignature: "sig_a" },
            { text: "answer" },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [{ name: "t", parameters: { type: "object" } }],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: 64 },
    }

    const encoded = encodeGeminiRequest(decodeGeminiRequest(source), {
      stream: false,
    })

    expect(encoded.systemInstruction).toEqual({ parts: [{ text: "sys" }] })
    expect(encoded.contents[0]).toEqual({
      role: "user",
      parts: [{ text: "hi" }],
    })
    expect(encoded.contents[1].parts[0]).toEqual({
      text: "reasoning",
      thought: true,
      thoughtSignature: "sig_a",
    })
    expect(encoded.contents[1].parts[1]).toEqual({ text: "answer" })
    expect(encoded.tools).toEqual([
      { functionDeclarations: [{ name: "t", parameters: { type: "object" } }] },
    ])
    expect(encoded.toolConfig).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    })
    expect(encoded.generationConfig).toEqual({ maxOutputTokens: 64 })
    expect(encoded.stream).toBe(false)
  })

  test("drops a thought signature that did not originate on the Gemini wire", () => {
    const ir = decodeGeminiRequest({
      model: "m",
      contents: [
        {
          role: "model",
          parts: [{ text: "from elsewhere", thought: true }],
        },
      ],
    })
    // Simulate a signature issued by a different wire.
    const thinking = ir.turns[0].parts[0]
    if (thinking.type === "thinking") {
      thinking.signature = "anthropic_sig"
      thinking.signedText = "from elsewhere"
      thinking.source = { wire: "messages" }
    }
    const encoded = encodeGeminiRequest(ir, {})
    expect(encoded.contents[0].parts[0]).toEqual({
      text: "from elsewhere",
      thought: true,
    })
  })

  test("encodes malformed tool arguments as an empty object", () => {
    const ir = decodeGeminiRequest({
      model: "m",
      contents: [
        { role: "model", parts: [{ functionCall: { name: "t", args: {} } }] },
      ],
    })
    const call = ir.turns[0].parts[0]
    if (call.type === "tool_call") call.arguments = '{"truncated":'
    const encoded = encodeGeminiRequest(ir, {})
    expect(encoded.contents[0].parts[0]).toEqual({
      functionCall: { name: "t", args: {} },
    })
  })
})

describe("gemini result codec", () => {
  test("decodes candidates, usage and stop reason", () => {
    const ir = decodeGeminiResult({
      responseId: "resp_1",
      modelVersion: "gemini-3-pro",
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [{ text: "answer" }, { text: "trace", thought: true }],
          },
          finishReason: "MAX_TOKENS",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
        thoughtsTokenCount: 5,
        cachedContentTokenCount: 3,
      },
    })

    expect(ir.id).toBe("resp_1")
    expect(ir.model).toBe("gemini-3-pro")
    expect(ir.parts).toEqual([
      { type: "text", text: "answer" },
      {
        type: "thinking",
        text: "trace",
        source: { wire: "gemini" },
      },
    ])
    expect(ir.stop).toEqual({ reason: "max_tokens", raw: "MAX_TOKENS" })
    expect(ir.usage).toEqual({
      source: "reported",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cacheReadTokens: 3,
      reasoningTokens: 5,
    })
  })

  test("maps a safety block to a refusal stop", () => {
    const ir = decodeGeminiResult({
      promptFeedback: { blockReason: "SAFETY" },
    })
    expect(ir.stop).toEqual({ reason: "refusal", raw: "SAFETY" })
  })

  test("encodes an IR result back into the Gemini shape", () => {
    const encoded = encodeGeminiResult(
      decodeGeminiResult({
        responseId: "resp_2",
        modelVersion: "gemini-3-pro",
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [
                { text: "trace", thought: true, thoughtSignature: "sig_z" },
                { text: "answer" },
                { functionCall: { name: "t", args: { a: 1 } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 },
      }),
    )

    expect(encoded.responseId).toBe("resp_2")
    expect(encoded.candidates?.[0].finishReason).toBe("STOP")
    expect(encoded.candidates?.[0].content?.parts).toEqual([
      { text: "trace", thought: true, thoughtSignature: "sig_z" },
      { text: "answer" },
      { functionCall: { name: "t", args: { a: 1 } } },
    ])
    expect(encoded.usageMetadata).toEqual({
      promptTokenCount: 4,
      candidatesTokenCount: 6,
    })
  })
})

describe("gemini stream codec", () => {
  async function* frames(events: Array<Record<string, unknown>>) {
    for (const event of events) yield { data: JSON.stringify(event) }
  }

  test("decodes SSE frames into incremental events and back", async () => {
    const upstream = frames([
      {
        candidates: [
          { index: 0, content: { role: "model", parts: [{ text: "Hel" }] } },
        ],
      },
      {
        candidates: [
          { index: 0, content: { role: "model", parts: [{ text: "lo" }] } },
        ],
      },
      {
        candidates: [{ index: 0, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      },
    ])

    const events: Array<StreamEvent> = []
    for await (const event of decodeGeminiStream(upstream, "gemini-3-pro"))
      events.push(event)

    expect(events[0]).toMatchObject({
      type: "message_start",
      model: "gemini-3-pro",
      source: { wire: "gemini" },
    })
    const deltas = events.filter((event) => event.type === "part_delta")
    expect(deltas.map((event) => event.delta)).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ])
    expect(events.at(-1)).toMatchObject({
      type: "message_end",
      stop: { reason: "complete", raw: "STOP" },
      status: "completed",
    })

    const reencoded: Array<{ data?: string }> = []
    for await (const frame of encodeGeminiStream(
      (async function* () {
        for (const event of events) yield event
      })(),
      "gemini-3-pro",
    ))
      reencoded.push(frame)

    const parsed = reencoded
      .map((frame) => JSON.parse(frame.data ?? "{}"))
      .flatMap((value) => value.candidates?.[0]?.content?.parts ?? [])
      .map((part: { text?: string }) => part.text)
      .filter(Boolean)
    expect(parsed).toEqual(["Hel", "lo"])
    const last = JSON.parse(reencoded.at(-1)?.data ?? "{}")
    expect(last.candidates[0].finishReason).toBe("STOP")
    expect(last.usageMetadata).toEqual({
      promptTokenCount: 1,
      candidatesTokenCount: 2,
    })
  })

  test("keeps thought parts separate from text", async () => {
    const upstream = frames([
      {
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [
                { text: "trace", thought: true, thoughtSignature: "sig_1" },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          { index: 0, content: { role: "model", parts: [{ text: "out" }] } },
        ],
      },
    ])

    const kinds: Array<string> = []
    const signatures: Array<string> = []
    for await (const event of decodeGeminiStream(upstream, "m")) {
      if (event.type === "part_start") kinds.push(event.part.type)
      if (event.type === "part_delta" && event.delta.type === "signature")
        signatures.push(event.delta.text)
    }
    expect(kinds).toEqual(["thinking", "text"])
    expect(signatures).toEqual(["sig_1"])
  })
})
