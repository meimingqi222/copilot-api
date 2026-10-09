import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  getConnectionProxyUrl,
  getConnectionSettings,
  managedConnectionFromInput,
} from "~/lib/provider-connections"
import { getSystemConfig, initializeSystemConfig } from "~/lib/system-config"
import {
  applyConnectionPatchToConnection,
  parseBodyToPatch,
} from "~/routes/admin/api/account-update"
import { publicAccountFromConnection } from "~/routes/admin/api/account-views"
import { connectionFetchInit } from "~/services/protocols/shared"

const OLD_PROXY = "http://old-proxy.invalid:8080"
const NEW_PROXY = "http://new-proxy.invalid:8080"
const DEFAULT_PROXY = "http://default-proxy.invalid:8080"
let previousConfig: ReturnType<typeof getSystemConfig>

beforeEach(() => {
  previousConfig = getSystemConfig()
  initializeSystemConfig({
    value: JSON.stringify({
      settings: {
        ...previousConfig.settings,
        requestDump: false,
        defaultProxyUrl: DEFAULT_PROXY,
      },
      expiresAt: null,
    }),
    save: () => undefined,
    onChange: () => undefined,
  })
})

afterEach(() => {
  initializeSystemConfig({
    value:
      previousConfig.source === "webui" ?
        JSON.stringify({
          settings: previousConfig.settings,
          expiresAt: previousConfig.expiresAt,
        })
      : undefined,
    save: () => undefined,
    onChange: () => undefined,
  })
})

describe("account proxy updates", () => {
  for (const provider of [
    "copilot",
    "windsurf",
    "codebuff",
    "codex",
    "claude",
  ] as const) {
    for (const storage of ["typed", "metadata", "settings"] as const) {
      test(`${provider}: edits and clears a proxy stored in ${storage}`, () => {
        const connection = managedConnectionFromInput({
          id: `${provider}-${storage}`,
          name: provider,
          provider,
          credentials: {},
          settings: { proxyUrl: OLD_PROXY, modelPrefix: "keep/" },
        })
        if (storage === "typed") connection.proxyUrl = OLD_PROXY
        if (storage === "settings") delete connection.metadata!.proxyUrl
        expect(getConnectionProxyUrl(connection)).toBe(OLD_PROXY)
        const credentials = structuredClone(connection.credentials)

        const update = (proxyUrl: string) =>
          applyConnectionPatchToConnection(
            connection,
            parseBodyToPatch(connection, { settings: { proxyUrl } }),
          )
        update(`  ${NEW_PROXY}  `)
        expect(connection.proxyUrl).toBe(NEW_PROXY)
        expect(connection.metadata?.proxyUrl).toBeUndefined()
        expect(getConnectionSettings(connection)?.proxyUrl).toBe(NEW_PROXY)
        expect(connectionFetchInit(connection, {}).proxy).toBe(NEW_PROXY)
        expect(publicAccountFromConnection(connection).proxyUrl).toBe(NEW_PROXY)

        update("   ")
        expect(connection.proxyUrl).toBeUndefined()
        expect(connection.metadata?.proxyUrl).toBeUndefined()
        expect(getConnectionSettings(connection)?.proxyUrl).toBeUndefined()
        expect(connectionFetchInit(connection, {}).proxy).toBe(DEFAULT_PROXY)
        expect(publicAccountFromConnection(connection).proxyUrl).toBe(
          DEFAULT_PROXY,
        )
        expect(getConnectionSettings(connection)?.modelPrefix).toBe("keep/")
        expect(connection.credentials).toEqual(credentials)
      })
    }
  }

  test("an unrelated settings patch preserves the connection proxy", () => {
    const connection = managedConnectionFromInput({
      id: "codex-proxy",
      name: "Codex",
      provider: "codex",
      credentials: {},
      settings: { proxyUrl: OLD_PROXY },
    })
    connection.proxyUrl = OLD_PROXY
    applyConnectionPatchToConnection(
      connection,
      parseBodyToPatch(connection, {
        settings: { modelPrefix: "new/" },
      }),
    )
    expect(getConnectionProxyUrl(connection)).toBe(OLD_PROXY)
    expect(getConnectionSettings(connection)?.modelPrefix).toBe("new/")
  })
})
