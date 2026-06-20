import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { OAuthAccount } from "~/lib/accounts"

import {
  buildAccountModelAliases,
  canonicalModelId,
  getAccountModelPrefix,
  parseModelReference,
} from "~/lib/accounts"
import { buildRouteTargets, resolveModelRouting } from "~/lib/route-target"
import { state } from "~/lib/state"
import { getCodexModelsForAccount } from "~/services/codex/get-models"
import { getOAuthCatalogModels } from "~/services/oauth/discover-models"
import { getOAuthFallbackModels } from "~/services/oauth/model-catalog"

const originalAccounts = state.accounts
const originalFetch = globalThis.fetch

beforeEach(() => {
  state.accounts = []
})

afterEach(() => {
  state.accounts = originalAccounts
  globalThis.fetch = originalFetch
})

function createOAuthAccount(
  provider: OAuthAccount["provider"],
  overrides: Partial<OAuthAccount> = {},
): OAuthAccount {
  return {
    id: `${provider}-account`,
    label: provider,
    provider,
    enabled: true,
    priority: 0,
    quotaState: "unknown",
    createdAt: Date.now(),
    credentials: {
      accessToken: "token",
    },
    settings: {},
    runtimeState: { authStatus: "ready" },
    availableModels: getOAuthFallbackModels({
      provider,
      settings: {},
    } as OAuthAccount),
    ...overrides,
  }
}

describe("OAuth model catalog", () => {
  test("returns provider-specific fallback models", () => {
    const claude = getOAuthCatalogModels(createOAuthAccount("claude"))
    expect(claude.some((model) => model.id === "claude-sonnet-4-6")).toBe(true)
    expect(claude[0]?.supportedEndpoints).toContain("/v1/messages")

    const kimi = getOAuthCatalogModels(createOAuthAccount("kimi"))
    expect(kimi.some((model) => model.id === "kimi-k2.5")).toBe(true)
    expect(kimi[0]?.supportedEndpoints).toContain("/chat/completions")

    const xai = getOAuthCatalogModels(createOAuthAccount("xai"))
    expect(xai.some((model) => model.id === "grok-4.3")).toBe(true)
    expect(xai[0]?.supportedEndpoints).toContain("/v1/responses")
  })
})

describe("OAuth model prefix helpers", () => {
  test("getAccountModelPrefix defaults to provider id", () => {
    expect(getAccountModelPrefix(createOAuthAccount("claude"))).toBe("claude")
  })

  test("getAccountModelPrefix uses custom CPA prefix", () => {
    const account = createOAuthAccount("claude", {
      settings: { modelPrefix: "work" },
    })
    expect(getAccountModelPrefix(account)).toBe("work")
  })

  test("parseModelReference strips provider and custom prefixes", () => {
    const account = createOAuthAccount("claude", {
      settings: { modelPrefix: "work" },
    })
    expect(parseModelReference("claude/claude-sonnet-4-6").nativeModelId).toBe(
      "claude-sonnet-4-6",
    )
    expect(
      parseModelReference("work/claude-sonnet-4-6", account).nativeModelId,
    ).toBe("claude-sonnet-4-6")
    expect(canonicalModelId("claude/claude-sonnet-4-6")).toBe(
      "claude/claude-sonnet-4-6",
    )
    expect(canonicalModelId("work/claude-sonnet-4-6", account)).toBe(
      "work/claude-sonnet-4-6",
    )
  })

  test("buildAccountModelAliases includes native and prefixed ids", () => {
    const account = createOAuthAccount("codex", {
      settings: { modelPrefix: "team-a" },
    })
    expect(buildAccountModelAliases(account, "gpt-5.4")).toEqual([
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
    state.accounts = [
      createOAuthAccount("kimi", { settings: { modelPrefix: "lab" } }),
    ]
    const routing = resolveModelRouting("lab/kimi-k2.5")
    expect(routing.accountPrefix).toBe("lab")
    expect(routing.modelId).toBe("kimi-k2.5")
  })

  test("buildRouteTargets filters by legacy provider prefix", () => {
    const claude = createOAuthAccount("claude")
    const kimi = createOAuthAccount("kimi", { id: "kimi-account" })
    state.accounts = [claude, kimi]

    const targets = buildRouteTargets({
      legacyProvider: "claude",
      publicModelId: "claude-sonnet-4-6",
      endpoint: "messages",
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]?.account?.provider).toBe("claude")
    expect(targets[0]?.upstreamModelId).toBe("claude-sonnet-4-6")
  })

  test("buildRouteTargets matches prefixed model ids", () => {
    state.accounts = [createOAuthAccount("codex")]

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
    state.accounts = [
      createOAuthAccount("claude", {
        id: "work-claude",
        settings: { modelPrefix: "work" },
      }),
      createOAuthAccount("claude", { id: "personal-claude" }),
    ]

    const targets = buildRouteTargets({
      accountPrefix: "work",
      publicModelId: "claude-sonnet-4-6",
      endpoint: "messages",
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]?.account?.id).toBe("work-claude")
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

    const account = createOAuthAccount("codex", {
      credentials: {
        accessToken: "codex-token",
        accountId: "acct_123",
      },
    })

    const models = await getCodexModelsForAccount(account)
    expect(models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.5"])
    expect(models[0]?.supportedEndpoints).toContain("/v1/responses")
  })
})
