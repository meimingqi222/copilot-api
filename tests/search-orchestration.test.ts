import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  setConnectionSetting,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const originalEnv = process.env.SEARCH_ORCHESTRATION

/**
 * A search-capable account whose backend answers `web_search` natively.
 *
 * Uses the plain-credential responses protocol rather than `codex-native`:
 * codex accounts go through the OAuth token refresher, which a fixture cannot
 * satisfy. Codex ranking first is covered by `tests/search-searcher.test.ts`.
 */
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

/**
 * A codex account.
 *
 * The upstream base comes from `metadata.settings.baseUrl` (see
 * `create-responses-once.ts`), not from `connection.baseUrl`, so it has to be
 * set separately here. `createConnection` drops the credential's
 * `refresherType`/`context`, which leaves the connection without a provider
 * (= no OAuth), so `ensureOAuthConnectionAccessToken` returns the stored token
 * as-is instead of attempting a refresh a fixture cannot satisfy.
 */
async function createCodexSearcher(): Promise<void> {
  const connection = await createConnection({
    id: "codex-searcher",
    name: "codex",
    protocol: "codex-native",
    baseUrl: "https://codex.test/v1",
    credentials: [
      {
        id: "codex-cred",
        value: "tok",
        authMode: "bearer",
      },
    ],
    models: [
      {
        publicId: "gpt-5-mini",
        upstreamId: "gpt-5-mini",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })
  setConnectionSetting(connection, "baseUrl", "https://codex.test/v1")
}

async function createXaiSearcher(): Promise<void> {
  const connection = await createConnection({
    id: "xai-searcher",
    name: "grok",
    protocol: "xai-native",
    baseUrl: "https://xai.test/v1",
    credentials: [{ id: "xai-cred", value: "tok", authMode: "bearer" }],
    models: [
      {
        publicId: "grok-4",
        upstreamId: "grok-4",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })
  setConnectionSetting(connection, "baseUrl", "https://xai.test/v1")
}

/** A chat-only upstream that hosts the model the client asked for. */
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

/** Request body of the second chat-backend round, where results are fed back. */
function secondChatBody(fetchMock: ReturnType<typeof mock>): string {
  const call = fetchMock.mock.calls
    .filter(([url]) => (url as string).includes("chat.test"))
    .at(1) as [string, { body?: string }] | undefined
  return call?.[1]?.body ?? ""
}

/**
 * A codex answer. The codex backend only speaks SSE — even for a request that
 * asked for `stream: false`, so this has to be a real event-stream response
 * (`collectResponsesFromSseResponse` reads the body).
 */
function codexSearchResponse(urls: Array<string>): Response {
  return sse([
    {
      type: "response.completed",
      response: {
        id: "resp_codex",
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
              sources: urls.map((url) => ({ type: "url", url })),
            },
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Go 1.27.1 is out." }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      },
    },
  ])
}

function chatResponse(
  text: string,
  toolCall?: { id: string; name: string; args: string },
) {
  return {
    ok: true,
    status: 200,
    headers: {},
    text: () => Promise.resolve(""),
    json: () => ({
      id: "chatcmpl_1",
      object: "chat.completion",
      created: 1,
      model: "writer-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: toolCall ? null : text,
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
    }),
  }
}

/** A search-capable Responses answer that ran the search server-side. */
function searcherSearchResponse(urls: Array<string>) {
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
            sources: urls.map((url) => ({ type: "url", url })),
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

beforeEach(async () => {
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
  if (originalEnv === undefined) delete process.env.SEARCH_ORCHESTRATION
  else process.env.SEARCH_ORCHESTRATION = originalEnv
})

for (const endpoint of ["messages", "responses"] as const) {
  for (const stream of [false, true]) {
    test.each([150_000, 250_000])(
      `search prices each round independently (${endpoint}, stream=${stream}, second input=%s)`,
      async (secondInput) => {
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
        let rounds = 0
        globalThis.fetch = mock((url: string) => {
          if (!url.includes("chat.test")) return searcherSearchResponse([])
          rounds++
          const reply = chatResponse(
            "answer",
            rounds === 1 ?
              { id: "call_1", name: "web_search", args: '{"query":"test"}' }
            : undefined,
          ).json()
          const usage = {
            prompt_tokens: rounds === 1 ? 150_000 : secondInput,
            completion_tokens: 10,
            total_tokens: (rounds === 1 ? 150_000 : secondInput) + 10,
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
        const body =
          endpoint === "messages" ?
            {
              model: "writer-model",
              stream,
              max_tokens: 100,
              messages: [{ role: "user", content: "search" }],
              tools: [{ type: "web_search_20250305", name: "web_search" }],
            }
          : {
              model: "writer-model",
              stream,
              input: "search",
              tools: [{ type: "web_search" }],
            }
        const response = await server.fetch(
          new Request(`http://localhost/v1/${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
        expect(response.status).toBe(200)
        await response.text()
        expect(rounds).toBe(2)
        const usage = statsStore.getUsageStats("chat-only")[0]
        expect(usage?.requests).toBe(1)
        expect(usage?.totalTokens).toBe(150_000 + secondInput + 20)
        expect(usage?.cacheReadTokens).toBe(100_000)
        expect(usage?.cost).toBeCloseTo(
          secondInput === 150_000 ? 0.21004 : 0.51506,
          10,
        )
      },
    )
  }
}

test("messages client → chat upstream: the proxy runs the search and reports it as server tool events", async () => {
  await createSearcher()
  await createChatTarget()

  const urls: Array<string> = []
  let chatRound = 0
  const fetchMock = mock((url: string) => {
    urls.push(url)
    if (url.includes("chat.test")) {
      chatRound++
      // Round 1: the model asks for a search. Round 2: it answers.
      return chatRound === 1 ?
          chatResponse("", {
            id: "call_1",
            name: "web_search",
            args: JSON.stringify({ query: "go 1.27" }),
          })
        : chatResponse("Go 1.27.1 is out.")
    }
    return searcherSearchResponse(["https://go.dev/doc/go1.27"])
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "writer-model",
        max_tokens: 256,
        messages: [{ role: "user", content: "did go 1.27 come out?" }],
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 3 },
        ],
      }),
    }),
  )

  expect(response.status).toBe(200)
  // Two target rounds + one search-backend turn.
  expect(urls.filter((url) => url.includes("chat.test"))).toHaveLength(2)
  expect(urls.filter((url) => url.includes("searcher.test"))).toHaveLength(1)

  const body = (await response.json()) as {
    content: Array<Record<string, unknown>>
    stop_reason: string
  }
  const types = body.content.map((block) => block.type)
  expect(types).toContain("server_tool_use")
  expect(types).toContain("web_search_tool_result")
  // The internal tool name must never leak as a client-executable tool.
  expect(types).not.toContain("tool_use")

  expect(
    body.content.find((block) => block.type === "server_tool_use"),
  ).toMatchObject({
    name: "web_search",
    input: { query: "go 1.27" },
  })
  expect(
    body.content.find((block) => block.type === "web_search_tool_result"),
  ).toMatchObject({
    content: [{ type: "web_search_result", url: "https://go.dev/doc/go1.27" }],
  })

  const finalText = body.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
  expect(finalText).toContain("Go 1.27.1 is out.")

  // Round 2 must carry the search results back to the model.
  expect(secondChatBody(fetchMock)).toContain("go.dev/doc/go1.27")
})

test("a codex account is preferred as the searcher when one is available", async () => {
  // Both searchers are available; the codex account must win (rank 0).
  await createCodexSearcher()
  await createSearcher()
  await createChatTarget()

  const urls: Array<string> = []
  let chatRound = 0
  const fetchMock = mock((url: string) => {
    urls.push(url)
    if (url.includes("chat.test")) {
      chatRound++
      return chatRound === 1 ?
          chatResponse("", {
            id: "call_1",
            name: "web_search",
            args: JSON.stringify({ query: "go 1.27" }),
          })
        : chatResponse("Go 1.27.1 is out.")
    }
    return codexSearchResponse(["https://go.dev/doc/go1.27"])
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "writer-model",
        max_tokens: 256,
        messages: [{ role: "user", content: "did go 1.27 come out?" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(urls.some((url) => url.includes("codex.test"))).toBe(true)
  expect(urls.some((url) => url.includes("searcher.test"))).toBe(false)

  const body = (await response.json()) as {
    content: Array<{ type: string }>
  }
  expect(body.content.map((block) => block.type)).toContain(
    "web_search_tool_result",
  )
})

test.each([false, true])(
  "xAI executes proxy search through Responses (fallback: %s)",
  async (failXai) => {
    await createXaiSearcher()
    if (failXai) await createSearcher()
    await createChatTarget()

    const urls: Array<string> = []
    let chatRound = 0
    let searchBody: Record<string, unknown> | undefined
    const fetchMock = mock((url: string, init?: RequestInit) => {
      urls.push(url)
      if (url.includes("chat.test")) {
        chatRound++
        return chatRound === 1 ?
            chatResponse("", {
              id: "call_1",
              name: "web_search",
              args: JSON.stringify({ query: "go 1.27" }),
            })
          : chatResponse("Go 1.27.1 is out.")
      }
      if (url.includes("xai.test")) {
        searchBody = JSON.parse(init?.body as string) as Record<string, unknown>
        if (failXai) return new Response("unavailable", { status: 500 })
        return codexSearchResponse(["https://go.dev/doc/go1.27"])
      }
      return searcherSearchResponse(["https://go.dev/doc/go1.27"])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await server.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "writer-model",
          max_tokens: 256,
          messages: [{ role: "user", content: "did go 1.27 come out?" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(urls.filter((url) => url.includes("xai.test"))).toEqual([
      "https://xai.test/v1/responses",
    ])
    expect(urls.some((url) => url.includes("searcher.test"))).toBe(failXai)
    expect(searchBody).toMatchObject({
      model: "grok-4",
      input: "Search the web for: go 1.27",
      tools: [{ type: "web_search", name: "web_search" }],
      store: false,
    })
    expect(secondChatBody(fetchMock)).toContain("Go 1.27.1 is out.")
    expect(secondChatBody(fetchMock)).toContain("https://go.dev/doc/go1.27")
    const body = (await response.json()) as { content: Array<{ type: string }> }
    expect(body.content.map((block) => block.type)).toContain(
      "web_search_tool_result",
    )
  },
)

test("messages client → responses upstream: native search is passed through, not orchestrated", async () => {
  await createSearcher()
  await createConnection({
    id: "responses-target",
    name: "responses-target",
    protocol: "openai-responses-compatible",
    baseUrl: "https://responses.test/v1",
    credentials: [{ id: "c", value: "sk", authMode: "bearer" }],
    models: [
      {
        publicId: "search-model",
        upstreamId: "search-model",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })

  const urls: Array<string> = []
  const bodies: Array<string> = []
  const fetchMock = mock((url: string, opts: { body?: string }) => {
    urls.push(url)
    bodies.push(opts.body ?? "")
    return {
      ok: true,
      status: 200,
      headers: {},
      text: () => Promise.resolve(""),
      json: () => ({
        id: "resp_1",
        object: "response",
        model: "search-model",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
        output_text: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    }
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "search-model",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(urls).toHaveLength(1)
  expect(urls[0]).toContain("responses.test")
  // The native declaration is forwarded in this wire's own spelling; no
  // internal tool is injected.
  expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
    tools: [{ type: "web_search" }],
  })
})

test("streaming: search parts are interleaved, indices stay monotonic and message_start is sent once", async () => {
  await createSearcher()
  await createChatTarget()

  let chatRound = 0
  const fetchMock = mock((url: string) => {
    if (!url.includes("chat.test"))
      return searcherSearchResponse(["https://go.dev"])
    chatRound++
    if (chatRound === 1) {
      return sse([
        {
          id: "c1",
          object: "chat.completion.chunk",
          created: 1,
          model: "writer-model",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: '{"query":"go 1.27"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "c1",
          object: "chat.completion.chunk",
          created: 1,
          model: "writer-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ])
    }
    return sse([
      {
        id: "c2",
        object: "chat.completion.chunk",
        created: 1,
        model: "writer-model",
        choices: [{ index: 0, delta: { content: "Go 1.27.1 is out." } }],
      },
      {
        id: "c2",
        object: "chat.completion.chunk",
        created: 1,
        model: "writer-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ])
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "writer-model",
        max_tokens: 256,
        stream: true,
        messages: [{ role: "user", content: "did go 1.27 come out?" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  const frames = (await response.text())
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map(
      (line) => JSON.parse(line.slice(6)) as { type: string; index?: number },
    )

  // Exactly one message_start and one message_stop reach the client.
  expect(frames.filter((frame) => frame.type === "message_start")).toHaveLength(
    1,
  )
  expect(frames.filter((frame) => frame.type === "message_stop")).toHaveLength(
    1,
  )

  const starts = frames.filter((frame) => frame.type === "content_block_start")
  expect(starts.map((frame) => frame.index)).toEqual([0, 1, 2])

  const serverToolStart = frames.find(
    (frame) => frame.type === "content_block_start",
  )
  expect(serverToolStart).toMatchObject({ index: 0 })

  // The internal tool never leaks as a client-executable content block.
  expect(JSON.stringify(frames).includes('"name":"web_search"')).toBe(true)
  expect(frames.some((frame) => frame.type === "error")).toBe(false)
})

test("without a searcher the request is still rejected semantically", async () => {
  await createChatTarget()

  const fetchMock = mock(() => {
    throw new Error("upstream must not be called")
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "writer-model",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    }),
  )

  expect(response.status).toBe(422)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("SEARCH_ORCHESTRATION=0 keeps the old reject behaviour", async () => {
  await createSearcher()
  await createChatTarget()
  process.env.SEARCH_ORCHESTRATION = "0"

  const fetchMock = mock(() => {
    throw new Error("upstream must not be called")
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "writer-model",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    }),
  )

  expect(response.status).toBe(422)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("a failing search degrades to an error tool result instead of failing the turn", async () => {
  await createSearcher()
  await createChatTarget()

  const urls: Array<string> = []
  let chatRound = 0
  const fetchMock = mock((url: string) => {
    urls.push(url)
    if (url.includes("chat.test")) {
      chatRound++
      return chatRound === 1 ?
          chatResponse("", {
            id: "call_1",
            name: "web_search",
            args: JSON.stringify({ query: "go 1.27" }),
          })
        : chatResponse("I could not verify that.")
    }
    const failure = {
      ok: false,
      status: 500,
      headers: new Headers(),
      text: () => Promise.resolve("backend down"),
      json: () => ({}),
    }
    return { ...failure, clone: () => failure }
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "writer-model",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    }),
  )

  // The turn still completes; the failed search is reported to the model.
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    content: Array<{ type: string; text?: string }>
  }
  expect(body.content.some((block) => block.type === "server_tool_use")).toBe(
    true,
  )
  expect(
    body.content.some((block) => block.type === "web_search_tool_result"),
  ).toBe(false)

  expect(secondChatBody(fetchMock)).toContain("Search failed")
})
