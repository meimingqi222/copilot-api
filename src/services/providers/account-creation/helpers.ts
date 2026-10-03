import type { CreateAccountBody } from "~/services/providers/account-creation/types"

/** Nested credentials take precedence, including explicitly empty values. */
export function credentialString(
  body: CreateAccountBody,
  key: string,
  legacy?: string,
): string | undefined {
  const value = body.credentials?.[key]
  return typeof value === "string" ? value.trim() : legacy?.trim()
}

/** JWT expiry is a scheduling hint, not token verification. */
export function extractJwtExp(token: string): number | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(
      Buffer.from(
        parts[1].replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString("utf8"),
    ) as { exp?: number }
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}
