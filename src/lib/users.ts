import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs/promises"

import { randomUUID } from "node:crypto"

import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

export interface User {
  id: string
  username: string
  hashedApiKey: string
  quotaLimit: number
  usedTokens: number
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

export async function loadUsers(): Promise<void> {
  try {
    const data = await fs.readFile(PATHS.USERS_PATH, "utf8")
    const parsed = JSON.parse(data) as User[]
    state.users = parsed
    return
  } catch {
    // File doesn't exist — check for legacy API key
  }

  // If a legacy API key is configured, create in-memory admin user (not persisted)
  if (state.legacyApiKey) {
    const adminUser: User = {
      id: randomUUID(),
      username: "admin",
      hashedApiKey: hashKey(state.legacyApiKey),
      quotaLimit: 0,
      usedTokens: 0,
      enabled: true,
      role: "admin",
      createdAt: Date.now(),
    }
    state.users = [adminUser]
    return
  }

  state.users = []
}

export async function saveUsers(): Promise<void> {
  await fs.writeFile(PATHS.USERS_PATH, JSON.stringify(state.users, null, 2))
}

export function createUserSync(
  username: string,
  quotaLimit = 0,
  role: "admin" | "user" = "user",
): UserWithKey {
  const rawKey = randomBytes(32).toString("hex")
  const user: User = {
    id: randomUUID(),
    username,
    hashedApiKey: hashKey(rawKey),
    quotaLimit,
    usedTokens: 0,
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
): Promise<UserWithKey> {
  const userWithKey = createUserSync(username, quotaLimit, role)
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
  patch: Partial<Pick<User, "username" | "quotaLimit" | "enabled" | "role">>,
): Promise<User | null> {
  const user = state.users.find((u) => u.id === id)
  if (!user) return null
  Object.assign(user, patch)
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
  const rawKey = randomBytes(32).toString("hex")
  user.hashedApiKey = hashKey(rawKey)
  await saveUsers()
  return rawKey
}

export function toPublicUser(user: User): PublicUser {
  const { hashedApiKey: _hashed, ...rest } = user
  return rest
}

/**
 * Increment user's usedTokens count and save to disk
 * @param userId - The user's ID
 * @param tokens - Number of tokens to add
 * @returns true if successful, false if user not found
 */
export async function incrementUserTokens(userId: string, tokens: number): Promise<boolean> {
  const user = state.users.find((u) => u.id === userId)
  if (!user) return false
  user.usedTokens += tokens
  user.lastUsedAt = Date.now()
  await saveUsers()
  return true
}

