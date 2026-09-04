import type { Account, AccountModel } from "~/lib/legacy-accounts"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { getWindsurfSettings } from "~/lib/legacy-accounts"
import {
  getConnectionSettings,
  getConnectionWindsurfApiKey,
} from "~/lib/provider-connections"
import { readResponseBytes } from "~/lib/request-body"
import { state } from "~/lib/state"

import { normalizeWindsurfBaseUrl } from "./base-url"
import {
  buildWindsurfClientMetadata,
  wrapWindsurfMetadataMessage,
} from "./metadata"
import { type ProtobufNode, parseMessage, walkNodes } from "./protobuf"

function buildGetUserStatusRequest(apiKey: string): Uint8Array {
  return wrapWindsurfMetadataMessage(buildWindsurfClientMetadata(apiKey))
}

const WINDSURF_SUPPORTED_ENDPOINTS = ["/chat/completions", "/v1/messages"]

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

export function extractWindsurfModelsFromPayload(
  payload: Uint8Array,
): Array<AccountModel> {
  const rows = walkNodes(parseMessage(payload))
  const vendorByDisplayName = extractProviderDisplayMap(rows)
  const models = new Map<string, AccountModel>()

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

    if (!publicId || models.has(publicId)) {
      continue
    }

    models.set(publicId, {
      id: publicId,
      name: displayName,
      vendor: vendorByDisplayName.get(displayName) ?? inferVendor(displayName),
      pickerEnabled: true,
      supportedEndpoints: WINDSURF_SUPPORTED_ENDPOINTS,
      provider: "windsurf",
      upstreamId,
    })
  }

  return Array.from(models.values())
}

export async function getWindsurfModelsForAccount(
  account: Account,
): Promise<Array<AccountModel>> {
  const settings = getWindsurfSettings(account)
  if (!settings) {
    return []
  }
  const apiKey = settings.apiKey
  if (!apiKey) {
    return fallbackWindsurfModels(settings.defaultModel ?? "")
  }

  const baseUrl = normalizeWindsurfBaseUrl(settings.baseUrl)
  const response = await fetch(
    `${baseUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        "Connect-Protocol-Version": "1",
        "User-Agent": "connect-go/1.18.1 (go1.26.3)",
        "Accept-Encoding": "gzip",
        "Connect-Timeout-Ms": "5000",
      },
      body: buildGetUserStatusRequest(apiKey),
    },
  )

  if (!response.ok) {
    throw new HTTPError(
      "Failed to fetch Windsurf model catalog",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  const models = extractWindsurfModelsFromPayload(
    await readResponseBytes(response, 16 * 1024 * 1024),
  )
  return models.length > 0 ?
      models
    : fallbackWindsurfModels(settings.defaultModel ?? "")
}

export function fallbackWindsurfModels(
  defaultModel: string,
): Array<AccountModel> {
  return [
    {
      id: defaultModel,
      name: defaultModel,
      vendor: "Windsurf",
      pickerEnabled: true,
      supportedEndpoints: WINDSURF_SUPPORTED_ENDPOINTS,
      provider: "windsurf",
      upstreamId: defaultModel,
    },
  ]
}

// ── Connection 原生版本 ───────────────────────────────────────

const WINDSURF_CONNECTION_ENDPOINTS: Array<ModelMapping["endpoints"][number]> =
  ["chat", "messages"]

function accountModelsToMappings(
  models: Array<AccountModel>,
): Array<ModelMapping> {
  return models.map((m) => ({
    publicId: m.id,
    upstreamId: m.upstreamId || m.id,
    name: m.name,
    vendor: m.vendor,
    enabled: true,
    pickerEnabled: m.pickerEnabled,
    pickerCategory: m.pickerCategory,
    endpoints: WINDSURF_CONNECTION_ENDPOINTS,
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
      endpoints: WINDSURF_CONNECTION_ENDPOINTS,
    },
  ]
}

/**
 * Connection 原生版本:从 connection 的 settings + credential 读取 windsurf 配置。
 */
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

  const baseUrl = normalizeWindsurfBaseUrl(settings?.baseUrl)
  const response = await fetch(
    `${baseUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        "Connect-Protocol-Version": "1",
        "User-Agent": "connect-go/1.18.1 (go1.26.3)",
        "Accept-Encoding": "gzip",
        "Connect-Timeout-Ms": "5000",
      },
      body: buildGetUserStatusRequest(apiKey),
    },
  )

  if (!response.ok) {
    throw new HTTPError(
      "Failed to fetch Windsurf model catalog",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  const accountModels = extractWindsurfModelsFromPayload(
    await readResponseBytes(response, 16 * 1024 * 1024),
  )
  if (accountModels.length > 0) {
    return accountModelsToMappings(accountModels)
  }
  return fallbackWindsurfConnectionModels(defaultModel ?? "")
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
