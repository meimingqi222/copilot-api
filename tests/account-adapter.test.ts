import { describe, test, expect } from "bun:test"

import type {
  Account,
  CopilotAccount,
  CodebuffAccount,
  WindsurfAccount,
  MimoAccount,
  OAuthAccount,
} from "~/lib/accounts"

import {
  type AccountConnectionPatch,
  accountToConnection,
  accountsToConnections,
  applyConnectionPatchToAccount,
  patchRequiresModelRefresh,
} from "~/lib/account-adapter"
import {
  getCodebuffAuthToken,
  getGitHubToken,
  getMimoPh,
  getMimoProxy,
  getMimoServiceToken,
  getMimoUserId,
  getOAuthAccessToken,
  getWindsurfApiKey,
} from "~/lib/accounts"

// ── Test fixtures ────────────────────────────────────────────────

function makeCopilotAccount(
  overrides?: Partial<CopilotAccount>,
): CopilotAccount {
  return {
    id: "copilot-1",
    label: "copilot-test",
    provider: "copilot",
    credentials: {
      githubToken: "ghp_test123",
    },
    settings: {
      accountType: "individual",
    },
    enabled: true,
    priority: 0,
    quotaState: "available",
    createdAt: Date.now(),
    runtimeState: {
      copilotToken: "copilot_token_abc",
      copilotTokenExpiry: Date.now() + 3600_000,
    },
    ...overrides,
  }
}

function makeCodebuffAccount(
  overrides?: Partial<CodebuffAccount>,
): CodebuffAccount {
  return {
    id: "codebuff-1",
    label: "codebuff-test",
    provider: "codebuff",
    credentials: {
      authToken: "cb_token_xyz",
    },
    settings: {
      baseUrl: "https://api.codebuff.com",
      cliVersion: "1.0.0",
      agentId: "agent-1",
      model: "default",
      costMode: "balanced",
      allowFallbacks: true,
    },
    enabled: true,
    priority: 0,
    quotaState: "available",
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeWindsurfAccount(
  overrides?: Partial<WindsurfAccount>,
): WindsurfAccount {
  return {
    id: "windsurf-1",
    label: "windsurf-test",
    provider: "windsurf",
    credentials: {
      apiKey: "ws_key_abc",
    },
    settings: {
      baseUrl: "https://api.windsurf.com",
      appVersion: "1.0.0",
      lsVersion: "1.0.0",
      defaultModel: "gpt-4",
      clientName: "windsurf",
    },
    enabled: true,
    priority: 0,
    quotaState: "available",
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeMimoAccount(overrides?: Partial<MimoAccount>): MimoAccount {
  return {
    id: "mimo-1",
    label: "mimo-test",
    provider: "mimo-aistudio",
    credentials: {
      serviceToken: "mimo_token_123",
      xiaomichatbotPh: "ph_abc",
      mimoWsToken: "ws_token",
    },
    settings: {
      userId: "user-123",
      proxy: "http://proxy:8080",
    },
    enabled: true,
    priority: 0,
    quotaState: "available",
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeOAuthAccount(overrides?: Partial<OAuthAccount>): OAuthAccount {
  return {
    id: "oauth-1",
    label: "claude-test",
    provider: "claude",
    credentials: {
      accessToken: "at_xyz",
      refreshToken: "rt_abc",
      expiresAt: Date.now() + 3600_000,
      idToken: "id_token",
      accountId: "acc-123",
      projectId: "proj-456",
      deviceId: "dev-789",
      apiKey: "api-key-000",
      email: "test@example.com",
    },
    settings: {
      baseUrl: "https://api.anthropic.com",
      proxyUrl: "http://proxy:7890",
      modelPrefix: "claude",
      tokenEndpoint: "https://auth.anthropic.com/token",
      redirectUri: "http://localhost:3000/callback",
    },
    cpaMetadata: {
      plan: "pro",
      expiresAt: "2025-12-31",
    },
    enabled: true,
    priority: 0,
    quotaState: "available",
    createdAt: Date.now(),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("accountToConnection", () => {
  test("copilot account maps to copilot-native connection", () => {
    const account = makeCopilotAccount()
    const conn = accountToConnection(account)

    expect(conn.id).toBe("copilot-1")
    expect(conn.name).toBe("copilot-test")
    expect(conn.protocol).toBe("copilot-native")
    expect(conn.enabled).toBe(true)
    expect(conn.priority).toBe(0)
    expect(conn.credentials).toHaveLength(1)

    const cred = conn.credentials[0]
    expect(cred.id).toBe("copilot-1")
    expect(cred.value).toBe("copilot_token_abc")
    expect(cred.authMode).toBe("bearer")
    expect(cred.status).toBe("ready")
    expect(cred.refresherType).toBe("copilot-token")
    expect(cred.context?.githubToken).toBe("ghp_test123")
    expect(cred.context?.copilotTokenExpiry).toBeDefined()
    expect(cred.context?.accountId).toBe("copilot-1")
  })

  test("codebuff account maps to codebuff-native connection", () => {
    const account = makeCodebuffAccount()
    const conn = accountToConnection(account)

    expect(conn.protocol).toBe("codebuff-native")
    expect(conn.credentials[0].value).toBe("cb_token_xyz")
    expect(conn.credentials[0].refresherType).toBe("static")
  })

  test("windsurf account maps to windsurf-native connection", () => {
    const account = makeWindsurfAccount()
    const conn = accountToConnection(account)

    expect(conn.protocol).toBe("windsurf-native")
    expect(conn.credentials[0].value).toBe("ws_key_abc")
    expect(conn.credentials[0].refresherType).toBe("windsurf-jwt")
  })

  test("mimo account maps to mimo-native connection", () => {
    const account = makeMimoAccount()
    const conn = accountToConnection(account)

    expect(conn.protocol).toBe("mimo-native")
    expect(conn.credentials[0].value).toBe("mimo_token_123")
    expect(conn.credentials[0].refresherType).toBe("static")
    expect(conn.metadata?.proxy).toBe("http://proxy:8080")
    expect(conn.metadata?.userId).toBe("user-123")
  })

  test("oauth account maps to native connection with metadata", () => {
    const account = makeOAuthAccount()
    const conn = accountToConnection(account)

    expect(conn.protocol).toBe("claude-native")
    expect(conn.credentials[0].value).toBe("at_xyz")
    expect(conn.credentials[0].refresherType).toBe("oauth-token")
    expect(conn.credentials[0].context?.refreshToken).toBe("rt_abc")
    expect(conn.credentials[0].context?.expiresAt).toBeDefined()
    expect(conn.credentials[0].context?.accountId).toBe("oauth-1")
    expect(conn.metadata?.cpaMetadata).toEqual({
      plan: "pro",
      expiresAt: "2025-12-31",
    })
    expect(conn.metadata?.proxyUrl).toBe("http://proxy:7890")
    expect(conn.metadata?.modelPrefix).toBe("claude")
  })

  test("exhausted account maps to quota_exhausted credential status", () => {
    const account = makeCopilotAccount({
      quotaState: "exhausted",
    })
    const conn = accountToConnection(account)

    expect(conn.credentials[0].status).toBe("quota_exhausted")
  })

  test("cooldown account maps to cooldown credential status", () => {
    const account = makeCopilotAccount({
      cooldownUntil: Date.now() + 60_000,
    })
    const conn = accountToConnection(account)

    expect(conn.credentials[0].status).toBe("cooldown")
    expect(conn.credentials[0].cooldownUntil).toBeDefined()
  })

  test("disabled account maps to disabled connection", () => {
    const account = makeCopilotAccount({ enabled: false })
    const conn = accountToConnection(account)

    expect(conn.enabled).toBe(false)
    expect(conn.credentials[0].enabled).toBe(false)
  })

  test("availableModels maps to ModelMapping[]", () => {
    const account = makeCopilotAccount({
      availableModels: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          vendor: "openai",
          pickerEnabled: true,
          pickerCategory: "premium",
          supportedEndpoints: ["chat/completions", "responses"],
        },
        {
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          vendor: "anthropic",
          pickerEnabled: true,
          supportedEndpoints: ["messages"],
        },
      ],
    })
    const conn = accountToConnection(account)

    expect(conn.models).toBeDefined()
    expect(conn.models).toHaveLength(2)
    if (!conn.models) throw new Error("models should be defined")
    expect(conn.models[0].publicId).toBe("gpt-4o")
    expect(conn.models[0].endpoints).toEqual(["chat", "responses"])
    expect(conn.models[1].publicId).toBe("claude-sonnet-4")
    expect(conn.models[1].endpoints).toEqual(["messages"])
  })

  test("undefined availableModels produces undefined models (not empty array)", () => {
    const account = makeCopilotAccount({ availableModels: undefined })
    const conn = accountToConnection(account)

    expect(conn.models).toBeUndefined()
  })

  test("empty availableModels produces empty array", () => {
    const account = makeCopilotAccount({ availableModels: [] })
    const conn = accountToConnection(account)

    expect(conn.models).toEqual([])
  })
})

describe("accountsToConnections", () => {
  test("converts multiple accounts to connections", () => {
    const accounts: Array<Account> = [
      makeCopilotAccount(),
      makeCodebuffAccount(),
      makeWindsurfAccount(),
    ]
    const conns = accountsToConnections(accounts)

    expect(conns).toHaveLength(3)
    expect(conns[0].protocol).toBe("copilot-native")
    expect(conns[1].protocol).toBe("codebuff-native")
    expect(conns[2].protocol).toBe("windsurf-native")
  })

  test("empty accounts returns empty connections", () => {
    expect(accountsToConnections([])).toEqual([])
  })
})

// ── Admin metadata mapping ──────────────────────────────────────

describe("accountToConnection admin metadata", () => {
  test("carries admin-only fields in metadata", () => {
    const account = makeCopilotAccount({
      exhaustedAt: 12345,
      quotaState: "exhausted",
      quotaInfo: {
        fetchedAt: Date.now(),
        unlimited: false,
        premiumInteractionsRemaining: 10,
      },
      runtimeState: {
        copilotToken: "tok",
        copilotTokenExpiry: Date.now() + 3600_000,
        authStatus: "error",
        lastError: "token expired",
      },
      settings: { accountType: "business" },
    })
    const conn = accountToConnection(account)

    expect(conn.metadata?.provider).toBe("copilot")
    expect(conn.metadata?.authStatus).toBe("error")
    expect(conn.metadata?.authError).toBe("token expired")
    expect(conn.credentials[0].status).toBe("auth_error")
    expect(conn.credentials[0].lastError).toBe("token expired")
    expect(conn.metadata?.exhaustedAt).toBe(12345)
    expect(conn.metadata?.quotaState).toBe("exhausted")
    const quotaInfo = conn.metadata?.quotaInfo as
      | Record<string, unknown>
      | undefined
    expect(quotaInfo).toBeDefined()
    expect(quotaInfo?.unlimited).toBe(false)
    expect(quotaInfo?.premiumInteractionsRemaining).toBe(10)
    expect(quotaInfo?.fetchedAt).toBeTypeOf("number")
    expect(conn.metadata?.settings).toEqual({ accountType: "business" })
  })

  test("defaults authStatus to ready and authError to null", () => {
    const account = makeCodebuffAccount({ runtimeState: undefined })
    const conn = accountToConnection(account)

    expect(conn.metadata?.authStatus).toBe("ready")
    expect(conn.metadata?.authError).toBeNull()
  })

  test("defaults quotaState to unknown and quotaInfo to null", () => {
    const account = makeWindsurfAccount({
      quotaState: undefined,
      quotaInfo: undefined,
    })
    const conn = accountToConnection(account)

    expect(conn.metadata?.quotaState).toBe("unknown")
    expect(conn.metadata?.quotaInfo).toBeNull()
  })

  test("OAuth account carries subtitle in metadata", () => {
    const account = makeOAuthAccount({
      label: "custom-label",
      credentials: {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() + 3600_000,
        email: "user@example.com",
      },
    })
    const conn = accountToConnection(account)

    expect(conn.metadata?.subtitle).toBe("user@example.com")
  })
})

// ── Reverse mapper: applyConnectionPatchToAccount ───────────────

describe("applyConnectionPatchToAccount", () => {
  test("updates generic fields (label, enabled, priority)", () => {
    const account = makeCopilotAccount()
    applyConnectionPatchToAccount(account, {
      label: "new-label",
      enabled: false,
      priority: 42,
    })

    expect(account.label).toBe("new-label")
    expect(account.enabled).toBe(false)
    expect(account.priority).toBe(42)
  })

  test("clamps priority to 0-100 range", () => {
    const account = makeCopilotAccount()
    applyConnectionPatchToAccount(account, { priority: 200 })
    expect(account.priority).toBe(100)

    applyConnectionPatchToAccount(account, { priority: -5 })
    expect(account.priority).toBe(0)
  })

  test("does not touch unspecified fields", () => {
    const account = makeCopilotAccount()
    const originalLabel = account.label
    applyConnectionPatchToAccount(account, { enabled: false })

    expect(account.label).toBe(originalLabel)
    expect(account.enabled).toBe(false)
  })

  test("copilot: credentialValue maps to githubToken", () => {
    const account = makeCopilotAccount()
    applyConnectionPatchToAccount(account, { credentialValue: "ghp_new" })
    expect(getGitHubToken(account)).toBe("ghp_new")
  })

  test("copilot: empty credentialValue clears githubToken", () => {
    const account = makeCopilotAccount()
    applyConnectionPatchToAccount(account, { credentialValue: "   " })
    expect(getGitHubToken(account)).toBeUndefined()
  })

  test("codebuff: credentialValue maps to authToken", () => {
    const account = makeCodebuffAccount()
    applyConnectionPatchToAccount(account, { credentialValue: "cb_new" })
    expect(getCodebuffAuthToken(account)).toBe("cb_new")
  })

  test("windsurf: credentialValue maps to apiKey", () => {
    const account = makeWindsurfAccount()
    applyConnectionPatchToAccount(account, { credentialValue: "ws_new" })
    expect(getWindsurfApiKey(account)).toBe("ws_new")
  })

  test("mimo: credentialValue maps to serviceToken", () => {
    const account = makeMimoAccount()
    applyConnectionPatchToAccount(account, { credentialValue: "mimo_new" })
    expect(getMimoServiceToken(account)).toBe("mimo_new")
  })

  test("mimo: credentialExtras updates xiaomichatbotPh/userId/proxy", () => {
    const account = makeMimoAccount()
    applyConnectionPatchToAccount(account, {
      credentialExtras: {
        xiaomichatbotPh: "ph_new",
        userId: "user-new",
        proxy: "http://new-proxy:8080",
      },
    })

    expect(getMimoPh(account)).toBe("ph_new")
    expect(getMimoUserId(account)).toBe("user-new")
    expect(getMimoProxy(account)).toBe("http://new-proxy:8080")
  })

  test("mimo: empty credentialExtras values clear the fields", () => {
    const account = makeMimoAccount()
    applyConnectionPatchToAccount(account, {
      credentialExtras: {
        xiaomichatbotPh: "  ",
        userId: "",
        proxy: undefined,
      },
    })

    expect(getMimoPh(account)).toBeUndefined()
    expect(getMimoUserId(account)).toBeUndefined()
    expect(getMimoProxy(account)).toBeUndefined()
  })

  test("oauth: credentialValue maps to accessToken", () => {
    const account = makeOAuthAccount()
    applyConnectionPatchToAccount(account, { credentialValue: "at_new" })
    expect(getOAuthAccessToken(account)).toBe("at_new")
  })

  test("oauth: settings patch applies whitelist with trim/clear semantics", () => {
    const account = makeOAuthAccount({
      settings: {
        baseUrl: "https://old.example.com",
        modelPrefix: "old",
      },
    })
    applyConnectionPatchToAccount(account, {
      settings: {
        baseUrl: "  https://new.example.com  ",
        modelPrefix: "  ", // empty → cleared to undefined
        proxyUrl: "http://proxy:7890",
        unknownField: "ignored", // not in whitelist, but still merged
      },
    })

    expect(account.settings?.baseUrl).toBe("https://new.example.com")
    expect(account.settings?.modelPrefix).toBeUndefined()
    expect(account.settings?.proxyUrl).toBe("http://proxy:7890")
  })

  test("non-oauth: settings patch merges directly without trim", () => {
    const account = makeCodebuffAccount()
    applyConnectionPatchToAccount(account, {
      settings: {
        baseUrl: "  https://untrimmed.com  ",
        customField: "value",
      },
    })

    expect(account.settings?.baseUrl).toBe("  https://untrimmed.com  ")
    expect(account.settings?.customField).toBe("value")
  })
})

describe("patchRequiresModelRefresh", () => {
  test("returns true when credentialValue is set", () => {
    const patch: AccountConnectionPatch = { credentialValue: "new-token" }
    expect(patchRequiresModelRefresh(patch)).toBe(true)
  })

  test("returns true when settings is set", () => {
    const patch: AccountConnectionPatch = { settings: { foo: "bar" } }
    expect(patchRequiresModelRefresh(patch)).toBe(true)
  })

  test("returns false when only generic fields are set", () => {
    const patch: AccountConnectionPatch = {
      label: "new",
      enabled: false,
      priority: 5,
    }
    expect(patchRequiresModelRefresh(patch)).toBe(false)
  })

  test("returns false for empty patch", () => {
    expect(patchRequiresModelRefresh({})).toBe(false)
  })
})
