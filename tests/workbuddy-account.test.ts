import { afterEach, expect, mock, test } from "bun:test"

import {
  managedConnectionFromInput,
  serializeConnectionForExport,
} from "~/lib/provider-connections"
import type { ManagedConnectionInput } from "~/lib/provider-connections"
import type { RouteTarget } from "~/lib/provider-connections"
import { quotaAvailability } from "~/lib/quota/allowance"
import { fetchCodebuddyQuota } from "~/services/codebuddy/quota"
import {
  ensureCodebuddyAccessToken,
  refreshCodebuddyTokenForConnection,
} from "~/services/codebuddy/token-refresh"
import {
  buildCodebuddyHeaders,
  codebuddyNativeAdapter,
  resolveCodebuddyBaseUrl,
} from "~/services/protocols/codebuddy-native"
import { createCodebuddyAccountCreation } from "~/services/providers/account-creation/codebuddy"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const providers = ["codebuddy", "codebuddy-cn"] as const
const fixtureKey = "ck_fixture_abcdefgh"

async function keyInput(
  provider: (typeof providers)[number],
  apiKey: string,
): Promise<ManagedConnectionInput> {
  const result = await createCodebuddyAccountCreation(provider).prepare({
    body: { credentials: { apiKey } },
    label: "Key fixture",
    registerDeviceFlow() {},
  })
  if (!("provider" in result)) throw new Error(JSON.stringify(result))
  return result
}

test.each([...providers])(
  "%s API key survives export and uses WorkBuddy auth without renewing or billing",
  async (provider) => {
    const original = managedConnectionFromInput(
      await keyInput(provider, ` ${fixtureKey} `),
    )
    const exported = serializeConnectionForExport(original)
    const connection = managedConnectionFromInput({
      id: original.id,
      name: original.name,
      provider,
      credentials: exported.credentials as Record<string, unknown>,
    })
    connection.headers = {
      ...connection.headers,
      "x-user-id": "stale",
      "x-enterprise-id": "stale",
      "x-tenant-id": "stale",
    }
    const [credential] = connection.credentials
    credential.context = {
      ...credential.context,
      refreshToken: "not-for-a-key",
      expiresAt: 1,
    }
    const sent = mock(() => Promise.reject(new Error("unexpected fetch")))
    globalThis.fetch = sent as unknown as typeof fetch
    expect(await ensureCodebuddyAccessToken(connection, credential)).toBe(
      fixtureKey,
    )
    expect(await refreshCodebuddyTokenForConnection(connection)).toBe(false)
    const headers = new Headers(buildCodebuddyHeaders(connection, credential))
    expect(headers.get("authorization")).toBe(`Bearer ${fixtureKey}`)
    expect(headers.get("x-api-key")).toBe(fixtureKey)
    expect(headers.get("x-user-id")).toBe("anonymous_abcdefgh")
    expect(headers.has("x-domain")).toBe(false)
    expect(headers.has("x-enterprise-id")).toBe(false)
    expect(headers.has("x-tenant-id")).toBe(false)
    expect(headers.get("user-agent")).toStartWith("WorkBuddy/")
    expect(resolveCodebuddyBaseUrl(connection)).toBe(
      provider === "codebuddy" ?
        "https://www.workbuddy.ai/v2"
      : "https://copilot.tencent.com/v2",
    )
    expect((await fetchCodebuddyQuota(connection)).allowance).toEqual({
      state: "unknown",
      windows: [],
    })
    expect(sent).not.toHaveBeenCalled()
  },
)

test("API-key model discovery only asks config for CLI-compatible keys", async () => {
  const seen: Array<{ url: string; headers: Headers }> = []
  globalThis.fetch = mock(async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers) })
    return Response.json({
      code: 0,
      data: {
        agents: [{ name: "cli", models: ["glm-5.3"] }],
        models: [
          { id: "glm-5.3" },
          { id: "other" },
          { id: "custom:team|team" },
        ],
      },
    })
  }) as unknown as typeof fetch
  const key = managedConnectionFromInput(
    await keyInput("codebuddy-cn", fixtureKey),
  )
  const other = managedConnectionFromInput(
    await keyInput("codebuddy-cn", "legacy_fixture"),
  )
  expect(
    (
      await codebuddyNativeAdapter.discoverModels!({
        connection: key,
        credential: key.credentials[0],
      })
    ).map((entry) => entry.upstreamId),
  ).toEqual(["glm-5.3", "custom:team|team"])
  expect(
    await codebuddyNativeAdapter.discoverModels!({
      connection: other,
      credential: other.credentials[0],
    }),
  ).toEqual([])
  expect(seen.map(({ url }) => url)).toEqual([
    "https://copilot.tencent.com/v3/config",
  ])
  expect(seen[0].headers.get("x-api-key")).toBe(fixtureKey)
  expect(seen[0].headers.get("user-agent")).toBe(
    "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0",
  )
})

test("a refused WorkBuddy API key isn't retried or renewed", async () => {
  const connection = managedConnectionFromInput(
    await keyInput("codebuddy-cn", fixtureKey),
  )
  const [credential] = connection.credentials
  const sent = mock(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://copilot.tencent.com/v2/chat/completions")
    expect(init.redirect).toBe("manual")
    return new Response("refused", { status: 401 })
  })
  globalThis.fetch = sent as unknown as typeof fetch
  const model = "glm-5.3"
  await expect(
    codebuddyNativeAdapter.createChatCompletions!({
      target: { upstreamModelId: model } as RouteTarget,
      connection,
      credential,
      payload: { model, messages: [{ role: "user", content: "fixture" }] },
    }),
  ).rejects.toThrow("www.workbuddy.cn/profile/keys")
  expect(sent).toHaveBeenCalledTimes(1)
})

test("resource summary routes on all measured pools, even with exhausted plan credits", async () => {
  const connection = managedConnectionFromInput({
    id: "personal",
    name: "Personal",
    provider: "codebuddy",
    credentials: { accessToken: "fixture-token" },
  })
  const sent = mock(async () =>
    Response.json({
      code: 0,
      data: {
        CreditGroups: [
          {
            Kind: "plan_base",
            CycleTotalCapacity: "500",
            CycleUsedCapacity: "500",
          },
          { Kind: "addon", CycleTotalCapacity: "10", CycleUsedCapacity: "8" },
        ],
        Packages: [
          { CycleTotalCapacity: "500", CycleUsedCapacity: "500" },
          { CycleRemainCapacity: "1.25" },
          { CycleTotalCapacity: "0", CycleRemainCapacity: "99" },
        ],
      },
    }),
  )
  globalThis.fetch = sent as unknown as typeof fetch
  const quota = await fetchCodebuddyQuota(connection)
  expect(sent).toHaveBeenCalledTimes(1)
  expect(quota.chatRemaining).toBe(3.25)
  expect(quota.chatTotal).toBeUndefined()
  expect(quota.allowance.windows).toContainEqual({
    id: "plan-credits",
    unit: "credits",
    remaining: 0,
    total: 500,
    used: 1,
    aside: true,
  })
  expect(quotaAvailability(quota)).toBe("available")
})

test("enterprise usage is fetched with tenant identity and a UTC+8 cycle", async () => {
  const connection = managedConnectionFromInput({
    id: "ent",
    name: "Enterprise",
    provider: "codebuddy-cn",
    credentials: { accessToken: "fixture-token" },
    settings: { proxyUrl: "http://proxy.example:8080" },
  })
  connection.headers = {
    ...connection.headers,
    "X-Enterprise-Id": "team",
    "X-User-Id": "fixture-user",
  }
  const sent = mock(
    async (url: string, init: RequestInit & { proxy?: string }) => {
      expect(url).toBe(
        "https://copilot.tencent.com/billing/meter/get-enterprise-user-usage",
      )
      expect(new Headers(init.headers).get("x-tenant-id")).toBe("team")
      expect(new Headers(init.headers).get("x-user-id")).toBe("fixture-user")
      expect(init.proxy).toBe("http://proxy.example:8080")
      return Response.json({
        code: 0,
        data: {
          limitNum: "100",
          credit: "12.5",
          cycleStartTime: "2026-11-01 00:00:00",
          cycleResetTime: "2026-12-01 00:00:00",
        },
      })
    },
  )
  globalThis.fetch = sent as unknown as typeof fetch
  const quota = await fetchCodebuddyQuota(connection)
  expect(sent).toHaveBeenCalledTimes(1)
  expect(quota.allowance.windows[0]).toMatchObject({
    remaining: 87.5,
    total: 100,
    resetsAtMs: Date.parse("2026-11-30T16:00:00Z"),
    spanMs: 30 * 86_400_000,
  })
})

test("only CN Claude discovers native Messages", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({
      code: 0,
      data: {
        agents: [{ name: "cli", models: ["claude-opus-5.5", "glm-5.3"] }],
        models: [{ id: "claude-opus-5.5" }, { id: "glm-5.3" }],
      },
    }),
  ) as unknown as typeof fetch
  for (const provider of providers) {
    const connection = managedConnectionFromInput(
      await keyInput(provider, fixtureKey),
    )
    const [credential] = connection.credentials
    const models = await codebuddyNativeAdapter.discoverModels!({
      connection,
      credential,
    })
    expect(models.map(({ endpoints }) => endpoints)).toEqual([
      provider === "codebuddy-cn" ? ["messages"] : ["chat"],
      ["chat"],
    ])
  }
})

test("CN native Messages preserves system, effort and signed thinking while folding SSE", async () => {
  const connection = managedConnectionFromInput(
    await keyInput("codebuddy-cn", fixtureKey),
  )
  const model = "claude-opus-5.5"
  const payload: AnthropicMessagesPayload = {
    model,
    stream: false,
    max_tokens: 1024,
    system: "x-anthropic-billing-header: example",
    output_config: { effort: "max" },
    messages: [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "unsigned" },
          {
            type: "thinking",
            thinking: "signed",
            signature: "fixture-signature",
          },
          { type: "text", text: "previous answer" },
        ],
      },
      { role: "user", content: "next" },
    ],
  }
  const seen: Array<Headers> = []
  const sent = mock(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://copilot.tencent.com/v1/messages")
    const headers = new Headers(init.headers)
    seen.push(headers)
    expect(headers.get("x-api-key")).toBe(fixtureKey)
    const body = JSON.parse(String(init.body)) as AnthropicMessagesPayload
    expect(body).toMatchObject({
      stream: true,
      system: payload.system,
      output_config: { effort: "max" },
    })
    expect(body.messages[1].content).toEqual([
      { type: "thinking", thinking: "signed", signature: "fixture-signature" },
      { type: "text", text: "previous answer" },
    ])
    const events = [
      {
        type: "message_start",
        message: { id: "msg_1", model, usage: { input_tokens: 8 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  globalThis.fetch = sent as unknown as typeof fetch
  const [credential] = connection.credentials
  const result = await codebuddyNativeAdapter.createMessages!({
    target: { upstreamModelId: model } as RouteTarget,
    connection,
    credential,
    payload,
  })
  expect(result.response).toMatchObject({
    model,
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 8, output_tokens: 2 },
  })
  const streamed = await codebuddyNativeAdapter.createMessages!({
    target: { upstreamModelId: model } as RouteTarget,
    connection,
    credential,
    payload: {
      ...payload,
      stream: true,
      messages: [
        ...payload.messages,
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "test", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
          ],
        },
      ],
    },
  })
  expect(
    (
      await Array.fromAsync(
        streamed.response as AsyncIterable<{ event: string }>,
      )
    ).map(({ event }) => event),
  ).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ])
  expect(sent).toHaveBeenCalledTimes(2)
  expect(seen[0].get("x-conversation-id")).toBe(
    seen[1].get("x-conversation-id"),
  )
  expect(seen[0].get("x-conversation-request-id")).toBe(
    seen[1].get("x-conversation-request-id"),
  )
  expect(seen[0].get("x-request-id")).not.toBe(seen[1].get("x-request-id"))
})
