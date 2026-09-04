import { afterEach, describe, expect, test } from "bun:test"

import { getCodebuffAuthToken, listAccounts } from "~/lib/legacy-accounts"
import { listProviderConnections } from "~/lib/provider-connections"
import { ensureDirectProviderConnections } from "~/lib/provider-defaults"
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

    await ensureDirectProviderConnections()

    expect(listAccounts()).toHaveLength(1)
    expect(getCodebuffAuthToken(listAccounts()[0])).toBe("new-token")
  })

  test("creates and persists codebuff managed default when none exists", async () => {
    state.providerDefaults.codebuff.authToken = "fresh-token"
    setTestAccounts([])

    await ensureDirectProviderConnections()

    const codebuffConns = listProviderConnections().filter(
      (c) => c.protocol === "codebuff-native" && c.name === "codebuff-default",
    )
    expect(codebuffConns).toHaveLength(1)
    expect(codebuffConns[0].credentials[0]?.value).toBe("fresh-token")
  })

  test("creates and persists windsurf managed default when none exists", async () => {
    state.providerDefaults.windsurf.apiKey = "fresh-key"
    setTestAccounts([])

    await ensureDirectProviderConnections()

    const windsurfConns = listProviderConnections().filter(
      (c) => c.protocol === "windsurf-native" && c.name === "windsurf-default",
    )
    expect(windsurfConns).toHaveLength(1)
    expect(windsurfConns[0].credentials[0]?.value).toBe("fresh-key")
  })
})
