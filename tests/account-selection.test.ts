import { afterEach, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import { getAccountForModel } from "~/lib/account-selection"
import { HTTPError } from "~/lib/error"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { state } from "~/lib/state"

afterEach(() => {
  resetAdaptiveRateLimiterForTest()
  state.accounts = []
  state.activeAccountIndex = 0
})

test("getAccountForModel picks the highest priority available account", () => {
  const acc1 = createTestAccount("acc-1", 1)
  const acc2 = createTestAccount("acc-2", 0) // priority 0 (higher)
  state.accounts = [acc1, acc2]

  const selected = getAccountForModel("gpt-5-mini")
  expect(selected.id).toBe("acc-2")
})

test("getAccountForModel throws 429 when all compatible accounts are rate limited", () => {
  const acc1 = createTestAccount("acc-1", 0)
  // Simulate cooldown by setting cooldownUntil in the future
  acc1.cooldownUntil = Date.now() + 60000
  state.accounts = [acc1]

  expect(() => {
    getAccountForModel("gpt-5-mini")
  }).toThrow(HTTPError)
})

function createTestAccount(id: string, priority: number): Account {
  return {
    id,
    label: id,
    provider: "copilot",
    enabled: true,
    priority,
    isExhausted: false,
    createdAt: Date.now(),
    credentials: {
      githubToken: `github-token-${id}`,
    },
    availableModels: [
      {
        id: "gpt-5-mini",
        name: "gpt-5-mini",
        vendor: "openai",
        pickerEnabled: true,
        supportedEndpoints: ["/chat/completions"],
        provider: "copilot",
      },
    ],
  }
}
