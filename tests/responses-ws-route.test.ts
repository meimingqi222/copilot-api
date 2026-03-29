import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { websocket } from "hono/bun"

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
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
    },
  ]
  state.activeAccountIndex = 0
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.apiKey = undefined
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

test("WS /responses supports sequential response.create requests", async () => {
  state.apiKey = "secret"

  const fetchMock = mock((_url: string, opts: { body?: string }) => {
    const payload = JSON.parse(opts.body ?? "{}") as {
      model?: string
      input?: string
    }

    return {
      ok: true,
      json: () => ({
        id: crypto.randomUUID(),
        object: "response",
        model: payload.model ?? "gpt-responses",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: payload.input ?? "ok" }],
          },
        ],
        output_text: payload.input ?? "ok",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
      }),
      text: () => Promise.resolve(""),
      status: 200,
    }
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  using appServer = Bun.serve({
    port: 0,
    fetch: server.fetch,
    websocket,
  })

  const { ws, queue } = await openSocket(
    `ws://localhost:${appServer.port}/responses`,
    { Authorization: "Bearer secret" },
  )

  ws.send(
    JSON.stringify({
      type: "response.create",
      response: {
        model: "gpt-responses",
        input: "first",
      },
    }),
  )
  const first = JSON.parse(await queue.next()) as {
    object: string
    output_text: string
  }
  expect(first.object).toBe("response")
  expect(first.output_text).toBe("first")

  ws.send(
    JSON.stringify({
      type: "response.create",
      response: {
        model: "gpt-responses",
        input: "second",
      },
    }),
  )
  const second = JSON.parse(await queue.next()) as {
    object: string
    output_text: string
  }
  expect(second.object).toBe("response")
  expect(second.output_text).toBe("second")

  ws.close()
})

test("WS /v1/responses handshake requires API key middleware", async () => {
  state.apiKey = "secret"

  using appServer = Bun.serve({
    port: 0,
    fetch: server.fetch,
    websocket,
  })

  const response = await fetch(
    `http://localhost:${appServer.port}/v1/responses`,
    {
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    },
  )

  expect(response.status).toBe(401)
})

test("WS /v1/responses returns busy error on concurrent response.create", async () => {
  const fetchMock = mock(
    () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(
            new Response(
              [
                'data: {"type":"response.created","response":{"id":"resp_123","model":"gpt-responses","status":"in_progress"}}',
                "",
                'data: {"type":"response.completed","response":{"id":"resp_123","object":"response","model":"gpt-responses","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"output_text":"ok","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
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
        }, 80)
      }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  using appServer = Bun.serve({
    port: 0,
    fetch: server.fetch,
    websocket,
  })

  const { ws, queue } = await openSocket(
    `ws://localhost:${appServer.port}/v1/responses`,
  )

  ws.send(
    JSON.stringify({
      type: "response.create",
      response: {
        model: "gpt-responses",
        input: "first",
        stream: true,
      },
    }),
  )

  ws.send(
    JSON.stringify({
      type: "response.create",
      response: {
        model: "gpt-responses",
        input: "second",
      },
    }),
  )

  let sawBusy = false
  let sawCompleted = false

  for (let i = 0; i < 6 && (!sawBusy || !sawCompleted); i += 1) {
    const message = JSON.parse(await queue.next(4_000)) as {
      type?: string
      error?: {
        code?: string
      }
    }

    if (message.type === "error" && message.error?.code === "busy") {
      sawBusy = true
    }

    if (message.type === "response.completed") {
      sawCompleted = true
    }
  }

  expect(sawBusy).toBe(true)
  expect(sawCompleted).toBe(true)

  ws.close()
})

test("WS /v1/responses forwards upstream errors as error events", async () => {
  const fetchMock = mock(
    () =>
      new Response("upstream failed", {
        status: 500,
      }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  using appServer = Bun.serve({
    port: 0,
    fetch: server.fetch,
    websocket,
  })

  const { ws, queue } = await openSocket(
    `ws://localhost:${appServer.port}/v1/responses`,
  )

  ws.send(
    JSON.stringify({
      type: "response.create",
      response: {
        model: "gpt-responses",
        input: "hi",
      },
    }),
  )

  const message = JSON.parse(await queue.next()) as {
    type: string
    error: {
      message: string
      type: string
    }
  }

  expect(message.type).toBe("error")
  expect(message.error.type).toBe("error")
  expect(message.error.message).toContain("upstream failed")

  ws.close()
})

interface SocketQueue {
  next: (timeoutMs?: number) => Promise<string>
}

async function openSocket(
  url: string,
  headers?: Record<string, string>,
): Promise<{
  ws: WebSocket
  queue: SocketQueue
}> {
  const ws = new WebSocket(url, { headers })
  const queue = createSocketQueue(ws)

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for websocket open"))
    }, 2_000)

    ws.addEventListener("open", () => {
      clearTimeout(timeout)
      resolve()
    })

    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      reject(new Error("WebSocket failed to connect"))
    })
  })

  return { ws, queue }
}

function createSocketQueue(ws: WebSocket): SocketQueue {
  const buffered: Array<string> = []
  const waiters: Array<(value: string) => void> = []

  ws.addEventListener(
    "message",
    (event: MessageEvent<string | Blob | ArrayBuffer>) => {
      void toText(event.data).then((text) => {
        const waiter = waiters.shift()
        if (waiter) {
          waiter(text)
          return
        }

        buffered.push(text)
      })
    },
  )

  return {
    next(timeoutMs = 2_000) {
      if (buffered.length > 0) {
        return Promise.resolve(buffered.shift() ?? "")
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(resolve)
          if (index !== -1) {
            waiters.splice(index, 1)
          }
          reject(new Error("Timed out waiting for websocket message"))
        }, timeoutMs)

        waiters.push((value) => {
          clearTimeout(timeout)
          resolve(value)
        })
      })
    },
  }
}

async function toText(data: string | Blob | ArrayBuffer): Promise<string> {
  if (typeof data === "string") {
    return data
  }

  if (data instanceof Blob) {
    return await data.text()
  }

  return Buffer.from(data).toString("utf8")
}
