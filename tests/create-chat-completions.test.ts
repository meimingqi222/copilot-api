import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// Mock state with an active account
const mockAccount = {
  id: "test-account-id",
  label: "test",
  githubToken: "gh-test-token",
  copilotToken: "test-token",
  enabled: true,
  isExhausted: false,
  createdAt: Date.now(),
}
state.accounts = [mockAccount]
state.activeAccountIndex = 0
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

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

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
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
  await createChatCompletions(payload)
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
  await createChatCompletions(payload)
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
  await createChatCompletions(payload)
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
  await createChatCompletions(payload, undefined, "agent")
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

  const result = await createChatCompletions(payload)
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
