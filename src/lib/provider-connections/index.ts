/**
 * Provider Connection 模块公共入口。
 *
 * 上层只需 import 此 barrel,而不需要关心内部细节。
 */

export {
  isAccountManagedConnection,
  isAccountManagedProtocol,
} from "./account-managed"
export {
  classifyUpstreamError,
  getConnectionRoutability,
  isCodexUsageLimitError,
  isConnectionAvailable,
  isCredentialAvailable,
  markCredentialAuthError,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  parseCodexUsageLimitRetryAfter,
  refreshConnectionAvailability,
  refreshCredentialAvailability,
  resetCredentialStatus,
  setCredentialEnabled,
} from "./availability"
export {
  connectionHasCredentials,
  getConnectionCodebuffAuthToken,
  getConnectionCopilotToken,
  getConnectionMimoPh,
  getConnectionMimoServiceToken,
  getConnectionOAuthAccessToken,
  getConnectionOAuthAccountId,
  getConnectionWindsurfApiKey,
  isOAuthConnection,
} from "./connection-accessors"
export {
  ensureConnectionMetadata,
  getConnectionAuthError,
  getConnectionAuthStatus,
  getConnectionCooldownUntil,
  getConnectionCpaMetadata,
  getConnectionCredentialExtras,
  getConnectionExhaustedAt,
  getConnectionLastRateLimitReason,
  getConnectionProvider,
  getConnectionProxy,
  getConnectionProxyUrl,
  getConnectionQuotaInfo,
  getConnectionQuotaState,
  getConnectionRedirectUri,
  getConnectionSettings,
  getConnectionUserId,
  getCredentialContextNumber,
  getCredentialContextString,
  getCredentialExtraString,
  readConnectionMetadata,
  setConnectionAuthStatus,
  setConnectionCooldownUntil,
  setConnectionCredentialExtra,
  setConnectionExhausted,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
  setConnectionRateLimitInfo,
  setConnectionSetting,
  setCredentialContextField,
  setCredentialValue,
} from "./connection-metadata"
export {
  flushManagedConnectionsOnShutdown,
  initializeManagedConnections,
} from "./boot"
export {
  connectionModelsToAccountModels,
  managedConnectionFromInput,
  serializeConnectionForExport,
} from "./managed-connection"
export type { AccountModel, ManagedConnectionInput } from "./managed-connection"
export { scheduleConnectionModelDiscovery } from "./discovery"
export {
  accountManagedModelPrefix,
  accountManagedProvider,
  connectionProvider,
  listAccountManagedConnections,
  providerFromProtocol,
} from "./protocol-provider"
export { getFirstAvailableAccountManagedConnection } from "./selection"
export {
  __resetProviderConnectionsForTest,
  addCredential,
  addModel,
  applyDiscoveredModels,
  createConnection,
  deleteConnection,
  deleteCredential,
  deleteModel,
  findCredential,
  getMutableProviderConnection,
  getProviderConnection,
  initializeProviderConnections,
  listProviderConnections,
  mergeDiscoveredModels,
  mergeProviderRefreshedModels,
  ModelConflictError,
  normalizeModelAliases,
  persistProviderConnections,
  removeProviderConnection,
  setConnectionModels,
  setDiscoveryError,
  updateConnection,
  updateCredential,
  updateModel,
  upsertProviderConnection,
} from "./state"
export type { CreateCredentialInput } from "./state"
export {
  sanitizeConnection,
  sanitizeCredential,
  saveProviderConnections,
  upgradeConnectionV1ToV2,
} from "./store"
export * from "./types"
