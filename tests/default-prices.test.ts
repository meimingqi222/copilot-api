import { describe, expect, test } from "bun:test"

import { getDefaultModelPrice } from "~/lib/default-prices"

describe("getDefaultModelPrice", () => {
  test("prefers the most specific partial model match", () => {
    const price = getDefaultModelPrice("gpt-5.1-codex-mini-20260101")

    expect(price).not.toBeNull()
    expect(price?.promptPricePer1k).toBe(0.00025)
    expect(price?.completionPricePer1k).toBe(0.002)
  })

  test("keeps generic partial matching for dated snapshots", () => {
    const price = getDefaultModelPrice("claude-sonnet-4-20250514")

    expect(price).not.toBeNull()
    expect(price?.promptPricePer1k).toBe(0.003)
    expect(price?.completionPricePer1k).toBe(0.015)
  })
})
