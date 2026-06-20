import type { Account } from "~/lib/accounts"

import { createCodexResponsesOnce } from "~/services/codex/create-responses-once"

import type { AdapterResponsesResult, ProtocolAdapter } from "./types"

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("codex-native adapter: target.account is required")
  }
  return account
}

export const codexNativeAdapter: ProtocolAdapter = {
  protocol: "codex-native",

  // eslint-disable-next-line max-params
  async createResponses(
    target,
    _connection,
    _credential,
    payload,
    signal,
    _ctx,
  ) {
    const account = extractAccount(target)
    const response = await createCodexResponsesOnce(account, payload, signal)
    return { credentialId: account.id, response } as AdapterResponsesResult
  },
}
