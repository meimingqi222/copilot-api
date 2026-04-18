import { afterEach, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import { HTTPError } from "~/lib/error"
import {
  getRemainingCooldownSeconds,
  resetAdaptiveRateLimiterForTest,
} from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { executeProviderRequestWithRetry } from "~/services/providers/execution"

afterEach(() => {
  resetAdaptiveRateLimiterForTest()
  state.accounts = []
  state.activeAccountIndex = 0
})

test("provider execution retries the next same-provider account after 429", async () => {
  const primary = createWindsurfAccount("windsurf-primary", 0)
  const secondary = createWindsurfAccount("windsurf-secondary", 1)
  state.accounts = [primary, secondary]

  const result = await executeProviderRequestWithRetry({
    account: primary,
    model: "windsurf/swe-1-6-fast",
    execute(account) {
      if (account.id === primary.id) {
        throw new HTTPError(
          "Too Many Requests",
          new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "1" },
          }),
        )
      }

      return Promise.resolve("ok")
    },
  })

  expect(result.account.id).toBe(secondary.id)
  expect(result.result).toBe("ok")
  expect(primary.isExhausted).toBe(true)
  expect(getRemainingCooldownSeconds(primary.id)).toBeGreaterThan(0)
})

function createWindsurfAccount(id: string, priority: number): Account {
  return {
    id,
    label: id,
    provider: "windsurf",
    enabled: true,
    priority,
    isExhausted: false,
    createdAt: Date.now(),
    credentials: {
      apiKey: `${id}-key`,
    },
    settings: {
      baseUrl: "https://server.self-serve.windsurf.com",
      appVersion: "1.0.0",
      lsVersion: "1.0.0",
      defaultModel: "swe-1-6-fast",
      clientName: "windsurf-next",
    },
    availableModels: [
      {
        id: "swe-1-6-fast",
        name: "swe-1-6-fast",
        vendor: "windsurf",
        pickerEnabled: true,
        supportedEndpoints: ["/chat/completions"],
        provider: "windsurf",
      },
    ],
  }
}
