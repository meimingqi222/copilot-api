import { afterEach, expect, test } from "bun:test"
import { asRecord } from "~/lib/json-shape"
import {
  managedConnectionFromInput,
  serializeConnectionForExport,
} from "~/lib/provider-connections"
import { parseProviderCallbackInput } from "~/services/oauth/callback-input"
import { buildDirectAdapterTarget } from "~/services/providers/adapter-target"
import { applyProviderAuthUpdate } from "~/services/providers/auth-update"
import { getMeooModule } from "~/services/providers/modules/meoo"

const realFetch = globalThis.fetch
const key = "meoo_project_service_v1.fixture"
afterEach(() => {
  globalThis.fetch = realFetch
})

function mockFetch(
  respond: (
    url: URL,
    init: RequestInit & { proxy?: string },
  ) => Response | Promise<Response>,
) {
  globalThis.fetch = Object.assign(
    (url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(respond(new URL(String(url)), init ?? {})),
    { preconnect: realFetch.preconnect },
  )
}

test("Meoo PKCE requires matching state, only reads an existing project, and survives export/import", async () => {
  const module = getMeooModule()
  const strategy = module.oauth!
  const started = await strategy.start({})
  const url = new URL(started.authUrl!)
  expect(url.origin).toBe("https://meoo.com")
  expect(url.searchParams.get("scope")).toBe("cli.compat")
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  const flow = {
    ...started,
    id: "meoo-fixture",
    label: "fixture",
    provider: "meoo" as const,
    status: "pending" as const,
    expiresAt: Date.now() + 10000,
    proxyUrl: "http://proxy.example.invalid:8080",
  }
  const callback = parseProviderCallbackInput(
    `${started.redirectUri}?state=${started.state}&code=fixture-auth`,
    module.callback!,
  )
  expect(callback).toEndWith("\0fixture-auth")
  expect(
    parseProviderCallbackInput(
      `state=${started.state}&code=x&code=y`,
      module.callback!,
    ),
  ).toBeUndefined()
  let writes = 0
  mockFetch((request, init) => {
    expect(request.origin).toBe("https://meoo.com")
    expect(init.proxy).toBe(flow.proxyUrl)
    expect(init.redirect).toBe("manual")
    if (request.pathname === "/oauth/token") {
      writes++
      expect(init.method).toBe("POST")
      const form = new URLSearchParams(String(init.body))
      expect(form.get("code_verifier")).toBe(started.pkce!.codeVerifier)
      expect(form.get("redirect_uri")).toBe(started.redirectUri!)
      return Response.json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
        scope: "cli.compat",
      })
    }
    expect(init.method ?? "GET").toBe("GET")
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer fixture-access",
    )
    if (request.pathname.endsWith("/identity"))
      return Response.json({
        data: { user_id: "user", project_url_id: "project" },
      })
    expect(request.pathname).toEndWith("/project/cloud/environment")
    return Response.json({ data: { instance: { meooProjectApiKey: key } } })
  })
  await expect(
    strategy.exchange({ flow, code: "wrong\0fixture-auth" }),
  ).rejects.toThrow("did not match")
  const connection = await strategy.exchange({ flow, code: callback })
  expect(writes).toBe(1)
  const exported = serializeConnectionForExport(connection)
  const restored = managedConnectionFromInput({
    id: "restored",
    name: "restored",
    provider: "meoo",
    credentials: asRecord(exported.credentials),
    settings: asRecord(exported.settings),
  })
  expect(restored.credentials[0].context).toMatchObject({
    refreshToken: "fixture-refresh",
    scope: "cli.compat",
    oauthAccountId: "user:project",
    serviceAk: key,
    projectUrlId: "project",
  })
  expect(restored.credentials[0].value).toBe("fixture-access")
})

test("Meoo refresh rotates only authentication fields and ignores an old refusal after reauthentication", async () => {
  const refresh = getMeooModule().refreshAuth!
  const connection = managedConnectionFromInput({
    id: "meoo-refresh",
    name: "fixture",
    provider: "meoo",
    credentials: {
      accessToken: "fixture-access",
      refreshToken: "fixture-old",
      serviceAk: key,
    },
  })
  const credential = connection.credentials[0]
  mockFetch((url, init) => {
    expect(url.href).toBe("https://meoo.com/oauth/token")
    expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe(
      "fixture-old",
    )
    return Response.json({
      access_token: "fixture-new",
      refresh_token: "fixture-new-refresh",
    })
  })
  const patch = await refresh(connection, "fixture-old", {})
  expect(credential.value).toBe("fixture-access")
  connection.name = "renamed concurrently"
  applyProviderAuthUpdate(connection, patch)
  expect(connection.name).toBe("renamed concurrently")
  expect(credential.value).toBe("fixture-new")
  expect(credential.context).toMatchObject({
    refreshToken: "fixture-new-refresh",
    serviceAk: key,
  })
  const refused = Promise.withResolvers<Response>()
  mockFetch(() => refused.promise)
  const stale = refresh(connection, "fixture-new-refresh", {})
  credential.value = "fixture-reauthorized"
  credential.context = {
    serviceAk: key,
    refreshToken: "fixture-reauthorized-refresh",
  }
  refused.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }))
  await expect(stale).rejects.toThrow("credentials changed")
  expect(credential.value).toBe("fixture-reauthorized")
})

test("Meoo verifies project AKs against the live catalog and sends AK, not OAuth, on chat", async () => {
  const module = getMeooModule()
  const prepare = module.accountCreation!.prepare
  expect(
    await prepare({
      label: "key",
      body: { apiKey: "meoo_ak_fixture" },
      registerDeviceFlow() {},
    }),
  ).toHaveProperty("error")
  const calls: Array<string> = []
  mockFetch((url, init) => {
    expect(url.origin).toBe("https://api.meoo.host")
    expect(init.redirect).toBe("manual")
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`)
    calls.push(url.pathname)
    if (url.pathname.endsWith("/models"))
      return Response.json({
        data: [{ id: "qwen3.8-flash" }, "new-model", "new-model"],
      })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: "new-model",
      reasoning_effort: "medium",
    })
    return body.stream ?
        new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      : Response.json({
          choices: [{ message: { reasoning_content: "reason" } }],
        })
  })
  const result = await prepare({
    label: "key",
    body: { apiKey: key },
    registerDeviceFlow() {},
  })
  if (!("id" in result)) throw new Error(JSON.stringify(result))
  const connection = managedConnectionFromInput(result)
  const models = await module.discoverModels!(connection)
  expect(models.map((model) => model.upstreamId)).toEqual([
    "qwen3.8-flash",
    "new-model",
  ])
  expect(models[0].metadata).toMatchObject({
    contextWindow: 1_000_000,
    multimodal: true,
  })
  expect(models[1].metadata).toMatchObject({
    contextWindow: 200_000,
    multimodal: false,
  })
  expect((await module.fetchQuota!(connection))?.allowance.state).toBe(
    "unsupported",
  )
  const credential = connection.credentials[0]
  credential.value = "fixture-access-not-for-gateway"
  credential.context = { serviceAk: key }
  connection.baseUrl = "https://example.invalid"
  const target = buildDirectAdapterTarget({
    connection,
    credential,
    endpoint: "chat",
    payloadModel: "alias",
    nativeModelId: "new-model",
  })
  const base = {
    connection,
    credential,
    target,
    payload: {
      model: "alias",
      messages: [],
      reasoning_effort: "medium" as const,
    },
  }
  const create = module.adapter.createChatCompletions!
  expect((await create(base)).response).toMatchObject({
    choices: [{ message: { reasoning_content: "reason" } }],
  })
  const { response } = await create({
    ...base,
    payload: { ...base.payload, stream: true },
  })
  if (!(Symbol.asyncIterator in response))
    throw new Error("Missing SSE response")
  const events = []
  for await (const event of response) events.push(event.data)
  expect(events).toEqual([
    '{"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}',
    "[DONE]",
  ])
  expect(calls.length).toBe(4)
})

test("Meoo OAuth quota only GETs wallet and entitlement; missing balance is not exhausted", async () => {
  const connection = managedConnectionFromInput({
    id: "meoo-quota",
    name: "fixture",
    provider: "meoo",
    credentials: { accessToken: "fixture-control", serviceAk: key },
  })
  let includeBalance = true
  mockFetch((url, init) => {
    expect(url.origin).toBe("https://meoo.com")
    expect(init.method ?? "GET").toBe("GET")
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer fixture-control",
    )
    if (url.pathname.endsWith("/entitlement"))
      return Response.json({
        data: { benefits: [{ typeCode: "daily_login", quota: 2000 }] },
      })
    expect(url.pathname).toEndWith("/account/points")
    return Response.json({
      data: {
        account: {
          ...(includeBalance ? { availableBalance: "0.25" } : {}),
          totalConsumed: 12,
        },
        activeGrants: [
          { grantDetails: [{ remainingAmount: 1, expiresDate: "2030-02-03" }] },
        ],
      },
    })
  })
  const read = getMeooModule().fetchQuota!
  const snapshot = await read(connection)
  expect(snapshot?.allowance.windows).toEqual([
    {
      id: "points",
      unit: "credits",
      remaining: 0.25,
    },
  ])
  expect(snapshot?.details).toMatchObject({
    nextGrantExpiryMs: Date.parse("2030-02-03"),
    pointsUsed: 12,
    dailyLoginPoints: 2000,
  })
  includeBalance = false
  expect((await read(connection))?.allowance).toEqual({
    state: "unknown",
    windows: [],
  })
})
