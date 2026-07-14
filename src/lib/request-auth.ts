import type { Context, Next } from "hono"

import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import { state } from "./state"
import { statsStore } from "./stats-store"
import { verifyApiKey } from "./users"

const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12
const REMEMBER_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
export const ADMIN_SESSION_COOKIE = "copilot_api_admin"
const ADMIN_PASSWORD_CONFIG_KEY = "admin_password_hash"

// Paths that are explicitly public and require no API key.
// /admin route handler performs its own auth checks internally.
const PUBLIC_PATHS = new Set([
  "/",
  "/admin/login",
  "/admin/setup",
  "/health",
  "/ws/mimo",
])
const PUBLIC_PREFIXES = ["/admin"]

export async function requireApiKey(c: Context, next: Next) {
  if (
    PUBLIC_PATHS.has(c.req.path)
    || PUBLIC_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))
  ) {
    await next()
    return
  }

  // Multi-user mode: verify against users list
  if (state.users.length > 0) {
    const rawKey = extractApiKey(c)
    if (!rawKey) {
      return c.json(
        {
          error: {
            message:
              "Unauthorized. Provide Authorization: Bearer <API_KEY> or X-Api-Key: <API_KEY>.",
            type: "authentication_error",
          },
        },
        401,
      )
    }
    const user = verifyApiKey(rawKey)
    if (!user) {
      return c.json(
        {
          error: {
            message: "Unauthorized. Invalid API key.",
            type: "authentication_error",
          },
        },
        401,
      )
    }
    if (!user.enabled) {
      return c.json(
        {
          error: {
            message: "Forbidden. This API key has been disabled.",
            type: "authentication_error",
          },
        },
        403,
      )
    }
    if (user.quotaLimit > 0 && user.usedTokens >= user.quotaLimit) {
      return c.json(
        {
          error: {
            message:
              "Quota exceeded. This API key has used all allowed tokens.",
            type: "rate_limit_error",
          },
        },
        429,
      )
    }
    // Store user info in context for logging
    c.set("userId", user.id)
    c.set("username", user.username)
    c.set("user", user)
    await next()
    return
  }

  // Legacy single-key mode
  if (hasValidLegacyApiKey(c)) {
    await next()
    return
  }

  // No auth configured — allow all
  if (!state.legacyApiKey) {
    await next()
    return
  }

  return c.json(
    {
      error: {
        message:
          "Unauthorized. Provide Authorization: Bearer <API_KEY> or X-Api-Key: <API_KEY>.",
        type: "authentication_error",
      },
    },
    401,
  )
}

export function isAuthorizedRequest(c: Context): boolean {
  if (state.users.length > 0) {
    const rawKey = extractApiKey(c)
    if (rawKey) {
      const user = verifyApiKey(rawKey)
      if (user?.enabled) return true
    }
  } else if (hasValidLegacyApiKey(c)) {
    return true
  }

  return hasValidAdminSession(c)
}

/**
 * Check if the request has admin role
 * - For API key auth: user must have role="admin"
 * - For legacy API key: always true (legacy key has full admin access)
 * - For admin session: always true (session is created via admin password)
 */
export function hasAdminRole(c: Context): boolean {
  // Check API key auth first
  if (state.users.length > 0) {
    const rawKey = extractApiKey(c)
    if (rawKey) {
      const user = verifyApiKey(rawKey)
      // User must be enabled AND have admin role
      if (user?.enabled && user.role === "admin") {
        return true
      }
    }
  } else if (hasValidLegacyApiKey(c)) {
    // Legacy API key has full admin access
    return true
  }

  // Admin session (created via admin password login) has full access
  return hasValidAdminSession(c)
}

function hasValidLegacyApiKey(c: Context): boolean {
  const configuredApiKey = state.legacyApiKey
  if (!configuredApiKey) return false

  const token = extractApiKey(c)
  if (!token) return false

  // Use constant-time comparison to prevent timing attacks.
  try {
    const tokenBuf = Buffer.from(token)
    const keyBuf = Buffer.from(configuredApiKey)
    return (
      tokenBuf.length === keyBuf.length && timingSafeEqual(tokenBuf, keyBuf)
    )
  } catch {
    return false
  }
}

export function setAdminSession(c: Context, remember = false) {
  const configuredAdminPassword = getAdminPassword()
  if (!configuredAdminPassword) return

  const maxAgeSeconds =
    remember ? REMEMBER_SESSION_MAX_AGE_SECONDS : ADMIN_SESSION_MAX_AGE_SECONDS

  const sessionToken = createSessionToken()
  state.adminSessionToken = sessionToken
  state.adminSessionExpiresAt = Date.now() + maxAgeSeconds * 1000

  const isHttps =
    c.req.url.startsWith("https://")
    || c.req.header("x-forwarded-proto") === "https"
  const cookieSecureEnv = process.env.COOKIE_SECURE
  let secure = isHttps
  if (cookieSecureEnv === "true" || cookieSecureEnv === "1") {
    secure = true
  } else if (cookieSecureEnv === "false" || cookieSecureEnv === "0") {
    secure = false
  }

  setCookie(c, ADMIN_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
    maxAge: maxAgeSeconds,
  })
}

export function clearAdminSession(c: Context) {
  state.adminSessionToken = undefined
  state.adminSessionExpiresAt = undefined
  deleteCookie(c, ADMIN_SESSION_COOKIE, { path: "/" })
}

function hasValidAdminSession(c: Context): boolean {
  const sessionExpiresAt = state.adminSessionExpiresAt
  if (!sessionExpiresAt || Date.now() > sessionExpiresAt) {
    state.adminSessionToken = undefined
    state.adminSessionExpiresAt = undefined
    return false
  }

  const sessionValue = getCookie(c, ADMIN_SESSION_COOKIE)
  const sessionToken = state.adminSessionToken
  return Boolean(sessionValue && sessionToken && sessionValue === sessionToken)
}

function getAdminPassword(): string | undefined {
  return (
    state.adminPassword ?? state.legacyApiKey ?? loadAdminPasswordHashFromDb()
  )
}

function loadAdminPasswordHashFromDb(): string | undefined {
  try {
    return statsStore.getConfig(ADMIN_PASSWORD_CONFIG_KEY)
  } catch {
    return undefined
  }
}

function hashAdminPassword(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

/**
 * Persist a hashed admin password to stats.db. Used by the initial setup flow.
 * Env/CLI provided passwords still take precedence at runtime.
 * Accepts either a plaintext password or an already-hashed "sha256:<hex>" value.
 */
export function saveAdminPasswordToDb(password: string): void {
  const normalized =
    password.startsWith("sha256:") ? password : hashAdminPassword(password)
  statsStore.setConfig(ADMIN_PASSWORD_CONFIG_KEY, normalized)
}

/**
 * Check whether an admin password is configured anywhere (env/CLI or database).
 */
export function isAdminPasswordConfigured(): boolean {
  return Boolean(
    state.adminPassword || state.legacyApiKey || loadAdminPasswordHashFromDb(),
  )
}

/**
 * Load admin password hash from stats.db into runtime state.
 * Called once at startup when no env/CLI password was provided.
 */
export function loadAdminPasswordFromDb(): void {
  const hash = loadAdminPasswordHashFromDb()
  if (hash) {
    state.adminPassword = hash
  }
}

/**
 * Verify a plaintext password against the configured admin password.
 * Supports two formats:
 * - Plain text: direct constant-time comparison
 * - Hashed: "sha256:<hex>" — hash the input and compare
 */
export function verifyAdminPassword(input: string): boolean {
  const configured = getAdminPassword()
  if (!configured) return false

  if (configured.startsWith("sha256:")) {
    const expectedHash = configured.slice(7)
    const inputHash = createHash("sha256").update(input).digest("hex")
    try {
      const a = Buffer.from(inputHash)
      const b = Buffer.from(expectedHash)
      return a.length === b.length && timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  // Plain text comparison
  try {
    const a = Buffer.from(input)
    const b = Buffer.from(configured)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function createSessionToken(): string {
  return randomBytes(32).toString("hex")
}

/**
 * Extract API key from either OpenAI-style Bearer token or Anthropic-style x-api-key header.
 * Tries Authorization: Bearer <token> first, then x-api-key.
 */
function extractApiKey(c: Context): string | null {
  const authHeader = c.req.header("authorization")
  const bearer = extractBearerToken(authHeader)
  if (bearer) return bearer

  const xApiKey = c.req.header("x-api-key")
  if (xApiKey?.trim()) return xApiKey.trim()

  return null
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null

  const trimmed = authHeader.trim()
  const match = trimmed.match(/^Bearer\s+(\S+)$/i)
  if (!match) return null

  return match[1]
}
