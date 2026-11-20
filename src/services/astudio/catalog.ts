import { asNumber, asRecord, asTrimmedString } from "~/lib/json-shape"
import {
  getConnectionOAuthAccessToken,
  getConnectionProxyUrl,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { ASTUDIO_MODEL_ORIGIN } from "~/services/astudio/auth"
import { oauthFetch } from "~/services/oauth/fetch"

const FALLBACK = [
  ["astronclaw-auto", "Auto", 262144, 32768, false],
  ["spark-x2.6", "Spark-X2.6", 262144, 32768, false],
  ["spark-x2.6-4b", "Spark-X2.6-Lite", 1048576, 110000, true],
  ["spark-x2.5", "Spark-X2.5", 262144, 32768, false],
  ["xopglm52", "GLM-5.2", 1048576, 32768, false],
  ["xopdeepseekv4pro0813", "DeepSeek-V4-Pro", 1048576, 32768, false],
  ["xopdsv4flash0731in", "DeepSeek-V4-Flash", 1048576, 32768, false],
] as const

function mapping(
  id: string,
  name: string,
  metadata: Record<string, unknown>,
  efforts?: Array<string>,
): ModelMapping {
  return {
    publicId: id,
    upstreamId: id,
    name,
    vendor: "astudio",
    endpoints: ["responses"],
    enabled: true,
    pickerEnabled: true,
    metadata,
    efforts,
  }
}

function extraModel(): ModelMapping {
  return mapping(
    "xdeepseek-flash-in",
    "DeepSeek-V4.1-Flash",
    {
      contextWindow: 1048576,
      outputLimit: 100000,
      reasoning: true,
      supportsImages: false,
    },
    ["none", "high", "max"],
  )
}

export function studioFallbackModels(): Array<ModelMapping> {
  return [
    ...FALLBACK.map(([id, name, contextWindow, outputLimit, free]) =>
      mapping(id, name, { contextWindow, outputLimit, free }),
    ),
    extraModel(),
  ]
}

function catalogRow(row: Record<string, unknown>, id: string): ModelMapping {
  const reasoningLevels =
    Array.isArray(row.supported_reasoning_levels) ?
      (row.supported_reasoning_levels as Array<unknown>)
    : []
  const efforts = reasoningLevels.flatMap((item) => {
    const effort = asTrimmedString(asRecord(item)?.effort)
    return effort ? [effort] : []
  })
  const badge = asRecord(asRecord(row.badge)?.text)?.en
  return mapping(
    id,
    asTrimmedString(row.display_name) ?? id,
    {
      contextWindow: asNumber(row.context_window),
      outputLimit: asNumber(row.max_output_tokens) ?? 32768,
      supportsImages:
        Array.isArray(row.input_modalities)
        && row.input_modalities.includes("image"),
      reasoning: efforts.some((effort) => effort !== "none"),
      free: badge === "Free",
    },
    efforts.length ? efforts : undefined,
  )
}

export async function discoverStudioModels(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<ModelMapping>> {
  const token = getConnectionOAuthAccessToken(connection)
  if (!token) return []
  const response = await oauthFetch(
    `${ASTUDIO_MODEL_ORIGIN}/api/v1/model-manager/models`,
    {
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal:
        signal ?
          AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    },
    { proxyUrl: getConnectionProxyUrl(connection) },
  )
  if (!response.ok)
    throw new Error(
      `Astron Studio model catalog returned HTTP ${response.status}`,
    )
  const data = asRecord(asRecord(await response.json())?.data)
  if (!Array.isArray(data?.models))
    throw new Error("Invalid Astron Studio model catalog")
  const seen = new Set<string>()
  const models: Array<ModelMapping> = []
  for (const value of data.models as Array<unknown>) {
    const row = asRecord(value)
    const id = asTrimmedString(row?.slug)
    if (!row || !id) throw new Error("Invalid Astron Studio model entry")
    if (seen.has(id)) continue
    seen.add(id)
    if (row.visibility !== "hidden" && row.supported_in_api !== false)
      models.push(catalogRow(row, id))
  }
  const extra = extraModel()
  if (!seen.has(extra.upstreamId)) models.push(extra)
  return models
}
