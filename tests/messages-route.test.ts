import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { listAccounts } from "~/lib/legacy-accounts"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

import { setTestAccounts } from "./helpers/set-accounts"

const originalFetch = globalThis.fetch
const originalAccounts = listAccounts()
const originalModels = state.models
const originalApiKey = state.legacyApiKey
const originalVsCodeVersion = state.vsCodeVersion
const originalAccountType = state.accountType
beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  resetProtectedRouteGuardForTest()
  setTestAccounts([
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
  ])
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.legacyApiKey = undefined
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  globalThis.fetch = originalFetch
  setTestAccounts(originalAccounts)
  state.models = originalModels
  state.legacyApiKey = originalApiKey
  state.vsCodeVersion = originalVsCodeVersion
  state.accountType = originalAccountType
})

test("POST /v1/messages routes messages-capable models to upstream /v1/messages", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-sonnet-4",
        object: "model",
        name: "Claude Sonnet 4",
        preview: false,
        vendor: "Anthropic",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages", "/chat/completions"],
        capabilities: {
          family: "claude",
          object: "capabilities",
          supports: {},
          tokenizer: "claude",
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
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }),
      text: () => Promise.resolve(""),
      status: 200,
      headers: opts.headers ?? {},
      url,
    }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  const [url, options] = fetchMock.mock.calls[0] as [
    string,
    { body?: string; headers?: Record<string, string> },
  ]
  expect(url).toContain("/v1/messages")
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "hi" }],
  })
  expect(options.headers?.["anthropic-version"]).toBe("2023-06-01")

  const body = await response.json()
  expect(body).toMatchObject({
    type: "message",
    model: "claude-sonnet-4",
  })
})

test("POST /v1/messages preserves X-Initiator when forwarding to Copilot", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-sonnet-4",
        object: "model",
        name: "Claude Sonnet 4",
        preview: false,
        vendor: "Anthropic",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages", "/chat/completions"],
        capabilities: {
          family: "claude",
          object: "capabilities",
          supports: {},
          tokenizer: "claude",
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
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }),
      text: () => Promise.resolve(""),
      status: 200,
      headers: opts.headers ?? {},
      url,
    }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-initiator": "agent",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
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

test("POST /v1/messages strips provider prefix before forwarding upstream", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-sonnet-4",
        object: "model",
        name: "Claude Sonnet 4",
        preview: false,
        vendor: "Anthropic",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages", "/chat/completions"],
        capabilities: {
          family: "claude",
          object: "capabilities",
          supports: {},
          tokenizer: "claude",
          type: "chat",
        },
      },
      {
        id: "copilot/claude-sonnet-4",
        object: "model",
        name: "Claude Sonnet 4",
        preview: false,
        vendor: "Anthropic",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages", "/chat/completions"],
        capabilities: {
          family: "claude",
          object: "capabilities",
          supports: {},
          tokenizer: "claude",
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
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }),
      text: () => Promise.resolve(""),
      status: 200,
      headers: opts.headers ?? {},
      url,
    }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "copilot/claude-sonnet-4",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  const [, options] = fetchMock.mock.calls[0] as [
    string,
    { body?: string; headers?: Record<string, string> },
  ]
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "hi" }],
  })
})
