/**
 * Account store facade (Phase 3)。
 *
 * 此模块仅为兼容性 re-export 边界,实际逻辑已拆分至:
 * - ~/lib/legacy-accounts/boot-migration — 启动加载与迁移
 * - ~/lib/legacy-accounts/persistence — saveAccounts / flush
 * - ~/lib/legacy-accounts/token-bridge — Copilot token refresh 桥接
 * - ~/lib/legacy-accounts/serialize — Account 序列化(导出)
 * - ~/services/copilot/quota-refresh — 配额刷新
 *
 * 外部代码应逐步迁移到直接从上述模块导入;
 * 此 facade 仅为避免一次性修改 30+ import 而保留。
 */
export { loadAccounts } from "~/lib/legacy-accounts/boot-migration"
export {
  flushAccountsOnShutdown,
  saveAccounts,
  type SaveAccountsOptions,
} from "~/lib/legacy-accounts/persistence"
export {
  serializeAccountForExport,
  serializeConnectionForExport,
} from "~/lib/legacy-accounts/serialize"
export {
  cancelTokenRefreshTimer,
  refreshCopilotToken,
  refreshCopilotTokenForConnection,
} from "~/lib/legacy-accounts/token-bridge"
export {
  refreshQuotaForAccount,
  refreshQuotaForConnection,
  scheduleQuotaRefresh,
} from "~/services/copilot/quota-refresh"

import { loadAccounts } from "~/lib/legacy-accounts/boot-migration"

/** 兼容入口:等价于 loadAccounts()。 */
export async function initAccounts(): Promise<void> {
  await loadAccounts()
}
