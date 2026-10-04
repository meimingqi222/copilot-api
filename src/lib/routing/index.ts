/**
 * L0 routing helpers for multi-account prompt-cache utilization.
 *
 * L1 (provider-specific rewrites) live under services/<provider>/.
 */

export { CACHE_UTILIZATION_DEFAULTS } from "./provider-cache"
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
  isSessionAffinityEnabled,
  noteSessionAffinityCacheRead,
  pruneSessionAffinityForTest,
  setSessionAffinity,
} from "./session-affinity"
export {
  extractSessionIds,
  extractSessionTurn,
  generateAntigravityStableSessionId,
  resolveStableSessionId,
} from "./session-extract"
