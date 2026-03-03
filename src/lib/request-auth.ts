import type { Context, Next } from "hono"

import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { randomBytes, timingSafeEqual } from "node:crypto"

import { state } from "./state"
import { verifyApiKey } from "./users"

const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12
export const ADMIN_SESSION_COOKIE = "copilot_api_admin"

// Paths that are explicitly public and require no API key.
// /admin and /usage route handlers perform their own auth checks internally.
const PUBLIC_PATHS = new Set(["/", "/admin/login", "/health"])
const PUBLIC_PREFIXES = ["/admin", "/usage"]

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
    const authHeader = c.req.header("authorization")
    const rawKey = extractBearerToken(authHeader)
    if (!rawKey) {
      return c.json(
        {
          error: {
            message: "Unauthorized. Provide Authorization: Bearer <API_KEY>.",
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
        message: "Unauthorized. Provide Authorization: Bearer <API_KEY>.",
        type: "authentication_error",
      },
    },
    401,
  )
}

export function isAuthorizedRequest(c: Context): boolean {
  if (state.users.length > 0) {
    const authHeader = c.req.header("authorization")
    const rawKey = extractBearerToken(authHeader)
    if (rawKey) {
      const user = verifyApiKey(rawKey)
      if (user?.enabled) return true
    }
  } else if (hasValidLegacyApiKey(c)) {
    return true
  }

  return hasValidAdminSession(c)
}

function hasValidLegacyApiKey(c: Context): boolean {
  const configuredApiKey = state.legacyApiKey ?? state.apiKey
  if (!configuredApiKey) return true

  const authHeader = c.req.header("authorization")
  const token = extractBearerToken(authHeader)
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

function createSessionToken(): string {
  return randomBytes(32).toString("hex")
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null

  const [scheme, token] = authHeader.split(" ")
  if (scheme.toLowerCase() !== "bearer") return null
  if (!token) return null

  return token
}
