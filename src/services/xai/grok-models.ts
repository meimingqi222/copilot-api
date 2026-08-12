import type { Model } from "~/services/copilot/get-models"

import { getXaiCatalogHints } from "./model-metadata"

/** Grok Shell / Grok Build client User-Agent detection (CPA IsGrokShellUserAgent). */
export function isGrokShellUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) return false
  return userAgent.toLowerCase().includes("grok-shell")
}

export interface GrokShellReasoningEffort {
  value: string
}

/** Single model entry formatted for Grok Shell (CPA grokbuild.ModelEntry). */
export interface GrokShellModelEntry {
  id: string
  model: string
  name: string
  context_window?: number
  api_backend: "responses"
  supported_in_api: true
  reasoning_efforts?: Array<GrokShellReasoningEffort>
}

export interface GrokShellModelsResponse {
  object: "list"
  data: Array<GrokShellModelEntry>
}

/**
 * Build the Grok Shell `/v1/models` envelope from our public model list.
 * Mirrors CPA `grokbuild.BuildResponse`.
 */
export function buildGrokShellModelsResponse(
  models: Array<Model>,
): GrokShellModelsResponse {
  return {
    object: "list",
    data: models.map((model) => toGrokShellModelEntry(model)),
  }
}

function toGrokShellModelEntry(model: Model): GrokShellModelEntry {
  const name = model.name.trim() || model.id
  // Live cache often only sets supports.streaming; fall back to CPA xAI
  // registry hints so Grok Shell still gets thinking levels / context.
  const hints = getXaiCatalogHints(model.id)
  const contextWindow =
    model.capabilities.limits?.max_context_window_tokens ?? hints.contextWindow
  const reasoningLevels =
    model.capabilities.supports.reasoning_effort ?? hints.reasoningLevels ?? []

  const efforts: Array<GrokShellReasoningEffort> = []
  for (const level of reasoningLevels) {
    const trimmed = level.trim()
    if (trimmed) {
      efforts.push({ value: trimmed })
    }
  }

  const entry: GrokShellModelEntry = {
    id: model.id,
    model: model.id,
    name,
    api_backend: "responses",
    supported_in_api: true,
  }

  if (typeof contextWindow === "number" && contextWindow > 0) {
    entry.context_window = contextWindow
  }
  if (efforts.length > 0) {
    entry.reasoning_efforts = efforts
  }

  return entry
}
