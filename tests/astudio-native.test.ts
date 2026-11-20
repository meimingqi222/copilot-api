import { afterEach, expect, spyOn, test } from "bun:test"

import {
  managedConnectionFromInput,
  removeProviderConnection,
  serializeConnectionForExport,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { buildRouteTargets, selectRouteTarget } from "~/lib/route-target"
import { studioAccountCreation } from "~/services/astudio/auth"
import {
  discoverStudioModels,
  studioFallbackModels,
} from "~/services/astudio/catalog"
import { fetchStudioQuota } from "~/services/astudio/quota"
import { studioNativeAdapter } from "~/services/protocols/astudio-native"
import { getAstudioModule } from "~/services/providers/modules/astudio"

const mocks: Array<{ mockRestore(): void }> = []
const fetchTarget: {
  fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
} = globalThis
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
})

function studioConnection(
  credentials: Record<string, unknown> = {
    modelBearerToken: "fixture-model",
    studioAccountId: "account-a",
    ssoSessionId: "fixture-session",
  },
) {
  const conn = managedConnectionFromInput({
    id: "astudio-fixture",
    name: "Astron Studio fixture",
    provider: "astudio",
    credentials,
    settings: { proxyUrl: "http://proxy.invalid:8080" },
  })
  conn.models = studioFallbackModels()
  return conn
}

test("Astron Studio exchanges a supplied web session once and keeps account and gateway credentials separate", async () => {
  const fetch = spyOn(fetchTarget, "fetch").mockImplementation(
    async (input, init) => {
      expect(String(input)).toBe(
        "https://agent.xfyun.cn/xingchen-studio/auth/bearer-token",
      )
      expect(init?.method).toBe("POST")
      expect(init?.redirect).toBe("error")
      expect(new Headers(init?.headers).get("cookie")).toBe(
        "account_id=account-a; ssoSessionId=fixture-session; sso_sessionid=fixture-session",
      )
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
      return Response.json({
        flag: true,
        code: 0,
        data: { modelBearerToken: "fixture-model" },
      })
    },
  )
  mocks.push(fetch)
  const prepared = await studioAccountCreation.prepare({
    body: {
      credentials: {
        ssoSessionId: "fixture-session",
        uid: "uid-a",
      },
      settings: {
        studioAccountId: "account-a",
        ssoSessionId: "must-not-persist",
      },
    },
    label: "Astron fixture",
    registerDeviceFlow() {
      throw new Error("Unexpected device flow")
    },
  })
  if (!("provider" in prepared)) throw new Error("Could not prepare account")
  expect(prepared.settings).toEqual({})
  const conn = managedConnectionFromInput(prepared)
  const serialized = serializeConnectionForExport(conn)
  const restored = studioConnection(
    serialized.credentials as Record<string, unknown>,
  )
  expect(restored.protocol).toBe("astudio-native")
  expect(restored.credentials[0]).toMatchObject({
    value: "fixture-model",
    context: {
      studioAccountId: "account-a",
      ssoSessionId: "fixture-session",
      uid: "uid-a",
    },
  })
  expect(fetch).toHaveBeenCalledTimes(1)
})

test("Astron Studio accepts a browser Cookie header without sending or storing unrelated cookies", async () => {
  const fetch = spyOn(fetchTarget, "fetch").mockImplementation(
    async (url, init) => {
      expect(String(url)).toBe(
        "https://agent.xfyun.cn/xingchen-studio/auth/bearer-token",
      )
      expect(new Headers(init?.headers).get("cookie")).toBe(
        "account_id=account-b; token=a=b; ssoSessionId=session-b; sso_sessionid=session-b",
      )
      expect(init?.redirect).toBe("error")
      return Response.json({
        code: 0,
        data: { modelBearerToken: "fixture-model" },
      })
    },
  )
  mocks.push(fetch)
  const prepare = (sessionCookie: string) =>
    studioAccountCreation.prepare({
      body: { credentials: { sessionCookie } },
      label: "Remote Astron fixture",
      registerDeviceFlow() {
        throw new Error("Unexpected device flow")
      },
    })

  for (const cookie of [
    "Cookie: account_id=account-a; account_id=account-b; token=ambiguous",
    "account_id=account-a; ssoSessionId=one; sso_sessionid=two",
    "account_id=account-a; tracking=ignored",
    "Cookie:\r\naccount_id=account-a; token=multiline",
  ]) {
    expect(await prepare(cookie)).toHaveProperty("error")
  }
  expect(fetch).not.toHaveBeenCalled()

  const prepared = await prepare(
    "Cookie: tracking=unrelated-secret; sso_sessionid=session-b; token=a=b; account_id=account-b",
  )
  if (!("provider" in prepared))
    throw new Error("Expected remote account input")
  const exported = serializeConnectionForExport(
    managedConnectionFromInput(prepared),
  )
  expect(exported.credentials).toMatchObject({
    modelBearerToken: "fixture-model",
    studioAccountId: "account-b",
    sessionToken: "a=b",
    ssoSessionId: "session-b",
  })
  expect(JSON.stringify(exported)).not.toContain("unrelated-secret")
  expect(JSON.stringify(exported)).not.toContain("sessionCookie")
  expect(fetch).toHaveBeenCalledTimes(1)
})

test("Astron Studio catalog excludes hidden and unavailable models, and preserves live capabilities", async () => {
  const connection = studioConnection()
  const fetch = spyOn(fetchTarget, "fetch").mockImplementation(
    async (url, init) => {
      expect(String(url)).toEndWith("/api/v1/model-manager/models")
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fixture-model",
      )
      expect(new Headers(init?.headers).has("cookie")).toBe(false)
      return Response.json({
        data: {
          models: [
            { slug: "xdeepseek-flash-in", supported_in_api: false },
            { slug: "hidden", visibility: "hidden" },
            {
              slug: "spark-live",
              display_name: "Spark Live",
              input_modalities: ["text", "image"],
              supported_reasoning_levels: [
                { effort: "none" },
                { effort: "high" },
              ],
              context_window: 256000,
              max_output_tokens: 8000,
              badge: { text: { en: "Free" } },
            },
          ],
        },
      })
    },
  )
  mocks.push(fetch)
  expect(await discoverStudioModels(connection)).toMatchObject([
    {
      upstreamId: "spark-live",
      endpoints: ["responses"],
      efforts: ["none", "high"],
      metadata: {
        contextWindow: 256000,
        outputLimit: 8000,
        supportsImages: true,
        free: true,
      },
    },
  ])
})

test("Astron Studio sends native Responses, preserving structured input and streaming events", async () => {
  const connection = studioConnection()
  const model = "spark-x2.6-4b"
  const target = buildRouteTargets({
    connections: [connection],
    publicModelId: model,
    endpoint: "responses",
  })[0]
  expect(target?.isTranslated).toBeFalsy()
  const fetch = spyOn(fetchTarget, "fetch").mockImplementation(
    async (url, init) => {
      expect(String(url)).toBe(
        "https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/responses",
      )
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fixture-model",
      )
      expect(new Headers(init?.headers).has("cookie")).toBe(false)
      expect((init as RequestInit & { proxy?: string }).proxy).toBe(
        connection.proxyUrl,
      )
      const body = JSON.parse(String(init?.body)) as { stream?: boolean }
      expect(body).toMatchObject({
        model,
        input: "hello",
        previous_response_id: "resp-prev",
        reasoning: { effort: "high" },
      })
      return body.stream ?
          new Response(
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1"}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          )
        : Response.json({ id: "resp-1", model, output: [] })
    },
  )
  mocks.push(fetch)
  const payload = {
    model,
    input: "hello",
    previous_response_id: "resp-prev",
    reasoning: { effort: "high" as const },
  }
  const args = {
    target,
    connection,
    credential: connection.credentials[0],
    payload,
  }
  expect(
    (await studioNativeAdapter.createResponses!(args)).response,
  ).toMatchObject({ id: "resp-1", model })
  const { response } = await studioNativeAdapter.createResponses!({
    ...args,
    payload: { ...payload, stream: true },
  })
  if (!(Symbol.asyncIterator in response))
    throw new Error("Expected Responses stream")
  expect(await Array.fromAsync(response)).toMatchObject([
    { event: "response.created" },
  ])
})

test("Astron Studio exhausted Spark points only exclude paid Spark routes", async () => {
  const connection = studioConnection()
  const fetch = spyOn(fetchTarget, "fetch").mockImplementation(
    async (input, init) => {
      expect(init?.method).toBe("GET")
      expect(new Headers(init?.headers).has("cookie")).toBe(true)
      const path = new URL(String(input)).pathname
      if (path.endsWith("points/balance"))
        return Response.json({
          data: {
            totalBalance: 20,
            sparkTotalBalance: 0,
            activityBalance: 5,
            activityNextExpireTime: "2099-11-23 10:00:00",
          },
        })
      if (path.endsWith("membership/me"))
        return Response.json({ data: { planName: "Standard" } })
      throw new Error(`Unexpected route ${path}`)
    },
  )
  mocks.push(fetch)
  const noSession = studioConnection({ modelBearerToken: "fixture-model" })
  expect((await fetchStudioQuota(noSession)).allowance.state).toBe("unknown")
  expect(fetch).not.toHaveBeenCalled()
  upsertProviderConnection(connection)
  try {
    const snapshot = await getAstudioModule().createRuntime().refreshQuota!(
      connection,
      undefined,
      { skipSave: true },
    )
    expect(snapshot?.allowance.windows).toMatchObject([
      {
        id: "general-credits",
        remaining: 20,
        expiresAtMs: Date.parse("2099-11-23T02:00:00Z"),
      },
      {
        id: "spark-credits",
        remaining: 0,
        scope: { models: ["spark-x2.6", "spark-x2.5"] },
      },
    ])
    const selected = (model: string) =>
      selectRouteTarget(
        buildRouteTargets({
          connections: [connection],
          publicModelId: model,
          endpoint: "responses",
        }),
      )
    expect(selected("spark-x2.6")).toBeNull()
    expect(selected("spark-x2.6-4b")?.connectionId).toBe(connection.id)
    expect(selected("xopglm52")?.connectionId).toBe(connection.id)
  } finally {
    removeProviderConnection(connection.id)
  }
})
