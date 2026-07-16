/**
 * Copilot Native Protocol Adapter。
 */

import type { Account } from "~/lib/accounts"
import type {
  AdapterChatResult,
  AdapterEmbeddingsResult,
  AdapterMessagesResult,
  AdapterResponsesResult,
  ProtocolAdapter,
} from "~/services/protocols/types"

import { refreshCopilotToken } from "~/lib/account-store"
import { getCopilotToken } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { connectionToAccount } from "~/lib/provider-connections"
import { createCopilotChatCompletionsOnce } from "~/services/copilot/create-chat-completions-once"
import { createCopilotEmbeddingsOnce } from "~/services/copilot/create-embeddings-once"
import { createCopilotMessagesOnce } from "~/services/copilot/create-messages-once"
import { createCopilotResponsesOnce } from "~/services/copilot/create-responses-once"

/**
 * 兜底刷新 Copilot token。
 *
 * T5.2 重构后 copilotToken 的内存真相从 state.accounts[i].runtimeState
 * 迁移到 connection.credentials[0].value。若启动时 refreshCopilotToken
 * 失败或定时器未及时刷新，dispatch 时 credential.value 可能为空。
 * 此处在调用上游前做一次惰性刷新，避免 "Copilot token not found"
 * 被误判为 rate-limit 冷却形成恶性循环。
 */
async function ensureCopilotToken(account: Account): Promise<void> {
  if (account.provider !== "copilot") return
  if (getCopilotToken(account)) return
  logger.debug(
    `[copilot-native] Copilot token missing for "${account.label}", refreshing on-demand`,
  )
  await refreshCopilotToken(account)
  // 刷新后仍无 token（如 githubToken 缺失或账号 disabled），抛 HTTPError
  // 而非让下游抛普通 Error —— 普通 Error 会被 markCooldown 误判为
  // !isHttp 网络错误走 rate-limit 冷却，形成 cooldown 翻倍恶性循环。
  // 503 server_error 会触发 failover 但不冷却当前账号。
  if (!getCopilotToken(account)) {
    throw new HTTPError(
      `Copilot token unavailable for "${account.label}"`,
      new Response("Copilot token unavailable", { status: 503 }),
    )
  }
}

export const copilotNativeAdapter: ProtocolAdapter = {
  protocol: "copilot-native",

  async createChatCompletions({ connection, payload, signal, ctx }) {
    const account = connectionToAccount(connection)
    await ensureCopilotToken(account)
    const response = await createCopilotChatCompletionsOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterChatResult
  },

  async createResponses({ connection, payload, signal, ctx }) {
    const account = connectionToAccount(connection)
    await ensureCopilotToken(account)
    const response = await createCopilotResponsesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterResponsesResult
  },

  async createMessages({ connection, payload, signal, ctx }) {
    const account = connectionToAccount(connection)
    await ensureCopilotToken(account)
    const response = await createCopilotMessagesOnce(
      account,
      payload,
      signal,
      ctx,
    )
    return { credentialId: account.id, response } as AdapterMessagesResult
  },

  async createEmbeddings({ connection, payload, signal }) {
    const account = connectionToAccount(connection)
    await ensureCopilotToken(account)
    const response = await createCopilotEmbeddingsOnce(account, payload, signal)
    return {
      credentialId: account.id,
      response,
    } as AdapterEmbeddingsResult
  },
}
