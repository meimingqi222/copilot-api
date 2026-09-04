import { beforeEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/legacy-accounts"

import {
  __resetModelAliasesForTest,
  replaceModelAliases,
  resolveModelAlias,
} from "~/lib/model-aliases"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { buildRouteTargets, resolveModelRouting } from "~/lib/route-target"

import { setTestAccounts } from "./helpers/set-accounts"

beforeEach(() => {
  __resetProviderConnectionsForTest()
  __resetModelAliasesForTest()
  setTestAccounts([])
})

async function addConnection(id: string, model = "grok-4.5") {
  return createConnection({
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: "",
    credentials: [{ id: `${id}-key`, value: "secret", authMode: "bearer" }],
    models: [
      {
        publicId: model,
        upstreamId: `${model}-build`,
        endpoints: ["chat"],
        enabled: true,
        aliases: ["legacy-grok"],
      },
    ],
  })
}

describe("global model aliases", () => {
  test("matches exact, prefix and pattern with specificity priority", () => {
    replaceModelAliases([
      {
        id: "pattern",
        kind: "pattern",
        from: "gk-*",
        to: "grok-*",
        enabled: true,
      },
      {
        id: "prefix",
        kind: "prefix",
        from: "gk-",
        to: "prefix-",
        enabled: true,
      },
      {
        id: "exact",
        kind: "exact",
        from: "gk-4.5",
        to: "exact-4.5",
        enabled: true,
      },
    ])
    expect(resolveModelAlias("gk-4.5").resolvedModelId).toBe("exact-4.5")
    expect(resolveModelAlias("gk-4.3").resolvedModelId).toBe("prefix-4.3")
  })

  test("chains aliases and stops cycles", () => {
    replaceModelAliases([
      { id: "a", kind: "exact", from: "a", to: "b", enabled: true },
      { id: "b", kind: "exact", from: "b", to: "c", enabled: true },
      { id: "c", kind: "exact", from: "c", to: "a", enabled: true },
    ])
    const result = resolveModelAlias("a")
    expect(result.aliasChain).toEqual(["a", "b", "c"])
    expect(result.resolvedModelId).toBe("c")
  })

  test("real model and per-connection aliases take priority", async () => {
    await addConnection("xai-1")
    replaceModelAliases([
      {
        id: "global",
        kind: "exact",
        from: "grok-4.5",
        to: "wrong",
        enabled: true,
      },
      {
        id: "legacy",
        kind: "exact",
        from: "legacy-grok",
        to: "wrong",
        enabled: true,
      },
    ])
    expect(resolveModelAlias("grok-4.5").resolvedModelId).toBe("grok-4.5")
    expect(resolveModelAlias("legacy-grok").resolvedModelId).toBe("legacy-grok")
  })

  test("scope narrows route candidates without changing replacement", async () => {
    await addConnection("xai-1")
    await addConnection("other")
    replaceModelAliases([
      {
        id: "xai-only",
        kind: "exact",
        from: "gk-4.5",
        to: "grok-4.5",
        enabled: true,
        scope: { connectionIds: ["xai-1"] },
      },
    ])
    const routing = resolveModelRouting("gk-4.5")
    expect(routing.modelId).toBe("grok-4.5")
    const targets = buildRouteTargets({
      publicModelId: routing.modelId,
      aliasRestriction: routing.aliasRestriction,
      endpoint: "chat",
    })
    expect(targets.map((target) => target.connectionId)).toEqual(["xai-1"])
  })

  test("connectionId/model preserves the connection pin", async () => {
    await addConnection("xai-1")
    replaceModelAliases([
      {
        id: "gk",
        kind: "pattern",
        from: "gk-*",
        to: "grok-*",
        enabled: true,
      },
    ])
    const routing = resolveModelRouting("xai-1/gk-4.5")
    expect(routing.connectionId).toBe("xai-1")
    expect(routing.modelId).toBe("grok-4.5")
    const targets = buildRouteTargets({
      ...routing,
      publicModelId: routing.modelId,
      endpoint: "chat",
    })
    expect(targets[0]?.upstreamModelId).toBe("grok-4.5-build")
  })

  test("routes aliases through an xai-native account connection", () => {
    const account: Account = {
      id: "xai-account",
      label: "xAI",
      provider: "xai",
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
      availableModels: [
        {
          id: "grok-4.5",
          name: "Grok 4.5",
          vendor: "xai",
          upstreamId: "grok-4.5-build",
          pickerEnabled: true,
          supportedEndpoints: ["chat"],
        },
      ],
    }
    setTestAccounts([account])
    replaceModelAliases([
      {
        id: "gk",
        kind: "pattern",
        from: "gk-*",
        to: "grok-*",
        enabled: true,
      },
    ])
    const routing = resolveModelRouting("gk-4.5")
    const targets = buildRouteTargets({
      publicModelId: routing.modelId,
      aliasRestriction: routing.aliasRestriction,
      endpoint: "chat",
    })
    expect(targets[0]?.connectionId).toBe("xai-account")
    expect(targets[0]?.upstreamModelId).toBe("grok-4.5-build")
  })
})
