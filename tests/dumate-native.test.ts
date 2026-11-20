import { afterEach, expect, test } from "bun:test"
import { createCipheriv, randomBytes } from "node:crypto"
import { asRecord } from "~/lib/json-shape"
import {
  managedConnectionFromInput,
  serializeConnectionForExport,
} from "~/lib/provider-connections"
import { buildDirectAdapterTarget } from "~/services/providers/adapter-target"
import { getDuMateModule } from "~/services/providers/modules/dumate"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function mockFetch(
  respond: (url: string, init: RequestInit & { proxy?: string }) => Response,
) {
  globalThis.fetch = Object.assign(
    (url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(respond(String(url), init ?? {})),
    { preconnect: realFetch.preconnect },
  )
}

function duMateResponse(result: Record<string, unknown>) {
  return Response.json({ code: 0, result })
}

function desktopFixture() {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify([
        {
          name: "bce-sessionid",
          value: "fixture-desktop",
          domain: ".bce.baidu.com",
        },
        {
          name: "unrelated",
          value: "not-for-the-console",
          domain: ".example.com",
        },
      ]),
    ),
    cipher.final(),
  ])
  return {
    desktopCookieKeyBase64: key.toString("base64"),
    desktopAuth: {
      cookies: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
        "base64",
      ),
    },
    desktopModelConfig: {
      provider: {
        QianfanPersonalQuota: {
          baseURL: "https://example.invalid",
          apiKey: "not-imported",
          models: {
            "deepseek-v41-flash": {
              limit: { context: 1_000_000, output: 384_000 },
              modalities: { input: ["text", "image"] },
            },
            "model-task-router": { limit: { context: 1000, output: 100 } },
          },
        },
      },
    },
  }
}

test("DuMate desktop sign-in is an explicit import and only persists console cookies and chat model metadata", async () => {
  const checked: Array<string> = []
  mockFetch((url, init) => {
    expect(new URL(url).origin).toBe("https://console.bce.baidu.com")
    expect(new Headers(init.headers).get("cookie")).toBe(
      "bce-sessionid=fixture-desktop",
    )
    expect(init.redirect).toBe("manual")
    checked.push(new URL(url).pathname)
    return duMateResponse(
      url.endsWith("/token/get") ? { token: "fixture-gateway" } : {},
    )
  })
  const module = getDuMateModule()
  const result = await module.accountCreation!.prepare({
    label: "fixture",
    body: { credentials: desktopFixture() },
    registerDeviceFlow() {},
  })
  if (!("id" in result)) throw new Error(JSON.stringify(result))
  const conn = managedConnectionFromInput(result)
  const exported = serializeConnectionForExport(conn)
  const reimported = managedConnectionFromInput({
    ...result,
    credentials: asRecord(exported.credentials),
  })
  const models = await module.discoverModels!(reimported)
  expect(reimported.credentials[0].value).toBe("bce-sessionid=fixture-desktop")
  expect(JSON.stringify(exported)).not.toContain("not-imported")
  expect(JSON.stringify(exported)).not.toContain("fixture-gateway")
  expect(checked).toEqual([
    "/api/dumate/user/info",
    "/api/dumate/app/token/get",
  ])
  expect(
    models.find((model) => model.publicId === "deepseek-v41-flash"),
  ).toMatchObject({
    endpoints: ["chat"],
    metadata: { multimodal: true, contextWindow: 1_000_000 },
  })
  expect(models.some((model) => model.publicId === "model-task-router")).toBe(
    false,
  )
})

test("DuMate coalesces token minting, remints once on 401, and preserves thinking, tools, and SSE", async () => {
  const cookie = "bce-sessionid=fixture-parallel"
  let mints = 0
  const bodies: Array<unknown> = []
  mockFetch((url, init) => {
    expect(init.redirect).toBe("manual")
    expect(init.proxy).toBe("http://proxy.example.invalid:8080")
    const headers = new Headers(init.headers)
    if (url.endsWith("/app/token/get")) {
      expect(headers.get("cookie")).toBe(cookie)
      return duMateResponse({ token: `fixture-token-${++mints}` })
    }
    expect(url).toBe(
      "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions",
    )
    expect(headers.has("cookie")).toBe(false)
    const body = JSON.parse(String(init.body)) as { stream: boolean }
    bodies.push(body)
    if (headers.get("authorization") === "Bearer fixture-token-1")
      return new Response(null, { status: 401 })
    expect(headers.get("authorization")).toBe("Bearer fixture-token-2")
    return body.stream ?
        new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      : Response.json({
          choices: [{ message: { tool_calls: [{ id: "tool_1" }] } }],
        })
  })
  const connection = managedConnectionFromInput({
    id: "du-chat",
    name: "DuMate",
    provider: "dumate",
    credentials: { cookie },
    settings: {
      proxyUrl: "http://proxy.example.invalid:8080",
      baseUrl: "https://example.invalid",
    },
  })
  const credential = connection.credentials[0]
  const target = buildDirectAdapterTarget({
    connection,
    credential,
    endpoint: "chat",
    payloadModel: "alias",
    nativeModelId: "deepseek-v41-flash",
  })
  const create = getDuMateModule().adapter.createChatCompletions!
  const base = { connection, credential, target }
  const [once, stream] = await Promise.all([
    create({
      ...base,
      payload: { model: "alias", messages: [], reasoning_effort: "none" },
    }),
    create({
      ...base,
      payload: {
        model: "alias",
        messages: [],
        stream: true,
        reasoning_effort: "low",
      },
    }),
  ])
  expect(mints).toBe(2)
  expect(bodies).toContainEqual({
    model: "deepseek-v41-flash",
    messages: [],
    thinking: { type: "disabled" },
    enable_thinking: false,
  })
  expect(bodies).toContainEqual({
    model: "deepseek-v41-flash",
    messages: [],
    stream: true,
    reasoning_effort: "high",
    thinking: { type: "enabled" },
    enable_thinking: true,
  })
  expect(once.response).toMatchObject({
    choices: [{ message: { tool_calls: [{ id: "tool_1" }] } }],
  })
  const response = stream.response
  if (!(Symbol.asyncIterator in response))
    throw new Error("Missing SSE response")
  const events = []
  for await (const event of response) events.push(event.data)
  expect(events).toEqual([
    '{"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
    "[DONE]",
  ])
})

test("DuMate quota uses read-only paths, preserves fractional credits, and does not count expiry as reset", async () => {
  mockFetch((url, init) => {
    expect(init.method ?? "GET").toBe("GET")
    if (url.endsWith("/loginBonusInfo"))
      return duMateResponse({ totalTimes: 5 })
    expect(new URL(url).searchParams.get("ignoreLoginBonus")).toBe("true")
    return duMateResponse({
      totalPoints: "45.25",
      usedPoints: "42.00",
      subscription: [{ status: "active", expireDate: "1900000000" }],
    })
  })
  const connection = managedConnectionFromInput({
    id: "du-quota",
    name: "DuMate",
    provider: "dumate",
    credentials: { cookie: "bce-sessionid=fixture-quota" },
  })
  const quota = await getDuMateModule().fetchQuota!(connection)
  expect(quota?.allowance).toEqual({
    state: "known",
    windows: [
      {
        id: "points",
        unit: "credits",
        total: 45.25,
        remaining: 3.25,
      },
    ],
  })
  expect(quota?.details).toMatchObject({
    loginBonusDays: 5,
    nextPackExpiryMs: 1_900_000_000_000,
  })
})
