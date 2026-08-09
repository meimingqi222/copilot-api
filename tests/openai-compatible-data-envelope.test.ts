import { afterEach, expect, test } from "bun:test"

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"

import { openAICompatibleAdapter } from "~/services/protocols/openai-compatible"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const connection: ProviderConnection = {
  id: "conn-1",
  name: "test",
  protocol: "openai-compatible",
  baseUrl: "https://upstream.test/v1",
  enabled: true,
  priority: 0,
  credentials: [],
  createdAt: 0,
}

const credential: ApiCredential = {
  id: "cred-1",
  authMode: "bearer",
  value: "sk-test",
  enabled: true,
  status: "ready",
  createdAt: 0,
}

function routeTarget(
  upstreamModelId: string,
  endpoint: RouteTarget["endpoint"],
): RouteTarget {
  return {
    connectionId: connection.id,
    connectionName: connection.name,
    protocol: "openai-compatible",
    credentialId: credential.id,
    publicModelId: upstreamModelId,
    upstreamModelId,
    endpoint,
    connectionPriority: 0,
    connectionWeight: 1,
    credentialPriority: 0,
    credentialWeight: 1,
  }
}

function mockJson(body: unknown): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch
}

const standardEmbeddings = {
  object: "list",
  data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 3, total_tokens: 3 },
}

const standardChat = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hi" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

async function callEmbeddings() {
  return openAICompatibleAdapter.createEmbeddings?.({
    target: routeTarget("text-embedding-3-small", "embeddings"),
    connection,
    credential,
    payload: { model: "text-embedding-3-small", input: "hello" },
  })
}

async function callChat() {
  return openAICompatibleAdapter.createChatCompletions?.({
    target: routeTarget("gpt-4o", "chat"),
    connection,
    credential,
    payload: { model: "gpt-4o", messages: [], stream: false },
  })
}

// The standard embeddings response has a top-level `data` array of its own.
// Unwrapping it as if it were a `{ data: ... }` envelope drops `model` and
// `usage`, and the embeddings route reads `usage.prompt_tokens` unguarded.
test("standard embeddings response is not mistaken for a data envelope", async () => {
  mockJson(standardEmbeddings)
  const result = await callEmbeddings()
  expect(result?.response.model).toBe("text-embedding-3-small")
  expect(result?.response.usage.total_tokens).toBe(3)
  expect(result?.response.data).toHaveLength(1)
})

test("data-wrapped embeddings response is unwrapped", async () => {
  mockJson({ data: standardEmbeddings })
  const result = await callEmbeddings()
  expect(result?.response.model).toBe("text-embedding-3-small")
  expect(result?.response.usage.total_tokens).toBe(3)
  expect(result?.response.data).toHaveLength(1)
})

test("standard chat response is returned unchanged", async () => {
  mockJson(standardChat)
  const result = await callChat()
  const response = result?.response as typeof standardChat
  expect(response.id).toBe("chatcmpl-1")
  expect(response.choices).toHaveLength(1)
})

test("data-wrapped chat response is unwrapped", async () => {
  mockJson({ data: standardChat })
  const result = await callChat()
  const response = result?.response as typeof standardChat
  expect(response.id).toBe("chatcmpl-1")
  expect(response.choices[0]?.message.content).toBe("hi")
})

// A `data` field that is not an envelope (null, a scalar, or an unrelated
// object) must leave the body alone rather than replacing it.
test("unrelated top-level data field does not replace the body", async () => {
  mockJson({ ...standardChat, data: null })
  const result = await callChat()
  const response = result?.response as typeof standardChat
  expect(response.choices).toHaveLength(1)
})
