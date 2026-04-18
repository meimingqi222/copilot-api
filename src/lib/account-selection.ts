import type { Account } from "~/lib/accounts"

import {
  getAccountAvailability,
  getMinimumCooldownSeconds,
  isAccountAvailable,
  refreshAccountRuntimeAvailability,
} from "~/lib/account-availability"
import {
  canonicalNativeModelId,
  getAccountProvider,
  getGitHubToken,
  parseModelReference,
} from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

function supportsModelExplicitly(account: Account, modelId: string): boolean {
  const target = parseModelReference(modelId).nativeModelId
  return (
    account.availableModels?.some(
      (model) => canonicalNativeModelId(model.id) === target,
    ) ?? false
  )
}

function supportsModelWithFallback(account: Account, modelId: string): boolean {
  return supportsModelExplicitly(account, modelId) || !account.availableModels
}

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

function getCapableAccounts(
  accounts: Array<Account>,
  nativeModelId: string,
): Array<Account> {
  const explicitCapable = accounts.filter((account) =>
    supportsModelExplicitly(account, nativeModelId),
  )
  const fallbackCapable = accounts.filter((account) =>
    supportsModelWithFallback(account, nativeModelId),
  )
  return explicitCapable.length > 0 ? explicitCapable : fallbackCapable
}

function throwNoAvailableAccounts(): never {
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

function throwModelSelectionError(
  modelId: string,
  reference: ReturnType<typeof parseModelReference>,
  providerMatched: Array<Account>,
): never {
  if (reference.provider && providerMatched.length === 0) {
    const providerEnabled = state.accounts.filter(
      (account) =>
        getAccountProvider(account) === reference.provider && account.enabled,
    )
    const providerAvailable = providerEnabled.filter(
      (account) => getAccountAvailability(account).available,
    )
    if (providerEnabled.length === 0) {
      throw new HTTPError(
        `No accounts configured for provider "${reference.provider}"`,
        new Response("Service Unavailable", { status: 503 }),
      )
    }
    if (providerAvailable.length === 0) {
      const anyCooldown = providerEnabled.some(
        (account) => getAccountAvailability(account).reason === "cooldown",
      )
      if (anyCooldown) {
        throw new HTTPError(
          `All "${reference.provider}" accounts are temporarily unavailable due to rate limiting`,
          rateLimitedResponse("Too Many Requests", providerEnabled),
        )
      }
      const anyQuota = providerEnabled.some(
        (account) => getAccountAvailability(account).reason === "quota",
      )
      if (anyQuota) {
        throw new HTTPError(
          `All "${reference.provider}" accounts are unavailable due to quota exhaustion`,
          new Response("Service Unavailable", { status: 503 }),
        )
      }
    }
  }

  const enabledRelevantPool = state.accounts.filter((account) => {
    if (!account.enabled) {
      return false
    }
    if (
      reference.provider
      && getAccountProvider(account) !== reference.provider
    ) {
      return false
    }
    return true
  })
  const capableEnabledAccounts = getCapableAccounts(
    enabledRelevantPool,
    reference.nativeModelId,
  )

  if (capableEnabledAccounts.length > 0) {
    const anyCooldown = capableEnabledAccounts.some(
      (account) => getAccountAvailability(account).reason === "cooldown",
    )
    if (anyCooldown) {
      throw new HTTPError(
        `All accounts supporting model "${modelId}" are temporarily unavailable due to rate limiting`,
        rateLimitedResponse("Too Many Requests", capableEnabledAccounts),
      )
    }
    const anyQuota = capableEnabledAccounts.some(
      (account) => getAccountAvailability(account).reason === "quota",
    )
    if (anyQuota) {
      throw new HTTPError(
        `All accounts supporting model "${modelId}" are quota exhausted`,
        new Response("Service Unavailable", { status: 503 }),
      )
    }
  }

  throw new HTTPError(
    `No available account supports model "${modelId}"`,
    new Response("Service Unavailable", { status: 503 }),
  )
}

export function getAccountForModel(modelId: string): Account {
  const reference = parseModelReference(modelId)
  refreshAllAccountAvailability()

  const available = getSortedAvailableAccounts()

  if (available.length === 0) {
    const hasMatchingEnabledAccounts =
      Boolean(reference.provider)
      || state.accounts.some(
        (account) =>
          account.enabled
          && supportsModelWithFallback(account, reference.nativeModelId),
      )
    if (hasMatchingEnabledAccounts) {
      throwModelSelectionError(modelId, reference, [])
    }
    throwNoAvailableAccounts()
  }

  const providerMatched =
    reference.provider ?
      available.filter(
        (account) => getAccountProvider(account) === reference.provider,
      )
    : available

  const capable = getCapableAccounts(
    reference.provider ? providerMatched : available,
    reference.nativeModelId,
  )

  if (capable.length === 0) {
    throwModelSelectionError(modelId, reference, providerMatched)
  }

  return capable[0]
}

export function switchToNextAccountForModel(
  currentAccount: Account,
  modelId: string,
): Account | null {
  const reference = parseModelReference(modelId)
  refreshAllAccountAvailability()

  const sorted = sortAccounts(state.accounts)

  const providerMatched =
    reference.provider ?
      sorted.filter(
        (account) =>
          isAccountAvailable(account)
          && getAccountProvider(account) === reference.provider,
      )
    : []

  const capablePool =
    reference.provider ? providerMatched : (
      sorted.filter((account) => isAccountAvailable(account))
    )

  const explicitCapable = capablePool.filter((account) =>
    supportsModelExplicitly(account, reference.nativeModelId),
  )
  const fallbackCapable = capablePool.filter((account) =>
    supportsModelWithFallback(account, reference.nativeModelId),
  )
  const capable = explicitCapable.length > 0 ? explicitCapable : fallbackCapable

  if (capable.length === 0) {
    return null
  }

  const currentIdx = capable.indexOf(currentAccount)
  for (let i = 1; i <= capable.length; i++) {
    const idx = currentIdx === -1 ? i - 1 : (currentIdx + i) % capable.length
    const account = capable[idx]
    return account
  }
  return null
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
      state.githubToken =
        getAccountProvider(account) === "copilot" ?
          getGitHubToken(account)
        : undefined
      return account
    }
  }
  return null
}
