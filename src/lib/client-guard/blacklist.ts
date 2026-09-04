import type { BlacklistEntry } from "./types"

import { saveGuard } from "./persistence"
import { ipBlacklist, uaBlacklist } from "./state"

// ── Blacklist operations ───────────────────────────────────────

export function isBlocked(opts: {
  ip?: string
  ua?: string
}): BlacklistEntry | null {
  const removed = pruneExpiredBlacklistEntries()
  if (removed > 0) {
    void saveGuard()
  }

  if (opts.ip) {
    const entry = ipBlacklist.get(opts.ip)
    if (entry) return entry
  }
  if (opts.ua) {
    const ua = opts.ua.toLowerCase()
    for (const [pattern, entry] of uaBlacklist) {
      if (ua.includes(pattern.toLowerCase())) return entry
    }
  }
  return null
}

export async function addBlacklistEntry(
  entry: Omit<BlacklistEntry, "createdAt">,
): Promise<BlacklistEntry> {
  const full: BlacklistEntry = {
    ...entry,
    source: entry.source ?? "manual",
    createdAt: Date.now(),
  }
  if (entry.type === "ip") {
    ipBlacklist.set(entry.value, full)
  } else {
    uaBlacklist.set(entry.value, full)
  }
  await saveGuard()
  return full
}

export async function removeBlacklistEntry(opts: {
  value: string
  type: "ip" | "ua"
}): Promise<boolean> {
  const map = opts.type === "ip" ? ipBlacklist : uaBlacklist
  const existed = map.delete(opts.value)
  if (existed) await saveGuard()
  return existed
}

export function getBlacklist(): Array<BlacklistEntry> {
  pruneExpiredBlacklistEntries()
  return [...ipBlacklist.values(), ...uaBlacklist.values()].sort(
    (a, b) => b.createdAt - a.createdAt,
  )
}

export function pruneExpiredBlacklistEntries(): number {
  let removed = 0
  for (const [key, entry] of ipBlacklist) {
    if (!isExpired(entry)) continue
    ipBlacklist.delete(key)
    removed += 1
  }
  for (const [key, entry] of uaBlacklist) {
    if (!isExpired(entry)) continue
    uaBlacklist.delete(key)
    removed += 1
  }
  return removed
}

export function isExpired(entry: BlacklistEntry): boolean {
  return typeof entry.expiresAt === "number" && entry.expiresAt <= Date.now()
}
