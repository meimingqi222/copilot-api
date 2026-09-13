import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

// Minimal TOTP (RFC 6238, SHA-1, 30s step, 6 digits) for admin second factor.
// Zero-dependency on purpose: no otplib, no QR library — the setup endpoint
// returns the otpauth:// URI + raw secret for manual entry into any
// authenticator app.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes))
}

export function base32Encode(data: Buffer): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

export function base32Decode(input: string): Buffer | undefined {
  const clean = input.trim().replace(/=+$/, "").toUpperCase()
  if (!/^[A-Z2-7]*$/.test(clean)) return undefined
  const bytes: Array<number> = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

function hotp(secret: Buffer, counter: bigint): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(counter)
  const mac = createHmac("sha1", secret).update(msg).digest()
  const offset = (mac.at(-1) ?? 0) & 0x0f
  const code =
    ((mac[offset] & 0x7f) << 24)
    | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8)
    | mac[offset + 3]
  return String(code % 1_000_000).padStart(6, "0")
}

export function totpCode(
  secretBase32: string,
  atMs = Date.now(),
): string | undefined {
  const secret = base32Decode(secretBase32)
  if (!secret || secret.length === 0) return undefined
  const counter = BigInt(Math.floor(atMs / 30_000))
  return hotp(secret, counter)
}

/** Accept codes from the previous/current/next 30s window (clock skew). */
export function verifyTotpCode(
  secretBase32: string,
  code: string,
  atMs = Date.now(),
): boolean {
  if (!/^\d{6}$/.test(code.trim())) return false
  const secret = base32Decode(secretBase32)
  if (!secret || secret.length === 0) return false
  const counter = BigInt(Math.floor(atMs / 30_000))
  const candidate = Buffer.from(code.trim())
  for (const step of [-1n, 0n, 1n]) {
    const expected = Buffer.from(hotp(secret, counter + step))
    if (
      candidate.length === expected.length
      && timingSafeEqual(candidate, expected)
    ) {
      return true
    }
  }
  return false
}

export function totpSetupUri(
  secretBase32: string,
  account = "copilot-api-admin",
  issuer = "copilot-api",
): string {
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  })
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params.toString()}`
}
