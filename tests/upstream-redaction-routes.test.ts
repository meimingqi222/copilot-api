import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { Hono } from "hono"

import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { initializeSystemConfig } from "~/lib/system-config"
import { server } from "~/server"
import { runRedactedCall } from "~/lib/redaction/context"
import { createClaudeMessagesOnce } from "~/services/claude/create-messages-once"
import { setClaudeCliTestHooks } from "~/services/claude/cli/binary"
import { runRegistry } from "~/services/claude/cli/run-registry"
import {
  installFakeClaude,
  testConnection,
  testCredential,
} from "./claude-cli-fixtures"
import { claudeMcpRoutes } from "~/routes/claude-mcp/route"
import {
  setClaudeCallbackBaseUrl,
  resetClaudeCallbackBaseUrlForTest,
} from "~/services/claude/cli/server-address"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"

const originalFetch = globalThis.fetch
const originalKey = state.legacyApiKey
const originalUsers = state.users
const originalEnv = process.env.UPSTREAM_REDACTION
const originalWords = process.env.SENSITIVE_WORDS
const text = "/home/redaction-user/work and DB_PASSWORD=verySecret123"

beforeEach(() => {
  __resetProviderConnectionsForTest()
  resetProtectedRouteGuardForTest()
  resetAdaptiveRateLimiterForTest()
  state.legacyApiKey = "redaction-test-key"
  state.users = []
  delete process.env.SENSITIVE_WORDS
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.legacyApiKey = originalKey
  state.users = originalUsers
  if (originalEnv === undefined) delete process.env.UPSTREAM_REDACTION
  else process.env.UPSTREAM_REDACTION = originalEnv
  if (originalWords === undefined) delete process.env.SENSITIVE_WORDS
  else process.env.SENSITIVE_WORDS = originalWords
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
})

type Wire = "chat" | "messages" | "responses" | "gemini"
const protocols = {
  chat: "openai-compatible",
  messages: "anthropic-compatible",
  responses: "openai-responses-compatible",
  gemini: "gemini-compatible",
} as const

async function connection(wire: Wire) {
  await createConnection({
    id: "redaction-backend",
    name: "redaction-backend",
    protocol: protocols[wire],
    baseUrl: "https://redaction-upstream.test/v1",
    credentials: [
      {
        id: "redaction-credential",
        value: "upstream-auth",
        authMode: "bearer",
      },
    ],
    models: [
      {
        publicId: "redaction-model",
        upstreamId: "redaction-model",
        endpoints: [wire],
        enabled: true,
      },
    ],
  })
}

function request(wire: Wire, streaming: boolean): Request {
  const path =
    wire === "chat" ? "/v1/chat/completions"
    : wire === "messages" ? "/v1/messages"
    : wire === "responses" ? "/v1/responses"
    : `/v1beta/models/redaction-model:${streaming ? "streamGenerateContent" : "generateContent"}`
  const body =
    wire === "responses" ?
      { model: "redaction-model", input: text, stream: streaming }
    : wire === "gemini" ? { contents: [{ role: "user", parts: [{ text }] }] }
    : {
        model: "redaction-model",
        max_tokens: 256,
        messages: [{ role: "user", content: text }],
        stream: streaming,
      }
  return new Request("http://localhost" + path, {
    method: "POST",
    headers: {
      authorization: "Bearer redaction-test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function readText(body: Record<string, unknown>, wire: Wire): string {
  if (wire === "responses") return body.input as string
  if (wire === "gemini")
    return (body.contents as Array<{ parts: Array<{ text: string }> }>)[0]
      .parts[0].text
  const content = (
    body.messages as Array<{ content: string | Array<{ text: string }> }>
  )[0].content
  return typeof content === "string" ? content : content[0].text
}

function result(wire: Wire, masked: string): Record<string, unknown> {
  if (wire === "chat")
    return {
      id: "chat_1",
      object: "chat.completion",
      created: 1,
      model: "redaction-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: masked },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }
  if (wire === "messages")
    return {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "redaction-model",
      content: [{ type: "text", text: masked }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 4 },
    }
  if (wire === "responses")
    return {
      id: "resp_1",
      object: "response",
      model: "redaction-model",
      status: "completed",
      output: [
        {
          type: "message",
          id: "message_1",
          role: "assistant",
          content: [{ type: "output_text", text: masked }],
        },
      ],
      output_text: masked,
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    }
  return {
    responseId: "gemini_1",
    modelVersion: "redaction-model",
    candidates: [
      {
        index: 0,
        content: { role: "model", parts: [{ text: masked }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 3,
      candidatesTokenCount: 4,
      totalTokenCount: 7,
    },
  }
}

function events(wire: Wire, masked: string): Array<Record<string, unknown>> {
  const parts = [masked.slice(0, 17), masked.slice(17)]
  if (wire === "chat")
    return [
      ...parts.map((content) => ({
        id: "chat_1",
        object: "chat.completion.chunk",
        model: "redaction-model",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })),
      {
        id: "chat_1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]
  if (wire === "messages")
    return [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "redaction-model",
          content: [],
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      ...parts.map((part) => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: part },
      })),
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]
  if (wire === "responses")
    return [
      {
        type: "response.created",
        response: {
          id: "resp_1",
          model: "redaction-model",
          status: "in_progress",
          output: [],
        },
      },
      ...parts.map((part) => ({
        type: "response.output_text.delta",
        item_id: "message_1",
        output_index: 0,
        content_index: 0,
        delta: part,
      })),
      { type: "response.output_text.done", item_id: "message_1", text: masked },
      { type: "response.completed", response: result(wire, masked) },
    ]
  return [
    ...parts.map((part) => ({
      candidates: [
        { index: 0, content: { role: "model", parts: [{ text: part }] } },
      ],
    })),
    {
      candidates: [
        {
          index: 0,
          content: { role: "model", parts: [] },
          finishReason: "STOP",
        },
      ],
    },
  ]
}

for (const wire of ["chat", "messages", "responses", "gemini"] as const) {
  for (const streaming of [false, true])
    test(`${wire} route masks actual upstream bytes and restores ${streaming ? "SSE" : "JSON"}`, async () => {
      await connection(wire)
      let sent = ""
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        sent = String(init?.body)
        const masked = readText(
          JSON.parse(sent) as Record<string, unknown>,
          wire,
        )
        return new Response(
          streaming ?
            events(wire, masked)
              .map((packet) => `data: ${JSON.stringify(packet)}\n\n`)
              .join("") + (wire === "chat" ? "data: [DONE]\n\n" : "")
          : JSON.stringify(result(wire, masked)),
          {
            headers: {
              "content-type":
                streaming ? "text/event-stream" : "application/json",
            },
          },
        ) as Response
      }) as typeof fetch
      const response = await server.fetch(request(wire, streaming))
      expect(response.status).toBe(200)
      const received = await response.text()
      expect(sent).not.toContain("redaction-user")
      expect(sent).not.toContain("verySecret123")
      expect(sent).toContain("{{HOME_")
      expect(sent).toContain("{{SECRET_")
      expect(received).not.toContain("{{HOME_")
      expect(received).not.toContain("{{SECRET_")
      // SSE repartitions deltas; derive the visible text from the public packets.
      if (!streaming) expect(received).toContain(text)
      else {
        const packets = received
          .split("\n")
          .filter(
            (line) => line.startsWith("data: ") && !line.includes("[DONE]"),
          )
          .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
        const deltas =
          wire === "chat" ?
            packets
              .flatMap(
                (packet) =>
                  (packet.choices ?? []) as Array<{
                    delta?: { content?: string }
                  }>,
              )
              .map((choice) => choice.delta?.content ?? "")
          : wire === "messages" ?
            packets.map(
              (packet) => (packet.delta as { text?: string })?.text ?? "",
            )
          : wire === "responses" ?
            packets
              .filter((packet) => packet.type === "response.output_text.delta")
              .map((packet) => packet.delta as string)
          : packets
              .flatMap(
                (packet) =>
                  (packet.candidates ?? []) as Array<{
                    content: { parts: Array<{ text?: string }> }
                  }>,
              )
              .flatMap((candidate) => candidate.content.parts)
              .map((part) => part.text ?? "")
        expect(deltas.join("")).toBe(text)
      }
    })
}

test("chat to messages translation remains masked through the target adapter", async () => {
  await connection("messages")
  let sent = ""
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent = String(init?.body)
    return Response.json(
      result(
        "messages",
        readText(JSON.parse(sent) as Record<string, unknown>, "messages"),
      ),
    )
  }) as typeof fetch
  const response = await server.fetch(request("chat", false))
  expect(response.status).toBe(200)
  expect(sent).not.toContain("redaction-user")
  expect(sent).not.toContain("verySecret123")
  const received = (await response.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  expect(received.choices[0].message.content).toBe(text)
})

test("signed messages round-trip verifies exact upstream bytes through the actual API", async () => {
  await connection("messages")
  let thinking = ""
  let signature = ""
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{
        role: string
        content: string | Array<{ thinking?: string; signature?: string }>
      }>
    }
    if (!thinking) {
      thinking = String(body.messages[0].content)
      signature = createHmac("sha256", "fixture").update(thinking).digest("hex")
    } else {
      const replay = body.messages.find(
        (message) => message.role === "assistant",
      )!
      const block = (
        replay.content as Array<{ thinking: string; signature: string }>
      )[0]
      expect(block.thinking).toBe(thinking)
      expect(
        createHmac("sha256", "fixture").update(block.thinking).digest("hex"),
      ).toBe(block.signature)
    }
    return Response.json({
      ...result("messages", thinking),
      content: [
        { type: "thinking", thinking, signature },
        { type: "text", text: "ok" },
      ],
    })
  }) as typeof fetch
  const first = await server.fetch(request("messages", false))
  expect(first.status).toBe(200)
  const visible = (await first.json()) as {
    content: Array<{ thinking?: string }>
  }
  expect(visible.content[0].thinking).toBe(text)
  const next = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer redaction-test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "redaction-model",
      max_tokens: 256,
      messages: [
        { role: "user", content: text },
        { role: "assistant", content: visible.content },
        { role: "user", content: "continue" },
      ],
    }),
  })
  const second = await server.fetch(next)
  expect(second.status).toBe(200)
})

test("Claude CLI receives masked stdin and MCP definitions, then returns restored content", async () => {
  const oldScenario = process.env.FAKE_CLAUDE_SCENARIO
  const oldTransport = process.env.COPILOT_API_CLAUDE_TRANSPORT
  process.env.FAKE_CLAUDE_SCENARIO = "redaction-echo"
  delete process.env.COPILOT_API_CLAUDE_TRANSPORT
  const binary = await installFakeClaude()
  setClaudeCliTestHooks({ findBinary: () => binary })
  try {
    let raw = ""
    const received = await runRedactedCall(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        system: "/Users/system-user/config",
        messages: [{ role: "user" as const, content: text }],
        tools: [
          {
            name: "read_file",
            description: "/home/tool-user/files",
            input_schema: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "/home/schema-user/files",
                },
              },
            },
          },
        ],
      },
      undefined,
      async (payload) => {
        const response = await createClaudeMessagesOnce(
          { connection: testConnection(), credential: testCredential() },
          payload,
        )
        raw = JSON.stringify(response)
        return { response, accountId: "conn-claude" }
      },
    )
    for (const value of [
      "redaction-user",
      "verySecret123",
      "system-user",
      "tool-user",
      "schema-user",
    ]) {
      expect(raw).not.toContain(value)
      expect(JSON.stringify(received.response)).toContain(value)
    }
    expect(raw).toContain("{{HOME_")
    expect(raw).toContain("{{SECRET_")
    expect(raw).toContain("read_file")
  } finally {
    runRegistry.clear()
    setClaudeCliTestHooks({})
    if (oldScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO
    else process.env.FAKE_CLAUDE_SCENARIO = oldScenario
    if (oldTransport === undefined)
      delete process.env.COPILOT_API_CLAUDE_TRANSPORT
    else process.env.COPILOT_API_CLAUDE_TRANSPORT = oldTransport
  }
})

test("Claude CLI resumes a pending tool with masked results and restores its reply", async () => {
  const oldScenario = process.env.FAKE_CLAUDE_SCENARIO
  const oldTransport = process.env.COPILOT_API_CLAUDE_TRANSPORT
  const binary = await installFakeClaude()
  setClaudeCliTestHooks({ findBinary: () => binary })
  process.env.FAKE_CLAUDE_SCENARIO = "tool"
  delete process.env.COPILOT_API_CLAUDE_TRANSPORT
  const app = new Hono()
  app.route("/_internal/claude-mcp", claudeMcpRoutes)
  const gateway = Bun.serve({ port: 0, fetch: app.fetch })
  setClaudeCallbackBaseUrl(`http://127.0.0.1:${gateway.port}`)
  try {
    let raw = ""
    const execute = (payload: AnthropicMessagesPayload) =>
      runRedactedCall(payload, undefined, async (prepared) => {
        const response = await createClaudeMessagesOnce(
          { connection: testConnection(), credential: testCredential() },
          prepared,
        )
        raw = JSON.stringify(response)
        return { response, accountId: "conn-claude" }
      })
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [{ role: "user", content: text }],
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    }
    const first = await execute(payload)
    const content = (
      first.response as {
        content: Array<{
          type: "tool_use"
          id: string
          name: string
          input: Record<string, unknown>
        }>
      }
    ).content
    const second = await execute({
      ...payload,
      messages: [
        ...payload.messages,
        { role: "assistant", content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: content[0].id, content: text },
          ],
        },
      ],
    })
    expect(raw).toContain("msg_fake_2")
    expect(raw).not.toContain("redaction-user")
    expect(raw).not.toContain("verySecret123")
    expect(raw).toContain("{{HOME_")
    expect(raw).toContain("{{SECRET_")
    expect(JSON.stringify(second.response)).toContain(text)
  } finally {
    runRegistry.clear()
    gateway.stop(true)
    resetClaudeCallbackBaseUrlForTest()
    setClaudeCliTestHooks({})
    if (oldScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO
    else process.env.FAKE_CLAUDE_SCENARIO = oldScenario
    if (oldTransport === undefined)
      delete process.env.COPILOT_API_CLAUDE_TRANSPORT
    else process.env.COPILOT_API_CLAUDE_TRANSPORT = oldTransport
  }
})
