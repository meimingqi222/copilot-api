import { afterEach, expect, spyOn, test } from "bun:test"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import {
  managedConnectionFromInput,
  serializeConnectionForExport,
  upsertProviderConnection,
  removeProviderConnection,
} from "~/lib/provider-connections"
import * as planQuotaStore from "~/lib/plan-quota/store"
import { quotaAvailability } from "~/lib/quota/allowance"
import { buildRouteTargets, selectRouteTarget } from "~/lib/route-target"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { CreateAccountBody } from "~/services/providers/account-creation/types"
import { getInkstoneModule } from "~/services/providers/modules/inkstone"

const inkstone = getInkstoneModule()
const proxyUrl = "http://127.0.0.1:8888"
const session = { uaaToken: "fake-session" }
const apiKey = "sk-test"
const consolePrefix = "https://discovery.intern-ai.org.cn/api/tokenplan/v1"
const api = "https://discovery-api.intern-ai.org.cn/v1"

function connection(
  credentials: Record<string, unknown> = { ...session, apiKey },
) {
  return managedConnectionFromInput({
    id: "inkstone-test",
    name: "InkStone",
    provider: "inkstone",
    credentials,
    settings: { proxyUrl },
    availableModels: [],
  })
}

function prepare(body: CreateAccountBody) {
  return inkstone.accountCreation!.prepare({
    body,
    label: "InkStone",
    registerDeviceFlow() {
      throw new Error("Unexpected device flow")
    },
  })
}

interface Call {
  url: string
  method: string
  headers: Headers
  body?: string
  proxy?: string
}

function mockVendor(handler: (call: Call) => Response) {
  const mockFetch = async (...[input, init]: Parameters<typeof fetch>) => {
    const url = String(input)
    expect(
      url.startsWith(`${api}/`) || url.startsWith(`${consolePrefix}/`),
    ).toBe(true)
    return handler({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
      proxy: (init as { proxy?: string })?.proxy,
    })
  }
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(mockFetch, { preconnect: globalThis.fetch.preconnect }),
  )
}

let vendor: ReturnType<typeof mockVendor> | undefined
afterEach(() => vendor?.mockRestore())

const ok = (data: unknown) => Response.json({ code: 0, data })

test("pasted key/session normalization applies distinct auth and never writes, even with create consent", async () => {
  vendor = mockVendor(({ url, method, headers, proxy }) => {
    expect(method).toBe("GET")
    expect(proxy).toBe(proxyUrl)
    expect(headers.get("cookie")).toBeNull()
    if (url.endsWith("/users/validate")) {
      expect(headers.get("authorization")).toBe("Bearer fake-session")
      return ok({ name: "Test" })
    }
    expect(url).toBe(`${api}/models`)
    expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`)
    return Response.json({ data: [] })
  })
  const result = await prepare({
    credentials: {
      apiKey: ' "Bearer sk-test" ',
      uaaToken: "other=discard; uaa-token=fake-session; other2=discard",
    },
    settings: { proxyUrl, createApiKey: true },
  })
  expect(result).toMatchObject({
    credentials: { apiKey, ...session },
    settings: { proxyUrl },
  })
  if (!("provider" in result)) throw new Error("Expected prepared account")
  expect(result.settings).not.toHaveProperty("createApiKey")
  expect(
    serializeConnectionForExport(managedConnectionFromInput(result)),
  ).toMatchObject({ credentials: { apiKey, ...session } })
  expect(vendor).toHaveBeenCalledTimes(2)
})

test("a quota-only account never writes or discovers models; a refused key is not accepted", async () => {
  vendor = mockVendor(({ url, method }) => {
    expect(method).toBe("GET")
    return url.endsWith("/users/validate") ?
        ok({ name: "Test" })
      : Response.json({ error: "secret sk-test" }, { status: 401 })
  })
  const result = await prepare({
    credentials: session,
    settings: { createApiKey: "true" },
  })
  if (!("provider" in result)) throw new Error("Expected prepared account")
  const account = managedConnectionFromInput(result)
  expect(account.credentials[0]?.value).toBe("")
  expect(await inkstone.discoverModels!(account)).toEqual([])
  expect(
    buildRouteTargets({
      connections: [account],
      publicModelId: "some-model",
      endpoint: "chat",
    }),
  ).toEqual([])
  expect(vendor).toHaveBeenCalledTimes(1)
  expect(await prepare({ credentials: { apiKey } })).toEqual({
    error: "InkStone refused the supplied credential (401/403).",
  })
  expect(
    await prepare({ credentials: { uaaToken: "other=secret" } }),
  ).toHaveProperty("error")
  expect(vendor).toHaveBeenCalledTimes(2)
})

test.each(["created", "full", "plaintext withheld"])(
  "opt-in key creation: %s never deletes or retries a write",
  async (mode) => {
    let mintedName = ""
    let writes = 0
    vendor = mockVendor(({ url, method, headers, body }) => {
      if (url.endsWith("/users/validate")) return ok({ name: "Test" })
      if (url.endsWith("/keys")) {
        expect(headers.get("cookie")).toBe("uaa-token=fake-session")
        expect(headers.get("authorization")).toBeNull()
        if (method === "GET")
          return ok({ items: [], total: mode === "full" ? 10 : 1 })
        expect(method).toBe("POST")
        writes++
        expect(headers.get("idempotency-key")).toMatch(/^[\da-f-]{36}$/)
        mintedName = (JSON.parse(body ?? "") as { name: string }).name
        expect(mintedName).toMatch(/^ink-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}$/)
        return mode === "plaintext withheld" ?
            Response.json({ code: -15108, msg: "sk-not-for-output" })
          : ok({ key: apiKey })
      }
      expect(url).toBe(`${api}/models`)
      expect(method).toBe("GET")
      return Response.json({ data: [] })
    })
    const result = await prepare({
      credentials: session,
      settings: { createApiKey: true },
    })
    expect(writes).toBe(mode === "full" ? 0 : 1)
    if (mode === "created")
      expect(result).toMatchObject({ credentials: { apiKey, ...session } })
    else
      expect(result).toEqual({
        error: expect.stringContaining(
          mode === "full" ? "No key was deleted" : mintedName,
        ),
      })
    expect(JSON.stringify(result)).not.toContain("sk-not-for-output")
  },
)

test("live key membership controls catalogue and public pricing enriches only chat models", async () => {
  vendor = mockVendor(({ url, method, headers }) => {
    expect(method).toBe("GET")
    if (url.startsWith(`${consolePrefix}/public/models?`)) {
      expect(headers.get("authorization")).toBeNull()
      return ok({
        models: [
          {
            id: "Free",
            input_uncached_price: "0",
            output_price: 0,
            input_types: ["text", "image"],
            capabilities: ["工具调用"],
            supported_protocols: ["openai_chat"],
          },
          {
            id: "Paid",
            context_length: 1048576,
            input_uncached_price: "8000",
            output_price: "9000",
            capabilities_en: ["Reasoning"],
          },
          { id: "ResponsesOnly", supported_protocols: ["openai_responses"] },
          { id: "PublicOnly" },
        ],
      })
    }
    if (headers.get("authorization") !== `Bearer ${apiKey}`)
      return new Response(null, { status: 403 })
    return Response.json({
      data: [
        { id: "Free" },
        { id: "Paid", max_output_tokens: 4096 },
        { id: "Unpriced" },
        { id: "intern-decision-4b" },
        { id: "ResponsesOnly" },
      ],
    })
  })
  const result = await inkstone.createRuntime().refreshModels(connection())
  expect(result.map((m) => m.publicId)).toEqual(["Free", "Paid", "Unpriced"])
  expect(result[0]).toMatchObject({
    endpoints: ["chat"],
    metadata: { isFree: true, supportsVision: true, supportsTools: true },
  })
  expect(result[1]).toMatchObject({
    metadata: {
      isFree: false,
      supportsReasoning: true,
      rate: 8,
      contextWindow: 1048576,
      maxOutputTokens: 4096,
    },
  })
  expect(result[2]?.metadata).not.toHaveProperty("isFree")
  expect(
    await inkstone.discoverModels!(connection({ apiKey: "sk-other" })),
  ).toEqual([])
})

test("read-only quota scopes exhausted windows to paid chat without treating package expiry as reset", async () => {
  const reset = Date.now() + 60_000
  const expires = reset + 86_400_000
  vendor = mockVendor(({ url, method, headers, proxy }) => {
    expect(method).toBe("GET")
    expect(proxy).toBe(proxyUrl)
    expect(headers.get("authorization")).toBe("Bearer fake-session")
    expect(headers.get("cookie")).toBeNull()
    if (url.endsWith("/credits/balance"))
      return ok({
        available_credits: "0.05",
        rpm_limit: 50,
        tpm_limit: "2000000",
        active_package_count: 1,
        usage_windows: {
          "5h": {
            limit_credits: 10,
            remaining_credits: "0",
            next_recover_at: reset,
          },
          "7d": { limit_credits: "50", used_credits: 12.5 },
        },
      })
    expect(url).toBe(`${consolePrefix}/credits/packages`)
    return ok({
      packages: [
        {
          remark: "Example pack",
          remaining_credits: 0.05,
          current_cycle: { end_at: new Date(expires).toISOString() },
        },
        { status: "expired", remaining_credits: 1 },
      ],
    })
  })
  const account = connection()
  account.models = ["Paid", "Free"].map((id) => ({
    publicId: id,
    upstreamId: id,
    enabled: true,
    endpoints: ["chat"],
    metadata: { isFree: id === "Free" },
  }))
  const write = spyOn(planQuotaStore, "mergeWithLast").mockResolvedValue({
    windows: [],
    stale: false,
  })
  upsertProviderConnection(account)
  try {
    const snapshot = await inkstone.createRuntime().refreshQuota!(
      account,
      undefined,
      { skipSave: true },
    )
    expect(snapshot?.details).toMatchObject({
      availableCredits: 0.05,
      rpmLimit: 50,
      tpmLimit: 2_000_000,
      packages: [
        { name: "Example pack", remaining: 0.05, expiresAtMs: expires },
      ],
    })
    expect(snapshot?.allowance.windows).toMatchObject([
      { id: "5h", used: 1, resetsAtMs: reset, scope: { models: ["Paid"] } },
      { id: "7d", used: 0.25 },
    ])
    expect(quotaAvailability(snapshot!, "Paid")).toBe("exhausted")
    expect(quotaAvailability(snapshot!, "Free")).toBe("unknown")
    expect(
      selectRouteTarget(
        buildRouteTargets({
          connections: [account],
          publicModelId: "Paid",
          endpoint: "chat",
        }),
      ),
    ).toBeNull()
    expect(
      selectRouteTarget(
        buildRouteTargets({
          connections: [account],
          publicModelId: "Free",
          endpoint: "chat",
        }),
      )?.connectionId,
    ).toBe(account.id)
  } finally {
    removeProviderConnection(account.id)
    write.mockRestore()
  }
})

test("expired console session reports unknown without probing or invalidating API key", async () => {
  vendor = mockVendor(({ method }) => {
    expect(method).toBe("GET")
    return new Response(null, { status: 401 })
  })
  const account = connection()
  const snapshot = await inkstone.fetchQuota!(account)
  expect(snapshot?.allowance).toMatchObject({ state: "unknown", windows: [] })
  expect(snapshot?.details?.balanceError).toMatch(/session expired/)
  expect(snapshot?.details?.availableCredits).toBeUndefined()
  expect(account.credentials[0]?.status).toBe("ready")
  expect(await inkstone.fetchQuota!(connection({ apiKey }))).toBeUndefined()
  expect(vendor).toHaveBeenCalledTimes(2)
})

function image(url: string, detail?: "low") {
  return {
    type: "image_url" as const,
    image_url: { url, ...(detail && { detail }) },
  }
}

function chatParams(
  content: NonNullable<ChatCompletionsPayload["messages"][number]["content"]>,
  stream = false,
) {
  const account = connection()
  account.models = [
    {
      publicId: "alias",
      upstreamId: "native",
      enabled: true,
      endpoints: ["chat"],
    },
  ]
  const [target] = buildRouteTargets({
    connections: [account],
    publicModelId: "alias",
    endpoint: "chat",
  })
  return {
    connection: account,
    credential: account.credentials[0]!,
    target: target!,
    payload: {
      model: "alias",
      stream,
      messages: [{ role: "user" as const, content }],
    },
  }
}

test.each([false, true])(
  "chat rewrites unsupported controls and preserves normal response (stream=%s)",
  async (stream) => {
    const params = chatParams(
      [
        image("data:image/png;base64,AAAA"),
        image("https://example.test/picture.php?id=1", "low"),
      ],
      stream,
    )
    const payload = {
      ...params.payload,
      reasoning_effort: "high",
      reasoning: { effort: "high" },
      thinking: { type: "enabled" },
      output_config: { effort: "high", format: "kept" },
    } satisfies ChatCompletionsPayload & Record<string, unknown>
    const event = '{"choices":[{"delta":{"content":"hello"}}]}'
    vendor = mockVendor(({ url, method, headers, body, proxy }) => {
      expect(url).toBe(`${api}/chat/completions`)
      expect(method).toBe("POST")
      expect(proxy).toBe(proxyUrl)
      expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`)
      expect(headers.get("cookie")).toBeNull()
      const sent = JSON.parse(body ?? "")
      expect(sent).toMatchObject({
        model: "native",
        output_config: { format: "kept" },
        messages: [
          {
            content: [
              { image_url: { detail: "auto" } },
              { image_url: { detail: "low" } },
            ],
          },
        ],
      })
      for (const name of ["thinking", "reasoning", "reasoning_effort"])
        expect(sent).not.toHaveProperty(name)
      expect(sent.output_config).not.toHaveProperty("effort")
      return stream ?
          new Response(`data: ${event}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json({
            id: "completion",
            choices: [{ message: { content: "hello" } }],
          })
    })
    const { response } = await inkstone.adapter.createChatCompletions!({
      ...params,
      payload,
    })
    if (Symbol.asyncIterator in response) {
      const events = await Array.fromAsync(response)
      expect(events.map((item) => item.data)).toEqual([event, "[DONE]"])
    } else {
      expect(response).toMatchObject({
        id: "completion",
        choices: [{ message: { content: "hello" } }],
      })
    }
    expect(payload.messages[0]?.content[0]).not.toHaveProperty(
      "image_url.detail",
    )
  },
)

test("media preflight sends neither excess images nor excess inline bytes nor unsupported formats", async () => {
  vendor = mockVendor(() => {
    throw new Error("Unexpected fetch")
  })
  const inline = (size: number) =>
    image(`data:image/png;base64,${"A".repeat(Math.ceil((size * 4) / 3))}`)
  const cases = [
    Array.from({ length: 9 }, () => image("https://example.test/test.png")),
    [image("https://example.test/test.svg?download=1")],
    [inline(10 * 1024 ** 2 + 1)],
    Array.from({ length: 5 }, () => inline(9 * 1024 ** 2)),
  ]
  for (const content of cases)
    await expect(
      inkstone.adapter.createChatCompletions!(chatParams(content)),
    ).rejects.toBeInstanceOf(LocalPayloadUnsupportedError)
  expect(vendor).not.toHaveBeenCalled()
})

test("vendor media errors are local shape refusals while 429 and Retry-After survive", async () => {
  vendor = mockVendor(() =>
    Response.json(
      {
        error: {
          code: "media_fetch_failed",
          message: "cumulative image bytes exceeded",
        },
      },
      { status: 502 },
    ),
  )
  await expect(
    inkstone.adapter.createChatCompletions!(chatParams("hello")),
  ).rejects.toBeInstanceOf(LocalPayloadUnsupportedError)
  vendor.mockRestore()
  vendor = mockVendor(() =>
    Response.json(
      { error: { type: "quota_exceeded" } },
      { status: 429, headers: { "retry-after": "1" } },
    ),
  )
  const error = await inkstone.adapter.createChatCompletions!(
    chatParams("hello"),
  ).catch((failure: unknown) => failure)
  expect(error).toMatchObject({
    response: { status: 429 },
    responseBody: expect.stringContaining("quota_exceeded"),
  })
  expect(
    (error as { response: Response }).response.headers.get("retry-after"),
  ).toBe("1")
})
