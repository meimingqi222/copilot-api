import { expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import { resolveWindsurfRequestModel } from "~/services/windsurf/create-chat-completions"
import { extractWindsurfModelsFromPayload } from "~/services/windsurf/get-models"
import { ProtobufEncoder } from "~/services/windsurf/protobuf"

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

test("extractWindsurfModelsFromPayload extracts mixed-provider catalog entries", () => {
  const catalog = new ProtobufEncoder()
  catalog.writeMessage(
    1,
    buildCatalogEntry({
      displayName: "SWE-1.6 Fast",
      modelId: "swe-1-6-fast",
      baseModelId: "swe-1.6-fast",
      baseDisplayName: "SWE-1.6 Fast",
    }),
  )
  catalog.writeMessage(
    1,
    buildCatalogEntry({
      displayName: "GPT-5.1-Codex Low",
      modelId: "MODEL_GPT_5_1_CODEX_LOW",
      baseModelId: "gpt-5.1-codex",
      baseDisplayName: "GPT-5.1-Codex",
    }),
  )
  catalog.writeMessage(
    1,
    buildCatalogEntry({
      displayName: "GPT-5.1-Codex Medium",
      modelId: "MODEL_PRIVATE_9",
    }),
  )
  catalog.writeMessage(
    1,
    buildCatalogEntry({
      displayName: "Claude Opus 4.7 Medium",
      modelId: "claude-opus-4-7-medium",
      baseModelId: "claude-opus-4.7",
      baseDisplayName: "Claude Opus 4.7",
    }),
  )
  catalog.writeMessage(
    1,
    buildCatalogEntry({
      displayName: "Gemini 3 Flash Low",
      modelId: "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
      baseModelId: "gemini-3.0-flash",
      baseDisplayName: "Gemini 3 Flash",
    }),
  )

  const inner = new ProtobufEncoder()
  inner.writeMessage(33, catalog)
  inner.writeMessage(
    33,
    buildProviderFacet({
      Windsurf: ["SWE-1.6 Fast"],
      OpenAI: ["GPT-5.1-Codex Low", "GPT-5.1-Codex Medium"],
      Anthropic: ["Claude Opus 4.7 Medium"],
      Google: ["Gemini 3 Flash Low"],
    }),
  )

  const outer = new ProtobufEncoder()
  outer.writeMessage(1, inner)

  expect(extractWindsurfModelsFromPayload(outer.toUint8Array())).toEqual([
    {
      id: "swe-1-6-fast",
      name: "SWE-1.6 Fast",
      vendor: "Windsurf",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions", "/v1/messages"],
      provider: "windsurf",
      upstreamId: "swe-1-6-fast",
    },
    {
      id: "gpt-5.1-codex-low",
      name: "GPT-5.1-Codex Low",
      vendor: "OpenAI",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions", "/v1/messages"],
      provider: "windsurf",
      upstreamId: "MODEL_GPT_5_1_CODEX_LOW",
    },
    {
      id: "gpt-5.1-codex-medium",
      name: "GPT-5.1-Codex Medium",
      vendor: "OpenAI",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions", "/v1/messages"],
      provider: "windsurf",
      upstreamId: "MODEL_PRIVATE_9",
    },
    {
      id: "claude-opus-4-7-medium",
      name: "Claude Opus 4.7 Medium",
      vendor: "Anthropic",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions", "/v1/messages"],
      provider: "windsurf",
      upstreamId: "claude-opus-4-7-medium",
    },
    {
      id: "gemini-3.0-flash-low",
      name: "Gemini 3 Flash Low",
      vendor: "Google",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions", "/v1/messages"],
      provider: "windsurf",
      upstreamId: "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
    },
  ])
})

test("resolveWindsurfRequestModel uses upstream ids and keeps fast models intact", () => {
  const account = {
    id: "windsurf-account",
    label: "Windsurf",
    provider: "windsurf",
    enabled: true,
    priority: 0,
    isExhausted: false,
    createdAt: 0,
    credentials: { apiKey: "token" },
    settings: {
      baseUrl: "https://server.self-serve.windsurf.com",
      appVersion: "1.48.2",
      lsVersion: "1.9544.35",
      defaultModel: "swe-1-6-fast",
      clientName: "windsurf",
    },
    availableModels: [
      {
        id: "gpt-5.1-codex-low",
        name: "GPT-5.1-Codex Low",
        vendor: "OpenAI",
        pickerEnabled: true,
        supportedEndpoints: ["/chat/completions", "/v1/messages"],
        provider: "windsurf",
        upstreamId: "MODEL_GPT_5_1_CODEX_LOW",
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
    ],
  } as Account

  expect(resolveWindsurfRequestModel(account, "gpt-5.1-codex-low")).toBe(
    "MODEL_GPT_5_1_CODEX_LOW",
  )
  expect(resolveWindsurfRequestModel(account, "swe-1-6-fast")).toBe(
    "swe-1-6-fast",
  )
  expect(resolveWindsurfRequestModel(account, "MODEL_PRIVATE_9")).toBe(
    "MODEL_PRIVATE_9",
  )
})
