import { afterEach, expect, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  setConnectionAuthStatus,
} from "~/lib/provider-connections"
import { createOAuthConnection } from "~/services/oauth/strategy-types"
import { applyOAuthBundleToCredential } from "~/services/oauth/apply-bundle"
import {
  applyProviderAuthUpdate,
  prepareOAuthRefresh,
} from "~/services/providers/auth-update"

afterEach(() => __resetProviderConnectionsForTest())

function account() {
  const connection = createOAuthConnection("codex", "boundary")
  applyOAuthBundleToCredential(connection, {
    accessToken: "old-access",
    refreshToken: "old-refresh",
  })
  connection.metadata!.settings = { proxyUrl: "old-proxy" }
  return connection
}

test("provider returns auth changes; host preserves concurrent account and quota edits", async () => {
  const connection = account()
  const refresh = prepareOAuthRefresh(async (draft) => {
    expect(draft).not.toBe(connection)
    applyOAuthBundleToCredential(draft, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
    })
    connection.name = "admin rename"
    connection.enabled = false
    connection.metadata!.settings = { proxyUrl: "new-proxy" }
    connection.credentials[0]!.context!.concurrent = "retained"
    connection.credentials[0]!.quota = { fetchedAt: 123, unlimited: true }
    connection.models = [
      {
        publicId: "concurrent",
        upstreamId: "concurrent",
        endpoints: ["responses"],
        enabled: true,
      },
    ]
  })
  const update = await refresh(connection, "old-refresh", {})
  expect(connection.credentials[0]!.value).toBe("old-access")
  applyProviderAuthUpdate(connection, update)
  expect(connection.credentials[0]!.value).toBe("new-access")
  expect(connection.credentials[0]!.context!.refreshToken).toBe("new-refresh")
  expect(connection.credentials[0]!.context!.concurrent).toBe("retained")
  expect(connection.credentials[0]!.quota?.unlimited).toBe(true)
  expect(connection.metadata!.settings).toEqual({ proxyUrl: "new-proxy" })
  expect(connection.name).toBe("admin rename")
  expect(connection.enabled).toBe(false)
  expect(connection.models?.[0]?.publicId).toBe("concurrent")
})

test("a failed provider operation cannot leak partial tokens into live state", async () => {
  const connection = account()
  const before = structuredClone(connection)
  const refresh = prepareOAuthRefresh(async (draft) => {
    applyOAuthBundleToCredential(draft, {
      accessToken: "partial",
      refreshToken: "partial-refresh",
    })
    throw new Error("upstream failed")
  })
  await expect(refresh(connection, "old-refresh", {})).rejects.toThrow(
    "upstream failed",
  )
  expect(connection).toEqual(before)
})

test("auth recovery and explicit context removal are applied without resetting quota exhaustion", async () => {
  const connection = account()
  setConnectionAuthStatus(connection, "error", "old auth failure")
  connection.credentials[0]!.context!.obsolete = "remove me"
  const refresh = prepareOAuthRefresh(async (draft) => {
    applyOAuthBundleToCredential(draft, { accessToken: "new-access" })
    delete draft.credentials[0]!.context!.obsolete
  })
  const update = await refresh(connection, "old-refresh", {})
  connection.credentials[0]!.status = "quota_exhausted"
  applyProviderAuthUpdate(connection, update)
  expect(connection.metadata!.authError).toBeNull()
  expect(connection.metadata!.authStatus).toBe("ready")
  expect(connection.credentials[0]!.status).toBe("quota_exhausted")
  expect(connection.credentials[0]!.context).not.toHaveProperty("obsolete")
  expect(connection.credentials[0]!.context!.refreshToken).toBe("old-refresh")
})

test("removed or replaced active credentials reject stale refresh results before applying", async () => {
  const connection = account()
  const update = await prepareOAuthRefresh(async (draft) => {
    applyOAuthBundleToCredential(draft, { accessToken: "new-access" })
  })(connection, "old-refresh", {})
  connection.credentials[0]!.id = "replacement"
  expect(() => applyProviderAuthUpdate(connection, update)).toThrow(
    "no longer active",
  )
  expect(connection.credentials[0]!.value).toBe("old-access")
})
