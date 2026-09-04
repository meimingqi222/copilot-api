import { saveGuard } from "./persistence"
import { BUILTIN_UA_PATTERNS, customUaWhitelist } from "./state"

export function isKnownUA(ua: string): boolean {
  const lower = ua.toLowerCase()
  for (const pattern of BUILTIN_UA_PATTERNS) {
    if (lower.includes(pattern)) return true
  }
  for (const pattern of customUaWhitelist) {
    if (lower.includes(pattern.toLowerCase())) return true
  }
  return false
}

// ── UA Whitelist management ────────────────────────────────────

export function getUaWhitelist(): Array<string> {
  return [...BUILTIN_UA_PATTERNS, ...customUaWhitelist]
}

export function getCustomUaWhitelist(): Array<string> {
  return [...customUaWhitelist]
}

export async function addUaWhitelistPattern(pattern: string): Promise<void> {
  const lower = pattern.toLowerCase().trim()
  if (!lower || customUaWhitelist.includes(lower)) return
  customUaWhitelist.push(lower)
  await saveGuard()
}

export async function removeUaWhitelistPattern(
  pattern: string,
): Promise<boolean> {
  const idx = customUaWhitelist.indexOf(pattern.toLowerCase().trim())
  if (idx === -1) return false
  customUaWhitelist.splice(idx, 1)
  await saveGuard()
  return true
}
