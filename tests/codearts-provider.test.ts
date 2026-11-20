import { afterEach, expect, test } from "bun:test"
import {
  createHash,
  createPublicKey,
  verify,
  type JsonWebKey,
} from "node:crypto"

import {
  managedConnectionFromInput,
  serializeConnectionForExport,
} from "~/lib/provider-connections/managed-connection"
import type { ProviderConnection } from "~/lib/provider-connections"
import {
  codeArtsFetch,
  codeArtsKeys,
  signCodeArts,
} from "~/services/codearts/client"
import { discoverCodeArtsModels } from "~/services/codearts/models"
import {
  codeArtsCallback,
  codeArtsOAuth,
  CODEARTS_STS,
  refreshCodeArts,
} from "~/services/codearts/oauth"
import { fetchCodeArtsQuota } from "~/services/codearts/quota"
import { CODEARTS_IAM, codeArtsStations } from "~/services/codearts/stations"
import { codeArtsNativeAdapter } from "~/services/protocols/codearts-native"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { AdapterParams } from "~/services/protocols/types"
import { applyProviderAuthUpdate } from "~/services/providers/auth-update"

import {
  fixtureAgent,
  fixtureBuiltin,
  fixtureProfile,
  fixtureQuota,
  fixtureRefresh,
  fixtureSse,
  fixtureSts,
} from "./fixtures/codearts"

const originalFetch = globalThis.fetch
type ObservedInit = RequestInit & { proxy?: string }

function mockNetwork(respond: (url: URL, init: ObservedInit) => Response) {
  globalThis.fetch = ((url: string, init: ObservedInit) =>
    Promise.resolve(respond(new URL(url), init))) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

function fixtureConnection(station = "mainland") {
  return managedConnectionFromInput({
    id: "codearts-fixture",
    name: "Fixture",
    provider: "codearts",
    credentials: {
      accessToken: "fixture-AK",
      secretAccessKey: "fixture-SK",
      securityToken: "fixture-ST",
      codeartsStation: station,
      codeartsVerifier: "fixture-verifier",
      codeartsDpopKey: "fixture-jwk",
      refreshToken: fixtureRefresh,
    },
  })
}

const chat = codeArtsNativeAdapter.createChatCompletions!

function chatParams(
  connection: ProviderConnection,
  partial: Partial<ChatCompletionsPayload> = {},
): AdapterParams<ChatCompletionsPayload> {
  const credential = connection.credentials[0]
  return {
    connection,
    credential,
    payload: {
      model: "ignored",
      messages: [{ role: "user", content: "hello" }],
      ...partial,
    },
    target: {
      connectionId: connection.id,
      connectionName: connection.name,
      protocol: connection.protocol,
      credentialId: credential.id,
      publicModelId: "public",
      upstreamModelId: "codearts/glm-5.3-flash",
      endpoint: "chat",
      connectionPriority: 0,
      connectionWeight: 1,
      credentialPriority: 0,
      credentialWeight: 1,
    },
  }
}

test("Huawei HMAC matches an independent known-answer signature", () => {
  const keys = codeArtsKeys(fixtureConnection().credentials[0])
  const signed = signCodeArts(
    keys,
    {
      url: new URL(
        "/api/v2/chat/completions?b=x+y!&a=2&a=1",
        codeArtsStations.mainland.snap,
      ),
      method: "POST",
      body: '{"m":1}',
    },
    new Date("2026-01-01T00:00:00Z"),
  )
  expect(signed.get("authorization")).toBe(
    "SDK-HMAC-SHA256 Access=fixture-AK,SignedHeaders=content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token,Signature=cb75e91f52aa8053cef17d59a5829344514a6eb2c977cd0b09d5ee1dbeb93d95", // gitleaks:allow — known-answer signature using fixture-SK and a fixed date.
  )
})

test("no connection override, cross-station URL, IAM wildcard, or redirect can receive signed secrets", async () => {
  const active = fixtureConnection("international")
  const keys = codeArtsKeys(active.credentials[0])
  active.baseUrl = "https://untrusted.invalid"
  const called: Array<string> = []
  mockNetwork((url, init) => {
    called.push(url.href)
    expect(init.redirect).toBe("error")
    return new Response(null, {
      status: 307,
      headers: { location: active.baseUrl },
    })
  })
  for (const url of [
    active.baseUrl,
    codeArtsStations.mainland.snap,
    `${CODEARTS_IAM}/v3.0/OS-USER/users/fixture`,
  ]) {
    expect(() => codeArtsFetch(active, keys, { url: new URL(url) })).toThrow(
      "own station",
    )
  }
  await expect(chat(chatParams(active))).rejects.toMatchObject({
    response: { status: 502 },
  })
  expect(called).toEqual([
    `${codeArtsStations.international.snap}/api/v2/chat/completions`,
  ])
})

test("international OAuth binds S256, STS form and a verifiable ES256 proof through portable credential rotation", async () => {
  const start = await codeArtsOAuth.start({ region: "international" })
  const login = new URL(start.authUrl!)
  const authorize = new URL(login.searchParams.get("service")!)
  expect(login.searchParams.get("site")).toBe("intl")
  expect(authorize.href).toStartWith(
    `${codeArtsStations.international.portal}/authorize?`,
  )
  expect(authorize.searchParams.get("code_challenge")).toBe(
    createHash("sha256").update(start.pkce!.codeVerifier).digest("base64url"),
  )
  expect(
    codeArtsCallback.parseQuery!(new URLSearchParams("code=fixture")),
  ).toEqual({ code: "fixture", state: "" })
  expect(
    codeArtsCallback.parseQuery!(new URLSearchParams("error=denied")),
  ).toBeUndefined()
  const proofs: Array<{ jwk: JsonWebKey; jti: string }> = []
  mockNetwork((url, init) => {
    expect(url.href).toBe(CODEARTS_STS)
    expect(init.redirect).toBe("error")
    expect(init.proxy).toBe("http://127.0.0.1:4321")
    const form = new URLSearchParams(String(init.body))
    expect(form.get("client_id")).toBe("codearts-agent")
    expect(form.get("code_verifier")).toBe(start.pkce!.codeVerifier)
    const [protectedHeader, claims, signature] = new Headers(init.headers)
      .get("dpop")!
      .split(".")
    const { alg, typ, jwk } = JSON.parse(
      Buffer.from(protectedHeader, "base64url").toString(),
    )
    const { htm, htu, jti } = JSON.parse(
      Buffer.from(claims, "base64url").toString(),
    )
    expect({ alg, typ, htm, htu }).toEqual({
      alg: "ES256",
      typ: "dpop+jwt",
      htm: "POST",
      htu: CODEARTS_STS,
    })
    expect(jwk).not.toHaveProperty("d")
    expect(
      verify(
        "sha256",
        Buffer.from(`${protectedHeader}.${claims}`),
        {
          key: createPublicKey({ key: jwk, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true)
    proofs.push({ jwk, jti })
    if (form.get("grant_type") === "authorization_code") {
      expect(form.get("redirect_uri")).toBe(
        `http://127.0.0.1:${codeArtsCallback.port}/oauth/callback`,
      )
      expect(form.get("code")).toBe("fixture")
      return Response.json(fixtureSts())
    }
    expect(form.get("grant_type")).toBe("refresh_token")
    expect(form.get("refresh_token")).toBe(fixtureRefresh)
    return Response.json(fixtureSts("rotated-AK", "rotated-refresh"))
  })
  const connection = await codeArtsOAuth.exchange({
    code: "fixture",
    flow: {
      ...start,
      id: "flow",
      label: "Fixture",
      status: "pending",
      provider: "codearts",
      expiresAt: 100,
      region: "international",
      proxyUrl: "http://127.0.0.1:4321",
    },
  })
  expect(connection.credentials[0].context?.oauthAccountId).toBe(
    `international:${fixtureProfile.principal_urn}`,
  )
  const exported = serializeConnectionForExport(connection)
  const imported = managedConnectionFromInput({
    id: "imported",
    name: "Imported",
    provider: "codearts",
    credentials: exported.credentials as Record<string, unknown>,
  })
  expect(codeArtsKeys(imported.credentials[0])).toEqual(
    codeArtsKeys(connection.credentials[0]),
  )
  const update = await refreshCodeArts(imported, fixtureRefresh, {
    proxyUrl: "http://127.0.0.1:4321",
  })
  expect(imported.credentials[0].value).toBe("fixture-AK")
  applyProviderAuthUpdate(imported, update)
  expect(codeArtsKeys(imported.credentials[0])).toMatchObject({
    accessKey: "rotated-AK",
    station: "international",
  })
  expect(imported.credentials[0].context?.refreshToken).toBe("rotated-refresh")
  expect(proofs[0].jwk).toEqual(proofs[1].jwk)
  expect(proofs[0].jti).not.toBe(proofs[1].jti)
  mockNetwork(() =>
    Response.json({ error: "invalid_dpop_proof" }, { status: 400 }),
  )
  await expect(
    refreshCodeArts(imported, "rotated-refresh", {}),
  ).rejects.toMatchObject({ response: { status: 503 } })
  mockNetwork(() => Response.json({ error_code: "STS5.1806" }, { status: 400 }))
  await expect(
    refreshCodeArts(imported, "rotated-refresh", {}),
  ).rejects.toMatchObject({ response: { status: 400 } })
})

test("signed catalog retains dated native IDs and the main agent's rates and limits without touching benefit APIs", async () => {
  const connection = fixtureConnection()
  mockNetwork((url, init) => {
    expect(url.origin).toBe(codeArtsStations.mainland.snap)
    expect(new Headers(init.headers).get("x-security-token")).toBe("fixture-ST")
    expect(init.method).toBe("GET")
    if (url.pathname === "/v1/model/builtin")
      return Response.json(fixtureBuiltin)
    if (url.pathname.endsWith("/useragents"))
      return Response.json({
        agents: [
          { agent_id: "secondary" },
          { agent_id: "main", original_id: "build" },
        ],
      })
    expect(url.searchParams.get("agent_id")).toBe("main")
    return Response.json(fixtureAgent)
  })
  const models = await discoverCodeArtsModels(connection)
  expect(models.map((m) => m.upstreamId)).toEqual([
    "deepseek-v4.1-flash-1017",
    "deepseek-v4.1-flash",
  ])
  expect(models[0]).toMatchObject({
    name: "DeepSeek-V4.1-Flash-1017",
    endpoints: ["chat"],
    metadata: {
      contextWindow: 1_000_000,
      maxOutput: 65_536,
      imageInput: false,
      codeartsCreditRate: 0.3,
    },
  })
})

test("mainland quota reads only statistics, the daily balance and read-only credit batches", async () => {
  mockNetwork((url, init) => {
    expect(init.redirect).toBe("error")
    expect(new Headers(init.headers).get("authorization")).toStartWith(
      "SDK-HMAC-SHA256",
    )
    switch (url.pathname) {
      case "/snap-manager/v1/statistics/plugin":
        return Response.json(fixtureQuota)
      case "/api/v1/user/tokens/balance":
        return Response.json({
          result: { daily_token_limit: 40, daily_tokens_used: 40 },
        })
      case "/snap-manager/v1/package/credit/page": {
        expect(init.method).toBe("POST")
        const query = JSON.parse(String(init.body))
        return Response.json({
          data: {
            list:
              query.packageTypes.includes("basic") ?
                [
                  {
                    packageType: "basic",
                    expiredTime: "2099-01-21",
                    creditAmount: 500,
                    creditUsed: 500,
                  },
                ]
              : [],
          },
        })
      }
      case "/v1/ops/credit/overview":
        return Response.json({ data: { items: [] } })
      default:
        throw new Error(`Unexpected quota route ${url.pathname}`)
    }
  })
  const { allowance, details } = await fetchCodeArtsQuota(fixtureConnection())
  expect(allowance.state).toBe("known")
  expect(allowance.windows.filter((w) => !w.aside)).toMatchObject([
    {
      id: "usageTotalPackageCredit",
      remaining: 100.01,
      resetsAtMs: Date.parse("2099-01-20T16:00:00Z"),
    },
  ])
  expect(allowance.windows.find((w) => w.id === "daily-benefit")).toMatchObject(
    { aside: true, remaining: 0 },
  )
  expect(
    allowance.windows.find((w) => w.id === "usageOnDemandPackageCredit"),
  ).toBeUndefined()
  expect(details?.creditBatches).toMatchObject([{ remaining: 0 }])
})

test("international quota never calls mainland, and a plan end isn't a renewal", async () => {
  mockNetwork((url) => {
    expect(url.href).toBe(
      `${codeArtsStations.international.snap}/snap-manager/v1/statistics/plugin`,
    )
    return Response.json({
      package: { is_token_package: true, package_name_en: "Free" },
      start_date: "2099-01-01",
      end_date: "2099-02-01",
      metrics: [
        {
          name: "usageTokenChatMessages",
          package_token_amount: 100,
          usage_token_num: 90,
        },
      ],
    })
  })
  const snapshot = await fetchCodeArtsQuota(fixtureConnection("international"))
  expect(snapshot.allowance.windows).toMatchObject([
    {
      id: "usageTokenChatMessages",
      remaining: 10,
      expiresAtMs: Date.parse("2099-01-31T16:00:00Z"),
    },
  ])
  expect(snapshot.allowance.windows[0].resetsAtMs).toBeUndefined()
})

test("metered chat folds streamed reasoning, renamed tool calls and trailing usage", async () => {
  const name = `mcp_${"a".repeat(64)}`
  const sent = new Array<Headers>()
  mockNetwork((url, init) => {
    const body = JSON.parse(String(init.body))
    const headers = new Headers(init.headers)
    sent.push(headers)
    expect(url.pathname).toBe("/api/v2/chat/completions")
    expect(body).toMatchObject({
      model: "glm-5.3-flash",
      stream: true,
      max_tokens: 65_536,
      reasoning_effort: "high",
    })
    expect(body).not.toHaveProperty("stop")
    expect(body).not.toHaveProperty("thinking")
    expect(headers.get("x-sdk-content-sha256")).toBe(
      createHash("sha256").update(String(init.body)).digest("hex"),
    )
    const short = body.tools[0].function.name as string
    expect(short).toHaveLength(64)
    return fixtureSse(
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", reasoning_content: "reason" },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: short.slice(0, 44), arguments: "{" },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: short.slice(44), arguments: "}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      {
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
      "[DONE]",
    )
  })
  const params = chatParams(fixtureConnection(), {
    stop: "stop",
    max_tokens: 90_000,
    reasoning_effort: "high",
    tools: [{ type: "function", function: { name, parameters: {} } }],
  })
  for (let i = 0; i < 2; i++) {
    const { response } = await chat(params)
    expect(response).toMatchObject({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "reason",
            tool_calls: [{ id: "call_1", function: { name, arguments: "{}" } }],
          },
        },
      ],
      usage: { total_tokens: 7 },
    })
  }
  expect(sent[0].get("x-ot-session-id")).toBe(sent[1].get("x-ot-session-id"))
  expect(sent[0].get("x-ot-trace-id")).not.toBe(sent[1].get("x-ot-trace-id"))
})

test("an error after the role-only SSE frame is a routable HTTP 429", async () => {
  mockNetwork(() =>
    fixtureSse(
      { choices: [{ index: 0, delta: { role: "assistant" } }] },
      {
        error_code: "InferHub.ModelArts.81111.429",
        error_msg: "Quota exhausted",
      },
    ),
  )
  await expect(
    chat(chatParams(fixtureConnection(), { stream: true })),
  ).rejects.toMatchObject({
    message: "Quota exhausted",
    response: { status: 429 },
  })
})

test("a gateway-queued request polls a signed trace, then retries a metered chat", async () => {
  const sent: Array<string> = []
  mockNetwork((url, init) => {
    sent.push(`${init.method} ${url.pathname}`)
    if (sent.length === 1)
      return new Response(null, {
        status: 429,
        headers: {
          "queue-status": "queued",
          "trace-id": "fixture_trace",
          "retry-after": "0",
        },
      })
    if (sent.length === 2) return Response.json({ status: "promoted" })
    return fixtureSse(
      {
        choices: [
          { index: 0, delta: { content: "ready" }, finish_reason: "stop" },
        ],
      },
      "[DONE]",
    )
  })
  expect((await chat(chatParams(fixtureConnection()))).response).toMatchObject({
    choices: [{ message: { content: "ready" } }],
  })
  expect(sent).toEqual([
    "POST /api/v2/chat/completions",
    "GET /api/v1/concurrency/trace-queues/fixture_trace",
    "POST /api/v2/chat/completions",
  ])
})
