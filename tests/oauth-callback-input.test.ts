import { describe, expect, test } from "bun:test"

import {
  parseOAuthAuthorizationCode,
  parseProviderCallbackInput,
} from "~/services/oauth/callback-input"
import { getBuiltinProviderModule } from "~/services/providers/builtins"

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

describe("parseProviderCallbackInput", () => {
  // 用模块自己声明的回调配置（queryParams/combineIntoCode），与
  // loopback 回调服务器同一处真相：改了 config 这里立刻报错。
  const traeCnCallback = getBuiltinProviderModule("trae-cn")!.callback!

  test("Trae CN callback combines userInfo and userJwt with a NUL separator", () => {
    const jwt = JSON.stringify({
      Token: "tok-1",
      RefreshToken: "ref-1",
      ClientID: "ono9krqynydwx5",
    })
    const info = JSON.stringify({ UserID: "u-1", ScreenName: "Dev" })
    const url =
      "http://127.0.0.1:57557/authorize"
      + `?userJwt=${encodeURIComponent(jwt)}`
      + `&userInfo=${encodeURIComponent(info)}`
    expect(parseProviderCallbackInput(url, traeCnCallback)).toBe(
      `${info}\u0000${jwt}`,
    )
  })

  test("a missing state-side param still yields the combined code", () => {
    const jwt = JSON.stringify({ Token: "tok-1" })
    const url = `http://127.0.0.1:57557/authorize?userJwt=${encodeURIComponent(jwt)}`
    expect(parseProviderCallbackInput(url, traeCnCallback)).toBe(`\u0000${jwt}`)
  })

  test("accepts a bare query string and rejects non-matching input", () => {
    expect(
      parseProviderCallbackInput("userJwt=tok&userInfo=info", traeCnCallback),
    ).toBe("info\u0000tok")
    expect(
      parseProviderCallbackInput(
        "http://localhost/callback?code=x&state=y",
        traeCnCallback,
      ),
    ).toBeUndefined()
    expect(
      parseProviderCallbackInput("not a url", traeCnCallback),
    ).toBeUndefined()
  })

  test("honors custom code param names without combining", () => {
    expect(
      parseProviderCallbackInput("http://localhost/cb?session_key=abc123&x=1", {
        queryParams: { code: "session_key", state: "state" },
      }),
    ).toBe("abc123")
    expect(
      parseProviderCallbackInput("code=tok&state=s", {
        combineIntoCode: true,
      }),
    ).toBe("s\u0000tok")
  })
})
