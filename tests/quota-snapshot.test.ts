import { describe, expect, test } from "bun:test"

import type { OAuthAccount } from "~/lib/accounts"

import { applyOAuthQuotaSnapshot } from "~/lib/quota"

function createAccount(provider: OAuthAccount["provider"]): OAuthAccount {
  return {
    id: `${provider}-test`,
    label: `${provider}@example.com`,
    provider,
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
  }
}

describe("applyOAuthQuotaSnapshot", () => {
  test("Codex account with 5% remaining is not exhausted", () => {
    const account = createAccount("codex")
    applyOAuthQuotaSnapshot(account, {
      fetchedAt: Date.now(),
      provider: "codex",
      unlimited: false,
      premiumInteractionsRemaining: 5,
    })
    expect(account.quotaState).toBe("available")
  })

  test("Codex account with 0% remaining is exhausted", () => {
    const account = createAccount("codex")
    applyOAuthQuotaSnapshot(account, {
      fetchedAt: Date.now(),
      provider: "codex",
      unlimited: false,
      premiumInteractionsRemaining: 0,
    })
    expect(account.quotaState).toBe("exhausted")
  })

  test("Claude account with 1% remaining is not exhausted", () => {
    const account = createAccount("claude")
    applyOAuthQuotaSnapshot(account, {
      fetchedAt: Date.now(),
      provider: "claude",
      unlimited: false,
      premiumInteractionsRemaining: 1,
    })
    expect(account.quotaState).toBe("available")
  })

  test("Kimi account with 5 chat remaining is exhausted", () => {
    const account = createAccount("kimi")
    applyOAuthQuotaSnapshot(account, {
      fetchedAt: Date.now(),
      provider: "kimi",
      unlimited: false,
      chatRemaining: 5,
      chatTotal: 100,
    })
    expect(account.quotaState).toBe("exhausted")
  })

  test("Kimi account with 6 chat remaining is not exhausted", () => {
    const account = createAccount("kimi")
    applyOAuthQuotaSnapshot(account, {
      fetchedAt: Date.now(),
      provider: "kimi",
      unlimited: false,
      chatRemaining: 6,
      chatTotal: 100,
    })
    expect(account.quotaState).toBe("available")
  })

  test("unlimited account is not exhausted", () => {
    const account = createAccount("codex")
    applyOAuthQuotaSnapshot(account, {
      fetchedAt: Date.now(),
      provider: "codex",
      unlimited: true,
    })
    expect(account.quotaState).toBe("available")
  })

  test("xai account with both percent and cents is exhausted when cents low", () => {
    const account = createAccount("xai")
    applyOAuthQuotaSnapshot(account, {
      fetchedAt: Date.now(),
      provider: "xai",
      unlimited: false,
      premiumInteractionsRemaining: 20,
      chatRemaining: 3,
      chatTotal: 1000,
    })
    expect(account.quotaState).toBe("exhausted")
  })

  test("xai account with both percent and cents is not exhausted when both sufficient", () => {
    const account = createAccount("xai")
    applyOAuthQuotaSnapshot(account, {
      fetchedAt: Date.now(),
      provider: "xai",
      unlimited: false,
      premiumInteractionsRemaining: 50,
      chatRemaining: 500,
      chatTotal: 1000,
    })
    expect(account.quotaState).toBe("available")
  })
})
