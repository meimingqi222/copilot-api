import { describe, expect, test } from "bun:test"

import { parseOAuthAuthorizationCode } from "~/services/oauth/callback-input"

describe("parseOAuthAuthorizationCode", () => {
  test("extracts code from callback URL", () => {
    expect(
      parseOAuthAuthorizationCode(
        "http://127.0.0.1:56121/callback?code=auth-code-1&state=state-1",
      ),
    ).toBe("auth-code-1")
    expect(
      parseOAuthAuthorizationCode(
        "http://localhost:1455/auth/callback?code=codex-code&state=state-1",
      ),
    ).toBe("codex-code")
    expect(
      parseOAuthAuthorizationCode(
        "http://localhost:51121/oauth-callback?code=ag-code&state=state-1",
      ),
    ).toBe("ag-code")
  })

  test("extracts code from query string", () => {
    expect(parseOAuthAuthorizationCode("code=auth-code-2&state=state-2")).toBe(
      "auth-code-2",
    )
  })

  test("extracts xAI displayed code format", () => {
    expect(parseOAuthAuthorizationCode("code: xai_displayed_code_123")).toBe(
      "xai_displayed_code_123",
    )
  })

  test("accepts raw authorization code", () => {
    expect(parseOAuthAuthorizationCode("raw-authorization-code-12345")).toBe(
      "raw-authorization-code-12345",
    )
  })

  test("returns undefined for empty input", () => {
    expect(parseOAuthAuthorizationCode("")).toBeUndefined()
    expect(parseOAuthAuthorizationCode("   ")).toBeUndefined()
  })
})
