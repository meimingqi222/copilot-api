import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"

import { clearDevinUserJwtCacheForTest } from "~/services/windsurf/auth"
import { logger } from "~/lib/logger"
import {
  getWindsurfConcurrencySnapshot,
  resetWindsurfConcurrencyForTest,
} from "~/services/windsurf/concurrency"
import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"
import {
  ProtobufEncoder,
  encodeConnectFrame,
} from "~/services/windsurf/protobuf"
import { loopbackTest } from "./helpers/loopback-test"

const originalFetch = globalThis.fetch
const originalTimeout = process.env.WINDSURF_FIRST_FRAME_TIMEOUT_MS
const originalRetries = process.env.WINDSURF_FIRST_FRAME_RETRIES
const originalJwtTtl = process.env.WINDSURF_USER_JWT_CACHE_TTL_MS
const originalIdleTimeout = process.env.WINDSURF_STREAM_IDLE_TIMEOUT_MS
let logLevel = logger.level
const diagnosticLogs: Array<{ type: string; args: Array<unknown> }> = []
const reporter = {
  log(entry: { type: string; args: Array<unknown> }) {
    if (
      entry.args[1]
      && typeof entry.args[1] === "object"
      && "requestId" in entry.args[1]
    ) {
      diagnosticLogs.push({ type: entry.type, args: [...entry.args] })
    }
  },
}

beforeEach(() => {
  logLevel = logger.level
  logger.level = 3
  diagnosticLogs.length = 0
  logger.addReporter(reporter)
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

afterEach(() => {
  logger.removeReporter(reporter)
  logger.level = logLevel
  globalThis.fetch = originalFetch
  restoreEnv("WINDSURF_FIRST_FRAME_TIMEOUT_MS", originalTimeout)
  restoreEnv("WINDSURF_FIRST_FRAME_RETRIES", originalRetries)
  restoreEnv("WINDSURF_USER_JWT_CACHE_TTL_MS", originalJwtTtl)
  restoreEnv("WINDSURF_STREAM_IDLE_TIMEOUT_MS", originalIdleTimeout)
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

function createSlowBody(
  signal?: AbortSignal,
  firstChunk?: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstChunk) controller.enqueue(firstChunk)
      signal?.addEventListener(
        "abort",
        () => controller.error(new Error("upstream aborted")),
        { once: true },
      )
    },
  })
}

const credential: ApiCredential = {
  id: "windsurf-timeout-account",
  authMode: "bearer",
  value: "windsurf-key",
  enabled: true,
  status: "ready",
  createdAt: Date.now(),
}

const connection: ProviderConnection = {
  id: "windsurf-timeout-account",
  name: "windsurf-timeout",
  protocol: "windsurf-native",
  baseUrl: "",
  enabled: true,
  priority: 0,
  createdAt: Date.now(),
  metadata: {
    provider: "windsurf",
    settings: { baseUrl: "https://windsurf.test" },
  },
  models: [
    {
      publicId: "swe-test",
      upstreamId: "swe-test",
      name: "swe-test",
      vendor: "windsurf",
      pickerEnabled: true,
      endpoints: ["chat"],
      enabled: true,
    },
  ],
  credentials: [credential],
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
  for (const stream of [false, true]) {
    for (const stage of [
      "auth",
      "headers",
      "error-body",
      "first-frame",
      "partial-frame",
      "metadata-only",
      "mid-stream",
    ] as const) {
      test(`bounds ${stage} stalls and frees the account (stream=${stream})`, async () => {
        process.env.WINDSURF_FIRST_FRAME_TIMEOUT_MS = "20"
        process.env.WINDSURF_STREAM_IDLE_TIMEOUT_MS = "20"
        process.env.WINDSURF_FIRST_FRAME_RETRIES =
          stage === "mid-stream" ? "1" : "0"
        let aborted = false
        let healthy = false
        let chatCalls = 0
        globalThis.fetch = (async (
          url: string | URL | Request,
          init?: RequestInit,
        ) => {
          const auth = requestUrl(url).includes("GetUserJwt")
          if (!auth) chatCalls++
          if (healthy)
            return new Response(
              auth ? encodeAuthResponse("jwt") : encodeTextFrame("recovered"),
            )
          const signal = init?.signal
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true
            },
            { once: true },
          )
          if ((auth && stage === "auth") || (!auth && stage === "headers")) {
            return await new Promise<Response>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              })
            })
          }
          if (auth) return new Response(encodeAuthResponse("jwt"))
          if (stage === "mid-stream") {
            const first = encodeTextFrame("partial")
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(first)
                  signal?.addEventListener(
                    "abort",
                    () => controller.error(signal.reason),
                    { once: true },
                  )
                },
              }),
            )
          }
          const metadata = new ProtobufEncoder()
          metadata.writeString(100, "private upstream metadata")
          const chunk =
            stage === "partial-frame" ? new Uint8Array([0])
            : stage === "metadata-only" ?
              encodeConnectFrame(metadata.toUint8Array(), false)
            : undefined
          return new Response(createSlowBody(signal ?? undefined, chunk), {
            status: stage === "error-body" ? 503 : 200,
          })
        }) as typeof fetch

        const run = async () => {
          const result = await createWindsurfChatCompletionsOnce(
            { connection, credential },
            { ...payload, stream },
            AbortSignal.timeout(250),
          )
          return Symbol.asyncIterator in result ? collectEvents(result) : result
        }
        await expect(run()).rejects.toThrow(
          stage === "mid-stream" ? "stream idle" : "first frame",
        )
        expect(aborted).toBe(true)
        expect(chatCalls).toBe(stage === "auth" ? 0 : 1)
        expect(getWindsurfConcurrencySnapshot(connection.id).active).toBe(0)
        const warning = diagnosticLogs.find(
          (entry) => entry.args[0] === "[windsurf] deadline exceeded",
        )
        expect(warning?.type).toBe("warn")
        const snapshot = warning?.args[1] as Record<string, unknown>
        const phase =
          stage === "auth" || stage === "headers" ? stage
          : stage === "error-body" ? "error_body"
          : stage === "mid-stream" ? "streaming"
          : "first_output"
        expect(snapshot).toMatchObject({
          phase,
          streaming: stream,
          contentEvents: stage === "mid-stream" ? 1 : 0,
          frames: stage === "mid-stream" || stage === "metadata-only" ? 1 : 0,
          sawEos: false,
          requestId: expect.any(String),
          elapsedMs: expect.any(Number),
          phaseDurationsMs: { [phase]: expect.any(Number) },
        })
        if (
          stage === "partial-frame"
          || stage === "metadata-only"
          || stage === "mid-stream"
        ) {
          expect(snapshot.firstReadBytes).toBeGreaterThan(0)
          expect(snapshot.readBytes).toBe(snapshot.firstReadBytes)
          expect(snapshot.readChunks).toBe(1)
          expect(snapshot.lastReadAgeMs).toEqual(expect.any(Number))
        } else {
          expect(snapshot.firstReadBytes).toBe(0)
          expect(snapshot.readBytes).toBe(0)
          expect(snapshot.readChunks).toBe(0)
        }
        const finished = diagnosticLogs.find(
          (entry) => entry.args[0] === "[windsurf] request finished",
        )
        expect(finished?.args[1]).toMatchObject({
          requestId: snapshot.requestId,
          phase,
          outcome: "timeout",
        })
        const serialized = JSON.stringify(diagnosticLogs)
        for (const secret of [
          credential.value,
          "private upstream metadata",
          "partial",
          "hello",
          "jwt",
        ])
          expect(serialized).not.toContain(secret)
        healthy = true
        const recovered = await run()
        expect(JSON.stringify(recovered)).toContain("recovered")
        expect(getWindsurfConcurrencySnapshot(connection.id).active).toBe(0)
      })
    }
  }

  test.each([false, true])(
    "counts reasoning and tools without per-delta or content logs (stream=%s)",
    async (stream) => {
      const details = new ProtobufEncoder()
      details.writeString(9, "PRIVATE_THINKING")
      const call = new ProtobufEncoder()
      call.writeString(1, "call-private")
      call.writeString(2, "private_tool_name")
      call.writeString(3, '{"query":"PRIVATE_QUERY"}')
      details.writeMessage(6, call)
      const eos = encodeConnectFrame(new TextEncoder().encode("{}"), false)
      eos[0] = 2
      const body = Buffer.concat([
        encodeConnectFrame(details.toUint8Array(), false),
        ...Array.from({ length: 100 }, () => encodeTextFrame("PRIVATE_TEXT")),
        eos,
      ])
      globalThis.fetch = (async (url: string | URL | Request) =>
        new Response(
          requestUrl(url).includes("GetUserJwt") ?
            encodeAuthResponse("jwt")
          : body,
        )) as typeof fetch
      const result = await createWindsurfChatCompletionsOnce(
        { connection, credential },
        { ...payload, stream },
      )
      if (Symbol.asyncIterator in result) {
        for await (const event of result) {
          if (event.data === "[DONE]") break
        }
      }
      const finished = diagnosticLogs.find(
        (entry) => entry.args[0] === "[windsurf] request finished",
      )
      expect(finished?.type).toBe("info")
      expect(finished?.args[1]).toMatchObject({
        outcome: "completed",
        phase: "streaming",
        readBytes: body.byteLength,
        frames: 101,
        contentEvents: 100,
        reasoningEvents: 1,
        toolEvents: 2,
        sawEos: true,
      })
      expect(diagnosticLogs.length).toBeLessThan(15)
      for (const text of [
        "PRIVATE_THINKING",
        "PRIVATE_QUERY",
        "PRIVATE_TEXT",
        "private_tool_name",
        credential.value,
      ])
        expect(JSON.stringify(diagnosticLogs)).not.toContain(text)
    },
  )

  test("records auth failure without a deadline or sensitive error text", async () => {
    process.env.WINDSURF_FIRST_FRAME_TIMEOUT_MS = "0"
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("private auth failure details")
      },
      { preconnect: originalFetch.preconnect },
    )
    await expect(
      createWindsurfChatCompletionsOnce({ connection, credential }, payload),
    ).rejects.toThrow("private auth failure details")
    const finished = diagnosticLogs.find(
      (entry) => entry.args[0] === "[windsurf] request finished",
    )
    expect(finished?.type).toBe("info")
    expect(finished?.args[1]).toMatchObject({
      phase: "auth",
      outcome: "error",
      frames: 0,
      readBytes: 0,
    })
    expect(
      diagnosticLogs.some(
        (entry) => entry.args[0] === "[windsurf] deadline exceeded",
      ),
    ).toBe(false)
    expect(JSON.stringify(diagnosticLogs)).not.toContain(
      "private auth failure details",
    )
  })

  test("records caller cancellation separately from provider deadlines", async () => {
    process.env.WINDSURF_FIRST_FRAME_TIMEOUT_MS = "500"
    const parent = new AbortController()
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      if (requestUrl(url).includes("GetUserJwt"))
        return Promise.resolve(new Response(encodeAuthResponse("jwt")))
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        )
        parent.abort(new Error("caller cancelled"))
      })
    }) as typeof fetch
    await expect(
      createWindsurfChatCompletionsOnce(
        { connection, credential },
        payload,
        parent.signal,
      ),
    ).rejects.toThrow("caller cancelled")
    const finished = diagnosticLogs.find(
      (entry) => entry.args[0] === "[windsurf] request finished",
    )
    expect(finished?.args[1]).toMatchObject({
      phase: "headers",
      outcome: "cancelled",
    })
    expect(
      diagnosticLogs.some(
        (entry) => entry.args[0] === "[windsurf] deadline exceeded",
      ),
    ).toBe(false)
  })

  loopbackTest(
    "shared HTTP client recovers after header/body stalls in both modes",
    async () => {
      process.env.WINDSURF_FIRST_FRAME_TIMEOUT_MS = "100"
      process.env.WINDSURF_STREAM_IDLE_TIMEOUT_MS = "100"
      process.env.WINDSURF_FIRST_FRAME_RETRIES = "0"
      let calls = 0
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          await request.arrayBuffer()
          if (request.url.includes("GetUserJwt"))
            return new Response(encodeAuthResponse("jwt"))
          const phase = calls++ % 4
          if (phase === 0) {
            await new Promise<void>((resolve) =>
              request.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            )
            return new Response(null, { status: 499 })
          }
          let timer: ReturnType<typeof setTimeout>
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encodeTextFrame(phase === 2 ? "partial" : "recovered"),
                )
                if (phase !== 2) {
                  const eos = encodeConnectFrame(
                    new TextEncoder().encode("{}"),
                    false,
                  )
                  eos[0] = 0x02
                  controller.enqueue(eos)
                }
                timer = setTimeout(
                  () => controller.error(new Error("HTTP body never closed")),
                  500,
                )
              },
              cancel() {
                clearTimeout(timer)
              },
            }),
          )
        },
      })
      const localConnection = {
        ...connection,
        metadata: {
          provider: "windsurf",
          settings: { baseUrl: upstream.url.origin },
        },
      }
      try {
        for (const stream of [false, true]) {
          for (const phase of [0, 1, 2, 3]) {
            const run = async () => {
              const result = await createWindsurfChatCompletionsOnce(
                { connection: localConnection, credential },
                { ...payload, stream },
                AbortSignal.timeout(1500),
              )
              return Symbol.asyncIterator in result ?
                  collectEvents(result)
                : result
            }
            if (phase === 0 || phase === 2)
              await expect(run()).rejects.toThrow(
                phase === 0 ? "first frame" : "stream idle",
              )
            else expect(JSON.stringify(await run())).toContain("recovered")
            expect(getWindsurfConcurrencySnapshot(connection.id).active).toBe(0)
          }
        }
        expect(calls).toBe(8)
      } finally {
        await upstream.stop(true)
      }
    },
  )

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

    const result = await createWindsurfChatCompletionsOnce(
      { connection, credential },
      payload,
    )
    if (Symbol.asyncIterator in result) {
      const events = await collectEvents(result)
      expect(events.join("\n")).toContain("recovered")
    } else {
      throw new Error("expected a streaming response")
    }

    expect(chatCalls).toBe(2)
    expect(authCalls).toBe(1)
    expect(getWindsurfConcurrencySnapshot(connection.id).active).toBe(0)
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

    const result = await createWindsurfChatCompletionsOnce(
      { connection, credential },
      payload,
    )
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
    expect(getWindsurfConcurrencySnapshot(connection.id).active).toBe(0)
  })
})
