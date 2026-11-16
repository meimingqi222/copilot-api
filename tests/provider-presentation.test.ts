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
  newAccount: {
    provider: string
    label: string
    credentials: Record<string, string>
    settings: Record<string, string>
  }
  authMethodTab: string
  patSubmitting: boolean
  deviceFlowStep: string
  handleAccountSubmit(): Promise<void> | undefined
  getSubmitButtonText(): string
  resetAddModalState(): void
  showToast(message: string, kind: string): void
  load(): Promise<void>
  startOAuthFlow(): Promise<void>
}

function createView(
  createAccount?: (payload: unknown) => Promise<unknown>,
): AccountView {
  const source = fs.readFileSync("pages/js/views/accounts.js", "utf8")
  const autoRefresh = fs.readFileSync("pages/js/usage-auto-refresh.js", "utf8")
  const view = vm.runInNewContext(`${autoRefresh}\n${source}\naccountsView()`, {
    ViewHelpers: {},
    I18n: { t: (key: string) => key },
    API: { accounts: { create: createAccount } },
  }) as AccountView
  view.providers = PROVIDER_IDS.map(getProviderDescriptor)
  return view
}

describe("provider-owned account presentation", () => {
  test.each(["qoder", "qoder-cn"])(
    "%s PAT login validates, submits once, and keeps browser login available",
    async (provider) => {
      const sent: unknown[] = []
      let finish!: (result: unknown) => void
      const view = createView((payload) => {
        sent.push(payload)
        return new Promise((resolve) => {
          finish = resolve
        })
      })
      const messages: string[] = []
      view.showToast = (message) => {
        messages.push(message)
      }
      view.load = () => Promise.resolve()
      let authorized = false
      view.startOAuthFlow = () => {
        authorized = true
        return Promise.resolve()
      }
      expect(view.getProviderMeta(provider)).toMatchObject({
        hasManualMode: true,
        importMethod: "pat",
      })
      view.newAccount = {
        provider,
        label: "Test account",
        credentials: { pat: "  " },
        settings: { proxyUrl: "http://localhost:9876" },
      }
      view.authMethodTab = "manual"
      expect(view.getSubmitButtonText()).toBe("accounts.pat.login")
      await view.handleAccountSubmit()
      expect(sent).toHaveLength(0)
      expect(messages).toEqual(["accounts.pat.required"])
      view.newAccount.credentials.pat = "  test-pat  "
      const pending = view.handleAccountSubmit()
      await view.handleAccountSubmit()
      expect(sent).toEqual([
        {
          provider,
          label: "Test account",
          credentials: { pat: "test-pat" },
          settings: { proxyUrl: "http://localhost:9876" },
        },
      ])
      expect(view.patSubmitting).toBe(true)
      finish({ status: "complete" })
      await pending
      expect(view.patSubmitting).toBe(false)
      expect(view.deviceFlowStep).toBe("success")
      view.authMethodTab = "oauth"
      await view.handleAccountSubmit()
      expect(authorized).toBe(true)
      expect(sent).toHaveLength(1)
      view.resetAddModalState()
      expect(view.newAccount.credentials).toEqual({})
    },
  )

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
      "trae-global",
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
