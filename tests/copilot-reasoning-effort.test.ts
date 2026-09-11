import { describe, expect, test } from "bun:test"

import { sanitizeReasoningEffortForCopilot } from "~/services/copilot/create-chat-completions-once"

describe("sanitizeReasoningEffortForCopilot", () => {
  test("passes through the values Copilot accepts", () => {
    for (const effort of [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ] as const) {
      expect(sanitizeReasoningEffortForCopilot(effort)).toBe(effort)
    }
    expect(sanitizeReasoningEffortForCopilot(undefined)).toBeUndefined()
  })

  test("drops the translation-pipeline-only values", () => {
    expect(sanitizeReasoningEffortForCopilot("none")).toBeUndefined()
    expect(sanitizeReasoningEffortForCopilot("auto")).toBeUndefined()
  })

  test("clamps max to Copilot's highest tier instead of forwarding it", () => {
    // "max" (Windsurf/Codex top tier) is not in Copilot's accepted set
    // (minimal-xhigh), so forwarding it verbatim would be rejected upstream.
    expect(sanitizeReasoningEffortForCopilot("max")).toBe("xhigh")
  })
})
