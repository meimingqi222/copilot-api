import { afterEach, describe, expect, spyOn, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"
import type {
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"

import { logStore } from "~/lib/log-store"
import {
  upsertProviderConnection,
  removeProviderConnection,
} from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"
import {
  buildWindsurfKeepaliveBody,
  WindsurfCacheKeepalive,
  windsurfKeepaliveKey,
  type KeepaliveRequest,
} from "~/services/windsurf/cache-keepalive"
import {
  decodeConnectFrames,
  encodeConnectFrame,
  parseMessage,
  ProtobufEncoder,
  decompressConnectPayload,
} from "~/services/windsurf/protobuf"
import { parseChatStreamFrame } from "~/services/windsurf/response-parsers"
import { resolveWindsurfCacheKeepaliveSettings } from "~/services/windsurf/settings"

function connection(
  settings: Record<string, unknown> = { cacheKeepalive: true },
): ProviderConnection {
  return {
    id: "keepalive-synthetic",
    name: "synthetic",
    protocol: "windsurf-native",
    baseUrl: "https://enterprise.invalid",
    enabled: true,
    priority: 1,
    createdAt: 0,
    proxyUrl: "http://proxy.invalid:8123",
    metadata: { provider: "windsurf", settings },
    credentials: [
      {
        id: "synthetic-key",
        value: "synthetic-token",
        authMode: "bearer",
        enabled: true,
        status: "ready",
        createdAt: 0,
      },
    ],
  }
}

function requestBody(compressed = false): Uint8Array {
  const request = new ProtobufEncoder()
  request.writeString(1, "opaque-metadata")
  request.writeString(2, "instructions")
  for (const text of ["user text", "assistant thinking", "tool response"]) {
    request.writeNested(3, (prompt) => {
      prompt.writeString(1, text)
      prompt.writeVarint(2, 1)
      prompt.writeString(3, text)
      prompt.writeString(12, "signed-opaque")
      prompt.writeNested(13, (cache) => cache.writeVarint(1, 1))
    })
  }
  request.writeNested(8, (config) => {
    config.writeVarint(2, 777)
    config.writeDouble(5, 0.4)
    config.writeString(100, "unknown-config")
  })
  request.writeNested(15, (session) => {
    session.writeString(1, "session")
    session.writeVarint(2, 4)
  })
  request.writeString(16, "cascade")
  request.writeString(17, "prompt")
  request.writeString(21, "model")
  request.writeVarint(100, 42)
  return encodeConnectFrame(request.toUint8Array(), compressed)
}

function decode(body: Uint8Array): Uint8Array {
  return body[0] === 1 ?
      decompressConnectPayload(body.subarray(5))
    : body.subarray(5)
}

const usage = (read = 90): CopilotStreamEvent => ({
  data: JSON.stringify({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: {
        cached_tokens: read,
        cache_creation_input_tokens: 0,
      },
    },
  }),
})

async function* events(
  read = 90,
  finishReason = "stop",
): AsyncIterable<CopilotStreamEvent> {
  yield {
    data: JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    }),
  }
  yield usage(read)
  yield { data: "[DONE]" }
}
async function drain(stream: AsyncIterable<CopilotStreamEvent>): Promise<void> {
  for await (const _ of stream) {
    /* drain */
  }
}

class Clock {
  time = 0
  unrefs = 0
  pending = new Map<object, { at: number; fn: () => void }>()
  now = () => this.time
  set = (fn: () => void, ms: number) => {
    const timer = {
      unref: () => {
        this.unrefs++
      },
    }
    this.pending.set(timer, { at: this.time + ms, fn })
    return timer
  }
  clear = (timer: object) => {
    this.pending.delete(timer)
  }
  async advance(ms: number): Promise<void> {
    this.time += ms
    const ready = [...this.pending].filter(([, timer]) => timer.at <= this.time)
    for (const [id, timer] of ready) {
      this.pending.delete(id)
      timer.fn()
    }
    // Async generators/fetch/body decoding settle without wall-clock sleeps.
    for (let i = 0; i < 40; i++) await Promise.resolve()
  }
  due(): number[] {
    return [...this.pending.values()].map((timer) => timer.at)
  }
}

const schedulers: WindsurfCacheKeepalive[] = []
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stopAll()
  removeProviderConnection("keepalive-synthetic")
})

function setup(
  options: {
    settings?: Record<string, unknown>
    fetch?: (url: string, init: RequestInit) => Promise<Response>
    read?: number
  } = {},
) {
  const clock = new Clock()
  const conn = connection(options.settings)
  const calls: RequestInit[] = []
  const scheduler = new WindsurfCacheKeepalive({
    timers: clock,
    connection: (id) => (id === conn.id ? conn : undefined),
    fetch:
      options.fetch
      ?? (async (_url, init) => {
        calls.push(init)
        return new Response("")
      }),
  })
  schedulers.push(scheduler)
  const request: KeepaliveRequest = {
    connectionId: conn.id,
    apiKey: conn.credentials.at(0)!.value,
    userJwt: "opaque-enterprise-jwt",
    url: `${conn.baseUrl}/GetChatMessage`,
    headers: { "Connect-Content-Encoding": "gzip" },
    body: requestBody(),
    model: "synthetic-model",
    sentAt: 0,
    streamFactory: () => events(options.read),
  }
  const start = async (
    key = "conversation",
    source = events(),
    req = request,
  ) => {
    const job = scheduler.begin(key)
    await drain(scheduler.wrap(source, key, job, req))
    return job
  }
  return { clock, conn, calls, scheduler, request, start }
}

describe("Windsurf paid cache keepalive", () => {
  test("only literal true enables; invalid limits fall back and boundaries are allowed", () => {
    for (const value of [undefined, false, "true", 1, null]) {
      expect(
        resolveWindsurfCacheKeepaliveSettings(
          connection({ cacheKeepalive: value }),
        ).enabled,
      ).toBe(false)
    }
    expect(
      resolveWindsurfCacheKeepaliveSettings(
        connection({
          cacheKeepalive: true,
          cacheKeepaliveIntervalSeconds: 300,
          cacheKeepaliveMaxPings: 0,
        }),
      ),
    ).toEqual({ enabled: true, intervalMs: 285000, maxPings: 6 })
    for (const seconds of [30, 299])
      for (const max of [1, 50]) {
        expect(
          resolveWindsurfCacheKeepaliveSettings(
            connection({
              cacheKeepaliveIntervalSeconds: seconds,
              cacheKeepaliveMaxPings: max,
            }),
          ),
        ).toMatchObject({ intervalMs: seconds * 1000, maxPings: max })
      }
  })

  for (const compressed of [false, true])
    test(`preserves native prompt boundaries, unknown fields and session bytes (gzip=${compressed})`, async () => {
      const original = requestBody(compressed)
      const originalCopy = original.slice()
      const ping = await buildWindsurfKeepaliveBody(original)
      const before = parseMessage(decode(original), 0, 5)
      const after = parseMessage(decode(ping), 0, 5)
      expect(original).toEqual(originalCopy)
      expect(after.filter((n) => n.field !== 3 && n.field !== 8)).toEqual(
        before.filter((n) => n.field !== 3 && n.field !== 8),
      )
      const prompts = after.filter((n) => n.field === 3)
      expect(prompts.slice(0, -1)).toEqual(before.filter((n) => n.field === 3))
      expect(prompts.at(-1)?.sub?.find((n) => n.field === 3)?.raw).toEqual(
        new TextEncoder().encode("continue"),
      )
      expect(
        after
          .find((n) => n.field === 8)
          ?.sub?.filter((n) => n.field === 2)
          .map((n) => n.varint),
      ).toEqual([1])
      expect(
        after.find((n) => n.field === 8)?.sub?.filter((n) => n.field !== 2),
      ).toEqual(
        before.find((n) => n.field === 8)?.sub?.filter((n) => n.field !== 2),
      )
    })

  test("rejects oversized and malformed requests rather than retaining them", async () => {
    await expect(
      buildWindsurfKeepaliveBody(new Uint8Array(4 * 1024 * 1024 + 1)),
    ).rejects.toThrow()
    await expect(
      buildWindsurfKeepaliveBody(new Uint8Array([0, 0, 0, 0, 2, 1])),
    ).rejects.toThrow()
    const oversized = encodeConnectFrame(
      new Uint8Array(4 * 1024 * 1024 + 1),
      true,
    )
    await expect(buildWindsurfKeepaliveBody(oversized)).rejects.toThrow(
      "expanded",
    )
  })

  test("isolates account/conversation/model/subagent/instructions/tools, not growing history/cache markers", () => {
    const base = {
      connectionId: "account",
      conversationKey: "session",
      model: "model",
      payload: {
        model: "model",
        messages: [
          { role: "system", content: "instructions" },
          { role: "user", content: "first" },
        ],
      } as ChatCompletionsPayload,
    }
    const key = windsurfKeepaliveKey(base)
    expect(key).toHaveLength(64)
    expect(
      windsurfKeepaliveKey({
        ...base,
        payload: {
          ...base.payload,
          messages: [
            ...base.payload.messages,
            { role: "assistant", content: "new" },
          ],
        },
      }),
    ).toBe(key)
    for (const extra of [
      { connectionId: "other" },
      { conversationKey: "other" },
      { model: "other" },
      { agent: "other" },
      { instructionsAndTools: ["different", []] },
    ])
      expect(windsurfKeepaliveKey({ ...base, ...extra })).not.toBe(key)
    expect(
      windsurfKeepaliveKey({
        ...base,
        instructionsAndTools: [
          "x-anthropic-billing-header: cch=first;\nStable",
          [],
        ],
      }),
    ).toBe(
      windsurfKeepaliveKey({
        ...base,
        instructionsAndTools: [
          "x-anthropic-billing-header: cch=second;\nStable",
          [],
        ],
      }),
    )
    expect(
      windsurfKeepaliveKey({
        ...base,
        instructionsAndTools: [
          { text: "same", cache_control: { type: "ephemeral" } },
        ],
      }),
    ).toBe(
      windsurfKeepaliveKey({
        ...base,
        instructionsAndTools: [{ text: "same" }],
      }),
    )
  })

  test("times from the send, not a slow completion, and uses connection proxy", async () => {
    const s = setup()
    s.clock.time = 47000
    await s.start()
    expect(s.clock.due()).toEqual([285000])
    expect(s.clock.unrefs).toBe(1)
    await s.clock.advance(238000)
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatchObject({
      proxy: "http://proxy.invalid:8123",
      method: "POST",
    })
    expect(s.calls[0]!.headers).not.toHaveProperty("Connect-Content-Encoding")
    expect(s.clock.due()).toEqual([570000])
  })

  test("already overdue real response pings immediately; no cache/disabled responses never schedule", async () => {
    const s = setup()
    s.clock.time = 310000
    await s.start()
    expect(s.clock.due()).toEqual([310000])
    await s.clock.advance(0)
    expect(s.calls).toHaveLength(1)
    const uncached = setup()
    await uncached.start("uncached", events(0))
    expect(uncached.clock.due()).toEqual([])
    const off = setup({ settings: {} })
    await off.start()
    expect(off.clock.due()).toEqual([])
  })

  test("content-filtered foreground and ping replies stop paid scheduling", async () => {
    const foreground = setup()
    await foreground.start("filtered", events(90, "content_filter"))
    expect(foreground.clock.due()).toEqual([])
    await foreground.clock.advance(285000)
    expect(foreground.calls).toHaveLength(0)

    const ping = setup()
    ping.request.streamFactory = () => events(90, "content_filter")
    await ping.start()
    await ping.clock.advance(285000)
    expect(ping.calls).toHaveLength(1)
    expect(ping.clock.due()).toEqual([])
    await ping.clock.advance(285000)
    expect(ping.calls).toHaveLength(1)
  })

  test("normal stop, length and tool calls remain eligible for keepalive", async () => {
    for (const reason of ["stop", "length", "tool_calls"]) {
      const s = setup()
      await s.start(reason, events(90, reason))
      expect(s.clock.due()).toEqual([285000])
      s.scheduler.stopAll()
    }
  })

  test("write-only real usage also schedules", async () => {
    const s = setup()
    async function* written() {
      yield {
        data: JSON.stringify({
          usage: {
            prompt_tokens: 100,
            completion_tokens: 1,
            prompt_tokens_details: { cache_creation_input_tokens: 100 },
          },
        }),
      }
      yield { data: "[DONE]" }
    }
    await s.start("write", written())
    expect(s.clock.due()).toEqual([285000])
  })

  test("cancelled, thrown or abandoned real streams never schedule", async () => {
    const s = setup()
    const abort = new AbortController()
    abort.abort()
    await s.start("aborted", events(), { ...s.request, signal: abort.signal })
    async function* broken() {
      yield usage()
      throw new Error("synthetic disconnect")
    }
    await expect(s.start("broken", broken())).rejects.toThrow("disconnect")
    const source = s.scheduler.wrap(
      events(),
      "abandoned",
      s.scheduler.begin("abandoned"),
      s.request,
    )
    for await (const _ of source) break
    expect(s.clock.due()).toEqual([])
  })

  test("a replacement cancels in-flight ping and obsolete real completion cannot resurrect it", async () => {
    let pingSignal: AbortSignal | undefined
    const s = setup({
      fetch: async (_url, init) => {
        pingSignal = init.signal ?? undefined
        return new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          ),
        )
      },
    })
    await s.start()
    await s.clock.advance(285000)
    expect(pingSignal?.aborted).toBe(false)
    const next = s.scheduler.begin("conversation")
    expect(pingSignal?.aborted).toBe(true)
    const obsolete = s.scheduler.begin("other")
    s.scheduler.begin("other")
    await drain(s.scheduler.wrap(events(), "other", obsolete, s.request))
    await s.clock.advance(0)
    expect(s.clock.due()).toEqual([])
    s.scheduler.stop("conversation", next)
  })

  test("never overlaps pings; a slow ping is timed from its own send", async () => {
    let resolve: ((response: Response) => void) | undefined
    let calls = 0
    const s = setup({
      fetch: async () => {
        calls++
        return new Promise<Response>((r) => {
          resolve = r
        })
      },
    })
    await s.start()
    await s.clock.advance(285000)
    s.clock.time += 310000
    expect(calls).toBe(1)
    resolve!(new Response(""))
    await s.clock.advance(0)
    expect(calls).toBe(1)
    expect(s.clock.due()).toEqual([595000])
    await s.clock.advance(0)
    expect(calls).toBe(2)
  })

  test("mutable connection switch, enabled state, credential and JWT validity are rechecked", async () => {
    for (const mutate of [
      (conn: ProviderConnection) => {
        conn.enabled = false
      },
      (conn: ProviderConnection) => {
        conn.metadata = { settings: { cacheKeepalive: false } }
      },
      (conn: ProviderConnection) => {
        conn.credentials[0]!.enabled = false
      },
      (conn: ProviderConnection) => {
        conn.credentials.at(0)!.value = "rotated-synthetic"
      },
      (conn: ProviderConnection) => {
        conn.credentials[0]!.status = "auth_error"
      },
    ]) {
      const s = setup()
      await s.start()
      mutate(s.conn)
      await s.clock.advance(285000)
      expect(s.calls).toHaveLength(0)
      expect(s.clock.due()).toEqual([])
    }
    const s = setup()
    s.request.userJwt = `a.${Buffer.from(JSON.stringify({ exp: 300 })).toString("base64url")}.b`
    await s.start()
    await s.clock.advance(285000)
    expect(s.calls).toHaveLength(0)
  })

  for (const status of [401, 402, 429])
    test(`stops on upstream HTTP ${status}`, async () => {
      const s = setup({
        fetch: async () => new Response("refused", { status }),
      })
      await s.start()
      await s.clock.advance(285000)
      expect(s.clock.due()).toEqual([])
    })

  test("two consecutive <50% reads stop, exactly 50% is a hit, maximum count stops", async () => {
    const miss = setup({ read: 49 })
    await miss.start()
    await miss.clock.advance(285000)
    expect(miss.calls).toHaveLength(1)
    await miss.clock.advance(285000)
    expect(miss.calls).toHaveLength(2)
    expect(miss.clock.due()).toEqual([])
    const hit = setup({
      read: 50,
      settings: { cacheKeepalive: true, cacheKeepaliveMaxPings: 3 },
    })
    await hit.start()
    for (let i = 0; i < 3; i++) await hit.clock.advance(285000)
    expect(hit.calls).toHaveLength(3)
    expect(hit.clock.due()).toEqual([])
  })

  test("caps retained conversations and process cleanup clears timers", async () => {
    const s = setup()
    for (let i = 0; i < 33; i++) await s.start(`conversation-${i}`)
    expect(s.clock.pending.size).toBe(32)
    s.scheduler.stopAll()
    expect(s.clock.pending.size).toBe(0)
  })

  test("synthetic protobuf usage is logged and added to account consumption without user request charges", async () => {
    const tokenFrame = new ProtobufEncoder()
    tokenFrame.writeNested(7, (tokens) => {
      tokens.writeVarint(2, 10)
      tokens.writeVarint(3, 1)
      tokens.writeVarint(4, 5)
      tokens.writeVarint(5, 85)
    })
    const frame = encodeConnectFrame(tokenFrame.toUint8Array())
    const trailer = new Uint8Array([2, 0, 0, 0, 2, 123, 125])
    const s = setup({
      fetch: async () => new Response(Buffer.concat([frame, trailer])),
    })
    s.request.streamFactory = async function* (response: Response) {
      for await (const bytes of decodeConnectFrames(response.body!)) {
        const parsed = parseChatStreamFrame(bytes)
        const u = parsed.usage!
        yield {
          data: JSON.stringify({
            usage: {
              prompt_tokens: u.prompt_tokens,
              completion_tokens: u.completion_tokens,
              prompt_tokens_details: {
                cached_tokens: u.cache_read_tokens,
                cache_creation_input_tokens: u.cache_write_tokens,
              },
            },
          }),
        }
      }
      yield { data: "[DONE]" }
    }
    upsertProviderConnection(s.conn)
    const record = spyOn(statsStore, "recordUsage").mockImplementation(() => {})
    const pricing = spyOn(statsStore, "getManualModelPricing").mockReturnValue({
      promptPricePer1k: 2,
      completionPricePer1k: 4,
      cacheReadPricePer1k: 0.2,
      cacheWritePricePer1k: 2.5,
      contextTierAbove: null,
    })
    try {
      await s.start()
      await s.clock.advance(285000)
      expect(record).toHaveBeenCalledTimes(1)
      expect(record.mock.calls[0]![0]).toMatchObject({
        accountId: s.conn.id,
        requestCount: 0,
        promptTokens: 10,
        completionTokens: 1,
        cacheReadTokens: 85,
        cacheWriteTokens: 5,
        totalTokens: 101,
      })
      // Same pricing surface as ordinary account consumption; no invented
      // upstream dollar amount and no additional client/user request charge.
      expect(record.mock.calls[0]![0].cost).toBeCloseTo(0.0535)
      expect(
        logStore
          .query({})
          .entries.find(
            (e) =>
              e.kind === "cache_keepalive" && e.model === "synthetic-model",
          ),
      ).toMatchObject({
        promptTokens: 100,
        completionTokens: 1,
        cacheReadTokens: 85,
        cacheWriteTokens: 5,
      })
    } finally {
      record.mockRestore()
      pricing.mockRestore()
    }
  })
})
