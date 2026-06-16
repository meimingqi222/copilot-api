import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const originalAccounts = state.accounts
const originalActiveAccountIndex = state.activeAccountIndex
const originalModels = state.models
const originalApiKey = state.legacyApiKey
const originalVsCodeVersion = state.vsCodeVersion
const originalAccountType = state.accountType
beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  resetProtectedRouteGuardForTest()
  state.accounts = [
    {
      id: "test-account-id",
      label: "test",
      provider: "copilot",
      credentials: { githubToken: "gh-test-token" },
      runtimeState: { copilotToken: "test-token" },
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
    },
  ]
  state.activeAccountIndex = 0
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.legacyApiKey = undefined
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  globalThis.fetch = originalFetch
  state.accounts = originalAccounts
  state.activeAccountIndex = originalActiveAccountIndex
  state.models = originalModels
  state.legacyApiKey = originalApiKey
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

test("POST /v1/responses preserves X-Initiator when forwarding to Copilot", async () => {
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
    (
      url: string,
      opts: { body?: string; headers?: Record<string, string> },
    ) => ({
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
      headers: opts.headers ?? {},
    }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-initiator": "agent",
      },
      body: JSON.stringify({
        model: "gpt-responses",
        input: "hi",
      }),
    }),
  )

  expect(response.status).toBe(200)
  const [, options] = fetchMock.mock.calls[0] as [
    string,
    { body?: string; headers?: Record<string, string> },
  ]
  expect(options.headers?.["X-Initiator"]).toBe("agent")
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

test("POST /v1/responses keeps provider-qualified model bound during chat fallback", async () => {
  state.accounts = [
    {
      id: "codebuff-account-id",
      label: "codebuff",
      provider: "codebuff",
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
      credentials: { authToken: "cb-token" },
      settings: {
        baseUrl: "https://codebuff.example",
        cliVersion: "0.0.44",
        agentId: "cb-agent",
        model: "gpt-chat",
        costMode: "normal",
        allowFallbacks: false,
      },
      availableModels: [
        {
          id: "gpt-chat",
          name: "gpt-chat",
          vendor: "codebuff",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions"],
          provider: "codebuff",
        },
      ],
    },
    {
      id: "copilot-account-id",
      label: "copilot",
      provider: "copilot",
      credentials: { githubToken: "gh-test-token" },
      runtimeState: { copilotToken: "copilot-token" },
      enabled: true,
      priority: 1,
      isExhausted: false,
      createdAt: Date.now(),
      availableModels: [
        {
          id: "gpt-chat",
          name: "gpt-chat",
          vendor: "OpenAI",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions"],
          provider: "copilot",
        },
      ],
    },
  ]
  state.activeAccountIndex = 0
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
      {
        id: "codebuff/gpt-chat",
        object: "model",
        name: "GPT Chat (Codebuff)",
        preview: false,
        vendor: "codebuff",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          family: "codebuff",
          object: "capabilities",
          supports: {},
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  }

  const fetchMock = mock((url: string, opts?: { body?: string }) => {
    if (url.endsWith("/api/v1/agent-runs")) {
      const body = JSON.parse(opts?.body ?? "{}") as { action?: string }
      return {
        ok: true,
        json: () => (body.action === "START" ? { runId: "run-123" } : {}),
        text: () => Promise.resolve(""),
        status: 200,
        url,
      }
    }

    if (url.endsWith("/api/v1/chat/completions")) {
      return {
        ok: true,
        json: () => ({
          id: "chat_qualified",
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
      }
    }

    throw new Error(`Unexpected upstream URL: ${url}`)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codebuff/gpt-chat",
        input: "hi",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
    "https://codebuff.example/api/v1/agent-runs",
  )
  expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
    "https://codebuff.example/api/v1/chat/completions",
  )
  expect(
    JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as { body?: string }).body ?? "{}",
    ),
  ).toMatchObject({
    model: "gpt-chat",
    messages: [{ role: "user", content: "hi" }],
  })

  const body = await response.json()
  expect(body).toMatchObject({
    object: "response",
    output_text: "ok",
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

test("POST /v1/responses streaming sends ping while waiting for upstream response", async () => {
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
      new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(
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
        }, 5_200)
      }),
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
  expect(body).toContain(": keep-alive")
  expect(body.indexOf(": keep-alive")).toBeLessThan(
    body.indexOf("response.created"),
  )
}, 12_000)
