import { afterEach, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { buildRouteTargets } from "~/lib/route-target"
import { resolveDispatchModel } from "~/services/dispatch/shared"
import { resolveWindsurfRequestModel } from "~/services/windsurf/create-chat-completions"
import {
  extractWindsurfModelMappingsFromPayload,
  extractWindsurfModelsFromPayload,
  extractDevinCliModelMappingsFromPayload,
  getWindsurfModelsForConnection,
  clearWindsurfModelCacheForTest,
} from "~/services/windsurf/get-models"
import { ProtobufEncoder, parseMessage } from "~/services/windsurf/protobuf"
import {
  WINDSURF_1M_CONTEXT_TOKENS,
  collapseWindsurfModelVariants,
  listWindsurfSupportedEfforts,
  parseWindsurfVariantTokens,
  readWindsurfVariants,
  windsurfContextWindow,
} from "~/services/windsurf/variant-collapse"

const originalCatalogFetch = globalThis.fetch
const originalDateNow = Date.now
afterEach(() => {
  globalThis.fetch = originalCatalogFetch
  Date.now = originalDateNow
  clearWindsurfModelCacheForTest()
})

function cachedCatalogConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id: "cached-catalog",
    name: "Cached catalog",
    protocol: "windsurf-native",
    baseUrl: "https://cache.example",
    enabled: true,
    priority: 0,
    createdAt: 0,
    credentials: [
      {
        id: "catalog-key",
        value: "cog_cache",
        authMode: "bearer",
        enabled: true,
        status: "ready",
        createdAt: 0,
      },
    ],
    metadata: {
      provider: "windsurf",
      settings: { defaultModel: "fallback-model" },
    },
    ...overrides,
  }
}

function cachedCatalogPayload(): Uint8Array {
  const response = new ProtobufEncoder()
  const model = new ProtobufEncoder()
  model.writeString(1, "SWE-2 High")
  model.writeString(22, "swe-2-high")
  model.writeBool(5, true)
  response.writeMessage(1, model)
  return response.toUint8Array()
}

test("catalog cache coalesces requests, isolates mutations and expires success at five minutes", async () => {
  let now = 1000
  Date.now = () => now
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    return new Response(cachedCatalogPayload())
  }) as unknown as typeof fetch
  const connection = cachedCatalogConnection()
  const [first, concurrent] = await Promise.all([
    getWindsurfModelsForConnection(connection),
    getWindsurfModelsForConnection(connection),
  ])
  expect(requests).toBe(1)
  first[0]!.endpoints.length = 0
  first[0]!.metadata!.supportsImages = false
  first.push({ ...first[0]!, publicId: "caller-only" })
  expect(concurrent[0]?.endpoints).toEqual(["chat", "messages"])
  const repeated = await getWindsurfModelsForConnection(connection)
  expect(repeated).toEqual(concurrent)
  expect(repeated[0]?.metadata?.supportsImages).toBe(true)
  now += 299_999
  await getWindsurfModelsForConnection(connection)
  expect(requests).toBe(1)
  now++
  await getWindsurfModelsForConnection(connection)
  expect(requests).toBe(2)
})

test("catalog cache normalizes hosts and separates credentials, hosts, proxies and defaults", async () => {
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    return new Response(cachedCatalogPayload())
  }) as unknown as typeof fetch
  const connection = cachedCatalogConnection()
  await getWindsurfModelsForConnection(connection)
  await getWindsurfModelsForConnection({
    ...connection,
    baseUrl: "https://cache.example/",
  })
  expect(requests).toBe(1)
  await getWindsurfModelsForConnection({
    ...connection,
    credentials: [{ ...connection.credentials[0]!, value: "cog_other_cache" }],
  })
  await getWindsurfModelsForConnection({
    ...connection,
    baseUrl: "https://other-cache.example",
  })
  await getWindsurfModelsForConnection({
    ...connection,
    proxyUrl: "http://proxy.example:8080",
  })
  await getWindsurfModelsForConnection({
    ...connection,
    metadata: {
      provider: "windsurf",
      settings: { defaultModel: "another-fallback" },
    },
  })
  expect(requests).toBe(5)
})

test("empty catalogs cool down for one minute after both discovery paths", async () => {
  let now = 1000
  Date.now = () => now
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    return new Response(new Uint8Array())
  }) as unknown as typeof fetch
  const connection = cachedCatalogConnection()
  expect((await getWindsurfModelsForConnection(connection))[0]?.publicId).toBe(
    "fallback-model",
  )
  expect(requests).toBe(2)
  now += 59_999
  await getWindsurfModelsForConnection(connection)
  expect(requests).toBe(2)
  now++
  await getWindsurfModelsForConnection(connection)
  expect(requests).toBe(4)
})

test("failed and rejected probes retain error semantics with only a one-minute cooldown", async () => {
  for (const status of [503, 401]) {
    clearWindsurfModelCacheForTest()
    let now = 1000
    Date.now = () => now
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      return new Response("unavailable", { status })
    }) as unknown as typeof fetch
    const connection = cachedCatalogConnection()
    await expect(
      getWindsurfModelsForConnection(connection),
    ).rejects.toMatchObject({ response: { status } })
    expect(requests).toBe(2)
    now += 59_999
    await expect(getWindsurfModelsForConnection(connection)).rejects.toThrow(
      "Failed to fetch",
    )
    expect(requests).toBe(2)
    now++
    await expect(getWindsurfModelsForConnection(connection)).rejects.toThrow(
      "Failed to fetch",
    )
    expect(requests).toBe(4)
  }
})

test("legacy editor discovery succeeds before rejection and caches for five minutes", async () => {
  let now = 1000
  Date.now = () => now
  let requests = 0
  const status = new ProtobufEncoder()
  status.writeBytes(33, cachedCatalogPayload())
  const legacyResponse = new ProtobufEncoder()
  legacyResponse.writeMessage(1, status)
  globalThis.fetch = (async (url) => {
    requests++
    return String(url).endsWith("GetCliModelConfigs") ?
        new Response("", { status: 403 })
      : new Response(legacyResponse.toUint8Array())
  }) as typeof fetch
  const connection = cachedCatalogConnection()
  expect(
    (await getWindsurfModelsForConnection(connection))[0]?.upstreamId,
  ).toBe("swe-2-high")
  expect(requests).toBe(2)
  now += 299_999
  await getWindsurfModelsForConnection(connection)
  expect(requests).toBe(2)
  now++
  await getWindsurfModelsForConnection(connection)
  expect(requests).toBe(4)
})

test("catalog cache evicts old scopes when its bounded capacity is exceeded", async () => {
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    return new Response(cachedCatalogPayload())
  }) as unknown as typeof fetch
  for (let index = 0; index < 257; index++) {
    await getWindsurfModelsForConnection(
      cachedCatalogConnection({ baseUrl: `https://cache-${index}.example` }),
    )
  }
  expect(requests).toBe(257)
  await getWindsurfModelsForConnection(
    cachedCatalogConnection({ baseUrl: "https://cache-256.example" }),
  )
  expect(requests).toBe(257)
  await getWindsurfModelsForConnection(
    cachedCatalogConnection({ baseUrl: "https://cache-0.example" }),
  )
  expect(requests).toBe(258)
})

test("CLI catalog carries image booleans and limits through effort collapse", () => {
  const response = new ProtobufEncoder()
  for (const [id, images] of [
    ["gemini-4-high", true],
    ["glm-5-high", false],
  ] as const) {
    const model = new ProtobufEncoder()
    model.writeString(1, id)
    model.writeString(22, id)
    if (images) model.writeBool(5, true)
    model.writeVarint(18, 1048576)
    const info = new ProtobufEncoder()
    info.writeVarint(13, 64000)
    model.writeMessage(23, info)
    response.writeMessage(1, model)
  }
  const models = extractDevinCliModelMappingsFromPayload(
    response.toUint8Array(),
  )
  expect(
    models.find((m) => m.upstreamId === "gemini-4-high")?.metadata,
  ).toMatchObject({
    supportsImages: true,
    contextWindow: 1048576,
    outputLimit: 64000,
  })
  expect(
    models.find((m) => m.upstreamId === "glm-5-high")?.metadata?.supportsImages,
  ).toBe(false)
})

test("unsupported CLI discovery retains GetUserStatus's legacy editor identity and proxy", async () => {
  const calls: string[] = []
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url).split("/").at(-1)!)
    expect((init as RequestInit & { proxy?: string }).proxy).toBe(
      "http://proxy.example:8080",
    )
    if (calls.length === 1) return new Response("", { status: 404 })
    const metadata = parseMessage(
      parseMessage(init?.body as Uint8Array)[0]!.raw!,
    )
    expect(
      new TextDecoder().decode(metadata.find((n) => n.field === 1)?.raw),
    ).toBe("windsurf")
    return new Response(new Uint8Array())
  }) as typeof fetch
  await getWindsurfModelsForConnection({
    id: "catalog-test",
    protocol: "windsurf-native",
    baseUrl: "https://region.example",
    proxyUrl: "http://proxy.example:8080",
    credentials: [{ value: "cog_test" }],
    metadata: { settings: { defaultModel: "swe-2" } },
  } as unknown as ProviderConnection)
  expect(calls).toEqual(["GetCliModelConfigs", "GetUserStatus"])
})

test("successful CLI catalog uses the key's host and CLI identity without editor fallback", async () => {
  const response = new ProtobufEncoder()
  const model = new ProtobufEncoder()
  model.writeString(1, "SWE-2 High")
  model.writeString(22, "swe-2-high")
  response.writeMessage(1, model)
  const calls: Array<{ url: string; body: Uint8Array }> = []
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: init?.body as Uint8Array })
    return new Response(response.toUint8Array())
  }) as typeof fetch
  const models = await getWindsurfModelsForConnection({
    id: "cli-catalog-test",
    protocol: "windsurf-native",
    baseUrl: "https://region.example",
    credentials: [{ value: "cog_catalog" }],
  } as unknown as ProviderConnection)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe(
    "https://region.example/exa.api_server_pb.ApiServerService/GetCliModelConfigs",
  )
  const metadata = parseMessage(parseMessage(calls[0]!.body)[0]!.raw!)
  const textAt = (field: number) =>
    new TextDecoder().decode(metadata.find((node) => node.field === field)?.raw)
  expect(textAt(1)).toBe("devin-cli")
  expect(textAt(3)).toBe("cog_catalog")
  expect(textAt(28)).toBe("chisel")
  expect(models[0]).toMatchObject({
    upstreamId: "swe-2-high",
    endpoints: ["chat", "messages"],
  })
})
import { effortVariantIsExact, pickEffortVariant } from "~/lib/effort-variants"

function buildCatalogEntry(options: {
  displayName: string
  modelId: string
  baseModelId?: string
  baseDisplayName?: string
}): ProtobufEncoder {
  const entry = new ProtobufEncoder()
  entry.writeString(1, options.displayName)
  entry.writeString(22, options.modelId)

  const metadata = new ProtobufEncoder()
  metadata.writeString(17, options.modelId)
  if (options.baseModelId) {
    metadata.writeString(23, options.baseModelId)
  }
  entry.writeMessage(23, metadata)

  if (options.baseDisplayName) {
    const traits = new ProtobufEncoder()
    traits.writeString(1, options.baseDisplayName)
    entry.writeMessage(30, traits)
  }

  return entry
}

function buildProviderFacet(
  groups: Record<string, Array<string>>,
): ProtobufEncoder {
  const facet = new ProtobufEncoder()
  facet.writeString(1, "Provider")

  for (const [vendor, modelNames] of Object.entries(groups)) {
    const group = new ProtobufEncoder()
    group.writeString(1, vendor)
    for (const modelName of modelNames) {
      group.writeString(2, modelName)
    }
    facet.writeMessage(2, group)
  }

  return facet
}

function buildCatalogPayload(
  entries: Array<{
    displayName: string
    modelId: string
    baseModelId?: string
    baseDisplayName?: string
  }>,
  vendorGroups?: Record<string, Array<string>>,
): Uint8Array {
  const catalog = new ProtobufEncoder()
  for (const entry of entries) {
    catalog.writeMessage(1, buildCatalogEntry(entry))
  }

  const inner = new ProtobufEncoder()
  inner.writeMessage(33, catalog)
  if (vendorGroups) {
    inner.writeMessage(33, buildProviderFacet(vendorGroups))
  }

  const outer = new ProtobufEncoder()
  outer.writeMessage(1, inner)
  return outer.toUint8Array()
}

const GLM_CATALOG_ENTRIES = [
  {
    displayName: "GLM-5.2 High",
    modelId: "glm-5-2",
    baseModelId: "glm-5-2",
    baseDisplayName: "GLM-5.2",
  },
  {
    displayName: "GLM-5.2 Max",
    modelId: "glm-5-2-max",
    baseModelId: "glm-5-2",
    baseDisplayName: "GLM-5.2",
  },
  {
    displayName: "GLM-5.2 No Thinking",
    modelId: "glm-5-2-none",
    baseModelId: "glm-5-2",
    baseDisplayName: "GLM-5.2",
  },
  {
    displayName: "GLM-5.2 High 1M",
    modelId: "glm-5-2-1m",
    baseModelId: "glm-5-2",
    baseDisplayName: "GLM-5.2",
  },
  {
    displayName: "GLM-5.2 Max 1M",
    modelId: "glm-5-2-max-1m",
    baseModelId: "glm-5-2",
    baseDisplayName: "GLM-5.2",
  },
  {
    displayName: "GLM-5.2 No Thinking 1M",
    modelId: "glm-5-2-none-1m",
    baseModelId: "glm-5-2",
    baseDisplayName: "GLM-5.2",
  },
]

test("extractWindsurfModelsFromPayload collapses thinking variants by family", () => {
  const payload = buildCatalogPayload(
    [
      {
        displayName: "SWE-1.6 Fast",
        modelId: "swe-1-6-fast",
        baseModelId: "swe-1.6-fast",
        baseDisplayName: "SWE-1.6 Fast",
      },
      {
        displayName: "GPT-5.1-Codex Low",
        modelId: "MODEL_GPT_5_1_CODEX_LOW",
        baseModelId: "gpt-5.1-codex",
        baseDisplayName: "GPT-5.1-Codex",
      },
      {
        displayName: "GPT-5.1-Codex Medium",
        modelId: "MODEL_PRIVATE_9",
      },
      {
        displayName: "Claude Opus 4.7 Medium",
        modelId: "claude-opus-4-7-medium",
        baseModelId: "claude-opus-4.7",
        baseDisplayName: "Claude Opus 4.7",
      },
      {
        displayName: "Gemini 3 Flash Low",
        modelId: "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
        baseModelId: "gemini-3.0-flash",
        baseDisplayName: "Gemini 3 Flash",
      },
    ],
    {
      Windsurf: ["SWE-1.6 Fast"],
      OpenAI: ["GPT-5.1-Codex Low", "GPT-5.1-Codex Medium"],
      Anthropic: ["Claude Opus 4.7 Medium"],
      Google: ["Gemini 3 Flash Low"],
    },
  )

  expect(extractWindsurfModelsFromPayload(payload)).toEqual([
    {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      vendor: "Anthropic",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions", "/v1/messages"],
      provider: "windsurf",
      upstreamId: "claude-opus-4-7-medium",
    },
    {
      id: "gemini-3.0-flash",
      name: "Gemini 3 Flash",
      vendor: "Google",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions", "/v1/messages"],
      provider: "windsurf",
      upstreamId: "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
    },
    {
      id: "gpt-5.1-codex",
      name: "GPT-5.1-Codex",
      vendor: "OpenAI",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions", "/v1/messages"],
      provider: "windsurf",
      upstreamId: "MODEL_PRIVATE_9",
    },
    {
      id: "swe-1-6-fast",
      name: "SWE-1.6 Fast",
      vendor: "Windsurf",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions", "/v1/messages"],
      provider: "windsurf",
      upstreamId: "swe-1-6-fast",
    },
  ])
})

test("extractWindsurfModelMappingsFromPayload emits head + hidden pin mappings", () => {
  const payload = buildCatalogPayload(GLM_CATALOG_ENTRIES, { Zai: [] })
  const mappings = extractWindsurfModelMappingsFromPayload(payload)

  const listed = mappings.filter((m) => !m.hidden).map((m) => m.publicId)
  expect(listed).toEqual(["glm-5-2", "glm-5-2-1m"])

  const pins = mappings.filter((m) => m.hidden)
  expect(pins.map((m) => m.publicId).sort()).toEqual([
    "glm-5-2-max",
    "glm-5-2-max-1m",
    "glm-5-2-none",
    "glm-5-2-none-1m",
  ])
  // Each pin keeps its own upstreamId so dispatch's payload.model overwrite
  // still lands on the pinned SKU.
  expect(pins.find((m) => m.publicId === "glm-5-2-max")?.upstreamId).toBe(
    "glm-5-2-max",
  )
  expect(pins.find((m) => m.publicId === "glm-5-2-max")?.pickerEnabled).toBe(
    false,
  )

  const standard = mappings.find((m) => m.publicId === "glm-5-2")
  const standardVariants = readWindsurfVariants(standard)
  expect(standardVariants?.defaultEffort).toBe("high")
  expect(standardVariants?.byEffort).toEqual({
    none: "glm-5-2-none",
    high: "glm-5-2",
    max: "glm-5-2-max",
  })
})

test("SWE Lightning variants list one head and keep exact tier pins", () => {
  const lightning = "swe-2-1-lightning"
  const nemotron = "nemotron-3-5-lightning"
  const tiers = ["low", "medium", "high", "xhigh", "max"] as const
  const payload = buildCatalogPayload(
    [
      { displayName: "SWE-2.1 Lightning", modelId: lightning },
      ...tiers.map((tier) => ({
        displayName: `SWE-2.1 ${tier} Lightning`,
        modelId: `swe-2-1-${tier}-lightning`,
        baseDisplayName: "SWE-2.1 Lightning",
      })),
      { displayName: "SWE-2.1 High", modelId: "swe-2-1-high" },
      { displayName: "Nemotron 3.5 Lightning", modelId: nemotron },
      {
        displayName: "Nemotron 3.5 Lightning High",
        modelId: `${nemotron}-high`,
      },
    ],
    {},
  )
  expect(
    extractWindsurfModelsFromPayload(payload).map(({ id, name }) => ({
      id,
      name,
    })),
  ).toEqual([
    { id: nemotron, name: "Nemotron 3.5 Lightning" },
    { id: "swe-2-1", name: "SWE-2.1" },
    { id: lightning, name: "SWE-2.1 Lightning" },
  ])

  const models = extractWindsurfModelMappingsFromPayload(payload)
  const connection = cachedCatalogConnection({ models })
  expect(
    listWindsurfSupportedEfforts(models.find((m) => m.publicId === lightning)),
  ).toEqual(["high", "low", "medium", "xhigh", "max"])
  for (const tier of tiers) {
    const sku = `swe-2-1-${tier}-lightning`
    expect(resolveWindsurfRequestModel(connection, lightning, tier)).toBe(sku)
    expect(
      resolveWindsurfRequestModel(
        connection,
        sku,
        tier === "low" ? "max" : "low",
      ),
    ).toBe(sku)
  }
  expect(resolveWindsurfRequestModel(connection, "swe-2-1", "high")).toBe(
    "swe-2-1-high",
  )
})

test("parseWindsurfVariantTokens handles thinking / fast / priority lanes", () => {
  // {effort}-thinking and no-thinking share family gpt-5.2
  expect(parseWindsurfVariantTokens("gpt-5.2-high-thinking")).toMatchObject({
    family: "gpt-5.2",
    effort: "high",
    lane: "standard",
  })
  expect(parseWindsurfVariantTokens("gpt-5.2-no-thinking")).toMatchObject({
    family: "gpt-5.2",
    effort: "none",
  })
  expect(
    parseWindsurfVariantTokens("gpt-5.2-high-thinking-fast"),
  ).toMatchObject({
    family: "gpt-5.2",
    effort: "high",
    lane: "fast",
  })
  expect(
    parseWindsurfVariantTokens("gpt-5-3-codex-high-priority"),
  ).toMatchObject({
    family: "gpt-5-3-codex",
    effort: "high",
    lane: "priority",
  })
  // Bare product `-fast` is not a lane — must not fold into swe-1-6.
  expect(parseWindsurfVariantTokens("swe-1-6-fast")).toMatchObject({
    family: "swe-1-6-fast",
    effort: undefined,
    lane: "standard",
  })
  // `{effort}-reasoning` folds like `{effort}-thinking`.
  expect(parseWindsurfVariantTokens("o3-high-reasoning")).toMatchObject({
    family: "o3",
    effort: "high",
  })
})

test("head display names stay unique across lane / thinking / 1m", () => {
  const mappings = collapseWindsurfModelVariants([
    {
      publicId: "claude-opus-4-8-high",
      name: "Claude Opus 4.8 High",
      upstreamId: "claude-opus-4-8-high",
      vendor: "Anthropic",
      endpoints: ["chat"],
    },
    {
      publicId: "claude-opus-4-8-low",
      name: "Claude Opus 4.8 Low",
      upstreamId: "claude-opus-4-8-low",
      vendor: "Anthropic",
      endpoints: ["chat"],
    },
    {
      publicId: "claude-opus-4-8-high-fast",
      name: "Claude Opus 4.8 High Fast",
      upstreamId: "claude-opus-4-8-high-fast",
      vendor: "Anthropic",
      endpoints: ["chat"],
    },
    {
      publicId: "claude-opus-4-8-low-fast",
      name: "Claude Opus 4.8 Low Fast",
      upstreamId: "claude-opus-4-8-low-fast",
      vendor: "Anthropic",
      endpoints: ["chat"],
    },
    // Single-effort thinking product: Thinking must remain in the name.
    {
      publicId: "claude-opus-4-6-thinking",
      name: "Claude Opus 4.6 Thinking",
      upstreamId: "claude-opus-4-6-thinking",
      vendor: "Anthropic",
      endpoints: ["chat"],
    },
    {
      publicId: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      upstreamId: "claude-opus-4-6",
      vendor: "Anthropic",
      endpoints: ["chat"],
    },
  ])

  const heads = mappings.filter((m) => !m.hidden)
  const names = heads.map((m) => m.name)
  expect(new Set(names).size).toBe(names.length)
  const byId = new Map(heads.map((m) => [m.publicId, m.name]))
  expect(byId.get("claude-opus-4-8")).toBe("Claude Opus 4.8")
  expect(byId.get("claude-opus-4-8-fast")).toBe("Claude Opus 4.8 Fast")
  expect(byId.get("claude-opus-4-6-thinking")).toBe("Claude Opus 4.6 Thinking")
  expect(byId.get("claude-opus-4-6")).toBe("Claude Opus 4.6")
})

test("collapse groups gpt-5.2 thinking family under one head per lane", () => {
  const mappings = collapseWindsurfModelVariants([
    {
      publicId: "gpt-5.2-high-thinking",
      name: "GPT-5.2 High Thinking",
      upstreamId: "MODEL_GPT_5_2_HIGH",
      vendor: "OpenAI",
      endpoints: ["chat"],
    },
    {
      publicId: "gpt-5.2-no-thinking",
      name: "GPT-5.2 No Thinking",
      upstreamId: "MODEL_GPT_5_2_NONE",
      vendor: "OpenAI",
      endpoints: ["chat"],
    },
    {
      publicId: "gpt-5.2-xhigh-thinking",
      name: "GPT-5.2 XHigh Thinking",
      upstreamId: "MODEL_GPT_5_2_XHIGH",
      vendor: "OpenAI",
      endpoints: ["chat"],
    },
    {
      publicId: "gpt-5.2-high-thinking-fast",
      name: "GPT-5.2 High Thinking Fast",
      upstreamId: "MODEL_GPT_5_2_HIGH_PRIORITY",
      vendor: "OpenAI",
      endpoints: ["chat"],
    },
  ])

  const heads = mappings.filter((m) => !m.hidden)
  expect(heads.map((m) => m.publicId).sort()).toEqual([
    "gpt-5.2",
    "gpt-5.2-fast",
  ])
  const standard = heads.find((m) => m.publicId === "gpt-5.2")
  expect(standard?.upstreamId).toBe("MODEL_GPT_5_2_HIGH")
  expect(readWindsurfVariants(standard)?.byEffort).toEqual({
    none: "MODEL_GPT_5_2_NONE",
    high: "MODEL_GPT_5_2_HIGH",
    xhigh: "MODEL_GPT_5_2_XHIGH",
  })
  const fast = heads.find((m) => m.publicId === "gpt-5.2-fast")
  expect(fast?.upstreamId).toBe("MODEL_GPT_5_2_HIGH_PRIORITY")
})

test("listWindsurfSupportedEfforts emits the default first, then ascending", () => {
  const mappings = collapseWindsurfModelVariants([
    {
      publicId: "glm-5-2",
      name: "GLM-5.2 High",
      upstreamId: "glm-5-2",
      vendor: "Zai",
      endpoints: ["chat"],
    },
    {
      publicId: "glm-5-2-max",
      name: "GLM-5.2 Max",
      upstreamId: "glm-5-2-max",
      vendor: "Zai",
      endpoints: ["chat"],
    },
    {
      publicId: "glm-5-2-none",
      name: "GLM-5.2 No Thinking",
      upstreamId: "glm-5-2-none",
      vendor: "Zai",
      endpoints: ["chat"],
    },
  ])
  const head = mappings.find((m) => m.publicId === "glm-5-2")
  // Default (high) first: consumers that only get value strings treat the first
  // entry as the default, so ascending order would default GLM to "no thinking".
  expect(listWindsurfSupportedEfforts(head)).toEqual(["high", "none", "max"])
  expect(listWindsurfSupportedEfforts(undefined)).toBeUndefined()
  // 折叠时同一份清单也写进 mapping，供 /v1/models 投影与请求钳制共用。
  expect(head?.efforts).toEqual(["high", "none", "max"])
  expect(
    mappings.find((m) => m.publicId === "glm-5-2-max")?.efforts,
  ).toBeUndefined()
})

test("windsurfContextWindow only advertises the 1m tier", () => {
  const mappings = collapseWindsurfModelVariants([
    {
      publicId: "glm-5-2",
      name: "GLM-5.2 High",
      upstreamId: "glm-5-2",
      vendor: "Zai",
      endpoints: ["chat"],
    },
    {
      publicId: "glm-5-2-1m",
      name: "GLM-5.2 High 1M",
      upstreamId: "glm-5-2-1m",
      vendor: "Zai",
      endpoints: ["chat"],
    },
  ])
  expect(
    windsurfContextWindow(mappings.find((m) => m.publicId === "glm-5-2-1m")),
  ).toBe(WINDSURF_1M_CONTEXT_TOKENS)
  // Standard-tier families carry no window information: clients keep their own
  // default instead of being told a made-up number.
  expect(
    windsurfContextWindow(mappings.find((m) => m.publicId === "glm-5-2")),
  ).toBeUndefined()
  expect(windsurfContextWindow(undefined)).toBeUndefined()
})

test("effortVariantIsExact flags tiers the family does not have", () => {
  const head = collapseWindsurfModelVariants([
    {
      publicId: "glm-5-2",
      name: "GLM-5.2 High",
      upstreamId: "glm-5-2",
      vendor: "Zai",
      endpoints: ["chat"],
    },
    {
      publicId: "glm-5-2-max",
      name: "GLM-5.2 Max",
      upstreamId: "glm-5-2-max",
      vendor: "Zai",
      endpoints: ["chat"],
    },
    {
      publicId: "glm-5-2-none",
      name: "GLM-5.2 No Thinking",
      upstreamId: "glm-5-2-none",
      vendor: "Zai",
      endpoints: ["chat"],
    },
  ]).find((m) => m.publicId === "glm-5-2")
  const variants = readWindsurfVariants(head)
  expect(variants).toBeDefined()
  if (!variants) return

  expect(effortVariantIsExact(undefined, variants)).toBe(true)
  expect(effortVariantIsExact("auto", variants)).toBe(true)
  expect(effortVariantIsExact("high", variants)).toBe(true)
  expect(effortVariantIsExact("max", variants)).toBe(true)
  expect(effortVariantIsExact("none", variants)).toBe(true)
  // Absent tiers: the request is honored by a neighbour, not exactly.
  expect(effortVariantIsExact("minimal", variants)).toBe(false)
  expect(effortVariantIsExact("low", variants)).toBe(false)
  expect(effortVariantIsExact("medium", variants)).toBe(false)
  expect(effortVariantIsExact("xhigh", variants)).toBe(false)
})

test("collapseWindsurfModelVariants maps standard reasoning_effort onto GLM tiers", () => {
  const mappings = collapseWindsurfModelVariants([
    {
      publicId: "glm-5-2",
      name: "GLM-5.2 High",
      upstreamId: "glm-5-2",
      vendor: "Zai",
      endpoints: ["chat", "messages"],
      baseModelId: "glm-5-2",
      baseDisplayName: "GLM-5.2",
    },
    {
      publicId: "glm-5-2-max",
      name: "GLM-5.2 Max",
      upstreamId: "glm-5-2-max",
      vendor: "Zai",
      endpoints: ["chat", "messages"],
      baseModelId: "glm-5-2",
      baseDisplayName: "GLM-5.2",
    },
    {
      publicId: "glm-5-2-none",
      name: "GLM-5.2 No Thinking",
      upstreamId: "glm-5-2-none",
      vendor: "Zai",
      endpoints: ["chat", "messages"],
      baseModelId: "glm-5-2",
      baseDisplayName: "GLM-5.2",
    },
  ])

  const variants = readWindsurfVariants(
    mappings.find((m) => m.publicId === "glm-5-2"),
  )
  expect(variants).toBeDefined()
  if (!variants) return

  expect(pickEffortVariant(undefined, variants)).toBe("high")
  expect(pickEffortVariant("auto", variants)).toBe("high")
  expect(pickEffortVariant("none", variants)).toBe("none")
  // `minimal` asks for the lightest thinking tier, not for thinking off:
  // GLM has no minimal/low, so it lands on the lowest thinking tier (high).
  expect(pickEffortVariant("minimal", variants)).toBe("high")
  expect(pickEffortVariant("low", variants)).toBe("high")
  expect(pickEffortVariant("medium", variants)).toBe("high")
  expect(pickEffortVariant("high", variants)).toBe("high")
  // max and xhigh are independent — never cross-map.
  expect(pickEffortVariant("max", variants)).toBe("max")
  expect(pickEffortVariant("xhigh", variants)).toBe("high")
})

function buildCollapsedConnection(): ProviderConnection {
  return {
    id: "windsurf-account",
    name: "Windsurf",
    protocol: "windsurf-native",
    baseUrl: "https://api.windsurf.com",
    enabled: true,
    priority: 0,
    createdAt: 0,
    models: collapseWindsurfModelVariants(
      GLM_CATALOG_ENTRIES.map((e) => ({
        publicId: e.modelId,
        name: e.displayName,
        upstreamId: e.modelId,
        vendor: "Zai",
        endpoints: ["chat", "messages"],
        baseModelId: e.baseModelId,
        baseDisplayName: e.baseDisplayName,
      })),
    ),
    credentials: [
      {
        id: "ws-cred",
        authMode: "bearer",
        value: "token",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
    ],
  } as unknown as ProviderConnection
}

test("resolveWindsurfRequestModel picks upstream by reasoning_effort on head", () => {
  const connection = buildCollapsedConnection()

  expect(resolveWindsurfRequestModel(connection, "glm-5-2")).toBe("glm-5-2")
  expect(resolveWindsurfRequestModel(connection, "glm-5-2", "none")).toBe(
    "glm-5-2-none",
  )
  expect(resolveWindsurfRequestModel(connection, "glm-5-2", "high")).toBe(
    "glm-5-2",
  )
  // max is its own tier; xhigh must not promote into it.
  expect(resolveWindsurfRequestModel(connection, "glm-5-2", "max")).toBe(
    "glm-5-2-max",
  )
  expect(resolveWindsurfRequestModel(connection, "glm-5-2", "xhigh")).toBe(
    "glm-5-2",
  )
  expect(resolveWindsurfRequestModel(connection, "glm-5-2-1m", "max")).toBe(
    "glm-5-2-max-1m",
  )
  expect(resolveWindsurfRequestModel(connection, "glm-5-2-1m", "none")).toBe(
    "glm-5-2-none-1m",
  )
})

test("route target upstream for a pin survives the dispatch model overwrite", () => {
  const connection = buildCollapsedConnection()

  // Production path: buildRouteTargets matches the hidden mapping, dispatch
  // sets payload.model = target.upstreamModelId, then the adapter resolves.
  const targets = buildRouteTargets({
    publicModelId: "glm-5-2-max",
    endpoint: "chat",
    connections: [connection],
    onlyAvailable: true,
  })
  expect(targets.map((target) => target.endpoint)).toEqual(["chat", "messages"])
  expect(targets[0]?.publicModelId).toBe("glm-5-2-max")
  expect(targets[0]?.upstreamModelId).toBe("glm-5-2-max")

  const target = targets[0]
  if (!target) throw new Error("expected a route target for glm-5-2-max")
  const dispatchedModel = target.upstreamModelId
  expect(resolveWindsurfRequestModel(connection, dispatchedModel, "none")).toBe(
    "glm-5-2-max",
  )
})

test("route target for opaque pin carries the opaque upstream", () => {
  const connection = {
    id: "windsurf-account",
    name: "Windsurf",
    protocol: "windsurf-native",
    baseUrl: "https://api.windsurf.com",
    enabled: true,
    priority: 0,
    createdAt: 0,
    models: collapseWindsurfModelVariants([
      {
        publicId: "gpt-5.1-codex-low",
        name: "GPT-5.1-Codex Low",
        upstreamId: "MODEL_GPT_5_1_CODEX_LOW",
        vendor: "OpenAI",
        endpoints: ["chat", "messages"],
        baseModelId: "gpt-5.1-codex",
        baseDisplayName: "GPT-5.1-Codex",
      },
      {
        publicId: "gpt-5.1-codex-medium",
        name: "GPT-5.1-Codex Medium",
        upstreamId: "MODEL_PRIVATE_9",
        vendor: "OpenAI",
        endpoints: ["chat", "messages"],
      },
    ]),
    credentials: [
      {
        id: "ws-cred",
        authMode: "bearer",
        value: "token",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
    ],
  } as unknown as ProviderConnection

  const targets = buildRouteTargets({
    publicModelId: "gpt-5.1-codex-low",
    endpoint: "chat",
    connections: [connection],
  })
  expect(targets.map((target) => target.endpoint)).toEqual(["chat", "messages"])
  const target = targets[0]
  if (!target) throw new Error("expected a route target for gpt-5.1-codex-low")
  expect(target.upstreamModelId).toBe("MODEL_GPT_5_1_CODEX_LOW")
  expect(resolveWindsurfRequestModel(connection, target.upstreamModelId)).toBe(
    "MODEL_GPT_5_1_CODEX_LOW",
  )
})

test("resolveWindsurfRequestModel keeps uncollapsed / opaque models intact", () => {
  const connection = {
    id: "windsurf-account",
    name: "Windsurf",
    protocol: "windsurf-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    createdAt: 0,
    models: [
      {
        publicId: "gpt-5.1-codex-low",
        upstreamId: "MODEL_GPT_5_1_CODEX_LOW",
        name: "GPT-5.1-Codex Low",
        vendor: "OpenAI",
        pickerEnabled: true,
        endpoints: ["chat", "messages"],
        enabled: true,
      },
      {
        publicId: "swe-1-6-fast",
        upstreamId: "swe-1-6-fast",
        name: "SWE-1.6 Fast",
        vendor: "Windsurf",
        pickerEnabled: true,
        endpoints: ["chat", "messages"],
        enabled: true,
      },
    ],
  } as ProviderConnection

  expect(resolveWindsurfRequestModel(connection, "gpt-5.1-codex-low")).toBe(
    "MODEL_GPT_5_1_CODEX_LOW",
  )
  expect(resolveWindsurfRequestModel(connection, "swe-1-6-fast")).toBe(
    "swe-1-6-fast",
  )
  expect(resolveWindsurfRequestModel(connection, "MODEL_PRIVATE_9")).toBe(
    "MODEL_PRIVATE_9",
  )
})

test("dispatch passes the requested head (not the default SKU) for windsurf effort selection", () => {
  const connection = {
    id: "windsurf-account",
    name: "Windsurf",
    protocol: "windsurf-native",
    baseUrl: "https://api.windsurf.com",
    enabled: true,
    priority: 0,
    createdAt: 0,
    models: collapseWindsurfModelVariants([
      {
        publicId: "swe-2-high",
        name: "SWE-2 High",
        upstreamId: "swe-2-high",
        vendor: "Windsurf",
        endpoints: ["chat"],
      },
      {
        publicId: "swe-2-medium",
        name: "SWE-2 Medium",
        upstreamId: "swe-2-medium",
        vendor: "Windsurf",
        endpoints: ["chat"],
      },
      {
        publicId: "swe-2-max",
        name: "SWE-2 Max",
        upstreamId: "swe-2-max",
        vendor: "Windsurf",
        endpoints: ["chat"],
      },
    ]),
    credentials: [
      {
        id: "ws-cred",
        authMode: "bearer",
        value: "token",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
    ],
  } as unknown as ProviderConnection

  const targets = buildRouteTargets({
    publicModelId: "swe-2",
    endpoint: "chat",
    connections: [connection],
    onlyAvailable: true,
  })
  expect(targets).toHaveLength(1)
  const target = targets[0]
  if (!target) throw new Error("expected a route target for swe-2")
  expect(target.publicModelId).toBe("swe-2")
  // Head default is high, but dispatch must not pre-resolve it: the adapter
  // selects the SKU from reasoning_effort.
  expect(target.upstreamModelId).toBe("swe-2-high")
  expect(resolveDispatchModel(target)).toBe("swe-2")
  expect(
    resolveWindsurfRequestModel(
      connection,
      resolveDispatchModel(target),
      "medium",
    ),
  ).toBe("swe-2-medium")
  // The old path (payload.model = upstreamModelId) collapsed the head into a
  // hidden pin and dropped the effort — locked here so it cannot regress.
  expect(
    resolveWindsurfRequestModel(connection, target.upstreamModelId, "medium"),
  ).toBe("swe-2-high")

  // Explicit pins still pin: publicModelId === upstreamModelId there.
  const pinTargets = buildRouteTargets({
    publicModelId: "swe-2-high",
    endpoint: "chat",
    connections: [connection],
    onlyAvailable: true,
  })
  expect(pinTargets).toHaveLength(1)
  const pin = pinTargets[0]
  if (!pin) throw new Error("expected a route target for swe-2-high")
  expect(resolveDispatchModel(pin)).toBe("swe-2-high")
  expect(
    resolveWindsurfRequestModel(
      connection,
      resolveDispatchModel(pin),
      "medium",
    ),
  ).toBe("swe-2-high")

  // Non-windsurf targets keep the static upstream mapping.
  expect(
    resolveDispatchModel({
      protocol: "openai-compatible",
      publicModelId: "gpt-x",
      upstreamModelId: "gpt-x-upstream",
    } as unknown as Parameters<typeof resolveDispatchModel>[0]),
  ).toBe("gpt-x-upstream")
})
