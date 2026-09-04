import { describe, test, expect } from "bun:test"

import type {
  Account,
  CodebuffAccount,
  CopilotAccount,
  MimoAccount,
  OAuthAccount,
  WindsurfAccount,
} from "~/lib/legacy-accounts"

import { connectionToAccount } from "~/lib/legacy-accounts"
import {
  getConnectionProvider,
  getConnectionQuotaState,
  getConnectionSettings,
  getConnectionCredentialExtras,
  getConnectionCpaMetadata,
  getConnectionProxyUrl,
  getConnectionModelPrefix,
} from "~/lib/provider-connections/connection-metadata"
import { accountToConnectionForPersistence } from "~/lib/provider-connections/migrate-from-accounts"

// ── Test fixtures (mirror account-adapter.test.ts) ────────────────

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
    quotaState: "unknown",
    createdAt: 1700000000000,
    runtimeState: {
      copilotToken: "copilot_token_abc",
      copilotTokenExpiry: 1700003600000,
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
    quotaState: "unknown",
    createdAt: 1700000000000,
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
      defaultModel: "gpt-4",
    },
    enabled: true,
    priority: 0,
    quotaState: "unknown",
    createdAt: 1700000000000,
    runtimeState: {
      windsurfJwt: "jwt_abc",
      windsurfJwtFetchedAt: 1700000000000,
    },
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
    quotaState: "unknown",
    createdAt: 1700000000000,
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
      expiresAt: 1700003600000,
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
    quotaState: "unknown",
    createdAt: 1700000000000,
    ...overrides,
  }
}

// ── Round-trip helpers ────────────────────────────────────────────

/**
 * 比较两个 Account，忽略 runtimeState 中不持久化的字段
 * （copilotToken / windsurfJwt 等短生命周期 token）。
 * 但保留 copilotTokenExpiry / windsurfJwtFetchedAt 等时间戳（从 context 恢复）。
 */
function expectAccountEqual(
  original: Account,
  reconstructed: Account,
  options: { skipRuntimeTokens?: boolean } = {},
): void {
  const { skipRuntimeTokens = true } = options

  // 基本字段
  expect(reconstructed.id).toBe(original.id)
  expect(reconstructed.label).toBe(original.label)
  expect(reconstructed.provider).toBe(original.provider)
  expect(reconstructed.enabled).toBe(original.enabled)
  expect(reconstructed.priority).toBe(original.priority)
  expect(reconstructed.createdAt).toBe(original.createdAt)
  expect(reconstructed.quotaState).toBe(original.quotaState ?? "unknown")
  expect(reconstructed.quotaExhaustedAt).toBe(original.quotaExhaustedAt)
  expect(reconstructed.exhaustedAt).toBe(original.exhaustedAt)
  expect(reconstructed.isExhausted).toBe(original.isExhausted)
  expect(reconstructed.cooldownUntil).toBe(original.cooldownUntil)
  expect(reconstructed.lastRateLimitAt).toBe(original.lastRateLimitAt)
  expect(reconstructed.lastRateLimitReason).toBe(original.lastRateLimitReason)

  // quotaInfo
  expect(reconstructed.quotaInfo).toEqual(original.quotaInfo)

  // availableModels
  expect(reconstructed.availableModels).toEqual(original.availableModels)

  // credentials
  expect(reconstructed.credentials).toEqual(original.credentials)

  // settings
  expect(reconstructed.settings).toEqual(original.settings)

  // cpaMetadata
  expect(reconstructed.cpaMetadata).toEqual(original.cpaMetadata)

  // runtimeState — 比较 skipRuntimeTokens 后的子集
  if (skipRuntimeTokens) {
    const origRuntime = stripRuntimeTokens(original.runtimeState)
    const reconRuntime = stripRuntimeTokens(reconstructed.runtimeState)
    expect(reconRuntime).toEqual(origRuntime)
  } else {
    expect(reconstructed.runtimeState).toEqual(original.runtimeState)
  }
}

/**
 * 移除不持久化的 runtime token 字段。
 * 保留 copilotTokenExpiry / windsurfJwtFetchedAt / authStatus / lastError。
 */
function stripRuntimeTokens(
  runtime: Account["runtimeState"],
): Partial<NonNullable<typeof runtime>> {
  if (!runtime) return {}
  const { copilotToken, windsurfJwt, ...rest } = runtime
  void copilotToken
  void windsurfJwt
  return rest
}

// ── Tests ─────────────────────────────────────────────────────────

describe("accountToConnectionForPersistence", () => {
  test("copilot account maps to copilot-native connection with full metadata", () => {
    const account = makeCopilotAccount()
    const conn = accountToConnectionForPersistence(account)

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
    expect(cred.context?.copilotTokenExpiry).toBe(1700003600000)
    expect(cred.context?.accountId).toBe("copilot-1")

    // metadata 完整性
    expect(getConnectionProvider(conn)).toBe("copilot")
    expect(getConnectionQuotaState(conn)).toBe("unknown")
    expect(getConnectionSettings(conn)).toEqual({ accountType: "individual" })
  })

  test("codebuff account maps to codebuff-native connection", () => {
    const account = makeCodebuffAccount()
    const conn = accountToConnectionForPersistence(account)

    expect(conn.protocol).toBe("codebuff-native")
    expect(conn.credentials[0].value).toBe("cb_token_xyz")
    expect(conn.credentials[0].refresherType).toBe("static")
    expect(getConnectionProvider(conn)).toBe("codebuff")
  })

  test("windsurf account maps to windsurf-native connection", () => {
    const account = makeWindsurfAccount()
    const conn = accountToConnectionForPersistence(account)

    expect(conn.protocol).toBe("windsurf-native")
    expect(conn.credentials[0].value).toBe("ws_key_abc")
    expect(conn.credentials[0].refresherType).toBe("windsurf-jwt")
    expect(conn.credentials[0].context?.windsurfJwt).toBe("jwt_abc")
    expect(getConnectionProvider(conn)).toBe("windsurf")
  })

  test("mimo account maps to mimo-native connection with credentialExtras", () => {
    const account = makeMimoAccount()
    const conn = accountToConnectionForPersistence(account)

    expect(conn.protocol).toBe("mimo-native")
    expect(conn.credentials[0].value).toBe("mimo_token_123")
    expect(conn.credentials[0].refresherType).toBe("static")

    // credentialExtras 应包含 xiaomichatbotPh 和 mimoWsToken
    const extras = getConnectionCredentialExtras(conn)
    expect(extras).toBeDefined()
    expect(extras?.xiaomichatbotPh).toBe("ph_abc")
    expect(extras?.mimoWsToken).toBe("ws_token")

    expect(getConnectionProvider(conn)).toBe("mimo-aistudio")
    expect(conn.metadata?.proxy).toBe("http://proxy:8080")
    expect(conn.metadata?.userId).toBe("user-123")
  })

  test("oauth account maps to native connection with full metadata", () => {
    const account = makeOAuthAccount()
    const conn = accountToConnectionForPersistence(account)

    expect(conn.protocol).toBe("claude-native")
    expect(conn.credentials[0].value).toBe("at_xyz")
    expect(conn.credentials[0].refresherType).toBe("oauth-token")
    expect(conn.credentials[0].context?.refreshToken).toBe("rt_abc")
    expect(conn.credentials[0].context?.expiresAt).toBe(1700003600000)
    expect(conn.credentials[0].context?.accountId).toBe("oauth-1")
    expect(conn.credentials[0].context?.oauthAccountId).toBe("acc-123")

    expect(getConnectionCpaMetadata(conn)).toEqual({
      plan: "pro",
      expiresAt: "2025-12-31",
    })
    expect(getConnectionProxyUrl(conn)).toBe("http://proxy:7890")
    expect(getConnectionModelPrefix(conn)).toBe("claude")

    // credentialExtras 应包含 email / accountId / projectId / deviceId / apiKey / idToken / refreshToken
    const extras = getConnectionCredentialExtras(conn)
    expect(extras).toBeDefined()
    expect(extras?.email).toBe("test@example.com")
    expect(extras?.accountId).toBe("acc-123")
    expect(extras?.projectId).toBe("proj-456")
    expect(extras?.deviceId).toBe("dev-789")
    expect(extras?.apiKey).toBe("api-key-000")
    expect(extras?.idToken).toBe("id_token")
    expect(extras?.refreshToken).toBe("rt_abc")
  })

  test("id is preserved (risk 5.9: never generate new id)", () => {
    const accounts = [
      makeCopilotAccount(),
      makeCodebuffAccount(),
      makeWindsurfAccount(),
      makeMimoAccount(),
      makeOAuthAccount(),
    ]
    const conns = accounts.map((a) => accountToConnectionForPersistence(a))
    for (const [i, account] of accounts.entries()) {
      expect(conns[i].id).toBe(account.id)
      expect(conns[i].credentials[0].id).toBe(account.id)
    }
  })
})

describe("connectionToAccount (round-trip)", () => {
  test("copilot round-trip: Account → Connection → Account deep equal", () => {
    const original = makeCopilotAccount()
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expectAccountEqual(original, reconstructed)
  })

  test("codebuff round-trip: Account → Connection → Account deep equal", () => {
    const original = makeCodebuffAccount()
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expectAccountEqual(original, reconstructed)
  })

  test("windsurf round-trip: Account → Connection → Account deep equal", () => {
    const original = makeWindsurfAccount()
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expectAccountEqual(original, reconstructed)
  })

  test("mimo round-trip: Account → Connection → Account deep equal", () => {
    const original = makeMimoAccount()
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expectAccountEqual(original, reconstructed)
  })

  test("oauth round-trip: Account → Connection → Account deep equal", () => {
    const original = makeOAuthAccount()
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expectAccountEqual(original, reconstructed)
  })

  test("round-trip preserves availableModels", () => {
    const original = makeCopilotAccount({
      availableModels: [
        {
          id: "gpt-4",
          name: "GPT-4",
          vendor: "openai",
          pickerEnabled: true,
          pickerCategory: "chat",
          supportedEndpoints: ["chat/completions"],
          upstreamId: "gpt-4-upstream",
        },
      ],
    })
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expect(reconstructed.availableModels).toEqual(original.availableModels)
  })

  test("round-trip preserves empty availableModels ([] stays [], not undefined)", () => {
    // [] 表示"已加载但为空",undefined 表示"尚未加载"。
    // 两者在通配 target 判定中语义不同(附录 D.3 规则 4),
    // round-trip 必须保留区分,不能把 [] 坍缩为 undefined。
    const original = makeCopilotAccount({ availableModels: [] })
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expect(reconstructed.availableModels).toEqual([])
  })

  test("round-trip preserves undefined availableModels", () => {
    const original = makeCopilotAccount({ availableModels: undefined })
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expect(reconstructed.availableModels).toBeUndefined()
  })

  test("round-trip preserves quotaInfo", () => {
    const original = makeCopilotAccount({
      quotaInfo: {
        fetchedAt: 1700000000000,
        premiumInteractionsRemaining: 100,
        premiumInteractionsTotal: 500,
        unlimited: false,
      },
    })
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expect(reconstructed.quotaInfo).toEqual(original.quotaInfo)
  })

  test("round-trip preserves cooldownUntil and lastRateLimitAt", () => {
    const original = makeCopilotAccount({
      cooldownUntil: Date.now() + 60_000,
      lastRateLimitAt: Date.now(),
      lastRateLimitReason: "upstream_429",
    })
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expect(reconstructed.cooldownUntil).toBe(original.cooldownUntil)
    expect(reconstructed.lastRateLimitAt).toBe(original.lastRateLimitAt)
    expect(reconstructed.lastRateLimitReason).toBe(original.lastRateLimitReason)
  })

  test("round-trip preserves authStatus error", () => {
    const original = makeOAuthAccount({
      runtimeState: {
        authStatus: "error",
        lastError: "token expired",
      },
    })
    const conn = accountToConnectionForPersistence(original)
    const reconstructed = connectionToAccount(conn)
    expect(reconstructed.runtimeState?.authStatus).toBe("error")
    expect(reconstructed.runtimeState?.lastError).toBe("token expired")
  })
})

describe("migrateAccountsToConnections", () => {
  test("batch migration preserves all ids and count", () => {
    const accounts = [
      makeCopilotAccount(),
      makeCodebuffAccount(),
      makeWindsurfAccount(),
      makeMimoAccount(),
      makeOAuthAccount(),
    ]
    const conns = accounts.map((a) => accountToConnectionForPersistence(a))
    expect(conns).toHaveLength(5)
    for (const [i, account] of accounts.entries()) {
      expect(conns[i].id).toBe(account.id)
    }
  })
})
