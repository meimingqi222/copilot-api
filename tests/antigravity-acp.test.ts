import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { managedConnectionFromInput } from "~/lib/provider-connections"
import {
  applyConnectionPatchToConnection,
  patchRequiresModelRefresh,
} from "~/routes/admin/api/account-update"
import { publicAccountFromConnection } from "~/routes/admin/api/account-views"
import { syncAntigravityAcpCredentials } from "~/services/antigravity/acp/auth-sync"
import { resolveAcpModelId } from "~/services/antigravity/acp/bridge"
import { normalizeAcpUsage } from "~/services/antigravity/acp/client"
import { handleAntigravityMcpCallback } from "~/services/antigravity/acp/mcp-callback"
import {
  buildAcpPromptBlocks,
  extractMcpTools,
  extractTrailingToolResults,
} from "~/services/antigravity/acp/prompt"
import {
  AgyRun,
  runRegistry,
  stripBridgeToolPrefix,
} from "~/services/antigravity/acp/run-registry"
import { resolveAntigravityTransport } from "~/services/antigravity/acp/transport"

import { loopbackTest } from "./helpers/loopback-test"

const ORIGINAL_APP_DIR = PATHS.APP_DIR
const tempDirs: Array<string> = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.COPILOT_API_ANTIGRAVITY_TRANSPORT
  delete process.env.COPILOT_API_ANTIGRAVITY_MAX_RUNS
  redirectPathsToDir(ORIGINAL_APP_DIR)
  runRegistry.disposeAll()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("antigravity acp transport", () => {
  test("env COPILOT_API_ANTIGRAVITY_TRANSPORT=http overrides metadata", () => {
    const conn = managedConnectionFromInput({
      id: "ag-test-1",
      provider: "antigravity",
      name: "ag-test",
    })
    conn.metadata = { ...conn.metadata, antigravityTransport: "acp" }
    process.env.COPILOT_API_ANTIGRAVITY_TRANSPORT = "http"
    expect(resolveAntigravityTransport(conn)).toBe("http")
  })

  test("metadata antigravityTransport=http selects http when env unset", () => {
    const conn = managedConnectionFromInput({
      id: "ag-test-2",
      provider: "antigravity",
      name: "ag-test",
    })
    conn.metadata = { ...conn.metadata, antigravityTransport: "http" }
    expect(resolveAntigravityTransport(conn)).toBe("http")
  })
})

describe("antigravity acp auth-sync", () => {
  test("writes the token file agy actually reads", async () => {
    const dataDir = makeTempDir("ag-acp-data-")
    redirectPathsToDir(dataDir)

    const conn = managedConnectionFromInput({
      id: "ag-user-1",
      provider: "antigravity",
      name: "ag-user",
    })
    const cred = conn.credentials[0]
    cred.value = "ya29.test-access-token"
    cred.context = {
      ...cred.context,
      refreshToken: "1//test-refresh-token",
      expiresAt: Date.now() + 3600_000,
      email: "user@example.com",
    }

    const { geminiDir } = await syncAntigravityAcpCredentials(conn, cred)
    const tokenJson = JSON.parse(
      readFileSync(
        path.join(geminiDir, "antigravity-cli", "antigravity-oauth-token"),
        "utf8",
      ),
    ) as {
      token: {
        access_token: string
        refresh_token?: string
        token_type: string
        expiry: string
      }
      auth_method: string
      id_token?: string
    }

    expect(tokenJson.token.access_token).toBe("ya29.test-access-token")
    expect(tokenJson.token.refresh_token).toBe("1//test-refresh-token")
    expect(tokenJson.token.token_type).toBe("Bearer")
    // agy 的枚举值是 consumer；oauth-personal 会被判定为 unknown auth method
    expect(tokenJson.auth_method).toBe("consumer")
    expect(tokenJson.token.expiry).toMatch(/Z$/)
    // 没有 id_token 时不应写入占位字段
    expect(tokenJson.id_token).toBeUndefined()
  })
})

describe("antigravity acp prompt & tools", () => {
  test("provides schemas for lazy bridge calls without local file access", () => {
    const blocks = buildAcpPromptBlocks({
      model: "gemini-3.8-flash-low",
      messages: [{ role: "user", content: "Check weather" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
      ],
    })
    expect(blocks[0].text).toContain("call_mcp_tool")
    expect(blocks[0].text).toContain('ServerName="bridge"')
    expect(blocks[0].text).toContain('"name":"get_weather"')
    expect(blocks[0].text).toContain('"city":{"type":"string"}')
    expect(blocks[0].text).toContain("Do NOT use local filesystem")
  })

  loopbackTest(
    "bundled MCP helper lists tools and forwards calls",
    async () => {
      const outDir = makeTempDir("ag-acp-build-")
      const root = path.resolve(import.meta.dir, "..")
      const build = Bun.spawn(
        [process.execPath, "run", "tsdown", "--out-dir", outDir],
        {
          cwd: root,
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      const buildErrors = await new Response(build.stderr).text()
      expect(await build.exited, buildErrors).toBe(0)

      const tools = [{ name: "get_weather", inputSchema: { type: "object" } }]
      const calls: Array<unknown> = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          calls.push(await request.json())
          return Response.json({
            content: [{ type: "text", text: "Sunny 22C" }],
            is_error: false,
          })
        },
      })
      const bridgeFile = path.join(outDir, "bridge.json")
      await Bun.write(
        bridgeFile,
        JSON.stringify({
          callbackUrl: `http://127.0.0.1:${server.port}/callback`,
          tools,
        }),
      )
      const helper = Bun.spawn(
        [
          process.execPath,
          "run",
          path.join(outDir, "antigravity-mcp-helper.js"),
          bridgeFile,
        ],
        {
          cwd: outDir,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      try {
        helper.stdin.write(
          [
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { protocolVersion: "2024-11-05" },
            },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            {
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "get_weather", arguments: { city: "Taipei" } },
            },
          ]
            .map((message) => JSON.stringify(message))
            .join("\n") + "\n",
        )
        helper.stdin.end()
        const [output, errors, exitCode] = await Promise.all([
          new Response(helper.stdout).text(),
          new Response(helper.stderr).text(),
          helper.exited,
        ])
        expect(exitCode, errors).toBe(0)
        const replies = output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(replies).toEqual([
          {
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "antigravity-bridge-mcp", version: "1.0.0" },
            },
          },
          { jsonrpc: "2.0", id: 2, result: { tools } },
          {
            jsonrpc: "2.0",
            id: 3,
            result: {
              content: [{ type: "text", text: "Sunny 22C" }],
              isError: false,
            },
          },
        ])
        expect(calls).toEqual([
          { name: "get_weather", arguments: { city: "Taipei" } },
        ])
      } finally {
        helper.kill()
        await server.stop(true)
      }
    },
    20_000,
  )

  test("extracts mcp tools and builds prompt blocks with image", () => {
    const tools = extractMcpTools([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    ])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("get_weather")

    const blocks = buildAcpPromptBlocks({
      model: "gemini-4-argon-medium",
      messages: [
        { role: "system", content: "Be concise." },
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
    })
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe("text")
    expect(blocks[0].text).toContain("Be concise.")
    expect(blocks[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "AAAA",
    })
  })

  test("extracts trailing tool results", () => {
    const results = extractTrailingToolResults([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "a", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "result_1" },
    ])
    expect(results).toEqual([
      { toolCallId: "call_1", text: "result_1", isError: false },
    ])
  })
})

describe("antigravity acp run-registry & mcp-callback", () => {
  test("lazy MCP callbacks expose the client tool, not the wrapper or local tools", async () => {
    const run = new AgyRun({
      token: "lazy",
      connectionId: "c1",
      model: "m1",
      toolsSignature: "s1",
      bridgeDir: makeTempDir("ag-lazy-"),
    })
    runRegistry.register(run)
    run.handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "local-read",
      name: "read_file",
      rawInput: { path: "schema.json" },
    })
    run.handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "lazy-call",
      name: "call_mcp_tool",
      rawInput: {
        ServerName: "bridge",
        ToolName: "get_weather",
        Arguments: { city: "Taipei" },
      },
    })
    const callback = handleAntigravityMcpCallback("lazy", {
      name: "get_weather",
      arguments: { city: "Taipei" },
    })
    const event = await run.nextEvent()
    expect(event?.type).toBe("tool_call_ready")
    if (event?.type === "tool_call_ready") {
      // Use the MCP callback as the authority; ACP wrapper IDs are not needed by the caller.
      run.resolveParkedCall(event.call.toolCallId, {
        content: [{ type: "text", text: "Sunny" }],
        is_error: false,
      })
      await callback
      expect(event.call.originalName).toBe("get_weather")
      expect(JSON.parse(event.call.argsJson)).toEqual({ city: "Taipei" })
    }
  })

  test("strips mcp_bridge_ prefix and parks/resolves tool calls", async () => {
    expect(stripBridgeToolPrefix("mcp_bridge_get_weather")).toBe("get_weather")
    expect(stripBridgeToolPrefix("other")).toBe("other")

    const bridgeDir = makeTempDir("ag-acp-bridge-")
    const run = new AgyRun({
      token: "tok-1",
      connectionId: "conn-1",
      model: "gemini-3.8-flash-low",
      toolsSignature: "sig-1",
      bridgeDir,
    })
    runRegistry.register(run)

    run.handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_999",
      name: "mcp_bridge_get_weather",
      rawInput: { city: "Beijing", toolSummary: "Check weather" },
    })

    const callbackPromise = handleAntigravityMcpCallback("tok-1", {
      name: "get_weather",
      arguments: { city: "Beijing" },
    })

    const event = await run.nextEvent()
    expect(event?.type).toBe("tool_call_ready")
    if (event?.type === "tool_call_ready") {
      expect(event.call.toolCallId).toBe("call_999")
      expect(event.call.originalName).toBe("get_weather")
      expect(event.call.argsJson).toBe('{"city":"Beijing"}')
    }

    expect(run.hasParkedCall("call_999")).toBe(true)
    run.resolveParkedCall("call_999", {
      content: [{ type: "text", text: "Sunny 22C" }],
      is_error: false,
    })

    const result = await callbackPromise
    expect(result).toEqual({
      content: [{ type: "text", text: "Sunny 22C" }],
      is_error: false,
    })
  })

  test("findCandidates returns non-tainted runs and evicts oldest idle on limit", () => {
    process.env.COPILOT_API_ANTIGRAVITY_MAX_RUNS = "2"

    const r1 = new AgyRun({
      token: "t1",
      connectionId: "c1",
      model: "m1",
      toolsSignature: "s1",
      bridgeDir: makeTempDir("ag-b1-"),
    })
    r1.lastActiveAt = 100
    runRegistry.register(r1)

    const r2 = new AgyRun({
      token: "t2",
      connectionId: "c1",
      model: "m1",
      toolsSignature: "s1",
      bridgeDir: makeTempDir("ag-b2-"),
    })
    r2.lastActiveAt = 200
    runRegistry.register(r2)

    expect(
      runRegistry.findCandidates("c1", "m1", "s1").map((r) => r.token),
    ).toEqual(["t2", "t1"])

    r2.tainted = true
    expect(
      runRegistry.findCandidates("c1", "m1", "s1").map((r) => r.token),
    ).toEqual(["t1"])

    // 注册第 3 个时应淘汰最老空闲 run (t1)
    const r3 = new AgyRun({
      token: "t3",
      connectionId: "c1",
      model: "m1",
      toolsSignature: "s1",
      bridgeDir: makeTempDir("ag-b3-"),
    })
    runRegistry.register(r3)
    expect(runRegistry.find("t1")).toBeUndefined()
    expect(runRegistry.find("t3")).toBeDefined()
  })
})

describe("antigravity acp model resolution", () => {
  test("resolves exact match and family fallback", () => {
    const available = [
      "gemini-4-argon-medium",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "claude-sonnet-5-5-medium",
      "claude-opus-5-5-high",
    ]
    expect(resolveAcpModelId("gemini-3.8-flash-low", available)).toBe(
      "gemini-3.8-flash-low",
    )
    expect(resolveAcpModelId("gemini-3-flash", available)).toBe(
      "gemini-3.8-flash-medium",
    )
    expect(resolveAcpModelId("claude-sonnet-4-6", available)).toBe(
      "claude-sonnet-5-5-medium",
    )
    expect(resolveAcpModelId("claude-opus-4-6-high", available)).toBe(
      "claude-opus-5-5-high",
    )
  })
})

describe("antigravity acp admin account settings", () => {
  test("reads and updates antigravityTransport without forcing model refresh", () => {
    const conn = managedConnectionFromInput({
      id: "ag-admin-1",
      provider: "antigravity",
      name: "ag-admin",
    })

    expect(
      patchRequiresModelRefresh({ settings: { antigravityTransport: "http" } }),
    ).toBe(false)

    applyConnectionPatchToConnection(conn, {
      settings: { antigravityTransport: "http" },
    })
    expect(conn.metadata?.antigravityTransport).toBe("http")
    expect(
      publicAccountFromConnection(conn).settings?.antigravityTransport,
    ).toBe("http")

    applyConnectionPatchToConnection(conn, {
      settings: { antigravityTransport: "acp" },
    })
    expect(
      publicAccountFromConnection(conn).settings?.antigravityTransport,
    ).toBe("acp")
  })
})

describe("antigravity acp usage normalization", () => {
  test("subtracts inclusive prompt caches but preserves uncached native input", () => {
    for (const input of [
      "inputTokens",
      "input_tokens",
      "prompt_tokens",
      "promptTokenCount",
    ]) {
      expect(
        normalizeAcpUsage({
          [input]: 211,
          cachedReadTokens: 37,
          cachedWriteTokens: 19,
        }),
      ).toEqual({
        inputTokens:
          input === "inputTokens" || input === "input_tokens" ? 211 : 155,
        cachedReadTokens: 37,
        cachedWriteTokens: 19,
      })
    }
    expect(
      normalizeAcpUsage({
        prompt_tokens: 23,
        prompt_tokens_details: { cached_tokens: 31 },
      }),
    ).toEqual({ inputTokens: 0, cachedReadTokens: 31 })
  })

  test("includes Gemini thoughts in output without double-counting native output", () => {
    for (const output of [
      "outputTokens",
      "output_tokens",
      "completion_tokens",
      "candidatesTokenCount",
    ]) {
      expect(
        normalizeAcpUsage({ [output]: 47, thoughtsTokenCount: 13 }),
      ).toEqual({
        outputTokens: output === "candidatesTokenCount" ? 60 : 47,
        thoughtTokens: 13,
      })
    }
    expect(
      normalizeAcpUsage({
        prompt_tokens: 211,
        prompt_tokens_details: { cached_tokens: 37 },
        completion_tokens: 47,
        completion_tokens_details: { reasoning_tokens: 13 },
      }),
    ).toEqual({
      inputTokens: 174,
      cachedReadTokens: 37,
      outputTokens: 47,
      thoughtTokens: 13,
    })
  })

  test("keeps context occupancy separate from billable usage and validates both fields", async () => {
    const { normalizeAcpContextUsage } = await import(
      "~/services/antigravity/acp/client"
    )
    for (const [used, size] of [
      [173, 8192],
      [0, 8192],
      [0, 0],
    ]) {
      const update = { sessionUpdate: "usage_update", used, size }
      expect(normalizeAcpContextUsage(update)).toEqual({ used, size })
      expect(normalizeAcpUsage(update)).toBeUndefined()
    }
    for (const invalid of [
      undefined,
      null,
      "12",
      -1,
      NaN,
      Infinity,
      -Infinity,
    ]) {
      expect(
        normalizeAcpContextUsage({
          sessionUpdate: "usage_update",
          used: invalid,
          size: 8192,
        }),
      ).toBeUndefined()
      expect(
        normalizeAcpContextUsage({
          sessionUpdate: "usage_update",
          used: 173,
          size: invalid,
        }),
      ).toBeUndefined()
    }
    for (const invalid of [
      null,
      [],
      "usage_update",
      {},
      { used: 1, size: 2 },
      { sessionUpdate: "agent_message_chunk", used: 1, size: 2 },
    ]) {
      expect(normalizeAcpContextUsage(invalid)).toBeUndefined()
    }
  })

  test("extracts camelCase, snake_case, and usage_update payloads", () => {
    expect(
      normalizeAcpUsage({
        stopReason: "end_turn",
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          cachedReadTokens: 80,
          thoughtTokens: 10,
          totalTokens: 255,
        },
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cachedReadTokens: 80,
      thoughtTokens: 10,
      totalTokens: 255,
    })

    expect(
      normalizeAcpUsage({
        usageMetadata: {
          promptTokenCount: 200,
          candidatesTokenCount: 60,
          cachedContentTokenCount: 50,
          thoughtsTokenCount: 15,
          totalTokenCount: 325,
        },
      }),
    ).toEqual({
      inputTokens: 150,
      outputTokens: 75,
      cachedReadTokens: 50,
      thoughtTokens: 15,
      totalTokens: 325,
    })

    const run = new AgyRun({
      token: "tok-usage",
      connectionId: "conn-1",
      model: "gemini-4-hydrogen-high",
      toolsSignature: "sig-1",
      bridgeDir: makeTempDir("ag-acp-usage-"),
    })
    run.handleUpdate({
      sessionUpdate: "usage_update",
      usage: {
        input_tokens: 30,
        output_tokens: 18,
        cache_read_input_tokens: 12,
      },
    })
    expect(run.consumeTurnUsage()).toEqual({
      inputTokens: 30,
      outputTokens: 18,
      cachedReadTokens: 12,
    })
    expect(run.consumeTurnUsage()).toBeUndefined()
  })
})
