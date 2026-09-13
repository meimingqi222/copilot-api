import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto"

// Slow-hash storage for API keys and the admin password.
//
// Format: `scrypt$<N>$<r>$<p>$<saltHex>$<keyHex>` (all self-describing, so
// parameters can evolve without another migration).
// Legacy values are still accepted on read:
// - `sha256:<hex>` (previous admin-password format)
// - bare 64-char hex (previous API-key format)
// - anything else is treated as plaintext (env-provided secrets)
//
// Rationale: SHA-256 is a fast hash — a leaked users.json/db is brute-forced
// at billions of guesses per second on GPUs. scrypt is memory-hard and
// bundled with node:crypto, so unlike argon2 it adds zero native build
// dependencies (which would break the single-file dist + Alpine deploys).
// API keys are additionally 256-bit random, so the slow hash is
// defense-in-depth; verification hot-path cost is bounded by a short-TTL
// memory cache in users.ts (invalidated on every mutation).

const SCRYPT_N = 2 ** 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32
const SCRYPT_SALT_BYTES = 16
const SCRYPT_MAXMEM = 64 * 1024 * 1024

export function hashSecret(secret: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const key = scryptSync(secret, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${(key as Buffer).toString("hex")}`
}

function verifyScrypt(secret: string, stored: string): boolean {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false
  }
  if (N <= 0 || N > 2 ** 20 || r <= 0 || p <= 0) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], "hex")
    expected = Buffer.from(parts[5], "hex")
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  let actual: Buffer
  try {
    actual = scryptSync(secret, salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(SCRYPT_MAXMEM, N * r * 256),
    })
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function verifySha256(secret: string, hex: string): boolean {
  try {
    const a = Buffer.from(createHash("sha256").update(secret).digest("hex"))
    const b = Buffer.from(hex)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Constant-time equality for two strings of possibly different length.
 *
 * `timingSafeEqual` throws on length mismatch, and the usual
 * `a.length === b.length && timingSafeEqual(a, b)` guard short-circuits —
 * leaking the stored secret's length through the response time and letting an
 * attacker walk the length down byte by byte. Hashing both sides to a fixed
 * 32 bytes first means the comparison always runs at the same cost.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest()
  const hb = createHash("sha256").update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** Verify `secret` against any stored format (new scrypt or legacy). */
export function verifySecret(secret: string, stored: string): boolean {
  if (stored.startsWith("scrypt$")) return verifyScrypt(secret, stored)
  if (stored.startsWith("sha256:")) {
    return verifySha256(secret, stored.slice("sha256:".length))
  }
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    return verifySha256(secret, stored)
  }
  // Plaintext (env/CLI-provided secrets not yet migrated). Compared via
  // fixed-width digests so a wrong length costs the same as a wrong value.
  return constantTimeEqual(secret, stored)
}

/**
 * Constant-time comparison of two secrets provided by the caller.
 * Exported for callers that compare a submitted token against an in-memory
 * one (e.g. the TOTP pre-auth token) without going through a stored format.
 */
export function secretEquals(a: string, b: string): boolean {
  return constantTimeEqual(a, b)
}

/** True when `stored` already uses the current scrypt format. */
export function isSlowHash(stored: string): boolean {
  return stored.startsWith("scrypt$")
}
