import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { ProviderConnection } from "~/lib/provider-connections"
import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"
import { modelRoutes } from "~/routes/models/route"
import { discoverOAuthModelsForConnection } from "~/services/oauth/discover-models"
import { getXaiModule } from "~/services/providers/modules/xai"
import { getXaiFallbackModels } from "~/services/providers/model-catalogs/xai"

const originalFetch = globalThis.fetch
const originalModels = state.models

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
  state.models = originalModels
})

function connection(
  settings: Record<string, unknown> = {},
): ProviderConnection {
  return {
    id: "xai-models-test",
    name: "xAI",
    protocol: "xai-native",
    baseUrl: "https://api.x.ai/v1",
    enabled: true,
    priority: 0,
    createdAt: 0,
    credentials: [
      {
        id: "cred",
        authMode: "bearer",
        value: "test-token",
        enabled: true,
        status: "ready",
        createdAt: 0,
      },
    ],
    metadata: { provider: "xai", settings },
  }
}

describe("xAI live model discovery", () => {
  test("discovers current Grok models through the CLI models endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init })
        return Response.json({
          data: [
            { id: "grok-4.7", name: "Grok 4.7", api_backend: "responses" },
            {
              id: "grok-4.7-build-fast",
              api_backend: "responses",
              context_window: 256000,
              context_windows: [500000, 256000, 500000, 0, -1, "900000", null],
            },
            { id: "grok-future" },
            { id: "old-chat", api_backend: "chat_completions" },
            { id: "", api_backend: "responses" },
            null,
            { id: "grok-4.7", name: "duplicate" },
          ],
        })
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    const signal = new AbortController().signal
    const models = await discoverOAuthModelsForConnection(connection(), signal)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://cli-chat-proxy.grok.com/v1/models")
    const headers = new Headers(requests[0]?.init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer test-token")
    expect(headers.get("X-XAI-Token-Auth")).toBe("xai-grok-cli")
    expect(headers.get("x-grok-client-version")).toBeTruthy()
    expect(headers.get("x-grok-client-identifier")).toBe("grok-shell")
    expect(requests[0]?.init?.signal).toBe(signal)
    expect(
      models
        .filter((model) => model.endpoints.includes("responses"))
        .map((model) => model.publicId),
    ).toEqual(["grok-4.7", "grok-4.7-build-fast", "grok-future"])
    expect(models[1]?.name).toBe("grok-4.7-build-fast")
    expect(models[1]?.metadata).toEqual({
      contextWindow: 256000,
      maxContextWindow: 500000,
      contextWindows: [256000, 500000],
    })
    expect(models[2]?.metadata).toBeUndefined()
    expect(models.some((model) => model.endpoints.includes("images"))).toBe(
      true,
    )
    expect(models.some((model) => model.endpoints.includes("videos"))).toBe(
      true,
    )
    const conn = connection()
    conn.models = models
    upsertProviderConnection(conn)
    cacheModels()
    const response = await new Hono()
      .route("/models", modelRoutes)
      .request("/models")
    const ordinary = (await response.json()) as {
      data: Array<Record<string, unknown>>
    }
    expect(ordinary.data).toContainEqual(
      expect.objectContaining({
        id: "grok-4.7-build-fast",
        context_length: 256000,
      }),
    )
  })

  test("fallback catalog includes Grok 4.7", () => {
    expect(
      getXaiFallbackModels().find((model) => model.publicId === "grok-4.7"),
    ).toMatchObject({ upstreamId: "grok-4.7", endpoints: ["responses"] })
  })

  test("capacity metadata filters invalid values without inferring output or defaults", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          data: [
            {
              id: "equal",
              context_window: 42,
              context_windows: [42, 21, 42],
              max_output_tokens: 7,
            },
            {
              id: "invalid",
              context_window: "42",
              context_windows: [null, -1, 0, "42"],
              max_output_tokens: -1,
            },
            { id: "missing-default", context_windows: [500000, 256000] },
          ],
        }),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    const models = await discoverOAuthModelsForConnection(connection())
    expect(models[0]?.metadata).toEqual({
      contextWindow: 42,
      contextWindows: [21, 42],
      outputLimit: 7,
    })
    expect(models[1]?.metadata).toBeUndefined()
    expect(models[2]?.metadata).toEqual({ contextWindows: [256000, 500000] })
  })
})

describe("xAI discovery configuration and failures", () => {
  test.each([
    [{}, "https://cli-chat-proxy.grok.com/v1/models", true],
    [{ useApi: true }, "https://api.x.ai/v1/models", false],
    [
      { baseUrl: "https://xai.example.invalid/v1/" },
      "https://xai.example.invalid/v1/models",
      true,
    ],
  ] as Array<[Record<string, unknown>, string, boolean]>)(
    "uses the configured endpoint for %j",
    async (settings, expectedUrl, cliIdentity) => {
      let capturedUrl = ""
      let capturedInit: RequestInit & { proxy?: string } = {}
      globalThis.fetch = Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          capturedUrl = String(url)
          capturedInit = init ?? {}
          return Response.json({
            data: [{ id: "grok-build-0.1" }, { id: "grok-imagine-image" }],
          })
        },
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch
      const conn = connection(settings)
      conn.proxyUrl = "http://proxy.example.invalid:8080"
      conn.headers = { "X-Trace": "model-probe" }
      const models = await discoverOAuthModelsForConnection(conn)
      expect(
        models.filter((model) => model.publicId === "grok-imagine-image"),
      ).toMatchObject([{ endpoints: ["images"] }])
      expect(capturedUrl).toBe(expectedUrl)
      expect(capturedInit.proxy).toBe(conn.proxyUrl)
      expect(new Headers(capturedInit.headers).get("X-Trace")).toBe(
        "model-probe",
      )
      expect(new Headers(capturedInit.headers).has("X-XAI-Token-Auth")).toBe(
        cliIdentity,
      )
      expect(
        models.find((model) => model.publicId === "grok-build"),
      ).toMatchObject({ upstreamId: "grok-build-0.1" })
    },
  )

  test.each([
    ["HTTP error", () => new Response("unavailable", { status: 503 })],
    ["invalid JSON", () => new Response("not json")],
    ["empty list", () => Response.json({ data: [] })],
    ["wrong envelope", () => Response.json({ models: [{ id: "grok-4.7" }] })],
    [
      "unsupported models",
      () =>
        Response.json({
          data: [{ id: "chat-only", api_backend: "chat_completions" }],
        }),
    ],
  ] as Array<[string, () => Response]>)(
    "falls back on %s",
    async (_name, response) => {
      globalThis.fetch = Object.assign(async () => response(), {
        preconnect: originalFetch.preconnect,
      }) as typeof fetch
      await expect(
        getXaiModule().discoverModels?.(connection()),
      ).rejects.toThrow()
      const models = await discoverOAuthModelsForConnection(connection())
      expect(models).toEqual(getXaiFallbackModels())
    },
  )

  test("does not request models without an access token", async () => {
    let requested = false
    globalThis.fetch = Object.assign(
      async () => {
        requested = true
        throw new Error("must not fetch")
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    const conn = connection()
    conn.credentials[0]!.value = ""
    expect(await discoverOAuthModelsForConnection(conn)).toEqual(
      getXaiFallbackModels(),
    )
    expect(requested).toBe(false)
  })
})
