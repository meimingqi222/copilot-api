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
  test("writes isolated jetski-standalone-oauth-token file", async () => {
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
        path.join(geminiDir, "jetski-standalone-oauth-token"),
        "utf8",
      ),
    ) as {
      token: {
        access_token: string
        refresh_token?: string
        token_type: string
      }
      auth_method: string
      id_token_email?: string
    }

    expect(tokenJson.token.access_token).toBe("ya29.test-access-token")
    expect(tokenJson.token.refresh_token).toBe("1//test-refresh-token")
    expect(tokenJson.token.token_type).toBe("Bearer")
    expect(tokenJson.auth_method).toBe("oauth-personal")
    expect(tokenJson.id_token_email).toBe("user@example.com")
  })
})

describe("antigravity acp prompt & tools", () => {
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
