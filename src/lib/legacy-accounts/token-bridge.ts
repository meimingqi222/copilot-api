import { getAccount } from "~/lib/legacy-accounts"
import { getMutableProviderConnection } from "~/lib/provider-connections"
import {
  cancelConnectionTokenRefresh,
  refreshCopilotTokenForConnection,
} from "~/services/copilot/token-refresh"

/**
 * Account 桥接层:Copilot token 刷新。
 *
 * Phase 3:从 account-store.ts 提取的 token refresh wrapper。
 * 委托 token-refresh.ts 的 connection 原生实现。
 * Phase 5:通过 getAccount(conn.id) 获取 Account 快照,不再直接调用 connectionToAccount。
 */
import type { Account } from "./accounts"

/**
 * Account 桥接:按 account.id 反查 connection 调原生 token refresh。
 */
export async function refreshCopilotToken(account: Account): Promise<void> {
  const connection = getMutableProviderConnection(account.id)
  if (!connection) {
    return
  }
  await refreshCopilotTokenForConnection(connection)
  // 从 connection 重新派生 Account 快照,同步 runtimeState 回 account
  const fresh = getAccount(connection.id)
  if (fresh?.runtimeState) {
    account.runtimeState = {
      ...account.runtimeState,
      ...fresh.runtimeState,
    }
  }
}

/**
 * 取消 connection 的 Copilot token 刷新定时器。
 */
export function cancelTokenRefreshTimer(connectionId: string): void {
  cancelConnectionTokenRefresh(connectionId)
}

export { refreshCopilotTokenForConnection } from "~/services/copilot/token-refresh"
