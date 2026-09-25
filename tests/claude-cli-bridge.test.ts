import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { HTTPError } from "~/lib/error"
import { claudeMcpRoutes } from "~/routes/claude-mcp/route"
import { ClaudeCliUnavailableError } from "~/services/claude/cli/errors"
import { runRegistry } from "~/services/claude/cli/run-registry"
import { setClaudeCallbackBaseUrl } from "~/services/claude/cli/server-address"
import {
  collectClaudeCliMessages,
  streamClaudeCliMessages,
  type ClaudeCliRunContext,
} from "~/services/claude/cli/bridge"
import { setClaudeCliTestHooks } from "~/services/claude/cli/binary"

import {
  drain,
  installFakeClaude,
  testConnection,
  testCredential,
} from "./claude-cli-fixtures"

const TOOL_USE_ID = "toolu_fake_1"

let context: ClaudeCliRunContext
let callbackServer: ReturnType<typeof Bun.serve> | undefined

/**
 * The fake CLI really POSTs its `tools/call` back, so the test mounts the real
 * callback route. That exercises parking, delivery and resume end to end.
 */
function startCallbackGateway(): string {
  const app = new Hono()
  app.route("/_internal/claude-mcp", claudeMcpRoutes)
  callbackServer = Bun.serve({ port: 0, fetch: app.fetch })
  return `http://127.0.0.1:${callbackServer.port}`
}

beforeEach(async () => {
  runRegistry.clear()
  setClaudeCallbackBaseUrl(startCallbackGateway())
  const launcher = await installFakeClaude()
  setClaudeCliTestHooks({
    findBinary: () => launcher,
    probeVersion: () => "9.9.9",
  })
  context = {
    connection: testConnection(),
    credential: testCredential(),
    model: "claude-sonnet-4-6",
    accessToken: "test-token",
  }
})

afterEach(() => {
  runRegistry.clear()
  callbackServer?.stop(true)
  callbackServer = undefined
  setClaudeCliTestHooks({})
  delete process.env.FAKE_CLAUDE_SCENARIO
  delete process.env.FAKE_CLAUDE_TOOL_ID
})

function userPayload(text: string, stream = true) {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    stream,
    messages: [{ role: "user" as const, content: text }],
  }
}

function toolResultPayload(toolUseId: string, text: string, stream = true) {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    stream,
    messages: [
      { role: "user" as const, content: "weather?" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: toolUseId,
            name: "get_weather",
            input: { city: "SF" },
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: toolUseId,
            content: text,
          },
        ],
      },
    ],
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("timed out waiting for condition")
}

function textOf(events: Array<{ type: string }>): string {
  return events
    .map((event) => {
      if (event.type !== "content_block_delta") return ""
      const delta = (event as { delta?: { type?: string; text?: string } })
        .delta
      return delta?.type === "text_delta" ? (delta.text ?? "") : ""
    })
    .join("")
}

// ── happy paths ─────────────────────────────────────────────────────────────

describe("claude cli bridge", () => {
  test("streams a text turn", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "text"
    const events = await drain(
      await streamClaudeCliMessages(context, userPayload("hi")),
    )
    expect(events.map((event) => event.type)).toContain("message_start")
    expect(events.at(-1)?.type).toBe("message_stop")
    expect(textOf(events)).toContain("hello")
  })

  /**
   * Privacy: Claude Code writes full conversation transcripts under its config
   * dir. Pointing `CLAUDE_CONFIG_DIR` at our own data dir keeps them out of the
   * user's real `~/.claude` (and makes them ours to prune — see transcripts.ts).
   */
  test("points the CLI at our own config dir, not the user's ~/.claude", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "text"
    const events = await drain(
      await streamClaudeCliMessages(context, userPayload("hi")),
    )
    expect(textOf(events)).toContain("configDir=set")
  })

  test("returns a complete response for a non-streaming request", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "text"
    const response = await collectClaudeCliMessages(
      context,
      userPayload("hi", false),
    )
    expect(response.role).toBe("assistant")
    expect(response.content[0]).toMatchObject({ type: "text" })
    expect(response.usage.input_tokens).toBe(10)
    expect(response.usage.cache_read_input_tokens).toBe(7)
  })

  test("rewrites the model to the one the caller asked for", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "text"
    const events = await drain(
      await streamClaudeCliMessages(context, userPayload("hi")),
    )
    const start = events.find((event) => event.type === "message_start")
    expect(
      start?.type === "message_start" ? start.message.model : undefined,
    ).toBe("claude-sonnet-4-6")
  })

  test("strips the MCP prefix from the tool name", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "tool"
    process.env.FAKE_CLAUDE_TOOL_ID = TOOL_USE_ID
    const events = await drain(
      await streamClaudeCliMessages(context, userPayload("weather?")),
    )
    const start = events.find(
      (event) =>
        event.type === "content_block_start"
        && event.content_block.type === "tool_use",
    )
    expect(
      start?.type === "content_block_start" ? start.content_block : undefined,
    ).toMatchObject({ type: "tool_use", name: "get_weather", id: TOOL_USE_ID })
  })

  /**
   * The whole point of the bridge: the CLI parks on the tool call, the caller's
   * next request delivers the result, and the *same* run finishes the turn.
   * If the bridge had restarted a process, `findParked` would not have matched
   * and the registry would hold two runs.
   */
  test("resumes the same run when the caller returns the tool result", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "tool"
    process.env.FAKE_CLAUDE_TOOL_ID = TOOL_USE_ID

    const first = await drain(
      await streamClaudeCliMessages(context, userPayload("weather?")),
    )
    expect(first.at(-1)?.type).toBe("message_stop")

    await waitFor(
      () =>
        runRegistry.findParked([TOOL_USE_ID], {
          connectionId: context.connection.id,
          credentialId: context.credential.id,
        }) !== undefined,
    )
    expect(runRegistry.size).toBe(1)

    const second = await drain(
      await streamClaudeCliMessages(
        context,
        toolResultPayload(TOOL_USE_ID, "sunny"),
      ),
    )
    expect(runRegistry.size).toBe(1)
    expect(textOf(second)).toContain("sunny")
  })

  test("collects the resumed turn for a non-streaming caller", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "tool"
    process.env.FAKE_CLAUDE_TOOL_ID = TOOL_USE_ID

    await collectClaudeCliMessages(context, userPayload("weather?", false))
    await waitFor(
      () =>
        runRegistry.findParked([TOOL_USE_ID], {
          connectionId: context.connection.id,
          credentialId: context.credential.id,
        }) !== undefined,
    )
    const response = await collectClaudeCliMessages(
      context,
      toolResultPayload(TOOL_USE_ID, "sunny", false),
    )
    expect(response.content[0]).toMatchObject({ type: "text" })
    expect(JSON.stringify(response.content)).toContain("sunny")
  })

  test("starts a fresh run when the tool result matches nothing parked", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "text"
    const events = await drain(
      await streamClaudeCliMessages(
        context,
        toolResultPayload("toolu_unknown", "stale"),
      ),
    )
    expect(events.at(-1)?.type).toBe("message_stop")
  })
})

// ── lifecycle ───────────────────────────────────────────────────────────────

describe("claude cli run lifecycle", () => {
  test("a finished run leaves the registry", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "text"
    await drain(await streamClaudeCliMessages(context, userPayload("hi")))
    await waitFor(() => runRegistry.size === 0)
    expect(runRegistry.size).toBe(0)
  })

  /**
   * Each run is a whole node process, so a connection must be capped. A parked
   * run still counts: it is holding a process while it waits for the caller.
   */
  test("refuses a new run once the connection is at its cap", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "tool"
    process.env.FAKE_CLAUDE_TOOL_ID = TOOL_USE_ID
    process.env.COPILOT_API_CLAUDE_MAX_RUNS = "1"
    try {
      await drain(await streamClaudeCliMessages(context, userPayload("a")))
      await waitFor(() => runRegistry.size === 1)
      await expect(
        streamClaudeCliMessages(context, userPayload("b")),
      ).rejects.toThrow(/concurrency limit reached/)
    } finally {
      delete process.env.COPILOT_API_CLAUDE_MAX_RUNS
    }
  })

  test("the cap is per connection, not global", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "tool"
    process.env.FAKE_CLAUDE_TOOL_ID = TOOL_USE_ID
    process.env.COPILOT_API_CLAUDE_MAX_RUNS = "1"
    try {
      await drain(await streamClaudeCliMessages(context, userPayload("a")))
      await waitFor(() => runRegistry.size === 1)
      const other = {
        ...context,
        connection: testConnection({ id: "conn-other" }),
      }
      const events = await drain(
        await streamClaudeCliMessages(other, userPayload("b")),
      )
      expect(events.at(-1)?.type).toBe("message_stop")
    } finally {
      delete process.env.COPILOT_API_CLAUDE_MAX_RUNS
    }
    // Two sequential fake-CLI spawns; each costs ~2.4s on Windows, which
    // straddles the default 5s timeout.
  }, 15_000)
})

// ── failure paths ───────────────────────────────────────────────────────────

describe("claude cli bridge failures", () => {
  test("turns a quota error before the first token into a retryable 429", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "error"
    await expect(
      streamClaudeCliMessages(context, userPayload("hi")),
    ).rejects.toThrow(/usage limit reached/)
    try {
      await streamClaudeCliMessages(context, userPayload("hi"))
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      expect((error as HTTPError).response.status).toBe(429)
    }
    // Two sequential fake-CLI spawns; each costs ~2.4s on Windows.
  }, 15_000)

  /**
   * The CLI's stderr is an external process's output: it may carry tokens,
   * paths or user content. It is logged for the operator but must never be
   * forwarded to the API client.
   */
  test("reports a non-zero exit without leaking stderr to the client", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "fail"
    try {
      await streamClaudeCliMessages(context, userPayload("hi"))
      throw new Error("expected a throw")
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain("exited with code 1")
      expect(message).not.toContain("not signed in")
      expect(message).not.toContain("fake claude")
    }
  })

  test("a failed run leaves no registered run behind", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "error"
    await expect(
      streamClaudeCliMessages(context, userPayload("hi")),
    ).rejects.toThrow()
    expect(runRegistry.size).toBe(0)
  })

  test("throws a clear error when no claude binary is installed", async () => {
    setClaudeCliTestHooks({ findBinary: () => undefined })
    await expect(
      streamClaudeCliMessages(context, userPayload("hi")),
    ).rejects.toThrow(ClaudeCliUnavailableError)
  })

  test("the failure names the install command", async () => {
    setClaudeCliTestHooks({ findBinary: () => undefined })
    try {
      await streamClaudeCliMessages(context, userPayload("hi"))
      throw new Error("expected a throw")
    } catch (error) {
      expect((error as Error).message).toContain("claude auth login")
    }
  })
})
