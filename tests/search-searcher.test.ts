import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import {
  hasSearcher,
  listSearchers,
  searchOrchestrationEnabled,
} from "~/services/search/searcher"

const isolationRoot = PATHS.APP_DIR
let tempAppDir: string
const originalEnv = process.env.SEARCH_ORCHESTRATION

beforeEach(async () => {
  tempAppDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `search-searcher-${randomUUID()}-`),
  )
  redirectPathsToDir(tempAppDir)
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
  delete process.env.SEARCH_ORCHESTRATION
})

afterEach(async () => {
  redirectPathsToDir(isolationRoot)
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
  if (originalEnv === undefined) delete process.env.SEARCH_ORCHESTRATION
  else process.env.SEARCH_ORCHESTRATION = originalEnv
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
})

describe("searcher selection", () => {
  test("ranks xAI after Codex and Claude, before compatible searchers", async () => {
    const candidates = [
      ["openai-responses-compatible", "responses"],
      ["anthropic-compatible", "messages"],
      ["xai-native", "responses"],
      ["claude-native", "messages"],
      ["codex-native", "responses"],
    ] as const
    for (const [protocol, endpoint] of candidates) {
      await createConnection({
        id: protocol,
        name: protocol,
        protocol,
        baseUrl: "https://search.test/v1",
        credentials: [
          { id: `${protocol}-cred`, value: "tok", authMode: "bearer" },
        ],
        models: [
          {
            publicId: `${protocol}-model`,
            upstreamId: `${protocol}-model`,
            endpoints: [endpoint],
            enabled: true,
          },
        ],
      })
    }

    expect(
      listSearchers().map((searcher) => searcher.connection.protocol),
    ).toEqual([
      "codex-native",
      "claude-native",
      "xai-native",
      "anthropic-compatible",
      "openai-responses-compatible",
    ])
    expect(listSearchers()[2].target.endpoint).toBe("responses")
  })

  test("xAI alone enables search and requires an available Responses model", async () => {
    await createConnection({
      id: "xai",
      name: "xai",
      protocol: "xai-native",
      baseUrl: "https://xai.test/v1",
      credentials: [{ id: "xai-cred", value: "tok", authMode: "bearer" }],
      models: [
        {
          publicId: "chat-only",
          upstreamId: "chat-only",
          endpoints: ["chat"],
          enabled: true,
        },
        {
          publicId: "disabled",
          upstreamId: "disabled",
          endpoints: ["responses"],
          enabled: false,
        },
      ],
    })
    expect(hasSearcher()).toBe(false)

    await createConnection({
      id: "xai-usable",
      name: "xai-usable",
      protocol: "xai-native",
      baseUrl: "https://xai.test/v1",
      credentials: [
        { id: "xai-usable-cred", value: "tok", authMode: "bearer" },
      ],
      models: [
        {
          publicId: "grok-mini",
          upstreamId: "grok-mini",
          endpoints: ["responses"],
          enabled: true,
        },
      ],
    })
    expect(hasSearcher()).toBe(true)
    expect(listSearchers().map((searcher) => searcher.connection.id)).toEqual([
      "xai-usable",
    ])
    process.env.SEARCH_ORCHESTRATION = "0"
    expect(listSearchers()).toEqual([])
  })

  test("prefers a codex account over every other search-capable protocol", async () => {
    await createConnection({
      id: "anthropic",
      name: "anthropic",
      protocol: "anthropic-compatible",
      baseUrl: "https://api.anthropic.test",
      credentials: [{ id: "c1", value: "sk", authMode: "bearer" }],
      models: [
        {
          publicId: "claude-sonnet-4",
          upstreamId: "claude-sonnet-4",
          endpoints: ["messages"],
          enabled: true,
        },
      ],
    })
    await createConnection({
      id: "codex",
      name: "codex",
      protocol: "codex-native",
      baseUrl: "https://chatgpt.test/backend-api/codex",
      credentials: [{ id: "c2", value: "tok", authMode: "bearer" }],
      models: [
        {
          publicId: "gpt-5-codex",
          upstreamId: "gpt-5-codex",
          endpoints: ["responses"],
          enabled: true,
        },
      ],
    })

    const searchers = listSearchers()
    expect(searchers.map((searcher) => searcher.connection.id)).toEqual([
      "codex",
      "anthropic",
    ])
    expect(searchers[0].target.endpoint).toBe("responses")
    expect(searchers[1].target.endpoint).toBe("messages")
  })

  test("prefers a small model tier on the chosen account", async () => {
    await createConnection({
      id: "codex",
      name: "codex",
      protocol: "codex-native",
      baseUrl: "https://chatgpt.test/backend-api/codex",
      credentials: [{ id: "c", value: "tok", authMode: "bearer" }],
      models: [
        {
          publicId: "gpt-5-codex",
          upstreamId: "gpt-5-codex",
          endpoints: ["responses"],
          enabled: true,
        },
        {
          publicId: "gpt-5-mini",
          upstreamId: "gpt-5-mini",
          endpoints: ["responses"],
          enabled: true,
        },
      ],
    })

    expect(listSearchers()[0]?.model).toBe("gpt-5-mini")
  })

  test("skips a disabled account and a connection with no usable model", async () => {
    await createConnection({
      id: "disabled",
      name: "disabled",
      protocol: "codex-native",
      baseUrl: "https://chatgpt.test/backend-api/codex",
      enabled: false,
      credentials: [{ id: "c", value: "tok", authMode: "bearer" }],
      models: [
        {
          publicId: "gpt-5-mini",
          upstreamId: "gpt-5-mini",
          endpoints: ["responses"],
          enabled: true,
        },
      ],
    })
    await createConnection({
      id: "no-model",
      name: "no-model",
      protocol: "codex-native",
      baseUrl: "https://chatgpt.test/backend-api/codex",
      credentials: [{ id: "c", value: "tok", authMode: "bearer" }],
      models: [],
    })

    expect(listSearchers()).toEqual([])
    expect(hasSearcher()).toBe(false)
  })

  test("SEARCH_ORCHESTRATION=0 disables the searcher entirely", async () => {
    await createConnection({
      id: "codex",
      name: "codex",
      protocol: "codex-native",
      baseUrl: "https://chatgpt.test/backend-api/codex",
      credentials: [{ id: "c", value: "tok", authMode: "bearer" }],
      models: [
        {
          publicId: "gpt-5-mini",
          upstreamId: "gpt-5-mini",
          endpoints: ["responses"],
          enabled: true,
        },
      ],
    })

    expect(searchOrchestrationEnabled()).toBe(true)
    expect(hasSearcher()).toBe(true)

    process.env.SEARCH_ORCHESTRATION = "0"
    expect(searchOrchestrationEnabled()).toBe(false)
    expect(hasSearcher()).toBe(false)
    expect(listSearchers()).toEqual([])
  })
})
