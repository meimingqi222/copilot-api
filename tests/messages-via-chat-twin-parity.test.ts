import { describe, expect, test } from "bun:test"

import type { CopilotStreamEvent } from "~/services/copilot/create-chat-completions"
import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic"

import {
  chunkFromText,
  chunkFromToolCallArgs,
  chunkFromToolCallInit,
  doneChunk,
  toOpenAIChunkUsage,
} from "~/services/windsurf/chunk-builders"
import { createMessagesViaChat } from "~/services/protocols/messages-via-chat"

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

async function runWith(events: Array<TwinEvent>): Promise<Array<unknown>> {
  const result = await createMessagesViaChat({
    target,
    connection,
    credential,
    payload,
    chatExecutor: () =>
      Promise.resolve({ credentialId: "cred-1", response: toStream(events) }),
  })
  const out: Array<unknown> = []
  for await (const event of result.response as AsyncIterable<unknown>) {
    out.push(event)
  }
  return out
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
    const events = await runWith(buildEvents())
    const types = events.map((e) => (e as { type?: string }).type)
    expect(types).toContain("message_start")
    expect(types).toContain("message_stop")
    const deltas = events.filter(
      (e) => (e as { type?: string }).type === "message_delta",
    )
    expect(deltas.length).toBeGreaterThan(0)
  })
})
