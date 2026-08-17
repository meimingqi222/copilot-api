import { beforeEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import {
  __resetModelAliasesForTest,
  replaceModelAliases,
} from "~/lib/model-aliases"
import { __resetProviderConnectionsForTest } from "~/lib/provider-connections"
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
})
