import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"
import { claudeMcpRoutes } from "~/routes/claude-mcp/route"
import { setClaudeCliTestHooks } from "~/services/claude/cli/binary"
import {
  streamClaudeCliMessages,
  ClaudeCliRun,
  type ClaudeCliRunContext,
} from "~/services/claude/cli/bridge"
import { cleanClaudeEnv } from "~/services/claude/cli/env"
import { claudeCliArgs } from "~/services/claude/cli/args"
import { runRegistry } from "~/services/claude/cli/run-registry"
import {
  setClaudeCallbackBaseUrl,
  resetClaudeCallbackBaseUrlForTest,
} from "~/services/claude/cli/server-address"
import { toolResults } from "~/services/claude/cli/tools"
import {
  drain,
  installFakeClaude,
  testConnection,
  testCredential,
} from "./claude-cli-fixtures"
import { loopbackTest } from "./helpers/loopback-test"

let context: ClaudeCliRunContext
let server: ReturnType<typeof Bun.serve> | undefined
beforeEach(async () => {
  const binary = await installFakeClaude()
  setClaudeCliTestHooks({ findBinary: () => binary })
  setClaudeCallbackBaseUrl("http://127.0.0.1:1")
  context = {
    connection: testConnection(),
    credential: testCredential(),
    model: "claude-sonnet-4-6",
    accessToken: "test-token",
  }
})
afterEach(() => {
  setClaudeCliTestHooks({})
  resetClaudeCallbackBaseUrlForTest()
  server?.stop(true)
  server = undefined
  delete process.env.FAKE_CLAUDE_SCENARIO
})
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

function payload(): AnthropicMessagesPayload {
  return {
    model: context.model,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
  }
}
function imagePayload(): AnthropicMessagesPayload {
  return {
    ...payload(),
    messages: [
      ...payload().messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_fake_1",
            name: "get_weather",
            input: { city: "SF" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_fake_1",
            content: [
              { type: "text", text: "screenshot:" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "aW1hZ2U=",
                },
              },
              {
                type: "image",
                source: {
                  type: "url",
                  url: "https://example.invalid/image.png",
                },
              },
            ],
          },
        ],
      },
    ],
  }
}

describe("Claude CLI connection contract", () => {
  test.each([undefined, "300000", "20"])(
    "bounds MCP patience below the CLI timeout (%s)",
    async (configured) => {
      const previous = process.env.COPILOT_API_CLAUDE_MCP_PATIENCE_MS
      if (configured === undefined)
        delete process.env.COPILOT_API_CLAUDE_MCP_PATIENCE_MS
      else process.env.COPILOT_API_CLAUDE_MCP_PATIENCE_MS = configured
      const proc = Bun.spawn(
        [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      const tmpDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "claude-patience-"),
      )
      const timer = spyOn(globalThis, "setTimeout")
      const run = new ClaudeCliRun({
        token: "patience-test",
        payload: payload(),
        context,
        proc,
        tmpDir,
      })
      const waiting = run
        .awaitToolCall("toolu_patience", "read")
        .catch(() => undefined)
      try {
        expect(timer.mock.calls.map((call) => call[1])).toContain(
          configured === "20" ? 20 : 55_000,
        )
      } finally {
        timer.mockRestore()
        run.abort()
        await waiting
        await proc.exited
        if (previous === undefined)
          delete process.env.COPILOT_API_CLAUDE_MCP_PATIENCE_MS
        else process.env.COPILOT_API_CLAUDE_MCP_PATIENCE_MS = previous
      }
    },
  )
  test("preserves xhigh as a distinct CLI effort", () => {
    const args = claudeCliArgs({
      model: "test",
      mcpConfigPath: "test.json",
      effort: "xhigh",
    })
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh")
  })
  test("sets connection proxy in the isolated CLI environment", () => {
    const env = cleanClaudeEnv(
      {
        HTTPS_PROXY: "http://inherited.invalid",
        https_proxy: "http://lowercase.invalid",
      },
      { proxyUrl: "http://connection.invalid:8080" },
    )
    expect(env.HTTPS_PROXY).toBe("http://connection.invalid:8080")
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY)
    expect(env.https_proxy).toBeUndefined()
    expect(env.NO_PROXY).toContain("127.0.0.1")
  })
  test("passes connection proxy to the actual child process", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "env"
    context.connection.proxyUrl = "http://connection.invalid:8080"
    const events = await drain(
      await streamClaudeCliMessages(context, payload()),
    )
    expect(JSON.stringify(events)).toContain("http://connection.invalid:8080")
  })
  test("rejects an already cancelled request without starting a run", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled-before-start"))
    const count = runRegistry.size
    await expect(
      streamClaudeCliMessages(
        { ...context, signal: controller.signal },
        payload(),
      ).then(drain),
    ).rejects.toThrow("cancelled-before-start")
    expect(runRegistry.size).toBe(count)
  })
  test("cancels while waiting for the first CLI event", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "delay"
    const controller = new AbortController()
    const pending = streamClaudeCliMessages(
      { ...context, signal: controller.signal },
      payload(),
    ).then(drain)
    setTimeout(() => controller.abort(new Error("cancelled-during-start")), 80)
    expect(await rejection(pending)).toMatchObject({
      message: "cancelled-during-start",
    })
  })
  test("cancels an active stream and releases its run", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "slow-text"
    const controller = new AbortController()
    const events = await streamClaudeCliMessages(
      { ...context, signal: controller.signal },
      payload(),
    )
    const reading = drain(events)
    controller.abort(new Error("cancelled-stream"))
    expect(await rejection(reading)).toMatchObject({
      message: "cancelled-stream",
    })
    expect(runRegistry.countForConnection(context.connection.id)).toBe(0)
  })
  test("preserves image blocks in resumed tool results", () => {
    expect(toolResults(imagePayload())).toMatchObject([
      {
        toolUseId: "toolu_fake_1",
        content: [
          { type: "text", text: "screenshot:" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          { type: "text", text: "[image: https://example.invalid/image.png]" },
        ],
      },
    ])
  })
  loopbackTest(
    "delivers image bytes through a parked run without cancelling the completed segment",
    async () => {
      const app = new Hono()
      app.route("/_internal/claude-mcp", claudeMcpRoutes)
      server = Bun.serve({ port: 0, fetch: app.fetch })
      setClaudeCallbackBaseUrl(`http://127.0.0.1:${server.port}`)
      process.env.FAKE_CLAUDE_SCENARIO = "tool-image"
      const controller = new AbortController()
      await drain(
        await streamClaudeCliMessages(
          { ...context, signal: controller.signal },
          payload(),
        ),
      )
      controller.abort(new Error("completed-http-request"))
      await Bun.sleep(100)
      expect(runRegistry.countForConnection(context.connection.id)).toBe(1)
      const events = await drain(
        await streamClaudeCliMessages(context, imagePayload()),
      )
      expect(JSON.stringify(events)).toContain("aW1hZ2U=")
      expect(JSON.stringify(events)).toContain("image/png")
    },
  )
})
