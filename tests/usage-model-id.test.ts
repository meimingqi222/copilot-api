import { describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import { listAccounts } from "~/lib/accounts"
import { resolveUsageModelId } from "~/lib/usage"

import { setTestAccounts } from "./helpers/set-accounts"

function windsurfAccount(overrides?: Partial<Account>): Account {
  return {
    id: "ws-1",
    label: "ws",
    provider: "windsurf",
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
    credentials: { apiKey: "key" },
    settings: { defaultModel: "swe-1-6-fast" },
    availableModels: [
      {
        id: "swe-1-6",
        name: "SWE-1.6",
        vendor: "Windsurf",
        pickerEnabled: true,
        supportedEndpoints: ["/chat/completions"],
        provider: "windsurf",
        upstreamId: "swe-1-6",
      },
      {
        id: "swe-1-6-fast",
        name: "SWE-1.6 Fast",
        vendor: "Windsurf",
        pickerEnabled: true,
        supportedEndpoints: ["/chat/completions"],
        provider: "windsurf",
        upstreamId: "swe-1-6-fast",
      },
    ],
    ...overrides,
  } as Account
}

describe("resolveUsageModelId", () => {
  test("maps provider-prefixed request to catalog model id", () => {
    const original = listAccounts()
    setTestAccounts([windsurfAccount()])

    expect(resolveUsageModelId("ws-1", "windsurf/swe-1-6-fast")).toBe(
      "swe-1-6-fast",
    )
    expect(resolveUsageModelId("ws-1", "windsurf/swe-1-6")).toBe("swe-1-6")

    setTestAccounts(original)
  })

  test("keeps swe-1-6 and swe-1-6-fast as separate models", () => {
    const original = listAccounts()
    setTestAccounts([windsurfAccount()])

    expect(resolveUsageModelId("ws-1", "swe-1-6")).toBe("swe-1-6")
    expect(resolveUsageModelId("ws-1", "swe-1-6-fast")).toBe("swe-1-6-fast")

    setTestAccounts(original)
  })
})
