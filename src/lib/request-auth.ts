import type { Context, Next } from "hono"

import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import { state } from "./state"
import { verifyApiKey } from "./users"

const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12
export const ADMIN_SESSION_COOKIE = "copilot_api_admin"

// Paths that are explicitly public and require no API key.
// /admin route handler performs its own auth checks internally.
const PUBLIC_PATHS = new Set(["/", "/admin/login", "/health"])
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
    // Store user info in context for logging
    c.set("userId" as never, user.id)
    c.set("username" as never, user.username)
    await next()
    return
  }

  // Legacy single-key mode
  if (hasValidLegacyApiKey(c)) {
    await next()
    return
  }

  // No auth configured — allow all
  if (!state.legacyApiKey && !state.apiKey) {
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
  const configuredApiKey = state.legacyApiKey ?? state.apiKey
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

export function setAdminSession(c: Context) {
  const configuredAdminPassword = getAdminPassword()
  if (!configuredAdminPassword) return

  const sessionToken = createSessionToken()
  state.adminSessionToken = sessionToken
  state.adminSessionExpiresAt =
    Date.now() + ADMIN_SESSION_MAX_AGE_SECONDS * 1000

  const isHttps = c.req.url.startsWith("https://")
  setCookie(c, ADMIN_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps,
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
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
  return state.adminPassword ?? state.apiKey
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

  const [scheme, token] = authHeader.split(" ")
  if (scheme.toLowerCase() !== "bearer") return null
  if (!token) return null

  return token
}
