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
export type ProviderCacheFeature =
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

export interface ProviderCacheProfile {
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
 * Account-backed native providers (state.accounts).
 * Connection protocols without a native account map use GENERIC_CACHE_PROFILE.
 */
export const PROVIDER_CACHE_PROFILES: Record<ProviderId, ProviderCacheProfile> =
  {
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
  }

/** OpenAI-compatible / generic connections: L0 only + passthrough. */
export const GENERIC_CACHE_PROFILE: ProviderCacheProfile = {
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

export function getProtocolCacheProfile(
  protocol?: string | null,
): ProviderCacheProfile {
  switch (protocol) {
    case "codex-native": {
      return PROVIDER_CACHE_PROFILES.codex
    }
    case "claude-native": {
      return PROVIDER_CACHE_PROFILES.claude
    }
    case "antigravity-native": {
      return PROVIDER_CACHE_PROFILES.antigravity
    }
    case "xai-native": {
      return PROVIDER_CACHE_PROFILES.xai
    }
    case "windsurf-native": {
      return PROVIDER_CACHE_PROFILES.windsurf
    }
    case "copilot-native": {
      return PROVIDER_CACHE_PROFILES.copilot
    }
    case "kimi-native": {
      return PROVIDER_CACHE_PROFILES.kimi
    }
    case "codebuff-native": {
      return PROVIDER_CACHE_PROFILES.codebuff
    }
    case "mimo-native": {
      return PROVIDER_CACHE_PROFILES["mimo-aistudio"]
    }
    case "anthropic-compatible": {
      return {
        provider: "anthropic-compatible",
        features: ["claude-session-header", "passthrough-client-session"],
        // Compatible endpoints often accept Claude session header.
        synthesizeStableSession: true,
      }
    }
    default: {
      return GENERIC_CACHE_PROFILE
    }
  }
}

export function providerHasCacheFeature(
  provider: string | null | undefined,
  feature: ProviderCacheFeature,
): boolean {
  return getProviderCacheProfile(provider).features.includes(feature)
}

/**
 * Defaults tuned for maximum prompt-cache utilization (L0).
 *
 * - fill-first: new sessions without affinity keys land on the same
 *   credential, so even hash-less traffic shares an upstream cache namespace.
 * - sessionAffinity: known sessions stick across turns (including failover
 *   rebind when the bound credential is unavailable).
 * - 2h sliding TTL: long agent sessions keep binding without re-scatter.
 * - identityConfuse off: does not improve hit rate (Codex TOS paranoia only).
 */
export const CACHE_UTILIZATION_DEFAULTS: {
  strategy: "round-robin" | "fill-first"
  sessionAffinity: boolean
  sessionAffinityTtlMs: number
  identityConfuse: boolean
} = {
  strategy: "fill-first",
  sessionAffinity: true,
  sessionAffinityTtlMs: 2 * 60 * 60_000,
  identityConfuse: false,
}
