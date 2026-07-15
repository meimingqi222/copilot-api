/**
 * Provider Connection 模块公共入口。
 *
 * 上层只需 import 此 barrel,而不需要关心内部细节。
 */

export {
  classifyUpstreamError,
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
export type { RateLimitInfo, UpstreamErrorKind } from "./availability"
export { connectionToAccount } from "./connection-to-account"
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
  __resetProviderConnectionsForTest,
  addCredential,
  addModel,
  applyDiscoveredModels,
  createConnection,
  deleteConnection,
  deleteCredential,
  deleteModel,
  findCredential,
  getProviderConnection,
  initializeProviderConnections,
  listProviderConnections,
  persistProviderConnections,
  setDiscoveryError,
  setProviderConnectionsForMigration,
  updateConnection,
  updateCredential,
  updateModel,
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
} from "./store"
export type { SanitizedConnection, SanitizedCredential } from "./store"
export * from "./types"
