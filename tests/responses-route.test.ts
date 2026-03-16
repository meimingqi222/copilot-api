import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const originalAccounts = state.accounts
const originalActiveAccountIndex = state.activeAccountIndex
const originalModels = state.models
const originalApiKey = state.apiKey
const originalVsCodeVersion = state.vsCodeVersion
const originalAccountType = state.accountType

beforeEach(() => {
  state.accounts = [
    {
      id: "test-account-id",
      label: "test",
      githubToken: "gh-test-token",
      copilotToken: "test-token",
      enabled: true,
      isExhausted: false,
      createdAt: Date.now(),
    },
  ]
  state.activeAccountIndex = 0
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.apiKey = undefined
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.accounts = originalAccounts
  state.activeAccountIndex = originalActiveAccountIndex
  state.models = originalModels
  state.apiKey = originalApiKey
  state.vsCodeVersion = originalVsCodeVersion
  state.accountType = originalAccountType
})

test("POST /v1/responses routes responses-capable models to upstream /responses", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-responses",
        object: "model",
        name: "GPT Responses",
        preview: false,
        vendor: "OpenAI",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "gpt-5",
          object: "capabilities",
          supports: {},
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  }

  const fetchMock = mock((url: string, opts: { body?: string }) => ({
    ok: true,
    json: () => ({
      id: "resp_123",
      object: "response",
      model: "gpt-responses",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
      output_text: "ok",
    }),
    text: () => Promise.resolve(""),
    status: 200,
    url,
    headers: opts,
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-responses",
        input: "hi",
      }),
    }),
  )

  expect(response.status).toBe(200)
  const [url, options] = fetchMock.mock.calls[0] as [string, { body?: string }]
  expect(url).toContain("/responses")
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "gpt-responses",
    input: "hi",
  })

  const body = await response.json()
  expect(body).toMatchObject({
    object: "response",
    output_text: "ok",
  })
})

test("POST /v1/responses falls back to chat completions when model lacks /responses", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-chat",
        object: "model",
        name: "GPT Chat",
        preview: false,
        vendor: "OpenAI",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          family: "gpt-5",
          object: "capabilities",
          supports: {},
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  }

  const fetchMock = mock((url: string, opts: { body?: string }) => ({
    ok: true,
    json: () => ({
      id: "chat_123",
      object: "chat.completion",
      created: 1,
      model: "gpt-chat",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "ok",
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }),
    text: () => Promise.resolve(""),
    status: 200,
    url,
    headers: opts,
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-chat",
        input: "hi",
      }),
    }),
  )

  expect(response.status).toBe(200)
  const [url, options] = fetchMock.mock.calls[0] as [string, { body?: string }]
  expect(url).toContain("/chat/completions")
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "gpt-chat",
    messages: [{ role: "user", content: "hi" }],
  })

  const body = await response.json()
  expect(body).toMatchObject({
    object: "response",
    output_text: "ok",
    model: "gpt-chat",
  })
})

test("POST /v1/responses streaming ignores terminal [DONE] frame", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-responses",
        object: "model",
        name: "GPT Responses",
        preview: false,
        vendor: "OpenAI",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "gpt-5",
          object: "capabilities",
          supports: {},
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  }

  const fetchMock = mock(
    () =>
      new Response(
        [
          'data: {"type":"response.created","response":{"id":"resp_123","model":"gpt-responses","status":"in_progress"}}',
          "",
          'data: {"type":"response.completed","response":{"id":"resp_123","object":"response","model":"gpt-responses","status":"completed","output_text":"ok","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-responses",
        input: "hi",
        stream: true,
      }),
    }),
  )

  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain("response.created")
  expect(body).toContain("response.completed")
})
