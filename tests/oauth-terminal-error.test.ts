/**
 * 终态 OAuth 刷新错误的判定（回归测试）。
 *
 * 线上实测：Codex 账号的 refresh token 被上游作废后，刷新端点回
 * 401 `{"error":{"code":"refresh_token_invalidated","message":"Your session has
 * ended. Please log in again."}}`。旧实现只认 RFC 6749 的 invalid_grant 一族，
 * 且把错误体截断到 200 字（正好把 code 切断），于是这条终态错误被当成瞬态：
 * 无限退避重试、authStatus 永远是 ready、WebUI 迟迟不显示"重新认证"。
 */
import { afterEach, describe, expect, mock, test } from "bun:test"

import { refreshCodexTokens } from "~/services/oauth/codex"
import { isOAuthTerminalError } from "~/services/oauth/refresh-scheduler"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const CODEX_SESSION_ENDED_BODY = JSON.stringify(
  {
    error: {
      message: "Your session has ended. Please log in again.",
      type: "invalid_request_error",
      param: null,
      code: "refresh_token_invalidated",
    },
  },
  null,
  2,
)

function stubFetch(body: string, status: number): void {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(body, { status })),
  ) as unknown as typeof fetch
}

describe("isOAuthTerminalError", () => {
  test("判定上游实测到的终态 code", () => {
    expect(
      isOAuthTerminalError(
        new Error(
          `Codex token refresh failed (401): ${CODEX_SESSION_ENDED_BODY}`,
        ),
      ),
    ).toBe(true)
    expect(
      isOAuthTerminalError(
        new Error(
          'Codex token refresh failed (401): {"error":{"code":"token_revoked"}}',
        ),
      ),
    ).toBe(true)
    expect(
      isOAuthTerminalError(
        new Error(
          'Claude token refresh failed (400): {"error":"invalid_grant"}',
        ),
      ),
    ).toBe(true)
    expect(isOAuthTerminalError(new Error("refresh_token_reused"))).toBe(true)
  })

  test("瞬态失败不判终态（旧 access token 可能仍有效，应继续退避重试）", () => {
    expect(
      isOAuthTerminalError(
        new Error("fetch failed: getaddrinfo ENOTFOUND auth.openai.com"),
      ),
    ).toBe(false)
    expect(
      isOAuthTerminalError(
        new Error("Codex token refresh failed (503): upstream unavailable"),
      ),
    ).toBe(false)
    expect(
      isOAuthTerminalError(
        new Error("The operation was aborted due to timeout"),
      ),
    ).toBe(false)
    expect(
      isOAuthTerminalError(new Error("refreshing refresh_token for account")),
    ).toBe(false)
  })

  test("能解析出 code 时不做全文匹配，避免 message 误伤", () => {
    const body = JSON.stringify({
      error: {
        code: "insufficient_quota",
        message: "unrelated to invalid_grant",
      },
    })
    expect(
      isOAuthTerminalError(
        new Error(`Codex token refresh failed (429): ${body}`),
      ),
    ).toBe(false)
  })
})

describe("refreshCodexTokens 的错误信息", () => {
  test("保留上游错误码，不被截断（截断会让终态判定漏判）", async () => {
    stubFetch(CODEX_SESSION_ENDED_BODY, 401)

    let caught: unknown
    try {
      await refreshCodexTokens("rt.test")
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain("401")
    expect(message).toContain("refresh_token_invalidated")
    expect(isOAuthTerminalError(caught)).toBe(true)
  })
})
