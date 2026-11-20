import { isRecord } from "~/lib/json-shape"
import {
  getConnectionProxyUrl,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  InkstoneRequestError,
  nonnegative,
  readApiModels,
  readPublicModels,
} from "~/services/inkstone/client"

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined
}

function strings(value: unknown): Array<string> | undefined {
  return Array.isArray(value) ?
      value.filter((item): item is string => typeof item === "string")
    : undefined
}

function positive(value: unknown): number | undefined {
  return nonnegative(value) || undefined
}

function publicById(
  payload: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const { data } = payload
  const rows =
    Array.isArray(data) ? data : (
      ((isRecord(data) ? data.models : undefined) ?? payload.models)
    )
  const result = new Map<string, Record<string, unknown>>()
  if (!Array.isArray(rows)) return result
  for (const row of rows) {
    const id = isRecord(row) && text(row.id)
    if (id) result.set(id, row as Record<string, unknown>)
  }
  return result
}

function chatMapping(
  id: string,
  live: Record<string, unknown>,
  meta?: Record<string, unknown>,
): ModelMapping | undefined {
  const protocols = strings(meta?.supported_protocols)
  if (
    id.toLowerCase() === "intern-decision-4b"
    || meta?.model_type === "decision"
    || (protocols?.length && !protocols.includes("openai_chat"))
  )
    return undefined

  const inputPrice = nonnegative(meta?.input_uncached_price)
  const outputPrice = nonnegative(meta?.output_price)
  const inputs = strings(meta?.input_types)
    ?? strings(live.input_modalities ?? live.inputModalities) ?? ["text"]
  const features =
    strings(live.supported_features ?? live.supportedFeatures) ?? []
  const caps = [
    ...(strings(meta?.capabilities) ?? []),
    ...(strings(meta?.capabilities_en) ?? []),
  ]
  return {
    publicId: id,
    upstreamId: id,
    name: text(meta?.display_name) ?? text(meta?.display_name_en) ?? id,
    vendor: "inkstone",
    endpoints: ["chat"],
    enabled: true,
    metadata: {
      contextWindow:
        positive(meta?.context_length)
        ?? positive(live.context_length ?? live.contextLength)
        ?? 262_144,
      maxOutputTokens:
        positive(
          live.max_output_length
            ?? live.maxOutputLength
            ?? live.max_output_tokens,
        ) ?? 32_768,
      inputModalities: inputs,
      supportsVision: inputs.includes("image"),
      supportsReasoning:
        meta ?
          caps.includes("深度思考") || caps.includes("Reasoning")
        : features.includes("reasoning"),
      supportsTools:
        meta ?
          caps.includes("工具调用") || caps.includes("Tool calling")
        : features.includes("tools"),
      ...(inputPrice !== undefined
        && outputPrice !== undefined && {
          isFree: inputPrice === 0 && outputPrice === 0,
        }),
      ...(inputPrice !== undefined
        && inputPrice > 0 && { rate: Math.round(inputPrice / 100) / 10 }),
    },
  }
}

export async function discoverInkstoneModels(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<ModelMapping>> {
  const credential = connection.credentials.find((item) => item.enabled)
  if (!credential?.value) return []
  const options = { proxyUrl: getConnectionProxyUrl(connection), signal }
  const [live, publicModels] = await Promise.allSettled([
    readApiModels(credential.value, options),
    readPublicModels(options),
  ])
  signal?.throwIfAborted()
  if (live.status === "rejected") {
    if (
      live.reason instanceof InkstoneRequestError
      && (live.reason.status === 401 || live.reason.status === 403)
    )
      return []
    throw live.reason
  }
  const { data } = live.value
  if (!Array.isArray(data))
    throw new Error("InkStone returned an invalid authorized model list.")
  const metadata =
    publicModels.status === "fulfilled" ?
      publicById(publicModels.value)
    : new Map<string, Record<string, unknown>>()
  const found = new Map<string, ModelMapping>()
  for (const row of data) {
    if (!isRecord(row)) continue
    const id = text(row.id) ?? text(row.model_id)
    if (!id) continue
    const model = chatMapping(id, row, metadata.get(id))
    if (model) found.set(id, model)
  }
  return [...found.values()]
}
