/**
 * L1 provider-specific prompt-cache capabilities.
 *
 * Architecture (mirrors CPA):
 *   L0 routing (all providers): session-affinity, fill-first / round-robin,
 *     unified session extraction for credential stickiness only.
 *   L1 executor (per provider): rewrite upstream headers/body only with
 *     optimizations that provider understands. Never cross-apply.
 *
 * "Generic fallback" = pass through client-provided session keys when the
 * provider has no dedicated scheme; do not invent Codex/AG-specific formats.
 */

import type { ProviderId } from "~/lib/provider-config"

/** L1 features that may be applied when talking to a given provider. */
type ProviderCacheFeature =
  | "claude-session-header" // X-Claude-Code-Session-Id + per-cred stable UUID
  | "codex-session" // prompt_cache_key + Session_id (+ optional identity confuse)
  | "codex-reasoning-replay"
  | "codex-identity-confuse"
  | "antigravity-stable-session" // request.sessionId = -int64 hash
  | "antigravity-signature-cache"
  | "xai-conv-id" // x-grok-conv-id + prompt_cache_key
  | "xai-reasoning-replay"
  | "windsurf-cloud-session" // cascade_id / session_id / prompt_id buckets
  | "passthrough-client-session" // only forward client keys, no synthesis

interface ProviderCacheProfile {
  provider:
    | ProviderId
    | "openai-compatible"
    | "anthropic-compatible"
    | "generic"
  features: ReadonlyArray<ProviderCacheFeature>
  /**
   * When true, missing client session ids may be synthesized with a
   * provider-specific stable key (not a random UUID per request).
   */
  synthesizeStableSession: boolean
}

/**
 * Cache profiles keyed by native provider.
 * Connection protocols without a native provider profile use GENERIC_CACHE_PROFILE.
 */
const PROVIDER_CACHE_PROFILES: Record<ProviderId, ProviderCacheProfile> = {
  copilot: {
    provider: "copilot",
    // Copilot Messages path speaks Anthropic-style session headers.
    features: ["claude-session-header", "passthrough-client-session"],
    synthesizeStableSession: true,
  },
  claude: {
    provider: "claude",
    features: ["claude-session-header"],
    synthesizeStableSession: true,
  },
  codex: {
    provider: "codex",
    features: [
      "codex-session",
      "codex-reasoning-replay",
      "codex-identity-confuse",
      "passthrough-client-session",
    ],
    synthesizeStableSession: true,
  },
  antigravity: {
    provider: "antigravity",
    features: [
      "antigravity-stable-session",
      "antigravity-signature-cache",
      "passthrough-client-session",
    ],
    synthesizeStableSession: true,
  },
  xai: {
    provider: "xai",
    features: [
      "xai-conv-id",
      "xai-reasoning-replay",
      "passthrough-client-session",
    ],
    // Prefix-hash / isolated session when client omits keys (cache hits).
    synthesizeStableSession: true,
  },
  windsurf: {
    provider: "windsurf",
    features: ["windsurf-cloud-session", "passthrough-client-session"],
    synthesizeStableSession: true,
  },
  kimi: {
    provider: "kimi",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
  codebuff: {
    provider: "codebuff",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
  "mimo-aistudio": {
    provider: "mimo-aistudio",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
  codebuddy: {
    provider: "codebuddy",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
  "codebuddy-cn": {
    provider: "codebuddy-cn",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
  lobsterai: {
    provider: "lobsterai",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
  // MiniMax Code 的模型面是 Anthropic Messages，但上游是否认
  // X-Claude-Code-Session-Id / prompt_cache_key 未实测，所以不伪造会话键，
  // 只透传客户端自己带来的（generic L0 行为）。
  minimax: {
    provider: "minimax",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
  // Qoder 的私有 SSE 协议未实测是否认会话键，不伪造：只透传客户端带来的。
  qoder: {
    provider: "qoder",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
  factory: {
    provider: "factory",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
  zcode: {
    provider: "zcode",
    features: ["claude-session-header", "passthrough-client-session"],
    synthesizeStableSession: false,
  },
  "commandcode-plan": {
    provider: "commandcode-plan",
    features: ["claude-session-header", "passthrough-client-session"],
    synthesizeStableSession: false,
  },
  zed: {
    provider: "zed",
    features: ["claude-session-header", "passthrough-client-session"],
    synthesizeStableSession: false,
  },
  dimagent: {
    provider: "dimagent",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
  gemini: {
    provider: "gemini",
    features: ["passthrough-client-session"],
    synthesizeStableSession: false,
  },
}

/** OpenAI-compatible / generic connections: L0 only + passthrough. */
const GENERIC_CACHE_PROFILE: ProviderCacheProfile = {
  provider: "generic",
  features: ["passthrough-client-session"],
  synthesizeStableSession: false,
}

export function getProviderCacheProfile(
  provider?: string | null,
): ProviderCacheProfile {
  if (!provider) return GENERIC_CACHE_PROFILE
  if (Object.hasOwn(PROVIDER_CACHE_PROFILES, provider)) {
    return PROVIDER_CACHE_PROFILES[provider as ProviderId]
  }
  return GENERIC_CACHE_PROFILE
}

export function providerHasCacheFeature(
  provider: string | null | undefined,
  feature: ProviderCacheFeature,
): boolean {
  return getProviderCacheProfile(provider).features.includes(feature)
}

/**
 * Shared routing defaults balance allowance with prompt-cache reuse (L0).
 *
 * - quota: new sessions use allowance pressure and renewal times within the
 *   primary priority tier, using a healthy backup when the primary is spent.
 * - sessionAffinity: known sessions stick across turns (including failover
 *   rebind when the bound credential is unavailable).
 * - 2h sliding TTL: long agent sessions keep binding without re-scatter.
 * - identityConfuse off: does not improve hit rate (Codex TOS paranoia only).
 */
export const CACHE_UTILIZATION_DEFAULTS: {
  strategy: "round-robin" | "fill-first" | "quota"
  sessionAffinity: boolean
  sessionAffinityTtlMs: number
  identityConfuse: boolean
  affinity: "session" | "turn" | "auto" | "off"
  quotaLowShare: number
  quotaSpentShare: number
} = {
  strategy: "quota",
  sessionAffinity: true,
  sessionAffinityTtlMs: 2 * 60 * 60_000,
  identityConfuse: false,
  affinity: "session",
  // Bands where a subscription's allowance stops being "fine": past `low` it
  // is kept for backup, past `spent` it is a last resort only.
  quotaLowShare: 0.9,
  quotaSpentShare: 0.98,
}
