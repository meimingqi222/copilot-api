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
export type {
  ConnectionRoutability,
  ConnectionUnavailabilityReason,
  RateLimitInfo,
  UpstreamErrorKind,
} from "./availability"
export {
  connectionHasCredentials,
  getConnectionCodebuffAuthToken,
  getConnectionCopilotToken,
  getConnectionGithubToken,
  getConnectionMimoPh,
  getConnectionMimoServiceToken,
  getConnectionMimoWsToken,
  getConnectionOAuthAccessToken,
  getConnectionOAuthAccountId,
  getConnectionOAuthApiKey,
  getConnectionOAuthDeviceId,
  getConnectionOAuthProjectId,
  getConnectionOAuthRefreshToken,
  getConnectionWindsurfApiKey,
  getCredentialValue,
  getCredentialValueRaw,
  isOAuthConnection,
} from "./connection-accessors"
export {
  buildAccountLegacyMetadata,
  ensureLegacyMetadata,
  getConnectionAuthError,
  getConnectionAuthStatus,
  getConnectionCooldownUntil,
  getConnectionCpaMetadata,
  getConnectionCredentialExtras,
  getConnectionExhaustedAt,
  getConnectionIsExhausted,
  getConnectionLastRateLimitAt,
  getConnectionLastRateLimitReason,
  getConnectionModelPrefix,
  getConnectionProvider,
  getConnectionProxy,
  getConnectionProxyUrl,
  getConnectionQuotaExhaustedAt,
  getConnectionQuotaInfo,
  getConnectionQuotaState,
  getConnectionRedirectUri,
  getConnectionSettings,
  getConnectionSubtitle,
  getConnectionTokenEndpoint,
  getConnectionUserId,
  getCredentialContextNumber,
  getCredentialContextString,
  getCredentialExtraNumber,
  getCredentialExtraString,
  readAccountLegacyMetadata,
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
export type { AccountLegacyMetadata } from "./connection-metadata"
export {
  refreshAllConnectionModels,
  refreshConnectionModels,
  scheduleConnectionModelDiscovery,
  stopConnectionModelDiscovery,
} from "./discovery"
export {
  accountToConnectionForPersistence,
  migrateAccountsToConnections,
} from "./migrate-from-accounts"
export {
  accountManagedModelPrefix,
  accountManagedProvider,
  accountManagedProviderFromId,
  connectionProvider,
  listAccountManagedConnections,
  providerFromProtocol,
} from "./protocol-provider"
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
  persistProviderConnections,
  removeProviderConnection,
  setConnectionModels,
  setDiscoveryError,
  setProviderConnectionsForMigration,
  updateConnection,
  updateCredential,
  updateModel,
  upsertProviderConnection,
} from "./state"
export type {
  CreateConnectionInput,
  CreateCredentialInput,
  UpdateConnectionInput,
  UpdateCredentialInput,
} from "./state"
export {
  loadProviderConnections,
  sanitizeConnection,
  sanitizeCredential,
  saveProviderConnections,
  upgradeConnectionV1ToV2,
} from "./store"
export type { SanitizedConnection, SanitizedCredential } from "./store"
export * from "./types"
