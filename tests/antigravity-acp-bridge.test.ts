import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono, type Context } from "hono"

import { HTTPError } from "~/lib/error"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { managedConnectionFromInput } from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"
import { startRequestPerformance } from "~/lib/request-performance"
import { handleNonStreamingResponse } from "~/routes/chat-completions/non-streaming"
import { recordDirectStreamingUsage } from "~/routes/messages/usage-recorder"
import { antigravityMcpRoutes } from "~/routes/antigravity-mcp/route"
import {
  createAntigravityAcpChatCompletionsOnce,
  matchRunHistory,
  classifyColdReplay,
  type ColdReplayCandidate,
} from "~/services/antigravity/acp/bridge"
import { hashMessages } from "~/services/antigravity/acp/prompt"
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
  const agentScript = path.join(
    import.meta.dir,
    "fixtures/antigravity-acp-agent.ts",
  )
  if (process.platform === "win32") {
    const launcher = path.join(dataDir, "agy.cmd")
    writeFileSync(
      launcher,
      `@echo off\r\n"${process.execPath}" "${agentScript}" %*\r\n`,
    )
    process.env.AGY_CLI_PATH = launcher
  } else {
    process.env.AGY_CLI_PATH = agentScript
  }
  const app = new Hono().route(
    "/_internal/antigravity-mcp",
    antigravityMcpRoutes,
  )
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
  setAntigravityCallbackBaseUrl(`http://127.0.0.1:${server.port}`)
})
async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code === "EBUSY" || code === "EPERM") && attempt < 19) {
        await Bun.sleep(25)
        continue
      }
      throw error
    }
  }
}

afterEach(async () => {
  runRegistry.disposeAll()
  server?.stop(true)
  redirectPathsToDir(originalDir)
  setAntigravityCallbackBaseUrl(originalCallback)
  if (originalBinary === undefined) delete process.env.AGY_CLI_PATH
  else process.env.AGY_CLI_PATH = originalBinary
  if (dataDir) await removeTempDir(dataDir)
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
  for (const stream of [false, true]) {
    loopbackTest(
      `rejects oversized native input before opening ${stream ? "streaming" : "non-streaming"} replies`,
      async () => {
        const cases: Array<Message[]> = [
          [{ role: "user", content: "a".repeat(191000) }],
          [{ role: "user", content: "汉".repeat(70000) }],
          [
            { role: "user", content: "a".repeat(100000) },
            { role: "assistant", content: "Historical response" },
            { role: "user", content: "b".repeat(100000) },
          ],
        ]
        for (const messages of cases) {
          const error: unknown = await complete(messages, false, stream).then(
            () => undefined,
            (failure: unknown) => failure,
          )
          expect(error).toBeInstanceOf(HTTPError)
          if (!(error instanceof HTTPError))
            throw new Error("Expected HTTPError")
          expect(error.response.status).toBe(400)
          expect(JSON.parse(error.responseBody).error).toMatchObject({
            code: "context_length_exceeded",
            type: "invalid_request_error",
            param: "messages",
          })
          expect(
            runRegistry.findCandidates(
              connection.id,
              "gemini-3.8-flash",
              undefined,
              JSON.stringify([connection.credentials.at(0)!.id, null]),
            ),
          ).toHaveLength(0)
        }
        const compacted = await complete(
          [
            {
              role: "user",
              content: "a".repeat(189000),
            },
          ],
          false,
          stream,
        )
        expect(compacted.choices[0].finish_reason).toBe("stop")
      },
    )
  }

  loopbackTest(
    "native prompt budget preserves long warm conversations and a rejected follow-up can recover",
    async () => {
      const messages: Message[] = [
        { role: "user", content: "a".repeat(100000) },
      ]
      const first = await complete(messages)
      messages.push(assistant(first), {
        role: "user",
        content: "b".repeat(100000),
      })
      const second = await complete(messages)
      const session = String(first.choices[0].message.content).split(":")[0]
      expect(second.choices[0].message.content).toBe(`${session}:2`)
      messages.push(assistant(second))
      const error: unknown = await complete([
        ...messages,
        { role: "user", content: "c".repeat(200000) },
      ]).then(
        () => undefined,
        (failure: unknown) => failure,
      )
      expect(error).toBeInstanceOf(HTTPError)
      const recovered = await complete([
        ...messages,
        { role: "user", content: "A shorter current question." },
      ])
      expect(recovered.choices[0].message.content).toBe(`${session}:3`)
    },
  )

  loopbackTest(
    "cancelling before the tool terminal retains native billing without emitting usage",
    async () => {
      statsStore.clearUsageStatsForTest()
      try {
        const c = await requestContext()
        c.set("model", "gemini-3.8-flash")
        const controller = new AbortController()
        const response = (await createAntigravityAcpChatCompletionsOnce(
          { connection, credential: connection.credentials.at(0)!, c },
          {
            model: "gemini-3.8-flash",
            messages: [{ role: "user", content: "TOOL_LOOP NATIVE_STEPS" }],
            tools,
            stream: true,
          },
          controller.signal,
        )) as AsyncIterable<{ data?: string }>
        const iterator = response[Symbol.asyncIterator]()
        const first = JSON.parse(
          (await iterator.next()).value!.data!,
        ) as ChatCompletionChunk
        expect(first.choices[0].delta.reasoning_content).toBeTruthy()
        const second = JSON.parse(
          (await iterator.next()).value!.data!,
        ) as ChatCompletionChunk
        expect(second.choices[0].delta.tool_calls).toHaveLength(1)
        expect(second.usage).toBeUndefined()
        controller.abort()
        expect((await iterator.next()).done).toBe(true)
        recordDirectStreamingUsage(c, connection.id, undefined)
        expect(statsStore.getUsageStats(connection.id)[0]).toMatchObject({
          requests: 1,
          promptTokens: 40,
          cacheReadTokens: 90,
          completionTokens: 7,
          totalTokens: 137,
        })
      } finally {
        statsStore.clearUsageStatsForTest()
      }
    },
  )

  loopbackTest(
    "parked tool results preserve inline images and text in order",
    async () => {
      const messages: Message[] = [
        { role: "user", content: "TOOL_LOOP IMAGE_RESULT" },
      ]
      const first = await complete(messages, true)
      const prefix = String(first.choices[0].message.reasoning_content)
      const resultContent = [
        { type: "text" as const, text: "before" },
        {
          type: "image_url" as const,
          image_url: { url: "data:image/png;base64,AAAA" },
        },
        { type: "text" as const, text: "after" },
      ]
      for (let step = 0, response = first; step < 2; step++) {
        const call = response.choices[0].message.tool_calls![0]
        messages.push(assistant(response), {
          role: "tool",
          tool_call_id: call.id,
          content: step === 0 ? resultContent : "second-result",
        })
        response = await complete(messages, true)
        if (step === 1) {
          expect(response.choices[0].message.content).toContain(
            JSON.stringify([
              { type: "text", text: "before" },
              { type: "image", mimeType: "image/png", data: "AAAA" },
              { type: "text", text: "after" },
            ]),
          )
          expect(response.choices[0].message.content).not.toContain("replayed:")
          expect(response.choices[0].message.content).toContain("second-result")
          // Both continuations kept the native session that produced the first thought.
          expect(response.choices[0].message.content).toContain(
            prefix.replace("native-reasoning-", ""),
          )
        }
      }
    },
  )

  for (const scenario of [
    "content",
    "thinking",
    "error",
    "abort",
    "abort-after-text",
  ] as const) {
    loopbackTest(
      `tool batch handles ${scenario} before its terminal`,
      async () => {
        const controller = new AbortController()
        const result = (await createAntigravityAcpChatCompletionsOnce(
          { connection, credential: connection.credentials[0] },
          {
            model: "gemini-3.8-flash",
            messages: [{ role: "user", content: "BATCH_HOLD" }],
            tools,
            stream: true,
          },
          controller.signal,
        )) as AsyncIterable<{ data?: string }>
        const ownerKey = JSON.stringify([connection.credentials[0].id, null])
        const run = runRegistry.findCandidates(
          connection.id,
          "gemini-3.8-flash",
          undefined,
          ownerKey,
        )[0]!
        // Queue a real parked callback before advancing the public stream.
        void run
          .parkMcpToolCall("lookup_probe", { value: "first" })
          .catch(() => {})
        const iterator = result[Symbol.asyncIterator]()
        const pending = iterator.next()
        await Promise.resolve() // stream has entered the 40ms batch wait
        if (scenario === "error") {
          run.pushEvent({ type: "text", text: "must not mask the failure" })
          run.pushEvent({ type: "error", message: "Synthetic peer failure" })
          runRegistry.dispose(run.token)
          await expect(pending).rejects.toThrow("Synthetic peer failure")
          return
        }
        if (scenario === "abort") {
          controller.abort()
          expect((await pending).done).toBe(true)
          return
        }
        void run
          .parkMcpToolCall("lookup_probe", { value: "second" })
          .catch(() => {})
        run.pushEvent(
          scenario === "thinking" ?
            { type: "thinking", text: "batch-thought" }
          : { type: "text", text: "batch-text" },
        )
        const first = await pending
        const chunk = JSON.parse(first.value!.data!) as ChatCompletionChunk
        expect(chunk.choices[0].delta.role).toBe("assistant")
        if (scenario === "thinking")
          expect(chunk.choices[0].delta.reasoning_content).toBe("batch-thought")
        else expect(chunk.choices[0].delta.content).toBe("batch-text")
        if (scenario === "abort-after-text") {
          controller.abort()
          expect((await iterator.next()).done).toBe(true)
          return
        }
        const chunks: ChatCompletionChunk[] = []
        for (
          let next = await iterator.next();
          !next.done;
          next = await iterator.next()
        ) {
          if (next.value.data !== "[DONE]")
            chunks.push(JSON.parse(next.value.data!))
        }
        expect(
          chunks
            .flatMap((item) => item.choices)
            .filter((choice) => choice.delta.role),
        ).toHaveLength(0)
        const calls = chunks
          .flatMap((item) => item.choices)
          .flatMap((choice) => choice.delta.tool_calls ?? [])
        expect(calls.map((call) => call.function)).toEqual([
          { name: "lookup_probe", arguments: '{"value":"first"}' },
          { name: "lookup_probe", arguments: '{"value":"second"}' },
        ])
        expect(chunks.at(-1)?.choices[0].finish_reason).toBe("tool_calls")
      },
    )
  }

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
    "a single matching session is reused even when the client normalizes the assistant echo",
    async () => {
      const initial: Message[] = [
        { role: "user", content: "Warm reuse request" },
      ]
      const first = await complete(initial)
      const session = String(first.choices[0].message.content).split(":")[0]
      const next = await complete([
        ...initial,
        { role: "assistant", content: "client-normalized reply" },
        { role: "user", content: "Continue the same conversation" },
      ])
      expect(next.choices[0].message.content).toBe(`${session}:2`)
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
    "parked tool continuation resumes warm session even when assistant echo is normalized",
    async () => {
      const messages: Message[] = [
        { role: "user", content: "TOOL_LOOP IMAGE_RESULT" },
      ]
      let response = await complete(messages, true)
      const prefix = String(response.choices[0].message.reasoning_content)
      for (let step = 0; step < 2; step++) {
        const call = response.choices[0].message.tool_calls![0]
        messages.push(
          {
            ...assistant(response),
            content: `client-normalized tool preamble ${step}`,
          },
          {
            role: "tool",
            tool_call_id: call.id,
            content: `normalized-echo-result-${step}`,
          },
        )
        response = await complete(messages, true)
      }
      expect(response.choices[0].finish_reason).toBe("stop")
      expect(response.choices[0].message.content).not.toContain("replayed:")
      expect(response.choices[0].message.content).toContain(
        prefix.replace("native-reasoning-", ""),
      )
      expect(response.choices[0].message.content).toContain(
        "normalized-echo-result-0",
      )
      expect(response.choices[0].message.content).toContain(
        "normalized-echo-result-1",
      )
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

  for (const stream of [false, true]) {
    loopbackTest(
      `native step usage is independent of aggregate billing and resets on the next prompt: ${stream}`,
      async () => {
        statsStore.clearUsageStatsForTest()
        try {
          const messages: Message[] = [
            { role: "user", content: "TOOL_LOOP NATIVE_STEPS" },
          ]
          const expected = [
            { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
            { prompt_tokens: 110, completion_tokens: 7, total_tokens: 117 },
            { prompt_tokens: 730, completion_tokens: 8, total_tokens: 738 },
          ]
          for (let step = 0; step < 3; step++) {
            const c = await requestContext()
            c.set("model", "gemini-3.8-flash")
            c.set("accountId", connection.id)
            const response = await complete(messages, true, stream, c)
            expect(response.usage).toMatchObject(expected[step]!)
            expect(
              response.usage?.completion_tokens_details?.reasoning_tokens,
            ).toBe(1)
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
            promptTokens: 130,
            cacheReadTokens: 840,
            completionTokens: 22,
            totalTokens: 992,
          })
          const c = await requestContext()
          c.set("model", "gemini-3.8-flash")
          c.set("accountId", connection.id)
          const next = await complete(
            [
              ...messages,
              {
                role: "user",
                content: "Continue without repeating previous results",
              },
            ],
            true,
            stream,
            c,
          )
          expect(next.usage).toMatchObject({
            prompt_tokens: 1000,
            completion_tokens: 20,
            total_tokens: 1020,
          })
          handleNonStreamingResponse(c, next, 12345, 1)
          expect(statsStore.getUsageStats(connection.id)[0]).toMatchObject({
            promptTokens: 250,
            cacheReadTokens: 1720,
            completionTokens: 42,
            totalTokens: 2012,
          })
        } finally {
          statsStore.clearUsageStatsForTest()
        }
      },
    )
  }

  for (const mode of ["", "SNAPSHOT", "SNAPSHOT_GAP", "PARTIAL"]) {
    loopbackTest(
      `tool loop bills once and exposes context occupancy: ${mode || "final-only"}`,
      async () => {
        statsStore.clearUsageStatsForTest()
        const messages: Message[] = [
          { role: "user", content: `TOOL_LOOP ${mode}` },
        ]
        const responses: ChatCompletionResponse[] = []
        for (let step = 0; step < 3; step++) {
          const c = await requestContext()
          c.set("model", "gemini-3.8-flash")
          c.set("accountId", connection.id)
          const response = await complete(
            messages,
            true,
            mode === "SNAPSHOT",
            c,
          )
          handleNonStreamingResponse(c, response, 12345, 1)
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
        // This peer supplies no native generation records. Preserve real billing,
        // but never publish the prompt aggregate or occupancy as per-step usage.
        for (const response of responses)
          expect(response.usage).toMatchObject({
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            usage_status: "pending",
          })
        expect(statsStore.getUsageStats(connection.id)[0]).toMatchObject({
          promptTokens: 120,
          cacheReadTokens: 880,
          completionTokens: 20,
          totalTokens: 1020,
        })
        expect(responses.at(-1)!.usage).toMatchObject({
          context_window: { used_tokens: 55000, max_tokens: 200000 },
        })
        if (!mode)
          expect(responses[0].usage).toMatchObject({
            prompt_tokens: 0,
            usage_status: "pending",
          })
        if (mode === "SNAPSHOT_GAP")
          expect(responses[1].usage).toMatchObject({
            prompt_tokens: 0,
            usage_status: "pending",
          })
        expect(responses.at(-1)!.choices[0].message.content).toContain(
          "result-0:result-1",
        )
        statsStore.clearUsageStatsForTest()
      },
    )
  }
})

describe("antigravity acp cold-replay diagnostics", () => {
  const history: Message[] = [
    { role: "user", content: "review the change" },
    { role: "assistant", content: "reviewed" },
  ]
  const followUp: Message[] = [...history, { role: "user", content: "fix it" }]
  const candidate = (
    overrides: Partial<ColdReplayCandidate> = {},
  ): ColdReplayCandidate => ({
    toolsSignature: "sig",
    lastMessageCount: 1,
    lastMessageHash: hashMessages(history.slice(0, 1)),
    lastAssistantHash: hashMessages([history[1]]),
    isIdle: true,
    activePromptInFlight: false,
    parkedCount: 0,
    hasParkedCall: () => false,
    ...overrides,
  })
  const payload = (messages: Message[]): ChatCompletionsPayload => ({
    model: "test",
    messages,
  })

  test("a fully matching idle candidate reports ok and a user-only delta", () => {
    const match = matchRunHistory(candidate(), followUp, "sig")
    expect(match.ok).toBe(true)
    const diag = classifyColdReplay([candidate()], payload(followUp), "sig", [])
    expect(diag.reason).toBe("no_reusable_candidate")
    expect(diag.candidates[0]).toMatchObject({
      idle: true,
      deltaCount: 1,
      deltaRolesOK: true,
      history: { ok: true },
    })
  })

  test("isolates each reuse-gate failure", () => {
    const cases: Array<[string, Partial<ColdReplayCandidate>, string]> = [
      ["tools signature", { toolsSignature: "other" }, "toolsMatch"],
      ["prefix hash", { lastMessageHash: "stale" }, "prefixMatch"],
      ["assistant echo", { lastAssistantHash: "stale" }, "assistantMatch"],
      ["zero count", { lastMessageCount: 0 }, "countPositive"],
    ]
    for (const [, overrides, field] of cases) {
      const match = matchRunHistory(candidate(overrides), followUp, "sig")
      expect(match.ok).toBe(false)
      expect(match[field as keyof typeof match]).toBe(false)
    }
    // previous message is not an assistant reply
    const userTail = matchRunHistory(
      candidate(),
      [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
      "sig",
    )
    expect(userTail.previousAssistant).toBe(false)
    expect(userTail.ok).toBe(false)
  })

  test("flags a delta that carries assistant/tool messages", () => {
    const toolDelta: Message[] = [
      ...history,
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "t", content: "result" },
    ]
    const diag = classifyColdReplay(
      [candidate()],
      payload(toolDelta),
      "sig",
      [],
    )
    expect(diag.candidates[0].deltaRolesOK).toBe(false)
  })

  test("classifies the fallback reason by candidate and tool-result presence", () => {
    expect(classifyColdReplay([], payload(followUp), "sig", []).reason).toBe(
      "no_candidate",
    )
    expect(
      classifyColdReplay([], payload(followUp), "sig", [{ toolCallId: "t" }])
        .reason,
    ).toBe("no_candidate_for_tool_result")
    expect(
      classifyColdReplay([candidate()], payload(followUp), "sig", [
        { toolCallId: "t" },
      ]).reason,
    ).toBe("tool_result_not_resumed")
    const parked = classifyColdReplay(
      [candidate({ hasParkedCall: (id) => id === "t" })],
      payload(followUp),
      "sig",
      [{ toolCallId: "t" }],
    )
    expect(parked.candidates[0].parked).toBe(true)
  })
})
