import type { Context, Next } from "hono"

import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { randomBytes, timingSafeEqual } from "node:crypto"

import { state } from "./state"

const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12
export const ADMIN_SESSION_COOKIE = "copilot_api_admin"

// Paths that are explicitly public and require no API key.
// /admin and /usage route handlers perform their own auth checks internally.
const PUBLIC_PATHS = new Set(["/", "/admin/login"])
const PUBLIC_PREFIXES = ["/admin", "/usage"]

export async function requireApiKey(c: Context, next: Next) {
  if (
    PUBLIC_PATHS.has(c.req.path)
    || PUBLIC_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))
  ) {
    await next()
    return
  }

  if (hasValidApiKey(c)) {
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
  if (hasValidApiKey(c)) {
    return true
  }

  return hasValidAdminSession(c)
}

function hasValidApiKey(c: Context): boolean {
  const configuredApiKey = state.apiKey
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
