import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { ProviderConnection } from "~/lib/provider-connections"
import type { ProtobufNode } from "~/services/windsurf/protobuf"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import { bunWebsocket } from "~/lib/bun-websocket"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { buildRouteTargets } from "~/lib/route-target"
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

function fieldText(
  nodes: Array<ProtobufNode>,
  field: number,
): string | undefined {
  const raw = nodes.find((node) => node.field === field)?.raw
  return raw ? new TextDecoder().decode(raw) : undefined
}

test("Windsurf shares developer-to-system normalization without mutating caller history", () => {
  const payload: ChatCompletionsPayload = {
    model: "deepseek-v4-1-flash",
    messages: [
      { role: "system", content: "System instruction" },
      { role: "developer", content: "Developer instruction" },
      { role: "user", content: "User question" },
    ],
  }
  const original = structuredClone(payload)
  const framed = buildRequest({
    payload,
    apiKey: "test-key",
    requestModel: "deepseek-v4-1-flash-high",
    cascadeId: "roles-test",
    turnIndex: 0,
  })
  const packet = parseMessage(
    Bun.gunzipSync(Buffer.from(framed.subarray(5))),
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
  resetProtectedRouteGuardForTest()
  clearDevinUserJwtCacheForTest()
  packets = []
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
    const bytes =
      framed[0] === 1 ?
        Bun.gunzipSync(Buffer.from(framed.subarray(5)))
      : framed.subarray(5)
    packets.push(parseMessage(bytes, 0, 6))
    const frame = new ProtobufEncoder()
    frame.writeString(9, "Synthetic reasoning")
    frame.writeString(3, "Synthetic answer")
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
  clearDevinUserJwtCacheForTest()
  resetWindsurfConcurrencyForTest()
  statsStore.clearUsageStatsForTest()
  redirectPathsToDir(originalDir)
  await fs.rm(testDir, { recursive: true, force: true })
})

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
    else expect(JSON.parse(body).object).toBe("response")
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
