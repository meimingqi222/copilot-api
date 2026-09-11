import { expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { buildRouteTargets } from "~/lib/route-target"
import { resolveWindsurfRequestModel } from "~/services/windsurf/create-chat-completions"
import {
  extractWindsurfModelMappingsFromPayload,
  extractWindsurfModelsFromPayload,
} from "~/services/windsurf/get-models"
import { ProtobufEncoder } from "~/services/windsurf/protobuf"
import {
  WINDSURF_1M_CONTEXT_TOKENS,
  collapseWindsurfModelVariants,
  listWindsurfSupportedEfforts,
  parseWindsurfVariantTokens,
  pickWindsurfEffort,
  readWindsurfVariants,
  windsurfContextWindow,
  windsurfEffortIsExact,
} from "~/services/windsurf/variant-collapse"

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
      supportedEndpoints: ["/chat/completions"],
      provider: "windsurf",
      upstreamId: "claude-opus-4-7-medium",
    },
    {
      id: "gemini-3.0-flash",
      name: "Gemini 3 Flash",
      vendor: "Google",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions"],
      provider: "windsurf",
      upstreamId: "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
    },
    {
      id: "gpt-5.1-codex",
      name: "GPT-5.1-Codex",
      vendor: "OpenAI",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions"],
      provider: "windsurf",
      upstreamId: "MODEL_PRIVATE_9",
    },
    {
      id: "swe-1-6-fast",
      name: "SWE-1.6 Fast",
      vendor: "Windsurf",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions"],
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

test("windsurfEffortIsExact flags tiers the family does not have", () => {
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

  expect(windsurfEffortIsExact(undefined, variants)).toBe(true)
  expect(windsurfEffortIsExact("auto", variants)).toBe(true)
  expect(windsurfEffortIsExact("high", variants)).toBe(true)
  expect(windsurfEffortIsExact("max", variants)).toBe(true)
  expect(windsurfEffortIsExact("none", variants)).toBe(true)
  // Absent tiers: the request is honored by a neighbour, not exactly.
  expect(windsurfEffortIsExact("minimal", variants)).toBe(false)
  expect(windsurfEffortIsExact("low", variants)).toBe(false)
  expect(windsurfEffortIsExact("medium", variants)).toBe(false)
  expect(windsurfEffortIsExact("xhigh", variants)).toBe(false)
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

  expect(pickWindsurfEffort(undefined, variants)).toBe("high")
  expect(pickWindsurfEffort("auto", variants)).toBe("high")
  expect(pickWindsurfEffort("none", variants)).toBe("none")
  // `minimal` asks for the lightest thinking tier, not for thinking off:
  // GLM has no minimal/low, so it lands on the lowest thinking tier (high).
  expect(pickWindsurfEffort("minimal", variants)).toBe("high")
  expect(pickWindsurfEffort("low", variants)).toBe("high")
  expect(pickWindsurfEffort("medium", variants)).toBe("high")
  expect(pickWindsurfEffort("high", variants)).toBe("high")
  // max and xhigh are independent — never cross-map.
  expect(pickWindsurfEffort("max", variants)).toBe("max")
  expect(pickWindsurfEffort("xhigh", variants)).toBe("high")
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
  expect(targets).toHaveLength(1)
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
  expect(targets).toHaveLength(1)
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
