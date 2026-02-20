import type { Context, Next } from "hono"

import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { randomBytes } from "node:crypto"

import { state } from "./state"

const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12
export const ADMIN_SESSION_COOKIE = "copilot_api_admin"

export async function requireApiKey(c: Context, next: Next) {
  if (
    c.req.path === "/"
    || c.req.path.startsWith("/admin")
    || c.req.path.startsWith("/usage")
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
  return Boolean(token && token === configuredApiKey)
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
