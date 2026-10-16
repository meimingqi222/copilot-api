// Exercise native chat search through the HTTP route and final accounting.
import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

const originalFetch = globalThis.fetch

async function createSearcher(): Promise<void> {
  await createConnection({
    id: "searcher",
    name: "searcher",
    protocol: "openai-responses-compatible",
    baseUrl: "https://searcher.test/v1",
    credentials: [{ id: "searcher-cred", value: "sk", authMode: "bearer" }],
    models: [
      {
        publicId: "gpt-5-mini",
        upstreamId: "gpt-5-mini",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })
}

async function createChatTarget(): Promise<void> {
  await createConnection({
    id: "chat-only",
    name: "chat-only",
    protocol: "openai-compatible",
    baseUrl: "https://chat.test/v1",
    credentials: [{ id: "chat-cred", value: "sk", authMode: "bearer" }],
    models: [
      {
        publicId: "writer-model",
        upstreamId: "writer-model",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
  })
}

function sse(frames: Array<Record<string, unknown>>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const frame of frames)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
          )
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function searcherSearchResponse() {
  return {
    ok: true,
    status: 200,
    headers: {},
    text: () => Promise.resolve(""),
    json: () => ({
      id: "resp_search",
      object: "response",
      model: "gpt-5-mini",
      status: "completed",
      output: [
        {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: {
            type: "search",
            query: "go 1.27",
            sources: [],
          },
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Go 1.27.1 is out." }],
        },
      ],
      output_text: "Go 1.27.1 is out.",
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    }),
  }
}

function chatReply(toolCall?: { id: string; name: string; args: string }) {
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "writer-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCall ? null : "answer",
          ...(toolCall && {
            tool_calls: [
              {
                id: toolCall.id,
                type: "function",
                function: { name: toolCall.name, arguments: toolCall.args },
              },
            ],
          }),
        },
        finish_reason: toolCall ? "tool_calls" : "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  }
}

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  resetProtectedRouteGuardForTest()
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
  delete process.env.SEARCH_ORCHESTRATION
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
})

for (const stream of [false, true]) {
  test(`native chat search prices mixed context rounds separately (stream=${stream})`, async () => {
    await createSearcher()
    await createChatTarget()
    statsStore.setModelPricing("writer-model", {
      promptPricePer1k: 0.001,
      completionPricePer1k: 0.002,
      cacheReadPricePer1k: 0.0001,
      contextThresholdTokens: 200_000,
      extendedPromptPricePer1k: 0.002,
      extendedCompletionPricePer1k: 0.004,
      extendedCacheReadPricePer1k: 0.0002,
    })
    statsStore.setModelPricing("gpt-5-mini", {
      promptPricePer1k: 1,
      completionPricePer1k: 2,
    })
    let rounds = 0
    globalThis.fetch = mock((url: string) => {
      if (!url.includes("chat.test")) return searcherSearchResponse()
      rounds++
      const reply = chatReply(
        rounds === 1 ?
          { id: "call_1", name: "web_search", args: '{"query":"test"}' }
        : undefined,
      )
      const usage = {
        prompt_tokens: rounds === 1 ? 150_000 : 250_000,
        completion_tokens: 10,
        total_tokens: (rounds === 1 ? 150_000 : 250_000) + 10,
        prompt_tokens_details: { cached_tokens: 50_000 },
      }
      if (!stream)
        return new Response(JSON.stringify({ ...reply, usage }), {
          headers: { "content-type": "application/json" },
        })
      return sse([
        {
          ...reply,
          choices: reply.choices.map((choice) => ({
            index: choice.index,
            delta: choice.message,
            finish_reason: choice.finish_reason,
          })),
        },
        { choices: [], usage },
        { choices: [], usage },
      ])
    }) as unknown as typeof fetch

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "writer-model",
          stream,
          messages: [{ role: "user", content: "search" }],
          plugins: [{ id: "web" }],
        }),
      }),
    )
    expect(response.status).toBe(200)
    await response.text()
    expect(rounds).toBe(2)
    const usage = statsStore.getUsageStats("chat-only")[0]
    expect(usage?.requests).toBe(1)
    expect(usage?.totalTokens).toBe(150_000 + 250_000 + 20)
    // Each round uses its own context tier, including cached input.
    expect(usage?.cost).toBeCloseTo(0.51506, 10)
    const search = statsStore.getUsageStats("searcher")[0]
    expect(search).toMatchObject({ requests: 0, totalTokens: 7 })
    expect(search?.cost).toBeCloseTo(0.011, 10)
  })
}

test("a failed later writer round preserves earlier usage under its own account before failover", async () => {
  await createSearcher()
  await createChatTarget()
  await createConnection({
    id: "writer-fallback",
    name: "fallback",
    protocol: "openai-compatible",
    priority: 100,
    baseUrl: "https://fallback.test/v1",
    credentials: [{ id: "fallback-cred", value: "sk", authMode: "bearer" }],
    models: [
      {
        publicId: "writer-model",
        upstreamId: "writer-model",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
  })
  statsStore.setModelPricing("writer-model", {
    promptPricePer1k: 1,
    completionPricePer1k: 2,
  })
  let rounds = 0
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("searcher.test")) return searcherSearchResponse()
    if (String(url).includes("fallback.test")) return Response.json(chatReply())
    rounds++
    if (rounds === 2)
      return new Response("fixture later round failed", { status: 500 })
    return Response.json(
      chatReply({
        id: "call_search",
        name: "web_search",
        args: '{"query":"test"}',
      }),
    )
  }) as typeof fetch
  const response = await server.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "writer-model",
        messages: [{ role: "user", content: "search" }],
        plugins: [{ id: "web" }],
      }),
    }),
  )
  expect(response.status).toBe(200)
  await response.text()
  expect(rounds).toBe(2)
  const failed = statsStore.getUsageStats("chat-only")[0]
  expect(failed).toMatchObject({
    requests: 0,
    promptTokens: 5,
    completionTokens: 5,
    totalTokens: 10,
  })
  expect(failed?.cost).toBeCloseTo(0.015, 10)
  const fallback = statsStore.getUsageStats("writer-fallback")[0]
  expect(fallback).toMatchObject({ requests: 1, totalTokens: 10 })
  expect(fallback?.cost).toBeCloseTo(0.015, 10)
  expect(statsStore.getUsageStats("searcher")[0]).toMatchObject({
    requests: 0,
    totalTokens: 7,
  })
})

for (const endpoint of ["chat/completions", "messages", "responses"]) {
  test(`${endpoint} stream keeps completed writer rounds when a later call throws`, async () => {
    await createSearcher()
    await createChatTarget()
    statsStore.setModelPricing("writer-model", {
      promptPricePer1k: 1,
      completionPricePer1k: 2,
    })
    let rounds = 0
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("searcher.test")) return searcherSearchResponse()
      rounds++
      if (rounds === 2)
        return new Response("fixture later round failed", { status: 500 })
      const reply = chatReply({
        id: "call_search",
        name: "web_search",
        args: '{"query":"test"}',
      })
      return sse([
        {
          ...reply,
          choices: reply.choices.map((choice) => ({
            index: 0,
            delta: choice.message,
            finish_reason: choice.finish_reason,
          })),
        },
      ])
    }) as typeof fetch
    const response = await server.fetch(
      new Request(`http://localhost/v1/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "writer-model",
          stream: true,
          max_tokens: 100,
          ...(endpoint === "responses" ?
            { input: "search", tools: [{ type: "web_search_preview" }] }
          : {
              messages: [{ role: "user", content: "search" }],
              ...(endpoint === "messages" ?
                { tools: [{ type: "web_search_20250305", name: "web_search" }] }
              : { plugins: [{ id: "web" }] }),
            }),
        }),
      }),
    )
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain("error")
    expect(rounds).toBe(2)
    const writer = statsStore.getUsageStats("chat-only")[0]
    expect(writer).toMatchObject({
      requests: 1,
      promptTokens: 5,
      completionTokens: 5,
      totalTokens: 10,
    })
    expect(writer?.cost).toBeCloseTo(0.015, 10)
    expect(statsStore.getUsageStats("searcher")[0]).toMatchObject({
      requests: 0,
      totalTokens: 7,
    })
  })
}
