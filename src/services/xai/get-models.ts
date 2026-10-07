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
import { buildXaiHeaders } from "~/services/xai/headers"

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
