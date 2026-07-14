import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  __resetProviderConnectionsForTest,
  listProviderConnections,
  markCredentialCooldown,
  resetCredentialStatus,
} from "~/lib/provider-connections"
import { providerConnectionIoRoutes } from "~/routes/admin/api/provider-connection-io"
import { clearCredentialErrorStateAfterSuccessfulTest } from "~/routes/admin/api/provider-connections-helpers"

describe("provider connection import/export + test recovery", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
  })

  afterEach(() => {
    __resetProviderConnectionsForTest()
  })

  test("import accepts batch connections and export round-trips secrets", async () => {
    const app = new Hono()
    app.route("/", providerConnectionIoRoutes)

    const payload = {
      version: 1,
      connections: [
        {
          id: "ark-coding",
          name: "Ark Coding",
          protocol: "anthropic-compatible",
          baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
          enabled: true,
          priority: 10,
          credentials: [
            {
              id: "cred-1",
              authMode: "bearer",
              value: "secret-key-abc",
              enabled: true,
            },
          ],
          models: [
            {
              publicId: "glm-5.2",
              upstreamId: "glm-5.2",
              endpoints: ["messages"],
              enabled: true,
            },
          ],
        },
        {
          id: "openai-compat",
          name: "OpenAI Compat",
          protocol: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          credentials: [{ value: "sk-test", authMode: "bearer" }],
        },
      ],
    }

    const importRes = await app.request("/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(importRes.status).toBe(200)
    const importBody = (await importRes.json()) as {
      imported: number
      skipped: number
      failed: number
    }
    expect(importBody.imported).toBe(2)
    expect(importBody.failed).toBe(0)

    expect(listProviderConnections()).toHaveLength(2)
    expect(listProviderConnections()[0]?.credentials[0]?.value).toBe(
      "secret-key-abc",
    )

    const exportRes = await app.request("/export")
    expect(exportRes.status).toBe(200)
    const exported = (await exportRes.json()) as {
      version: number
      connections: Array<{
        id: string
        credentials: Array<{ value: string }>
      }>
    }
    expect(exported.version).toBe(1)
    expect(exported.connections).toHaveLength(2)
    const ark = exported.connections.find((c) => c.id === "ark-coding")
    expect(ark?.credentials[0]?.value).toBe("secret-key-abc")

    // skip duplicates by default
    const again = await app.request("/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    const againBody = (await again.json()) as {
      imported: number
      skipped: number
    }
    expect(againBody.imported).toBe(0)
    expect(againBody.skipped).toBe(2)
  })

  test("successful connectivity recovery clears sticky 429 cooldown", async () => {
    const app = new Hono()
    app.route("/", providerConnectionIoRoutes)
    await app.request("/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connections: [
          {
            id: "c1",
            name: "c1",
            protocol: "openai-compatible",
            baseUrl: "https://example.com/v1",
            credentials: [{ id: "k1", value: "sk", authMode: "bearer" }],
          },
        ],
      }),
    })

    const connections = listProviderConnections()
    expect(connections.length).toBeGreaterThan(0)
    const cred = connections[0].credentials[0]
    expect(cred).toBeDefined()

    markCredentialCooldown(cred, { reason: "HTTP 429", retryAfterMs: 60_000 })
    expect(cred.status).toBe("cooldown")
    expect(cred.lastError).toContain("429")

    await clearCredentialErrorStateAfterSuccessfulTest(cred)
    expect(cred.status).toBe("ready")
    expect(cred.lastError).toBeUndefined()
    expect(cred.cooldownUntil).toBeUndefined()

    // idempotent when already clean
    resetCredentialStatus(cred)
    await clearCredentialErrorStateAfterSuccessfulTest(cred)
    expect(cred.status).toBe("ready")
  })
})
