import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Integration tests for the stdio MCP helper.
 *
 * The helper is spawned the way the real `claude` binary spawns it — through
 * the CLI entrypoint (`main.ts claude-mcp-helper <url> <tools>`), not by
 * importing the module. That covers the pre-citgty dispatch branch in main.ts
 * and the "nothing but JSON-RPC on stdout" contract.
 */

const ENTRY = path.join(import.meta.dir, "..", "src", "main.ts")

/** Reads newline-delimited JSON from a stream, one line at a time. */
class LineReader {
  private buffer = ""
  private readonly decoder = new TextDecoder()
  private readonly pending: Array<string> = []
  private readonly waiters: Array<(line: string) => void> = []
  private done = false

  constructor(stream: ReadableStream<Uint8Array>) {
    void this.pump(stream)
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        this.done = true
        return
      }
      this.buffer += this.decoder.decode(value, { stream: true })
      let index = this.buffer.indexOf("\n")
      while (index >= 0) {
        this.push(this.buffer.slice(0, index))
        this.buffer = this.buffer.slice(index + 1)
        index = this.buffer.indexOf("\n")
      }
    }
  }

  private push(line: string): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(line)
      return
    }
    this.pending.push(line)
  }

  next(timeoutMs = 10_000): Promise<string> {
    const buffered = this.pending.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.done) return Promise.reject(new Error("helper closed stdout"))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for helper output")),
        timeoutMs,
      )
      this.waiters.push((line) => {
        clearTimeout(timer)
        resolve(line)
      })
    })
  }
}

interface Harness {
  send(value: unknown): void
  next(): Promise<Record<string, unknown>>
  stop(): void
}

interface CallbackCall {
  tool_call_id: string
  name: string
  arguments: unknown
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/**
 * Write the `bridge.json` the gateway hands the helper. The callback URL lives
 * in this file rather than in argv — it carries a one-shot run token and argv is
 * world-visible via `ps` on a shared machine.
 */
async function writeBridge(
  callbackUrl: string,
  tools: Array<Record<string, unknown>>,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-bridge-"))
  const file = path.join(dir, "bridge.json")
  await fs.writeFile(file, JSON.stringify({ callbackUrl, tools }), "utf8")
  return file
}

/** A fake gateway callback endpoint. */
function startCallback(responder: (call: CallbackCall) => Response): {
  url: string
  calls: Array<CallbackCall>
} {
  const calls: Array<CallbackCall> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const call = (await request.json()) as CallbackCall
      calls.push(call)
      return responder(call)
    },
  })
  cleanups.push(() => void server.stop(true))
  return { url: `http://127.0.0.1:${server.port}/callback`, calls }
}

async function startHelper(bridgePath: string): Promise<Harness> {
  const proc = Bun.spawn(
    [process.execPath, ENTRY, "claude-mcp-helper", bridgePath],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  cleanups.push(() => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  })
  const lines = new LineReader(proc.stdout)
  return {
    send: (value) => proc.stdin.write(`${JSON.stringify(value)}\n`),
    next: async () => JSON.parse(await lines.next()) as Record<string, unknown>,
    stop: () => proc.kill(),
  }
}

const TOOLS = [
  {
    name: "get_weather",
    description: "Look up the weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  },
]

describe("claude-mcp-helper", () => {
  test("answers initialize with the protocol version and server info", async () => {
    const { url } = startCallback(() => Response.json({ content: [] }))
    const harness = await startHelper(await writeBridge(url, TOOLS))
    harness.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const response = await harness.next()
    expect(response.id).toBe(1)
    expect(response.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "copilot-api" },
    })
  })

  test("lists the tools it was given", async () => {
    const { url } = startCallback(() => Response.json({ content: [] }))
    const harness = await startHelper(await writeBridge(url, TOOLS))
    harness.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    const response = await harness.next()
    expect(response.result).toEqual({ tools: TOOLS })
  })

  test("posts a tools/call to the gateway and returns its content", async () => {
    const callback = startCallback(() =>
      Response.json({ content: [{ type: "text", text: "sunny" }] }),
    )
    const harness = await startHelper(await writeBridge(callback.url, TOOLS))
    harness.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_weather",
        arguments: { city: "SF" },
        _meta: { "claudecode/toolUseId": "toolu_abc" },
      },
    })
    const response = await harness.next()
    expect(response.result).toEqual({
      content: [{ type: "text", text: "sunny" }],
      isError: false,
    })
    expect(callback.calls).toEqual([
      {
        tool_call_id: "toolu_abc",
        name: "get_weather",
        arguments: { city: "SF" },
      },
    ])
  })

  test("passes is_error through as isError", async () => {
    const callback = startCallback(() =>
      Response.json({
        content: [{ type: "text", text: "boom" }],
        is_error: true,
      }),
    )
    const harness = await startHelper(await writeBridge(callback.url, TOOLS))
    harness.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "get_weather",
        arguments: {},
        _meta: { "claudecode/toolUseId": "toolu_1" },
      },
    })
    const response = await harness.next()
    expect(response.result).toMatchObject({ isError: true })
  })

  test("invents a call id when Claude Code did not supply one", async () => {
    const callback = startCallback(() =>
      Response.json({ content: [{ type: "text", text: "ok" }] }),
    )
    const harness = await startHelper(await writeBridge(callback.url, TOOLS))
    harness.send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_weather", arguments: {} },
    })
    await harness.next()
    expect(callback.calls[0]?.tool_call_id).toMatch(/^call_/)
  })

  test("turns a non-200 callback into a JSON-RPC error", async () => {
    const callback = startCallback(() =>
      Response.json({ error: "unknown run" }, { status: 404 }),
    )
    const harness = await startHelper(await writeBridge(callback.url, TOOLS))
    harness.send({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "get_weather",
        arguments: {},
        _meta: { "claudecode/toolUseId": "toolu_1" },
      },
    })
    const response = await harness.next()
    expect(response.error).toMatchObject({ code: -32000 })
  })

  test("does not answer a notification that has no id", async () => {
    const { url } = startCallback(() => Response.json({ content: [] }))
    const harness = await startHelper(await writeBridge(url, TOOLS))
    harness.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    harness.send({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} })
    // The first response must be the tools/list one: the notification was
    // silently dropped, not answered.
    const response = await harness.next()
    expect(response.id).toBe(7)
  })

  test("rejects an unknown method", async () => {
    const { url } = startCallback(() => Response.json({ content: [] }))
    const harness = await startHelper(await writeBridge(url, TOOLS))
    harness.send({
      jsonrpc: "2.0",
      id: 8,
      method: "resources/list",
      params: {},
    })
    const response = await harness.next()
    expect(response.error).toMatchObject({ code: -32601 })
  })

  test("exits non-zero when it cannot read the bridge file", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        ENTRY,
        "claude-mcp-helper",
        path.join(os.tmpdir(), "definitely-missing-bridge.json"),
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    expect(await proc.exited).not.toBe(0)
  })

  test("exits non-zero when the bridge file has no callback URL", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-bridge-"))
    const file = path.join(dir, "bridge.json")
    await fs.writeFile(file, JSON.stringify({ tools: [] }), "utf8")
    const proc = Bun.spawn(
      [process.execPath, ENTRY, "claude-mcp-helper", file],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    expect(await proc.exited).not.toBe(0)
  })
})
