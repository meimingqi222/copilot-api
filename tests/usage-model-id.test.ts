import { beforeEach, describe, expect, test } from "bun:test"

import type { TestAccount as Account } from "./helpers/set-accounts"

import {
  __resetModelAliasesForTest,
  replaceModelAliases,
} from "~/lib/model-aliases"
import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { resolveUsageModelId } from "~/lib/usage"

import { setTestAccounts } from "./helpers/set-accounts"

function windsurfAccount(overrides?: Partial<Account>): Account {
  return {
    id: "ws-1",
    label: "ws",
    provider: "windsurf",
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
    credentials: { apiKey: "key" },
    settings: { defaultModel: "swe-1-6-fast" },
    availableModels: [
      {
        id: "swe-1-6",
        name: "SWE-1.6",
        vendor: "Windsurf",
        pickerEnabled: true,
        supportedEndpoints: ["/chat/completions"],
        provider: "windsurf",
        upstreamId: "swe-1-6",
      },
      {
        id: "swe-1-6-fast",
        name: "SWE-1.6 Fast",
        vendor: "Windsurf",
        pickerEnabled: true,
        supportedEndpoints: ["/chat/completions"],
        provider: "windsurf",
        upstreamId: "swe-1-6-fast",
      },
    ],
    ...overrides,
  } as Account
}

beforeEach(() => {
  __resetProviderConnectionsForTest()
  __resetModelAliasesForTest()
  setTestAccounts([])
})

describe("resolveUsageModelId", () => {
  test("maps provider-prefixed request to catalog model id", () => {
    setTestAccounts([windsurfAccount()])

    expect(resolveUsageModelId("ws-1", "windsurf/swe-1-6-fast")).toBe(
      "swe-1-6-fast",
    )
    expect(resolveUsageModelId("ws-1", "windsurf/swe-1-6")).toBe("swe-1-6")
  })

  test("keeps swe-1-6 and swe-1-6-fast as separate models", () => {
    setTestAccounts([windsurfAccount()])

    expect(resolveUsageModelId("ws-1", "swe-1-6")).toBe("swe-1-6")
    expect(resolveUsageModelId("ws-1", "swe-1-6-fast")).toBe("swe-1-6-fast")
  })

  test("resolves model alias to catalog model id for usage recording", () => {
    // 模拟别名场景：用户请求 gpt-5（别名），实际路由到 claude 账户的 claude-sonnet-4
    setTestAccounts([
      {
        ...windsurfAccount(),
        id: "claude-1",
        label: "claude",
        provider: "claude",
        settings: { defaultModel: "claude-sonnet-4" },
        availableModels: [
          {
            id: "claude-sonnet-4",
            name: "Claude Sonnet 4",
            vendor: "Anthropic",
            pickerEnabled: true,
            supportedEndpoints: ["/chat/completions"],
            provider: "claude",
            upstreamId: "claude-sonnet-4",
          },
        ],
      },
    ])
    replaceModelAliases([
      {
        id: "alias-gpt5",
        kind: "exact",
        from: "gpt-5",
        to: "claude-sonnet-4",
        enabled: true,
      },
    ])

    // 别名 gpt-5 应解析为 claude-sonnet-4，以便用量统计和定价查询使用真实模型
    expect(resolveUsageModelId("claude-1", "gpt-5")).toBe("claude-sonnet-4")
  })

  test("strips connectionId prefix for account-managed and plain connections", () => {
    setTestAccounts([
      windsurfAccount({
        id: "00000000-0000-4000-8000-000000000001",
        provider: "antigravity",
        availableModels: [
          {
            id: "gemini-3.8-flash",
            name: "Gemini 3.8 Flash",
            vendor: "Google",
            pickerEnabled: true,
            supportedEndpoints: ["/chat/completions"],
            provider: "antigravity",
            upstreamId: "gemini-3.8-flash-medium",
          },
        ],
      }),
    ])
    upsertProviderConnection({
      id: "plain-or-1",
      name: "OpenRouter",
      protocol: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      enabled: true,
      priority: 10,
      credentials: [],
      createdAt: Date.now(),
    })

    expect(
      resolveUsageModelId(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001/gemini-3.8-flash",
      ),
    ).toBe("gemini-3.8-flash")
    expect(
      resolveUsageModelId("plain-or-1", "plain-or-1/anthropic/claude-sonnet-4"),
    ).toBe("anthropic/claude-sonnet-4")
    expect(resolveUsageModelId("plain-or-1", "anthropic/claude-sonnet-4")).toBe(
      "anthropic/claude-sonnet-4",
    )
  })
})
