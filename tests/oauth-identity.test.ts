import { describe, expect, test } from "bun:test"

import { managedConnectionFromInput } from "~/lib/provider-connections"
import { findConnectionByOAuthIdentity } from "~/services/oauth/identity"

function codexConn(
  id: string,
  accountId: string | undefined,
  email: string | undefined,
) {
  return managedConnectionFromInput({
    id,
    name: id,
    provider: "codex",
    credentials: {
      accessToken: "t",
      accountId: accountId ?? "",
      email: email ?? "",
    },
    settings: {},
  })
}

describe("findConnectionByOAuthIdentity", () => {
  test("same workspace accountId with different emails does NOT merge", () => {
    // chatgpt_account_id 是工作区级 id：同一个 Team 工作区的不同成员返回相同的
    // 值。只按 accountId 判重会把不同用户的 token 覆盖合并到一条连接上
    // （用户报的"不同账号被重复更新"正是这个）。
    const existing = codexConn(
      "a",
      "acct-shared-workspace",
      "softeagle302@leihouwanglab886.com",
    )
    const found = findConnectionByOAuthIdentity(
      "codex",
      {
        accountId: "acct-shared-workspace",
        email: "darktiger900@procsite.dpdns.org",
      },
      [existing],
    )
    expect(found).toBeUndefined()
  })

  test("same email re-login merges even when accountId differs", () => {
    // 用户重新登录后工作区 id 可能变化（换了 workspace）；email 匹配仍应合并，
    // 否则两份 refresh token 会互相把对方顶掉。
    const existing = codexConn("a", "acct-old", "user@example.com")
    const found = findConnectionByOAuthIdentity(
      "codex",
      { accountId: "acct-new", email: "user@example.com" },
      [existing],
    )
    expect(found?.id).toBe("a")
  })

  test("accountId match merges when emails are not contradictory", () => {
    // 老连接没有记录 email（历史上未捕获）时，仍用 accountId 判重。
    const existing = codexConn("a", "acct-1", undefined)
    const found = findConnectionByOAuthIdentity(
      "codex",
      { accountId: "acct-1", email: "user@example.com" },
      [existing],
    )
    expect(found?.id).toBe("a")
  })

  test("both accountId and email matching merges", () => {
    const existing = codexConn("a", "acct-1", "user@example.com")
    const found = findConnectionByOAuthIdentity(
      "codex",
      { accountId: "acct-1", email: "user@example.com" },
      [existing],
    )
    expect(found?.id).toBe("a")
  })

  test("does not merge across providers", () => {
    const existing = codexConn("a", "acct-1", "user@example.com")
    const found = findConnectionByOAuthIdentity(
      "xai",
      { accountId: "acct-1", email: "user@example.com" },
      [existing],
    )
    expect(found).toBeUndefined()
  })
})
