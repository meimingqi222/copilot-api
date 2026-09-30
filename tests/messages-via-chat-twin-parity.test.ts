import { describe, expect, test } from "bun:test"

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { CopilotStreamEvent } from "~/services/protocols/chat/types"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic"

import { createMessagesViaChat } from "~/services/protocols/messages-via-chat"
import {
  chunkFromText,
  chunkFromToolCallArgs,
  chunkFromToolCallInit,
  doneChunk,
  toOpenAIChunkUsage,
} from "~/services/windsurf/chunk-builders"

const REQ = "chatcmpl-twin-test"
const MODEL = "swe-twin"

interface TwinEvent extends CopilotStreamEvent {
  collected?: Record<string, unknown>
}

function buildEvents(): Array<TwinEvent> {
  const usage = {
    prompt_tokens: 120,
    completion_tokens: 34,
    total_tokens: 154,
    cached_tokens: 90,
    cache_read_tokens: 90,
  }
  return [
    {
      data: chunkFromText({
        requestId: REQ,
        model: MODEL,
        text: "thinking hard",
        field: "reasoning_text",
      }),
      collected: { reasoningText: "thinking hard" },
    },
    {
      data: chunkFromText({
        requestId: REQ,
        model: MODEL,
        text: "SIG",
        field: "reasoning_opaque",
      }),
      collected: { reasoningOpaque: "SIG" },
    },
    {
      data: chunkFromText({
        requestId: REQ,
        model: MODEL,
        text: "Hello ",
        field: "content",
      }),
      collected: { content: "Hello " },
    },
    {
      data: chunkFromToolCallInit({
        requestId: REQ,
        model: MODEL,
        toolIndex: 0,
        callId: "call_1",
        toolName: "bash",
      }),
      collected: {
        toolCalls: [
          { index: 0, id: "call_1", function: { name: "bash", arguments: "" } },
        ],
      },
    },
    {
      data: chunkFromToolCallArgs({
        requestId: REQ,
        model: MODEL,
        toolIndex: 0,
        args: '{"cmd":"ls"}',
      }),
      collected: {
        toolCalls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }],
      },
    },
    {
      data: doneChunk({
        requestId: REQ,
        model: MODEL,
        finishReason: "tool_calls",
        usage,
      }),
      collected: {
        finishReason: "tool_calls",
        usage: toOpenAIChunkUsage(usage),
      },
    },
    { data: "[DONE]" },
  ]
}

function toStream(events: Array<TwinEvent>): AsyncIterable<CopilotStreamEvent> {
  // Must be an async generator: the dispatch layer distinguishes streams by
  // `Symbol.asyncIterator` (a sync generator would look like a response).
  return (async function* () {
    for (const event of events) yield event as CopilotStreamEvent
  })()
}

const target: RouteTarget = {
  connectionId: "conn-1",
  connectionName: "windsurf-test",
  protocol: "windsurf-native",
  credentialId: "cred-1",
  publicModelId: "swe-twin",
  upstreamModelId: "swe-twin",
  endpoint: "chat",
  connectionPriority: 10,
  connectionWeight: 1,
  credentialPriority: 0,
  credentialWeight: 1,
}

const connection = { id: "conn-1" } as unknown as ProviderConnection
const credential = { id: "cred-1" } as unknown as ApiCredential

const payload: AnthropicMessagesPayload = {
  model: "swe-twin",
  max_tokens: 256,
  stream: true,
  messages: [{ role: "user", content: "hi" }],
}

interface AnthropicSseFrame {
  data: string
  event: string
}

async function runWith(
  events: Array<TwinEvent>,
): Promise<Array<AnthropicSseFrame>> {
  const result = await createMessagesViaChat({
    target,
    connection,
    credential,
    payload,
    chatExecutor: () =>
      Promise.resolve({ credentialId: "cred-1", response: toStream(events) }),
  })
  const out: Array<AnthropicSseFrame> = []
  for await (const frame of result.response as AsyncIterable<AnthropicSseFrame>) {
    out.push(frame)
  }
  return out
}

/** Consume frames the way connection-handler does — proves the frame shape. */
async function forwardedEventTypes(
  events: Array<TwinEvent>,
): Promise<Array<string | undefined>> {
  const frames = await runWith(events)
  const types: Array<string | undefined> = []
  for (const frame of frames) {
    if (!frame.data) continue
    types.push((JSON.parse(frame.data) as { type?: string }).type)
  }
  return types
}

describe("messages-via-chat structured twin", () => {
  test("twin fast path matches the JSON-parse path exactly", async () => {
    const events = buildEvents()
    const viaTwin = await runWith(events)
    const viaJson = await runWith(events.map(({ data }) => ({ data })))

    expect(viaTwin.length).toBeGreaterThan(0)
    expect(viaTwin).toEqual(viaJson)
  })

  test("twin path carries tool calls and usage to the end", async () => {
    const frames = await runWith(buildEvents())
    const types = frames.map((frame) => {
      expect(frame.data).toBeString()
      return (JSON.parse(frame.data) as { type?: string }).type
    })
    expect(types).toContain("message_start")
    expect(types).toContain("message_stop")
    const deltas = types.filter((type) => type === "message_delta")
    expect(deltas.length).toBeGreaterThan(0)
  })

  test("stream yields SSE frames the connection-handler loop can forward", async () => {
    // Regression: the wrapper used to yield raw Anthropic event objects, which
    // the consumer's `if (!event.data) continue` guard silently dropped —
    // clients received only the synthetic terminal error.
    const types = await forwardedEventTypes(buildEvents())
    expect(types).toContain("message_start")
    expect(types).toContain("message_stop")
    for (const frameType of types) {
      expect(frameType).toBeString()
    }
  })
})
