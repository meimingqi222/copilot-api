import type { ProviderConnection } from "~/lib/provider-connections"

import { logger } from "~/lib/logger"
import {
  setConnectionCooldownUntil,
  setConnectionRateLimitInfo,
} from "~/lib/provider-connections"
import { clearRestsForCredential } from "~/lib/route-target/rest-registry"

/**
 * The upstream just reported capacity again: lift every local wait that only
 * described the old depletion.
 *
 * Clearing the quota flags alone was not enough. A 429 leaves a
 * `cooldownUntil` on the credential *and* a rest in the registry; neither is
 * touched when a quota read later says the account has room, and
 * `getRemainingCooldownSeconds` re-imports the persisted instant into the
 * pacing limiter. Routing therefore kept answering the old reset for hours
 * after the account recovered (a Codex 5h window reset upstream still showed
 * the pre-reset `retryAfterMs`), and no probe ever happened because the
 * candidate was filtered out before dispatch.
 *
 * Called only after a *fresh* read that says the account has capacity, so the
 * estimate can no longer be trusted. `auth_error` is left alone: a valid quota
 * does not prove the credential works.
 */
export function liftRestAfterQuotaRecovery(
  connection: ProviderConnection,
): boolean {
  let lifted = false
  for (const credential of connection.credentials) {
    if (credential.status === "auth_error") continue
    if (
      credential.status === "quota_exhausted"
      || credential.status === "cooldown"
      || credential.cooldownUntil !== undefined
    ) {
      credential.status = credential.enabled === false ? "disabled" : "ready"
      credential.cooldownUntil = undefined
      lifted = true
    }
    if (clearRestsForCredential(credential.id)) lifted = true
  }
  if (!lifted) return false
  setConnectionCooldownUntil(connection, undefined)
  setConnectionRateLimitInfo(connection, undefined, undefined)
  logger.info(
    `Connection "${connection.name}" quota recovered upstream — local rest lifted`,
  )
  return true
}
