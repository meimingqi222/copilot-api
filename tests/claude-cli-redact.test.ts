import { describe, expect, test } from "bun:test"

import { redactAndTruncate, redactSecrets } from "~/services/claude/cli/redact"

// Fixtures are assembled at runtime on purpose: a literal key-shaped string in
// the source is both a secret-hygiene smell and something upstream tooling may
// rewrite. Building them from parts keeps the shapes real and the source clean.
const ANTHROPIC_KEY = ["sk", "ant", "api03", "AbCdEf1234567890"].join("-")
const GENERIC_KEY = ["sk", "AbCdEf1234567890"].join("-")
const JWT = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
].join(".")
const JSON_VALUE = "abcdefgh12345678"

describe("redactSecrets", () => {
  test("redacts an Anthropic-style key", () => {
    const out = redactSecrets(`using ${ANTHROPIC_KEY} now`)
    expect(out).not.toContain(ANTHROPIC_KEY)
    expect(out).toContain("[REDACTED:api-key]")
  })

  test("redacts a generic sk- key", () => {
    const out = redactSecrets(`key=${GENERIC_KEY}`)
    expect(out).not.toContain(GENERIC_KEY)
    expect(out).toContain("[REDACTED:api-key]")
  })

  test("redacts a Bearer token", () => {
    const out = redactSecrets("Authorization: Bearer eyJhbGciOi.payload.sig")
    expect(out).not.toContain("eyJhbGciOi.payload.sig")
    expect(out).toContain("Bearer [REDACTED]")
  })

  test("redacts a JWT", () => {
    // A real three-segment JWT shape. Prefixing it with `token ` would be
    // caught by the Bearer rule first — also fine, but that tests a different
    // pattern.
    expect(redactSecrets(JWT)).toBe("[REDACTED:jwt]")
  })

  test("redacts token-shaped query parameters", () => {
    const out = redactSecrets(`?access_token=${JSON_VALUE}&x=1`)
    expect(out).not.toContain(JSON_VALUE)
    expect(out).toContain("x=1")
  })

  test("redacts token-shaped JSON fields", () => {
    const out = redactSecrets(`{"refresh_token":"${JSON_VALUE}"}`)
    expect(out).not.toContain(JSON_VALUE)
    expect(out).toBe('{"refresh_token":"[REDACTED]"}')
  })

  test("redacts a JSON token field with a space after the colon", () => {
    const out = redactSecrets(`{ "api_key": "${JSON_VALUE}" }`)
    expect(out).not.toContain(JSON_VALUE)
  })

  test("redacts a form-encoded token field", () => {
    const out = redactSecrets(`refresh_token=${JSON_VALUE}&scope=read`)
    expect(out).not.toContain(JSON_VALUE)
    expect(out).toContain("scope=read")
  })

  test("leaves ordinary text alone", () => {
    const text = "Not logged in · Please run /login"
    expect(redactSecrets(text)).toBe(text)
  })

  test("does not mangle a short word that merely starts with sk-", () => {
    // Too short to be a key; redacting it would hide the real reason.
    expect(redactSecrets("sk-1 failed")).toBe("sk-1 failed")
  })
})

describe("redactAndTruncate", () => {
  test("returns short text unchanged", () => {
    expect(redactAndTruncate("hello")).toBe("hello")
  })

  test("redacts before truncating", () => {
    const out = redactAndTruncate(`prefix ${GENERIC_KEY}`, 12)
    expect(out).not.toContain(GENERIC_KEY)
  })

  test("truncates with a marker and the remaining length", () => {
    const out = redactAndTruncate("x".repeat(100), 10)
    expect(out.startsWith("x".repeat(10))).toBe(true)
    expect(out).toContain("truncated")
    expect(out).toContain("90 more chars")
  })
})
