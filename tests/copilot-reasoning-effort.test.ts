import { describe, expect, test } from "bun:test"

import { managedConnectionFromInput } from "~/lib/provider-connections"
import { sanitizeReasoningEffortForCopilot } from "~/services/copilot/create-chat-completions-once"
import { copilotProviderRuntime } from "~/services/providers/copilot"

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

test("Copilot model discovery keeps the levels the catalog advertises", async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (() => ({
      ok: true,
      status: 200,
      json: () => ({
        data: [
          {
            id: "gpt-6.1-sol",
            name: "GPT-6.1 Sol",
            vendor: "OpenAI",
            model_picker_enabled: true,
            supported_endpoints: ["/responses"],
            policy: { state: "enabled" },
            capabilities: {
              supports: { reasoning_effort: ["low", "medium", "high", "max"] },
            },
          },
          {
            // 上游没公布档位：mapping 不写 efforts，请求原样转发。
            id: "gpt-4o",
            name: "GPT-4o",
            vendor: "OpenAI",
            model_picker_enabled: true,
            supported_endpoints: ["/chat/completions"],
            policy: { state: "enabled" },
            capabilities: { supports: {} },
          },
        ],
      }),
    })) as unknown as typeof fetch

    const connection = managedConnectionFromInput({
      id: "copilot-efforts",
      name: "Copilot",
      provider: "copilot",
      enabled: true,
      priority: 0,
      credentials: { githubToken: "gh-token" },
    })
    connection.credentials[0]!.value = "copilot-token"

    const mappings = await copilotProviderRuntime.refreshModels(connection)
    expect(
      mappings.find((model) => model.publicId === "gpt-6.1-sol")?.efforts,
    ).toEqual(["low", "medium", "high", "max"])
    expect(
      mappings.find((model) => model.publicId === "gpt-4o")?.efforts,
    ).toBeUndefined()
  } finally {
    globalThis.fetch = originalFetch
  }
})
