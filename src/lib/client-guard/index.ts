// Barrel: re-export all public API from client-guard sub-modules.
// 内部模块拆分仅用于代码组织，对外接口保持不变。

export {
  addBlacklistEntry,
  getBlacklist,
  isBlocked,
  removeBlacklistEntry,
} from "./blacklist"

export { loadGuard, resetGuardForTest } from "./persistence"

export { getSnapshots, recordRequest, recordRequestPreview } from "./snapshot"

export type {
  BlacklistEntry,
  ClientSnapshot,
  ClientSnapshotDTO,
  GuardRecordResult,
  GuardRequestPreview,
} from "./types"

export {
  addUaWhitelistPattern,
  getCustomUaWhitelist,
  getUaWhitelist,
  removeUaWhitelistPattern,
} from "./ua-whitelist"
