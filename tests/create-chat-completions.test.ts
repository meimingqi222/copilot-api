import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
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
