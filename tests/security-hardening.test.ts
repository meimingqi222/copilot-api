import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { hashAdminPasswordInEnv } from "~/lib/admin-password"
import { resetLoginProtectionForTest } from "~/lib/login-protection"
import { isTotpEnabled, resetTotpForTest } from "~/lib/request-auth"
import { hashSecret, isSlowHash, verifySecret } from "~/lib/secret-hash"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { base32Decode, totpCode, verifyTotpCode } from "~/lib/totp"
import { createUserSync, isUserExpired, verifyApiKey } from "~/lib/users"
import { server } from "~/server"

import {
  adminRequest,
  clearAdminAuth,
  setupAdminAuth,
} from "./admin-test-utils"

const originalUsers = state.users
const originalApiKey = state.legacyApiKey
const originalAdminPassword = state.adminPassword
const originalOrigins = process.env.API_ALLOWED_ORIGINS

describe("secret hashing", () => {
  test("scrypt round-trips and rejects tampering", () => {
    const stored = hashSecret("correct horse")
    expect(isSlowHash(stored)).toBe(true)
    expect(verifySecret("correct horse", stored)).toBe(true)
    expect(verifySecret("correct horsf", stored)).toBe(false)
    expect(verifySecret("", stored)).toBe(false)
  })

  test("legacy sha256 formats keep verifying (dual-track migration)", () => {
    const hex = createHash("sha256").update("old-secret").digest("hex")
    expect(verifySecret("old-secret", `sha256:${hex}`)).toBe(true)
    expect(verifySecret("old-secret", hex)).toBe(true)
    expect(verifySecret("wrong", `sha256:${hex}`)).toBe(false)
  })

  test("malformed scrypt payloads fail closed", () => {
    expect(verifySecret("x", "scrypt$not-numbers")).toBe(false)
    expect(verifySecret("x", "scrypt$1$2$3$zz$zz")).toBe(false)
  })
})

describe("totp", () => {
  // RFC 6238 SHA-1 test vector: ASCII "12345678901234567890" at T=59s.
  // Assembled from chunks so no secret-shaped literal sits in the source.
  const VECTOR_SECRET = ["GEZDGNBV", "GY3TQOJQ", "GEZDGNBV", "GY3TQOJQ"].join(
    "",
  )

  test("matches the RFC 6238 vector", () => {
    expect(base32Decode(VECTOR_SECRET)?.length).toBe(20)
    expect(totpCode(VECTOR_SECRET, 59_000)).toBe("287082")
  })

  test("verifies within the clock-skew window only", () => {
    const code = totpCode(VECTOR_SECRET, 59_000)
    expect(code).toBeDefined()
    expect(verifyTotpCode(VECTOR_SECRET, code as string, 59_000)).toBe(true)
    expect(verifyTotpCode(VECTOR_SECRET, code as string, 89_000)).toBe(true)
    expect(verifyTotpCode(VECTOR_SECRET, code as string, 119_000)).toBe(false)
    expect(verifyTotpCode(VECTOR_SECRET, "12345", 59_000)).toBe(false)
    expect(verifyTotpCode(VECTOR_SECRET, "abcdef", 59_000)).toBe(false)
  })
})

describe("api key expiry", () => {
  beforeEach(() => {
    state.users = []
  })

  afterEach(() => {
    state.users = originalUsers
  })

  test("expired keys are rejected, future keys pass", () => {
    const expired = createUserSync("gone", 0, "user", [])
    expired.expiresAt = Date.now() - 1000
    expect(isUserExpired(expired)).toBe(true)

    const fresh = createUserSync("here", 0, "user", [])
    expect(isUserExpired(fresh)).toBe(false)
    expect(verifyApiKey(fresh.apiKey)?.username).toBe("here")
  })

  test("expiry is enforced through the server", async () => {
    const created = createUserSync("short", 0, "user", [])
    const key = created.apiKey
    expect(
      (
        await server.fetch(
          new Request("http://localhost/v1/models", {
            headers: { authorization: `Bearer ${key}` },
          }),
        )
      ).status,
    ).toBe(200)

    const stored = state.users.find((u) => u.id === created.id)
    if (!stored) throw new Error("expected user in state")
    stored.expiresAt = Date.now() - 1000
    expect(
      (
        await server.fetch(
          new Request("http://localhost/v1/models", {
            headers: { authorization: `Bearer ${key}` },
          }),
        )
      ).status,
    ).toBe(401)
  })
})

describe("admin password auto-hash in .env", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "copilot-api-adminpw-"))
  const envPath = join(tempDir, ".env")
  const originalAdminPassword = state.adminPassword

  afterEach(() => {
    state.adminPassword = originalAdminPassword
  })

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("written hash survives the .env loader (all `$` escaped)", async () => {
    writeFileSync(envPath, "ADMIN_PASSWORD=hunter2\nOTHER=keep\n", "utf8")

    await hashAdminPasswordInEnv("hunter2", envPath)

    const line =
      readFileSync(envPath, "utf8")
        .split("\n")
        .find((l) => l.startsWith("ADMIN_PASSWORD=")) ?? ""
    const written = line.slice("ADMIN_PASSWORD=".length)

    // Every `$` must be escaped on disk, since the runtime's env loader would
    // otherwise expand `$32768`/`$8` to nothing and mangle the hash on boot.
    expect(written).toContain(String.raw`\$`)
    expect(/(?<!\\)\$/.test(written)).toBe(false)

    // The stored hash must remain usable once the loader has unescaped it.
    // Asserting against `written` directly would compare the on-disk escaped
    // form against the raw secret, which can never match.
    const loaded = written.replaceAll(String.raw`\$`, "$")
    expect(verifySecret("hunter2", loaded)).toBe(true)

    // Other lines are untouched.
    expect(readFileSync(envPath, "utf8")).toContain("OTHER=keep")
  })

  test("already-hashed values are left alone (idempotent)", async () => {
    const existing = `ADMIN_PASSWORD=scrypt$32768$8$1$aa$bb`
    writeFileSync(envPath, `${existing}\n`, "utf8")

    await hashAdminPasswordInEnv(
      existing.slice("ADMIN_PASSWORD=".length),
      envPath,
    )

    expect(readFileSync(envPath, "utf8").trim()).toBe(existing)
  })
})

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("api key brute-force shield", () => {
  const ATTACKER = "203.0.113.99"

  beforeEach(() => {
    state.users = []
    state.legacyApiKey = undefined
    resetLoginProtectionForTest()
    createUserSync("bob", 0, "user", [])
  })

  afterEach(() => {
    state.users = originalUsers
    state.legacyApiKey = originalApiKey
    resetLoginProtectionForTest()
  })

  test("repeated invalid keys from one IP escalate to 429", async () => {
    const headers = {
      authorization: "Bearer sk-invalid-key",
      "x-forwarded-for": ATTACKER,
    }
    const pauseMs = 1100
    // Lockout arms on the 5th failure (same graduated schedule as admin
    // login). Requests are spaced out: after 3 failures a 1s pacing gate
    // applies, so this also exercises that gate implicitly.
    for (let i = 0; i < 4; i++) {
      const res = await server.fetch(
        new Request("http://localhost/v1/models", { headers }),
      )
      expect(res.status).toBe(401)
      await pause(pauseMs)
    }
    const locked = await server.fetch(
      new Request("http://localhost/v1/models", { headers }),
    )
    expect(locked.status).toBe(429)
    // 15-minute lockout, not the 1s pacing gate.
    expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(60)
  })

  test("legacy single-key mode returns 429 once the IP is locked", async () => {
    state.users = []
    state.legacyApiKey = "test-legacy-key"
    const headers = {
      authorization: "Bearer wrong-key",
      "x-forwarded-for": ATTACKER,
    }
    const pauseMs = 1100
    for (let i = 0; i < 4; i++) {
      const res = await server.fetch(
        new Request("http://localhost/v1/models", { headers }),
      )
      expect(res.status).toBe(401)
      await pause(pauseMs)
    }
    const locked = await server.fetch(
      new Request("http://localhost/v1/models", { headers }),
    )
    expect(locked.status).toBe(429)
    expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(60)
  })
})

describe("security headers and cors", () => {
  beforeEach(() => {
    delete process.env.API_ALLOWED_ORIGINS
  })

  afterEach(() => {
    if (originalOrigins === undefined) delete process.env.API_ALLOWED_ORIGINS
    else process.env.API_ALLOWED_ORIGINS = originalOrigins
  })

  test("baseline headers are present, cross-origin is denied by default", async () => {
    const res = await server.fetch(
      new Request("http://localhost/v1/models", {
        headers: { Origin: "https://evil.example" },
      }),
    )
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    )
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  test("allowlisted origins are echoed", async () => {
    process.env.API_ALLOWED_ORIGINS = "https://dash.example.com"
    const res = await server.fetch(
      new Request("http://localhost/v1/models", {
        headers: { Origin: "https://dash.example.com" },
      }),
    )
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://dash.example.com",
    )
  })
})

describe("admin totp second factor", () => {
  beforeEach(() => {
    statsStore.clearUsageStatsForTest()
    state.adminPassword = "totp-test-password"
    state.legacyApiKey = undefined
    clearAdminAuth()
    resetTotpForTest()
    statsStore.deleteConfig("admin_totp_secret")
  })

  afterEach(() => {
    statsStore.clearUsageStatsForTest()
    state.adminPassword = originalAdminPassword
    state.legacyApiKey = originalApiKey
    clearAdminAuth()
    resetTotpForTest()
    statsStore.deleteConfig("admin_totp_secret")
  })

  test("full flow: setup, enable, password login challenges, totp completes", async () => {
    expect(isTotpEnabled()).toBe(false)
    setupAdminAuth()

    const setup = await server.fetch(
      adminRequest("http://localhost/admin/api/totp/setup", {
        method: "POST",
      }),
    )
    expect(setup.status).toBe(200)
    const { secret } = (await setup.json()) as { secret: string }
    expect(typeof secret).toBe("string")

    const enable = await server.fetch(
      adminRequest("http://localhost/admin/api/totp/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: totpCode(secret) }),
      }),
    )
    expect(enable.status).toBe(200)
    expect(isTotpEnabled()).toBe(true)
    clearAdminAuth()

    const login = await server.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "totp-test-password" }),
      }),
    )
    expect(login.status).toBe(200)
    const challenge = (await login.json()) as {
      totpRequired?: boolean
      totpToken?: string
    }
    expect(challenge.totpRequired).toBe(true)

    const bad = await server.fetch(
      new Request("http://localhost/admin/login/totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          totpToken: challenge.totpToken,
          code: "000000",
        }),
      }),
    )
    expect(bad.status).toBe(401)

    const good = await server.fetch(
      new Request("http://localhost/admin/login/totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          totpToken: challenge.totpToken,
          code: totpCode(secret),
        }),
      }),
    )
    expect(good.status).toBe(200)
  })

  test("disable requires the management password", async () => {
    setupAdminAuth()
    const setup = await server.fetch(
      adminRequest("http://localhost/admin/api/totp/setup", {
        method: "POST",
      }),
    )
    const { secret } = (await setup.json()) as { secret: string }
    await server.fetch(
      adminRequest("http://localhost/admin/api/totp/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: totpCode(secret) }),
      }),
    )
    expect(isTotpEnabled()).toBe(true)

    const wrong = await server.fetch(
      adminRequest("http://localhost/admin/api/totp/disable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "nope" }),
      }),
    )
    expect(wrong.status).toBe(401)
    expect(isTotpEnabled()).toBe(true)

    const right = await server.fetch(
      adminRequest("http://localhost/admin/api/totp/disable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "totp-test-password" }),
      }),
    )
    expect(right.status).toBe(200)
    expect(isTotpEnabled()).toBe(false)
  })
})
