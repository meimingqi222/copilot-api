import { afterEach, expect, mock, test } from "bun:test"

import type {
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { statsStore } from "../src/lib/stats-store"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import { setTestAccounts } from "./helpers/set-accounts"

// Mock state with an active account
const mockAccount = {
  id: "test-account-id",
  label: "test",
  provider: "copilot" as const,
  credentials: { githubToken: "gh-test-token" },
  runtimeState: { copilotToken: "test-token" },
  enabled: true,
  priority: 0,
  isExhausted: false,
  createdAt: Date.now(),
}
setTestAccounts([mockAccount])
state.activeAccountIndex = 0
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const originalProviderDefaults = structuredClone(state.providerDefaults)

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  state.providerDefaults = originalProviderDefaults
})

// Helper to mock fetch
const fetchMock = mock(
  (url: string, opts: { headers: Record<string, string>; body?: string }) => {
    return {
      ok: true,
      json: () =>
        url.endsWith("/responses") ?
          {
            id: "resp_123",
            model: "gpt-responses",
            output: [
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "thinking..." }],
              },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
          }
        : { id: "123", object: "chat.completion", choices: [] },
      headers: opts.headers,
    }
  },
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

function createWithSelectedAccount(
  payload: ChatCompletionsPayload,
  options?: {
    signal?: AbortSignal
    initiatorOverride?: "agent" | "user"
  },
) {
  const account = state.accounts.at(0)
  if (!account) {
    throw new Error("Expected at least one account in test state")
  }
  return createChatCompletions(payload, {
    account,
    ...options,
  })
}

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createWithSelectedAccount(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createWithSelectedAccount(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("sets X-Initiator to user when last message is user", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow-up question" },
    ],
    model: "gpt-test",
  }
  await createWithSelectedAccount(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[2][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("ignores system and developer when inferring X-Initiator", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "system", content: "system prompt" },
      { role: "developer", content: "developer prompt" },
      { role: "assistant", content: "internal planning" },
    ],
    model: "gpt-test",
  }
  await createWithSelectedAccount(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[3][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("uses initiator override when provided", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }
  await createWithSelectedAccount(payload, { initiatorOverride: "agent" })
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[4][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("routes responses-only models to /responses", async () => {
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

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-responses",
    max_tokens: 64,
    reasoning_effort: "medium",
  }

  const result = await createWithSelectedAccount(payload)
  const [url, options] = fetchMock.mock.calls[5] as [
    string,
    { body?: string; headers: Record<string, string> },
  ]
  expect(url).toContain("/responses")
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "gpt-responses",
    input: [{ role: "user", content: "hi" }],
    max_output_tokens: 64,
    reasoning: { summary: "auto" },
  })

  if ("choices" in result.response) {
    expect(result.response.choices[0]?.message.reasoning_content).toBe(
      "thinking...",
    )
    expect(result.response.choices[0]?.message.content).toEqual([
      { type: "reasoning", text: "thinking..." },
      { type: "output_text", text: "ok" },
    ])
    return
  }

  throw new Error("Expected non-streaming response")
})

test("strips copilot prefix before forwarding qualified chat models upstream", async () => {
  setTestAccounts([
    {
      id: "copilot-qualified-account",
      label: "copilot-qualified",
      provider: "copilot",
      credentials: { githubToken: "gh-test-token" },
      runtimeState: { copilotToken: "test-token" },
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
      availableModels: [
        {
          id: "gpt-test",
          name: "gpt-test",
          vendor: "OpenAI",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions"],
          provider: "copilot",
        },
      ],
    },
  ])
  state.activeAccountIndex = 0

  const localFetchMock = mock((url: string, opts?: { body?: string }) => ({
    ok: true,
    json: () => ({
      id: "chatcmpl-qualified",
      object: "chat.completion",
      created: 1,
      model: "gpt-test",
      choices: [],
    }),
    url,
    opts,
  }))
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    localFetchMock as unknown as typeof fetch

  await createWithSelectedAccount({
    model: "copilot/gpt-test",
    messages: [{ role: "user", content: "hello" }],
  })

  const [, options] = localFetchMock.mock.calls[0] as [
    string,
    { body?: string },
  ]
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "gpt-test",
  })

  setTestAccounts([mockAccount])
  state.activeAccountIndex = 0
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

test("codebuff account sends start/chat/finish workflow", async () => {
  state.providerDefaults.codebuff.baseUrl = "https://www.codebuff.com"
  state.providerDefaults.codebuff.authToken = "global-cb-token"
  state.providerDefaults.codebuff.cliVersion = "0.0.33"
  state.providerDefaults.codebuff.agentId = "base"
  state.providerDefaults.codebuff.model = "z-ai/glm-5.1"
  state.providerDefaults.codebuff.costMode = "normal"
  state.providerDefaults.codebuff.allowFallbacks = true
  setTestAccounts([
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
        baseUrl: "https://www.codebuff.com",
        cliVersion: "0.0.44",
        agentId: "cb-agent",
        costMode: "fast",
        allowFallbacks: false,
      },
      availableModels: [
        {
          id: "z-ai/glm-5.1",
          name: "z-ai/glm-5.1",
          vendor: "codebuff",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions"],
        },
      ],
    },
  ])
  state.activeAccountIndex = 0

  const localFetchMock = mock((url: string, opts?: { body?: string }) => {
    if (url.endsWith("/api/v1/agent-runs")) {
      const body = JSON.parse(opts?.body ?? "{}") as { action?: string }
      if (body.action === "START") {
        return {
          ok: true,
          json: () => ({ runId: "run-123" }),
        }
      }
      return {
        ok: true,
        json: () => ({}),
      }
    }

    return {
      ok: true,
      json: () => ({
        id: "chatcmpl-codebuff",
        object: "chat.completion",
        model: "z-ai/glm-5.1",
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
      }),
    }
  })

  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    localFetchMock as unknown as typeof fetch

  const result = await createWithSelectedAccount({
    model: "z-ai/glm5",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  })

  expect(result.accountId).toBe("codebuff-account-id")
  expect(localFetchMock).toHaveBeenCalledTimes(3)

  const startHeaders = (
    localFetchMock.mock.calls[0]?.[1] as {
      headers?: Record<string, string>
    }
  ).headers
  expect(startHeaders?.["User-Agent"]).toContain("0.0.44") // Account-level config

  const startBody = JSON.parse(
    (localFetchMock.mock.calls[0]?.[1] as { body?: string }).body ?? "{}",
  ) as Record<string, unknown>
  expect(startBody.action).toBe("START")
  expect(startBody.agentId).toBe("cb-agent") // Account-level config

  const chatBody = JSON.parse(
    (localFetchMock.mock.calls[1]?.[1] as { body?: string }).body ?? "{}",
  ) as Record<string, unknown>
  expect(chatBody.codebuff_metadata).toBeDefined()
  expect(chatBody.provider).toEqual({ allow_fallbacks: false }) // Account-level config
  expect((chatBody.codebuff_metadata as { cost_mode?: string }).cost_mode).toBe(
    "fast", // Account-level config
  )

  const finishBody = JSON.parse(
    (localFetchMock.mock.calls[2]?.[1] as { body?: string }).body ?? "{}",
  ) as Record<string, unknown>
  expect(finishBody.action).toBe("FINISH")
  expect(finishBody.runId).toBe("run-123")

  setTestAccounts([mockAccount])
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

test("codebuff streaming still triggers finish agent run", async () => {
  state.providerDefaults.codebuff.baseUrl = "https://www.codebuff.com"
  state.providerDefaults.codebuff.authToken = "global-cb-token"
  state.providerDefaults.codebuff.cliVersion = "0.0.33"
  state.providerDefaults.codebuff.agentId = "base"
  state.providerDefaults.codebuff.model = "z-ai/glm-5.1"
  state.providerDefaults.codebuff.costMode = "normal"
  state.providerDefaults.codebuff.allowFallbacks = true
  setTestAccounts([
    {
      id: "codebuff-stream-account-id",
      label: "codebuff-stream",
      provider: "codebuff",
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
      credentials: { authToken: "cb-token" },
      availableModels: [
        {
          id: "z-ai/glm-5.1",
          name: "z-ai/glm-5.1",
          vendor: "codebuff",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions"],
        },
      ],
    },
  ])
  state.activeAccountIndex = 0

  const localFetchMock = mock((url: string, opts?: { body?: string }) => {
    if (url.endsWith("/api/v1/agent-runs")) {
      const body = JSON.parse(opts?.body ?? "{}") as { action?: string }
      if (body.action === "START") {
        return {
          ok: true,
          json: () => ({ runId: "run-stream" }),
        }
      }
      return {
        ok: true,
        json: () => ({}),
      }
    }

    const stream = {
      async *[Symbol.asyncIterator](): AsyncIterableIterator<CopilotStreamEvent> {
        await Promise.resolve()
        yield {
          data: JSON.stringify({
            id: "chunk-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "z-ai/glm-5.1",
            choices: [
              {
                index: 0,
                delta: { content: "你" },
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
        }
        yield { data: "[DONE]" }
      },
    }

    return {
      ok: true,
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream),
    }
  })

  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    localFetchMock as unknown as typeof fetch

  const result = await createWithSelectedAccount({
    model: "z-ai/glm-5.1",
    messages: [{ role: "user", content: "stream" }],
    stream: true,
  })

  if ("choices" in result.response) {
    throw new Error("Expected streaming response")
  }

  for await (const _event of result.response) {
    // consume stream to trigger finally
  }

  expect(localFetchMock).toHaveBeenCalledTimes(3)
  const finishBody = JSON.parse(
    (localFetchMock.mock.calls[2]?.[1] as { body?: string }).body ?? "{}",
  ) as Record<string, unknown>
  expect(finishBody.action).toBe("FINISH")
  expect(finishBody.runId).toBe("run-stream")

  setTestAccounts([mockAccount])
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})
