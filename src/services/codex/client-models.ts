import type { Model } from "~/lib/model-catalog"

import { listProviderConnections } from "~/lib/provider-connections"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import fallbackCatalog from "~/services/codex/client-models-fallback.json"

type CodexClientModel = Record<string, unknown>

// Capability-only CPA snapshot; refreshed catalogs retain their complete prompts.
const templates = new Map<string, CodexClientModel>(
  fallbackCatalog.models.map((entry) => [entry.slug, entry]),
)
const discoveredCatalogs = new Map<string, Map<string, CodexClientModel>>()

interface NativeModelSource {
  connectionId: string
  nativeId: string
}

export function resetCodexClientModelsForTest(): void {
  discoveredCatalogs.clear()
}

/** Retain native metadata before model discovery projects it into AccountModel. */
export function rememberCodexClientModels(
  connectionId: string,
  entries: Array<unknown>,
): void {
  const catalog = new Map<string, CodexClientModel>()
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const entry = raw as CodexClientModel
    if (typeof entry.slug !== "string" || !entry.slug.trim()) continue
    const id = canonicalNativeModelId(entry.slug)
    catalog.set(id, entry)
  }
  discoveredCatalogs.set(connectionId, catalog)
}

function nativeCodexModelIds(): Map<string, NativeModelSource> {
  const ids = new Map<string, NativeModelSource>()
  const allConnections = listProviderConnections()
  const activeIds = new Set(allConnections.map((connection) => connection.id))
  for (const id of discoveredCatalogs.keys()) {
    if (!activeIds.has(id)) discoveredCatalogs.delete(id)
  }
  const connections = allConnections
    .filter(
      (connection) =>
        connection.protocol === "codex-native"
        && connection.enabled
        && connection.credentials.some((credential) => credential.enabled),
    )
    .sort((left, right) => left.priority - right.priority)
  for (const connection of connections) {
    for (const mapping of connection.models ?? []) {
      if (mapping.enabled && !ids.has(mapping.publicId)) {
        ids.set(mapping.publicId, {
          connectionId: connection.id,
          nativeId: canonicalNativeModelId(mapping.upstreamId),
        })
      }
    }
  }
  return ids
}

function genericModel(model: Model): CodexClientModel {
  const efforts = model.capabilities.supports.reasoning_effort ?? []
  return {
    slug: model.id,
    display_name: model.name,
    description: null,
    default_reasoning_level: efforts[0] ?? null,
    supported_reasoning_levels: efforts.map((effort) => ({
      effort,
      description: effort,
    })),
    shell_type: "shell_command",
    visibility: model.model_picker_enabled ? "list" : "hide",
    supported_in_api: true,
    priority: 100,
    availability_nux: null,
    upgrade: null,
    base_instructions:
      "You are Codex, a coding agent. You and the user share one workspace.",
    model_messages: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "bytes", limit: 10000 },
    context_window:
      model.capabilities.limits?.max_context_window_tokens ?? null,
    experimental_supported_tools: [],
    auto_review_model_override: null,
  }
}

function clientModel(
  model: Model,
  nativeIds: Map<string, NativeModelSource>,
): CodexClientModel {
  if (model.capabilities.family !== "codex") return genericModel(model)
  const source = nativeIds.get(model.id)
  const nativeId = source?.nativeId ?? canonicalNativeModelId(model.id)
  const discovered =
    source ?
      discoveredCatalogs.get(source.connectionId)?.get(nativeId)
    : undefined
  const template = { ...templates.get(nativeId), ...discovered }
  return {
    ...genericModel(model),
    ...structuredClone(template),
    slug: model.id,
    display_name: model.name,
    supported_in_api: true,
    visibility:
      model.model_picker_enabled ? (template.visibility ?? "list") : "hide",
  }
}

function isTextModel(model: Model): boolean {
  return (model.supported_endpoints ?? []).some((endpoint) =>
    ["responses", "chat/completions", "messages", "generateContent"].some(
      (wire) => endpoint.includes(wire),
    ),
  )
}

function sanitizeReasoningLevels(
  entry: CodexClientModel,
  legacyClient: boolean,
): void {
  const allowed = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])
  if (!legacyClient) {
    allowed.add("max")
    allowed.add("ultra")
  }
  const rawLevels: Array<unknown> =
    Array.isArray(entry.supported_reasoning_levels) ?
      entry.supported_reasoning_levels
    : []
  const levels = rawLevels.filter((raw): raw is Record<string, unknown> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
    const effort = (raw as Record<string, unknown>).effort
    return typeof effort === "string" && allowed.has(effort)
  })
  entry.supported_reasoning_levels = levels
  if (!levels.some((level) => level.effort === entry.default_reasoning_level)) {
    entry.default_reasoning_level = levels[0]?.effort ?? null
  }
}

/** CPA-compatible catalog, built only from models already filtered for this user. */
export function buildCodexClientModelsResponse(
  models: Array<Model>,
  clientVersion: string,
): { models: Array<CodexClientModel> } {
  const nativeIds = nativeCodexModelIds()
  const entries = models
    .filter(isTextModel)
    .map((model) => clientModel(model, nativeIds))
  // max/ultra were added in CLI 0.144.0; older clients reject the whole catalog.
  const version = clientVersion.match(/^(\d+)\.(\d+)\.(\d+)/)
  const legacyClient =
    !!version && Number(version[1]) === 0 && Number(version[2]) < 144
  for (const entry of entries) sanitizeReasoningLevels(entry, legacyClient)
  return { models: entries }
}
