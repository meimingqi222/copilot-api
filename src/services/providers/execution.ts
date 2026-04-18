import type { Context } from "hono"

import consola from "consola"

import type { Account } from "~/lib/accounts"

import {
  markAccountRateLimitRecovered,
  markAccountRateLimited,
} from "~/lib/account-availability"
import { buildAccountDiagnosticSnapshot } from "~/lib/account-diagnostics"
import { switchToNextAccountForModel } from "~/lib/account-selection"
import { HTTPError } from "~/lib/error"
import {
  reportUpstream429,
  reportRequestSuccess,
} from "~/lib/protected-route-guard"
import { checkAccountRateLimitOrThrow } from "~/lib/request-lifecycle"
import { initializeProviderRegistry } from "~/services/providers"
import { providerSupports } from "~/services/providers/registry"

interface ExecuteProviderRequestWithRetryInput<T> {
  account: Account
  model: string
  signal?: AbortSignal
  execute: (account: Account) => Promise<T>
  isRateLimitError?: (error: unknown) => error is HTTPError
  c?: Context
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
    c,
  } = input

  initializeProviderRegistry()

  let currentAccount = account
  const attemptedAccounts = new Set<string>()
  let attempt = 0

  while (true) {
    attempt += 1
    attemptedAccounts.add(currentAccount.id)

    if (providerSupports(currentAccount, "cooldown")) {
      await checkAccountRateLimitOrThrow(currentAccount.id, signal)
    }

    try {
      const result = await execute(currentAccount)
      await markAccountRateLimitRecovered(currentAccount.id)
      if (c) reportRequestSuccess(c)
      return {
        account: currentAccount,
        result,
      }
    } catch (error) {
      if (!isRateLimitError(error)) {
        throw error
      }

      consola.warn(
        `Provider request received upstream 429: ${JSON.stringify({
          model,
          attempt,
          account: buildAccountDiagnosticSnapshot(currentAccount, model),
          attemptedAccountIds: [...attemptedAccounts],
          upstreamStatus: error.response.status,
          upstreamRetryAfter:
            error.response.headers.get("Retry-After")
            ?? error.response.headers.get("retry-after"),
          upstreamBody: error.responseBody,
        })}`,
      )

      await markAccountRateLimited(currentAccount.id, error.response)
      if (c) reportUpstream429(c)

      const retryAccount = switchToNextAccountForModel(currentAccount, model)
      if (!retryAccount || attemptedAccounts.has(retryAccount.id)) {
        consola.warn(
          `Provider request cannot fail over after 429: ${JSON.stringify({
            model,
            attempt,
            account: buildAccountDiagnosticSnapshot(currentAccount, model),
            retryAccountId: retryAccount?.id,
            attemptedAccountIds: [...attemptedAccounts],
          })}`,
        )
        throw error
      }

      consola.warn(
        `Provider request failing over after 429: ${JSON.stringify({
          model,
          attempt,
          from: buildAccountDiagnosticSnapshot(currentAccount, model),
          to: buildAccountDiagnosticSnapshot(retryAccount, model),
          attemptedAccountIds: [...attemptedAccounts],
        })}`,
      )

      currentAccount = retryAccount
    }
  }
}

function isRateLimitHttpError(error: unknown): error is HTTPError {
  return error instanceof HTTPError && error.response.status === 429
}
