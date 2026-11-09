import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { ProviderConnection } from "~/lib/provider-connections"
import type { ProtobufNode } from "~/services/windsurf/protobuf"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/protocols/chat/types"
import { bunWebsocket } from "~/lib/bun-websocket"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { buildRouteTargets, clearRestRegistryForTest } from "~/lib/route-target"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { cacheModels } from "~/lib/utils"
import { server } from "~/server"
import { clearDevinUserJwtCacheForTest } from "~/services/windsurf/auth"
import { buildRequest } from "~/services/windsurf/request-builders"
import { resetWindsurfConcurrencyForTest } from "~/services/windsurf/concurrency"
import {
  ProtobufEncoder,
  encodeConnectFrame,
  parseMessage,
} from "~/services/windsurf/protobuf"
import { loopbackTest } from "./helpers/loopback-test"

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalApiKey = state.legacyApiKey
const originalUsers = state.users
const originalDir = PATHS.APP_DIR
const originalLogPersist = process.env.LOG_PERSIST
let testDir: string
let packets: Array<Array<ProtobufNode>>
let structuredReply: string | undefined
let thinkingReply: Uint8Array | undefined

function fieldText(
  nodes: Array<ProtobufNode>,
  field: number,
): string | undefined {
  const raw = nodes.find((node) => node.field === field)?.raw
  return raw ? new TextDecoder().decode(raw) : undefined
}

test("Windsurf shares developer-to-system normalization without mutating caller history", async () => {
  const payload: ChatCompletionsPayload = {
    model: "deepseek-v4-1-flash",
    messages: [
      { role: "system", content: "System instruction" },
      { role: "developer", content: "Developer instruction" },
      { role: "user", content: "User question" },
    ],
  }
  const original = structuredClone(payload)
  const framed = await buildRequest({
    payload,
    apiKey: "test-key",
    requestModel: "deepseek-v4-1-flash-high",
    cascadeId: "roles-test",
    turnIndex: 0,
  })
  const packet = parseMessage(
    framed[0] === 1 ?
      Bun.gunzipSync(Buffer.from(framed.subarray(5)))
    : framed.subarray(5),
    0,
    6,
  )
  expect(fieldText(packet, 2)).toBe(
    "System instruction\n\nDeveloper instruction",
  )
  const prompts = packet.filter((node) => node.field === 3)
  expect(prompts).toHaveLength(1)
  expect(fieldText(prompts[0].sub!, 3)).toBe("User question")
  expect(payload).toEqual(original)
})

const connection: ProviderConnection = {
  id: "windsurf-responses-test",
  name: "Windsurf",
  protocol: "windsurf-native",
  baseUrl: "",
  enabled: true,
  priority: 0,
  createdAt: 0,
  metadata: { settings: { baseUrl: "https://windsurf.test" } },
  credentials: [
    {
      id: "windsurf-credential",
      authMode: "bearer",
      value: "test-key",
      enabled: true,
      status: "ready",
      createdAt: 0,
    },
  ],
  models: [
    {
      publicId: "deepseek-v4-1-flash",
      upstreamId: "deepseek-v4-1-flash-high",
      name: "DeepSeek V4.1 Flash",
      vendor: "windsurf",
      endpoints: ["chat"],
      enabled: true,
      pickerEnabled: true,
    },
  ],
}

beforeEach(async () => {
  await fs.mkdir("temp", { recursive: true })
  testDir = await fs.mkdtemp(path.resolve("temp/windsurf-responses-"))
  redirectPathsToDir(testDir)
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
  clearRestRegistryForTest()
  resetProtectedRouteGuardForTest()
  clearDevinUserJwtCacheForTest()
  packets = []
  structuredReply = undefined
  thinkingReply = undefined
  process.env.LOG_PERSIST = "0"
  state.legacyApiKey = undefined
  state.users = []
  statsStore.clearUsageStatsForTest()
  upsertProviderConnection(structuredClone(connection))
  cacheModels()
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input)
    if (url.includes("GetUserJwt")) {
      const auth = new ProtobufEncoder()
      auth.writeString(1, "test-jwt")
      return new Response(auth.toUint8Array())
    }
    expect(url).toEndWith("/exa.api_server_pb.ApiServerService/GetChatMessage")
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/connect+proto",
    )
    const framed = init!.body as Uint8Array
    expect(new Headers(init?.headers).get("connect-content-encoding")).toBe(
      framed[0] === 1 ? "gzip" : null,
    )
    const bytes =
      framed[0] === 1 ?
        Bun.gunzipSync(Buffer.from(framed.subarray(5)))
      : framed.subarray(5)
    packets.push(parseMessage(bytes, 0, 6))
    if (thinkingReply) return new Response(thinkingReply)
    if (structuredReply !== undefined) {
      const frames = [
        structuredReply.slice(0, 8),
        structuredReply.slice(8),
      ].map((argumentsPart, index) => {
        const call = new ProtobufEncoder()
        call.writeString(1, "call_structured")
        if (index === 0) call.writeString(2, "__structured_output")
        call.writeString(3, argumentsPart)
        const frame = new ProtobufEncoder()
        frame.writeMessage(6, call)
        return encodeConnectFrame(frame.toUint8Array(), false)
      })
      const trailer = encodeConnectFrame(new TextEncoder().encode("{}"), false)
      trailer[0] = 2
      return new Response(Buffer.concat([...frames, trailer]))
    }
    const frame = new ProtobufEncoder()
    frame.writeString(9, "Synthetic reasoning")
    frame.writeString(3, "Synthetic answer")
    frame.writeString(9, " and a late thought")
    const call = new ProtobufEncoder()
    call.writeString(1, "call_next")
    call.writeString(2, "functions__read_file")
    call.writeString(3, '{"path":"next.txt"}')
    frame.writeMessage(6, call)
    frame.writeVarint(5, 10)
    const trailer = encodeConnectFrame(new TextEncoder().encode("{}"), false)
    trailer[0] = 2
    return new Response(
      Buffer.concat([encodeConnectFrame(frame.toUint8Array(), false), trailer]),
    )
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalLogPersist === undefined) delete process.env.LOG_PERSIST
  else process.env.LOG_PERSIST = originalLogPersist
  state.models = originalModels
  state.legacyApiKey = originalApiKey
  state.users = originalUsers
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
  clearRestRegistryForTest()
  clearDevinUserJwtCacheForTest()
  resetWindsurfConcurrencyForTest()
  statsStore.clearUsageStatsForTest()
  redirectPathsToDir(originalDir)
  await fs.rm(testDir, { recursive: true, force: true })
})

test.each([false, true])(
  "Messages preserves Devin thinking blocks and their signature types through tool replay (stream=%s)",
  async (stream) => {
    const claude = structuredClone(connection)
    claude.models = [
      {
        ...connection.models![0],
        publicId: "claude-opus-5-5",
        upstreamId: "claude-opus-5-5",
        endpoints: ["chat"],
      },
    ]
    upsertProviderConnection(claude)
    cacheModels()
    const frame = (field: number, text: string) => {
      const encoder = new ProtobufEncoder()
      encoder.writeString(field, text)
      return encodeConnectFrame(encoder.toUint8Array(), false)
    }
    const call = new ProtobufEncoder()
    call.writeString(1, "call_beta")
    call.writeString(2, "read_file")
    call.writeString(3, '{"path":"beta"}')
    const tool = new ProtobufEncoder()
    tool.writeMessage(6, call)
    tool.writeVarint(5, 10)
    const eos = encodeConnectFrame(new TextEncoder().encode("{}"), false)
    eos[0] = 2
    thinkingReply = Buffer.concat([
      frame(9, "inspect alpha"),
      frame(10, "sig-a"),
      frame(10, "-end"),
      frame(21, "anthropic-bedrock"),
      frame(3, "Reading alpha."),
      frame(9, "then beta"),
      frame(10, "sig-b"),
      frame(10, "-tail"),
      frame(21, "anthropic"),
      encodeConnectFrame(tool.toUint8Array(), false),
      eos,
    ])
    const request = {
      model: "claude-opus-5-5",
      max_tokens: 1024,
      tools: [
        {
          name: "read_file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
      messages: [{ role: "user", content: "Inspect alpha then beta." }],
    }
    const response = await server.request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream }),
    })
    expect(response.status).toBe(200)
    let content: Array<Record<string, unknown>>
    if (!stream)
      content = (
        (await response.json()) as { content: Array<Record<string, unknown>> }
      ).content
    else {
      content = []
      const argumentsByIndex = new Map<number, string>()
      const frames = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data:"))
      for (const line of frames) {
        const event = JSON.parse(line.slice(5)) as {
          type: string
          index: number
          content_block?: Record<string, unknown>
          delta?: {
            type: string
            thinking?: string
            text?: string
            signature?: string
            partial_json?: string
          }
        }
        if (event.type === "content_block_start")
          content[event.index] = event.content_block!
        const delta = event.delta
        const block = content[event.index]
        if (!delta || !block) continue
        if (delta.type === "thinking_delta")
          block.thinking = `${block.thinking ?? ""}${delta.thinking}`
        if (delta.type === "signature_delta")
          block.signature = `${block.signature ?? ""}${delta.signature}`
        if (delta.type === "text_delta")
          block.text = `${block.text ?? ""}${delta.text}`
        if (delta.type === "input_json_delta")
          argumentsByIndex.set(
            event.index,
            `${argumentsByIndex.get(event.index) ?? ""}${delta.partial_json}`,
          )
      }
      for (const [index, args] of argumentsByIndex)
        content[index].input = JSON.parse(args)
    }
    expect(content).toEqual([
      { type: "thinking", thinking: "inspect alpha", signature: "sig-a-end" },
      { type: "text", text: "Reading alpha." },
      { type: "thinking", thinking: "then beta", signature: "sig-b-tail" },
      {
        type: "tool_use",
        id: "call_beta",
        name: "read_file",
        input: { path: "beta" },
      },
    ])
    const replay = await server.request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        messages: [
          ...request.messages,
          { role: "assistant", content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_beta",
                content: "beta data",
              },
            ],
          },
        ],
      }),
    })
    expect(replay.status).toBe(200)
    await replay.text()
    const prompts = packets
      .at(-1)!
      .filter((node) => node.field === 3)
      .map((node) => node.sub!)
    const assistant = prompts.filter(
      (fields) => fields.find((node) => node.field === 2)?.varint === 2,
    )
    expect(
      assistant.map((fields) => [
        fieldText(fields, 3),
        fieldText(fields, 11),
        fieldText(fields, 12),
        fieldText(fields, 18),
      ]),
    ).toEqual([
      ["Reading alpha.", "inspect alpha", "sig-a-end", "anthropic-bedrock"],
      [undefined, "then beta", "sig-b-tail", "anthropic"],
    ])
    expect(
      assistant.map(
        (fields) => fields.filter((node) => node.field === 6).length,
      ),
    ).toEqual([0, 1])
    expect(
      prompts.some(
        (fields) =>
          fieldText(fields, 7) === "call_beta"
          && fieldText(fields, 3) === "beta data",
      ),
    ).toBe(true)
  },
)

test("chained Responses deltas are rejected before a stateless Windsurf request", async () => {
  const response = await server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-1-flash",
      previous_response_id: "resp_previous",
      input: [
        {
          type: "function_call_output",
          call_id: "call_previous",
          output: "Delta only",
        },
      ],
      stream: false,
    }),
  })
  expect(response.status).toBe(400)
  expect(
    ((await response.json()) as { error: { code: string } }).error.code,
  ).toBe("previous_response_not_found")
  expect(packets).toHaveLength(0)
})

test("Chat output caps and required tool schemas survive Windsurf encoding", async () => {
  const parameters = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  }
  for (const limits of [
    { max_completion_tokens: 123 },
    { max_tokens: 57, max_completion_tokens: 123 },
  ]) {
    const response = await server.request(
      "http://localhost/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-1-flash",
          messages: [{ role: "user", content: "Search for amethyst" }],
          ...limits,
          tools: [
            {
              type: "function",
              function: {
                name: "search_observations",
                parameters,
                strict: true,
              },
            },
          ],
          tool_choice: {
            type: "function",
            function: { name: "search_observations" },
          },
        }),
      },
    )
    expect(response.status).toBe(200)
    await response.json()
    const packet = packets.at(-1)!
    const config = packet.find((node) => node.field === 8)!.sub!
    expect(config.find((node) => node.field === 2)?.varint).toBe(
      limits.max_tokens ?? 123,
    )
    const tool = packet.find((node) => node.field === 10)!.sub!
    expect(JSON.parse(fieldText(tool, 3)!)).toEqual(parameters)
    expect(tool.find((node) => node.field === 12)?.varint).toBe(1)
    const choice = packet.find((node) => node.field === 12)!.sub!
    expect(fieldText(choice, 2)).toBe("search_observations")
  }
})

const structuredSchema = {
  type: "object",
  additionalProperties: false,
  required: ["call"],
  properties: {
    call: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["name", "arguments"],
          properties: {
            name: { const: "search_observations" },
            arguments: {
              type: "object",
              additionalProperties: false,
              required: ["query", "max_tokens", "reason"],
              properties: {
                query: { type: "string" },
                max_tokens: { type: ["integer", "null"] },
                reason: { type: "string" },
              },
            },
          },
        },
        { type: "null" },
      ],
    },
  },
}

const schemaFormat = {
  type: "json_schema",
  json_schema: { name: "response", strict: true, schema: structuredSchema },
}

for (const stream of [false, true]) {
  for (const type of ["json_schema", "json_object"]) {
    test(`Windsurf structured output bridge returns validated ${type} content (stream=${stream})`, async () => {
      const expected =
        type === "json_schema" ?
          '{ "call": {"name":"search_observations","arguments":{"query":"amethyst","max_tokens":null,"reason":"lookup"}}}'
        : '{ "query": "amethyst", "nested": {"ok":true} }'
      structuredReply =
        type === "json_schema" ? expected : JSON.stringify({ json: expected })
      const response = await server.request(
        "http://localhost/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "deepseek-v4-1-flash",
            messages: [{ role: "user", content: "Return JSON" }],
            response_format: type === "json_schema" ? schemaFormat : { type },
            stream,
          }),
        },
      )
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).not.toContain("__structured_output")
      if (stream) {
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        )
        expect(body).toContain("data: [DONE]")
        const chunks = body
          .split("\n")
          .filter(
            (line) => line.startsWith("data: ") && line !== "data: [DONE]",
          )
          .map((line) => JSON.parse(line.slice(6)) as ChatCompletionChunk)
        const choices = chunks.flatMap((chunk) => chunk.choices)
        expect(
          choices.map((choice) => choice.delta.content ?? "").join(""),
        ).toBe(expected)
        expect(
          choices.every((choice) => !choice.delta.tool_calls?.length),
        ).toBe(true)
        expect(
          choices
            .filter((choice) => choice.finish_reason)
            .map((choice) => choice.finish_reason),
        ).toEqual(["stop"])
      } else {
        const result = JSON.parse(body) as ChatCompletionResponse
        expect(result.choices[0].message.content).toBe(expected)
        expect(result.choices[0].message.tool_calls?.length ?? 0).toBe(0)
        expect(result.choices[0].finish_reason).toBe("stop")
      }
      expect(packets).toHaveLength(1)
      const tools = packets[0].filter((node) => node.field === 10)
      expect(tools).toHaveLength(1)
      const tool = tools[0].sub!
      expect(fieldText(tool, 1)).toBe("__structured_output")
      expect(JSON.parse(fieldText(tool, 3)!)).toEqual(
        type === "json_schema" ? structuredSchema : (
          {
            type: "object",
            properties: {
              json: {
                type: "string",
                description:
                  "The complete JSON object answer, encoded as JSON text.",
              },
            },
            required: ["json"],
            additionalProperties: false,
          }
        ),
      )
      expect(tool.find((node) => node.field === 12)?.varint).toBe(1)
      const choice = packets[0].find((node) => node.field === 12)!.sub!
      expect(fieldText(choice, 2)).toBe("__structured_output")
    })
  }

  for (const invalid of [
    '{"call":{"name":"search_observations","arguments":{"max_tokens":null,"reason":"missing query"}}}',
    '{"call":',
  ]) {
    test(`Windsurf structured output rejects ${invalid.endsWith(":") ? "invalid JSON" : "missing required query"} before success (stream=${stream})`, async () => {
      structuredReply = invalid
      const response = await server.request(
        "http://localhost/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "deepseek-v4-1-flash",
            messages: [{ role: "user", content: "Return JSON" }],
            response_format: schemaFormat,
            stream,
          }),
        },
      )
      expect(response.status).not.toBe(200)
      expect(response.status).toBe(502)
      const body = await response.text()
      expect(body).not.toContain('"object":"chat.completion')
      expect(body).not.toContain("data: [DONE]")
      expect(body).not.toContain('"finish_reason":"stop"')
      expect(packets).toHaveLength(1)
    })
  }

  test(`Windsurf json_object rejects an array inside a valid envelope (stream=${stream})`, async () => {
    structuredReply = JSON.stringify({ json: '["not an object"]' })
    const response = await server.request(
      "http://localhost/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-1-flash",
          messages: [{ role: "user", content: "Return JSON" }],
          response_format: { type: "json_object" },
          stream,
        }),
      },
    )
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("data: [DONE]")
  })

  test(`Windsurf structured output preserves real auto tool calls (stream=${stream})`, async () => {
    const response = await server.request(
      "http://localhost/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-1-flash",
          messages: [
            { role: "user", content: "Read a file before returning JSON" },
          ],
          response_format: schemaFormat,
          stream,
          tools: [
            {
              type: "function",
              function: {
                name: "functions__read_file",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            },
          ],
          tool_choice: "auto",
        }),
      },
    )
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toContain("__structured_output")
    if (stream) {
      const chunks = body
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)) as ChatCompletionChunk)
      const choices = chunks.flatMap((chunk) => chunk.choices)
      const calls = choices.flatMap((choice) => choice.delta.tool_calls ?? [])
      expect(calls.map((call) => call.function?.name ?? "").join("")).toBe(
        "functions__read_file",
      )
      expect(calls.map((call) => call.function?.arguments ?? "").join("")).toBe(
        '{"path":"next.txt"}',
      )
      expect(choices.at(-1)?.finish_reason).toBe("tool_calls")
    } else {
      const result = JSON.parse(body) as ChatCompletionResponse
      expect(result.choices[0].message.tool_calls?.[0]).toMatchObject({
        id: "call_next",
        type: "function",
        function: {
          name: "functions__read_file",
          arguments: '{"path":"next.txt"}',
        },
      })
      expect(result.choices[0].finish_reason).toBe("tool_calls")
    }
    expect(packets).toHaveLength(1)
    expect(
      packets[0]
        .filter((node) => node.field === 10)
        .map((node) => fieldText(node.sub!, 1)),
    ).toEqual(
      expect.arrayContaining(["functions__read_file", "__structured_output"]),
    )
    const choice = packets[0].find((node) => node.field === 12)!.sub!
    expect(fieldText(choice, 1)).toBe("auto")
    expect(fieldText(choice, 2)).toBeUndefined()
  })
}

test("Windsurf malformed structured schema fails before any fetch", async () => {
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    throw new Error("malformed schema must not reach auth or upstream")
  }) as unknown as typeof fetch
  const response = await server.request(
    "http://localhost/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-1-flash",
        messages: [{ role: "user", content: "Return JSON" }],
        response_format: {
          ...schemaFormat,
          json_schema: {
            ...schemaFormat.json_schema,
            schema: { type: "not-a-json-schema-type" },
          },
        },
      }),
    },
  )
  expect(response.status).toBe(400)
  expect(fetches).toBe(0)
  expect(packets).toHaveLength(0)
})

loopbackTest(
  "Codex WebSocket chat fallback asks for full replay, then translates a self-contained turn",
  async () => {
    using appServer = Bun.serve({
      port: 0,
      fetch: server.fetch,
      websocket: bunWebsocket,
    })
    const ws = new WebSocket(`ws://localhost:${appServer.port}/v1/responses`)
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket turn timed out")),
          2000,
        )
        const finish = (value: string) => {
          clearTimeout(timeout)
          resolve(value)
        }
        ws.addEventListener("error", () => {
          clearTimeout(timeout)
          reject(new Error("WebSocket error"))
        })
        ws.addEventListener("open", () =>
          ws.send(
            JSON.stringify({
              type: "response.create",
              model: "deepseek-v4-1-flash",
              previous_response_id: "resp_previous",
              stream: true,
              input: [
                {
                  type: "function_call_output",
                  call_id: "call_previous",
                  output: "Delta only",
                },
              ],
            }),
          ),
        )
        ws.addEventListener("message", (event: MessageEvent<string>) => {
          const value = JSON.parse(event.data) as {
            type: string
            error?: { code?: string }
            status?: number
          }
          if (value.type === "error") finish(event.data)
          else if (value.type === "response.completed") finish(event.data)
        })
      })
      expect(JSON.parse(result).error.code).toBe("previous_response_not_found")
      expect(JSON.parse(result).status).toBe(400)
      expect(packets).toHaveLength(0)
      const replay = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket replay timed out")),
          2000,
        )
        ws.addEventListener("message", (event: MessageEvent<string>) => {
          const value = JSON.parse(event.data) as { type: string }
          if (value.type === "response.completed") {
            clearTimeout(timeout)
            resolve(event.data)
          } else if (value.type === "error") {
            clearTimeout(timeout)
            reject(new Error(event.data))
          }
        })
        ws.send(
          JSON.stringify({
            type: "response.create",
            model: "deepseek-v4-1-flash",
            stream: true,
            instructions: "Synthetic system instructions",
            input: [
              {
                role: "developer",
                content: "Synthetic developer instructions",
              },
              { role: "user", content: "Read a file" },
              {
                type: "function_call",
                name: "read_file",
                call_id: "call_previous",
                arguments: "{}",
              },
              {
                type: "function_call_output",
                call_id: "call_previous",
                output: "Full replay result",
              },
            ],
          }),
        )
      })
      expect(replay).toContain("Synthetic answer")
      expect(packets).toHaveLength(1)
      expect(fieldText(packets[0], 2)).toContain(
        "Synthetic developer instructions",
      )
      expect(fieldText(packets[0], 21)).toBe("deepseek-v4-1-flash-high")
    } finally {
      ws.close()
    }
  },
)

for (const stream of [false, true]) {
  test(`Windsurf Chat keeps late reasoning out of visible content (stream=${stream})`, async () => {
    const response = await server.request(
      "http://localhost/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-1-flash",
          messages: [{ role: "user", content: "Answer briefly" }],
          stream,
        }),
      },
    )
    expect(response.status).toBe(200)
    if (stream) {
      const deltas = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .flatMap((line) =>
          (JSON.parse(line.slice(6)) as ChatCompletionChunk).choices.map(
            (choice) => choice.delta,
          ),
        )
      expect(deltas.map((delta) => delta.content ?? "").join("")).toBe(
        "Synthetic answer",
      )
      expect(
        deltas.map((delta) => delta.reasoning_content ?? "").join(""),
      ).toBe("Synthetic reasoning and a late thought")
    } else {
      const body = (await response.json()) as ChatCompletionResponse
      expect(body.choices[0].message.content).toBe("Synthetic answer")
      expect(body.choices[0].message.reasoning_content).toBe(
        "Synthetic reasoning and a late thought",
      )
      expect(body.choices[0].message.reasoning_text).toBeUndefined()
      expect(body.choices[0].message.tool_calls?.[0].function.name).toBe(
        "functions__read_file",
      )
    }
    expect(packets).toHaveLength(1)
  })

  test(`Responses to Windsurf preserves Codex instructions, namespace tools and replay (stream=${stream})`, async () => {
    const targets = buildRouteTargets({
      publicModelId: "deepseek-v4-1-flash",
      endpoint: "responses",
    })
    expect(targets).toHaveLength(1)
    expect(targets[0].endpoint).toBe("chat")
    expect(targets[0].isTranslated).toBe(true)
    const response = await server.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-1-flash",
        stream,
        instructions: "Synthetic system instructions",
        reasoning: { effort: "high" },
        input: [
          { role: "developer", content: "Synthetic developer instructions" },
          { role: "user", content: "Read a file" },
          {
            type: "reasoning",
            summary: [
              { type: "summary_text", text: "Synthetic historical reasoning" },
            ],
          },
          {
            type: "function_call",
            call_id: "call_previous",
            namespace: "functions",
            name: "read_file",
            arguments: '{"path":"previous.txt"}',
          },
          {
            type: "function_call_output",
            call_id: "call_previous",
            output: "Synthetic tool result",
          },
          { role: "user", content: "Continue" },
        ],
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              {
                type: "function",
                name: "read_file",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            ],
          },
        ],
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("Synthetic answer")
    expect(body).toContain("Synthetic reasoning")
    expect(body).toContain('"name":"read_file"')
    expect(body).toContain('"namespace":"functions"')
    if (stream) expect(body).toContain("response.completed")
    else {
      const result = JSON.parse(body)
      expect(result.object).toBe("response")
      expect(
        result.output
          .filter((item: { type: string }) => item.type === "reasoning")
          .flatMap((item: { summary: Array<{ text: string }> }) =>
            item.summary.map((part) => part.text),
          ),
      ).toEqual(["Synthetic reasoning", " and a late thought"])
      expect(
        result.output
          .filter((item: { type: string }) => item.type === "message")
          .flatMap((item: { content: Array<{ text: string }> }) =>
            item.content.map((part) => part.text),
          ),
      ).toEqual(["Synthetic answer"])
    }
    expect(packets).toHaveLength(1)
    const packet = packets[0]
    expect(fieldText(packet, 21)).toBe("deepseek-v4-1-flash-high")
    const prompts = packet
      .filter((node) => node.field === 3)
      .map((node) => node.sub ?? [])
    expect(
      prompts.some(
        (nodes) => fieldText(nodes, 3) === "Synthetic developer instructions",
      ),
    ).toBe(false)
    expect(fieldText(packet, 2)).toContain("Synthetic system instructions")
    expect(fieldText(packet, 2)).toContain("Synthetic developer instructions")
    const assistant = prompts.find((nodes) =>
      nodes.some((node) => node.field === 6),
    )!
    expect(fieldText(assistant, 11)).toBe("Synthetic historical reasoning")
    const call = assistant.find((node) => node.field === 6)!.sub!
    expect(fieldText(call, 1)).toBe("call_previous")
    expect(fieldText(call, 2)).toBe("functions__read_file")
    const result = prompts.find(
      (nodes) => fieldText(nodes, 7) === "call_previous",
    )!
    expect(fieldText(result, 3)).toBe("Synthetic tool result")
    const tool = packet.find((node) => node.field === 10)!.sub!
    expect(fieldText(tool, 1)).toBe("functions__read_file")
    expect(JSON.parse(fieldText(tool, 3)!).required).toEqual(["path"])
  })
}
