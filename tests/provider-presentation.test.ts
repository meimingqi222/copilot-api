import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import vm from "node:vm"

import { PROVIDER_IDS } from "~/lib/provider-definitions"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import type { ProviderPresentation } from "~/lib/provider-descriptors/types"

interface PresentationProvider {
  id: string
  name?: string
  authMode: "device_flow" | "direct" | "oauth"
  presentation?: ProviderPresentation
}

interface AccountView {
  providers: Array<PresentationProvider>
  providerCategory: string
  providerSearchQuery: string
  getProviderMeta(id: string): ProviderPresentation
  needsManualOAuthCallback(id: string): boolean
  filteredProviders(): Array<PresentationProvider>
}

function createView(): AccountView {
  const source = fs.readFileSync("pages/js/views/accounts.js", "utf8")
  const view = vm.runInNewContext(`${source}\naccountsView()`, {
    ViewHelpers: {},
  }) as AccountView
  view.providers = PROVIDER_IDS.map(getProviderDescriptor)
  return view
}

describe("provider-owned account presentation", () => {
  test("existing categories, import modes and manual callback availability survive API-driven rendering", () => {
    const view = createView()
    expect(view.getProviderMeta("mimo-aistudio")).toMatchObject({
      category: "domestic",
      importMethod: "cookie",
      badgeKey: "accounts.badge.cookie",
    })
    expect(view.getProviderMeta("codebuddy-cn")).toMatchObject({
      category: "import",
      importMethod: "json",
      hasManualMode: true,
    })
    expect(view.getProviderMeta("lobsterai")).toMatchObject({
      category: "import",
      importMethod: "lobsterai",
      hasManualMode: true,
    })
    for (const id of [
      "claude",
      "codex",
      "xai",
      "antigravity",
      "windsurf",
      "lobsterai",
      "trae-cn",
    ])
      expect(view.needsManualOAuthCallback(id)).toBe(true)
    for (const id of ["copilot", "kimi", "gemini", "zed", "commandcode-plan"])
      expect(view.needsManualOAuthCallback(id)).toBe(false)
  })

  test("a new provider can control filtering and login presentation without page-specific registration", () => {
    const view = createView()
    const presentation: ProviderPresentation = {
      category: "ide",
      badgeKey: "new.badge",
      hintKey: "new.hint",
      manualOAuthCallback: true,
    }
    view.providers = [
      {
        id: "new-provider",
        name: "New Provider",
        authMode: "oauth",
        presentation,
      },
    ]
    view.providerCategory = "ide"
    view.providerSearchQuery = "new"
    expect(view.getProviderMeta("new-provider")).toBe(presentation)
    expect(view.filteredProviders().map((p) => p.id)).toEqual(["new-provider"])
    expect(view.needsManualOAuthCallback("new-provider")).toBe(true)
    view.providerCategory = "domestic"
    expect(view.filteredProviders()).toEqual([])
  })

  test("providers without presentation get defaults appropriate to their login mode", () => {
    const view = createView()
    view.providers = [
      { id: "new-direct", authMode: "direct" },
      { id: "new-device", authMode: "device_flow" },
      { id: "new-oauth", authMode: "oauth" },
    ]
    expect(view.getProviderMeta("new-direct").badgeKey).toBe(
      "accounts.badge.token",
    )
    expect(view.getProviderMeta("new-device").badgeKey).toBe(
      "accounts.badge.deviceFlow",
    )
    expect(view.getProviderMeta("new-oauth").badgeKey).toBe(
      "accounts.badge.oauth",
    )
    expect(view.needsManualOAuthCallback("missing")).toBe(false)
  })
})
