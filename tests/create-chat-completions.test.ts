import { afterEach, expect, mock, test } from "bun:test"

import type { ProviderAdmission } from "~/lib/request-admission"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/protocols/chat/types"

import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { resolveConnectionFromTarget } from "~/lib/route-target"
import { buildRouteTargets } from "~/lib/route-target/build"
import { resolveModelRouting } from "~/lib/route-target/model-reference"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { dispatchRequest } from "~/services/dispatch/shared"

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
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const originalProviderDefaults = structuredClone(state.providerDefaults)

afterEach(() => {
  resetAdaptiveRateLimiterForTest()
  statsStore.clearUsageStatsForTest()
  state.providerDefaults = structuredClone(originalProviderDefaults)
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

/**
 * Dispatch a chat request through the real routing layer so the test covers
 * endpoint selection as well as the adapter call.
 */
function dispatchChat(
  payload: ChatCompletionsPayload,
): ReturnType<typeof dispatchRequest> {
  // Mirrors request-admission: aliases are resolved before candidates are built.
  const routing = resolveModelRouting(payload.model)
  const target = buildRouteTargets({
    connectionId: routing.connectionId,
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    aliasRestriction: routing.aliasRestriction,
    endpoint: "chat",
  }).at(0)
  if (!target) {
    throw new Error(`No route target for "${payload.model}"`)
  }
  const resolved = resolveConnectionFromTarget(target)
  if (!resolved) {
    throw new Error(`Route target for "${payload.model}" did not resolve`)
  }
  const admission: ProviderAdmission = {
    target,
    connection: resolved.connection,
    credential: resolved.credential,
    initiator: "user",
  }
  return dispatchRequest({ routeKind: "chat", payload }, admission)
}

test("routes responses-only models to /responses", async () => {
  setTestAccounts([
    {
      ...mockAccount,
      availableModels: [
        {
          id: "gpt-responses",
          name: "GPT Responses",
          vendor: "OpenAI",
          pickerEnabled: true,
          supportedEndpoints: ["/responses"],
          provider: "copilot",
        },
      ],
    },
  ])

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-responses",
    max_tokens: 64,
    reasoning_effort: "medium",
  }

  const result = await dispatchChat(payload)
  const [url, options] = fetchMock.mock.calls[0] as [
    string,
    { body?: string; headers: Record<string, string> },
  ]
  expect(url).toContain("/responses")
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "gpt-responses",
    max_output_tokens: 64,
    reasoning: { effort: "medium", summary: "auto" },
  })

  if ("choices" in result.response) {
    const response = result.response as ChatCompletionResponse
    expect(response.choices[0]?.message.content).toContain("ok")
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

  await dispatchChat({
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

  const result = await dispatchChat({
    model: "z-ai/glm-5.1",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  })

  expect(result.identity.connectionId).toBe("codebuff-account-id")
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
      async *[Symbol.asyncIterator](): AsyncIterableIterator<{
        data?: string
      }> {
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

  const result = await dispatchChat({
    model: "z-ai/glm-5.1",
    messages: [{ role: "user", content: "stream" }],
    stream: true,
  })

  if ("choices" in result.response) {
    throw new Error("Expected streaming response")
  }

  const stream = result.response as AsyncIterable<{ data?: string }>
  for await (const _event of stream) {
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
