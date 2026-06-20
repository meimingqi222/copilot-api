function decodeBase64Url(value: string): string | null {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  try {
    return Buffer.from(padded, "base64").toString("utf8")
  } catch {
    return null
  }
}

export function parseJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.trim().split(".")
  if (segments.length < 2) {
    return null
  }
  const decoded = decodeBase64Url(segments[1])
  if (!decoded) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(decoded)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

export function extractCodexAccountIdFromIdToken(
  idToken: string | undefined,
): string | undefined {
  if (!idToken) {
    return undefined
  }
  const claims = parseJwtPayload(idToken)
  if (!claims) {
    return undefined
  }
  const authInfo = claims["https://api.openai.com/auth"]
  if (authInfo && typeof authInfo === "object" && !Array.isArray(authInfo)) {
    const accountId = (authInfo as Record<string, unknown>).chatgpt_account_id
    if (typeof accountId === "string" && accountId.trim()) {
      return accountId.trim()
    }
  }
  return undefined
}

export function extractEmailFromIdToken(
  idToken: string | undefined,
): string | undefined {
  if (!idToken) {
    return undefined
  }
  const claims = parseJwtPayload(idToken)
  const email = claims?.email
  return typeof email === "string" && email.trim() ? email.trim() : undefined
}
