import { describe, expect, test } from "bun:test"

import type { OAuthAccount } from "~/lib/accounts"

import {
  isXaiCliChatProxyBaseUrl,
  isXaiDefaultApiBaseUrl,
  xaiChatBaseUrl,
  xaiUsesApi,
  xaiWsBaseUrl,
} from "~/services/xai/endpoint"
import { buildXaiHeaders } from "~/services/xai/headers"

const API_BASE = "https://api.x.ai/v1"
const CLI_BASE = "https://cli-chat-proxy.grok.com/v1"

function makeXaiAccount(settings: OAuthAccount["settings"] = {}): OAuthAccount {
  return {
    id: "xai-1",
    label: "xai",
    provider: "xai",
    enabled: true,
    priority: 0,
    createdAt: 0,
    settings,
  }
}

describe("xai endpoint resolution", () => {
  test("xaiUsesApi defaults to false (CLI mode)", () => {
    expect(xaiUsesApi(makeXaiAccount())).toBe(false)
    expect(xaiUsesApi(makeXaiAccount({ baseUrl: API_BASE }))).toBe(false)
  })

  test("xaiUsesApi honors the explicit boolean flag", () => {
    expect(xaiUsesApi(makeXaiAccount({ useApi: true }))).toBe(true)
    expect(xaiUsesApi(makeXaiAccount({ useApi: false }))).toBe(false)
  })

  test("chat base URL is cli-chat-proxy in CLI mode (default base URL)", () => {
    expect(xaiChatBaseUrl(makeXaiAccount())).toBe(CLI_BASE)
    expect(xaiChatBaseUrl(makeXaiAccount({ baseUrl: API_BASE }))).toBe(CLI_BASE)
    expect(xaiChatBaseUrl(makeXaiAccount({ baseUrl: `${API_BASE}/` }))).toBe(
      CLI_BASE,
    )
  })

  test("chat base URL is the official API when useApi is true", () => {
    expect(xaiChatBaseUrl(makeXaiAccount({ useApi: true }))).toBe(API_BASE)
    expect(
      xaiChatBaseUrl(makeXaiAccount({ useApi: true, baseUrl: API_BASE })),
    ).toBe(API_BASE)
  })

  test("chat base URL honors an explicit custom base URL in CLI mode", () => {
    const custom = "https://gateway.example.com/v1"
    expect(xaiChatBaseUrl(makeXaiAccount({ baseUrl: custom }))).toBe(custom)
    expect(
      xaiChatBaseUrl(makeXaiAccount({ useApi: true, baseUrl: custom })),
    ).toBe(custom)
  })

  test("WS base URL always uses official API (never cli-chat-proxy)", () => {
    expect(xaiWsBaseUrl(makeXaiAccount())).toBe(API_BASE)
    expect(xaiWsBaseUrl(makeXaiAccount({ useApi: true }))).toBe(API_BASE)
    // cli-chat-proxy stored in baseUrl must not leak into WS (405 upstream).
    expect(xaiWsBaseUrl(makeXaiAccount({ baseUrl: CLI_BASE }))).toBe(API_BASE)
  })

  test("WS base URL honors a custom non-cli base URL", () => {
    const custom = "https://gateway.example.com/v1"
    expect(xaiWsBaseUrl(makeXaiAccount({ baseUrl: custom }))).toBe(custom)
  })

  test("base URL classifiers ignore trailing slashes", () => {
    expect(isXaiDefaultApiBaseUrl(`${API_BASE}/`)).toBe(true)
    expect(isXaiCliChatProxyBaseUrl(`${CLI_BASE}/`)).toBe(true)
    expect(isXaiDefaultApiBaseUrl(CLI_BASE)).toBe(false)
  })
})

describe("buildXaiHeaders CLI identity", () => {
  test("omits CLI identity headers by default", () => {
    const headers = buildXaiHeaders("tok", true, "sess")
    expect(headers["X-XAI-Token-Auth"]).toBeUndefined()
    expect(headers["x-grok-client-version"]).toBeUndefined()
    expect(headers["User-Agent"]).toBeUndefined()
    expect(headers.Authorization).toBe("Bearer tok")
  })

  test("attaches CLI identity headers when cliIdentity is true", () => {
    const headers = buildXaiHeaders("tok", true, "sess", true)
    expect(headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli")
    expect(headers["x-grok-client-version"]).toBe("0.2.93")
    expect(headers["User-Agent"]).toBe("xai-grok-workspace/0.2.93")
  })
})
