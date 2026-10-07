/**
 * `wait_for_tool` + late tool results.
 *
 * Two behaviours, one seam:
 *
 *  1. A tool result that arrives when no MCP call is waiting for it must be
 *     **kept**, not dropped. Claude Code makes its MCP calls one after another,
 *     so of a reply's two tool calls the second is made only once the first has
 *     its result — while the caller ran both and sends both results back at
 *     once. The old code aborted the whole run when it met a result nobody was
 *     waiting for, taking the process and the result with it.
 *  2. Once a call has been answered "still running" (patience), the result is
 *     collected with the synthetic `wait_for_tool` call instead of by blocking
 *     the MCP call past its client's ~1 minute limit. That tool is OURS: the
 *     caller must never see it, and a turn whose only tool call is ours must
 *     not end the response — the real answer is still coming.
 */

import { afterEach, describe, expect, test } from "bun:test"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AnthropicStreamEventData } from "~/services/protocols/anthropic/types"

import { ClaudeCliRun } from "~/services/claude/cli/bridge"
import { CLAUDE_WAIT_TOOL_NAME } from "~/services/claude/cli/mcp-names"
import { bridgeTools } from "~/services/claude/cli/tools"
import { translateClaudeStreamJson } from "~/services/claude/cli/translate"
import { normalizeClaudeTurns } from "~/services/claude/cli/turns"

import { testConnection, testCredential } from "./claude-cli-fixtures"

const SAVED_PATIENCE = process.env.COPILOT_API_CLAUDE_MCP_PATIENCE_MS

afterEach(() => {
  if (SAVED_PATIENCE === undefined) {
    delete process.env.COPILOT_API_CLAUDE_MCP_PATIENCE_MS
  } else {
    process.env.COPILOT_API_CLAUDE_MCP_PATIENCE_MS = SAVED_PATIENCE
  }
})

/** A run with a stand-in process: only the waiter book-keeping is exercised. */
async function makeRun(patienceMs: number): Promise<{
  run: ClaudeCliRun
  dispose: () => Promise<void>
}> {
  process.env.COPILOT_API_CLAUDE_MCP_PATIENCE_MS = String(patienceMs)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-wait-"))
  const proc = Bun.spawn(
    [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const run = new ClaudeCliRun({
    token: "tok-wait-test",
    payload: { model: "claude-sonnet-5-5", max_tokens: 100, messages: [] },
    context: {
      connection: testConnection(),
      credential: testCredential(),
      model: "claude-sonnet-5-5",
      accessToken: "test-access-token",
    },
    proc,
    tmpDir,
  })
  return {
    run,
    dispose: async () => {
      run.abort()
      await proc.exited
    },
  }
}

const RESULT = (
  text: string,
): { content: Array<{ type: string; text: string }> } => ({
  content: [{ type: "text", text }],
})

function textOf(result: {
  content: Array<{ type: string; text: string }>
}): string {
  return result.content.map((block) => block.text).join("")
}

describe("late tool results", () => {
  test("keeps a result that arrives before its call is made", async () => {
    const { run, dispose } = await makeRun(60_000)
    try {
      // The caller answered both calls at once; this one has not been made yet.
      expect(run.deliver("toolu_second", RESULT("SECOND") as never)).toBe(true)

      // When the CLI finally makes it, the answer is already there — no wait.
      const result = await run.awaitToolCall("toolu_second", "get_secret")
      expect(textOf(result as never)).toBe("SECOND")
    } finally {
      await dispose()
    }
  })

  test("a late result is collected by wait_for_tool, not by blocking", async () => {
    const { run, dispose } = await makeRun(40)
    try {
      const parked = await run.awaitToolCall("toolu_slow", "get_secret")
      const text = textOf(parked as never)
      expect(text).toContain("still running")
      // The model needs the tool's real name to call it back.
      expect(text).toContain(`mcp__copilotapi__${CLAUDE_WAIT_TOOL_NAME}`)
      expect(text).toContain("toolu_slow")

      // The caller finally answers: nobody is on the MCP call any more.
      expect(run.deliver("toolu_slow", RESULT("42-DELTA") as never)).toBe(true)

      const collected = await run.awaitWaitRequest("toolu_slow")
      expect(textOf(collected as never)).toBe("42-DELTA")
    } finally {
      await dispose()
    }
  })

  test("wait_for_tool answers at once for an id it never handed out", async () => {
    const { run, dispose } = await makeRun(60_000)
    try {
      const started = Date.now()
      const result = await run.awaitWaitRequest("toolu_nope")
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(textOf(result as never)).toContain("No tool call")
    } finally {
      await dispose()
    }
  })
})

describe("bridgeTools", () => {
  const payload = {
    model: "claude-sonnet-5-5",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: [
      {
        name: "get_secret",
        description: "look one up",
        input_schema: { type: "object", properties: {} },
      },
    ],
  }

  test("offers wait_for_tool alongside the caller's tools", () => {
    const names = bridgeTools(payload as never).map((tool) => tool.name)
    expect(names).toContain(CLAUDE_WAIT_TOOL_NAME)
    expect(names).toContain("get_secret")
  })

  test("stays out of the way when the caller has no tools", () => {
    const names = bridgeTools({ ...payload, tools: [] } as never).map(
      (tool) => tool.name,
    )
    expect(names).toEqual([])
  })
})

// ── the synthetic call must not leak into the caller's stream ──────────

async function translate(
  lines: Array<unknown>,
): Promise<Array<AnthropicStreamEventData>> {
  const out: Array<AnthropicStreamEventData> = []
  const iterable = (async function* generate() {
    for (const value of lines) yield JSON.stringify(value)
  })()
  for await (const event of translateClaudeStreamJson(
    normalizeClaudeTurns(iterable, { structured: false }),
    {
      model: "claude-sonnet-5-5",
    },
  )) {
    out.push(event)
  }
  return out
}

function turnStart(id: string): unknown {
  return {
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  }
}

/** One assistant message that calls exactly one tool, then stops. */
function ownToolTurn(): Array<unknown> {
  return [
    turnStart("msg_wait"),
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_wait",
          name: `mcp__copilotapi__${CLAUDE_WAIT_TOOL_NAME}`,
        },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"call":"toolu_1"}' },
      },
    },
    {
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    },
    {
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 4 },
      },
    },
    { type: "stream_event", event: { type: "message_stop" } },
  ]
}

function textTurn(id: string, text: string): Array<unknown> {
  return [
    turnStart(id),
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    {
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    },
    {
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
    },
    { type: "stream_event", event: { type: "message_stop" } },
  ]
}

describe("translateClaudeStreamJson and the wait tool", () => {
  test("never shows the caller a tool call the gateway makes itself", async () => {
    const events = await translate(ownToolTurn())
    const toolUse = events.filter(
      (event) =>
        event.type === "content_block_start"
        && event.content_block.type === "tool_use",
    )
    expect(toolUse).toEqual([])
    // Its argument deltas are not forwarded either.
    expect(events.some((event) => event.type === "content_block_delta")).toBe(
      false,
    )
  })

  test("keeps the response open while only its own call is pending", async () => {
    const events = await translate([
      ...ownToolTurn(),
      ...textTurn("msg_2", "done"),
    ])
    // One message_stop only: the continuation's. The own-call turn is not an
    // answer the caller could act on.
    expect(
      events.filter((event) => event.type === "message_stop"),
    ).toHaveLength(1)
    const text = events
      .filter((event) => event.type === "content_block_delta")
      .map((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "text_delta"
        ) ?
          event.delta.text
        : "",
      )
      .join("")
    expect(text).toBe("done")
  })

  test("still surfaces a client tool call normally", async () => {
    const events = await translate([
      turnStart("msg_tool"),
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_client",
            name: "mcp__copilotapi__get_secret",
          },
        },
      },
      {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      },
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 3 },
        },
      },
      { type: "stream_event", event: { type: "message_stop" } },
    ])
    const start = events.find(
      (event) =>
        event.type === "content_block_start"
        && event.content_block.type === "tool_use",
    )
    expect(start).toBeDefined()
    if (
      start?.type === "content_block_start"
      && start.content_block.type === "tool_use"
    ) {
      expect(start.content_block.name).toBe("get_secret")
    }
    expect(
      events.filter((event) => event.type === "message_stop"),
    ).toHaveLength(1)
  })
})
