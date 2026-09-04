import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { Repository } from "~/lib/repository"
import { globalTimers } from "~/lib/timer-registry"

import type { GuardPersistence } from "./types"

import {
  getBlacklist,
  isExpired,
  pruneExpiredBlacklistEntries,
} from "./blacklist"
import {
  CLEANUP_INTERVAL_MS,
  SNAPSHOT_WINDOW_MS,
  customUaWhitelist,
  ipBlacklist,
  ipSnapshots,
  uaBlacklist,
  uaSnapshots,
} from "./state"

let cleanupTimer: ReturnType<typeof setInterval> | undefined
let persistenceEnabled = true

export function ensureCleanup() {
  if (cleanupTimer) return
  cleanupTimer = globalTimers.interval(() => {
    const cutoff = Date.now() - SNAPSHOT_WINDOW_MS
    for (const [key, snap] of ipSnapshots) {
      if (snap.lastSeenAt < cutoff) ipSnapshots.delete(key)
    }
    for (const [key, snap] of uaSnapshots) {
      if (snap.lastSeenAt < cutoff) uaSnapshots.delete(key)
    }

    const removed = pruneExpiredBlacklistEntries()
    if (removed > 0) {
      void saveGuard()
    }
  }, CLEANUP_INTERVAL_MS)
}

// ── Persistence ────────────────────────────────────────────────

const guardRepository = new Repository<GuardPersistence>({
  filePath: () => PATHS.GUARD_PATH,
  serialize: (data) => JSON.stringify(data, null, 2),
  deserialize: (raw) => JSON.parse(raw) as GuardPersistence,
  corruptMessage: "guard.json is corrupt",
})

export async function loadGuard(): Promise<void> {
  try {
    const data = await guardRepository.load()
    if (!data) return
    for (const entry of data.blacklist || []) {
      if (isExpired(entry)) continue
      const map = entry.type === "ip" ? ipBlacklist : uaBlacklist
      map.set(entry.value, { ...entry, source: entry.source ?? "manual" })
    }
    for (const pattern of data.uaWhitelist || []) {
      if (!customUaWhitelist.includes(pattern)) {
        customUaWhitelist.push(pattern)
      }
    }
    logger.info(
      `Guard loaded: ${ipBlacklist.size} blocked IPs, ${uaBlacklist.size} blocked UAs, ${customUaWhitelist.length} custom UA patterns`,
    )
  } catch {
    // File doesn't exist yet — that's fine
  }
}

export async function saveGuard(): Promise<void> {
  if (!persistenceEnabled) return
  await guardRepository.save({
    blacklist: getBlacklist(),
    uaWhitelist: [...customUaWhitelist],
  })
}

export function resetGuardForTest(): void {
  persistenceEnabled = false
  ipBlacklist.clear()
  uaBlacklist.clear()
  ipSnapshots.clear()
  uaSnapshots.clear()
  customUaWhitelist.splice(0)
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = undefined
  }
}
