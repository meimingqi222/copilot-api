import { afterEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"
import type {
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

import { clearDevinUserJwtCacheForTest } from "~/services/windsurf/auth"
import {
  getWindsurfConcurrencySnapshot,
  resetWindsurfConcurrencyForTest,
} from "~/services/windsurf/concurrency"
import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"
import {
  ProtobufEncoder,
  encodeConnectFrame,
} from "~/services/windsurf/protobuf"

const originalFetch = globalThis.fetch
const originalTimeout = process.env.WINDSURF_FIRST_FRAME_TIMEOUT_MS
const originalRetries = process.env.WINDSURF_FIRST_FRAME_RETRIES
const originalJwtTtl = process.env.WINDSURF_USER_JWT_CACHE_TTL_MS

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

afterEach(() => {
  globalThis.fetch = originalFetch
  restoreEnv("WINDSURF_FIRST_FRAME_TIMEOUT_MS", originalTimeout)
  restoreEnv("WINDSURF_FIRST_FRAME_RETRIES", originalRetries)
  restoreEnv("WINDSURF_USER_JWT_CACHE_TTL_MS", originalJwtTtl)
  clearDevinUserJwtCacheForTest()
  resetWindsurfConcurrencyForTest()
})

function encodeAuthResponse(jwt: string): Uint8Array {
  const response = new ProtobufEncoder()
  response.writeString(1, jwt)
  return response.toUint8Array()
}

function encodeTextFrame(text: string): Uint8Array {
  const frame = new ProtobufEncoder()
  frame.writeString(3, text)
  return encodeConnectFrame(frame.toUint8Array(), false)
}

function createSlowBody(signal?: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        "abort",
        () => controller.error(new Error("upstream aborted")),
        { once: true },
      )
    },
  })
}

const account: Account = {
  id: "windsurf-timeout-account",
  label: "windsurf-timeout",
  provider: "windsurf",
  credentials: { apiKey: "windsurf-key" },
  settings: { baseUrl: "https://windsurf.test" },
  availableModels: [
    {
      id: "swe-test",
      name: "swe-test",
      vendor: "windsurf",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions"],
    },
  ],
  enabled: true,
  priority: 0,
  createdAt: Date.now(),
}

const payload: ChatCompletionsPayload = {
  model: "swe-test",
  messages: [{ role: "user", content: "hello" }],
  stream: true,
}

async function collectEvents(
  stream: AsyncIterable<CopilotStreamEvent>,
): Promise<Array<string>> {
  const values: Array<string> = []
  for await (const event of stream) {
    if (event.data) values.push(event.data)
  }
  return values
}

describe("Windsurf first-frame resilience", () => {
  test("cancels a silent response and retries before returning output", async () => {
    process.env.WINDSURF_FIRST_FRAME_TIMEOUT_MS = "15"
    process.env.WINDSURF_FIRST_FRAME_RETRIES = "1"
    process.env.WINDSURF_USER_JWT_CACHE_TTL_MS = "60000"
    let authCalls = 0
    let chatCalls = 0
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      const href = requestUrl(url)
      if (href.includes("GetUserJwt")) {
        authCalls++
        return Promise.resolve(new Response(encodeAuthResponse("jwt")))
      }
      chatCalls++
      if (chatCalls === 1) {
        return Promise.resolve(
          new Response(createSlowBody(init?.signal ?? undefined)),
        )
      }
      return Promise.resolve(new Response(encodeTextFrame("recovered")))
    }) as typeof fetch

    const result = await createWindsurfChatCompletionsOnce(account, payload)
    if (Symbol.asyncIterator in result) {
      const events = await collectEvents(result)
      expect(events.join("\n")).toContain("recovered")
    } else {
      throw new Error("expected a streaming response")
    }

    expect(chatCalls).toBe(2)
    expect(authCalls).toBe(1)
    expect(getWindsurfConcurrencySnapshot(account.id).active).toBe(0)
  })

  test("does not retry an error after the first output was exposed", async () => {
    process.env.WINDSURF_FIRST_FRAME_TIMEOUT_MS = "50"
    process.env.WINDSURF_FIRST_FRAME_RETRIES = "1"
    process.env.WINDSURF_USER_JWT_CACHE_TTL_MS = "60000"
    let chatCalls = 0
    globalThis.fetch = ((url: string | URL | Request) => {
      if (requestUrl(url).includes("GetUserJwt")) {
        return Promise.resolve(new Response(encodeAuthResponse("jwt")))
      }
      chatCalls++
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encodeTextFrame("visible"))
          setTimeout(() => controller.error(new Error("late failure")), 1)
        },
      })
      return Promise.resolve(new Response(body))
    }) as typeof fetch

    const result = await createWindsurfChatCompletionsOnce(account, payload)
    if (!(Symbol.asyncIterator in result)) {
      throw new Error("expected a streaming response")
    }
    let failure: unknown
    try {
      await collectEvents(result)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("late failure")
    expect(chatCalls).toBe(1)
    expect(getWindsurfConcurrencySnapshot(account.id).active).toBe(0)
  })
})
