import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { getConnectionOAuthAccessToken } from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { getXaiFallbackModels } from "~/services/providers/model-catalogs/xai"
import { xaiChatBaseUrl, xaiUsesApi } from "~/services/xai/endpoint"
import { getXaiCatalogHints } from "~/services/xai/model-metadata"
import { buildXaiHeaders } from "~/services/xai/headers"

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function capacityMetadata(entry: object) {
  const metadata: Record<string, unknown> = {}
  const context = "context_window" in entry ? entry.context_window : undefined
  const windows =
    "context_windows" in entry && Array.isArray(entry.context_windows) ?
      [...new Set(entry.context_windows.filter(positiveFinite))].sort(
        (left, right) => left - right,
      )
    : []
  if (positiveFinite(context)) {
    metadata.contextWindow = context
    const maximum = windows.at(-1)
    if (maximum !== undefined && maximum > context) {
      metadata.maxContextWindow = maximum
    }
  }
  if (windows.length > 0) metadata.contextWindows = windows
  if ("max_output_tokens" in entry && positiveFinite(entry.max_output_tokens)) {
    metadata.outputLimit = entry.max_output_tokens
  }
  return Object.keys(metadata).length > 0 ? { metadata } : {}
}

function parseXaiModels(payload: unknown): Array<ModelMapping> {
  if (
    !payload
    || typeof payload !== "object"
    || !("data" in payload)
    || !Array.isArray(payload.data)
  ) {
    throw new Error("xAI models response did not include a model list")
  }
  const endpointsById = new Map(
    getXaiFallbackModels().map((model) => [model.publicId, model.endpoints]),
  )
  const models: Array<ModelMapping> = []
  const seen = new Set<string>()
  for (const entry of payload.data as Array<unknown>) {
    if (
      !entry
      || typeof entry !== "object"
      || !("id" in entry)
      || typeof entry.id !== "string"
      || !entry.id.trim()
    )
      continue
    // The native adapter sends Responses requests. Do not advertise chat-only models.
    if (
      "api_backend" in entry
      && entry.api_backend
      && entry.api_backend !== "responses"
    )
      continue
    const id = entry.id.trim()
    const publicId = canonicalNativeModelId(id)
    if (seen.has(publicId)) continue
    seen.add(publicId)
    const levels = getXaiCatalogHints(id).reasoningLevels
    models.push({
      publicId,
      upstreamId: id,
      name:
        "name" in entry && typeof entry.name === "string" && entry.name.trim() ?
          entry.name.trim()
        : id,
      vendor: "xai",
      enabled: true,
      pickerEnabled: true,
      endpoints: endpointsById.get(publicId) ?? ["responses"],
      ...(levels && levels.length > 0 ? { efforts: [...levels] } : {}),
      ...capacityMetadata(entry),
    })
  }
  if (models.length === 0) throw new Error("xAI listed no Responses models")
  return models
}

/** Fetch the authenticated /models catalog used by Grok Build. */
export async function getXaiModelsForConnection(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<ModelMapping>> {
  const token = getConnectionOAuthAccessToken(connection)
  if (!token) throw new Error("xAI model discovery requires an access token")
  const baseUrl = xaiChatBaseUrl(connection).replace(/\/+$/, "")
  const response = await fetchWithConnectionProxy(
    connection,
    `${baseUrl}/models`,
    {
      method: "GET",
      headers: buildXaiHeaders(
        token,
        false,
        undefined,
        !xaiUsesApi(connection),
        connection.headers,
      ),
      signal,
    },
  )
  if (!response.ok) {
    throw new HTTPError(
      "xAI model discovery failed",
      response,
      await response.text(),
    )
  }
  const models = parseXaiModels(await response.json())
  // Media uses the separate official API; the CLI catalog only lists Responses.
  // Keep its mappings, and keep compatibility aliases only while their target is live.
  const liveIds = new Set(models.map((model) => model.upstreamId))
  const publicIds = new Set(models.map((model) => model.publicId))
  const retained = getXaiFallbackModels().filter(
    (model) =>
      !publicIds.has(model.publicId)
      && (model.endpoints.some(
        (endpoint) => endpoint === "images" || endpoint === "videos",
      )
        || (model.publicId !== model.upstreamId
          && liveIds.has(model.upstreamId))),
  )
  return [...models, ...retained]
}
