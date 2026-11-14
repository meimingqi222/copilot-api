import { afterEach, beforeEach, describe, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono, type Context } from "hono"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { managedConnectionFromInput } from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"
import { startRequestPerformance } from "~/lib/request-performance"
import { handleNonStreamingResponse } from "~/routes/chat-completions/non-streaming"
import { antigravityMcpRoutes } from "~/routes/antigravity-mcp/route"
import { createAntigravityAcpChatCompletionsOnce } from "~/services/antigravity/acp/bridge"
import { runRegistry } from "~/services/antigravity/acp/run-registry"
import {
  antigravityCallbackBaseUrl,
  setAntigravityCallbackBaseUrl,
} from "~/services/antigravity/acp/server-address"
import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatCompletionsPayload,
  Message,
} from "~/services/protocols/chat/types"

import { loopbackTest } from "./helpers/loopback-test"

const originalDir = PATHS.APP_DIR
const originalBinary = process.env.AGY_CLI_PATH
const originalCallback = antigravityCallbackBaseUrl()
let dataDir: string
let server: ReturnType<typeof Bun.serve>
const connection = managedConnectionFromInput({
  id: "synthetic-acp",
  provider: "antigravity",
  name: "Synthetic ACP",
})
connection.credentials[0].value = "synthetic-token"
connection.credentials[0].context = { expiresAt: Date.now() + 3600000 }
const tools: ChatCompletionsPayload["tools"] = [
  {
    type: "function",
    function: {
      name: "lookup_probe",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  },
]

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "acp-bridge-"))
  redirectPathsToDir(dataDir)
  process.env.AGY_CLI_PATH = path.join(
    import.meta.dir,
    "fixtures/antigravity-acp-agent.ts",
  )
  const app = new Hono().route(
    "/_internal/antigravity-mcp",
    antigravityMcpRoutes,
  )
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
  setAntigravityCallbackBaseUrl(`http://127.0.0.1:${server.port}`)
})
afterEach(() => {
  runRegistry.disposeAll()
  server?.stop(true)
  redirectPathsToDir(originalDir)
  setAntigravityCallbackBaseUrl(originalCallback)
  if (originalBinary === undefined) delete process.env.AGY_CLI_PATH
  else process.env.AGY_CLI_PATH = originalBinary
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})
async function complete(
  messages: Message[],
  withTools = false,
  stream = false,
  c?: Context,
): Promise<ChatCompletionResponse> {
  const result = await createAntigravityAcpChatCompletionsOnce(
    { connection, credential: connection.credentials[0], c },
    {
      model: "gemini-3.8-flash",
      messages,
      tools: withTools ? tools : undefined,
      stream,
    },
  )
  if (!stream) return result as ChatCompletionResponse
  const response: ChatCompletionResponse = {
    id: "",
    object: "chat.completion",
    created: 0,
    model: "gemini-3.8-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  }
  for await (const event of result as AsyncIterable<{ data?: string }>) {
    if (!event.data || event.data === "[DONE]") continue
    const chunk = JSON.parse(event.data) as ChatCompletionChunk
    if (chunk.usage) response.usage = chunk.usage
    const choice = chunk.choices[0]
    if (!choice) continue
    if (typeof choice.delta.content === "string")
      response.choices[0].message.content =
        String(response.choices[0].message.content ?? "") + choice.delta.content
    if (choice.delta.tool_calls)
      response.choices[0].message.tool_calls = choice.delta.tool_calls.map(
        (call) => ({
          id: call.id!,
          type: "function",
          function: {
            name: call.function!.name!,
            arguments: call.function!.arguments!,
          },
        }),
      )
    if (choice.finish_reason)
      response.choices[0].finish_reason = choice.finish_reason
  }
  return response
}
function assistant(response: ChatCompletionResponse): Message {
  return { ...response.choices[0].message, role: "assistant" }
}

async function requestContext(userId?: string): Promise<Context> {
  let context!: Context
  await new Hono()
    .get("/", (c) => {
      context = c
      if (userId) c.set("userId", userId)
      return c.text("ok")
    })
    .request("/")
  return context
}

describe("ACP public bridge continuations", () => {
  loopbackTest(
    "same-prefix conversations resume their own completed assistant history",
    async () => {
      const initial: Message[] = [
        { role: "user", content: "Same initial request" },
      ]
      const a = await complete(initial)
      const b = await complete(initial)
      const aText = String(a.choices[0].message.content)
      const bText = String(b.choices[0].message.content)
      expect(aText).not.toBe(bText)
      const next = await complete([
        ...initial,
        {
          ...assistant(a),
          content: [{ type: "text", text: aText }],
          reasoning_content: undefined,
        },
        { role: "user", content: "Continue A only" },
      ])
      expect(next.choices[0].message.content).toBe(aText.replace(/:1$/, ":2"))
    },
  )

  loopbackTest(
    "ambiguous native sessions are replayed instead of choosing hidden reasoning arbitrarily",
    async () => {
      const initial: Message[] = [{ role: "user", content: "SAME_VISIBLE" }]
      const first = await complete(initial)
      const second = await complete(initial)
      expect(first.choices[0].message.content).toBe(
        second.choices[0].message.content,
      )
      const next = await complete([
        ...initial,
        assistant(first),
        { role: "user", content: "Newest request" },
      ])
      expect(next.choices[0].message.content).toContain("replayed:")
      expect(next.choices[0].message.content).toContain("Newest request")
    },
  )

  loopbackTest(
    "native context cannot be reused by another API user",
    async () => {
      const c1 = await requestContext("synthetic-user-a")
      const c2 = await requestContext("synthetic-user-b")
      const initial: Message[] = [
        { role: "user", content: "Owner-scoped request" },
      ]
      const first = await complete(initial, false, false, c1)
      const next = await complete(
        [...initial, assistant(first), { role: "user", content: "Continue" }],
        false,
        false,
        c2,
      )
      expect(next.choices[0].message.content).toContain("replayed:")
    },
  )

  loopbackTest(
    "changed instructions on a tool continuation are replayed, not silently discarded",
    async () => {
      const initial: Message[] = [
        { role: "system", content: "Original instructions" },
        { role: "user", content: "TOOL_LOOP" },
      ]
      const first = await complete(initial, true)
      const call = first.choices[0].message.tool_calls![0]
      const next = await complete(
        [
          { role: "system", content: "NEW instruction: use Spanish" },
          initial[1],
          assistant(first),
          {
            role: "tool",
            tool_call_id: call.id,
            content: "independent-result",
          },
        ],
        true,
      )
      expect(next.choices[0].finish_reason).toBe("stop")
      expect(next.choices[0].message.content).toContain(
        "NEW instruction: use Spanish",
      )
      expect(next.choices[0].message.content).toContain("independent-result")
    },
  )

  loopbackTest(
    "HTTP accounting does not charge estimates or divide cumulative output by the last segment",
    async () => {
      statsStore.clearUsageStatsForTest()
      try {
        const messages: Message[] = [
          { role: "user", content: "TOOL_LOOP TIMING" },
        ]
        for (let step = 0; step < 3; step++) {
          const c = await requestContext()
          c.set("model", "gemini-3.8-flash")
          c.set("accountId", connection.id)
          startRequestPerformance(c)
          const response = await complete(messages, true, false, c)
          handleNonStreamingResponse(c, response, 12345, 1)
          messages.push(assistant(response))
          if (step < 2)
            messages.push({
              role: "tool",
              tool_call_id: response.choices[0].message.tool_calls![0].id,
              content: `result-${step}`,
            })
        }
        expect(statsStore.getUsageStats(connection.id)[0]).toMatchObject({
          promptTokens: 120,
          completionTokens: 20,
          cacheReadTokens: 880,
          totalTokens: 1020,
        })
        const summary = statsStore.getPerformanceSummaryInRange({
          startMs: 0,
          endMs: Date.now() + 1000,
        })
        expect(summary.tpsSamples).toBe(1)
        expect(summary.avgTps).toBeGreaterThan(0)
        expect(summary.avgTps).toBeLessThan(100)
      } finally {
        statsStore.clearUsageStatsForTest()
      }
    },
  )

  for (const mode of ["", "SNAPSHOT", "PARTIAL"]) {
    loopbackTest(
      `tool loop bills once and exposes context occupancy: ${mode || "final-only"}`,
      async () => {
        const messages: Message[] = [
          { role: "user", content: `TOOL_LOOP ${mode}` },
        ]
        const responses: ChatCompletionResponse[] = []
        for (let step = 0; step < 3; step++) {
          const response = await complete(messages, true, mode === "SNAPSHOT")
          responses.push(response)
          messages.push(assistant(response))
          if (step < 2) {
            const call = response.choices[0].message.tool_calls![0]
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `result-${step}`,
            })
          }
        }
        expect(
          responses
            .map((response) => response.usage?.prompt_tokens ?? -10000)
            .reduce((a, b) => a + b),
        ).toBe(1000)
        expect(
          responses
            .map((response) => response.usage?.completion_tokens ?? -10000)
            .reduce((a, b) => a + b),
        ).toBe(20)
        expect(
          responses
            .map(
              (response) =>
                response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
            )
            .reduce((a, b) => a + b),
        ).toBe(880)
        expect(responses.at(-1)!.usage).toMatchObject({
          context_window: { used_tokens: 55000, max_tokens: 200000 },
        })
        if (!mode)
          expect(responses[0].usage).toMatchObject({
            prompt_tokens: 0,
            usage_status: "pending",
          })
        expect(responses.at(-1)!.choices[0].message.content).toContain(
          "result-0:result-1",
        )
      },
    )
  }
})
