/**
 * L0 routing helpers for multi-account prompt-cache utilization.
 *
 * L1 (provider-specific rewrites) live under services/<provider>/ and
 * must consult provider-cache.ts before inventing session identifiers.
 */

export {
  CACHE_UTILIZATION_DEFAULTS,
  GENERIC_CACHE_PROFILE,
  getProtocolCacheProfile,
  getProviderCacheProfile,
  PROVIDER_CACHE_PROFILES,
  type ProviderCacheFeature,
  type ProviderCacheProfile,
  providerHasCacheFeature,
} from "./provider-cache"
export {
  affinityAuthKey,
  affinityCacheKey,
  affinityMode,
  affinitySessionKey,
  clearSessionAffinityForTest,
  getSessionAffinity,
  getSessionAffinityBySession,
  getSessionAffinitySizeForTest,
  invalidateSessionAffinityAuth,
  isCodexIdentityConfuseEnabled,
  isFillFirstEnabled,
  isLeastUsedStrategyEnabled,
  isQuotaStrategyEnabled,
  isSessionAffinityEnabled,
  noteSessionAffinityCacheRead,
  pruneSessionAffinityForTest,
  setSessionAffinity,
} from "./session-affinity"
export {
  computeSessionHash,
  extractClaudeSessionFromPayload,
  type ExtractedSessionIds,
  extractMessageHashIds,
  extractSessionIds,
  extractSessionTurn,
  generateAntigravityStableSessionId,
  resolveStableSessionId,
  type SessionExtractInput,
  type SessionTurn,
} from "./session-extract"
