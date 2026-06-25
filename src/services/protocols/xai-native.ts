import type { Account } from "~/lib/accounts"

import { createXaiResponsesOnce } from "~/services/xai/create-responses-once"

import type { AdapterResponsesResult, ProtocolAdapter } from "./types"

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("xai-native adapter: target.account is required")
  }
  return account
}

export const xaiNativeAdapter: ProtocolAdapter = {
  protocol: "xai-native",

  // eslint-disable-next-line max-params
  async createResponses(
    target,
    _connection,
    _credential,
    payload,
    signal,
    ctx,
  ) {
    const account = extractAccount(target)
    const response = await createXaiResponsesOnce(account, payload, signal, ctx)
    return { credentialId: account.id, response } as AdapterResponsesResult
  },
}
