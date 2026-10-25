import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import {
  __resetProviderConnectionsForTest,
  connectionHasCredentials,
  getConnectionProxyUrl,
  listAccountManagedConnections,
  managedConnectionFromInput,
  removeProviderConnection,
  serializeConnectionForExport,
  upsertProviderConnection,
  type AccountModel,
} from "~/lib/provider-connections"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { AIStudioClient } from "~/services/aistudio/client"
import { setWaaSettleMsForTest } from "~/services/aistudio/waa"
import { decodeAIStudioModels } from "~/services/aistudio/models"
import { getAIStudioModule } from "~/services/providers/modules/aistudio"
import { server } from "~/server"
import {
  adminRequest,
  setupAdminAuth,
  clearAdminAuth,
} from "./admin-test-utils"

const originalFetch = globalThis.fetch
const cookie = "SAPISID=one; __Secure-1PAPISID=two; __Secure-3PAPISID=three"
const interpreter = `globalThis.fixture = { a(program, ready) {
  ready((done, input) => {
    const names = Object.getOwnPropertyNames(Array.prototype);
    const matchesFirefox = names.indexOf('copyWithin') === 24 && names.indexOf('findLast') === 33;
    done(matchesFirefox ? 'proof:' + input[0].content : 'invalid-fingerprint');
  }, () => {});
} }`

beforeEach(() => {
  __resetProviderConnectionsForTest()
  resetProtectedRouteGuardForTest()
  resetAdaptiveRateLimiterForTest()
  // The fixture guard program is ready at once; skip the production settle.
  setWaaSettleMsForTest(0)
})
afterEach(() => {
  setWaaSettleMsForTest(3000)
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
  clearAdminAuth()
})

test("AI Studio account creation requires complete cookies and preserves Gemini models on export/import", async () => {
  const prepare = getAIStudioModule().accountCreation!.prepare
  const context = {
    label: "test",
    registerDeviceFlow() {
      throw new Error("Unexpected device flow")
    },
  }
  expect(
    await prepare({
      ...context,
      body: { credentials: { cookie: "SAPISID=incomplete" } },
    }),
  ).toHaveProperty("error")
  const prepared = await prepare({
    ...context,
    body: {
      credentials: { cookie: `Cookie: ${cookie};` },
      settings: { proxyUrl: "http://proxy.test:8080" },
    },
  })
  if (!("provider" in prepared)) throw new Error("Account preparation failed")
  const connection = managedConnectionFromInput({
    ...prepared,
    availableModels: [
      {
        id: "gemini-test",
        name: "Test",
        vendor: "Google",
        pickerEnabled: true,
        supportedEndpoints: ["gemini"],
      },
    ],
  })
  expect(connectionHasCredentials(connection)).toBe(true)
  const exported = serializeConnectionForExport(connection)
  expect(exported.credentials).toEqual({ cookie })
  const imported = managedConnectionFromInput({
    ...prepared,
    availableModels: exported.availableModels as AccountModel[],
    credentials: exported.credentials as Record<string, unknown>,
  })
  expect(imported.credentials[0].value).toBe(cookie)
  expect(imported.models?.[0].endpoints).toEqual(["gemini"])
  expect(getConnectionProxyUrl(imported)).toBe("http://proxy.test:8080")
  globalThis.fetch = (async (url) =>
    String(url).startsWith("https://aistudio.google.com/") ?
      new Response('"WIu0Nc":"public-fixture-key"')
    : String(url).endsWith("GetAiStudioBenefitTier") ? Response.json([0])
    : Response.json([[]])) as typeof fetch
  setupAdminAuth()
  const response = await server.fetch(
    adminRequest("http://localhost/admin/api/accounts/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accounts: [exported] }),
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ imported: 1, failed: 0 })
  const restored = listAccountManagedConnections()[0]
  expect(restored.credentials[0].value).toBe(cookie)
  expect(getConnectionProxyUrl(restored)).toBe("http://proxy.test:8080")
})

test("discovery retains paid and unsupported models with access metadata through the connection proxy", async () => {
  const connection = managedConnectionFromInput({
    id: "test",
    name: "test",
    provider: "aistudio",
    credentials: { cookie },
    settings: { proxyUrl: "http://proxy.test:8080" },
  })
  const row: unknown[] = []
  row[0] = "models/gemini-test"
  row[3] = "Test model"
  row[5] = 12345
  row[6] = 4096
  row[7] = ["generateContent"]
  row[56] = [["models/test-alias"], ["models/second-alias"]]
  row[64] = [1, 25]
  row[71] = [512, null, null, null, null, 1, [1, 3]]
  const rows = [
    row,
    Object.assign([...row], { 0: "models/paid", 77: 2 }),
    Object.assign([...row], { 0: "models/live", 7: ["bidiGenerateContent"] }),
    Object.assign([...row], { 0: "models/interaction", 78: [] }),
    Object.assign([...row], { 0: "models/image", 64: [1, 21] }),
    Object.assign([...row], { 0: "models/gemini-4-argon", 77: 2, 82: [3] }),
    Object.assign([...row], { 0: "models/ultra", 82: [4] }),
    Object.assign([...row], { 0: "models/api-key", 82: [1] }),
  ]
  globalThis.fetch = (async (url, init) => {
    expect((init as RequestInit & { proxy?: string }).proxy).toBe(
      "http://proxy.test:8080",
    )
    const headers = new Headers(init?.headers)
    expect(headers.get("cookie")).toBe(cookie)
    if (String(url).startsWith("https://aistudio.google.com/"))
      return new Response('"WIu0Nc":"public-fixture-key"')
    expect(headers.get("authorization")).toMatch(
      /^SAPISIDHASH \d+_[a-f0-9]{40} SAPISID1PHASH /,
    )
    if (String(url).endsWith("GetAiStudioBenefitTier"))
      return Response.json([1])
    return Response.json([rows])
  }) as typeof fetch
  const models =
    await getAIStudioModule().createRuntime().refreshModels!(connection)
  expect(models).toHaveLength(rows.length)
  expect(models[0]).toMatchObject({
    upstreamId: "gemini-test",
    endpoints: ["gemini"],
    aliases: ["test-alias", "second-alias"],
    metadata: {
      inputTokenLimit: 12345,
      outputTokenLimit: 4096,
      thinkingConfig: row[71],
      isFree: true,
      benefitTier: 1,
    },
  })
  expect(models[1]).toMatchObject({
    enabled: true,
    metadata: { paid: true, isFree: false },
  })
  for (const model of models.slice(2, 5))
    expect(model).toMatchObject({
      enabled: false,
      endpoints: [],
      metadata: { supported: false },
    })
  expect(models[5]).toMatchObject({
    upstreamId: "gemini-4-argon",
    enabled: true,
    metadata: { accessModes: [3], accountAllowed: true },
  })
  for (const model of models.slice(6))
    expect(model).toMatchObject({
      enabled: false,
      endpoints: [],
      metadata: { supported: true, accountAllowed: false },
    })
  for (const [tier, pro, ultra] of [
    [0, false, false],
    [1, true, false],
    [2, true, true],
    [3, false, false],
  ] as const) {
    const catalog = decodeAIStudioModels([rows], tier)
    expect(catalog[5].enabled).toBe(pro)
    expect(catalog[6].enabled).toBe(ultra)
    expect(catalog[7].enabled).toBe(false)
  }
  expect(() => decodeAIStudioModels([[row, row]], 0)).toThrow("duplicate")
  expect(() => decodeAIStudioModels([[null]], 0)).toThrow("model row")
  expect(() =>
    decodeAIStudioModels([[Object.assign([...row], { 82: "unknown" })]], 0),
  ).toThrow("field 82")
})

test("unsupported routes and lost entitlements cannot reach GenerateContent or cool the account", async () => {
  for (const supported of [false, true]) {
    const connection = managedConnectionFromInput({
      id: "restricted",
      name: "restricted",
      provider: "aistudio",
      credentials: { cookie },
    })
    // Simulate a stale catalog or a manually enabled unsupported model.
    connection.models = [
      {
        publicId: "restricted-model",
        upstreamId: "restricted-model",
        endpoints: ["gemini"],
        enabled: true,
        metadata: { supported, accessModes: [3], benefitTier: 1 },
      },
    ]
    upsertProviderConnection(connection)
    globalThis.fetch = (async (url) => {
      if (String(url).startsWith("https://aistudio.google.com/"))
        return new Response('"WIu0Nc":"public-fixture-key"')
      if (String(url).endsWith("GetAiStudioBenefitTier"))
        return Response.json([0])
      throw new Error("Restricted model must not reach WAA or generation")
    }) as typeof fetch
    const response = await server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "restricted-model",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )
    expect(response.status).toBe(422)
    expect(await response.text()).toContain(
      supported ? "required subscription" : "unsupported upstream route",
    )
    expect(connection.credentials[0].status).toBe("ready")
    expect(connection.credentials[0].cooldownUntil).toBeUndefined()
  }
})

test("expired login and modified interpreter are rejected before generation without disclosing cookies", async () => {
  const client = new AIStudioClient({ cookie })
  globalThis.fetch = (async () =>
    new Response("login page")) as unknown as typeof fetch
  await expect(client.initialize()).rejects.toThrow("sign-in expired")
  const deleted = new AIStudioClient({ cookie })
  globalThis.fetch = (async () =>
    new Response('"WIu0Nc":"public-fixture-key"', {
      headers: {
        "Set-Cookie": "SAPISID=; Domain=.google.com; Path=/; Max-Age=0",
      },
    })) as unknown as typeof fetch
  await deleted.initialize()
  await expect(deleted.rpc("ListModels")).rejects.toMatchObject({
    response: { status: 401 },
  })
  let generations = 0
  globalThis.fetch = (async (url) => {
    const address = String(url)
    if (address.endsWith("Waa/Create"))
      return Response.json([
        [null, [interpreter], null, "wrong-hash", "program", "fixture"],
      ])
    if (address.endsWith("GetLoggingContext"))
      return Response.json(["log", 123])
    if (address.endsWith("GenerateContent")) generations++
    return new Response('"WIu0Nc":"public-fixture-key"')
  }) as typeof fetch
  await client.initialize()
  await expect(client.generate([], "hello")).rejects.toThrow(
    "integrity check failed",
  )
  expect(generations).toBe(0)
})

test("model probes retain rotated cookies across requests, including error responses and deletions", async () => {
  const connection = managedConnectionFromInput({
    id: "rotation",
    name: "rotation",
    provider: "aistudio",
    credentials: { cookie: `${cookie}; obsolete=old; expiring=old` },
  })
  upsertProviderConnection(connection)
  const runtime = getAIStudioModule().createRuntime()
  let requests = 0
  globalThis.fetch = (async (url, init) => {
    const sent = new Headers(init?.headers).get("cookie")!
    if (requests++ === 0)
      return new Response('"WIu0Nc":"public-fixture-key"', {
        headers: {
          "Set-Cookie":
            "SAPISID=rotated; Domain=.google.com; Path=/; Secure; HttpOnly",
        },
      })
    expect(sent).toContain("SAPISID=rotated")
    if (String(url).endsWith("ListModels") && requests === 2) {
      const headers = new Headers({ "Retry-After": "10" })
      for (const value of [
        "__Secure-3PAPISID=rotated-three; Domain=.google.com; Path=/; Secure",
        "obsolete=; Domain=.google.com; Path=/; Max-Age=0",
        "expiring=; Domain=.google.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        "foreign=no; Domain=example.com; Path=/",
        "hostonly=no; Path=/",
        "scoped=no; Domain=.google.com; Path=/private",
        "implicitpath=no; Domain=.google.com",
        "partitioned=no; Domain=.google.com; Path=/; Secure; Partitioned",
      ])
        headers.append("Set-Cookie", value)
      return new Response(null, { status: 429, headers })
    }
    expect(sent).toContain("__Secure-3PAPISID=rotated-three")
    expect(sent).not.toMatch(
      /obsolete=|expiring=|foreign=|hostonly=|scoped=|implicitpath=|partitioned=/,
    )
    if (String(url).endsWith("GetAiStudioBenefitTier"))
      return Response.json([0])
    return String(url).endsWith("ListModels") ?
        Response.json([[]])
      : new Response('"WIu0Nc":"public-fixture-key"')
  }) as typeof fetch
  const error = await runtime.refreshModels(connection).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toMatchObject({ response: { status: 429 } })
  if (!(error instanceof Error) || !("response" in error))
    throw new Error("Expected an upstream HTTP error")
  const response = error.response as Response
  expect(response.headers.getSetCookie()).toEqual([])
  expect(response.headers.get("retry-after")).toBe("10")
  await runtime.refreshModels(connection)
  expect(serializeConnectionForExport(connection).credentials).toEqual({
    cookie:
      "SAPISID=rotated; __Secure-1PAPISID=two; __Secure-3PAPISID=rotated-three",
  })
})

test("out-of-order probes merge disjoint cookie rotations without restoring replaced or deleted values", async () => {
  const connection = managedConnectionFromInput({
    id: "parallel",
    name: "parallel",
    provider: "aistudio",
    credentials: { cookie: `${cookie}; removed=old` },
  })
  upsertProviderConnection(connection)
  const pages = Array.from({ length: 3 }, () =>
    Promise.withResolvers<Response>(),
  )
  let index = 0
  globalThis.fetch = (async (url) =>
    String(url).startsWith("https://aistudio.google.com/") ?
      pages[index++].promise
    : String(url).endsWith("GetAiStudioBenefitTier") ? Response.json([0])
    : Response.json([[]])) as typeof fetch
  const runtime = getAIStudioModule().createRuntime()
  const pending = pages.map(() => runtime.refreshModels(connection))
  const page = (cookies: string[]) => {
    const headers = new Headers()
    for (const value of cookies)
      headers.append("Set-Cookie", `${value}; Domain=.google.com; Path=/`)
    return new Response('"WIu0Nc":"public-fixture-key"', { headers })
  }
  pages[1].resolve(page(["SAPISID=newest", "b=keep"]))
  await pending[1]
  pages[0].resolve(page(["SAPISID=stale", "a=keep", "removed=; Max-Age=0"]))
  await pending[0]
  pages[2].resolve(page(["SAPISID=stale-again", "removed=old"]))
  await pending[2]
  expect(serializeConnectionForExport(connection).credentials).toEqual({
    cookie:
      "SAPISID=newest; __Secure-1PAPISID=two; __Secure-3PAPISID=three; b=keep; a=keep",
  })
})

test("in-flight cookie updates cannot overwrite replacement logins or recreate deleted accounts", async () => {
  for (const change of [
    "value",
    "credential",
    "connection",
    "delete",
  ] as const) {
    const connection = managedConnectionFromInput({
      id: change,
      name: change,
      provider: "aistudio",
      credentials: { cookie },
    })
    upsertProviderConnection(connection)
    const page = Promise.withResolvers<Response>()
    globalThis.fetch = (async (url) =>
      String(url).startsWith("https://aistudio.google.com/") ? page.promise
      : String(url).endsWith("GetAiStudioBenefitTier") ? Response.json([0])
      : Response.json([[]])) as typeof fetch
    const pending = getAIStudioModule()
      .createRuntime()
      .refreshModels(connection)
    const replacement = cookie.replace("SAPISID=one", "SAPISID=manual")
    if (change === "value") connection.credentials[0].value = replacement
    if (change === "credential")
      connection.credentials[0] = {
        ...connection.credentials[0],
        value: replacement,
      }
    if (change === "connection")
      upsertProviderConnection(
        managedConnectionFromInput({
          id: change,
          name: change,
          provider: "aistudio",
          credentials: { cookie: replacement },
        }),
      )
    if (change === "delete") removeProviderConnection(connection.id)
    page.resolve(
      new Response('"WIu0Nc":"public-fixture-key"', {
        headers: { "Set-Cookie": "SAPISID=stale; Domain=.google.com; Path=/" },
      }),
    )
    await pending
    const live = listAccountManagedConnections().find(
      (item) => item.id === change,
    )
    if (change === "delete") expect(live).toBeUndefined()
    else expect(live?.credentials[0].value).toBe(replacement)
  }
})

for (const wire of ["chat", "messages", "responses", "gemini"] as const) {
  for (const streaming of [false, true]) {
    test(`AI Studio ${wire} ${streaming ? "streaming" : "unary"} uses the native Playground adapter`, async () => {
      const connection = managedConnectionFromInput({
        id: "ai-fixture",
        name: "fixture",
        provider: "aistudio",
        credentials: { cookie },
      })
      connection.models = [
        {
          publicId: "gemini-fixture",
          upstreamId: "gemini-fixture",
          endpoints: ["gemini"],
          enabled: true,
        },
      ]
      upsertProviderConnection(connection)
      const parameters = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string", minLength: 1 },
          optional: { anyOf: [{ type: "integer" }, { type: "null" }] },
        },
      }
      let generated = false
      globalThis.fetch = (async (url, init) => {
        const address = String(url)
        if (address.startsWith("https://aistudio.google.com/"))
          return new Response('"WIu0Nc":"public-fixture-key"')
        if (address.endsWith("GetAiStudioBenefitTier"))
          return Response.json([2])
        if (address.endsWith("GetLoggingContext"))
          return Response.json(["log", 123])
        if (address.endsWith("Waa/Create"))
          return Response.json([
            [
              null,
              [interpreter],
              null,
              createHash("sha256").update(interpreter).digest("base64url"),
              "program",
              "fixture",
            ],
          ])
        if (!address.endsWith("GenerateContent"))
          throw new Error("Unexpected upstream")
        expect(new Headers(init?.headers).get("X-AIStudio-G1-Tier")).toBe(
          "TIER2",
        )
        const body = JSON.parse(String(init?.body)) as unknown[]
        expect(body[0]).toBe("models/gemini-fixture")
        const tools = body[6] as unknown[][]
        const declarations = tools[0][1] as unknown[][]
        expect(declarations[0][0]).toBe("fixture_tool")
        expect(declarations[0][1]).toContain(JSON.stringify(parameters))
        expect(body[4]).toBe(
          `proof:${createHash("sha256").update("hello").digest("hex")}`,
        )
        generated = true
        const content = [[[null, "answer😀"]], "model"]
        const first = [[[content, 0]], null, [7, 0, 7]]
        const last = [[[[[], "model"], 1]], null, [7, 3, 10]]
        return Response.json([[first, last]])
      }) as typeof fetch
      const model = "gemini-fixture"
      const path =
        wire === "gemini" ?
          `/v1beta/models/${model}:${streaming ? "streamGenerateContent" : "generateContent"}`
        : wire === "chat" ? "/v1/chat/completions"
        : `/v1/${wire}`
      const body =
        wire === "gemini" ?
          { contents: [{ role: "user", parts: [{ text: "hello" }] }] }
        : wire === "responses" ? { model, input: "hello", stream: streaming }
        : {
            model,
            messages: [{ role: "user", content: "hello" }],
            max_tokens: 128,
            stream: streaming,
          }
      const response = await server.fetch(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...body,
            tools:
              wire === "gemini" ?
                [
                  {
                    functionDeclarations: [
                      { name: "fixture_tool", parameters },
                    ],
                  },
                ]
              : wire === "responses" ?
                [{ type: "function", name: "fixture_tool", parameters }]
              : wire === "messages" ?
                [{ name: "fixture_tool", input_schema: parameters }]
              : [
                  {
                    type: "function",
                    function: {
                      name: "fixture_tool",
                      parameters,
                      strict: false,
                    },
                  },
                ],
          }),
        }),
      )
      const result = await response.text()
      expect(response.status).toBe(200)
      expect(generated).toBe(true)
      expect(result).toContain("answer😀")
      if (streaming)
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        )
      else {
        const parsed = JSON.parse(result)
        if (wire === "chat")
          expect(parsed.choices[0].message.content).toBe("answer😀")
        if (wire === "messages")
          expect(
            parsed.content.find((p: { type: string }) => p.type === "text")
              .text,
          ).toBe("answer😀")
        if (wire === "responses")
          expect(
            parsed.output.find((p: { type: string }) => p.type === "message")
              .content[0].text,
          ).toBe("answer😀")
        if (wire === "gemini")
          expect(parsed.candidates[0].finishReason).toBe("STOP")
      }
    }, 15_000)
  }
}
