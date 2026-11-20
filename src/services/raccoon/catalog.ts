import { asNumber, asRecord, asTrimmedString } from "~/lib/json-shape"
import {
  getConnectionProxyUrl,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { oauthFetch } from "~/services/oauth/fetch"
import { RACCOON_LLM } from "~/services/raccoon/auth"

const fallbackRows = [
  ["raccoon-8c4485", "Raccoon-Work", 1_000_000, 100_000, true, true, 1],
  [
    "raccoon-19b265",
    "Raccoon-Work-260817-A",
    1_000_000,
    100_000,
    false,
    true,
    1,
  ],
  [
    "raccoon-405a1c",
    "Raccoon-Work-260817-B",
    1_000_000,
    100_000,
    false,
    false,
    1,
  ],
  [
    "sn-sensenova-6-8-flash",
    "SenseNova-6.8-Flash",
    256_000,
    63_999,
    true,
    true,
    0,
  ],
  [
    "sn-sensenova-6-8-flash-lite",
    "SenseNova-6.8-Flash-Lite",
    256_000,
    63_999,
    true,
    true,
    0,
  ],
  ["sn-glm-5-3", "GLM-5-3", 1_000_000, 100_000, true, true, 0.75],
  ["sn-kimi-k3", "Kimi-K3", 1_000_000, 100_000, true, true, 1],
  ["sn-glm-5-3-flash", "GLM-5-3-Flash", 1_000_000, 100_000, false, true, 0.2],
  [
    "sn-deepseek-v4-1-flash",
    "DeepSeek-V4.1-Flash",
    1_000_000,
    100_000,
    false,
    true,
    0.25,
  ],
  ["raccoon-chat-ml-5-5", "Raccoon Chat", 180_000, 80_000, false, true, 1],
] as const

function mapping(
  id: string,
  name: string,
  metadata: Record<string, unknown>,
): ModelMapping {
  return {
    publicId: id,
    upstreamId: id,
    name,
    vendor: "raccoon",
    endpoints: ["chat"],
    enabled: true,
    pickerEnabled: true,
    metadata,
  }
}

export function raccoonFallbackModels(): Array<ModelMapping> {
  return fallbackRows.map(
    ([
      id,
      name,
      contextWindow,
      outputLimit,
      supportsImages,
      reasoning,
      creditMultiplier,
    ]) =>
      mapping(id, name, {
        contextWindow,
        outputLimit,
        supportsImages,
        reasoning,
        creditMultiplier,
        free: creditMultiplier === 0,
      }),
  )
}

function nonNegative(input: unknown): number | undefined {
  const value = asNumber(input)
  return value !== undefined && value >= 0 ? value : undefined
}

function catalogRow(row: Record<string, unknown>): ModelMapping | undefined {
  const id = asTrimmedString(row.name) ?? asTrimmedString(row.model_name)
  if (!id) return undefined
  const description = asTrimmedString(row.description)
  const name =
    asTrimmedString(row.display_name)
    ?? (description && description.length <= 64 ? description : id)
  const params = asRecord(row.params)
  const tags =
    Array.isArray(row.tags) ?
      row.tags.map((tag: unknown) => asTrimmedString(tag)?.toLowerCase())
    : []
  const fallback = fallbackRows.find(([key]) => key === id)
  const creditMultiplierBase = nonNegative(row.billing_multiplier)
  const creditMultiplier =
    nonNegative(row.billing_effective_multiplier) ?? creditMultiplierBase
  return mapping(id, name, {
    contextWindow:
      nonNegative(
        row.context_window
          ?? row.contextWindow
          ?? params?.context_window
          ?? params?.contextWindow,
      ) || 200_000,
    outputLimit:
      nonNegative(
        row.max_tokens
          ?? row.maxTokens
          ?? params?.max_tokens
          ?? params?.maxTokens,
      ) || 64_000,
    supportsImages: tags.some(
      (tag) =>
        tag === "vision" || tag === "image" || tag === "image-understanding",
    ),
    reasoning:
      typeof row.reasoning === "boolean" ?
        row.reasoning
      : (fallback?.[5] ?? true),
    creditMultiplier,
    creditMultiplierBase,
    free: creditMultiplier === 0,
  })
}

export async function discoverRaccoonModels(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<ModelMapping>> {
  const token = connection.credentials[0]?.value
  if (!token) return []
  const response = await oauthFetch(
    `${RACCOON_LLM}/model_catalog`,
    {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal:
        signal ?
          AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      redirect: "error",
    },
    { proxyUrl: getConnectionProxyUrl(connection) },
  )
  if (!response.ok)
    throw new Error(`Raccoon model catalog returned HTTP ${response.status}`)
  const root = asRecord(await response.json())
  const data = asRecord(root?.data) ?? root
  if (!Array.isArray(data?.categories))
    throw new Error("Invalid Raccoon model catalog")
  const models = new Map<string, ModelMapping>()
  for (const category of data.categories as Array<unknown>) {
    const entries = asRecord(category)?.models
    if (!Array.isArray(entries)) continue
    for (const entry of entries as Array<unknown>) {
      const row = asRecord(entry)
      const model = row && catalogRow(row)
      if (model && !models.has(model.upstreamId))
        models.set(model.upstreamId, model)
    }
  }
  if (models.size === 0) throw new Error("Empty Raccoon model catalog")
  const defaultModel = raccoonFallbackModels().at(-1)!
  if (!models.has(defaultModel.upstreamId))
    models.set(defaultModel.upstreamId, defaultModel)
  return [...models.values()]
}
