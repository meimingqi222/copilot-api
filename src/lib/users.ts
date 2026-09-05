import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { randomUUID } from "node:crypto"

import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { Repository } from "~/lib/repository"
import { parseModelRef } from "~/lib/route-target/model-reference"
import { state } from "~/lib/state"
import { globalTimers } from "~/lib/timer-registry"

export interface User {
  id: string
  username: string
  hashedApiKey: string
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

export type PublicUser = Omit<User, "hashedApiKey">

const hashKey = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex")

const keysMatch = (raw: string, hashed: string): boolean => {
  try {
    const a = Buffer.from(hashKey(raw), "hex")
    const b = Buffer.from(hashed, "hex")
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
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
    const hashedKey = hashKey(state.legacyApiKey)
    const existingLegacyAdmin = state.users.find(
      (u) => u.hashedApiKey === hashedKey,
    )
    if (!existingLegacyAdmin) {
      // Check for persisted admin with stale key — update key, preserve tokens
      const persistedAdmin = state.users.find(
        (u) => u.username === "admin" && u.role === "admin",
      )
      if (persistedAdmin) {
        persistedAdmin.hashedApiKey = hashedKey
      } else {
        const adminUser: User = {
          id: randomUUID(),
          username: "admin",
          hashedApiKey: hashedKey,
          quotaLimit: 0,
          usedTokens: 0,
          allowedModels: [],
          enabled: true,
          role: "admin",
          createdAt: Date.now(),
        }
        state.users.push(adminUser)
      }
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
): UserWithKey {
  const rawKey = `sk-${randomBytes(32).toString("hex")}`
  const user: User = {
    id: randomUUID(),
    username,
    hashedApiKey: hashKey(rawKey),
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
): Promise<UserWithKey> {
  const userWithKey = createUserSync(username, quotaLimit, role, allowedModels)
  await saveUsers()
  return userWithKey
}

export function verifyApiKey(rawKey: string): User | null {
  for (const user of state.users) {
    if (keysMatch(rawKey, user.hashedApiKey)) {
      return user
    }
  }
  return null
}

export async function updateUser(
  id: string,
  patch: Partial<
    Pick<User, "username" | "quotaLimit" | "enabled" | "role" | "allowedModels">
  >,
): Promise<User | null> {
  const user = state.users.find((u) => u.id === id)
  if (!user) return null
  Object.assign(user, {
    ...patch,
    allowedModels:
      patch.allowedModels === undefined ?
        user.allowedModels
      : normalizeAllowedModels(patch.allowedModels),
  })
  await saveUsers()
  return user
}

export async function deleteUser(id: string): Promise<boolean> {
  const idx = state.users.findIndex((u) => u.id === id)
  if (idx === -1) return false
  state.users.splice(idx, 1)
  await saveUsers()
  return true
}

export async function resetApiKey(id: string): Promise<string | null> {
  const user = state.users.find((u) => u.id === id)
  if (!user) return null
  const rawKey = `sk-${randomBytes(32).toString("hex")}`
  user.hashedApiKey = hashKey(rawKey)
  await saveUsers()
  return rawKey
}

export function toPublicUser(user: User): PublicUser {
  const { hashedApiKey: _hashed, ...rest } = user
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
