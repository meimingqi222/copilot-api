import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import { buildConnectionModelAliases } from "~/lib/model-aliases"
import {
  accountManagedModelPrefix,
  listAccountManagedConnections,
  managedConnectionFromInput,
} from "~/lib/provider-connections"
import {
  canonicalModelId,
  parseModelReference,
} from "~/lib/route-target/model-reference"
import { buildRouteTargets, resolveModelRouting } from "~/lib/route-target"
import { parseThinkingModel } from "~/lib/thinking"
import { getCodexModelsForConnection } from "~/services/codex/get-models"
import { getOAuthFallbackModelsForConnection } from "~/services/oauth/model-catalog"

import { setTestConnections } from "./helpers/set-connections"

const originalConnections = listAccountManagedConnections()
const originalFetch = globalThis.fetch

beforeEach(() => {
  setTestConnections([])
})

afterEach(() => {
  setTestConnections(originalConnections)
  globalThis.fetch = originalFetch
})

function oauthConnection(
  provider: OAuthProviderId,
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  const conn = managedConnectionFromInput({
    id: `${provider}-account`,
    name: provider,
    provider,
    enabled: true,
    priority: 0,
    credentials: { accessToken: "token" },
    settings: {},
  })
  conn.models = getOAuthFallbackModelsForConnection(provider)
  return { ...conn, ...overrides }
}

describe("OAuth model catalog", () => {
  test("returns provider-specific fallback models", () => {
    const claude = getOAuthFallbackModelsForConnection("claude")
    expect(claude.some((model) => model.publicId === "claude-sonnet-4-6")).toBe(
      true,
    )
    expect(claude[0]?.endpoints).toContain("messages")

    const kimi = getOAuthFallbackModelsForConnection("kimi")
    expect(kimi.some((model) => model.publicId === "kimi-k2.5")).toBe(true)
    expect(kimi[0]?.endpoints).toContain("chat")

    const xai = getOAuthFallbackModelsForConnection("xai")
    expect(xai.some((model) => model.publicId === "grok-4.3")).toBe(true)
    expect(xai[0]?.endpoints).toContain("responses")

    const codex = getOAuthFallbackModelsForConnection("codex")
    const codexIds = codex.map((model) => model.publicId)
    for (const id of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "codex-auto-review",
    ]) {
      expect(codexIds).toContain(id)
    }
    expect(codex[0]?.endpoints).toContain("responses")
  })
})

describe("OAuth model prefix helpers", () => {
  test("accountManagedModelPrefix defaults to provider id", () => {
    expect(accountManagedModelPrefix(oauthConnection("claude"))).toBe("claude")
  })

  test("accountManagedModelPrefix uses custom CPA prefix", () => {
    const conn = oauthConnection("claude", {
      metadata: {
        provider: "claude",
        quotaState: "unknown",
        modelPrefix: "work",
      },
      modelPrefix: "work",
    })
    expect(accountManagedModelPrefix(conn)).toBe("work")
  })

  test("parses thinking suffixes without changing ordinary model ids", () => {
    expect(parseThinkingModel("gpt-5(high)")).toEqual({
      model: "gpt-5",
      config: { mode: "level", effort: "high" },
    })
    expect(parseThinkingModel("claude-sonnet-4(16384)")).toEqual({
      model: "claude-sonnet-4",
      config: { mode: "budget", budget: 16384 },
    })
    expect(parseThinkingModel("provider/model(high)")).toEqual({
      model: "provider/model",
      config: { mode: "level", effort: "high" },
    })
    expect(parseThinkingModel("gpt-5")).toEqual({ model: "gpt-5" })
    expect(parseThinkingModel("gpt-5(unknown)")).toEqual({
      model: "gpt-5(unknown)",
    })
  })

  test("parseModelReference strips provider and custom prefixes", () => {
    expect(parseModelReference("claude/claude-sonnet-4-6").nativeModelId).toBe(
      "claude-sonnet-4-6",
    )
    expect(
      parseModelReference("work/claude-sonnet-4-6", "work").nativeModelId,
    ).toBe("claude-sonnet-4-6")
    expect(canonicalModelId("claude/claude-sonnet-4-6")).toBe(
      "claude/claude-sonnet-4-6",
    )
    expect(canonicalModelId("work/claude-sonnet-4-6", "work")).toBe(
      "work/claude-sonnet-4-6",
    )
  })

  test("buildConnectionModelAliases includes native and prefixed ids", () => {
    const conn = oauthConnection("codex", {
      metadata: {
        provider: "codex",
        quotaState: "unknown",
        modelPrefix: "team-a",
      },
      modelPrefix: "team-a",
    })
    expect(buildConnectionModelAliases(conn, "gpt-5.4")).toEqual([
      "gpt-5.4",
      "team-a/gpt-5.4",
      "codex/gpt-5.4",
    ])
  })
})

describe("OAuth provider routing", () => {
  test("resolveModelRouting maps provider prefix to legacy provider", () => {
    const routing = resolveModelRouting("claude/claude-sonnet-4-6")
    expect(routing.legacyProvider).toBe("claude")
    expect(routing.modelId).toBe("claude-sonnet-4-6")
  })

  test("resolveModelRouting maps custom account prefix", () => {
    const conn = oauthConnection("kimi")
    conn.metadata = {
      ...conn.metadata,
      modelPrefix: "lab",
    }
    conn.modelPrefix = "lab"
    setTestConnections([conn])
    const routing = resolveModelRouting("lab/kimi-k2.5")
    expect(routing.accountPrefix).toBe("lab")
    expect(routing.modelId).toBe("kimi-k2.5")
  })

  test("buildRouteTargets filters by legacy provider prefix", () => {
    const claude = oauthConnection("claude")
    const kimi = oauthConnection("kimi", { id: "kimi-account" })
    setTestConnections([claude, kimi])

    const targets = buildRouteTargets({
      legacyProvider: "claude",
      publicModelId: "claude-sonnet-4-6",
      endpoint: "messages",
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]?.protocol).toBe("claude-native")
    expect(targets[0]?.upstreamModelId).toBe("claude-sonnet-4-6")
  })

  test("buildRouteTargets matches prefixed model ids", () => {
    setTestConnections([oauthConnection("codex")])

    const targets = buildRouteTargets({
      legacyProvider: "codex",
      publicModelId: "codex/gpt-5.4",
      endpoint: "responses",
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]?.upstreamModelId).toBe("gpt-5.4")
    expect(targets[0]?.publicModelId).toBe("codex/gpt-5.4")
  })

  test("buildRouteTargets routes custom prefix only to matching account", () => {
    const work = oauthConnection("claude", { id: "work-claude" })
    work.metadata = { ...work.metadata, modelPrefix: "work" }
    work.modelPrefix = "work"
    const personal = oauthConnection("claude", { id: "personal-claude" })
    setTestConnections([work, personal])

    const targets = buildRouteTargets({
      accountPrefix: "work",
      publicModelId: "claude-sonnet-4-6",
      endpoint: "messages",
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]?.connectionId).toBe("work-claude")
  })
})

describe("Codex model discovery", () => {
  test("parses codex /models response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              { slug: "gpt-5.4", display_name: "GPT-5.4" },
              { slug: "gpt-5.5", display_name: "GPT-5.5" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as unknown as typeof fetch

    const conn = oauthConnection("codex")
    conn.credentials[0].value = "codex-token"
    setTestConnections([conn])

    const models = await getCodexModelsForConnection(conn)
    expect(models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.5"])
    expect(models[0]?.supportedEndpoints).toContain("/v1/responses")
  })

  test("marks gpt-image models with the images endpoint", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              { slug: "gpt-image-2", display_name: "GPT Image 2" },
              { slug: "gpt-5.4", display_name: "GPT-5.4" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as unknown as typeof fetch

    const conn = oauthConnection("codex")
    conn.credentials[0].value = "codex-token"
    setTestConnections([conn])

    const models = await getCodexModelsForConnection(conn)
    const imageModel = models.find((model) => model.id === "gpt-image-2")
    expect(imageModel?.supportedEndpoints).toContain("/v1/images/generations")
    const chatModel = models.find((model) => model.id === "gpt-5.4")
    expect(chatModel?.supportedEndpoints).not.toContain(
      "/v1/images/generations",
    )
  })
})
