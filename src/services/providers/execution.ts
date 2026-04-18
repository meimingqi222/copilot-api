import type { Account } from "~/lib/accounts"

import {
  markAccountRateLimitRecovered,
  markAccountRateLimited,
} from "~/lib/account-availability"
import { switchToNextAccountForModel } from "~/lib/account-selection"
import { HTTPError } from "~/lib/error"
import { checkAccountRateLimitOrThrow } from "~/lib/request-lifecycle"
import { initializeProviderRegistry } from "~/services/providers"
import { providerSupports } from "~/services/providers/registry"

interface ExecuteProviderRequestWithRetryInput<T> {
  account: Account
  model: string
  signal?: AbortSignal
  execute: (account: Account) => Promise<T>
  isRateLimitError?: (error: unknown) => error is HTTPError
}

export async function executeProviderRequestWithRetry<T>(
  input: ExecuteProviderRequestWithRetryInput<T>,
): Promise<{ account: Account; result: T }> {
  const {
    account,
    model,
    signal,
    execute,
    isRateLimitError = isRateLimitHttpError,
  } = input

  initializeProviderRegistry()

  let currentAccount = account
  const attemptedAccounts = new Set<string>()

  while (true) {
    attemptedAccounts.add(currentAccount.id)

    if (providerSupports(currentAccount, "cooldown")) {
      await checkAccountRateLimitOrThrow(currentAccount.id, signal)
    }

    try {
      const result = await execute(currentAccount)
      await markAccountRateLimitRecovered(currentAccount.id)
      return {
        account: currentAccount,
        result,
      }
    } catch (error) {
      if (!isRateLimitError(error)) {
        throw error
      }

      await markAccountRateLimited(currentAccount.id, error.response)

      const retryAccount = switchToNextAccountForModel(currentAccount, model)
      if (!retryAccount || attemptedAccounts.has(retryAccount.id)) {
        throw error
      }

      currentAccount = retryAccount
    }
  }
}

function isRateLimitHttpError(error: unknown): error is HTTPError {
  return error instanceof HTTPError && error.response.status === 429
}
