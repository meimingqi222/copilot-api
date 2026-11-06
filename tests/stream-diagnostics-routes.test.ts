import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import {
  listStreamIncidents,
  readStreamIncident,
} from "~/lib/stream-diagnostics-store"
import { server } from "~/server"

type Wire = "chat" | "messages" | "responses" | "gemini"
type Json = { [key: string]: unknown }
interface Capture {
  text: string
  bytes: number
  truncated: boolean
}
interface Incident {
  requestId: string
  status: string
  reasons: string[]
  requests: Array<{ stage: string; body: Capture }>
  streams: Array<{
    stage: string
    attempt: number
    events: number
    textBytes: number
    reasoningBytes: number
    textHash: string
    reasoningHash: string
    terminal: boolean
    droppedFrames: number
    frames: Array<{ wireData: Capture }>
  }>
}

const protocols = {
  chat: "openai-compatible",
  messages: "anthropic-compatible",
  responses: "openai-responses-compatible",
  gemini: "gemini-compatible",
} as const
// Non-ASCII data catches character-count vs UTF-8 byte-count mistakes. Enough
// repetitions to cross multiple 128-character detector sampling boundaries.
const repeated =
  "这是一段用于诊断流式重复输出的中文短语，保留每个字符并确保原样传输。".repeat(
    24,
  )
const isolationRoot = PATHS.APP_DIR // already redirected by the Bun preload
const originalFetch =
  (globalThis as { __realFetch?: typeof fetch }).__realFetch ?? globalThis.fetch
const originalApiKey = state.legacyApiKey
const originalDump = process.env.DUMP_REQUESTS
const originalDiagnostics = process.env.STREAM_DIAGNOSTICS
let temporaryRoot = ""
const pendingIds = new Set<string>()

function chunks(text: string): string[] {
  return text.match(/[\s\S]{1,7}/g) ?? []
}

function frame(data: Json): string {
  const event = typeof data.type === "string" ? `event: ${data.type}\n` : ""
  return `${event}data: ${JSON.stringify(data)}\n\n`
}

function upstream(wire: Wire, text: string, reasoning = ""): string {
  const events: Json[] = []
  if (wire === "chat") {
    const choice = (delta: Json, finish_reason: string | null = null) => ({
      id: "chat_diag",
      object: "chat.completion.chunk",
      created: 1,
      model: "diagnostic-model",
      choices: [{ index: 0, delta, finish_reason }],
    })
    events.push(choice({ role: "assistant" }))
    for (const delta of chunks(reasoning))
      events.push(choice({ reasoning_content: delta }))
    for (const delta of chunks(text)) events.push(choice({ content: delta }))
    events.push(choice({}, "stop"))
  } else if (wire === "messages") {
    events.push({
      type: "message_start",
      message: {
        id: "msg_diag",
        type: "message",
        role: "assistant",
        model: "diagnostic-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    })
    let index = 0
    for (const [kind, value] of [
      ["thinking", reasoning],
      ["text", text],
    ] as const) {
      if (!value) continue
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: kind, [kind]: "" },
      })
      for (const delta of chunks(value))
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: `${kind}_delta`, [kind]: delta },
        })
      events.push({ type: "content_block_stop", index })
      index++
    }
    events.push(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      },
      { type: "message_stop" },
    )
  } else if (wire === "responses") {
    const response = {
      id: "resp_diag",
      object: "response",
      created_at: 1,
      model: "diagnostic-model",
      status: "in_progress",
      output: [],
    }
    events.push({ type: "response.created", response })
    const output: Json[] = []
    if (reasoning) {
      const item = { id: "rs_diag", type: "reasoning", summary: [] }
      events.push(
        { type: "response.output_item.added", output_index: 0, item },
        {
          type: "response.reasoning_summary_part.added",
          item_id: item.id,
          output_index: 0,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        },
      )
      for (const delta of chunks(reasoning))
        events.push({
          type: "response.reasoning_summary_text.delta",
          item_id: item.id,
          output_index: 0,
          summary_index: 0,
          delta,
        })
      const summary = { type: "summary_text", text: reasoning }
      events.push(
        {
          type: "response.reasoning_summary_text.done",
          item_id: item.id,
          output_index: 0,
          summary_index: 0,
          text: reasoning,
        },
        {
          type: "response.reasoning_summary_part.done",
          item_id: item.id,
          output_index: 0,
          summary_index: 0,
          part: summary,
        },
      )
      output.push({ ...item, summary: [summary] })
      events.push({
        type: "response.output_item.done",
        output_index: 0,
        item: output[0],
      })
    }
    const index = output.length
    const item = {
      id: "msg_diag",
      type: "message",
      role: "assistant",
      content: [],
      status: "in_progress",
    }
    events.push(
      { type: "response.output_item.added", output_index: index, item },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
    )
    for (const delta of chunks(text))
      events.push({
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta,
      })
    const part = { type: "output_text", text, annotations: [] }
    output.push({ ...item, status: "completed", content: [part] })
    events.push(
      {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        text,
      },
      {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part,
      },
      {
        type: "response.output_item.done",
        output_index: index,
        item: output[index],
      },
      {
        type: "response.completed",
        response: {
          ...response,
          status: "completed",
          output,
          usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
        },
      },
    )
  } else {
    for (const [value, thought] of [
      [reasoning, true],
      [text, false],
    ] as const) {
      for (const delta of chunks(value))
        events.push({
          candidates: [
            {
              index: 0,
              content: {
                role: "model",
                parts: [{ text: delta, ...(thought ? { thought } : {}) }],
              },
            },
          ],
        })
    }
    events.push({
      candidates: [{ index: 0, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 7,
        totalTokenCount: 10,
      },
    })
  }
  return (
    events.map(frame).join("") + (wire === "chat" ? "data: [DONE]\n\n" : "")
  )
}

async function connect(wire: Wire): Promise<void> {
  await createConnection({
    id: "diagnostic-connection",
    name: "diagnostics",
    protocol: protocols[wire],
    baseUrl: "https://diagnostics.invalid/v1",
    credentials: [
      {
        id: "diagnostic-credential",
        value: "fixture-secret-token",
        authMode: "bearer",
      },
    ],
    models: [
      {
        publicId: "diagnostic-model",
        upstreamId: "diagnostic-model",
        endpoints: [wire],
        enabled: true,
      },
    ],
  })
}

function stubTransport(sse: string, wire: Wire) {
  const stub = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    expect(url).toStartWith("https://diagnostics.invalid/v1/")
    expect(url).toContain(
      wire === "chat" ? "/chat/completions"
      : wire === "gemini" ? ":streamGenerateContent"
      : `/${wire}`,
    )
    expect(init?.method).toBe("POST")
    // Break transport chunks independently of JSON/SSE boundaries as well.
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(sse)
          for (let offset = 0; offset < bytes.length; offset += 31)
            controller.enqueue(bytes.slice(offset, offset + 31))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  globalThis.fetch = stub as unknown as typeof fetch
  return stub
}

async function request(wire: Wire): Promise<{ id: string; sse: string }> {
  const route =
    wire === "chat" ? "/v1/chat/completions"
    : wire === "gemini" ?
      "/v1beta/models/diagnostic-model:streamGenerateContent"
    : `/v1/${wire}`
  const body =
    wire === "gemini" ?
      { contents: [{ role: "user", parts: [{ text: "say hello" }] }] }
    : {
        model: "diagnostic-model",
        stream: true,
        ...(wire === "responses" ?
          { input: "say hello" }
        : {
            max_tokens: 4096,
            messages: [{ role: "user", content: "say hello" }],
          }),
      }
  const response = await server.fetch(
    new Request(`http://localhost${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    }),
  )
  expect(response.status).toBe(200)
  const id = response.headers.get("x-request-id")
  expect(id).toBeTruthy()
  pendingIds.add(id!)
  return { id: id!, sse: await response.text() }
}

// Client-side extraction is deliberately independent of the recorder's event
// inspector: assertions must catch the inspector overlooking or doubling data.
function delivered(
  wire: Wire,
  sse: string,
): { text: string; reasoning: string } {
  let text = ""
  let reasoning = ""
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue
    const value = JSON.parse(line.slice(6)) as {
      type?: string
      delta?: string | { type: string; text?: string; thinking?: string }
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_content?: string
          reasoning_text?: string
          reasoning?: string
        }
      }>
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> }
      }>
    }
    if (wire === "chat") {
      const delta = value.choices?.[0]?.delta
      text += delta?.content ?? ""
      reasoning +=
        delta?.reasoning_content
        ?? delta?.reasoning_text
        ?? delta?.reasoning
        ?? ""
    } else if (
      wire === "messages"
      && value.type === "content_block_delta"
      && typeof value.delta === "object"
    ) {
      text += value.delta.text ?? ""
      reasoning += value.delta.thinking ?? ""
    } else if (wire === "responses" && typeof value.delta === "string") {
      if (value.type === "response.output_text.delta") text += value.delta
      if (
        value.type === "response.reasoning_summary_text.delta"
        || value.type === "response.reasoning_text.delta"
      )
        reasoning += value.delta
    } else if (wire === "gemini") {
      for (const part of value.candidates?.[0]?.content?.parts ?? []) {
        if (part.thought) reasoning += part.text ?? ""
        else text += part.text ?? ""
      }
    }
  }
  return { text, reasoning }
}

async function finalIncident(id: string): Promise<Incident> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = await readStreamIncident(id)
    if (record && record.status !== "triggered") {
      pendingIds.delete(id)
      return record as unknown as Incident
    }
    await Bun.sleep(10)
  }
  throw new Error(`No finalized stream incident for ${id}`)
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex")

function assertIncident(
  record: Incident,
  id: string,
  text: string,
  reasoning: string,
) {
  expect(record.requestId).toBe(id)
  expect(record.status).toBe("success")
  expect(record.reasons).toContain("repetition:upstream-wire")
  expect(record.reasons).toContain("repetition:upstream-adapter")
  expect(record.reasons).toContain("repetition:downstream")
  expect(record.reasons).not.toContain("output_expansion")
  expect(record.streams.map((stream) => stream.stage).sort()).toEqual([
    "downstream",
    "upstream-adapter",
    "upstream-wire",
  ])
  for (const stream of record.streams) {
    expect(stream.attempt).toBe(stream.stage === "downstream" ? 0 : 1)
    expect(stream.terminal).toBe(true)
    expect(stream.events).toBeGreaterThan(0)
    expect(stream.textBytes).toBe(Buffer.byteLength(text))
    expect(stream.reasoningBytes).toBe(Buffer.byteLength(reasoning))
    expect(stream.textHash).toBe(hash(text))
    expect(stream.reasoningHash).toBe(hash(reasoning))
    expect(stream.frames.length).toBeGreaterThan(0)
    expect(stream.frames.length).toBeLessThanOrEqual(128)
    expect(stream.droppedFrames + stream.frames.length).toBe(stream.events)
    for (const { wireData } of stream.frames) {
      expect(wireData.bytes).toBe(Buffer.byteLength(wireData.text))
      expect(wireData.truncated).toBe(false)
    }
  }
  expect(record.requests.map((request) => request.stage).sort()).toEqual([
    "adapter-input",
    "dispatch-input",
    "transport-input",
  ])
  for (const { body } of record.requests) {
    expect(body.text).toContain("say hello")
    expect(body.bytes).toBe(Buffer.byteLength(body.text))
    expect(body.truncated).toBe(false)
  }
}

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "stream-diagnostic-routes-"),
  )
  redirectPathsToDir(temporaryRoot)
  __resetProviderConnectionsForTest()
  resetProtectedRouteGuardForTest()
  statsStore.clearUsageStatsForTest()
  state.legacyApiKey = undefined
  delete process.env.STREAM_DIAGNOSTICS
  process.env.DUMP_REQUESTS = "0"
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  // Reads serialize behind incident writes; do not redirect while a triggered
  // record is still waiting for its final update (including assertion failures).
  try {
    for (const id of pendingIds) {
      const record = await readStreamIncident(id)
      if (record?.status === "triggered") await finalIncident(id)
    }
    await listStreamIncidents()
  } finally {
    pendingIds.clear()
    __resetProviderConnectionsForTest()
    state.legacyApiKey = originalApiKey
    if (originalDump === undefined) delete process.env.DUMP_REQUESTS
    else process.env.DUMP_REQUESTS = originalDump
    if (originalDiagnostics === undefined) delete process.env.STREAM_DIAGNOSTICS
    else process.env.STREAM_DIAGNOSTICS = originalDiagnostics
    redirectPathsToDir(isolationRoot)
    await fs.rm(temporaryRoot, { recursive: true, force: true })
  }
})

describe("default stream diagnostics through registered compatible adapters", () => {
  for (const wire of ["chat", "messages", "responses", "gemini"] as const) {
    for (const kind of ["text", "thinking"] as const) {
      test(`${wire}: repeated ${kind} is diagnosed without changing delivered deltas`, async () => {
        await connect(wire)
        const text = kind === "text" ? repeated : "Here is the answer."
        const reasoning = kind === "thinking" ? repeated : ""
        const transport = stubTransport(upstream(wire, text, reasoning), wire)
        const { id, sse } = await request(wire)
        expect(delivered(wire, sse)).toEqual({ text, reasoning })
        expect(transport).toHaveBeenCalledTimes(1)
        assertIncident(await finalIncident(id), id, text, reasoning)
        expect(
          (await listStreamIncidents()).map((entry) => entry.requestId),
        ).toEqual([id])
      })
    }
  }

  test("Responses upstream -> Chat: completed snapshots do not double text or canonical reasoning metrics", async () => {
    await connect("responses") // responses-only model forces real cross-wire translation
    stubTransport(upstream("responses", repeated, repeated), "responses")
    const { id, sse } = await request("chat")
    expect(delivered("chat", sse)).toEqual({
      text: repeated,
      reasoning: repeated,
    })
    assertIncident(await finalIncident(id), id, repeated, repeated)
  })

  test.each(["chat", "messages", "responses", "gemini"] as const)(
    "%s: a valid normal stream creates no incident",
    async (wire) => {
      await connect(wire)
      stubTransport(upstream(wire, "Hello, 世界。", "A brief thought."), wire)
      const { id, sse } = await request(wire)
      expect(delivered(wire, sse)).toEqual({
        text: "Hello, 世界。",
        reasoning: "A brief thought.",
      })
      expect(await readStreamIncident(id)).toBeUndefined()
      expect(await listStreamIncidents()).toEqual([])
    },
  )

  test("malformed upstream SSE is recorded without injecting the invalid JSON into client text", async () => {
    await connect("chat")
    stubTransport(
      `data: {not valid JSON}\n\n${upstream("chat", "Still delivered.")}`,
      "chat",
    )
    const { id, sse } = await request("chat")
    expect(delivered("chat", sse)).toEqual({
      text: "",
      reasoning: "",
    })
    const record = await finalIncident(id)
    expect(record.reasons).toContain("malformed_json")
    expect(record.status).toBe("failed")
    expect(record.reasons).toContain("stream_failed")
    expect(
      record.streams
        .find((stream) => stream.stage === "upstream-wire")
        ?.frames.some(({ wireData }) => wireData.text === "{not valid JSON}"),
    ).toBe(true)
  })
})
