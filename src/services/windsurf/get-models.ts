import { createHash } from "node:crypto"
import { logger } from "~/lib/logger"
import type { AccountModel } from "~/lib/provider-connections"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import {
  getConnectionSettings,
  getConnectionWindsurfApiKey,
} from "~/lib/provider-connections"
import { readResponseBytes } from "~/lib/request-body"
import { state } from "~/lib/state"
import { oauthFetch } from "~/services/oauth/fetch"
import { getConnectionProxyUrl } from "~/lib/provider-connections"

import { normalizeWindsurfBaseUrl } from "~/services/windsurf/base-url"
import {
  buildWindsurfClientMetadata,
  WINDSURF_CONNECT_USER_AGENT,
  WINDSURF_EDITOR_IDENTITY,
  wrapWindsurfMetadataMessage,
} from "~/services/windsurf/metadata"
import {
  ProtobufEncoder,
  type ProtobufNode,
  parseMessage,
  walkNodes,
} from "~/services/windsurf/protobuf"
import {
  collapseWindsurfModelVariants,
  type RawWindsurfCatalogEntry,
} from "~/services/windsurf/variant-collapse"

function buildGetUserStatusRequest(apiKey: string): Uint8Array {
  return wrapWindsurfMetadataMessage(
    buildWindsurfClientMetadata(apiKey, undefined, WINDSURF_EDITOR_IDENTITY),
  )
}

function decodeBest(raw: Uint8Array): string | undefined {
  let bestText: string | undefined
  let bestScore: number | undefined

  for (const encoding of ["utf8", "gb18030", "latin1"] as const) {
    try {
      const text =
        encoding === "latin1" ?
          Buffer.from(raw).toString("latin1")
        : decodeText(raw, encoding)
      const printable = Array.from(text).filter(
        (char) =>
          /[\p{L}\p{N}\p{P}\p{Zs}]/u.test(char) || "\n\r\t".includes(char),
      ).length
      const cjk = Array.from(text).filter(
        (char) => char >= "\u4e00" && char <= "\u9fff",
      ).length
      const replacement = text.split("\ufffd").length - 1
      const score = printable + cjk * 3 - replacement * 5

      if (bestScore === undefined || score > bestScore) {
        bestScore = score
        bestText = text
      }
    } catch {
      continue
    }
  }

  return bestText?.trim() || undefined
}

function decodeText(raw: Uint8Array, encoding: "utf8" | "gb18030"): string {
  return new TextDecoder(
    encoding as ConstructorParameters<typeof TextDecoder>[0],
  ).decode(raw)
}

function getTextValues(
  rows: Array<{ path: string; node: ProtobufNode }>,
  paths: Array<string>,
): Array<string> {
  const targets = new Set(paths)
  const values: Array<string> = []
  for (const { path, node } of rows) {
    if (targets.has(path) && node.wire === 2 && node.raw) {
      const decoded = decodeBest(node.raw)
      if (decoded) values.push(decoded)
    }
  }
  return values
}

function firstTextValue(
  rows: Array<{ path: string; node: ProtobufNode }>,
  paths: Array<string>,
): string | undefined {
  return getTextValues(rows, paths)[0]
}

function isOpaqueWindsurfModelId(modelId: string): boolean {
  return /^MODEL(?:_PRIVATE)?_/i.test(modelId)
}

function slugifyModelId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9.-]+/g, "-")
    .replaceAll(/-{2,}/g, "-")
    .replaceAll(/^-+|-+$/g, "")
}

function derivePublicModelId(opts: {
  displayName: string
  directModelId?: string
  baseModelId?: string
  baseDisplayName?: string
}): string {
  const { displayName, directModelId, baseModelId, baseDisplayName } = opts
  if (directModelId && !isOpaqueWindsurfModelId(directModelId)) {
    return slugifyModelId(directModelId)
  }

  if (baseModelId && !isOpaqueWindsurfModelId(baseModelId)) {
    const baseId = slugifyModelId(baseModelId)
    const suffix =
      baseDisplayName && displayName.startsWith(baseDisplayName) ?
        displayName.slice(baseDisplayName.length).trim()
      : ""
    return suffix ? `${baseId}-${slugifyModelId(suffix)}` : baseId
  }

  return slugifyModelId(displayName)
}

function inferVendor(displayName: string): string {
  if (
    /^(?:SWE-|Adaptive|Frontier Arena|Fast Arena|Hybrid Arena)/i.test(
      displayName,
    )
  ) {
    return "Windsurf"
  }
  if (/^Claude\b/i.test(displayName)) {
    return "Anthropic"
  }
  if (/^(?:GPT|o1|o3|o4|ChatGPT)\b/i.test(displayName)) {
    return "OpenAI"
  }
  if (/^Gemini\b/i.test(displayName)) {
    return "Google"
  }
  if (/^(?:xAI|Grok)\b/i.test(displayName)) {
    return "xAI"
  }
  return "Other"
}

function extractProviderDisplayMap(
  rows: Array<{ path: string; node: ProtobufNode }>,
): Map<string, string> {
  const vendorByDisplayName = new Map<string, string>()

  for (const { path, node } of rows) {
    if (path !== "/1/33/2" || !node.sub) {
      continue
    }

    const facetRows = walkNodes(node.sub)
    if (firstTextValue(facetRows, ["/1"]) !== "Provider") {
      continue
    }

    for (const group of node.sub.filter(
      (child) => child.field === 2 && child.wire === 2 && Boolean(child.sub),
    )) {
      const groupRows = walkNodes(group.sub as Array<ProtobufNode>)
      const vendor = firstTextValue(groupRows, ["/1"])
      if (!vendor) {
        continue
      }

      for (const displayName of getTextValues(groupRows, ["/2"])) {
        vendorByDisplayName.set(displayName, vendor)
      }
    }
  }

  return vendorByDisplayName
}

const WINDSURF_CONNECTION_ENDPOINTS: Array<ModelMapping["endpoints"][number]> =
  ["chat", "messages"]

export function extractWindsurfModelsFromPayload(
  payload: Uint8Array,
): Array<AccountModel> {
  // Account-facing view lists only head models; hidden variants stay routable
  // via connection.models but are not part of this snapshot.
  return modelMappingsToAccountModels(
    extractWindsurfModelMappingsFromPayload(payload).filter((m) => !m.hidden),
  )
}

/**
 * Extract + collapse catalog entries into family-level ModelMappings.
 * Thinking-effort siblings fold into one mapping; 1M context stays a
 * separate public model (plan C).
 */
export function extractWindsurfModelMappingsFromPayload(
  payload: Uint8Array,
): Array<ModelMapping> {
  const rows = walkNodes(parseMessage(payload))
  const vendorByDisplayName = extractProviderDisplayMap(rows)
  const entries = new Map<string, RawWindsurfCatalogEntry>()
  const details = new Map<string, Record<string, unknown>>()

  for (const { path, node } of rows) {
    if (path !== "/1/33/1" || !node.sub) {
      continue
    }

    const entryRows = walkNodes(node.sub)
    const displayName = firstTextValue(entryRows, ["/1"])
    if (!displayName) {
      continue
    }

    const upstreamId =
      firstTextValue(entryRows, ["/22", "/23/17", "/23/23"]) ?? displayName
    const baseModelId = firstTextValue(entryRows, ["/23/23"])
    const baseDisplayName = firstTextValue(entryRows, ["/30/1"])
    const publicId = derivePublicModelId({
      displayName,
      directModelId: upstreamId,
      baseModelId,
      baseDisplayName,
    })

    if (!publicId || entries.has(publicId)) {
      continue
    }

    const numberAt = (path: string) =>
      entryRows.find((row) => row.path === path && row.node.wire === 0)?.node
        .varint
    details.set(upstreamId, {
      supportsImages: Number(numberAt("/5") ?? 0) !== 0,
      contextWindow: Number(numberAt("/18") ?? 0),
      outputLimit: Number(numberAt("/23/13") ?? 0),
    })
    entries.set(publicId, {
      publicId,
      name: displayName,
      upstreamId,
      vendor: vendorByDisplayName.get(displayName) ?? inferVendor(displayName),
      pickerEnabled: true,
      endpoints: [...WINDSURF_CONNECTION_ENDPOINTS],
      baseModelId,
      baseDisplayName,
    })
  }

  if (entries.size === 0) return []
  return collapseWindsurfModelVariants(Array.from(entries.values())).map(
    (model) => ({
      ...model,
      metadata: { ...model.metadata, ...details.get(model.upstreamId) },
    }),
  )
}

function modelMappingsToAccountModels(
  mappings: Array<ModelMapping>,
): Array<AccountModel> {
  return mappings.map((m) => ({
    id: m.publicId,
    name: m.name ?? m.publicId,
    vendor: m.vendor ?? "Other",
    pickerEnabled: m.pickerEnabled ?? true,
    pickerCategory: m.pickerCategory,
    supportedEndpoints: m.endpoints.map((endpoint) =>
      endpointToSupportedPath(endpoint),
    ),
    provider: "windsurf",
    upstreamId: m.upstreamId || m.publicId,
  }))
}

/** The CLI publishes the same ClientModelConfig messages directly in field 1. */
export function extractDevinCliModelMappingsFromPayload(
  payload: Uint8Array,
): Array<ModelMapping> {
  const catalog = new ProtobufEncoder()
  for (const node of parseMessage(payload)) {
    if (node.field !== 1 || !node.raw) continue
    const rows = walkNodes(parseMessage(node.raw))
    const id = firstTextValue(rows, ["/22"])
    if (!id) continue
    const family = firstTextValue(rows, ["/23/23", "/30/1", "/1"]) ?? id
    if (/^(adaptive|fusion)$/i.test(family)) continue
    catalog.writeBytes(1, node.raw)
  }
  const status = new ProtobufEncoder()
  status.writeMessage(33, catalog)
  const response = new ProtobufEncoder()
  response.writeMessage(1, status)
  return extractWindsurfModelMappingsFromPayload(response.toUint8Array())
}

function endpointToSupportedPath(
  endpoint: ModelMapping["endpoints"][number],
): string {
  switch (endpoint) {
    case "chat": {
      return "/chat/completions"
    }
    case "messages": {
      return "/v1/messages"
    }
    default: {
      return `/${endpoint}`
    }
  }
}

const CATALOG_SUCCESS_TTL_MS = 5 * 60_000
const CATALOG_FAILURE_TTL_MS = 60_000
const MAX_CATALOG_CACHE_ENTRIES = 256

type CatalogResult =
  | { models: Array<ModelMapping>; discovered: boolean }
  | { errorStatus: number }

const catalogCache = new Map<
  string,
  {
    expiresAt: number
    result: Promise<CatalogResult>
  }
>()

export function clearWindsurfModelCacheForTest(): void {
  catalogCache.clear()
}

export async function getWindsurfModelsForConnection(
  connection: ProviderConnection,
): Promise<Array<ModelMapping>> {
  const settings = getConnectionSettings(connection) as
    | { baseUrl?: string; defaultModel?: string }
    | undefined
  const apiKey = getConnectionWindsurfApiKey(connection)
  const defaultModel =
    settings?.defaultModel ?? state.providerDefaults.windsurf.defaultModel
  if (!apiKey) {
    return fallbackWindsurfConnectionModels(defaultModel ?? "")
  }

  const baseUrl = normalizeWindsurfBaseUrl(
    settings?.baseUrl || connection.baseUrl,
  )
  const proxyUrl = getConnectionProxyUrl(connection)
  // Hash the complete scope, including proxy credentials, rather than retain
  // any secret in a long-lived cache key. The cache itself is process-local.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        baseUrl,
        createHash("sha256").update(apiKey).digest("hex"),
        proxyUrl ?? "",
        defaultModel ?? "",
      ]),
    )
    .digest("hex")
  let cached = catalogCache.get(key)
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached) catalogCache.delete(key)
    if (catalogCache.size >= MAX_CATALOG_CACHE_ENTRIES) {
      const oldest = catalogCache.keys().next().value
      if (oldest !== undefined) catalogCache.delete(oldest)
    }
    const entry = {
      expiresAt: Number.POSITIVE_INFINITY,
      result: Promise.resolve<CatalogResult>({ errorStatus: 502 }),
    }
    entry.result = fetchWindsurfCatalog({
      apiKey,
      baseUrl,
      proxyUrl,
      defaultModel: defaultModel ?? "",
    })
      .catch((error: unknown): CatalogResult => {
        logger.debug(
          "Windsurf model discovery failed",
          error instanceof Error ? error.name : "unknown error",
        )
        // Cache only the failure status, never upstream bodies or credentials.
        return {
          errorStatus: error instanceof HTTPError ? error.response.status : 502,
        }
      })
      .then((result) => {
        entry.expiresAt =
          Date.now()
          + ("models" in result && result.discovered ?
            CATALOG_SUCCESS_TTL_MS
          : CATALOG_FAILURE_TTL_MS)
        return result
      })
    catalogCache.set(key, entry)
    cached = entry
  }
  const result = await cached.result
  if ("errorStatus" in result) {
    throw new HTTPError(
      "Failed to fetch Windsurf model catalog",
      new Response(null, { status: result.errorStatus }),
    )
  }
  // Callers mutate mappings during merge/persistence; never lend the cache's copy.
  return structuredClone(result.models)
}

async function fetchWindsurfCatalog({
  apiKey,
  baseUrl,
  proxyUrl,
  defaultModel,
}: {
  apiKey: string
  baseUrl: string
  proxyUrl?: string
  defaultModel: string
}): Promise<CatalogResult> {
  let rejectedStatus: number | undefined
  // Prefer the account-scoped current CLI catalog; legacy Enterprise seats
  // can expose only the editor's GetUserStatus catalog, so keep that fallback.
  try {
    const cliResponse = await oauthFetch(
      `${baseUrl}/exa.api_server_pb.ApiServerService/GetCliModelConfigs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/proto",
          "Connect-Protocol-Version": "1",
          "User-Agent": WINDSURF_CONNECT_USER_AGENT,
        },
        body: wrapWindsurfMetadataMessage(buildWindsurfClientMetadata(apiKey)),
        signal: AbortSignal.timeout(15_000),
      },
      { proxyUrl },
    )
    if (cliResponse.ok) {
      const models = extractDevinCliModelMappingsFromPayload(
        await readResponseBytes(cliResponse, 16 * 1024 * 1024),
      )
      if (models.length)
        return {
          models: collapsedMappingsToConnectionModels(models),
          discovered: true,
        }
    }
    if (cliResponse.status === 401 || cliResponse.status === 403)
      rejectedStatus = cliResponse.status
  } catch (error) {
    // Failed/unsupported CLI discovery must not hide legacy editor models.
    logger.debug(
      "Devin CLI catalog unavailable; trying the legacy editor catalog",
      error instanceof Error ? error.name : "unknown error",
    )
  }
  // Enterprise seats can publish their roster only to this editor identity.
  const response = await oauthFetch(
    `${baseUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        "Connect-Protocol-Version": "1",
        "User-Agent": WINDSURF_CONNECT_USER_AGENT,
        "Accept-Encoding": "gzip",
        "Connect-Timeout-Ms": "5000",
      },
      body: buildGetUserStatusRequest(apiKey),
      signal: AbortSignal.timeout(15_000),
    },
    { proxyUrl },
  )

  if (!response.ok) {
    throw new HTTPError(
      "Failed to fetch Windsurf model catalog",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  const collapsed = extractWindsurfModelMappingsFromPayload(
    await readResponseBytes(response, 16 * 1024 * 1024),
  )
  if (collapsed.length > 0) {
    return {
      models: collapsedMappingsToConnectionModels(collapsed),
      discovered: true,
    }
  }
  if (rejectedStatus) return { errorStatus: rejectedStatus }
  return {
    models: fallbackWindsurfConnectionModels(defaultModel),
    discovered: false,
  }
}

/**
 * Connection 原生 fallback models。
 */
export function fallbackWindsurfConnectionModelsForConnection(
  connection: ProviderConnection,
): Array<ModelMapping> {
  const settings = getConnectionSettings(connection) as
    | { defaultModel?: string }
    | undefined
  const defaultModel =
    settings?.defaultModel ?? state.providerDefaults.windsurf.defaultModel
  return fallbackWindsurfConnectionModels(defaultModel ?? "")
}

function collapsedMappingsToConnectionModels(
  mappings: Array<ModelMapping>,
): Array<ModelMapping> {
  return mappings.map((m) => ({
    ...m,
    enabled: true,
    endpoints: [...WINDSURF_CONNECTION_ENDPOINTS],
  }))
}

function fallbackWindsurfConnectionModels(
  defaultModel: string,
): Array<ModelMapping> {
  return [
    {
      publicId: defaultModel,
      upstreamId: defaultModel,
      name: defaultModel,
      vendor: "Windsurf",
      enabled: true,
      pickerEnabled: true,
      endpoints: [...WINDSURF_CONNECTION_ENDPOINTS],
    },
  ]
}
