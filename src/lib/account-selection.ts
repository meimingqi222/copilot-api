import type { Account } from "~/lib/accounts"

import {
  getAccountAvailability,
  getMinimumCooldownSeconds,
  isAccountAvailable,
  refreshAccountRuntimeAvailability,
} from "~/lib/account-availability"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

function rateLimitedResponse(
  body: string,
  accounts = state.accounts,
): Response {
  const minCooldown = getMinimumCooldownSeconds(accounts)
  return new Response(body, {
    status: 429,
    headers: minCooldown > 0 ? { "Retry-After": String(minCooldown) } : {},
  })
}

function refreshAllAccountAvailability(): void {
  for (const account of state.accounts) {
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
    state.accounts.filter((account) => isAccountAvailable(account)),
  )
}

export function getActiveAccount(): Account {
  refreshAllAccountAvailability()

  const configured = state.accounts.at(state.activeAccountIndex)
  if (configured && isAccountAvailable(configured)) {
    return configured
  }

  const available = getSortedAvailableAccounts()

  if (available.length > 0) {
    return available[0]
  }

  const hasCooldownAccounts = state.accounts.some(
    (account) =>
      account.enabled && getAccountAvailability(account).reason === "cooldown",
  )
  if (hasCooldownAccounts) {
    throw new HTTPError(
      "All accounts are temporarily unavailable due to rate limiting",
      rateLimitedResponse("Too Many Requests"),
    )
  }

  const hasQuotaExhaustedAccounts = state.accounts.some(
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

export function switchToNextAccount(): Account | null {
  refreshAllAccountAvailability()

  const sorted = sortAccounts(state.accounts)

  const currentIdx = sorted.indexOf(state.accounts[state.activeAccountIndex])
  for (let i = 1; i < sorted.length; i++) {
    const idx = (currentIdx + i) % sorted.length
    const account = sorted[idx]
    if (isAccountAvailable(account)) {
      state.activeAccountIndex = state.accounts.indexOf(account)
      return account
    }
  }
  return null
}
