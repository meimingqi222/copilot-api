/**
 * 流内终止失败事件（开流 200 后上游毙掉 turn）的日志落盘测试。
 *
 * 背景：此前这类失败在请求日志里只留下 `response.failed` + 零输出，
 * error 字段全空，无法定位。这组测试锁定：
 * 1. `extractStreamFailureDetail` 对各种事件形态的提取；
 * 2. `buildStreamFailurePatch` 构造的补丁形态（含脱敏与截断）；
 * 3. 端到端：流内 `response.failed` 事件原样转发给客户端。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
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
  buildStreamFailurePatch,
  extractStreamFailureDetail,
} from "~/routes/responses/logging"
import { server } from "~/server"

describe("extractStreamFailureDetail", () => {
  test("extracts top-level error event", () => {
    expect(
      extractStreamFailureDetail({
        type: "error",
        code: "server_error",
        message: "upstream exploded",
      }),
    ).toBe("server_error: upstream exploded")
  })

  test("extracts nested response.failed error", () => {
    expect(
      extractStreamFailureDetail({
        type: "response.failed",
        response: {
          error: { type: "server_error", message: "model blew up" },
        },
      }),
    ).toBe("server_error: model blew up")
  })

  test("falls back to message-only and code-only shapes", () => {
    expect(extractStreamFailureDetail({ type: "error", message: "boom" })).toBe(
      "boom",
    )
    expect(extractStreamFailureDetail({ type: "error", code: "x" })).toBe(
      "upstream stream failed (x)",
    )
  })

  test("returns undefined when there is nothing to report", () => {
    expect(
      extractStreamFailureDetail({ type: "response.failed", response: {} }),
    ).toBeUndefined()
    expect(
      extractStreamFailureDetail({ type: "response.completed" }),
    ).toBeUndefined()
  })
})

describe("buildStreamFailurePatch", () => {
  test("builds a log-ready patch with upstream origin", () => {
    const patch = buildStreamFailurePatch({
      type: "response.failed",
      response: {
        error: { code: "server_error", message: "upstream exploded" },
      },
    })
    expect(patch).toEqual({
      error: "server_error: upstream exploded",
      errorType: "upstream_stream_error",
      errorSnippet: "server_error: upstream exploded",
      outcome: "failed",
      diagnosticError: {
        origin: "upstream",
        kind: "stream_failed",
        message: "server_error: upstream exploded",
      },
    })
  })

  test("returns undefined when the event carries no detail", () => {
    expect(
      buildStreamFailurePatch({ type: "response.failed", response: {} }),
    ).toBeUndefined()
  })

  test("truncates long messages", () => {
    const patch = buildStreamFailurePatch({
      type: "error",
      message: `m${"o".repeat(600)}`,
    })
    expect(patch?.error.length).toBeLessThanOrEqual(500)
    expect(patch?.diagnosticError.message.length).toBeLessThanOrEqual(500)
  })
})

describe("stream failure forwarding (integration)", () => {
  const isolationRoot = PATHS.APP_DIR
  let tempAppDir = ""
  const originalFetch = globalThis.fetch
  const originalApiKey = state.legacyApiKey

  beforeEach(async () => {
    tempAppDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `stream-fail-test-${randomUUID()}-`),
    )
    redirectPathsToDir(tempAppDir)
    __resetProviderConnectionsForTest()
    statsStore.clearUsageStatsForTest()
    resetProtectedRouteGuardForTest()
    state.legacyApiKey = undefined
    await createConnection({
      id: "codex-stream-fail",
      name: "codex-stream-fail",
      protocol: "codex-native",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      priority: 0,
      credentials: [{ id: "cred", value: "eJ-test", authMode: "bearer" }],
      models: [
        {
          publicId: "gpt-5.4",
          upstreamId: "gpt-5.4",
          endpoints: ["responses"],
          enabled: true,
        },
      ],
    })
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    redirectPathsToDir(isolationRoot)
    __resetProviderConnectionsForTest()
    state.legacyApiKey = originalApiKey
    if (tempAppDir) {
      await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("in-stream response.failed reaches the client unchanged", async () => {
    const sse =
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`
      + `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          id: "resp_1",
          error: { code: "server_error", message: "upstream exploded" },
        },
      })}\n\ndata: [DONE]\n\n`
    const fetchMock = mock(() => {
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await server.fetch(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          stream: true,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "hi" }],
            },
          ],
        }),
      }),
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    // 失败事件原样透传给客户端（日志补丁由单测覆盖）。
    expect(text).toContain("response.failed")
    expect(text).toContain("upstream exploded")
  })
})
