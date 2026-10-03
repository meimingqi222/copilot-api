import { describe, expect, test } from "bun:test"

import {
  isOAuthProviderId,
  isProviderId,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
} from "~/lib/provider-config"
import { PROVIDER_IDS } from "~/lib/provider-definitions"
import { isProviderProtocol } from "~/lib/provider-connections/types"
import { isAccountManagedProtocol } from "~/lib/provider-connections/account-managed"
import {
  getOAuthStrategy,
  isCallbackOAuthCapableProvider,
  isOAuthCapableProvider,
  OAUTH_PROVIDER_STRATEGIES,
} from "~/services/oauth/provider-strategies"
import {
  OAUTH_REFRESH_LEAD_MS,
  OAUTH_REFRESH_STRATEGIES,
} from "~/services/oauth/refresh-strategies"
import { initializeProviderRegistry } from "~/services/providers"
import {
  getBuiltinProviderModule,
  listBuiltinProviderModules,
} from "~/services/providers/builtins"
import { validateProviderModules } from "~/services/providers/module"
import { getProviderRuntime } from "~/services/providers/registry"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

describe("internal provider modules", () => {
  test("every persisted provider has one complete module and a recognized protocol", () => {
    const modules = listBuiltinProviderModules()
    expect(modules.map((m) => m.id).sort()).toEqual([...PROVIDER_IDS].sort())
    expect(() => validateProviderModules(modules)).not.toThrow()
    for (const module of modules) {
      expect(isProviderId(module.id)).toBe(true)
      expect(isProviderProtocol(module.adapter.protocol)).toBe(true)
      expect(isAccountManagedProtocol(module.adapter.protocol)).toBe(true)
      expect(module.adapter.protocol).toBe(PROVIDER_PROTOCOL_MAP[module.id])
    }
  })

  test("protocol and runtime initialization is repeatable and shares the registered adapter", () => {
    initializeProtocolAdapters()
    initializeProviderRegistry()
    initializeProviderRegistry()
    initializeProtocolAdapters()
    for (const module of listBuiltinProviderModules()) {
      const runtime = getProviderRuntime(module.id)
      expect(runtime.descriptor.id).toBe(module.id)
      expect(runtime.adapter).toBe(module.adapter)
      expect(getProtocolAdapter(module.adapter.protocol)).toBe(module.adapter)
    }
    for (const protocol of [
      "openai-compatible",
      "openai-responses-compatible",
      "anthropic-compatible",
      "gemini-compatible",
    ] as const) {
      expect(getProtocolAdapter(protocol)).toBeDefined()
      expect(isAccountManagedProtocol(protocol)).toBe(false)
    }
  })

  test("OAuth compatibility views resolve the module's own login and refresh hooks", () => {
    for (const id of OAUTH_PROVIDER_IDS) {
      const module = getBuiltinProviderModule(id)!
      expect(getOAuthStrategy(id)).toBe(module.oauth)
      expect(OAUTH_PROVIDER_STRATEGIES[id]).toBe(module.oauth!)
      expect(OAUTH_REFRESH_STRATEGIES[id]).toBe(module.refreshAuth!)
    }
    expect(OAUTH_REFRESH_LEAD_MS.codex).toBe(24 * 60 * 60 * 1000)
    expect(OAUTH_REFRESH_LEAD_MS.claude).toBe(4 * 60 * 60 * 1000)
    expect(OAUTH_REFRESH_LEAD_MS.factory).toBe(2 * 60 * 1000)
    expect(OAUTH_REFRESH_LEAD_MS.kimi).toBeUndefined()
  })

  test("additional browser/device sign-ins do not change account classification", () => {
    for (const id of ["windsurf", "lobsterai", "codebuddy", "codebuddy-cn"]) {
      expect(isOAuthProviderId(id)).toBe(false)
      expect(isOAuthCapableProvider(id)).toBe(true)
    }
    expect(isCallbackOAuthCapableProvider("windsurf")).toBe(true)
    expect(isCallbackOAuthCapableProvider("lobsterai")).toBe(true)
    expect(isCallbackOAuthCapableProvider("codebuddy")).toBe(false)
    expect(isOAuthCapableProvider("copilot")).toBe(false)
  })

  test("unknown and inherited object keys cannot resolve a provider", () => {
    for (const id of ["missing", "__proto__", "constructor", "toString"]) {
      expect(getBuiltinProviderModule(id)).toBeUndefined()
      expect(getOAuthStrategy(id)).toBeUndefined()
      expect(isOAuthCapableProvider(id)).toBe(false)
    }
  })

  test("rejects duplicate modules, protocol mismatches and incomplete OAuth hooks", () => {
    const codex = getBuiltinProviderModule("codex")!
    expect(() => validateProviderModules([codex, codex])).toThrow("Duplicate")
    expect(() =>
      validateProviderModules([
        { ...codex, adapter: { ...codex.adapter, protocol: "claude-native" } },
      ]),
    ).toThrow("protocol does not match")
    expect(() =>
      validateProviderModules([{ ...codex, oauth: undefined }]),
    ).toThrow("incomplete")
    expect(() =>
      validateProviderModules([{ ...codex, refreshAuth: undefined }]),
    ).toThrow("incomplete")
  })

  test("two providers may share one adapter but cannot compete for the same protocol", () => {
    const global = getBuiltinProviderModule("codebuddy")!
    const cn = getBuiltinProviderModule("codebuddy-cn")!
    expect(global.adapter).toBe(cn.adapter)
    expect(() => validateProviderModules([global, cn])).not.toThrow()
    expect(() =>
      validateProviderModules([global, { ...cn, adapter: { ...cn.adapter } }]),
    ).toThrow("Conflicting")
  })

  test("refresh-only, OAuth-only and protocol-only entry points work in a fresh process", () => {
    for (const entry of [
      "oauth/refresh-strategies",
      "oauth/provider-strategies",
      "protocols",
      "providers",
    ]) {
      const source = `await import("./src/services/${entry}");
        const { initializeProviderRegistry } = await import("./src/services/providers");
        initializeProviderRegistry();
        const { getOAuthStrategy } = await import("./src/services/oauth/provider-strategies");
        if (getOAuthStrategy("codex")?.flowType !== "pkce-callback") throw Error("missing strategy");`
      const result = Bun.spawnSync([process.execPath, "--eval", source], {
        cwd: process.cwd(),
        env: process.env,
        timeout: 30_000,
      })
      expect({
        entry,
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      }).toEqual({ entry, stderr: "", exitCode: 0 })
    }
  })
})
