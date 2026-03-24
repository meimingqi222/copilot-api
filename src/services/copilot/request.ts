import type { Account } from "~/lib/accounts"

import { markAccountExhausted, tryNextAccountForModel } from "~/lib/accounts"
import {
  reportUpstreamRateLimit,
  reportUpstreamSuccess,
} from "~/lib/rate-limit"

interface ExecuteCopilotRequestWithRetryInput {
  account: Account
  model: string
  doRequest: (requestAccount: Account) => Promise<Response>
}

export async function executeCopilotRequestWithRetry(
  input: ExecuteCopilotRequestWithRetryInput,
): Promise<{ account: Account; response: Response }> {
  const { account, model, doRequest } = input

  let usedAccount = account
  let response = await doRequest(account)

  if (!response.ok && response.status === 429) {
    await reportUpstreamRateLimit(account.id, response)
    markAccountExhausted(account.id)

    const retryResult = await tryNextAccountForModel(account, model, doRequest)
    response = retryResult.response
    usedAccount = retryResult.account
  }

  if (response.ok) {
    await reportUpstreamSuccess(usedAccount.id)
  }

  return {
    account: usedAccount,
    response,
  }
}
