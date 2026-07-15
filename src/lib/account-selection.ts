import type { Account } from "~/lib/accounts"

import {
  getAccountAvailability,
  getMinimumCooldownSeconds,
  isAccountAvailable,
  refreshAccountRuntimeAvailability,
} from "~/lib/account-availability"
import { listAccounts } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"

function rateLimitedResponse(
  body: string,
  accounts: Array<Account> = listAccounts(),
): Response {
  const minCooldown = getMinimumCooldownSeconds(accounts)
  return new Response(body, {
    status: 429,
    headers: minCooldown > 0 ? { "Retry-After": String(minCooldown) } : {},
  })
}

function refreshAllAccountAvailability(): void {
  for (const account of listAccounts()) {
    refreshAccountRuntimeAvailability(account)
  }
}

function sortAccounts(accounts: Array<Account>): Array<Account> {
  return accounts
    .map((account, originalIndex) => ({ account, originalIndex }))
    .sort((left, right) => {
      const leftPriority = left.account.priority
      const rightPriority = right.account.priority
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority
      }
      return left.originalIndex - right.originalIndex
    })
    .map((item) => item.account)
}

function getSortedAvailableAccounts(): Array<Account> {
  return sortAccounts(
    listAccounts().filter((account) => isAccountAvailable(account)),
  )
}

export function getActiveAccount(): Account {
  refreshAllAccountAvailability()

  const available = getSortedAvailableAccounts()

  if (available.length > 0) {
    return available[0]
  }

  const allAccounts = listAccounts()
  const hasCooldownAccounts = allAccounts.some(
    (account) =>
      account.enabled && getAccountAvailability(account).reason === "cooldown",
  )
  if (hasCooldownAccounts) {
    throw new HTTPError(
      "All accounts are temporarily unavailable due to rate limiting",
      rateLimitedResponse("Too Many Requests"),
    )
  }

  const hasQuotaExhaustedAccounts = allAccounts.some(
    (account) =>
      account.enabled && getAccountAvailability(account).reason === "quota",
  )
  if (hasQuotaExhaustedAccounts) {
    throw new HTTPError(
      "All accounts are unavailable due to quota exhaustion",
      new Response("Service Unavailable", { status: 503 }),
    )
  }

  throw new HTTPError(
    "No available accounts (all disabled or no accounts configured)",
    new Response("Service Unavailable", { status: 503 }),
  )
}
