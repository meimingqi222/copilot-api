import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  __resetProviderConnectionsForTest,
  getProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { handleSseStream } from "~/lib/sse"
import { translateClaudeStreamJson } from "~/services/claude/cli/translate"
import {
  applyClaudeLimitHeaders,
  claudeLimitHeaders,
  recordClaudeRateLimit,
} from "~/services/claude/limit-headers"

import { testConnection } from "./claude-cli-fixtures"

const FIVE = Date.parse("2026-11-01T05:00:00Z") / 1000
const WEEK = Date.parse("2026-11-07T00:00:00Z") / 1000

afterEach(() => __resetProviderConnectionsForTest())

function connectionWithQuota() {
  const connection = testConnection()
  connection.credentials[0].quota = {
    fetchedAt: Date.now(),
    unlimited: false,
    provider: "claude",
    details: {
      five_hour: {
        utilization: 0.42,
        resets_at: new Date(FIVE * 1000).toISOString(),
      },
      seven_day: {
        utilization: 0.17,
        resets_at: new Date(WEEK * 1000).toISOString(),
      },
      seven_day_opus: { utilization: 0.9, resets_at: "2026-11-07T00:00:00Z" },
    },
  }
  upsertProviderConnection(connection)
  return connection
}

test("headers carry a 0-1 share and a Unix-seconds reset per window, as Anthropic's do", () => {
  expect(
    claudeLimitHeaders(connectionWithQuota().credentials[0].quota?.details),
  ).toEqual({
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-5h-reset": String(FIVE),
    "anthropic-ratelimit-unified-7d-utilization": "0.17",
    "anthropic-ratelimit-unified-7d-reset": String(WEEK),
  })
  // A window without a reset, or no quota at all, says nothing.
  expect(claudeLimitHeaders({ five_hour: { utilization: 0.4 } })).toEqual({})
  expect(claudeLimitHeaders(undefined)).toEqual({})
})

test("a reply carries them on both the JSON and the streamed response", async () => {
  const connection = connectionWithQuota()
  const identity = {
    ownerId: connection.id,
    connectionId: connection.id,
    credentialId: connection.credentials[0].id,
    provider: "claude",
  }
  const app = new Hono()
  app.get("/json", (c) => {
    applyClaudeLimitHeaders(c, identity)
    return c.json({ ok: true })
  })
  app.get("/sse", (c) => {
    applyClaudeLimitHeaders(c, identity)
    return handleSseStream(c, async (stream) => {
      await stream.writeSSE({ data: "{}" })
    })
  })
  for (const path of ["/json", "/sse"]) {
    const response = await app.request(path)
    expect(
      response.headers.get("anthropic-ratelimit-unified-5h-utilization"),
    ).toBe("0.42")
    expect(response.headers.get("anthropic-ratelimit-unified-7d-reset")).toBe(
      String(WEEK),
    )
    await response.text()
  }
})

test("Claude Code's rate_limit_event updates the account's windows for the next reply", () => {
  const connection = connectionWithQuota()
  const next = FIVE + 3600
  recordClaudeRateLimit(connection.id, connection.credentials[0].id, {
    unifiedWindows: {
      five_hour: { utilization: 0.63, resetsAt: next },
      seven_day: { utilization: 0.2, resetsAt: WEEK },
    },
  })
  const details = getProviderConnection(connection.id)?.credentials[0].quota
    ?.details
  expect(claudeLimitHeaders(details)).toMatchObject({
    "anthropic-ratelimit-unified-5h-utilization": "0.63",
    "anthropic-ratelimit-unified-5h-reset": String(next),
    "anthropic-ratelimit-unified-7d-utilization": "0.2",
  })
  // Windows the event does not carry are kept.
  expect(details?.seven_day_opus).toMatchObject({ utilization: 0.9 })
})

test("the translator hands Claude Code's rate_limit_event over, not to the client", async () => {
  const seen: Array<unknown> = []
  async function* lines() {
    yield JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: FIVE } },
      },
    })
  }
  const events = []
  for await (const event of translateClaudeStreamJson(lines(), {
    model: "m",
    onRateLimit: (info) => seen.push(info),
  }))
    events.push(event)
  expect(seen).toEqual([
    {
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: FIVE } },
    },
  ])
  expect(JSON.stringify(events)).not.toContain("rate_limit")
})
