import type { ProviderId } from "~/lib/provider-config"
import type { User } from "~/lib/users"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { CACHE_UTILIZATION_DEFAULTS } from "~/lib/routing/provider-cache"
import type { ModelAliasRule } from "~/lib/model-aliases"

interface CodebuffProviderDefaults {
  authToken?: string
  baseUrl: string
  cliVersion: string
  agentId: string
  model: string
  costMode: string
  allowFallbacks: boolean
}

interface WindsurfProviderDefaults {
  apiKey?: string
  baseUrl: string
  defaultModel: string
}

/**
 * L0 multi-account routing (CPA routing + codex.identity-confuse gate).
 *
 * Defaults target maximum prompt-cache utilization (see CACHE_UTILIZATION_DEFAULTS).
 * L1 provider rewrites are NOT configured here — they live in services/<provider>/.
 */
export interface RoutingConfig {
  strategy: "round-robin" | "fill-first" | "fillfirst" | "ff"
  sessionAffinity: boolean
  sessionAffinityTtlMs: number
  /** Codex-only L1. Requires sessionAffinity or fill-first. */
  identityConfuse: boolean
}

export interface State {
  // Multi-user support
  users: Array<User>

  // CLI/env global API key (--api-key / API_KEY) for legacy single-key mode
  legacyApiKey?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  providerDefaults: {
    codebuff: CodebuffProviderDefaults
    windsurf: WindsurfProviderDefaults
  }

  defaultProvider?: ProviderId

  routing: RoutingConfig

  manualApprove: boolean
  showToken: boolean
  adminPassword?: string
  adminSessionToken?: string
  adminSessionExpiresAt?: number
  modelAliases: Array<ModelAliasRule>
}

export const state: State = {
  users: [],
  accountType: "individual",
  providerDefaults: {
    codebuff: {
      baseUrl: "https://www.codebuff.com",
      cliVersion: "0.0.33",
      agentId: "base",
      model: "z-ai/glm-5.1",
      costMode: "normal",
      allowFallbacks: true,
    },
    windsurf: {
      baseUrl: "https://server.codeium.com",
      defaultModel: "swe-1-6-fast",
    },
  },
  // Max prompt-cache utilization defaults (fill-first + session affinity).
  routing: { ...CACHE_UTILIZATION_DEFAULTS },
  manualApprove: false,
  showToken: false,
  modelAliases: [],
}
