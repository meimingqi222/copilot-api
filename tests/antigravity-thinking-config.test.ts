import { describe, expect, test } from "bun:test"

import { translateOpenAiChatToAntigravity } from "~/services/antigravity/translate-request"

/** The generationConfig a translated request carries. */
function generationConfigFor(model: string, effort?: string) {
  const body = translateOpenAiChatToAntigravity(
    {
      model,
      messages: [{ role: "user", content: "hi" }],
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
    },
    "test-project",
  )
  return body.request.generationConfig
}

describe("Antigravity thinking config (CPA parity)", () => {
  test("no reasoning_effort → no thinkingConfig", () => {
    const gc = generationConfigFor("gemini-3.1-flash-lite")
    expect(gc?.thinkingConfig).toBeUndefined()
  })

  test("auto → thinkingBudget=-1 on level-format models", () => {
    const gc = generationConfigFor("gemini-3.1-flash-lite", "auto")
    expect(gc?.thinkingConfig).toEqual({
      thinkingBudget: -1,
      includeThoughts: true,
    })
  })

  test("none → thinkingConfig dropped entirely on Gemini 3+ (CPA ModeNone)", () => {
    const gc = generationConfigFor("gemini-3.1-flash-lite", "none")
    expect(gc?.thinkingConfig).toBeUndefined()
  })

  test("none → thinkingBudget=0 on Gemini 2.5 budget-format models", () => {
    const gc = generationConfigFor("gemini-2.5-pro", "none")
    expect(gc?.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    })
  })

  test("xhigh → falls back to high (no Antigravity model supports xhigh)", () => {
    const gc = generationConfigFor("gemini-3.1-flash-lite", "xhigh")
    expect(gc?.thinkingConfig).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    })
  })

  test("high → thinkingLevel on Gemini 3+", () => {
    const gc = generationConfigFor("gemini-3.1-flash-lite", "high")
    expect(gc?.thinkingConfig).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    })
  })

  test("medium → thinkingBudget conversion on Gemini 2.5", () => {
    const gc = generationConfigFor("gemini-2.5-pro", "medium")
    expect(gc?.thinkingConfig).toEqual({
      thinkingBudget: 8192,
      includeThoughts: true,
    })
  })
})
