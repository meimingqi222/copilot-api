/**
 * Tests for provider-connection runtime: state CRUD, availability state machine,
 * route-target build + selection, model reference parsing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  classifyUpstreamError,
  createConnection,
  getProviderConnection,
  isCredentialAvailable,
  isProviderProtocol,
  listProviderConnections,
  markCredentialAuthError,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  refreshCredentialAvailability,
  resetCredentialStatus,
  setCredentialEnabled,
  type ApiCredential,
  type ProviderConnection,
  updateConnection,
} from "~/lib/provider-connections"
import {
  __resetRouteTargetRoundRobin,
  buildRouteTargets,
  listExposedPublicModels,
  parseModelRef,
  selectRouteTarget,
  targetKey,
} from "~/lib/route-target"
import { openAICompatibleAdapter } from "~/services/protocols/openai-compatible"
import { openAIResponsesCompatibleAdapter } from "~/services/protocols/openai-responses"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function setupSimpleConnection(opts?: {
  id?: string
  priority?: number
  weight?: number
}) {
  return createConnection({
    id: opts?.id ?? "deepseek",
    name: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    priority: opts?.priority,
    weight: opts?.weight,
    credentials: [{ id: "cred-a", value: "sk-aaaa", authMode: "bearer" }],
    models: [
      {
        publicId: "deepseek-chat",
        upstreamId: "deepseek-chat",
        endpoints: ["chat"],
        enabled: true,
        aliases: ["deepseek-v3"],
      },
    ],
  })
}

describe("provider-connections state", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
    __resetRouteTargetRoundRobin()
  })

  test("createConnection persists and lists", async () => {
    await setupSimpleConnection()
    expect(listProviderConnections()).toHaveLength(1)
    const conn = getProviderConnection("deepseek")
    expect(conn?.protocol).toBe("openai-compatible")
    expect(conn?.credentials[0].status).toBe("ready")
  })

  test("switching to anthropic-compatible migrates existing chat models to messages", async () => {
    await setupSimpleConnection()

    await updateConnection("deepseek", {
      protocol: "anthropic-compatible",
    })

    const conn = getProviderConnection("deepseek")
    expect(conn?.protocol).toBe("anthropic-compatible")
    expect(conn?.models?.[0].endpoints).toEqual(["messages"])
    expect(
      buildRouteTargets({
        publicModelId: "deepseek-chat",
        endpoint: "messages",
        accounts: [],
      }),
    ).toHaveLength(1)
  })

  test("switching to openai-compatible migrates existing message models to chat", async () => {
    await createConnection({
      id: "anthropic",
      name: "Anthropic",
      protocol: "anthropic-compatible",
      baseUrl: "https://api.anthropic.com/v1",
      credentials: [{ id: "cred-a", value: "sk-ant", authMode: "header" }],
      models: [
        {
          publicId: "claude-sonnet",
          upstreamId: "claude-sonnet",
          endpoints: ["messages"],
          enabled: true,
        },
      ],
    })

    await updateConnection("anthropic", {
      protocol: "openai-compatible",
    })

    const conn = getProviderConnection("anthropic")
    expect(conn?.protocol).toBe("openai-compatible")
    expect(conn?.models?.[0].endpoints).toEqual(["chat"])
  })
})

describe("availability state machine", () => {
  beforeEach(() => __resetProviderConnectionsForTest())

  test("markCredentialCooldown moves to cooldown and expires", () => {
    const cred: ApiCredential = {
      id: "x",
      authMode: "bearer" as const,
      value: "v",
      enabled: true,
      status: "ready" as const,
      createdAt: Date.now(),
    }
    markCredentialCooldown(cred, { retryAfterMs: 50, reason: "test" })
    expect(cred.status).toBe("cooldown")
    expect(isCredentialAvailable(cred)).toBe(false)
    // wait past cooldown
    cred.cooldownUntil = Date.now() - 1
    refreshCredentialAvailability(cred)
    expect(cred.status).toBe("ready")
  })

  test("markCredentialAuthError requires manual reset", () => {
    const cred: ApiCredential = {
      id: "x",
      authMode: "bearer" as const,
      value: "v",
      enabled: true,
      status: "ready" as const,
      createdAt: Date.now(),
    }
    markCredentialAuthError(cred, "401 unauthorized")
    expect(cred.status).toBe("auth_error")
    refreshCredentialAvailability(cred)
    expect(cred.status).toBe("auth_error")
    resetCredentialStatus(cred)
    expect(cred.status).toBe("ready")
  })

  test("markCredentialQuotaExhausted auto-recovers after window", () => {
    const cred: ApiCredential = {
      id: "x",
      authMode: "bearer" as const,
      value: "v",
      enabled: true,
      status: "ready" as const,
      createdAt: Date.now(),
    }
    markCredentialQuotaExhausted(cred, "billing")
    expect(cred.status).toBe("quota_exhausted")
    cred.cooldownUntil = Date.now() - 1
    refreshCredentialAvailability(cred)
    expect(cred.status).toBe("ready")
  })

  test("setCredentialEnabled toggles disabled status", () => {
    const cred: ApiCredential = {
      id: "x",
      authMode: "bearer" as const,
      value: "v",
      enabled: true,
      status: "ready" as const,
      createdAt: Date.now(),
    }
    setCredentialEnabled(cred, false)
    expect(cred.status).toBe("disabled")
    expect(cred.enabled).toBe(false)
    setCredentialEnabled(cred, true)
    expect(cred.status).toBe("ready")
  })
})

describe("classifyUpstreamError", () => {
  test("classifies 429 with retry-after", () => {
    const r = classifyUpstreamError({
      status: 429,
      retryAfterHeader: "5",
      body: "",
    })
    expect(r.kind).toBe("rate_limited")
    expect(r.retryAfterMs).toBe(5000)
  })

  test("classifies 401 as auth_error", () => {
    expect(
      classifyUpstreamError({ status: 401, retryAfterHeader: null, body: "" })
        .kind,
    ).toBe("auth_error")
  })

  test("classifies 402 as quota_exhausted", () => {
    expect(
      classifyUpstreamError({ status: 402, retryAfterHeader: null, body: "" })
        .kind,
    ).toBe("quota_exhausted")
  })

  test("classifies 503 as server_error", () => {
    expect(
      classifyUpstreamError({ status: 503, retryAfterHeader: null, body: "" })
        .kind,
    ).toBe("server_error")
  })
})

describe("route-target build + select", () => {
  beforeEach(async () => {
    __resetProviderConnectionsForTest()
    __resetRouteTargetRoundRobin()
    await setupSimpleConnection()
  })

  test("buildRouteTargets returns chat target for public model", () => {
    const targets = buildRouteTargets({
      publicModelId: "deepseek-chat",
      endpoint: "chat",
      accounts: [],
    })
    expect(targets).toHaveLength(1)
    expect(targets[0].connectionId).toBe("deepseek")
    expect(targets[0].upstreamModelId).toBe("deepseek-chat")
  })

  test("buildRouteTargets matches alias", () => {
    const targets = buildRouteTargets({
      publicModelId: "deepseek-v3",
      endpoint: "chat",
      accounts: [],
    })
    expect(targets).toHaveLength(1)
  })

  test("selectRouteTarget excludes already tried", () => {
    const targets = buildRouteTargets({ endpoint: "chat" })
    const first = selectRouteTarget(targets)
    expect(first).not.toBeNull()
    const second = selectRouteTarget(targets, {
      exclude: new Set([targetKey(first as NonNullable<typeof first>)]),
    })
    expect(second).toBeNull()
  })

  test("listExposedPublicModels includes aliases", () => {
    const ids = listExposedPublicModels().map((m) => m.publicId)
    expect(ids).toContain("deepseek-chat")
    expect(ids).toContain("deepseek-v3")
  })

  test("buildRouteTargets safely ignores connections with missing credentials", () => {
    const connection = {
      id: "broken",
      name: "Broken",
      protocol: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      enabled: true,
      priority: 10,
      models: [
        {
          publicId: "broken-chat",
          upstreamId: "broken-chat",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
      createdAt: Date.now(),
    } as unknown as ProviderConnection

    expect(() =>
      buildRouteTargets({
        publicModelId: "broken-chat",
        endpoint: "chat",
        connections: [connection],
      }),
    ).not.toThrow()
    expect(
      buildRouteTargets({
        publicModelId: "broken-chat",
        endpoint: "chat",
        connections: [connection],
        accounts: [],
      }),
    ).toEqual([])
  })
})

describe("OpenAI-compatible model discovery", () => {
  test("classifies embedding model ids as embeddings only and chat ids as chat only", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: "gpt-4o-mini", owned_by: "openai" },
              { id: "text-embedding-3-small", owned_by: "openai" },
              { id: "bge-m3-embed", owned_by: "baai" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const models = await openAICompatibleAdapter.discoverModels?.({
      connection: {
        id: "openai",
        name: "OpenAI",
        protocol: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        priority: 10,
        credentials: [],
        createdAt: Date.now(),
      },
      credential: {
        id: "cred-a",
        authMode: "bearer",
        value: "sk-test",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
    })

    expect(models).toEqual([
      expect.objectContaining({ publicId: "gpt-4o-mini", endpoints: ["chat"] }),
      expect.objectContaining({
        publicId: "text-embedding-3-small",
        endpoints: ["embeddings"],
      }),
      expect.objectContaining({
        publicId: "bge-m3-embed",
        endpoints: ["embeddings"],
      }),
    ])
  })
})

describe("OpenAI Responses-compatible protocol", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
    __resetRouteTargetRoundRobin()
  })

  test("isProviderProtocol recognizes openai-responses-compatible", () => {
    expect(isProviderProtocol("openai-responses-compatible")).toBe(true)
  })

  test("adapter is registered under correct protocol id", () => {
    expect(openAIResponsesCompatibleAdapter.protocol).toBe(
      "openai-responses-compatible",
    )
  })

  test("switching to openai-responses-compatible migrates messages endpoints to chat", async () => {
    await createConnection({
      id: "openai-rs",
      name: "OpenAI Responses",
      protocol: "anthropic-compatible",
      baseUrl: "https://api.openai.com/v1",
      credentials: [{ id: "cred-a", value: "sk-test", authMode: "bearer" }],
      models: [
        {
          publicId: "gpt-4o",
          upstreamId: "gpt-4o",
          endpoints: ["messages"],
          enabled: true,
        },
      ],
    })

    await updateConnection("openai-rs", {
      protocol: "openai-responses-compatible",
    })

    const conn = getProviderConnection("openai-rs")
    expect(conn?.protocol).toBe("openai-responses-compatible")
    expect(conn?.models?.[0].endpoints).toEqual(["chat"])
  })

  test("discoverModels classifies chat models with both chat and responses endpoints", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: "gpt-4o", owned_by: "openai" },
              { id: "text-embedding-3-small", owned_by: "openai" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const models = await openAIResponsesCompatibleAdapter.discoverModels?.({
      connection: {
        id: "openai",
        name: "OpenAI",
        protocol: "openai-responses-compatible",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        priority: 10,
        credentials: [],
        createdAt: Date.now(),
      },
      credential: {
        id: "cred-a",
        authMode: "bearer",
        value: "sk-test",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
    })

    expect(models).toEqual([
      expect.objectContaining({
        publicId: "gpt-4o",
        endpoints: ["chat", "responses"],
      }),
      expect.objectContaining({
        publicId: "text-embedding-3-small",
        endpoints: ["embeddings"],
      }),
    ])
  })

  test("createResponses posts to /responses endpoint with upstream model id", async () => {
    let capturedUrl = ""
    let capturedBody: unknown = null
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: "resp_1", model: "gpt-4o" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await openAIResponsesCompatibleAdapter.createResponses?.({
      target: {
        connectionId: "openai",
        connectionName: "OpenAI",
        protocol: "openai-responses-compatible",
        credentialId: "cred-a",
        publicModelId: "gpt-4o",
        upstreamModelId: "gpt-4o-2024-08-06",
        endpoint: "responses",
        connectionPriority: 10,
        connectionWeight: 1,
        credentialPriority: 0,
        credentialWeight: 1,
      },
      connection: {
        id: "openai",
        name: "OpenAI",
        protocol: "openai-responses-compatible",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        priority: 10,
        credentials: [],
        createdAt: Date.now(),
      },
      credential: {
        id: "cred-a",
        authMode: "bearer",
        value: "sk-test",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
      payload: {
        model: "gpt-4o",
        input: "hello",
        stream: false,
      },
    })

    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >
    for (const [req, init] of calls) {
      if (req.endsWith("/responses")) {
        capturedUrl = req
        capturedBody = JSON.parse(init.body as string)
        break
      }
    }
    expect(capturedUrl).toBe("https://api.openai.com/v1/responses")
    expect(capturedBody).toEqual(
      expect.objectContaining({
        model: "gpt-4o-2024-08-06",
        input: "hello",
      }),
    )
  })
})

describe("parseModelRef", () => {
  beforeEach(async () => {
    __resetProviderConnectionsForTest()
    await setupSimpleConnection({ id: "deepseek" })
  })

  test("bare model name", () => {
    const r = parseModelRef("gpt-4o-mini")
    expect(r.connectionId).toBeUndefined()
    expect(r.legacyProvider).toBeUndefined()
    expect(r.modelId).toBe("gpt-4o-mini")
  })

  test("connection prefix matches registered connection", () => {
    const r = parseModelRef("deepseek/deepseek-chat")
    expect(r.connectionId).toBe("deepseek")
    expect(r.modelId).toBe("deepseek-chat")
  })

  test("legacy provider prefix routes to legacy", () => {
    const r = parseModelRef("copilot/gpt-4o")
    expect(r.legacyProvider).toBe("copilot")
    expect(r.modelId).toBe("gpt-4o")
  })

  test("unknown prefix stays as full id", () => {
    const r = parseModelRef("anthropic/claude-3-sonnet")
    expect(r.connectionId).toBeUndefined()
    expect(r.legacyProvider).toBeUndefined()
    expect(r.modelId).toBe("anthropic/claude-3-sonnet")
  })
})
