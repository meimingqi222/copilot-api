import type { Context, Next } from "hono"

import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { randomBytes, timingSafeEqual } from "node:crypto"

import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from "./login-protection"
import { hashSecret, secretEquals, verifySecret } from "./secret-hash"
import { state } from "./state"
import { statsStore } from "./stats-store"
import { generateTotpSecret, totpSetupUri, verifyTotpCode } from "./totp"
import { findUserByKeyFingerprint, isUserExpired, verifyApiKey } from "./users"
import { getClientIp } from "./utils"

const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12
const REMEMBER_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
export const ADMIN_SESSION_COOKIE = "copilot_api_admin"
const ADMIN_PASSWORD_CONFIG_KEY = "admin_password_hash"
const ADMIN_TOTP_SECRET_CONFIG_KEY = "admin_totp_secret"
const TOTP_SETUP_TTL_MS = 10 * 60 * 1000
const TOTP_LOGIN_TTL_MS = 5 * 60 * 1000

// Paths that are explicitly public and require no API key.
// /admin route handler performs its own auth checks internally.
const PUBLIC_PATHS = new Set([
  "/",
  "/admin/login",
  "/admin/setup",
  "/health",
  "/ws/mimo",
  "/favicon.ico",
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
    // Brute-force shield for stolen-key spraying: same graduated lockout as
    // /admin/login (5→15m, 10→1h, 15→24h+blacklist), keyed by client IP.
    // Missing keys are not counted (usually misconfiguration, not attacks).
    const clientIp = getClientIp(c)
    const gate = checkLoginAllowed(clientIp)
    if (!gate.allowed) {
      if (gate.retryAfterSeconds) {
        c.header("Retry-After", String(gate.retryAfterSeconds))
      }
      return c.json(
        {
          error: {
            message: gate.reason ?? "Too many authentication attempts.",
            type: "authentication_error",
          },
        },
        429,
      )
    }
    const user = verifyApiKey(rawKey)
    if (!user) {
      // Expired keys are deterministic account state (stale cron job, not an
      // attack): report 401 without feeding the brute-force counter, so a
      // rotated replacement key works immediately instead of hitting a lock.
      const known = findUserByKeyFingerprint(rawKey)
      if (known && isUserExpired(known)) {
        return c.json(
          {
            error: {
              message: "Unauthorized. This API key has expired.",
              type: "authentication_error",
            },
          },
          401,
        )
      }
      const failResult = await recordLoginFailure(clientIp)
      if (!failResult.allowed && failResult.retryAfterSeconds) {
        c.header("Retry-After", String(failResult.retryAfterSeconds))
      }
      const status = failResult.allowed ? 401 : 429
      return c.json(
        {
          error: {
            message:
              status === 429 ?
                (failResult.reason ?? "Too many authentication attempts.")
              : "Unauthorized. Invalid API key.",
            type: "authentication_error",
          },
        },
        status,
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
    // Only fully successful authentication clears the IP's failure record —
    // disabled/expired/quota states must not reset an attacker's counter.
    recordLoginSuccess(clientIp)
    // Store user info in context for logging
    c.set("userId", user.id)
    c.set("username", user.username)
    c.set("user", user)
    await next()
    return
  }

  // Legacy single-key mode
  if (hasValidLegacyApiKey(c)) {
    recordLoginSuccess(getClientIp(c))
    await next()
    return
  }

  // No auth configured — allow all
  if (!state.legacyApiKey) {
    await next()
    return
  }

  const legacyIp = getClientIp(c)
  const legacyGate = checkLoginAllowed(legacyIp)
  if (!legacyGate.allowed) {
    if (legacyGate.retryAfterSeconds) {
      c.header("Retry-After", String(legacyGate.retryAfterSeconds))
    }
    return c.json(
      {
        error: {
          message: legacyGate.reason ?? "Too many authentication attempts.",
          type: "authentication_error",
        },
      },
      429,
    )
  }
  await recordLoginFailure(legacyIp)

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
  return hashSecret(input)
}

/**
 * Persist a hashed admin password to stats.db. Used by the initial setup flow.
 * Env/CLI provided passwords still take precedence at runtime.
 * Accepts plaintext (hashed with scrypt on write) or any already-stored
 * format (`scrypt$…` / `sha256:…`), which is preserved as-is for dual-track
 * verification until the next password change.
 */
export function saveAdminPasswordToDb(password: string): void {
  const normalized =
    password.startsWith("scrypt$") || password.startsWith("sha256:") ?
      password
    : hashAdminPassword(password)
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
 * Supports every stored format via dual-track verification:
 * - `scrypt$…` (current), `sha256:<hex>` (legacy hash), plaintext (env/CLI).
 */
export function verifyAdminPassword(input: string): boolean {
  const configured = getAdminPassword()
  if (!configured) return false
  return verifySecret(input, configured)
}

function createSessionToken(): string {
  return randomBytes(32).toString("hex")
}

// ── TOTP second factor (optional) ────────────────────────────────────

export function isTotpEnabled(): boolean {
  try {
    return Boolean(statsStore.getConfig(ADMIN_TOTP_SECRET_CONFIG_KEY))
  } catch {
    return false
  }
}

function getTotpSecret(): string | undefined {
  try {
    return statsStore.getConfig(ADMIN_TOTP_SECRET_CONFIG_KEY)
  } catch {
    return undefined
  }
}

/** Start setup: returns a secret + otpauth URI for the authenticator app. */
export function beginTotpSetup(): { secret: string; uri: string } {
  const secret = generateTotpSecret()
  state.adminTotpSetup = { secret, expiresAt: Date.now() + TOTP_SETUP_TTL_MS }
  return { secret, uri: totpSetupUri(secret) }
}

/** Confirm setup with a code from the app; persists the secret. */
export function confirmTotpSetup(code: string): boolean {
  const pending = state.adminTotpSetup
  if (!pending || pending.expiresAt <= Date.now()) {
    state.adminTotpSetup = undefined
    return false
  }
  if (!verifyTotpCode(pending.secret, code)) return false
  try {
    statsStore.setConfig(ADMIN_TOTP_SECRET_CONFIG_KEY, pending.secret)
  } catch {
    return false
  }
  state.adminTotpSetup = undefined
  return true
}

/** Disable TOTP after re-verifying the admin password. */
export function disableTotp(password: string): boolean {
  if (!verifyAdminPassword(password)) return false
  try {
    statsStore.deleteConfig(ADMIN_TOTP_SECRET_CONFIG_KEY)
  } catch {
    return false
  }
  return true
}

/** Issue a short-lived pre-auth token after a correct password (login step 1). */
export function createTotpLoginToken(): string {
  const token = randomBytes(32).toString("hex")
  state.adminTotpLogin = { token, expiresAt: Date.now() + TOTP_LOGIN_TTL_MS }
  return token
}

/** Verify the TOTP step; consumes the pre-auth token on success. */
export function verifyTotpLogin(token: string, code: string): boolean {
  const pending = state.adminTotpLogin
  if (!pending || pending.expiresAt <= Date.now()) {
    state.adminTotpLogin = undefined
    return false
  }
  if (!secretEquals(token, pending.token)) return false
  const secret = getTotpSecret()
  if (!secret || !verifyTotpCode(secret, code)) return false
  state.adminTotpLogin = undefined
  return true
}

export function resetTotpForTest(): void {
  state.adminTotpLogin = undefined
  state.adminTotpSetup = undefined
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
