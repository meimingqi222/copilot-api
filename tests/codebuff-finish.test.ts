import { afterEach, describe, expect, mock, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import { createCodebuffChatCompletionsOnce } from "~/services/codebuff/create-chat-completions"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Codebuff agent run cleanup", () => {
  test("returns the main non-stream response when FINISH fails", async () => {
    const account: Account = {
      id: "codebuff-1",
      label: "codebuff",
      provider: "codebuff",
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
      credentials: { authToken: "token" },
      settings: {
        baseUrl: "https://codebuff.test",
        cliVersion: "1.0.0",
        agentId: "agent",
        model: "model-1",
        costMode: "normal",
        allowFallbacks: true,
      },
    }
    const fetchMock = mock((url: string, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}"
      const body = JSON.parse(rawBody) as {
        action?: string
      }
      if (url.endsWith("/api/v1/agent-runs") && body.action === "START") {
        return Promise.resolve(
          new Response(JSON.stringify({ runId: "run-1" }), { status: 200 }),
        )
      }
      if (url.endsWith("/api/v1/agent-runs") && body.action === "FINISH") {
        return Promise.resolve(new Response("cleanup failed", { status: 500 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "model-1",
            choices: [],
          }),
          { status: 200 },
        ),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await createCodebuffChatCompletionsOnce(account, {
      model: "model-1",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    })

    expect(result).toMatchObject({ id: "chatcmpl-1" })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe("Codebuff agent run id shape", () => {
  test("accepts snake_case run_id from the upstream START response", async () => {
    const account: Account = {
      id: "codebuff-1",
      label: "codebuff",
      provider: "codebuff",
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
      credentials: { authToken: "token" },
      settings: {
        baseUrl: "https://codebuff.test",
        cliVersion: "1.0.0",
        agentId: "agent",
        model: "model-1",
        costMode: "normal",
        allowFallbacks: true,
      },
    }
    const fetchMock = mock((url: string, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}"
      const body = JSON.parse(rawBody) as { action?: string }
      if (url.endsWith("/api/v1/agent-runs") && body.action === "START") {
        // Python-style upstream returns snake_case.
        return Promise.resolve(
          new Response(JSON.stringify({ run_id: "run-snake-1" }), {
            status: 200,
          }),
        )
      }
      if (url.endsWith("/api/v1/agent-runs") && body.action === "FINISH") {
        const finishBody = JSON.parse(rawBody) as { runId?: string }
        expect(finishBody.runId).toBe("run-snake-1")
        return Promise.resolve(new Response("ok", { status: 200 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "model-1",
            choices: [],
          }),
          { status: 200 },
        ),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await createCodebuffChatCompletionsOnce(account, {
      model: "model-1",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    })

    expect(result).toMatchObject({ id: "chatcmpl-1" })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
