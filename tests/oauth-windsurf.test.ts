import { describe, expect, test } from "bun:test"

import {
  buildWindsurfAuthUrl,
  createWindsurfOAuthStart,
  formatWindsurfSessionToken,
  isWindsurfSessionToken,
  WINDSURF_CALLBACK_PATH,
  WINDSURF_CALLBACK_PORT,
  WINDSURF_REDIRECT_URI,
} from "~/services/oauth/windsurf"
import { OAUTH_CALLBACK_CONFIGS } from "~/services/oauth/flows"
import {
  getOAuthStrategy,
  isCallbackOAuthCapableProvider,
} from "~/services/oauth/provider-strategies"
import { classifyWindsurfErrorText } from "~/services/windsurf/error-classifier"

describe("windsurf error classifier (CPA trailer-code parity)", () => {
  test("resource_exhausted maps to rate_limited", () => {
    expect(
      classifyWindsurfErrorText("resource_exhausted", "quota hit").kind,
    ).toBe("rate_limited")
  })

  test("permission_denied with high demand maps to rate_limited", () => {
    expect(
      classifyWindsurfErrorText("permission_denied", "high demand, retry later")
        .kind,
    ).toBe("rate_limited")
  })

  test("plain permission_denied maps to auth_error", () => {
    expect(
      classifyWindsurfErrorText("permission_denied", "forbidden").kind,
    ).toBe("auth_error")
  })

  test("failed_precondition with quota keywords maps to quota_exhausted", () => {
    expect(
      classifyWindsurfErrorText("failed_precondition", "credit exhausted").kind,
    ).toBe("quota_exhausted")
  })

  test("failed_precondition without quota keywords maps to client_error", () => {
    expect(
      classifyWindsurfErrorText("failed_precondition", "bad args").kind,
    ).toBe("client_error")
  })

  test("unauthenticated / internal / unavailable / deadline_exceeded map correctly", () => {
    expect(classifyWindsurfErrorText("unauthenticated", "nope").kind).toBe(
      "auth_error",
    )
    expect(classifyWindsurfErrorText("internal", "boom").kind).toBe(
      "server_error",
    )
    expect(classifyWindsurfErrorText("unavailable", "boom").kind).toBe(
      "server_error",
    )
    expect(classifyWindsurfErrorText("deadline_exceeded", "slow").kind).toBe(
      "server_error",
    )
  })

  test("natural-language rate limit still maps to rate_limited", () => {
    expect(
      classifyWindsurfErrorText(
        "Permission denied",
        "Reached message rate limit. Resets in: 3h0m0s",
      ).kind,
    ).toBe("rate_limited")
  })
})

describe("windsurf oauth loopback redirect", () => {
  test("devin only accepts a loopback 127.0.0.1/callback redirect", () => {
    expect(WINDSURF_REDIRECT_URI).toBe(
      `http://127.0.0.1:${WINDSURF_CALLBACK_PORT}${WINDSURF_CALLBACK_PATH}`,
    )
  })

  test("start advertises the loopback redirect and drops the pkce marker", () => {
    const s = createWindsurfOAuthStart()
    expect(s.redirectUri).toBe(WINDSURF_REDIRECT_URI)
    expect(s.authUrl).toContain(
      `redirect_uri=${encodeURIComponent(WINDSURF_REDIRECT_URI)}`,
    )
    expect(s.authUrl).not.toContain("cli_pkce_marker")
    // CPA parity: redirect_uri and state lead, then the fixed PKCE tail.
    expect(s.authUrl).toMatch(
      /\?redirect_uri=[^&]+&state=[^&]+&prompt=select_account&code_challenge=[^&]+&code_challenge_method=S256$/,
    )
  })

  test("manual paste keeps working from a full callback URL", () => {
    const url = buildWindsurfAuthUrl(
      "challenge123",
      "state123",
      WINDSURF_REDIRECT_URI,
    )
    expect(url).toContain("redirect_uri=")
    expect(url).not.toContain("cli_pkce_marker=1")
  })

  test("the flow type has a callback server to run", () => {
    // Regression: `windsurf` declared flowType `pkce-callback` without an
    // entry here, so every non-manual start died with `Provider "windsurf"
    // does not use a callback server`.
    expect(isCallbackOAuthCapableProvider("windsurf")).toBe(true)
    expect(getOAuthStrategy("windsurf")?.flowType).toBe("pkce-callback")
    expect(OAUTH_CALLBACK_CONFIGS.windsurf).toEqual({
      port: WINDSURF_CALLBACK_PORT,
      hostname: "127.0.0.1",
      callbackPath: WINDSURF_CALLBACK_PATH,
      providerLabel: "Devin",
    })
  })
})

describe("windsurf oauth helpers", () => {
  test("headless auth url carries pkce marker and ordering", () => {
    const url = buildWindsurfAuthUrl("challenge123", "state123")
    expect(url.startsWith("https://app.devin.ai/auth/cli/continue?")).toBe(true)
    expect(url).toContain("prompt=select_account")
    expect(url).toContain("code_challenge=challenge123")
    expect(url).toContain("code_challenge_method=S256")
    expect(url).toContain("cli_pkce_marker=1")
    expect(url).not.toContain("redirect_uri=")
  })

  test("session token formatting detects pasted tokens", () => {
    expect(isWindsurfSessionToken("devin-session-token$abc")).toBe(true)
    // JWT-shaped paste (eyJ prefix + dot-separated segments) skips the
    // code exchange. Concatenated so no secret-looking literal lives in
    // source; segments decode to plain "test" text and cannot auth anywhere.
    expect(isWindsurfSessionToken("eyJ" + ".dGVzdA.dGVzdA")).toBe(true)
    // Bare eyJ prefix without JWT structure is treated as an auth code so
    // it still goes through the code exchange instead of being stored raw.
    expect(isWindsurfSessionToken("eyJabc")).toBe(false)
    expect(isWindsurfSessionToken("plain-code-123")).toBe(false)
    expect(formatWindsurfSessionToken("eyJabc")).toBe(
      "devin-session-token$eyJabc",
    )
    expect(formatWindsurfSessionToken("devin-session-token$abc")).toBe(
      "devin-session-token$abc",
    )
  })
})
