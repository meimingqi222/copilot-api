import { describe, expect, test } from "bun:test"

import { managedConnectionFromInput } from "~/lib/provider-connections"
import { quotaAvailability } from "~/lib/quota/allowance"
import { snapshotFromCopilotUsage } from "~/lib/quota/fetchers/copilot"
import { sanitizeReasoningEffortForCopilot } from "~/services/copilot/create-chat-completions-once"
import { copilotProviderRuntime } from "~/services/providers/copilot"

test("Copilot premium requests limit the whole account unless a personal plan pays overage", () => {
  const connection = managedConnectionFromInput({
    provider: "copilot",
    id: "copilot-quota",
    name: "quota",
    credentials: { githubToken: "test" },
  })
  connection.models = [
    {
      publicId: "premium-looking",
      upstreamId: "native",
      endpoints: ["chat"],
      enabled: true,
    },
  ]
  const usage = (
    premium: Record<string, unknown>,
    plan = "individual",
  ): Parameters<typeof snapshotFromCopilotUsage>[0] => ({
    copilot_plan: plan,
    quota_reset_date_utc: "2026-12-01T00:00:00Z",
    quota_snapshots: {
      premium_interactions: {
        remaining: 0,
        entitlement: 300,
        unlimited: false,
        ...premium,
      },
      chat: { remaining: 0, entitlement: 0, unlimited: true },
      completions: { remaining: 0, entitlement: 0, unlimited: true },
    },
  })
  const snapshot = snapshotFromCopilotUsage(usage({}), connection)
  expect(snapshot.allowance?.state).toBe("known")
  expect(snapshot.allowance?.windows[0]).toMatchObject({
    used: 1,
    unlimited: false,
    resetsAtMs: Date.parse("2026-12-01T00:00:00Z"),
  })
  expect(snapshot.allowance?.windows[0]?.aside).toBeUndefined()
  expect(quotaAvailability(snapshot, "native")).toBe("exhausted")
  expect(snapshot.allowance?.windows[1]).toMatchObject({
    unlimited: true,
    scope: { models: ["native"] },
  })
  expect(snapshot.allowance?.windows[1]?.used).toBeUndefined()
  expect(snapshot.allowance?.windows[2]).toMatchObject({
    unlimited: true,
    aside: true,
  })

  // Paid overage keeps a personal plan serving; an organization seat is paused.
  const overage = { overage_permitted: true }
  expect(
    quotaAvailability(
      snapshotFromCopilotUsage(usage(overage), connection),
      "native",
    ),
  ).not.toBe("exhausted")
  expect(
    quotaAvailability(
      snapshotFromCopilotUsage(usage(overage, "business"), connection),
      "native",
    ),
  ).toBe("exhausted")
  // A pooled "unlimited" product without quota is spent.
  expect(
    quotaAvailability(
      snapshotFromCopilotUsage(
        usage({ unlimited: true, has_quota: false }),
        connection,
      ),
      "native",
    ),
  ).toBe("exhausted")
  expect(snapshotFromCopilotUsage({}, connection).allowance).toEqual({
    state: "unknown",
    windows: [],
  })
})

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
