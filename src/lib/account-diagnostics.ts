import type { Account } from "~/lib/accounts"

import { canonicalNativeModelId, parseModelReference } from "~/lib/accounts"
import {
  getAccountRateLimitSnapshot,
  getRemainingCooldownSeconds,
} from "~/lib/rate-limit"

function getAccountAvailabilityReason(
  account: Account,
  retryAfterSeconds: number,
): "available" | "cooldown" | "disabled" | "quota" {
  if (!account.enabled) {
    return "disabled"
  }
  if (retryAfterSeconds > 0) {
    return "cooldown"
  }
  if (account.quotaState === "exhausted") {
    return "quota"
  }
  return "available"
}

export function buildAccountDiagnosticSnapshot(
  account: Account,
  modelId?: string,
): Record<string, unknown> {
  const retryAfterSeconds = getRemainingCooldownSeconds(account.id)
  const availability = getAccountAvailabilityReason(account, retryAfterSeconds)

  const requestedModel =
    typeof modelId === "string" && modelId.trim() ? modelId : undefined
  const nativeModelId =
    requestedModel ?
      parseModelReference(requestedModel).nativeModelId
    : undefined
  const supportsExplicitly =
    nativeModelId ?
      (account.availableModels?.some(
        (model) => canonicalNativeModelId(model.id) === nativeModelId,
      ) ?? false)
    : undefined

  return {
    id: account.id,
    label: account.label,
    provider: account.provider,
    enabled: account.enabled,
    priority: account.priority,
    availability,
    retryAfterSeconds,
    quotaState: account.quotaState ?? "unknown",
    isExhausted: account.isExhausted ?? false,
    cooldownUntil: account.cooldownUntil,
    lastRateLimitAt: account.lastRateLimitAt,
    lastRateLimitReason: account.lastRateLimitReason,
    availableModelCount: account.availableModels?.length ?? 0,
    requestedModel,
    nativeModelId,
    supportsExplicitly,
    supportsWithFallback:
      nativeModelId ?
        supportsExplicitly || !account.availableModels
      : undefined,
    limiter: getAccountRateLimitSnapshot(account.id),
  }
}

export function buildAccountsDiagnosticSnapshot(
  accounts: Array<Account>,
  modelId?: string,
): Array<Record<string, unknown>> {
  return accounts.map((account) =>
    buildAccountDiagnosticSnapshot(account, modelId),
  )
}
