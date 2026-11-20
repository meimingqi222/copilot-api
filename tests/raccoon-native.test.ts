import { afterEach, expect, spyOn, test } from "bun:test"

import {
  managedConnectionFromInput,
  serializeConnectionForExport,
} from "~/lib/provider-connections"
import { buildRouteTargets } from "~/lib/route-target"
import { parseProviderCallbackInput } from "~/services/oauth/callback-input"
import { createOAuthConnection } from "~/services/oauth/strategy-types"
import { raccoonNativeAdapter } from "~/services/protocols/raccoon-native"
import {
  applyProviderAuthUpdate,
  prepareOAuthRefresh,
} from "~/services/providers/auth-update"
import {
  applyRaccoonTokens,
  raccoonCallback,
  renewRaccoonTokens,
  resolveRaccoonLogin,
  startRaccoonLogin,
} from "~/services/raccoon/auth"
import {
  discoverRaccoonModels,
  raccoonFallbackModels,
} from "~/services/raccoon/catalog"
import { fetchRaccoonQuota } from "~/services/raccoon/quota"

const jwt = (sub: string, exp = 2_000_000_000) =>
  `e30.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.signature`
const mocks: Array<{ mockRestore(): void }> = []
const fetchTarget: {
  fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
} = globalThis
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
})

function raccoonConnection() {
  const connection = createOAuthConnection("raccoon", "Raccoon fixture")
  applyRaccoonTokens(connection, { accessToken: jwt("seat-a") })
  connection.proxyUrl = "http://proxy.invalid:8080"
  connection.models = raccoonFallbackModels()
  return connection
}

test("Raccoon callback checks state before exchanging; token pair survives standard export/import", async () => {
  const start = startRaccoonLogin()
  expect(start.state).toMatch(/^[a-f\d]{64}$/)
  expect(new URL(start.authUrl).searchParams.get("redirect")).toBe(
    start.redirectUri,
  )
  const callback = parseProviderCallbackInput(
    `${start.redirectUri}?state=${start.state}&code=fixture`,
    raccoonCallback,
  )!
  expect(
    parseProviderCallbackInput(
      `${start.redirectUri}?state=${start.state}&code=a&code=b`,
      raccoonCallback,
    ),
  ).toBeUndefined()
  const token = jwt("seat-a")
  const fetch = spyOn(fetchTarget, "fetch").mockImplementation(
    async (url, init) => {
      expect(String(url)).toEndWith("/login_with_authorization_code")
      expect(JSON.parse(String(init?.body))).toEqual({
        authorization_code: "fixture",
      })
      return Response.json({
        code: 0,
        data: { access_token: token, refresh_token: "refresh-a" },
      })
    },
  )
  mocks.push(fetch)
  await expect(resolveRaccoonLogin(callback, "0".repeat(64))).rejects.toThrow(
    "complete Raccoon callback",
  )
  expect(fetch).not.toHaveBeenCalled()
  const connection = raccoonConnection()
  applyRaccoonTokens(
    connection,
    await resolveRaccoonLogin(callback, start.state),
  )
  const saved = serializeConnectionForExport(connection)
  const imported = managedConnectionFromInput({
    id: "restore",
    name: "Raccoon",
    provider: "raccoon",
    credentials: saved.credentials as Record<string, unknown>,
  })
  const restoredCredential = imported.credentials.at(0)
  expect(restoredCredential?.value).toBe(token)
  expect(restoredCredential?.context).toMatchObject({
    refreshToken: "refresh-a",
    oauthAccountId: "seat-a",
    expiresAt: 2_000_000_000_000,
  })
  const desktop = await resolveRaccoonLogin(
    JSON.stringify({
      source: "desktop",
      access_token: token,
      refresh_token: "desktop-secret",
    }),
    start.state,
  )
  expect(desktop.refreshToken).toBeUndefined()
})

test("Raccoon refresh won't replace the account with another seat's token", async () => {
  const conn = raccoonConnection()
  applyRaccoonTokens(conn, {
    accessToken: jwt("seat-a"),
    refreshToken: "refresh-a",
  })
  const run = prepareOAuthRefresh(renewRaccoonTokens)
  const fetch = spyOn(fetchTarget, "fetch").mockImplementation(async () =>
    Response.json({
      data: { access_token: jwt("seat-b"), refresh_token: "refresh-b" },
    }),
  )
  mocks.push(fetch)
  await expect(run(conn, "refresh-a", {})).rejects.toThrow("different account")
  expect(conn.credentials[0].value).toBe(jwt("seat-a"))
  fetch.mockImplementation(async () =>
    Response.json({ data: { access_token: jwt("seat-a", 2_000_000_001) } }),
  )
  const delta = await run(conn, "refresh-a", {})
  expect(conn.credentials[0].value).toBe(jwt("seat-a"))
  applyProviderAuthUpdate(conn, delta)
  expect(conn.credentials[0].context).toMatchObject({
    refreshToken: "refresh-a",
    expiresAt: 2_000_000_001_000,
  })
})

test("Raccoon native chat forwards bearer/proxy and rewrites JSON and SSE model names", async () => {
  const connection = raccoonConnection()
  const model = connection.models![0].upstreamId
  const target = buildRouteTargets({
    connections: [connection],
    publicModelId: model,
    endpoint: "chat",
  })[0]
  expect(target?.endpoint).toBe("chat")
  const fetch = spyOn(fetchTarget, "fetch").mockImplementation(
    async (url, init) => {
      expect(String(url)).toEndWith("/api/web/llm/v2/chat/completions")
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Bearer ${jwt("seat-a")}`,
      )
      expect((init as RequestInit & { proxy?: string }).proxy).toBe(
        connection.proxyUrl,
      )
      const body = JSON.parse(String(init?.body)) as {
        model: string
        stream?: boolean
      }
      expect(body.model).toBe(model)
      return body.stream ?
          new Response(
            'data: {"model":"internal","choices":[]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          )
        : Response.json({ model: "internal", choices: [] })
    },
  )
  mocks.push(fetch)
  const args = {
    target,
    connection,
    credential: connection.credentials[0],
    payload: { model, messages: [] },
  }
  expect(
    (await raccoonNativeAdapter.createChatCompletions!(args)).response,
  ).toMatchObject({ model })
  const { response } = await raccoonNativeAdapter.createChatCompletions!({
    ...args,
    payload: { ...args.payload, stream: true },
  })
  if (!(Symbol.asyncIterator in response))
    throw new Error("Expected chat stream")
  const frames = await Array.fromAsync(response)
  expect(frames.map((frame) => frame.data)).toEqual([
    JSON.stringify({ model, choices: [] }),
    "[DONE]",
  ])
})

test("Raccoon catalog capability and daily allowance preserve vendor expiry without side effects", async () => {
  const connection = raccoonConnection()
  const expiry = "2099-11-23T00:00:00Z"
  const fetch = spyOn(fetchTarget, "fetch").mockImplementation(
    async (input, init) => {
      const url = new URL(String(input))
      expect(init?.method ?? "GET").toBe("GET")
      if (url.pathname.endsWith("model_catalog"))
        return Response.json({
          data: {
            categories: [
              {
                models: [
                  {
                    name: "live",
                    tags: ["vision"],
                    context_window: 200_000,
                    max_tokens: 12_000,
                    billing_multiplier: 0.5,
                    billing_effective_multiplier: 0,
                  },
                ],
              },
            ],
          },
        })
      if (url.pathname.endsWith("/balance"))
        return Response.json({
          data: { available_points: 2500, daily_points: 200 },
        })
      if (url.pathname.endsWith("/bills"))
        return Response.json({
          data: {
            items: [
              { points: 300, expire_at: expiry, biz_type: "daily_grant" },
            ],
          },
        })
      if (url.pathname.endsWith("/entitlement_info"))
        return Response.json({ data: { office: { pro_enable: true } } })
      if (url.pathname.endsWith("/user_info"))
        return Response.json({ data: { phone: "+86 00012345678" } })
      throw new Error(`Unexpected route ${url.pathname}`)
    },
  )
  mocks.push(fetch)
  const models = await discoverRaccoonModels(connection)
  expect(models[0]).toMatchObject({
    upstreamId: "live",
    endpoints: ["chat"],
    metadata: {
      supportsImages: true,
      outputLimit: 12000,
      creditMultiplier: 0,
      free: true,
    },
  })
  const snapshot = await fetchRaccoonQuota(connection)
  expect(snapshot?.details).toMatchObject({ plan: "Pro", user: "000****5678" })
  const windows = snapshot!.allowance.windows
  expect(windows[0]).toMatchObject({
    id: "daily-pool",
    total: 2100,
    remaining: 200,
    expiresAtMs: Date.parse(expiry),
  })
  expect(windows[0].resetsAtMs).toBeUndefined()
  expect(windows[1]).toMatchObject({
    id: "credits",
    remaining: 2500,
    aside: true,
  })
  fetch.mockImplementation(async () => new Response(null, { status: 403 }))
  fetch.mockClear()
  await expect(fetchRaccoonQuota(connection)).rejects.toThrow("403")
  expect(fetch).toHaveBeenCalledTimes(1)
})
