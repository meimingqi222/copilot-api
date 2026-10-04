import type { ModelAliasRule } from "~/lib/model-aliases"
import type { ModelsResponse } from "~/lib/model-catalog"
import type { User } from "~/lib/users"

import { CACHE_UTILIZATION_DEFAULTS } from "~/lib/routing/provider-cache"

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
 * L0 凭据选路策略。
 *
 * - `fill-first`：稳定 id 排序取第一个（手动选择的固定填充策略）。
 * - `round-robin`：按 connectionWeight/credentialWeight 加权轮转。
 * - `quota`（默认）：额度感知——同优先级层内按 allowance 使用率分档，优先用掉
 *   即将重置的额度。
 * - `least-used`：先按 allowance 使用率、再按近期 served tokens 升序。
 */
type RoutingStrategy =
  | "round-robin"
  | "fill-first"
  | "fillfirst"
  | "ff"
  | "quota"
  | "least-used"

/**
 * 会话亲和模式。
 *
 * - `session`（默认，现状）：按 session 粘到同一 connection/credential。
 * - `turn`：只在同一对话 turn 内粘，跨 turn 释放重选。
 * - `auto`：仅当上一次应答的 `cacheRead ≥ 1024` 且距上次 ≤ 5min（缓存未冷）
 *   才跨 turn 保持绑定，否则释放。
 * - `off`：关闭亲和。
 */
export type AffinityMode = "session" | "turn" | "auto" | "off"

/**
 * L0 multi-account routing (CPA routing + codex.identity-confuse gate).
 *
 * Defaults balance quota and prompt-cache reuse (see CACHE_UTILIZATION_DEFAULTS).
 * L1 provider rewrites are NOT configured here — they live in services/<provider>/.
 */
interface RoutingConfig {
  strategy: RoutingStrategy
  sessionAffinity: boolean
  /** Affinity stickiness mode; overrides `sessionAffinity` when `off`. */
  affinity: AffinityMode
  sessionAffinityTtlMs: number
  /** Codex-only L1. Requires sessionAffinity or fill-first. */
  identityConfuse: boolean
  /** Share of an allowance past which an account is "low" (kept for backup). */
  quotaLowShare?: number
  /** Share past which an account is all but used up (last resort only). */
  quotaSpentShare?: number
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

  routing: RoutingConfig

  manualApprove: boolean
  showToken: boolean
  adminPassword?: string
  adminSessionToken?: string
  adminSessionExpiresAt?: number
  /** Short-lived pre-auth token for the TOTP second step (single admin). */
  adminTotpLogin?: { token: string; expiresAt: number }
  /** Pending TOTP secret awaiting confirmation (setup flow). */
  adminTotpSetup?: { secret: string; expiresAt: number }
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
  // Quota-aware same-model routing with session affinity.
  routing: { ...CACHE_UTILIZATION_DEFAULTS },
  manualApprove: false,
  showToken: false,
  modelAliases: [],
}
