import { afterEach, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"

import {
  managedConnectionFromInput,
  removeProviderConnection,
  serializeConnectionForExport,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import {
  buildRouteTargets,
  routeEvidenceFor,
  selectRouteTarget,
} from "~/lib/route-target"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { AdapterParams } from "~/services/protocols/types"
import { wpsLingxiNativeAdapter } from "~/services/protocols/wps-lingxi-native"
import { getWpsLingxiModule } from "~/services/providers/modules/wps-lingxi"
import {
  cookieInput,
  WPS_ORIGINS,
  WPS_PATHS,
} from "~/services/wps-lingxi/client"
import * as web from "~/services/wps-lingxi/cowork-web"

// Wire fixtures adapted from the Magpie plugin's cookie-login, quota, models,
// agent and audit tests at 2a290226ecd575531563dac4a5308428918769ca.
const SID = "fixture-cookie-not-real-=="
const ORIGIN = WPS_ORIGINS[1]
const PROXY = "http://proxy.invalid:9080"
const nativeChat = wpsLingxiNativeAdapter.createChatCompletions!
const provider = getWpsLingxiModule()
const model = "GLM-5.3"

const originalFetch = globalThis.fetch
type FetchInit = RequestInit & { proxy?: unknown }
type MockRoute = (url: URL, init: FetchInit) => Response
function fakeHTTP(route: MockRoute) {
  const calls: Array<{ url: URL; init: FetchInit }> = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init: FetchInit = {}) => {
      const url = new URL(String(input))
      calls.push({ url, init })
      return route(url, init)
    },
    { preconnect: originalFetch.preconnect },
  )
  return calls
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

function params(
  overrides: Partial<ChatCompletionsPayload> = {},
): AdapterParams<ChatCompletionsPayload> {
  const connection = managedConnectionFromInput({
    id: randomUUID(),
    name: "WPS fixture",
    provider: "wps-lingxi",
    credentials: {
      cookie: `wps_sid=${SID}; uid=123; copilot_server_branch=beta`,
      origin: ORIGIN,
    },
    settings: { proxyUrl: PROXY },
  })
  connection.baseUrl = "https://untrusted.invalid/path"
  connection.headers = { Cookie: "not-the-selected-cookie" }
  const [credential] = connection.credentials
  return {
    connection,
    credential,
    target: {
      protocol: connection.protocol,
      connectionId: connection.id,
      connectionName: connection.name,
      credentialId: credential.id,
      publicModelId: "friendly-alias",
      upstreamModelId: model,
      endpoint: "chat",
      connectionPriority: 0,
      connectionWeight: 1,
      credentialPriority: 0,
      credentialWeight: 1,
    },
    payload: {
      model: "friendly-alias",
      stream: false,
      messages: [{ role: "user", content: "北京 weather" }],
      ...overrides,
    },
  }
}

function sse(...frames: Array<unknown>): Response {
  return new Response(
    frames.map((frame) => `data:${JSON.stringify(frame)}\r\n\r\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function agent(chat: MockRoute): MockRoute {
  let sessions = 0
  let runs = 0
  return (url, init) => {
    if (url.pathname === WPS_PATHS.session)
      return Response.json({ data: { session_id: `s${++sessions}` } })
    if (url.pathname === WPS_PATHS.run)
      return Response.json({ data: { run_id: `r${++runs}` } })
    if (url.pathname === WPS_PATHS.chat) return chat(url, init)
    throw new Error(`Unexpected mock path ${url.pathname}`)
  }
}

const finished = () =>
  sse({ code: "Success", choices: [{ text: "ok", finish_reason: "stop" }] })

test("pasted sign-in probes only official profile URLs and exports the verified origin", async () => {
  const calls = fakeHTTP((url) => {
    expect(url.pathname).toBe(WPS_PATHS.profile)
    return url.origin === ORIGIN ?
        Response.json({ result: "ok", data: { name: "Example", id: 123 } })
      : Response.json({ result: "UserUnauthorized" })
  })
  expect(cookieInput(SID)).toBe(`wps_sid=${SID}`)
  expect(cookieInput("uid=123; other_token=never-forward")).toBeUndefined()
  expect(
    cookieInput(`wps_sid=${SID}\r\nHost: untrusted.invalid`),
  ).toBeUndefined()
  const result = await provider.accountCreation!.prepare({
    body: {
      credentials: {
        cookie: `Cookie: unrelated=no; wps_sid=${SID}; uid=123; copilot_server_branch=beta`,
      },
      settings: { proxyUrl: PROXY },
    },
    label: "fallback",
    registerDeviceFlow: () => {
      throw new Error("Not a device flow")
    },
  })
  if (!("id" in result)) throw new Error(JSON.stringify(result))
  expect(result.name).toBe("Example")
  expect(calls.map(({ url }) => url.origin)).toEqual([...WPS_ORIGINS])
  for (const { init } of calls) {
    expect(init.method).toBe("GET")
    expect(init.redirect).toBe("manual")
    expect(init.proxy).toBe(PROXY)
    const cookie = new Headers(init.headers).get("cookie")
    expect(cookie).toContain(
      `wps_sid=${SID}; uid=123; copilot_server_branch=beta;`,
    )
    expect(cookie).not.toContain("unrelated")
  }
  const connection = managedConnectionFromInput(result)
  const exported = serializeConnectionForExport(connection)
  expect(exported.credentials).toEqual({
    cookie: `wps_sid=${SID}; uid=123; copilot_server_branch=beta`,
    origin: ORIGIN,
  })
})

test("models and quota only read the pinned origin; bonus credits never become reset windows", async () => {
  const { connection } = params()
  const expiry = new Date(Date.now() + 86_400_000).toISOString()
  let balance: number | undefined = 0.125
  const calls = fakeHTTP((url, init) => {
    expect(url.origin).toBe(ORIGIN)
    expect(init.method).toBe("GET")
    expect(init.proxy).toBe(PROXY)
    if (url.pathname === WPS_PATHS.models)
      return Response.json({
        data: {
          models: [
            { key: "auto" },
            { key: "plan_max" },
            {
              key: model,
              name: "GLM",
              reasoning_efforts: ["low", "max"],
              max_context_tokens: 131072,
              multiplier: "0.50x",
            },
          ],
          plans: [{ key: "not-a-model" }],
        },
      })
    expect(url.pathname).toBe(WPS_PATHS.balance)
    return Response.json({
      data: {
        total_balance: balance,
        bonus_summary: { total_value: 300, total_consumed: 10 },
        bonus_credits: [
          { balance: 0.125, expire_time: expiry },
          { balance: 10, expire_time: "2020-01-01 00:00:01" },
        ],
      },
    })
  })
  expect(
    await provider.createRuntime().refreshModels(connection),
  ).toMatchObject([
    {
      upstreamId: model,
      efforts: ["low", "max"],
      endpoints: ["chat"],
      metadata: { context: 131072, creditMultiplier: 0.5 },
    },
  ])
  expect(await provider.fetchQuota!(connection)).toMatchObject({
    allowance: {
      state: "known",
      windows: [
        { id: "credits", remaining: 0.125, unit: "credits" },
        { aside: true, expiresAtMs: Date.parse(expiry), remaining: 0.125 },
      ],
    },
  })
  balance = undefined
  expect((await provider.fetchQuota!(connection))?.allowance.state).toBe(
    "unknown",
  )
  expect(calls).toHaveLength(3)
})

test("an imported nonofficial origin never receives a request, and redirects are not followed", async () => {
  const args = params()
  const calls = fakeHTTP(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.invalid/" },
      }),
  )
  args.credential.context!.origin = "https://lingxi.wps.cn.untrusted.invalid"
  await expect(nativeChat(args)).rejects.toMatchObject({
    reason: "sign_in_required",
  })
  expect(calls).toHaveLength(0)
  args.credential.context!.origin = ORIGIN
  await expect(nativeChat(args)).rejects.toMatchObject({
    response: { status: 502 },
  })
  expect(calls).toHaveLength(1)
  expect(calls[0].init.redirect).toBe("manual")
})

test("read-only wallet balance controls admission without treating bonus expiry as a refill", async () => {
  const { connection, credential } = params()
  connection.models = [
    { publicId: model, upstreamId: model, endpoints: ["chat"], enabled: true },
  ]
  let remaining = 0.01
  fakeHTTP((url) => {
    expect(url.pathname).toBe(WPS_PATHS.balance)
    return Response.json({ data: { total_balance: remaining } })
  })
  upsertProviderConnection(connection)
  try {
    const runtime = provider.createRuntime()
    await runtime.refreshQuota!(connection, undefined, { skipSave: true })
    const targets = () =>
      buildRouteTargets({
        connections: [connection],
        publicModelId: model,
        endpoint: "chat",
      })
    expect(selectRouteTarget(targets())?.connectionId).toBe(connection.id)
    expect(
      routeEvidenceFor(connection.id, credential.id, model).quota?.usedFraction,
    ).toBeUndefined()
    remaining = 0
    await runtime.refreshQuota!(connection, undefined, { skipSave: true })
    expect(targets()).toEqual([])
  } finally {
    removeProviderConnection(connection.id)
  }
})

test("native streaming forwards call deltas, while JSON folds tool args, reasoning and usage", async () => {
  const tools: ChatCompletionsPayload["tools"] = [
    {
      type: "function",
      function: {
        name: "weather",
        parameters: {
          $defs: {
            City: {
              anyOf: [{ type: "null" }, { type: "string", const: "北京" }],
            },
          },
          properties: { city: { $ref: "#/$defs/City" } },
        },
      },
    },
  ]
  const calls = fakeHTTP(
    agent((_url, init) => {
      const headers = new Headers(init.headers)
      expect(headers.get("x-cc-session-id")).toMatch(/^s\d+$/)
      expect(headers.get("x-cc-run-id")).toMatch(/^r\d+$/)
      expect(headers.get("x-cc-region")).toBe("beta")
      expect(headers.get("cookie")).toContain(`wps_sid=${SID}`)
      expect(JSON.parse(String(init.body))).toMatchObject({
        model,
        stream: true,
        base_llm_arguments: { max_tokens: 50 },
        llm_arguments: { reasoning_effort: "high" },
        tool_choice: "required",
        tools: [
          {
            function: {
              name: "weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string", enum: ["北京"] } },
              },
            },
          },
        ],
      })
      return sse(
        {
          code: "Success",
          choices: [
            {
              reasoning_content: "想",
              tool_calls: [
                {
                  index: 0,
                  id: "call_weather",
                  function: { name: "weather", arguments: '{"city":' },
                },
              ],
            },
          ],
        },
        {
          code: "Success",
          choices: [
            {
              text: "答",
              finish_reason: "tool_calls",
              tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }],
            },
          ],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            cached_tokens: 25,
            total_tokens: 31,
            reasoning_tokens: 1,
          },
        },
      )
    }),
  )
  const args = params({
    tools,
    tool_choice: "required",
    reasoning_effort: "high",
    max_tokens: 50,
  })
  const json = await nativeChat(args)
  expect(json.response).toMatchObject({
    model,
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          reasoning_content: "想",
          content: "答",
          tool_calls: [
            {
              id: "call_weather",
              function: { name: "weather", arguments: '{"city":"北京"}' },
            },
          ],
        },
      },
    ],
    usage: {
      total_tokens: 6,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  })
  args.payload.stream = true
  const { response } = await nativeChat(args)
  if (!(Symbol.asyncIterator in response))
    throw new Error("Expected SSE events")
  const events = await Array.fromAsync(response)
  expect(events.at(-1)?.data).toBe("[DONE]")
  expect(JSON.parse(events[0].data!)).toMatchObject({
    choices: [
      {
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_weather" }],
        },
      },
    ],
  })
  expect(calls.map(({ url }) => url.pathname)).toEqual([
    WPS_PATHS.session,
    WPS_PATHS.run,
    WPS_PATHS.chat,
    WPS_PATHS.session,
    WPS_PATHS.run,
    WPS_PATHS.chat,
  ])
  expect(
    calls.every(
      ({ url, init }) =>
        url.origin === ORIGIN && init.method === "POST" && init.proxy === PROXY,
    ),
  ).toBe(true)
})

test("stable threads reuse runs only inside their request scope, rebuilding a stale run once", async () => {
  const ids: Array<string | null> = []
  fakeHTTP(
    agent((_url, init) => {
      ids.push(new Headers(init.headers).get("x-cc-run-id"))
      return ids.length === 2 ?
          Response.json({ message: "会话不存在" }, { status: 400 })
        : finished()
    }),
  )
  const args = params()
  args.ctx = { transcriptScopeId: "tenant-a", executionSessionId: "thread-1" }
  await nativeChat(args)
  await nativeChat(args)
  await nativeChat(args)
  args.ctx = { ...args.ctx, transcriptScopeId: "tenant-b" }
  await nativeChat(args)
  expect(ids).toEqual(["r1", "r1", "r2", "r2", "r3"])
})

test("audit and truncated SSE are not successful completions or replay triggers", async () => {
  const calls = fakeHTTP(
    agent(() => sse({ code: "AuditFailed", message: `会话不存在 ${SID}` })),
  )
  await expect(nativeChat(params())).rejects.toMatchObject({
    reason: "audit_blocked",
    response: { status: 400 },
  })
  expect(calls).toHaveLength(3)
  fakeHTTP(agent(() => sse({ choices: [{ text: "partial" }] })))
  await expect(nativeChat(params())).rejects.toMatchObject({
    reason: "truncated_stream",
  })
})

test("only text can use the PermissionDenied cowork fallback", async () => {
  fakeHTTP(
    agent(() => Response.json({ code: "PermissionDenied" }, { status: 403 })),
  )
  const fallback = spyOn(web, "coworkWebStream").mockImplementation(
    async () => finished().body!,
  )
  try {
    expect((await nativeChat(params())).response).toMatchObject({
      choices: [{ message: { content: "ok" } }],
    })
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback.mock.calls[0][0]).toMatchObject({
      prompt: "user: 北京 weather",
      model,
      proxyUrl: PROXY,
    })
    await expect(
      nativeChat(
        params({
          tools: [
            { type: "function", function: { name: "weather", parameters: {} } },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      reason: "PermissionDenied",
      response: { status: 403 },
    })
    expect(fallback).toHaveBeenCalledTimes(1)
  } finally {
    fallback.mockRestore()
  }
})
