import { describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { getCredentialContextString } from "~/lib/provider-connections"
import {
  applyConnectionPatchToConnection,
  parseBodyToPatch,
} from "~/routes/admin/api/account-update"

function makeCopilotConnection(): ProviderConnection {
  return {
    id: "copilot-1",
    name: "copilot-test",
    protocol: "copilot-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
    credentials: [
      {
        id: "copilot-1",
        authMode: "bearer",
        value: "",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
        refresherType: "copilot-token",
        context: {
          accountId: "copilot-1",
          githubToken: "ghp_old",
        },
      },
    ],
    metadata: {
      provider: "copilot",
      quotaState: "unknown",
      settings: {},
    },
  }
}

describe("parseBodyToPatch + applyConnectionPatchToConnection", () => {
  test("copilot: maps credentials.githubToken to credentialValue", () => {
    const conn = makeCopilotConnection()
    const patch = parseBodyToPatch(conn, {
      credentials: { githubToken: "ghp_new" },
    })
    applyConnectionPatchToConnection(conn, patch)
    expect(getCredentialContextString(conn, "githubToken")).toBe("ghp_new")
  })

  test("copilot: maps top-level githubToken to credentialValue", () => {
    const conn = makeCopilotConnection()
    const patch = parseBodyToPatch(conn, { githubToken: "ghp_top" })
    applyConnectionPatchToConnection(conn, patch)
    expect(getCredentialContextString(conn, "githubToken")).toBe("ghp_top")
  })

  test("copilot: updating githubToken does NOT overwrite credential.value (copilot JWT)", () => {
    const conn = makeCopilotConnection()
    // 模拟已有 copilot JWT
    conn.credentials[0].value = "copilot-jwt-abc"
    const patch = parseBodyToPatch(conn, { githubToken: "ghp_new" })
    applyConnectionPatchToConnection(conn, patch)
    // githubToken 写入 context
    expect(getCredentialContextString(conn, "githubToken")).toBe("ghp_new")
    // credential.value 必须被清空(不是被 githubToken 覆盖),
    // 这样 ensureCopilotToken 才会惰性刷新出新的 copilot JWT
    expect(conn.credentials[0].value).toBe("")
  })

  test("copilot: clearing githubToken clears credential.value too", () => {
    const conn = makeCopilotConnection()
    conn.credentials[0].value = "copilot-jwt-abc"
    const patch = parseBodyToPatch(conn, { githubToken: "" })
    applyConnectionPatchToConnection(conn, patch)
    expect(getCredentialContextString(conn, "githubToken")).toBe("")
    expect(conn.credentials[0].value).toBe("")
  })

  test("copilot: ignores githubToken when not present in body", () => {
    const conn = makeCopilotConnection()
    const patch = parseBodyToPatch(conn, { label: "renamed" })
    applyConnectionPatchToConnection(conn, patch)
    expect(getCredentialContextString(conn, "githubToken")).toBe("ghp_old")
    expect(conn.name).toBe("renamed")
  })

  test("codebuff: does not treat githubToken as credential", () => {
    const conn: ProviderConnection = {
      id: "cb-1",
      name: "codebuff",
      protocol: "codebuff-native",
      baseUrl: "",
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
      credentials: [
        {
          id: "cb-1",
          authMode: "bearer",
          value: "cb-old",
          enabled: true,
          status: "ready",
          createdAt: Date.now(),
          refresherType: "static",
          context: { accountId: "cb-1" },
        },
      ],
      metadata: {
        provider: "codebuff",
        quotaState: "unknown",
        settings: {},
      },
    }
    const patch = parseBodyToPatch(conn, { githubToken: "ghp_wrong" })
    expect(patch.credentialValue).toBeUndefined()
  })
})
