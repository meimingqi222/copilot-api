import { describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { buildRouteTargets } from "~/lib/route-target"
import { resolveAntigravityRequestModel } from "~/services/antigravity/create-chat-completions-once"
import { parseAntigravityModelsPayload } from "~/services/antigravity/get-models"
import {
  collapseAntigravityModelVariants,
  listAntigravitySupportedEfforts,
  parseAntigravityVariantTokens,
  readAntigravityVariants,
} from "~/services/antigravity/variant-collapse"
import {
  pickEffortVariant,
  resolveEffortVariantUpstreamId,
} from "~/lib/effort-variants"
import { resolveDispatchModel } from "~/services/dispatch/shared"

/** The live fetchAvailableModels shape: one SKU per thinking tier. */
const LIVE_CATALOG = {
  models: {
    "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" },
    "gemini-4-hydrogen-low": { displayName: "Gemini 4 Hydrogen (Low)" },
    "gemini-2.5-flash": { displayName: "Gemini 3.5 Flash Lite" },
    "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image" },
    "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)" },
    "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)" },
    "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 (High)" },
    "claude-sonnet-5-5-medium": { displayName: "Claude Sonnet 5.5 (Medium)" },
    "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
    "claude-sonnet-5-5-low": { displayName: "Claude Sonnet 5.5 (Low)" },
    "gemini-4-hydrogen-medium": { displayName: "Gemini 4 Hydrogen (Medium)" },
    "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
    // Skipped internal SKUs must not reappear through the collapse.
    "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" },
    chat_20706: { displayName: "Chat" },
  },
}

function buildCollapsedConnection(): ProviderConnection {
  return {
    id: "antigravity-account",
    name: "Antigravity",
    protocol: "antigravity-native",
    enabled: true,
    priority: 0,
    createdAt: 0,
    models: parseAntigravityModelsPayload(JSON.stringify(LIVE_CATALOG)),
    credentials: [
      {
        id: "ag-cred",
        authMode: "bearer",
        value: "token",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
    ],
  } as unknown as ProviderConnection
}

describe("Antigravity catalog variant collapse", () => {
  test("folds effort SKUs into family heads and keeps hidden pins", () => {
    const mappings = parseAntigravityModelsPayload(JSON.stringify(LIVE_CATALOG))

    const listed = mappings.filter((m) => !m.hidden).map((m) => m.publicId)
    expect(listed).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gemini-2.5-flash",
      "gemini-3.1-flash-image",
      "gemini-3.8-flash",
      "gemini-4-argon",
      "gemini-4-hydrogen",
      "gpt-oss-120b",
    ])

    const pins = mappings.filter((m) => m.hidden)
    expect(pins.map((m) => m.publicId).sort()).toEqual([
      "claude-opus-5-5-high",
      "claude-sonnet-5-5-low",
      "claude-sonnet-5-5-medium",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-4-argon-high",
      "gemini-4-hydrogen-low",
      "gemini-4-hydrogen-medium",
      "gpt-oss-120b-medium",
    ])
    // Each pin keeps its own upstreamId so an explicit pin survives dispatch.
    for (const pin of pins) {
      expect(pin.upstreamId).toBe(pin.publicId)
      expect(pin.pickerEnabled).toBe(false)
    }
  })

  test("head carries the default-tier upstream, clean name and effort list", () => {
    const mappings = parseAntigravityModelsPayload(JSON.stringify(LIVE_CATALOG))

    const flash = mappings.find((m) => m.publicId === "gemini-3.8-flash")
    expect(flash?.upstreamId).toBe("gemini-3.8-flash-high")
    expect(flash?.name).toBe("Gemini 3.8 Flash")
    expect(readAntigravityVariants(flash)).toEqual({
      defaultEffort: "high",
      byEffort: {
        low: "gemini-3.8-flash-low",
        medium: "gemini-3.8-flash-medium",
        high: "gemini-3.8-flash-high",
      },
    })
    // Default first — consumers that only see value strings take the first
    // entry as the default (same contract as Windsurf).
    expect(flash?.efforts).toEqual(["high", "low", "medium"])
    expect(listAntigravitySupportedEfforts(flash)).toEqual([
      "high",
      "low",
      "medium",
    ])

    // No high SKU: the default falls to the strongest tier present.
    const hydrogen = mappings.find((m) => m.publicId === "gemini-4-hydrogen")
    expect(hydrogen?.upstreamId).toBe("gemini-4-hydrogen-medium")
    expect(hydrogen?.name).toBe("Gemini 4 Hydrogen")
    expect(hydrogen?.efforts).toEqual(["medium", "low"])

    const sonnet = mappings.find((m) => m.publicId === "claude-sonnet-5-5")
    expect(sonnet?.upstreamId).toBe("claude-sonnet-5-5-medium")
    expect(sonnet?.efforts).toEqual(["medium", "low"])
  })

  test("families without effort SKUs stay plain mappings", () => {
    const mappings = parseAntigravityModelsPayload(JSON.stringify(LIVE_CATALOG))

    for (const id of ["gemini-2.5-flash", "gemini-3.1-flash-image"]) {
      const model = mappings.find((m) => m.publicId === id)
      expect(model?.upstreamId).toBe(id)
      expect(model?.hidden).toBeUndefined()
      expect(model?.efforts).toBeUndefined()
      expect(readAntigravityVariants(model)).toBeUndefined()
    }
    // The renamed display name is kept as-is.
    expect(mappings.find((m) => m.publicId === "gemini-2.5-flash")?.name).toBe(
      "Gemini 3.5 Flash Lite",
    )
  })

  test("endpoints survive the collapse on heads and pins", () => {
    const mappings = parseAntigravityModelsPayload(JSON.stringify(LIVE_CATALOG))
    for (const model of mappings) {
      expect(model.endpoints).toEqual(["chat", "messages"])
    }
  })

  test("parseAntigravityVariantTokens peels only real effort suffixes", () => {
    expect(parseAntigravityVariantTokens("gemini-4-hydrogen-low")).toEqual({
      family: "gemini-4-hydrogen",
      effort: "low",
    })
    expect(parseAntigravityVariantTokens("gpt-oss-120b-medium")).toEqual({
      family: "gpt-oss-120b",
      effort: "medium",
    })
    expect(parseAntigravityVariantTokens("claude-opus-5-5-high")).toEqual({
      family: "claude-opus-5-5",
      effort: "high",
    })
    expect(parseAntigravityVariantTokens("gemini-3.1-flash-image")).toEqual({
      family: "gemini-3.1-flash-image",
      effort: undefined,
    })
    expect(parseAntigravityVariantTokens("gemini-2.5-flash")).toEqual({
      family: "gemini-2.5-flash",
      effort: undefined,
    })
    // A bare effort token is a model name, not an empty family.
    expect(parseAntigravityVariantTokens("high")).toEqual({
      family: "high",
      effort: undefined,
    })
  })

  test("a bare id alongside suffixed siblings takes the high slot", () => {
    const mappings = collapseAntigravityModelVariants([
      {
        publicId: "gemini-3-flash",
        name: "Gemini 3 Flash",
        endpoints: ["chat", "messages"],
      },
      {
        publicId: "gemini-3-flash-low",
        name: "Gemini 3 Flash (Low)",
        endpoints: ["chat", "messages"],
      },
    ])
    const head = mappings.find((m) => !m.hidden)
    expect(head?.publicId).toBe("gemini-3-flash")
    expect(head?.upstreamId).toBe("gemini-3-flash")
    expect(readAntigravityVariants(head)?.byEffort).toEqual({
      high: "gemini-3-flash",
      low: "gemini-3-flash-low",
    })
    // The bare id is the head itself, not a duplicate hidden pin.
    expect(mappings.filter((m) => m.hidden).map((m) => m.publicId)).toEqual([
      "gemini-3-flash-low",
    ])
  })
})

describe("Antigravity effort selection", () => {
  const variants = {
    defaultEffort: "high" as const,
    byEffort: {
      low: "gemini-3.8-flash-low",
      medium: "gemini-3.8-flash-medium",
      high: "gemini-3.8-flash-high",
    },
  }

  test("exact tiers resolve to their own SKU", () => {
    expect(pickEffortVariant("low", variants)).toBe("low")
    expect(pickEffortVariant("medium", variants)).toBe("medium")
    expect(pickEffortVariant("high", variants)).toBe("high")
    expect(resolveEffortVariantUpstreamId(variants, "low")).toBe(
      "gemini-3.8-flash-low",
    )
    expect(resolveEffortVariantUpstreamId(variants, "medium")).toBe(
      "gemini-3.8-flash-medium",
    )
  })

  test("missing tiers fall back without crossing independent tiers", () => {
    // minimal asks for the lightest thinking tier, not thinking off.
    expect(pickEffortVariant("minimal", variants)).toBe("low")
    // xhigh/max never cross-map into the low/medium/high ladder.
    expect(pickEffortVariant("xhigh", variants)).toBe("high")
    expect(pickEffortVariant("max", variants)).toBe("high")
    // No none SKU: the family default answers, never a silent tier swap.
    expect(pickEffortVariant("none", variants)).toBe("high")
    expect(pickEffortVariant("auto", variants)).toBe("high")
    expect(pickEffortVariant(undefined, variants)).toBe("high")
  })

  test("a single-tier family answers every request with its only SKU", () => {
    const mediumOnly = {
      defaultEffort: "medium" as const,
      byEffort: { medium: "gpt-oss-120b-medium" },
    }
    for (const effort of [
      "low",
      "medium",
      "high",
      "minimal",
      "xhigh",
      "max",
    ] as const) {
      expect(pickEffortVariant(effort, mediumOnly)).toBe("medium")
    }
    expect(resolveEffortVariantUpstreamId(mediumOnly, "low")).toBe(
      "gpt-oss-120b-medium",
    )
  })

  test("a none SKU honors thinking-off requests", () => {
    const withNone = {
      defaultEffort: "high" as const,
      byEffort: { high: "family-high", none: "family-none" },
    }
    expect(pickEffortVariant("none", withNone)).toBe("none")
    expect(resolveEffortVariantUpstreamId(withNone, "none")).toBe("family-none")
  })
})

describe("resolveAntigravityRequestModel", () => {
  test("head selects the upstream SKU by reasoning_effort", () => {
    const connection = buildCollapsedConnection()

    expect(
      resolveAntigravityRequestModel(connection, "gemini-4-hydrogen"),
    ).toBe("gemini-4-hydrogen-medium")
    expect(
      resolveAntigravityRequestModel(connection, "gemini-4-hydrogen", "low"),
    ).toBe("gemini-4-hydrogen-low")
    expect(
      resolveAntigravityRequestModel(connection, "gemini-4-hydrogen", "medium"),
    ).toBe("gemini-4-hydrogen-medium")
    expect(
      resolveAntigravityRequestModel(connection, "gemini-3.8-flash", "high"),
    ).toBe("gemini-3.8-flash-high")
    expect(
      resolveAntigravityRequestModel(connection, "claude-sonnet-5-5", "low"),
    ).toBe("claude-sonnet-5-5-low")
  })

  test("hidden pins are never re-selected by effort", () => {
    const connection = buildCollapsedConnection()
    expect(
      resolveAntigravityRequestModel(
        connection,
        "gemini-4-hydrogen-low",
        "high",
      ),
    ).toBe("gemini-4-hydrogen-low")
    expect(
      resolveAntigravityRequestModel(connection, "gemini-3.8-flash-high"),
    ).toBe("gemini-3.8-flash-high")
  })

  test("aliases resolve through the head; plain and unknown models pass through", () => {
    const connection = buildCollapsedConnection()
    const head = connection.models?.find(
      (m) => m.publicId === "gemini-4-hydrogen",
    )
    if (!head) throw new Error("expected gemini-4-hydrogen head")
    head.aliases = ["hydrogen"]

    expect(resolveAntigravityRequestModel(connection, "hydrogen", "low")).toBe(
      "gemini-4-hydrogen-low",
    )
    expect(resolveAntigravityRequestModel(connection, "gemini-2.5-flash")).toBe(
      "gemini-2.5-flash",
    )
    expect(
      resolveAntigravityRequestModel(
        connection,
        "gemini-3.1-flash-image",
        "high",
      ),
    ).toBe("gemini-3.1-flash-image")
    expect(resolveAntigravityRequestModel(connection, "unknown-model")).toBe(
      "unknown-model",
    )
  })

  test("a user-renamed plain model keeps its own upstreamId", () => {
    const connection = buildCollapsedConnection()
    const plain = connection.models?.find(
      (m) => m.publicId === "gemini-2.5-flash",
    )
    if (!plain) throw new Error("expected gemini-2.5-flash mapping")
    plain.publicId = "my-flash"

    expect(resolveAntigravityRequestModel(connection, "my-flash")).toBe(
      "gemini-2.5-flash",
    )
  })
})

describe("Antigravity dispatch keeps the head for effort selection", () => {
  test("dispatch passes the requested head, not the default SKU", () => {
    const connection = buildCollapsedConnection()

    const targets = buildRouteTargets({
      publicModelId: "gemini-4-hydrogen",
      endpoint: "chat",
      connections: [connection],
      onlyAvailable: true,
    })
    // Antigravity declares chat + messages, so a chat request also gets the
    // translated messages fallback; the native chat target is the one that
    // carries the effort selection.
    const target = targets.find((t) => t.endpoint === "chat" && !t.isTranslated)
    if (!target)
      throw new Error("expected a route target for gemini-4-hydrogen")
    expect(target.publicModelId).toBe("gemini-4-hydrogen")
    // Head default is medium, but dispatch must not pre-resolve it: the
    // adapter selects the SKU from reasoning_effort.
    expect(target.upstreamModelId).toBe("gemini-4-hydrogen-medium")
    expect(resolveDispatchModel(target)).toBe("gemini-4-hydrogen")
    expect(
      resolveAntigravityRequestModel(
        connection,
        resolveDispatchModel(target),
        "low",
      ),
    ).toBe("gemini-4-hydrogen-low")
    // The old path (payload.model = upstreamModelId) collapsed the head into
    // a hidden pin and dropped the effort — locked here so it cannot regress.
    expect(
      resolveAntigravityRequestModel(connection, target.upstreamModelId, "low"),
    ).toBe("gemini-4-hydrogen-medium")
  })

  test("explicit pins keep their own SKU through dispatch", () => {
    const connection = buildCollapsedConnection()

    const pinTargets = buildRouteTargets({
      publicModelId: "gemini-4-hydrogen-low",
      endpoint: "chat",
      connections: [connection],
      onlyAvailable: true,
    })
    const pin = pinTargets.find((t) => t.endpoint === "chat" && !t.isTranslated)
    if (!pin)
      throw new Error("expected a route target for gemini-4-hydrogen-low")
    expect(pin.upstreamModelId).toBe("gemini-4-hydrogen-low")
    expect(resolveDispatchModel(pin)).toBe("gemini-4-hydrogen-low")
    expect(
      resolveAntigravityRequestModel(
        connection,
        resolveDispatchModel(pin),
        "high",
      ),
    ).toBe("gemini-4-hydrogen-low")
  })

  test("collapsed heads still serve both chat and messages endpoints", () => {
    const connection = buildCollapsedConnection()
    const targets = buildRouteTargets({
      publicModelId: "gemini-3.8-flash",
      connections: [connection],
      onlyAvailable: true,
    })
    expect(targets.map((target) => target.endpoint).sort()).toEqual([
      "chat",
      "messages",
    ])
  })
})
