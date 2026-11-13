import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { claudeMcpRoutes } from "~/routes/claude-mcp/route"
import {
  collectClaudeCliMessages,
  streamClaudeCliMessages,
  type ClaudeCliRunContext,
} from "~/services/claude/cli/bridge"
import { setClaudeCliTestHooks } from "~/services/claude/cli/binary"
import { claudeCliArgs } from "~/services/claude/cli/args"
import { selectClaudeCliMode } from "~/services/claude/cli/mode"
import { ClaudeCliUnavailableError } from "~/services/claude/cli/errors"
import {
  interactiveClaudeArgs,
  pasteClaudeText,
} from "~/services/claude/cli/tui-args"
import { runRegistry } from "~/services/claude/cli/run-registry"
import {
  resetClaudeCallbackBaseUrlForTest,
  setClaudeCallbackBaseUrl,
} from "~/services/claude/cli/server-address"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/services/protocols/anthropic/types"
import { testConnection, testCredential } from "./claude-cli-fixtures"
import { loopbackTest } from "./helpers/loopback-test"
import { ClaudeTuiEvents } from "~/services/claude/cli/tui-events"
import {
  collectAnthropicResponse,
  translateClaudeStreamJson,
} from "~/services/claude/cli/translate"
import { normalizeClaudeTurns } from "~/services/claude/cli/turns"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import {
  __resetProviderConnectionsForTest,
  getProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"

let context: ClaudeCliRunContext
let launcherDir: string
let server: ReturnType<typeof Bun.serve> | undefined
const originalEntry = process.argv[1]
beforeEach(async () => {
  process.argv[1] = path.resolve(
    process.env.COPILOT_API_TEST_CLAUDE_ENTRY ?? "src/main.ts",
  )
  runRegistry.clear()
  launcherDir = await fs.mkdtemp(path.join(os.tmpdir(), "fake claude tui "))
  const fixture = path.join(import.meta.dir, "fixtures/claude-cli/tui.ts")
  const launcher = path.join(
    launcherDir,
    process.platform === "win32" ? "claude.cmd" : "claude",
  )
  await fs.writeFile(
    launcher,
    process.platform === "win32" ?
      `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
  )
  if (process.platform !== "win32") await fs.chmod(launcher, 0o755)
  setClaudeCliTestHooks({ findBinary: () => launcher })
  setClaudeCallbackBaseUrl("http://127.0.0.1:1")
  context = {
    connection: testConnection({
      id: `tui-${Date.now()}`,
      metadata: { claudeCliMode: "interactive" },
    }),
    credential: testCredential(),
    model: "claude-sonnet-4-6",
    accessToken: "test-token",
  }
})
afterEach(async () => {
  process.argv[1] = originalEntry
  runRegistry.clear()
  server?.stop(true)
  server = undefined
  resetClaudeCallbackBaseUrlForTest()
  setClaudeCliTestHooks({})
  delete process.env.FAKE_TUI_SCENARIO
  delete process.env.FAKE_TUI_PID_FILE
  await fs.rm(launcherDir, { recursive: true, force: true })
})
function payload(): AnthropicMessagesPayload {
  return {
    model: context.model,
    max_tokens: 100,
    messages: [{ role: "user", content: "hi 中文" }],
  }
}
function text(response: AnthropicResponse): string {
  return response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
}
function next(
  first: AnthropicMessagesPayload,
  response: AnthropicResponse,
): AnthropicMessagesPayload {
  return {
    ...first,
    messages: [
      ...first.messages,
      {
        role: "assistant",
        content: response.content as Extract<
          AnthropicMessagesPayload["messages"][number],
          { role: "assistant" }
        >["content"],
      },
      { role: "user", content: "second turn" },
    ],
  }
}

test("mode selection preserves -p defaults and SDK-only contracts", () => {
  const request = payload()
  expect(selectClaudeCliMode(testConnection(), request).mode).toBe("print")
  expect(selectClaudeCliMode(context.connection, request).mode).toBe(
    "interactive",
  )
  for (const change of [
    {
      output_config: {
        format: { type: "json_schema" as const, schema: { type: "object" } },
      },
    },
    { tools: [{ type: "web_search_20250305", name: "web_search" }] },
    { messages: [{ role: "user" as const, content: "a".repeat(410 * 1024) }] },
  ])
    expect(() =>
      selectClaudeCliMode(context.connection, { ...request, ...change }),
    ).toThrow("Interactive mode")
  const args = interactiveClaudeArgs(
    claudeCliArgs({ model: "m", mcpConfigPath: "mcp.json", effort: "xhigh" }),
    "sid",
  )
  expect(args).not.toContain("-p")
  expect(args).not.toContain("--no-session-persistence")
  expect(args).not.toContain("--dangerously-skip-permissions")
  expect(args).toContain("xhigh")
  expect(args).toContain("mcp__copilotapi")
  expect(pasteClaudeText("/clear\x1b[201~\x03")).toBe(
    "\x1b[200~\n/clear[201~\x1b[201~",
  )
})

test.each(["tap", "transcript", "trust", "chrome"])(
  "real PTY %s output keeps text, usage and a persistent second turn",
  async (scenario) => {
    process.env.FAKE_TUI_SCENARIO = scenario
    const first = payload()
    const reply = await collectClaudeCliMessages(context, first)
    const detail = JSON.parse(text(reply)) as {
      pid: number
      turn: number
      args: Array<string>
      input: string
      entrypoint: unknown
      tap: unknown
    }
    expect(detail.args).not.toContain("-p")
    expect(detail.input).toContain("hi 中文")
    expect(detail.entrypoint).toBeNull()
    expect(detail.tap).toBeNull()
    expect(reply.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 7,
    })
    const second = JSON.parse(
      text(await collectClaudeCliMessages(context, next(first, reply))),
    ) as { pid: number; turn: number }
    expect(second).toMatchObject({ pid: detail.pid, turn: 2 })
  },
  30_000,
)

test("the first interactive prompt waits for the MCP tool list", async () => {
  process.env.FAKE_TUI_SCENARIO = "slow-mcp"
  const request = {
    ...payload(),
    tools: [{ name: "echo", input_schema: { type: "object" } }],
  }
  const reply = await collectClaudeCliMessages(context, request)
  expect(JSON.parse(text(reply))).toMatchObject({ toolsListed: true })
})

test.each([false, true])(
  "a successful interactive response updates the credential allowance (stream=%s)",
  async (stream) => {
    __resetProviderConnectionsForTest()
    context.connection.credentials = [context.credential]
    upsertProviderConnection(context.connection)
    try {
      const request = { ...payload(), stream }
      const reply =
        stream ?
          await collectAnthropicResponse(
            await streamClaudeCliMessages(context, request),
            context.model,
          )
        : await collectClaudeCliMessages(context, request)
      expect(JSON.parse(text(reply)).turn).toBe(1)
      expect(
        getProviderConnection(context.connection.id)?.credentials[0].quota
          ?.allowance?.windows,
      ).toContainEqual(
        expect.objectContaining({
          id: "five_hour",
          used: 0.42,
          resetsAtMs: 1800000000000,
        }),
      )
    } finally {
      __resetProviderConnectionsForTest()
    }
  },
)

test.each([false, true])(
  "a silent interactive turn fails with 502 (stream=%s)",
  async (stream) => {
    process.env.FAKE_TUI_SCENARIO = "silent"
    const request = { ...payload(), stream }
    await expect(
      stream ?
        streamClaudeCliMessages(context, request)
      : collectClaudeCliMessages(context, request),
    ).rejects.toMatchObject({ response: { status: 502 } })
    expect(runRegistry.size).toBe(0)
  },
)

test.each([
  ["effort", "medium"],
  ["tap", "medium"],
  ["effort", "default"],
])(
  "interactive effort changes with %s from %s keep the selected mode",
  async (scenario, initial) => {
    process.env.FAKE_TUI_SCENARIO = scenario
    let request: AnthropicMessagesPayload = {
      ...payload(),
      ...(initial === "medium" ?
        { output_config: { effort: "medium" as const } }
      : {}),
    }
    let reply = await collectClaudeCliMessages(context, request)
    const first = JSON.parse(text(reply)) as { pid: number }
    for (const effort of ["high", "medium"] as const) {
      request = { ...next(request, reply), output_config: { effort } }
      reply = await collectClaudeCliMessages(context, request)
      const detail = JSON.parse(text(reply)) as {
        pid: number
        effort: string
        args: Array<string>
      }
      expect(detail.effort).toBe(effort)
      expect(detail.pid === first.pid).toBe(scenario === "effort")
      expect(detail.args).not.toContain("-p")
    }
    const reset = next(request, reply)
    delete reset.output_config
    const detail = JSON.parse(
      text(await collectClaudeCliMessages(context, reset)),
    ) as { pid: number; effort: string; args: Array<string> }
    expect(detail.pid === first.pid).toBe(
      scenario === "effort" && initial === "default",
    )
    expect(detail.effort).toBe("")
    expect(detail.args).not.toContain("-p")
  },
  30_000,
)

test.each(["images", "images-partial"])(
  "interactive %s are pasted as files in order and removed after acceptance",
  async (scenario) => {
    process.env.FAKE_TUI_SCENARIO = scenario
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
    const first = payload()
    const count = scenario === "images-partial" ? 19 : 2
    const content: Extract<
      AnthropicMessagesPayload["messages"][number],
      { role: "user" }
    >["content"] = []
    for (let i = 0; i < count; i++)
      content.push(
        { type: "text", text: `words-${i}` },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data },
        },
      )
    content.push({ type: "text", text: "after" })
    const expected =
      Array.from(
        { length: count },
        (_, i) => `words-${i}[Image #${i + 1}]`,
      ).join("") + "after"
    first.messages = [
      {
        role: "user",
        content,
      },
    ]
    const reply = await collectClaudeCliMessages(context, first)
    const detail = JSON.parse(text(reply)) as {
      pid: number
      input: string
      images: Array<{ file: string; bytes: string }>
    }
    expect(detail.input).toContain(expected)
    expect(detail.images.map((image) => image.bytes)).toEqual(
      Array(count).fill(data),
    )
    const cleanedBy = Date.now() + 2000
    while (
      (await Bun.file(detail.images[0].file).exists())
      && Date.now() < cleanedBy
    )
      await Bun.sleep(20)
    expect(await Bun.file(detail.images[0].file).exists()).toBe(false)
    const follow = next(first, reply)
    follow.messages[follow.messages.length - 1] = first.messages[0]
    const second = JSON.parse(
      text(await collectClaudeCliMessages(context, follow)),
    ) as typeof detail
    expect(second.pid).toBe(detail.pid)
    expect(second.images.map((image) => image.bytes)).toEqual(
      Array(count).fill(data),
    )
    expect(second.input).toContain(expected)
  },
  30_000,
)

test("a synthetic refusal waits for Claude Code's fallback instead of failing the stream", async () => {
  const values: Array<unknown> = []
  const events = new ClaudeTuiEvents((row) => values.push(row))
  events.transcript({ type: "user", message: { content: "hi" } })
  events.transcript({
    type: "assistant",
    message: {
      id: "refused",
      model: "real",
      content: [{ type: "text", text: "partial" }],
      stop_reason: "refusal",
    },
  })
  events.transcript({
    type: "assistant",
    isApiErrorMessage: true,
    message: {
      model: "<synthetic>",
      content: [{ type: "text", text: "safeguards refused" }],
      stop_reason: "refusal",
    },
  })
  events.transcript({
    type: "assistant",
    message: {
      id: "fallback",
      model: "real",
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
    },
  })
  events.transcript({ type: "system", subtype: "turn_duration" })
  events.tick()
  const reply = await collectAnthropicResponse(
    translateClaudeStreamJson(
      normalizeClaudeTurns(
        (async function* () {
          for (const value of values) yield JSON.stringify(value)
        })(),
        { structured: false },
      ),
      { model: "test" },
    ),
    "test",
  )
  expect(reply.stop_reason).toBe("end_turn")
  expect(text(reply)).toBe("partialanswer")
})

test("interactive safeguards reach the child and changed safety context starts a fresh run", async () => {
  const first = {
    ...payload(),
    safeguards: [
      {
        dangerous_tool_use: {
          classifier_context: { purpose: "fictional-test" },
        },
      },
    ],
  }
  const reply = await collectClaudeCliMessages(context, first)
  const detail = JSON.parse(text(reply)) as { pid: number; extraBody: unknown }
  expect(detail.extraBody).toEqual({ safeguards: first.safeguards })
  const follow = { ...next(first, reply), safeguards: [] }
  const second = JSON.parse(
    text(await collectClaudeCliMessages(context, follow)),
  ) as { pid: number; extraBody: unknown }
  expect(second.pid).not.toBe(detail.pid)
  expect(second.extraBody).toEqual({ safeguards: [] })
}, 30_000)

test("transcript fallback preserves separate signed thinking rows and suppresses late tapped duplicates", async () => {
  const lines: Array<string> = []
  const events = new ClaudeTuiEvents((value) =>
    lines.push(JSON.stringify(value)),
  )
  events.transcript({ type: "user", message: { content: "hi" } })
  const message = {
    id: "msg-blocks",
    model: "fake",
    usage: { input_tokens: 12, output_tokens: 5 },
    stop_reason: "end_turn",
  }
  const thinking = {
    type: "thinking" as const,
    thinking: "same text",
    signature: "valid-signature",
  }
  events.transcript({
    type: "assistant",
    message: { ...message, content: [thinking] },
  })
  await Bun.sleep(170)
  events.tick()
  events.transcript({
    type: "assistant",
    message: { ...message, content: [thinking] },
  })
  events.transcript({
    type: "assistant",
    message: { ...message, content: [{ type: "text", text: '{"turn":1}' }] },
  })
  events.tap({ s: 1, open: true })
  events.tap({ s: 1, e: { type: "message_start", message } })
  events.tap({
    s: 1,
    e: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "duplicate" },
    },
  })
  events.tap({ s: 1, end: "done" })
  events.transcript({ type: "system", subtype: "turn_duration" })
  events.tick()
  const result = await collectAnthropicResponse(
    translateClaudeStreamJson(
      normalizeClaudeTurns(
        (async function* () {
          yield* lines
        })(),
        { structured: false },
      ),
      { model: "fake" },
    ),
    "fake",
  )
  expect(result.content).toEqual([
    thinking,
    thinking,
    { type: "text", text: '{"turn":1}' },
  ])
  expect(result.usage).toMatchObject({ input_tokens: 12, output_tokens: 5 })

  // The transcript can settle before a poll sees the same reply in the tap.
  const secondStart = lines.length
  events.tap({
    s: 2,
    open: true,
    h: {
      "anthropic-ratelimit-unified-5h-utilization": "0.6",
      "anthropic-ratelimit-unified-5h-reset": "1800000000",
    },
  })
  events.tap({ s: 2, e: { type: "message_start", message } })
  events.tap({
    s: 2,
    e: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  })
  events.tap({
    s: 2,
    e: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: '{"turn":1}' },
    },
  })
  events.tap({ s: 2, e: { type: "content_block_stop", index: 0 } })
  events.tap({ s: 2, e: { type: "message_stop" } })
  events.tap({ s: 2, end: "done" })
  expect(lines.slice(secondStart).map((line) => JSON.parse(line))).toEqual([
    {
      type: "rate_limit_event",
      rate_limit_info: {
        unifiedWindows: {
          five_hour: { utilization: 0.6, resetsAt: 1800000000 },
        },
      },
    },
  ])
  events.transcript({ type: "user", message: { content: "second turn" } })
  events.transcript({
    type: "assistant",
    message: {
      ...message,
      id: "msg-second",
      content: [{ type: "text", text: '{"turn":2}' }],
    },
  })
  events.transcript({ type: "system", subtype: "turn_duration" })
  events.tick()
  const second = await collectAnthropicResponse(
    translateClaudeStreamJson(
      normalizeClaudeTurns(
        (async function* () {
          yield* lines.slice(secondStart)
        })(),
        { structured: false },
      ),
      { model: "fake" },
    ),
    "fake",
  )
  expect(text(second)).toBe('{"turn":2}')
})

test.each(["before", "after", "error"])(
  "interactive reply limits keep the newest observation when old streams end %s",
  (order) => {
    const output: Array<Record<string, unknown>> = []
    const events = new ClaudeTuiEvents((value) =>
      output.push(value as Record<string, unknown>),
    )
    const open = (s: number, used: string) =>
      events.tap({
        s,
        open: true,
        h: {
          "anthropic-ratelimit-unified-5h-utilization": used,
          "anthropic-ratelimit-unified-5h-reset": "1800000000.6",
          "anthropic-ratelimit-unified-7d-utilization": "NaN",
          "anthropic-ratelimit-unified-7d-reset": "1800000000",
        },
      })
    events.transcript({ type: "user" })
    open(1, "0.3")
    if (order === "before") events.tap({ s: 1, end: "done" })
    open(2, "0.42")
    // An open header alone must not interrupt a message in progress.
    expect(output).toEqual([])
    events.tap({
      s: 2,
      e: {
        type: "message_start",
        message: { id: "new", content: [] },
      },
    })
    expect(output[0]).toMatchObject({
      type: "rate_limit_event",
      rate_limit_info: {
        unifiedWindows: {
          five_hour: { utilization: 0.42, resetsAt: 1800000001 },
        },
      },
    })
    expect(output[1]).toMatchObject({
      type: "stream_event",
      event: { type: "message_start" },
    })
    if (order !== "before") events.tap({ s: 1, end: "done" })
    events.tap({ s: 2, end: "done" })
    if (order === "error") {
      open(3, "0.5")
      events.tap({ s: 3, end: "done" })
      events.transcript({
        type: "assistant",
        isApiErrorMessage: true,
        message: { model: "<synthetic>", content: [] },
        apiErrorParams: {
          rate_limit_info: {
            unifiedWindows: {
              five_hour: { utilization: 1, resetsAt: 1800000200 },
            },
          },
        },
      })
    }
    events.transcript({ type: "system", subtype: "turn_duration" })
    events.tick()
    const readings = output.filter((row) => row.type === "rate_limit_event")
    expect(readings.map((row) => row.rate_limit_info)).toEqual(
      (order === "error" ? [0.42, 0.5, 1] : [0.42]).map((used) => ({
        unifiedWindows: {
          five_hour: {
            utilization: used,
            resetsAt: used === 1 ? 1800000200 : 1800000001,
          },
        },
      })),
    )
  },
)

test("transcript replies defer tapped limits until the complete message ends", () => {
  const output: Array<Record<string, unknown>> = []
  const events = new ClaudeTuiEvents((value) =>
    output.push(value as Record<string, unknown>),
  )
  events.transcript({ type: "user" })
  events.transcript({
    type: "assistant",
    message: {
      id: "whole",
      content: [{ type: "text", text: "complete answer" }],
    },
  })
  events.tap({
    s: 1,
    open: true,
    h: {
      "anthropic-ratelimit-unified-5h-utilization": "0.6",
      "anthropic-ratelimit-unified-5h-reset": "1800000000",
    },
  })
  events.tap({ s: 1, end: "done" })
  expect(output).toEqual([])
  events.transcript({ type: "system", subtype: "turn_duration" })
  events.tick()
  const types = output.map((row) =>
    row.type === "stream_event" ?
      (row.event as { type: string }).type
    : row.type,
  )
  expect(types.indexOf("rate_limit_event")).toBeGreaterThan(
    types.indexOf("message_stop"),
  )
  expect(output.find((row) => row.type === "rate_limit_event")).toMatchObject({
    rate_limit_info: {
      unifiedWindows: {
        five_hour: { utilization: 0.6, resetsAt: 1800000000 },
      },
    },
  })
})

test("tap tees only main SSE and leaves the actual request and response bytes intact", async () => {
  const rows: Array<Record<string, unknown>> = []
  const calls: Array<unknown> = []
  const frames =
    'event: message_start\r\ndata: {"type":"message_start","message":{"id":"m"}}\r\n\r\nevent: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"中文"}}\r\n\r\n'
  class FetchSession {
    async fetch(
      input: string | Request,
      init?: RequestInit,
    ): Promise<Response> {
      calls.push({ input, init })
      const bytes = new TextEncoder().encode(frames)
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 7)
              controller.enqueue(bytes.slice(offset, offset + 7))
            controller.close()
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "anthropic-ratelimit-unified-5h-utilization": "0.42",
            "anthropic-ratelimit-unified-5h-reset": "1800000000.6",
            "x-private-header": "not-for-the-tap",
          },
        },
      )
    }
  }
  const env: Record<string, string> = {
    COPILOT_API_CLAUDE_TAP: "tap.jsonl",
    COPILOT_API_CLAUDE_PRELOAD: ".copilot-tui-test.js",
    COPILOT_API_CLAUDE_EFFORT: "effort.json",
    BUN_OPTIONS: "--smol --preload ./.copilot-tui-test.js",
  }
  let effort = "{}"
  const sandbox = {
    fs: {
      openSync: () => 1,
      readFileSync: () => effort,
      writeFileSync: () => {},
      writeSync: (_fd: number, text: string) =>
        rows.push(JSON.parse(text) as Record<string, unknown>),
    },
    process: { env, execArgv: ["--preload", "./.copilot-tui-test.js"] },
    Bun: { FetchSession },
    Headers,
    Request,
    TextDecoder,
  }
  const source = readFileSync(
    "src/services/claude/cli/tui-tap.js",
    "utf8",
  ).replace('import fs from "node:fs"', "")
  runInNewContext(source, sandbox)
  const session = new sandbox.Bun.FetchSession()
  const init = { headers: { "x-claude-code-request-class": "main" } }
  const response = await session.fetch("https://example.com/v1/messages", init)
  expect(await new Response(response.body).text()).toBe(frames)
  for (let n = 0; n < 50 && !rows.some((row) => row.end); n++)
    await Bun.sleep(1)
  expect(calls[0]).toEqual({ input: "https://example.com/v1/messages", init })
  expect(rows.find((row) => row.open)?.h).toEqual({
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-5h-reset": "1800000000.6",
  })
  expect(
    rows.filter((row) => row.e).map((row) => (row.e as { type: string }).type),
  ).toEqual(["message_start", "content_block_delta"])
  expect(rows.at(-1)).toMatchObject({ end: "done" })
  expect(env.BUN_OPTIONS).toBe("--smol")
  expect(env.COPILOT_API_CLAUDE_TAP).toBeUndefined()
  expect(sandbox.process.execArgv).toEqual([])
  const before = rows.length
  const background = await session.fetch("https://example.com/v1/messages", {
    headers: { "x-claude-code-request-class": "background" },
  })
  expect(await new Response(background.body).text()).toBe(frames)
  expect(rows).toHaveLength(before)
  effort = JSON.stringify({ effort: "xhigh" })
  const body = JSON.stringify({
    output_config: { effort: "medium", format: { type: "json_schema" } },
    safeguards: ["keep"],
  })
  const original = { ...init, body }
  const changed = await session.fetch(
    "https://example.com/v1/messages",
    original,
  )
  await new Response(changed.body).text()
  const sent = calls.at(-1) as { init: RequestInit }
  expect(JSON.parse(sent.init.body as string)).toEqual({
    output_config: { effort: "xhigh", format: { type: "json_schema" } },
    safeguards: ["keep"],
  })
  expect(original.body).toBe(body)
  expect(env.COPILOT_API_CLAUDE_EFFORT).toBeUndefined()
  const backgroundInit = {
    ...original,
    headers: { "x-claude-code-request-class": "background" },
  }
  await new Response(
    (
      await session.fetch("https://example.com/v1/messages", backgroundInit)
    ).body,
  ).text()
  expect(calls.at(-1)).toEqual({
    input: "https://example.com/v1/messages",
    init: backgroundInit,
  })
  const request = new Request("https://example.com/v1/messages", {
    ...original,
    method: "POST",
  })
  await new Response((await session.fetch(request)).body).text()
  expect(
    JSON.parse((calls.at(-1) as { init: RequestInit }).init.body as string)
      .output_config.effort,
  ).toBe("xhigh")
  expect(await request.text()).toBe(body)
  effort = "{}"
  await new Response(
    (await session.fetch("https://example.com/v1/messages", original)).body,
  ).text()
  expect(calls.at(-1)).toEqual({
    input: "https://example.com/v1/messages",
    init: original,
  })
})

loopbackTest(
  "interactive tool calls park and resume through the existing MCP callback",
  async () => {
    process.env.FAKE_TUI_SCENARIO = "tool"
    const app = new Hono().route("/_internal/claude-mcp", claudeMcpRoutes)
    server = Bun.serve({ port: 0, fetch: app.fetch })
    setClaudeCallbackBaseUrl(`http://127.0.0.1:${server.port}`)
    const first = {
      ...payload(),
      tools: [
        {
          name: "echo",
          description: "echo",
          input_schema: {
            type: "object",
            properties: { word: { type: "string" } },
          },
        },
      ],
    } satisfies AnthropicMessagesPayload
    const reply = await collectClaudeCliMessages(context, first)
    expect(reply.stop_reason).toBe("tool_use")
    expect(reply.content[0]).toMatchObject({
      type: "tool_use",
      name: "echo",
      input: { word: "hello" },
    })
    const follow = next(first, reply)
    follow.messages[follow.messages.length - 1] = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_tui",
          content: "tool result delivered",
        },
      ],
    }
    const result = await collectClaudeCliMessages(context, follow)
    expect(text(result)).toContain("tool result delivered")
  },
  30_000,
)

test("interactive startup failure never launches a print request", async () => {
  process.env.FAKE_TUI_SCENARIO = "startup-fail"
  await expect(
    collectClaudeCliMessages(context, payload()),
  ).rejects.toBeInstanceOf(ClaudeCliUnavailableError)
}, 30_000)

test.each(["bypass", "startup-fail", "undrawn"])(
  "interactive startup diagnostics explain %s without exposing process arguments",
  async (scenario) => {
    if (scenario === "undrawn" && process.platform === "win32") return
    const waitCommand = path.join(launcherDir, "security")
    if (scenario === "undrawn") {
      await fs.writeFile(
        waitCommand,
        "#!/bin/sh\nsleep 60 &\ntrap 'kill $!' TERM HUP EXIT\nwait\n",
      )
      await fs.chmod(waitCommand, 0o755)
    }
    const config = path.join(launcherDir, "tui.json")
    await fs.writeFile(
      config,
      JSON.stringify({
        command: [
          process.execPath,
          path.resolve("tests/fixtures/claude-cli/tui.ts"),
        ],
        args: ["--mcp-config", path.join(launcherDir, "mcp.json")],
        cwd: launcherDir,
        configDir: launcherDir,
        tmpDir: launcherDir,
      }),
    )
    const child = Bun.spawn(
      [process.execPath, process.argv[1], "claude-tui-helper", config],
      {
        env: {
          ...process.env,
          FAKE_TUI_SCENARIO: scenario,
          FAKE_TUI_WAIT_COMMAND: waitCommand,
          CLAUDE_CONFIG_DIR: launcherDir,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code).toBe(1)
      expect(stdout).toContain("copilot_tui_unavailable")
      expect(stdout).not.toContain('"subtype":"init"')
      expect(stdout).not.toContain("UNSAFE_ACCEPTED")
      if (scenario === "bypass") expect(stderr).toContain("Bypass Permissions")
      if (scenario === "startup-fail")
        expect(stderr).toContain("startup explanation from Claude Code")
      if (scenario === "undrawn") {
        expect(stderr).toContain("0 bytes read")
        expect(stderr).toContain(
          process.platform === "darwin" ? "macOS Keychain" : "security",
        )
        expect(stderr).not.toContain("private-diagnostic-argument")
      }
    } finally {
      child.kill()
      child.stdin.end()
      await child.exited
    }
  },
  60_000,
)

test("changing the account mode cannot reuse the previous interactive process", async () => {
  const first = payload()
  const reply = await collectClaudeCliMessages(context, first)
  context.connection.metadata!.claudeCliMode = "print"
  // The interactive-only fixture refuses -p: success would mean a stale run was reused.
  await expect(
    collectClaudeCliMessages(context, next(first, reply)),
  ).rejects.toThrow()
}, 30_000)

test("cancellation ends the real PTY child and releases its run", async () => {
  const pidFile = path.join(launcherDir, "pid")
  process.env.FAKE_TUI_SCENARIO = "hang"
  process.env.FAKE_TUI_PID_FILE = pidFile
  const controller = new AbortController()
  const pending = collectClaudeCliMessages(
    { ...context, signal: controller.signal },
    payload(),
  )
  // Attach the rejection handler before aborting so it is never unhandled.
  const rejection = pending.catch((error: unknown) => error)
  const readyBy = Date.now() + 15_000
  while (!(await Bun.file(pidFile).exists()) && Date.now() < readyBy)
    await Bun.sleep(20)
  expect(await Bun.file(pidFile).exists()).toBe(true)
  const pid = Number(await Bun.file(pidFile).text())
  controller.abort(new Error("cancel tui test"))
  expect(await rejection).toBeInstanceOf(Error)
  const deadBy = Date.now() + 8000
  let live = true
  while (live && Date.now() < deadBy) {
    try {
      process.kill(pid, 0)
      await Bun.sleep(30)
    } catch {
      live = false
    }
  }
  expect(live).toBe(false)
}, 30_000)
