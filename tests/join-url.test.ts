import { describe, expect, test } from "bun:test"

import { joinUrl } from "~/services/protocols/shared"

describe("joinUrl", () => {
  test("injects /v1 for anthropic messages when base has no version", () => {
    expect(
      joinUrl("https://ark.cn-beijing.volces.com/api/coding", "/messages"),
    ).toBe("https://ark.cn-beijing.volces.com/api/coding/v1/messages")
  })

  test("does not double /v1 when base already ends with /v1", () => {
    expect(
      joinUrl("https://ark.cn-beijing.volces.com/api/coding/v1", "/messages"),
    ).toBe("https://ark.cn-beijing.volces.com/api/coding/v1/messages")
    expect(joinUrl("https://api.deepseek.com/v1/", "/chat/completions")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    )
  })

  test("injects /v1 for openai-compatible standard paths", () => {
    expect(joinUrl("https://api.openai.com", "/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    )
    expect(joinUrl("https://api.openai.com", "models")).toBe(
      "https://api.openai.com/v1/models",
    )
    expect(joinUrl("https://api.openai.com", "/embeddings")).toBe(
      "https://api.openai.com/v1/embeddings",
    )
    expect(joinUrl("https://api.openai.com", "/responses")).toBe(
      "https://api.openai.com/v1/responses",
    )
  })

  test("leaves custom relative endpoints unchanged", () => {
    expect(joinUrl("https://host.example/api", "/list-models")).toBe(
      "https://host.example/api/list-models",
    )
  })

  test("respects path that already includes /v1", () => {
    expect(joinUrl("https://host.example/api/coding", "/v1/messages")).toBe(
      "https://host.example/api/coding/v1/messages",
    )
  })

  test("trims whitespace and trailing slashes on base", () => {
    expect(
      joinUrl("  https://ark.cn-beijing.volces.com/api/coding/  ", "/messages"),
    ).toBe("https://ark.cn-beijing.volces.com/api/coding/v1/messages")
  })

  test("keeps non-v1 version suffixes as-is (no extra /v1)", () => {
    expect(joinUrl("https://host.example/v2", "/messages")).toBe(
      "https://host.example/v2/messages",
    )
    expect(joinUrl("https://host.example/v1beta", "/models")).toBe(
      "https://host.example/v1beta/models",
    )
  })
})
