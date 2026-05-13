/**
 * Provider Connection 模块公共入口。
 *
 * 上层只需 import 此 barrel,而不需要关心内部细节。
 */

export {
  classifyUpstreamError,
  isConnectionAvailable,
  isCredentialAvailable,
  markCredentialAuthError,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  refreshConnectionAvailability,
  refreshCredentialAvailability,
  resetCredentialStatus,
  setCredentialEnabled,
} from "./availability"
export type { RateLimitInfo, UpstreamErrorKind } from "./availability"
export {
  refreshAllConnectionModels,
  refreshConnectionModels,
  scheduleConnectionModelDiscovery,
  stopConnectionModelDiscovery,
} from "./discovery"
export {
  __resetProviderConnectionsForTest,
  addCredential,
  createConnection,
  deleteConnection,
  deleteCredential,
  findCredential,
  getProviderConnection,
  initializeProviderConnections,
  listProviderConnections,
  persistProviderConnections,
  updateConnection,
  updateCredential,
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
