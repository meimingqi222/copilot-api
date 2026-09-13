import { createHash } from "node:crypto"
import { randomBytes, randomUUID } from "node:crypto"

import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { Repository } from "~/lib/repository"
import { parseModelRef } from "~/lib/route-target/model-reference"
import { hashSecret, verifySecret } from "~/lib/secret-hash"
import { state } from "~/lib/state"
import { globalTimers } from "~/lib/timer-registry"

export interface User {
  id: string
  username: string
  hashedApiKey: string
  /** SHA-256 fingerprint of the raw key — fast lookup index, not a secret. */
  keyFingerprint?: string
  /** Epoch ms after which the key is rejected (401). Absent = never expires. */
  expiresAt?: number
  quotaLimit: number
  usedTokens: number
  allowedModels?: Array<string>
  enabled: boolean
  role: "admin" | "user"
  createdAt: number
  lastUsedAt?: number
}

export interface UserWithKey extends User {
  apiKey: string
}

export type PublicUser = Omit<User, "hashedApiKey" | "keyFingerprint">

const fingerprintKey = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex")

// Short-TTL verification cache: scrypt is intentionally slow (~tens of ms),
// so a verified key maps fingerprint → userId for 60s. Every hit re-resolves
// the user object from state and re-checks enabled/expiry, and all mutations
// (update/delete/reset) drop the user's entries — a revoked key is honored
// within one request, not one TTL.
const VERIFY_CACHE_TTL_MS = 60_000
const verifyCache = new Map<string, { userId: string; expires: number }>()

function dropVerifyCacheForUser(id: string): void {
  for (const [fp, entry] of verifyCache) {
    if (entry.userId === id) verifyCache.delete(fp)
  }
}

export function isUserExpired(user: User, now = Date.now()): boolean {
  return typeof user.expiresAt === "number" && user.expiresAt <= now
}

/** Finite-number check for an expiry timestamp patch value. */
export function isValidExpiry(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

const usersRepository = new Repository<Array<User>>({
  filePath: () => PATHS.USERS_PATH,
  serialize: (data) => JSON.stringify(data, null, 2),
  deserialize: (raw) => JSON.parse(raw) as Array<User>,
})

export async function loadUsers(): Promise<void> {
  const rawUsers = await usersRepository.load()
  state.users = rawUsers ? rawUsers.map((user) => normalizeUser(user)) : []

  // If a legacy API key is configured, ensure the in-memory admin user exists.
  // This keeps --api-key functional even after users.json is created/modified.
  if (state.legacyApiKey) {
    const existingLegacyAdmin = state.users.find((u) =>
      verifySecret(state.legacyApiKey as string, u.hashedApiKey),
    )
    if (!existingLegacyAdmin) {
      // Check for persisted admin with stale key — update key, preserve tokens.
      // Only re-hash when the persisted key no longer verifies against the
      // configured legacy key; otherwise the existing scrypt hash (with its
      // salt) is reused to avoid rewriting users.json on every boot.
      const persistedAdmin = state.users.find(
        (u) => u.username === "admin" && u.role === "admin",
      )
      if (persistedAdmin) {
        persistedAdmin.hashedApiKey = hashSecret(state.legacyApiKey)
        persistedAdmin.keyFingerprint = fingerprintKey(state.legacyApiKey)
      } else {
        const adminUser: User = {
          id: randomUUID(),
          username: "admin",
          hashedApiKey: hashSecret(state.legacyApiKey),
          keyFingerprint: fingerprintKey(state.legacyApiKey),
          quotaLimit: 0,
          usedTokens: 0,
          allowedModels: [],
          enabled: true,
          role: "admin",
          createdAt: Date.now(),
        }
        state.users.push(adminUser)
      }
    } else if (!existingLegacyAdmin.keyFingerprint) {
      // Backfill fingerprint on a legacy admin that already verifies, so the
      // fast path in verifyApiKey applies on subsequent requests.
      existingLegacyAdmin.keyFingerprint = fingerprintKey(state.legacyApiKey)
    }
  }
}

export async function saveUsers(): Promise<void> {
  await usersRepository.save(state.users)
}

const USER_TOKENS_FLUSH_MS = 5_000
let userTokensDirty = false
let userTokensFlushTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic flush of coalesced token counts. Idempotent. */
export function startUserTokenFlusher(): void {
  if (userTokensFlushTimer) return
  userTokensFlushTimer = globalTimers.interval(() => {
    void flushUserTokens()
  }, USER_TOKENS_FLUSH_MS)
}

export function stopUserTokenFlusherForTest(): void {
  if (userTokensFlushTimer) {
    globalTimers.clearInterval(userTokensFlushTimer)
    userTokensFlushTimer = null
  }
}

/** Persist pending token counts if any. No-op when nothing changed. */
export async function flushUserTokens(): Promise<void> {
  if (!userTokensDirty) return
  userTokensDirty = false
  try {
    await saveUsers()
  } catch (error) {
    userTokensDirty = true
    logger.warn("Failed to flush user token counts:", error)
  }
}

export function createUserSync(
  username: string,
  quotaLimit = 0,
  role: "admin" | "user" = "user",
  allowedModels: Array<string> = [],
  opts: { expiresAt?: number } = {},
): UserWithKey {
  const rawKey = `sk-${randomBytes(32).toString("hex")}`
  const user: User = {
    id: randomUUID(),
    username,
    hashedApiKey: hashSecret(rawKey),
    keyFingerprint: fingerprintKey(rawKey),
    expiresAt: opts.expiresAt,
    quotaLimit,
    usedTokens: 0,
    allowedModels: normalizeAllowedModels(allowedModels),
    enabled: true,
    role,
    createdAt: Date.now(),
  }
  state.users.push(user)
  return { ...user, apiKey: rawKey }
}

export async function createUser(
  username: string,
  quotaLimit = 0,
  role: "admin" | "user" = "user",
  allowedModels: Array<string> = [],
  opts: { expiresAt?: number } = {},
): Promise<UserWithKey> {
  const userWithKey = createUserSync(
    username,
    quotaLimit,
    role,
    allowedModels,
    opts,
  )
  await saveUsers()
  return userWithKey
}

/**
 * Find a user by raw key without fully verifying the secret.
 *
 * Fast path: fingerprint match (modern users store keyFingerprint).
 * Slow path: legacy users loaded from disk have no fingerprint, so a
 * constant-time scrypt verify is required to identify them. This is only
 * used on the expired-key short-circuit in requireApiKey, which is rare
 * and not in the hot auth path.
 */
export function findUserByKeyFingerprint(rawKey: string): User | undefined {
  const fp = fingerprintKey(rawKey)
  const byFp = state.users.find((u) => u.keyFingerprint === fp)
  if (byFp) return byFp
  // Legacy users without a fingerprint: fall back to secret verification.
  return state.users.find(
    (u) => !u.keyFingerprint && verifySecret(rawKey, u.hashedApiKey),
  )
}

export function verifyApiKey(rawKey: string): User | null {
  const now = Date.now()
  const fp = fingerprintKey(rawKey)
  const cached = verifyCache.get(fp)
  if (cached) {
    if (cached.expires <= now) {
      verifyCache.delete(fp)
    } else {
      const user = state.users.find((u) => u.id === cached.userId)
      // Re-resolve every hit: disabled/expired/rotated keys fall through.
      // Legacy users loaded from disk have no keyFingerprint; cache entries
      // are still valid because mutations drop them by userId (see
      // dropVerifyCacheForUser), so a rotated/disabled key never survives.
      if (
        user
        && !isUserExpired(user, now)
        && (!user.keyFingerprint || user.keyFingerprint === fp)
      ) {
        return user
      }
      verifyCache.delete(fp)
    }
  }
  if (verifyCache.size > 5000) {
    for (const [key, entry] of verifyCache) {
      if (entry.expires <= now) verifyCache.delete(key)
    }
  }
  for (const user of state.users) {
    // Fingerprint-indexed fast path: skip users that provably don't match,
    // so one scrypt (~tens of ms) runs per lookup instead of per user.
    if (user.keyFingerprint && user.keyFingerprint !== fp) continue
    if (!verifySecret(rawKey, user.hashedApiKey)) continue
    if (isUserExpired(user, now)) return null
    verifyCache.set(fp, { userId: user.id, expires: now + VERIFY_CACHE_TTL_MS })
    return user
  }
  return null
}

export async function updateUser(
  id: string,
  patch: Partial<
    Pick<
      User,
      | "username"
      | "quotaLimit"
      | "enabled"
      | "role"
      | "allowedModels"
      | "expiresAt"
    >
  >,
): Promise<User | null> {
  const user = state.users.find((u) => u.id === id)
  if (!user) return null
  if (patch.expiresAt !== undefined && !isValidExpiry(patch.expiresAt)) {
    return null
  }
  Object.assign(user, {
    ...patch,
    allowedModels:
      patch.allowedModels === undefined ?
        user.allowedModels
      : normalizeAllowedModels(patch.allowedModels),
  })
  dropVerifyCacheForUser(id)
  await saveUsers()
  return user
}

export async function deleteUser(id: string): Promise<boolean> {
  const idx = state.users.findIndex((u) => u.id === id)
  if (idx === -1) return false
  state.users.splice(idx, 1)
  dropVerifyCacheForUser(id)
  await saveUsers()
  return true
}

export async function resetApiKey(id: string): Promise<string | null> {
  const user = state.users.find((u) => u.id === id)
  if (!user) return null
  const rawKey = `sk-${randomBytes(32).toString("hex")}`
  user.hashedApiKey = hashSecret(rawKey)
  user.keyFingerprint = fingerprintKey(rawKey)
  dropVerifyCacheForUser(id)
  await saveUsers()
  return rawKey
}

export function toPublicUser(user: User): PublicUser {
  const { hashedApiKey: _hashed, keyFingerprint: _fp, ...rest } = user
  return rest
}

/**
 * Increment user's usedTokens count (memory only; flushed on an interval).
 *
 * Token increments are the hottest write path (once per chat request), so
 * they mutate `state.users` synchronously and defer the `users.json` rewrite
 * to `flushUserTokens()`. Memory stays authoritative for quota enforcement
 * (`verifyApiKey`/quota checks read `state.users`); a crash loses at most
 * one flush interval of usage counts. Structural mutations
 * (create/update/delete/resetKey/resetTokens) still save immediately.
 */
export async function incrementUserTokens(
  userId: string,
  tokens: number,
): Promise<boolean> {
  const user = state.users.find((u) => u.id === userId)
  if (!user) return false
  user.usedTokens += tokens
  user.lastUsedAt = Date.now()
  userTokensDirty = true
  return true
}

export async function resetUserTokens(id: string): Promise<boolean> {
  const user = state.users.find((u) => u.id === id)
  if (!user) return false
  user.usedTokens = 0
  await saveUsers()
  return true
}

/**
 * Strip a recognized routing prefix (providerId/connectionId) keeping the
 * bare model id. `parseModelRef` only strips prefixes it identifies; a model
 * name that itself contains `/` (e.g. `z-ai/glm-5.1`) is kept intact.
 */
function bareModelId(model: string): string {
  return parseModelRef(model).modelId
}

export function isUserAllowedModel(user: User, model: string): boolean {
  const allowedModels = user.allowedModels ?? []
  if (allowedModels.length === 0) return true
  const bare = bareModelId(model)
  return allowedModels.some((allowed) => bareModelId(allowed) === bare)
}

type PersistedUser = Partial<User>
  & Pick<User, "id" | "username" | "hashedApiKey">

function normalizeUser(user: PersistedUser): User {
  return {
    ...user,
    quotaLimit: user.quotaLimit ?? 0,
    usedTokens: user.usedTokens ?? 0,
    allowedModels: normalizeAllowedModels(user.allowedModels ?? []),
    enabled: user.enabled ?? true,
    role: user.role ?? "user",
    createdAt: user.createdAt ?? Date.now(),
  }
}

function normalizeAllowedModels(models: Array<string>): Array<string> {
  return Array.from(
    new Set(
      models.map((model) => model.trim()).filter((model) => model.length > 0),
    ),
  )
}
