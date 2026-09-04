import type { Account } from "~/lib/legacy-accounts"

import { getOAuthAccessToken, getOAuthApiKey } from "~/lib/legacy-accounts"
import { buildAntigravityHubUserAgent } from "~/services/antigravity/version"

const TOKEN_PLACEHOLDER = "$TOKEN$"
const ANTIGRAVITY_UA_PLACEHOLDER = "$ANTIGRAVITY_UA$"

export function resolveAccountAccessToken(
  account: Account,
): string | undefined {
  const apiKey = getOAuthApiKey(account)
  if (apiKey) {
    return apiKey
  }
  return getOAuthAccessToken(account)
}

export function substituteTokenInHeaders(
  headers: Record<string, string> | undefined,
  token: string | undefined,
): Record<string, string> {
  if (!headers) {
    return {}
  }

  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    let replaced = value
    if (replaced.includes(TOKEN_PLACEHOLDER)) {
      replaced =
        token ? replaced.replaceAll(TOKEN_PLACEHOLDER, token) : replaced
    }
    if (replaced.includes(ANTIGRAVITY_UA_PLACEHOLDER)) {
      replaced = replaced.replaceAll(
        ANTIGRAVITY_UA_PLACEHOLDER,
        buildAntigravityHubUserAgent(),
      )
    }
    resolved[key] = replaced
  }
  return resolved
}

export function parseExpiresAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) {
      return undefined
    }
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    }
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return undefined
}
