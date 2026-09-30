/**
 * Claude 上游模型目录发现的解析与守卫。
 *
 * 这层是「新模型能不能自动出现」的开关:claude 的模型表过去只来自静态
 * catalog,而 `mergeProviderRefreshedModels` 只保留已有条目、永不新增,所以
 * 上游一发新模型就永远进不了 UI。这些测试钉住上游 payload → AccountModel
 * 的映射,以及「不是 claude / 没有 token」时必须返回空数组(让调用方回落
 * 到静态 catalog),而不是抛错或返回垃圾。
 */

import { describe, expect, test } from "bun:test"

import {
  getClaudeModelsForConnection,
  parseClaudeModelsPage,
} from "~/services/claude/get-models"

import { testConnection } from "./claude-cli-fixtures"

/** Realistic shape of `GET https://api.anthropic.com/v1/models`. */
const UPSTREAM_PAGE = JSON.stringify({
  data: [
    {
      type: "model",
      id: "claude-sonnet-5-5",
      display_name: "Claude Sonnet 5.5",
      created_at: "2026-09-28T00:00:00Z",
      max_input_tokens: 1000000,
      max_tokens: 128000,
    },
    {
      type: "model",
      id: "claude-opus-5-5",
      display_name: "Claude Opus 5.5",
    },
  ],
  has_more: false,
  first_id: "claude-sonnet-5-5",
  last_id: "claude-opus-5-5",
})

describe("parseClaudeModelsPage", () => {
  test("maps upstream entries onto routable /v1/messages models", () => {
    const page = parseClaudeModelsPage(UPSTREAM_PAGE)
    expect(page.models).toEqual([
      {
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        vendor: "anthropic",
        pickerEnabled: true,
        supportedEndpoints: ["/v1/messages"],
        provider: "claude",
      },
      {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        vendor: "anthropic",
        pickerEnabled: true,
        supportedEndpoints: ["/v1/messages"],
        provider: "claude",
      },
    ])
  })

  test("canonicalises the model id and falls back to it for the name", () => {
    const page = parseClaudeModelsPage(
      JSON.stringify({ data: [{ id: "Claude-Sonnet-5-5" }] }),
    )
    expect(page.models[0]?.id).toBe("claude-sonnet-5-5")
    expect(page.models[0]?.name).toBe("claude-sonnet-5-5")
  })

  test("drops entries without a usable id and de-duplicates", () => {
    const page = parseClaudeModelsPage(
      JSON.stringify({
        data: [
          { display_name: "no id here" },
          { id: "claude-sonnet-5-5" },
          { id: "claude-sonnet-5-5" },
          { id: "  " },
        ],
      }),
    )
    expect(page.models.map((model) => model.id)).toEqual(["claude-sonnet-5-5"])
  })

  test("surfaces pagination so the caller can follow it", () => {
    const page = parseClaudeModelsPage(
      JSON.stringify({
        data: [{ id: "claude-sonnet-5-5" }],
        has_more: true,
        last_id: "claude-sonnet-5-5",
      }),
    )
    expect(page.hasMore).toBe(true)
    expect(page.lastId).toBe("claude-sonnet-5-5")
  })

  test("treats a missing has_more as the last page", () => {
    const page = parseClaudeModelsPage(JSON.stringify({ data: [] }))
    expect(page.hasMore).toBe(false)
    expect(page.lastId).toBeUndefined()
  })

  test("throws on a non-JSON body so the caller can fall back", () => {
    expect(() => parseClaudeModelsPage("<html>502 Bad Gateway</html>")).toThrow(
      "Claude models response was not valid JSON",
    )
  })
})

describe("getClaudeModelsForConnection", () => {
  test("returns nothing for a connection that is not claude", async () => {
    const connection = testConnection({
      protocol: "codex-native",
      metadata: { provider: "codex" },
    })
    expect(await getClaudeModelsForConnection(connection)).toEqual([])
  })

  test("returns nothing without an access token so the catalog fallback applies", async () => {
    const connection = testConnection({
      credentials: [
        {
          id: "cred-claude",
          authMode: "bearer",
          value: "",
          enabled: true,
          status: "ready",
          createdAt: Date.now(),
        },
      ],
    })
    expect(await getClaudeModelsForConnection(connection)).toEqual([])
  })
})
