import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import {
  getMutableProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import * as store from "~/lib/provider-connections/store"
import type { QuotaSnapshot } from "~/lib/quota/types"
import * as quota from "~/lib/quota/refresh"
import {
  resetWarmupReportingForTest,
  runAccountWarmups,
} from "~/lib/quota/warmup"
import { acquireRouteTargetSlot } from "~/lib/route-target/load"
import { onStateChange } from "~/lib/state-events"
import { systemConfigApiRoutes } from "~/routes/admin/api/system-config"
import { initializeSystemConfig, updateSystemConfig } from "~/lib/system-config"
import * as claude from "~/services/claude/create-messages-once"
import * as codex from "~/services/codex/create-responses-once"
import * as antigravity from "~/services/antigravity/create-chat-completions-once"
import { logger } from "~/lib/logger"
import { HTTPError } from "~/lib/error"
import {
  rememberCodexClientModels,
  resetCodexClientModelsForTest,
} from "~/services/codex/client-models"
import { listTestAccounts, setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = listTestAccounts()
const normal = {
  logLevel: "info",
  requestDump: false,
  memoryVerbose: false,
  performanceDetails: true,
  debugMinutes: 15,
} as const
let now: number
let snapshots: Record<string, QuotaSnapshot>
let requests: string[]
let fail: boolean
let clock: ReturnType<typeof spyOn<typeof Date, "now">>
let save: ReturnType<typeof spyOn<typeof store, "saveProviderConnections">>
let refresh: ReturnType<typeof spyOn<typeof quota, "refreshManagedQuota">>
let messages: ReturnType<
  typeof spyOn<typeof claude, "createClaudeMessagesOnce">
>
let responses: ReturnType<
  typeof spyOn<typeof codex, "createCodexResponsesOnce">
>
let chats: ReturnType<
  typeof spyOn<typeof antigravity, "createAntigravityChatCompletionsOnce">
>

function connection(id: string) {
  const conn = getMutableProviderConnection(id)
  if (!conn) throw new Error("missing fixture")
  return conn
}

function enable(times = ["07:00"]) {
  updateSystemConfig({
    ...normal,
    accountWarmup: { enabled: true, times, timeZone: "Asia/Shanghai" },
  })
}

beforeEach(() => {
  resetWarmupReportingForTest()
  now = Date.parse("2026-10-15T23:00:30Z") // 07:00 next day in Shanghai
  clock = spyOn(Date, "now").mockImplementation(() => now)
  save = spyOn(store, "saveProviderConnections").mockResolvedValue(undefined)
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  setTestAccounts(
    ["claude", "codex"].map((provider) => ({
      id: provider,
      label: provider,
      provider: provider as "claude" | "codex",
      enabled: true,
      credentials: { accessToken: "test-token" },
    })),
  )
  for (const id of ["claude", "codex"])
    connection(id).models = [
      {
        publicId: `${id}-public`,
        upstreamId: id === "claude" ? "claude-haiku-4-5" : "gpt-6-luna",
        enabled: true,
        endpoints: [id === "claude" ? "messages" : "responses"],
      },
    ]
  snapshots = {
    claude: {
      fetchedAt: now,
      unlimited: false,
      premiumInteractionsRemaining: 85,
      details: {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 0.15, resets_at: "2026-10-20T00:00:00Z" },
      },
    },
    codex: {
      fetchedAt: now,
      unlimited: false,
      premiumInteractionsRemaining: 70,
      details: {
        rate_limit: {
          primary_window: {
            used_percent: 0,
            limit_window_seconds: 18000,
            reset_at: Math.floor(now / 1000) - 1,
          },
          secondary_window: {
            used_percent: 30,
            limit_window_seconds: 604800,
            reset_at: Math.floor(now / 1000) + 86400,
          },
        },
      },
    },
  }
  refresh = spyOn(quota, "refreshManagedQuota").mockImplementation(
    async (conn) => snapshots[conn.id],
  )
  requests = []
  fail = false
  messages = spyOn(claude, "createClaudeMessagesOnce").mockImplementation(
    async ({ connection: conn }, payload) => {
      requests.push(`${conn.id}/${payload.model}`)
      if (fail) throw new Error("temporary upstream error")
      return { type: "message", content: [{ type: "text", text: "O" }] }
    },
  )
  responses = spyOn(codex, "createCodexResponsesOnce").mockImplementation(
    async ({ connection: conn }, payload) => {
      requests.push(`${conn.id}/${payload.model}`)
      if (fail) throw new Error("temporary upstream error")
      return {
        id: "warmup",
        model: payload.model,
        status: "completed",
        output: [],
      }
    },
  )
  chats = spyOn(
    antigravity,
    "createAntigravityChatCompletionsOnce",
  ).mockImplementation(async ({ connection: conn }, payload) => {
    requests.push(`${conn.id}/${payload.model}`)
    return {
      id: "warmup",
      object: "chat.completion",
      created: 0,
      model: payload.model,
      choices: [],
    }
  })
})

afterEach(() => {
  clock.mockRestore()
  save.mockRestore()
  refresh.mockRestore()
  messages.mockRestore()
  responses.mockRestore()
  chats.mockRestore()
  resetCodexClientModelsForTest()
  setTestAccounts(originalAccounts)
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
})

test("off by default; each native account sends once at its configured local time, including concurrent ticks", async () => {
  await runAccountWarmups()
  expect(requests).toEqual([])
  enable()
  await Promise.all([runAccountWarmups(), runAccountWarmups()])
  await runAccountWarmups()
  expect(requests).toEqual(["claude/claude-haiku-4-5", "codex/gpt-6-luna"])
  expect(connection("claude").metadata?.accountWarmup).toMatchObject({
    status: "succeeded",
    slot: "Asia/Shanghai/2026-10-16/07:00",
  })
  // Simulate a reload with the durable attempt metadata, not an in-memory latch.
  for (const id of ["claude", "codex"])
    upsertProviderConnection(structuredClone(connection(id)))
  await runAccountWarmups()
  expect(requests).toHaveLength(2)
})

test("before the slot and beyond its catch-up window sends nothing; next day's slot runs", async () => {
  enable()
  now -= 60_000
  await runAccountWarmups()
  now += 6 * 60_000
  await runAccountWarmups()
  expect(requests).toEqual([])
  now += 24 * 3600_000 - 5 * 60_000
  snapshots.claude.fetchedAt = snapshots.codex.fetchedAt = now
  await runAccountWarmups()
  expect(requests).toHaveLength(2)
})

test("active windows, exhausted weekly quotas, disabled accounts and missing native models are skipped", async () => {
  enable()
  snapshots.claude.details!.five_hour = {
    utilization: 0.2,
    resets_at: new Date(now + 3600_000).toISOString(),
  }
  snapshots.codex.premiumInteractionsRemaining = 0
  await runAccountWarmups()
  expect(requests).toEqual([])
  snapshots.claude.details!.five_hour = { utilization: 0, resets_at: null }
  snapshots.codex.premiumInteractionsRemaining = 70
  connection("claude").enabled = false
  snapshots.codex.details!.rate_limit = {
    primary_window: {
      used_percent: 10,
      limit_window_seconds: 18000,
      reset_at: Math.floor(now / 1000) + 1000,
    },
  }
  await runAccountWarmups()
  expect(requests).toEqual([])
  snapshots.codex.details!.rate_limit = {
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 18000,
      reset_at: Math.floor(now / 1000) - 1,
    },
  }
  const release = acquireRouteTargetSlot(
    `codex::${connection("codex").credentials[0].id}::responses`,
  )
  try {
    await runAccountWarmups()
    expect(requests).toEqual([])
  } finally {
    release?.()
  }
  connection("codex").models = []
  await runAccountWarmups()
  expect(requests).toEqual([])
})

test("failed or stale quota reads cannot trigger inference; upstream failures are recorded without resending", async () => {
  enable()
  snapshots.claude.fetchedAt = now - 61_000
  refresh.mockImplementation(async (conn) => {
    if (conn.id === "codex") throw new Error("quota unavailable")
    return snapshots[conn.id]
  })
  await runAccountWarmups()
  expect(requests).toEqual([])
  refresh.mockImplementation(async (conn) => snapshots[conn.id])
  snapshots.claude.fetchedAt = now
  fail = true
  await runAccountWarmups()
  await runAccountWarmups()
  expect(requests).toHaveLength(2)
  expect(connection("codex").metadata?.accountWarmup).toMatchObject({
    status: "failed",
    error: "temporary upstream error",
  })
})

test("catch-up across midnight uses the previous local date and does not replay that slot", async () => {
  enable(["23:59"])
  now = Date.parse("2026-10-16T16:01:00Z") // 00:01 Shanghai, previous slot belongs to Oct 16.
  snapshots.claude.fetchedAt = snapshots.codex.fetchedAt = now
  await runAccountWarmups()
  await runAccountWarmups()
  expect(requests).toHaveLength(2)
  expect(connection("codex").metadata?.accountWarmup).toMatchObject({
    slot: "Asia/Shanghai/2026-10-16/23:59",
  })
})

test("unknown or malformed window resets are not treated as idle windows", async () => {
  enable()
  snapshots.claude.details = { five_hour: { utilization: 0.3 } }
  snapshots.codex.details = {
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18000 },
    },
  }
  await runAccountWarmups()
  expect(requests).toEqual([])
  snapshots.claude.details = {}
  snapshots.codex.details = {}
  await runAccountWarmups()
  expect(requests).toEqual([])
})

test("auto selection skips expensive, disabled and wrong-endpoint models; Luna wins over Mini", async () => {
  enable()
  connection("claude").models!.unshift({
    publicId: "opus",
    upstreamId: "claude-opus-4-6",
    enabled: true,
    endpoints: ["messages"],
  })
  connection("codex").models!.unshift(
    {
      publicId: "sol",
      upstreamId: "gpt-6-sol",
      enabled: true,
      endpoints: ["responses"],
    },
    {
      publicId: "mini",
      upstreamId: "gpt-5.4-mini",
      enabled: true,
      endpoints: ["responses"],
    },
  )
  await runAccountWarmups()
  expect(requests).toEqual(["claude/claude-haiku-4-5", "codex/gpt-6-luna"])
  expect(messages.mock.calls[0][1]).toMatchObject({
    messages: [{ role: "user", content: "Reply only OK." }],
    max_tokens: 1,
  })
  expect(responses.mock.calls[0][1]).toMatchObject({
    input: "Reply only OK.",
    tools: [],
    reasoning: { effort: "low" },
  })
  now += 86400_000
  snapshots.claude.fetchedAt = snapshots.codex.fetchedAt = now
  connection("claude").models![1].enabled = false
  connection("codex").models!.at(-1)!.endpoints = ["chat"]
  await runAccountWarmups()
  expect(requests).toEqual([
    "claude/claude-haiku-4-5",
    "codex/gpt-6-luna",
    "codex/gpt-5.4-mini",
  ])
})

test("exact upstream overrides are respected without fallback; discovered effort levels override templates", async () => {
  enable()
  connection("claude").models!.push({
    publicId: "opus",
    upstreamId: "claude-opus-4-6",
    enabled: true,
    endpoints: ["messages"],
  })
  updateSystemConfig({
    ...normal,
    accountWarmup: {
      enabled: true,
      times: ["07:00"],
      timeZone: "Asia/Shanghai",
      models: { claude: "claude-public", codex: "gpt-6-luna" },
    },
  })
  rememberCodexClientModels("codex", [
    {
      slug: "gpt-6-luna",
      supported_reasoning_levels: [
        null,
        { effort: "high" },
        { effort: "medium" },
      ],
    },
  ])
  await runAccountWarmups()
  expect(requests).toEqual(["codex/gpt-6-luna"])
  expect(responses.mock.calls[0][1].reasoning).toEqual({ effort: "medium" })
  updateSystemConfig({
    ...normal,
    accountWarmup: {
      enabled: true,
      times: ["07:00"],
      timeZone: "Asia/Shanghai",
      models: { claude: "claude-opus-4-6", codex: "missing-model" },
    },
  })
  await runAccountWarmups()
  expect(requests).toEqual(["codex/gpt-6-luna", "claude/claude-opus-4-6"])
})

function setupAntigravity() {
  setTestAccounts([
    {
      id: "ag",
      label: "ag",
      provider: "antigravity",
      enabled: true,
      credentials: { accessToken: "test-token" },
    },
  ])
  connection("ag").models = [
    "claude-opus-4-6",
    "gemini-3.1-pro",
    "gemini-3.8-flash",
    "claude-haiku-4-5",
  ].map((id) => ({
    publicId: id,
    upstreamId: id,
    enabled: true,
    endpoints: ["chat"],
  }))
  snapshots.ag = {
    fetchedAt: now,
    unlimited: false,
    premiumInteractionsRemaining: 0,
    details: {
      groups: ["Gemini Models", "Claude and GPT models"].map((displayName) => ({
        displayName,
        buckets: [
          {
            window: "five_hour",
            remainingFraction: 1,
            resetTime: new Date(now - 1).toISOString(),
          },
          {
            window: "weekly",
            remainingFraction: 0.8,
            resetTime: new Date(now + 86400_000).toISOString(),
          },
        ],
      })),
    },
  }
  return snapshots.ag.details!.groups as Array<{
    displayName: string
    buckets: Array<{
      window: string
      remainingFraction: number
      resetTime: string
    }>
  }>
}

test("Antigravity pools warm independently, do not cross pools and persist per-pool dedup", async () => {
  const groups = setupAntigravity()
  groups[1].buckets[1].remainingFraction = 0
  enable()
  await runAccountWarmups()
  expect(requests).toEqual(["ag/gemini-3.8-flash"])
  expect(chats.mock.calls[0][1]).toMatchObject({
    max_tokens: 1,
    reasoning_effort: "minimal",
  })
  groups[1].buckets[1].remainingFraction = 0.8
  upsertProviderConnection(structuredClone(connection("ag")))
  await runAccountWarmups()
  await runAccountWarmups()
  expect(requests).toEqual(["ag/gemini-3.8-flash", "ag/claude-haiku-4-5"])
  expect(connection("ag").metadata?.accountWarmup).toMatchObject({
    pools: {
      antigravityGemini: { status: "succeeded", model: "gemini-3.8-flash" },
      antigravityClaude: { status: "succeeded", model: "claude-haiku-4-5" },
    },
  })
})

test("Antigravity busy, unknown and weekly-only windows skip; explicit models cannot cross pools", async () => {
  const groups = setupAntigravity()
  enable()
  // A busy five hour window skips even while more than 99% is not required:
  // the gate is usage based now, not "is the window still open".
  groups[0].buckets[0].remainingFraction = 0.5
  groups[1].buckets.shift()
  await runAccountWarmups()
  expect(requests).toEqual([])
  groups[0].buckets[0].remainingFraction = 1
  groups[0].buckets[0].resetTime = ""
  await runAccountWarmups()
  expect(requests).toEqual([])
  groups[0].buckets[0].resetTime = new Date(now - 1).toISOString()
  updateSystemConfig({
    ...normal,
    accountWarmup: {
      enabled: true,
      times: ["07:00"],
      timeZone: "Asia/Shanghai",
      models: { antigravityGemini: "claude-opus-4-6" },
    },
  })
  await runAccountWarmups()
  expect(requests).toEqual([])
})

test("model changes during quota refresh or persistence prevent sending the old selection", async () => {
  enable()
  refresh.mockImplementation(async (conn) => {
    if (conn.id === "claude") conn.models![0].enabled = false
    return snapshots[conn.id]
  })
  const unsubscribe = onStateChange("models-stale", () => {
    connection("codex").models = []
  })
  try {
    await runAccountWarmups()
    expect(requests).toEqual([])
    // Nothing was sent, so the reason must be visible instead of silent.
    expect(connection("claude").metadata?.accountWarmup).toMatchObject({
      lastSkip: {
        reason: expect.stringMatching(
          /model selection changed|no enabled messages model matched the claude pool/,
        ),
      },
    })
  } finally {
    unsubscribe()
  }
})

test("warmup catalog lists enabled native upstream IDs once, recommends low-cost families first and separates pools", async () => {
  connection("codex").models!.unshift(
    {
      publicId: "sol-alias",
      upstreamId: "gpt-6-sol",
      enabled: true,
      endpoints: ["responses"],
    },
    {
      publicId: "mini-alias",
      upstreamId: "gpt-5.4-mini",
      enabled: true,
      endpoints: ["responses"],
    },
    {
      publicId: "luna-alias",
      upstreamId: "gpt-6-luna",
      enabled: true,
      endpoints: ["responses"],
    },
    {
      publicId: "disabled",
      upstreamId: "disabled-luna",
      enabled: false,
      endpoints: ["responses"],
    },
    {
      publicId: "wrong-wire",
      upstreamId: "wrong-luna",
      enabled: true,
      endpoints: ["chat"],
    },
  )
  connection("claude").enabled = false
  let response = await systemConfigApiRoutes.request("/warmup-models")
  expect(response.status).toBe(200)
  expect(((await response.json()) as { models: unknown }).models).toEqual({
    claude: [],
    antigravityGemini: [],
    antigravityClaude: [],
    codex: [
      { id: "gpt-6-luna", name: "gpt-6-luna", recommended: true },
      { id: "gpt-5.4-mini", name: "gpt-5.4-mini", recommended: true },
      { id: "gpt-6-sol", name: "gpt-6-sol", recommended: false },
    ],
  })
  setupAntigravity()
  response = await systemConfigApiRoutes.request("/warmup-models")
  const { models } = (await response.json()) as {
    models: Record<string, Array<{ id: string }>>
  }
  expect(
    models.antigravityGemini.map((model: { id: string }) => model.id),
  ).toEqual(["gemini-3.8-flash", "gemini-3.1-pro"])
  expect(
    models.antigravityClaude.map((model: { id: string }) => model.id),
  ).toEqual(["claude-haiku-4-5", "claude-opus-4-6"])
  expect(requests).toEqual([])
})

test("a slot that sends nothing still explains itself: one reason per connection, durable and write-once", async () => {
  enable()
  // The real production shape: the five hour window is full and has not reset,
  // and the weekly allowance is still healthy.
  snapshots.codex.details!.rate_limit = {
    primary_window: {
      used_percent: 100,
      limit_window_seconds: 18000,
      reset_at: Math.floor(now / 1000) + 3600,
    },
    secondary_window: {
      used_percent: 30,
      limit_window_seconds: 604800,
      reset_at: Math.floor(now / 1000) + 86400,
    },
  }
  const info = spyOn(logger, "info")
  try {
    await runAccountWarmups()
    const writes = save.mock.calls.length
    await runAccountWarmups()
    await runAccountWarmups()
    const lines = info.mock.calls.map((call) => String(call[0]))
    // Claude was idle and warmed; Codex was busy and said so.
    expect(requests).toEqual(["claude/claude-haiku-4-5"])
    expect(
      lines.filter((line) => line.startsWith("Account warmup slot ")),
    ).toHaveLength(1)
    expect(lines).toContain(
      "Account warmup slot Asia/Shanghai/2026-10-16/07:00: evaluating 2 warmable account connection(s)",
    )
    const skips = lines.filter((line) =>
      line.startsWith("Account warmup skipped for"),
    )
    expect(skips).toHaveLength(1)
    expect(skips[0]).toMatch(/skipped for "codex" \(codex\)/)
    expect(skips[0]).toMatch(/window is at 100% until/)
    // Reasons are durable so a restart does not erase the explanation.
    expect(connection("codex").metadata?.accountWarmup).toMatchObject({
      lastSkip: {
        slot: "Asia/Shanghai/2026-10-16/07:00",
        pool: "codex",
        reason: expect.stringMatching(/window is at 100% until/),
      },
    })
    // Repeated ticks inside the catch-up window must not re-report or re-write.
    expect(save.mock.calls.length).toBe(writes)
  } finally {
    info.mockRestore()
  }
})

test("a skipped connection does not block the others, and the next day's slot reports again", async () => {
  enable()
  snapshots.codex.premiumInteractionsRemaining = 0
  const info = spyOn(logger, "info")
  try {
    await runAccountWarmups()
    expect(requests).toEqual(["claude/claude-haiku-4-5"])
    expect(connection("codex").metadata?.accountWarmup).toMatchObject({
      lastSkip: { reason: "weekly allowance is exhausted" },
    })
    now += 86400_000
    snapshots.claude.fetchedAt = snapshots.codex.fetchedAt = now
    await runAccountWarmups()
    const slots = info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("Account warmup slot "))
    expect(slots).toEqual([
      "Account warmup slot Asia/Shanghai/2026-10-16/07:00: evaluating 2 warmable account connection(s)",
      "Account warmup slot Asia/Shanghai/2026-10-17/07:00: evaluating 2 warmable account connection(s)",
    ])
  } finally {
    info.mockRestore()
  }
})

test("a resting credential, a disabled account and a missing model each name their own reason", async () => {
  enable()
  const info = spyOn(logger, "info")
  try {
    connection("codex").enabled = false
    await runAccountWarmups()
    expect(requests).toEqual(["claude/claude-haiku-4-5"])
    expect(connection("codex").metadata?.accountWarmup).toMatchObject({
      lastSkip: { reason: "connection is disabled" },
    })
    connection("codex").enabled = true
    connection("codex").models = []
    now += 86400_000
    snapshots.claude.fetchedAt = snapshots.codex.fetchedAt = now
    await runAccountWarmups()
    expect(connection("codex").metadata?.accountWarmup).toMatchObject({
      lastSkip: {
        reason: "no enabled responses model matched the codex pool",
      },
    })
  } finally {
    info.mockRestore()
  }
})

test("a five hour window with more than 99% left warms even while it is still open", async () => {
  enable()
  // Open window (reset in the future) but almost untouched: the old gate treated
  // any open window as busy and never warmed this account.
  snapshots.codex.details!.rate_limit = {
    primary_window: {
      used_percent: 0.5,
      limit_window_seconds: 18000,
      reset_at: Math.floor(now / 1000) + 3600,
    },
    secondary_window: {
      used_percent: 30,
      limit_window_seconds: 604800,
      reset_at: Math.floor(now / 1000) + 86400,
    },
  }
  const info = spyOn(logger, "info")
  try {
    await runAccountWarmups()
    expect(requests).toEqual(["claude/claude-haiku-4-5", "codex/gpt-6-luna"])
    const lines = info.mock.calls.map((call) => String(call[0]))
    expect(
      lines.filter((line) => line.startsWith("Account warmup skipped for")),
    ).toEqual([])
    expect(connection("codex").metadata?.accountWarmup).toMatchObject({
      status: "succeeded",
      slot: "Asia/Shanghai/2026-10-16/07:00",
    })
    // With 10% used the window is busy again and the warmup stands down.
    now += 86400_000
    snapshots.claude.fetchedAt = snapshots.codex.fetchedAt = now
    const rateLimit = snapshots.codex.details!.rate_limit as {
      primary_window: { used_percent: number }
    }
    rateLimit.primary_window.used_percent = 10
    await runAccountWarmups()
    const next = info.mock.calls.map((call) => String(call[0]))
    expect(
      next.filter((line) => line.includes("Account warmup skipped for")),
    ).toHaveLength(1)
    expect(next.find((line) => line.includes("five hour window has"))).toMatch(
      /five hour window has 90% left \(needs more than 99%\)/,
    )
    expect(connection("codex").metadata?.accountWarmup).toMatchObject({
      lastSkip: {
        reason: expect.stringMatching(/five hour window has 90% left/),
      },
    })
  } finally {
    info.mockRestore()
  }
})

test("connections whose protocol is never warmed are excluded from the slot line and never reported", async () => {
  setTestAccounts([
    {
      id: "xai",
      label: "xai-fixture",
      provider: "xai",
      enabled: true,
      credentials: { accessToken: "test-token" },
    },
    ...["claude", "codex"].map((provider) => ({
      id: provider,
      label: provider,
      provider: provider as "claude" | "codex",
      enabled: true,
      credentials: { accessToken: "test-token" },
    })),
  ])
  for (const id of ["claude", "codex"])
    connection(id).models = [
      {
        publicId: `${id}-public`,
        upstreamId: id === "claude" ? "claude-haiku-4-5" : "gpt-6-luna",
        enabled: true,
        endpoints: [id === "claude" ? "messages" : "responses"],
      },
    ]
  enable()
  const info = spyOn(logger, "info")
  try {
    await runAccountWarmups()
    const lines = info.mock.calls.map((call) => String(call[0]))
    expect(lines).toContain(
      "Account warmup slot Asia/Shanghai/2026-10-16/07:00: evaluating 2 warmable account connection(s) of 3 account connection(s)",
    )
    expect(
      lines.filter((line) => line.startsWith("Account warmup skipped for")),
    ).toEqual([])
    expect(lines.some((line) => line.includes("xai-fixture"))).toBe(false)
  } finally {
    info.mockRestore()
  }
})

test("a failed warmup keeps the upstream body so the reason survives the log", async () => {
  enable()
  responses.mockImplementation(async () => {
    throw new HTTPError(
      "Failed to create Codex responses",
      new Response("{}", { status: 429 }),
      '{"error":{"message":"usage limit reached"}}',
    )
  })
  const info = spyOn(logger, "info")
  const warn = spyOn(logger, "warn")
  try {
    await runAccountWarmups()
    expect(connection("codex").metadata?.accountWarmup).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/HTTP 429 .*usage limit reached/),
    })
    const warned = warn.mock.calls.map((call) => String(call[0]))
    expect(
      warned.some(
        (line) =>
          line.includes("Account warmup failed")
          && line.includes("usage limit reached"),
      ),
    ).toBe(true)
  } finally {
    info.mockRestore()
    warn.mockRestore()
  }
})
