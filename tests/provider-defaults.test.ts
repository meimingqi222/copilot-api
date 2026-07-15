import { afterEach, describe, expect, test } from "bun:test"

import { getCodebuffAuthToken, listAccounts } from "~/lib/accounts"
import { ensureDirectProviderAccounts } from "~/lib/provider-defaults"
import { state } from "~/lib/state"

import { setTestAccounts } from "./helpers/set-accounts"

const originalProviderDefaults = structuredClone(state.providerDefaults)

afterEach(() => {
  setTestAccounts([])
  state.providerDefaults = structuredClone(originalProviderDefaults)
})

describe("provider-defaults", () => {
  test("updates managed default token instead of creating duplicate account", async () => {
    state.providerDefaults.codebuff.authToken = "new-token"
    setTestAccounts([
      {
        id: "codebuff-default",
        label: "codebuff-default",
        provider: "codebuff",
        enabled: true,
        priority: 0,
        createdAt: Date.now(),
        credentials: { authToken: "old-token" },
        settings: {
          baseUrl: state.providerDefaults.codebuff.baseUrl,
          cliVersion: state.providerDefaults.codebuff.cliVersion,
          agentId: state.providerDefaults.codebuff.agentId,
          model: state.providerDefaults.codebuff.model,
          costMode: state.providerDefaults.codebuff.costMode,
          allowFallbacks: state.providerDefaults.codebuff.allowFallbacks,
        },
      },
    ])

    await ensureDirectProviderAccounts()

    expect(listAccounts()).toHaveLength(1)
    expect(getCodebuffAuthToken(listAccounts()[0])).toBe("new-token")
  })
})
