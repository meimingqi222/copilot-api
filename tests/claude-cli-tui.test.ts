import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { claudeMcpRoutes } from "~/routes/claude-mcp/route"
import {
  collectClaudeCliMessages,
  type ClaudeCliRunContext,
} from "~/services/claude/cli/bridge"
import { setClaudeCliTestHooks } from "~/services/claude/cli/binary"
import { claudeCliArgs } from "~/services/claude/cli/args"
import { selectClaudeCliMode } from "~/services/claude/cli/mode"
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
    {
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "image" as const,
              source: {
                type: "url" as const,
                url: "https://example.com/a.png",
              },
            },
          ],
        },
      ],
    },
    { messages: [{ role: "user" as const, content: "a".repeat(410 * 1024) }] },
  ])
    expect(
      selectClaudeCliMode(context.connection, { ...request, ...change }).mode,
    ).toBe("print")
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

test.each(["tap", "transcript", "trust"])(
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
    message: { ...message, content: [{ type: "text", text: "answer" }] },
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
    { type: "text", text: "answer" },
  ])
  expect(result.usage).toMatchObject({ input_tokens: 12, output_tokens: 5 })
})

test("tap tees only main SSE and leaves the actual request and response bytes intact", async () => {
  const rows: Array<Record<string, unknown>> = []
  const calls: Array<unknown> = []
  const frames =
    'event: message_start\r\ndata: {"type":"message_start","message":{"id":"m"}}\r\n\r\nevent: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"中文"}}\r\n\r\n'
  class FetchSession {
    async fetch(input: string, init?: RequestInit): Promise<Response> {
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
        { headers: { "content-type": "text/event-stream" } },
      )
    }
  }
  const env: Record<string, string> = {
    COPILOT_API_CLAUDE_TAP: "tap.jsonl",
    COPILOT_API_CLAUDE_PRELOAD: ".copilot-tui-test.js",
    BUN_OPTIONS: "--smol --preload ./.copilot-tui-test.js",
  }
  const sandbox = {
    fs: {
      openSync: () => 1,
      writeSync: (_fd: number, text: string) =>
        rows.push(JSON.parse(text) as Record<string, unknown>),
    },
    process: { env, execArgv: ["--preload", "./.copilot-tui-test.js"] },
    Bun: { FetchSession },
    Headers,
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

test("interactive startup failure safely falls back before sending the prompt", async () => {
  process.env.FAKE_TUI_SCENARIO = "startup-fail"
  const result = await collectClaudeCliMessages(context, payload())
  expect(text(result)).toContain("hello")
}, 30_000)

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
