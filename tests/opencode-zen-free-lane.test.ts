import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import {
  BUILTIN_PROVIDER_PRESETS,
  type ProviderPreset,
} from "~/lib/provider-presets"
import {
  classifyUpstreamError,
  isOpenCodeFreeTierBlock,
} from "~/lib/provider-connections"
import {
  ZEN_CLIENT_UA,
  ZEN_TOOL_QUARTET,
  applyFreeTierFingerprint,
  baseModelId,
  endpointForModel,
  isFreeLaneModel,
  openCodeZenAdapter,
  restoreToolName,
  restoreAndFilterToolStream,
  restoreToolNamesInPayload,
  suppressDecoyToolCalls,
  zenRequestId,
  zenSessionFor,
  zenSessionForRequest,
} from "~/services/protocols/opencode-zen"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

/**
 * OpenCode Zen 免费车道的回归守卫。
 *
 * 这条上游能在没有任何账号的情况下用，但代价是三道门（客户端指纹 / 工具白名单 /
 * 按 session 记账的配额），任何一道被绕过或漏掉，症状都是「时好时坏」而不是
 * 明确报错。所以这里把三个不变量钉死：
 *
 * 1. 请求必须带全套指纹头，且 session 由种子确定性派生（否则每请求一个新
 *    session，额度瞬间烧穿换来 429）；
 * 2. 工具清单必须**恰好**是四件组（上游对多带的任何一个工具都 403）；
 * 3. 调用方的工具照常透传,四件组缺哪个就规范化/提升/补齐哪个,响应侧再把
 *    改过拼写的工具名改回调用方的原名。
 */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function zenPreset(): ProviderPreset {
  const preset = BUILTIN_PROVIDER_PRESETS.find(
    (p) => p.id === "opencode-zen-free",
  )
  if (!preset) throw new Error("Missing opencode-zen-free preset")
  return preset
}

function zenConnection(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "zen",
    name: "OpenCode Zen 免费层",
    protocol: "opencode-zen-free",
    baseUrl: "https://opencode.ai/zen",
    enabled: true,
    priority: 20,
    // 免费车道不挂 credential
    credentials: [],
    createdAt: 1_700_000_000_000,
    models: [
      {
        publicId: "nemotron-3-ultra-free",
        upstreamId: "nemotron-3-ultra-free",
        endpoints: ["chat"],
        enabled: true,
      },
      {
        publicId: "muse-spark-1.3-contributor-free",
        upstreamId: "muse-spark-1.3-contributor-free",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
    ...overrides,
  }
}

function zenCredential(): Record<string, unknown> {
  return {
    id: "zen",
    authMode: "bearer",
    value: "",
    enabled: true,
    status: "ready",
    createdAt: 0,
  }
}

describe("opencode zen free lane preset", () => {
  test("is a keyless anonymous lane with no user-supplied headers", () => {
    const preset = zenPreset()
    expect(preset.category).toBe("free")
    expect(preset.keyless).toBe(true)
    expect(preset.protocol).toBe("opencode-zen-free")
    // 指纹头由 adapter 兜底;放预设里只会多一种「用户删了必接头」的坏法
    expect(preset.headers).toBeUndefined()
    // joinUrl 补 /v1 后必须落在 /zen/v1/*
    expect(preset.baseUrl).toBe("https://opencode.ai/zen")
  })

  test("muse-spark is declared on the responses line only", () => {
    const models = zenPreset().defaultModels ?? []
    const muse = models.find(
      (m) => m.upstreamId === "muse-spark-1.3-contributor-free",
    )
    expect(muse?.endpoints).toEqual(["responses"])
    const plain = models.find((m) => m.upstreamId === "nemotron-3-ultra-free")
    expect(plain?.endpoints).toEqual(["chat"])
  })
})

describe("free lane tool fingerprint", () => {
  test("caller tools pass through and the quartet is filled in", () => {
    const body: Record<string, unknown> = {
      tools: [
        { type: "function", function: { name: "get_weather", parameters: {} } },
      ],
    }
    const wire = applyFreeTierFingerprint(body, "chat")
    const names = (body.tools as Array<{ function?: { name?: string } }>).map(
      (t) => t.function?.name,
    )
    // 调用方工具原样保留,四件组补齐——门禁要的是「包含」而不是「只有」
    expect(names).toContain("get_weather")
    expect([...names].sort()).toEqual(
      ["bash", "get_weather", "glob", "grep", "read"].sort(),
    )
    // 没有重命名任何调用方工具
    expect(wire.rename.size).toBe(0)
    // 调用方带了工具就不再碰 tool_choice
    expect(body.tool_choice).toBeUndefined()
  })

  test("a case variant is canonicalized and restored on the way back", () => {
    const body: Record<string, unknown> = {
      tools: [{ type: "function", function: { name: "Bash", parameters: {} } }],
    }
    const wire = applyFreeTierFingerprint(body, "chat")
    const names = (body.tools as Array<{ function?: { name?: string } }>).map(
      (t) => t.function?.name,
    )
    // 发出去的是小写 bash(门禁认这个),且只出现一次
    expect(names.filter((n) => n?.toLowerCase() === "bash")).toEqual(["bash"])
    expect(names).toContain("glob")
    // 响应侧要把 bash 改回 Bash,否则客户端收到一个它没声明过的工具
    expect(wire.rename.get("bash")).toBe("Bash")
    expect(restoreToolName("bash", wire.rename)).toBe("Bash")
    expect(restoreToolName("get_weather", wire.rename)).toBe("get_weather")
  })

  test("a donor tool is promoted instead of a decoy, and its calls stay runnable", () => {
    const body: Record<string, unknown> = {
      tools: [
        { type: "function", function: { name: "pwsh", parameters: {} } },
        { type: "function", function: { name: "glob", parameters: {} } },
        { type: "function", function: { name: "grep", parameters: {} } },
        { type: "function", function: { name: "read", parameters: {} } },
      ],
    }
    const wire = applyFreeTierFingerprint(body, "chat")
    const names = (body.tools as Array<{ function?: { name?: string } }>).map(
      (t) => t.function?.name,
    )
    // pwsh 被提升进 bash 槽位:模型调用 bash 时客户端有 pwsh 可以执行,
    // 而凭空补的 decoy 只会得到 unknown tool
    expect(names).toContain("bash")
    expect(names).not.toContain("pwsh")
    expect(wire.rename.get("bash")).toBe("pwsh")
    expect(restoreToolName("bash", wire.rename)).toBe("pwsh")
  })

  test("decoys only fill slots nothing could answer, and carry a refusal", () => {
    const body: Record<string, unknown> = {}
    const wire = applyFreeTierFingerprint(body, "chat")
    const tools = body.tools as Array<{
      function: { name: string; description: string }
    }>
    expect(tools.map((t) => t.function.name).sort()).toEqual(
      [...ZEN_TOOL_QUARTET].sort(),
    )
    for (const tool of tools) {
      expect(tool.function.description).toContain("must not be used")
    }
    // 调用方完全没带工具:此时列表里只有 decoy,不能让它被调用
    expect(body.tool_choice).toBe("none")
    expect(wire.rename.size).toBe(0)
  })

  test("responses line forces auto because the gateway rejects none there", () => {
    const body: Record<string, unknown> = {}
    applyFreeTierFingerprint(body, "responses")
    // 实测:responses 线传 "none" 会 400 only "auto" is supported for tool_choice
    expect(body.tool_choice).toBe("auto")
    const tools = body.tools as Array<{ name: string }>
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...ZEN_TOOL_QUARTET].sort(),
    )
  })

  test("tool names in streamed and final payloads are restored", () => {
    const wire = {
      rename: new Map([["bash", "Bash"]]),
      declared: new Set(["Bash"]),
    }
    const chunk = {
      choices: [
        {
          delta: {
            tool_calls: [{ function: { name: "bash", arguments: "{}" } }],
          },
        },
      ],
    }
    restoreToolNamesInPayload(chunk, wire.rename)
    expect(
      (chunk.choices[0]!.delta.tool_calls[0] as { function: { name: string } })
        .function.name,
    ).toBe("Bash")

    const responsesEvent = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "bash", call_id: "c1" },
    }
    restoreToolNamesInPayload(responsesEvent, wire.rename)
    expect((responsesEvent.item as { name: string }).name).toBe("Bash")

    const final = {
      choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }],
    }
    restoreToolNamesInPayload(final, wire.rename)
    expect(
      (
        final.choices[0]!.message.tool_calls[0] as {
          function: { name: string }
        }
      ).function.name,
    ).toBe("Bash")
  })

  test("the stream wrapper rewrites frames and passes everything else through", async () => {
    const wire = {
      rename: new Map([["bash", "Bash"]]),
      declared: new Set(["Bash"]),
    }
    async function* source(): AsyncIterable<{ data?: string }> {
      yield { data: ": keep-alive" }
      yield {
        data: JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ function: { name: "bash" } }] } },
          ],
        }),
      }
      yield { data: "[DONE]" }
      yield {}
    }
    const seen: Array<string | undefined> = []
    for await (const event of restoreAndFilterToolStream(
      source() as unknown as AsyncIterable<{ data?: string }>,
      wire,
    )) {
      seen.push(event.data)
    }
    // 注释帧 / [DONE] / 无 data 帧原样放过,只有 JSON 帧被改写
    expect(seen[0]).toBe(": keep-alive")
    expect(seen[2]).toBe("[DONE]")
    expect(seen[3]).toBeUndefined()
    expect(seen[1]).toContain('"name":"Bash"')
    expect(seen[1]).not.toContain('"name":"bash"')
  })

  test("the terminal completed frame restores names nested under response", () => {
    const wire = {
      rename: new Map([["bash", "Bash"]]),
      declared: new Set(["Bash"]),
    }
    // IR 层在流被截断时会从 response.completed 的 response.output 补发 part,
    // 这一路漏改等于把未回滚的工具名直接递给客户端
    const completed = {
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "muse-spark-1.3-contributor-free",
        output: [{ type: "function_call", name: "bash", call_id: "c1" }],
      },
    }
    restoreToolNamesInPayload(completed, wire.rename)
    const item = (completed.response as { output: Array<{ name: string }> })
      .output[0]!
    expect(item.name).toBe("Bash")
  })

  test("a named tool_choice is rewritten to the spelling we send", () => {
    const chat: Record<string, unknown> = {
      tools: [{ type: "function", function: { name: "Bash", parameters: {} } }],
      tool_choice: { type: "function", function: { name: "Bash" } },
    }
    applyFreeTierFingerprint(chat, "chat")
    expect(
      (chat.tool_choice as { function: { name: string } }).function.name,
    ).toBe("bash")

    const responses: Record<string, unknown> = {
      tools: [{ type: "function", name: "Bash", parameters: {} }],
      tool_choice: { type: "function", name: "Bash" },
    }
    applyFreeTierFingerprint(responses, "responses")
    expect((responses.tool_choice as { name: string }).name).toBe("bash")

    const anthropic: Record<string, unknown> = {
      tools: [{ name: "Bash", input_schema: {} }],
      tool_choice: { type: "tool", name: "Bash" },
    }
    applyFreeTierFingerprint(anthropic, "chat")
    expect((anthropic.tool_choice as { name: string }).name).toBe("bash")
  })

  test("a tool-free Responses stream suppresses decoy calls and keeps text and completion", async () => {
    const wire = applyFreeTierFingerprint({}, "responses")
    const decoy = {
      type: "function_call",
      name: "bash",
      call_id: "call_x",
      arguments: "{}",
    }
    const events = [
      { type: "response.output_item.added", output_index: 0, item: decoy },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: "{}",
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: "{}",
      },
      { type: "response.output_item.done", output_index: 0, item: decoy },
      { type: "response.output_text.delta", output_index: 1, delta: "hello" },
      {
        type: "response.completed",
        response: {
          output: [decoy],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
    ]
    async function* source(): AsyncIterable<{ data?: string }> {
      for (const event of events) yield { data: JSON.stringify(event) }
    }
    const seen: Array<Record<string, unknown>> = []
    for await (const event of restoreAndFilterToolStream(source(), wire)) {
      seen.push(JSON.parse(event.data!) as Record<string, unknown>)
    }
    expect(seen.map((event) => event.type)).toEqual([
      "response.output_text.delta",
      "response.completed",
    ])
    expect(seen[1]!.response).toEqual({
      output: [],
      usage: { input_tokens: 10, output_tokens: 2 },
    })
  })

  test("a Chat tool stream preserves standalone usage frames", async () => {
    const wire = applyFreeTierFingerprint(
      { tools: [{ type: "function", function: { name: "get_weather" } }] },
      "chat",
    )
    const usage = {
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }
    async function* source(): AsyncIterable<{ data?: string }> {
      yield { data: JSON.stringify(usage) }
      yield { data: "[DONE]" }
    }
    const seen: Array<string | undefined> = []
    for await (const event of restoreAndFilterToolStream(source(), wire))
      seen.push(event.data)
    expect(seen).toEqual([JSON.stringify(usage), "[DONE]"])
  })

  test("a decoy call is dropped whole, arguments included", async () => {
    // 客户端只声明了 get_weather,bash 是我们补位的占位工具(没有任何改名)。
    // 模型调它时连同参数片段一起丢——递过去就是客户端无法执行的 unknown tool。
    const wire = { rename: new Map(), declared: new Set(["get_weather"]) }
    async function* source(): AsyncIterable<{ data?: string }> {
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_x", function: { name: "bash" } },
                ],
              },
            },
          ],
        }),
      }
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"c":' } }],
              },
            },
          ],
        }),
      }
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, id: "call_y", function: { name: "get_weather" } },
                ],
              },
            },
          ],
        }),
      }
      yield { data: "[DONE]" }
    }
    const frames: Array<string | undefined> = []
    for await (const event of restoreAndFilterToolStream(
      source() as unknown as AsyncIterable<{ data?: string }>,
      wire,
    )) {
      frames.push(event.data)
    }
    // 占位调用的两帧都没了;客户端的工具与 [DONE] 都在
    expect(frames).toHaveLength(2)
    expect(frames[0]).toContain("get_weather")
    expect(frames[0]).not.toContain("bash")
    expect(frames[1]).toBe("[DONE]")
  })

  test("a renamed caller tool is kept, not mistaken for a decoy", async () => {
    // 反向守卫:客户端声明的是大写 Bash,我们规范化成 bash 发出去。恢复名字后
    // 它是 `Bash`——不在四件组里,必须放行。若在恢复前按上游拼写判,或把四件组
    // 比较做成大小写不敏感,这里就会被误杀,客户端凭空丢掉一个真能执行的工具。
    const wire = {
      rename: new Map([["bash", "Bash"]]),
      declared: new Set(["Bash"]),
    }
    async function* source(): AsyncIterable<{ data?: string }> {
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_x", function: { name: "bash" } },
                ],
              },
            },
          ],
        }),
      }
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "{}" } }],
              },
            },
          ],
        }),
      }
    }
    const frames: Array<string | undefined> = []
    for await (const event of restoreAndFilterToolStream(
      source() as unknown as AsyncIterable<{ data?: string }>,
      wire,
    )) {
      frames.push(event.data)
    }
    expect(frames).toHaveLength(2)
    // 名字按调用方的拼写送达,参数帧也照常放行
    expect(frames[0]).toContain('"name":"Bash"')
    expect(frames[1]).toContain('"arguments":"{}"')
  })

  test("argument fragments before a name arrives are held back", async () => {
    // 参数先于名字到达时不能乐观转发:否则占位调用的 fragment 会在还不知道
    // 它是什么的时候就漏给客户端
    const wire = { rename: new Map(), declared: new Set(["get_weather"]) }
    async function* source(): AsyncIterable<{ data?: string }> {
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"c":' } }],
              },
            },
          ],
        }),
      }
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { name: "get_weather" } }],
              },
            },
          ],
        }),
      }
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "1}" } }],
              },
            },
          ],
        }),
      }
    }
    const frames: Array<string | undefined> = []
    for await (const event of restoreAndFilterToolStream(
      source() as unknown as AsyncIterable<{ data?: string }>,
      wire,
    )) {
      frames.push(event.data)
    }
    // 第一帧被扣住;名字帧与后续参数帧放行
    expect(frames).toHaveLength(2)
    expect(frames[0]).toContain("get_weather")
    expect(frames[1]).toContain("1}")
  })

  test("a decoy function_call is dropped on the responses wire too", async () => {
    const wire = { rename: new Map(), declared: new Set(["get_weather"]) }
    async function* source(): AsyncIterable<{ data?: string }> {
      yield {
        data: JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", name: "bash", call_id: "c1" },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: "{}",
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "function_call", name: "get_weather", call_id: "c2" },
        }),
      }
    }
    const frames: Array<string | undefined> = []
    for await (const event of restoreAndFilterToolStream(
      source() as unknown as AsyncIterable<{ data?: string }>,
      wire,
    )) {
      frames.push(event.data)
    }
    // 占位调用的三帧(item/参数/done)全丢,客户端的调用放行
    expect(frames).toHaveLength(1)
    expect(frames[0]).toContain("get_weather")
  })

  test("non-streaming payloads drop decoy calls in every shape", () => {
    const wire = { rename: new Map(), declared: new Set(["get_weather"]) }
    const chat = {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "bash" } },
              { function: { name: "get_weather" } },
            ],
          },
        },
      ],
    }
    suppressDecoyToolCalls(chat, wire)
    expect(chat.choices[0]!.message.tool_calls).toHaveLength(1)
    expect(chat.choices[0]!.message.tool_calls[0]!.function.name).toBe(
      "get_weather",
    )

    const responses = {
      output: [
        { type: "function_call", name: "bash" },
        { type: "function_call", name: "get_weather" },
      ],
    }
    suppressDecoyToolCalls(responses, wire)
    expect(responses.output).toHaveLength(1)

    const completed = {
      type: "response.completed",
      response: {
        id: "r",
        model: "m",
        output: [{ type: "function_call", name: "bash" }],
      },
    }
    suppressDecoyToolCalls(completed, wire)
    expect(completed.response.output).toHaveLength(0)
  })
})

describe("zen fingerprint", () => {
  test("session ids are deterministic per seed and gateway-shaped", () => {
    const first = zenSessionFor("zen\u0000user-1\u0000nemotron-3-ultra-free")
    const second = zenSessionFor("zen\u0000user-1\u0000nemotron-3-ultra-free")
    const other = zenSessionFor("zen\u0000user-2\u0000nemotron-3-ultra-free")
    // 每请求一个新 session 会立刻 429 FreeUsageLimitError
    expect(first).toBe(second)
    expect(first).not.toBe(other)
    expect(first).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })

  test("request ids are unique per call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => zenRequestId()))
    expect(ids.size).toBe(50)
    for (const id of ids)
      expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })

  test("the session bucket follows the caller, not the connection alone", () => {
    const connection = zenConnection() as never
    // 多用户模式按 userId 分桶:所有人挤同一个 session 时,一个人就能把整条
    // 连接搞到 429
    const userA = zenSessionForRequest(connection, "nemotron-3-ultra-free", {
      c: { get: () => "user-a" } as never,
    })
    const userAAgain = zenSessionForRequest(
      connection,
      "nemotron-3-ultra-free",
      {
        c: { get: () => "user-a" } as never,
      },
    )
    const userB = zenSessionForRequest(connection, "nemotron-3-ultra-free", {
      c: { get: () => "user-b" } as never,
    })
    expect(userA).toBe(userAAgain)
    expect(userA).not.toBe(userB)
  })

  test("no caller identity degrades to one stable bucket instead of throwing", () => {
    const connection = zenConnection() as never
    // 单用户模式没有 userId,getClientIp 在测试上下文里取不到连接信息:
    // 必须退化成固定桶,而不是每请求一个新 session(那会立刻烧穿额度)
    const first = zenSessionForRequest(connection, "nemotron-3-ultra-free", {
      c: { get: () => undefined } as never,
    })
    const second = zenSessionForRequest(connection, "nemotron-3-ultra-free", {
      c: { get: () => undefined } as never,
    })
    expect(first).toBe(second)
    // 与任何带身份的桶都不同
    expect(first).not.toBe(
      zenSessionForRequest(connection, "nemotron-3-ultra-free", {
        c: { get: () => "user-a" } as never,
      }),
    )
  })

  test("model ids keep their thinking suffix out of the session bucket", () => {
    const plain = zenSessionForRequest(
      zenConnection() as never,
      "nemotron-3-ultra-free",
      { c: { get: () => "u" } as never },
    )
    const suffixed = zenSessionForRequest(
      zenConnection() as never,
      "nemotron-3-ultra-free (Deep)",
      { c: { get: () => "u" } as never },
    )
    expect(plain).toBe(suffixed)
    expect(baseModelId("nemotron-3-ultra-free (Deep)")).toBe(
      "nemotron-3-ultra-free",
    )
  })

  test("endpoint routing follows the model family", () => {
    expect(endpointForModel("muse-spark-1.3-contributor-free")).toBe(
      "/responses",
    )
    expect(endpointForModel("nemotron-3-ultra-free")).toBe("/chat/completions")
    expect(isFreeLaneModel("nemotron-3-ultra-free")).toBe(true)
    // 清单里混着付费 id:发现时必须过滤掉
    expect(isFreeLaneModel("claude-opus-5")).toBe(false)
    expect(isFreeLaneModel("space-bunny-free")).toBe(true)
  })
})

describe("zen requests", () => {
  test("chat completions carry the full fingerprint and the exact quartet", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = ((input: string, init: RequestInit) => {
      calls.push({ url: String(input), init })
      return Promise.resolve(
        new Response(JSON.stringify({ id: "x", choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof globalThis.fetch

    await openCodeZenAdapter.createChatCompletions!({
      target: {
        connectionId: "zen",
        connectionName: "zen",
        protocol: "opencode-zen-free",
        credentialId: "zen",
        publicModelId: "nemotron-3-ultra-free",
        upstreamModelId: "nemotron-3-ultra-free",
        endpoint: "chat",
        connectionPriority: 20,
        connectionWeight: 1,
        credentialPriority: 0,
        credentialWeight: 1,
      } as never,
      connection: zenConnection() as never,
      credential: zenCredential() as never,
      payload: {
        model: "nemotron-3-ultra-free",
        messages: [{ role: "user", content: "hi" }],
        // 客户端工具必须原样到达上游(门禁只要求四件组存在,不排斥额外工具)
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
      } as never,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://opencode.ai/zen/v1/chat/completions")
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers["authorization"]).toBe("Bearer public")
    expect(headers["user-agent"]).toBe(ZEN_CLIENT_UA)
    expect(headers["x-opencode-client"]).toBe("desktop")
    expect(headers["x-opencode-project"]).toBe("global")
    expect(headers["x-opencode-session"]).toMatch(
      /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    )
    expect(headers["x-opencode-request"]).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    )

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      tools: Array<{ function?: { name?: string } }>
      tool_choice: unknown
      functions?: unknown
    }
    const names = body.tools.map((t) => t.function?.name)
    // 调用方工具原样透传,四件组补齐(门禁要的是「包含」四个小写名)
    expect(names).toContain("get_weather")
    for (const slot of ZEN_TOOL_QUARTET) expect(names).toContain(slot)
    // 带了工具就不动 tool_choice,由客户端自己决定
    expect(body.tool_choice).toBe("auto")
    expect(body.functions).toBeUndefined()
  })

  test("a non-streaming client is still sent upstream as a stream, then aggregated", async () => {
    // 免费车道门禁要求上游请求必须流式:客户端发 stream:false 会被上游 403
    // FreeTierError。适配器一律按流式发,再把整条流聚合成一个 JSON 回给客户端。
    const calls: Array<{ url: string; init: RequestInit }> = []
    const frames = [
      'data: {"id":"c1","model":"nemotron-3-ultra-free","choices":[{"index":0,"delta":{"role":"assistant","content":"he"}}]}',
      "",
      'data: {"id":"c1","model":"nemotron-3-ultra-free","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n")
    globalThis.fetch = ((input: string, init: RequestInit) => {
      calls.push({ url: String(input), init })
      return Promise.resolve(
        new Response(frames, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }) as unknown as typeof globalThis.fetch

    const result = await openCodeZenAdapter.createChatCompletions!({
      target: {
        connectionId: "zen",
        connectionName: "zen",
        protocol: "opencode-zen-free",
        credentialId: "zen",
        publicModelId: "nemotron-3-ultra-free",
        upstreamModelId: "nemotron-3-ultra-free",
        endpoint: "chat",
        connectionPriority: 20,
        connectionWeight: 1,
        credentialPriority: 0,
        credentialWeight: 1,
      } as never,
      connection: zenConnection() as never,
      credential: zenCredential() as never,
      payload: {
        model: "nemotron-3-ultra-free",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      } as never,
    })

    // 上游请求:即便客户端要非流式,body 也必须是 stream:true 且 accept 走 SSE
    const sent = JSON.parse(String(calls[0]!.init.body)) as { stream?: boolean }
    expect(sent.stream).toBe(true)
    expect((calls[0]!.init.headers as Record<string, string>)["accept"]).toBe(
      "text/event-stream",
    )

    // 客户端拿到的是聚合后的非流式 chat.completion
    const response = result.response as {
      choices?: Array<{
        message?: { content?: string }
        finish_reason?: string
      }>
    }
    expect(response.choices?.[0]?.message?.content).toBe("hello")
    expect(response.choices?.[0]?.finish_reason).toBe("stop")
  })

  test("responses line sends auto, because the gateway rejects none there", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    // 免费车道上游恒定流式:非流式请求也会拿到 SSE,这里用一条最小流回包。
    globalThis.fetch = ((input: string, init: RequestInit) => {
      calls.push({ url: String(input), init })
      return Promise.resolve(
        new Response(
          'data: {"type":"response.completed","response":{"id":"r","output":[]}}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      )
    }) as unknown as typeof globalThis.fetch

    await openCodeZenAdapter.createResponses!({
      target: {
        connectionId: "zen",
        connectionName: "zen",
        protocol: "opencode-zen-free",
        credentialId: "zen",
        publicModelId: "muse-spark-1.3-contributor-free",
        upstreamModelId: "muse-spark-1.3-contributor-free",
        endpoint: "responses",
        connectionPriority: 20,
        connectionWeight: 1,
        credentialPriority: 0,
        credentialWeight: 1,
      } as never,
      connection: zenConnection() as never,
      credential: zenCredential() as never,
      payload: {
        model: "muse-spark-1.3-contributor-free",
        input: "hi",
        max_output_tokens: 32,
      } as never,
    })

    expect(calls[0]!.url).toBe("https://opencode.ai/zen/v1/responses")
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      tools: Array<{ name?: string }>
      tool_choice: unknown
    }
    // 扁平工具形状(不是 chat 的 {type,function} 包装)
    expect(body.tools.map((t) => t.name).sort()).toEqual(
      [...ZEN_TOOL_QUARTET].sort(),
    )
    // 调用方没给 tool_choice 时兜底为 auto:这条线传 "none" 会 400
    // `only "auto" is supported for tool_choice`
    expect(body.tool_choice).toBe("auto")
  })

  test("the responses line also forces upstream streaming and de-streams", async () => {
    // 与 chat 线同源:免费车道门禁要求上游流式,客户端发非流式会被 403。
    const calls: Array<{ url: string; init: RequestInit }> = []
    const frames = [
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      "",
      'data: {"type":"response.completed","response":{"id":"r1","model":"muse-spark-1.3-contributor-free","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"output_text":"hi"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n")
    globalThis.fetch = ((input: string, init: RequestInit) => {
      calls.push({ url: String(input), init })
      return Promise.resolve(
        new Response(frames, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }) as unknown as typeof globalThis.fetch

    const result = await openCodeZenAdapter.createResponses!({
      target: {
        connectionId: "zen",
        connectionName: "zen",
        protocol: "opencode-zen-free",
        credentialId: "zen",
        publicModelId: "muse-spark-1.3-contributor-free",
        upstreamModelId: "muse-spark-1.3-contributor-free",
        endpoint: "responses",
        connectionPriority: 20,
        connectionWeight: 1,
        credentialPriority: 0,
        credentialWeight: 1,
      } as never,
      connection: zenConnection() as never,
      credential: zenCredential() as never,
      payload: {
        model: "muse-spark-1.3-contributor-free",
        input: "hi",
        stream: false,
      } as never,
    })

    const sent = JSON.parse(String(calls[0]!.init.body)) as { stream?: boolean }
    expect(sent.stream).toBe(true)
    expect((calls[0]!.init.headers as Record<string, string>)["accept"]).toBe(
      "text/event-stream",
    )

    const response = result.response as {
      output_text?: string
      output?: Array<unknown>
    }
    expect(response.output_text).toBe("hi")
  })

  test("discovery keeps only the free slice and annotates capabilities", async () => {
    const calls: Array<string> = []
    globalThis.fetch = ((input: string) => {
      calls.push(String(input))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: "nemotron-3-ultra-free" },
              { id: "muse-spark-1.3-contributor-free" },
              { id: "claude-opus-5" },
              { id: "gpt-5.2" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }) as unknown as typeof globalThis.fetch

    const models = await openCodeZenAdapter.discoverModels!({
      connection: zenConnection() as never,
      credential: zenCredential() as never,
    })

    expect(calls).toEqual(["https://opencode.ai/zen/v1/models"])
    expect(models.map((m) => m.publicId)).toEqual([
      "nemotron-3-ultra-free",
      "muse-spark-1.3-contributor-free",
    ])
    // muse-spark 只能走 responses 线
    expect(models[1]!.endpoints).toEqual(["responses"])
    expect(models[0]!.endpoints).toEqual(["chat"])
    // contextWindow 有真实读取方(routing-groups/auto.ts 的 contextWindowOf);
    // 曾经一起写下的 maxOutputTokens / supportsVision / freeLane 无人读,已删
    expect(models[0]!.metadata).toMatchObject({ contextWindow: 1000000 })
    expect(models[0]!.metadata?.maxOutputTokens).toBeUndefined()
  })

  test("the adapter is registered under its own protocol", () => {
    initializeProtocolAdapters()
    const adapter = getProtocolAdapter("opencode-zen-free")
    expect(adapter?.protocol).toBe("opencode-zen-free")
    // 只实现 chat/responses:messages 客户端由 IR 层翻译成 chat 后落在这里
    expect(typeof adapter?.createChatCompletions).toBe("function")
    expect(typeof adapter?.createResponses).toBe("function")
    expect(adapter?.createMessages).toBeUndefined()
  })
})

describe("zen failure classification", () => {
  test("region and fingerprint refusals do not lock the connection", () => {
    const region = classifyUpstreamError({
      status: 403,
      body: JSON.stringify({
        type: "error",
        error: { type: "RegionError", message: "not available in your region" },
      }),
    })
    expect(region.kind).toBe("client_error")

    const fingerprint = classifyUpstreamError({
      status: 403,
      body: JSON.stringify({
        type: "error",
        error: {
          type: "FreeTierError",
          message: "OpenCode's free tier can only be used from within OpenCode",
        },
      }),
    })
    expect(fingerprint.kind).toBe("client_error")

    // 真正的鉴权失败仍然要锁
    const real = classifyUpstreamError({
      status: 403,
      body: JSON.stringify({ error: { message: "invalid credentials" } }),
    })
    expect(real.kind).toBe("auth_error")
  })

  test("the detector only fires on free-lane refusals", () => {
    expect(isOpenCodeFreeTierBlock('{"error":{"type":"RegionError"}}')).toBe(
      true,
    )
    expect(
      isOpenCodeFreeTierBlock(
        "OpenCode's free tier can only be used from within OpenCode",
      ),
    ).toBe(true)
    expect(isOpenCodeFreeTierBlock('{"error":{"message":"nope"}}')).toBe(false)
    expect(isOpenCodeFreeTierBlock("")).toBe(false)
  })
})

describe("free lane documentation", () => {
  test("the adapter header explains the gates it works around", () => {
    const source = readFileSync(
      "src/services/protocols/opencode-zen.ts",
      "utf8",
    )
    // 后来人改这个文件前必须先知道为什么工具清单不能被透传、为什么必须流式
    expect(source).toContain("工具白名单")
    expect(source).toContain("按 session 记账")
    expect(source).toContain("请求必须流式")
  })
})
