import type { OAuthAccount, OAuthAccountCredentials } from "~/lib/accounts"

export interface OAuthBundleCore {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

/**
 * 通用 OAuth bundle 落库:写 credentials(undefined 字段保留旧值)
 * 并将 runtimeState 置为 ready。
 * extraCredentials 承载 provider 专属字段(email/idToken/deviceId/
 * projectId/accountId 等),同样遵循 undefined 保留旧值的语义。
 */
export function applyOAuthBundle(
  account: OAuthAccount,
  bundle: OAuthBundleCore,
  extraCredentials?: OAuthAccountCredentials,
): void {
  const old = account.credentials
  account.credentials = {
    ...old,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken ?? old?.refreshToken,
    expiresAt: bundle.expiresAt ?? old?.expiresAt,
    ...mergeExtraCredentials(old, extraCredentials),
  }
  account.runtimeState = {
    ...account.runtimeState,
    authStatus: "ready",
    lastRefreshAt: Date.now(),
    lastError: undefined,
  }
}

/**
 * Merge provider-specific credential fields, preserving old values
 * when the new value is undefined. Iterates via a string-keyed record
 * view to avoid per-field type narrowing issues, then casts back —
 * only known OAuthAccountCredentials keys are ever written.
 */
function mergeExtraCredentials(
  old: OAuthAccountCredentials | undefined,
  extras: OAuthAccountCredentials | undefined,
): OAuthAccountCredentials {
  if (!extras) {
    return {}
  }
  const result: Record<string, unknown> = {}
  const oldRecord = old as Record<string, unknown> | undefined
  const extrasRecord = extras as Record<string, unknown>
  for (const key of Object.keys(extrasRecord)) {
    const newVal = extrasRecord[key]
    if (newVal !== undefined) {
      result[key] = newVal
    } else if (oldRecord?.[key] !== undefined) {
      result[key] = oldRecord[key]
    }
  }
  return result as OAuthAccountCredentials
}
