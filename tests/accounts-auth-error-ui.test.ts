import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

/**
 * 认证失败必须在账号卡片上直接可见。
 *
 * 之前的实现只把 `authError` 放在徽标的 `title` 属性里:桌面端要悬停,
 * 移动端根本看不到 —— 用户因此以为"没有报错",也就找不到重新认证的入口。
 */
const ROOT = join(import.meta.dir, "..")
const html = readFileSync(join(ROOT, "pages/index.html"), "utf8")
const i18n = readFileSync(join(ROOT, "pages/js/i18n.js"), "utf8")

describe("账号卡片:认证失败可见", () => {
  test("卡片上有直接渲染 authError 的横幅(不是只放 title)", () => {
    // 横幅以 authStatus === 'error' 且存在 authError 为条件
    expect(html).toContain(
      "x-show=\"account.authStatus === 'error' && account.authError\"",
    )
    // 文本绑定在可见元素上
    const banner = html.slice(
      html.indexOf(
        "x-show=\"account.authStatus === 'error' && account.authError\"",
      ),
    )
    const bannerBody = banner.slice(0, 1600)
    expect(bannerBody).toContain('x-text="account.authError"')
    // 就地提供重新认证入口
    expect(bannerBody).toContain('@click="openReauthModal(account)"')
  })

  test("重新认证入口由供应商认证模式决定，不依赖供应商名称名单", () => {
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)]
      .map(([tag]) => tag)
      .filter((tag) => tag.includes('@click="openReauthModal(account)"'))
    expect(buttons).toHaveLength(2)
    const view = runInNewContext(
      readFileSync(join(ROOT, "pages/js/usage-auto-refresh.js"), "utf8")
        + "\n"
        + readFileSync(join(ROOT, "pages/js/views/accounts.js"), "utf8")
        + "\naccountsView()",
      { ViewHelpers: {} },
    ) as Record<string, unknown>
    const providers = [
      { id: "codebuddy", authMode: "oauth" },
      { id: "codebuddy-cn", authMode: "oauth" },
      { id: "codex", authMode: "oauth" },
      { id: "future-provider", authMode: "oauth" },
      { id: "token-only", authMode: "direct" },
      { id: "device-only", authMode: "device_flow" },
    ]
    for (const provider of [...providers.map(({ id }) => id), "unknown"]) {
      for (const button of buttons) {
        const expression = button.match(/x-show="([^"]+)"/)?.[1]
        expect(expression).toBeDefined()
        for (const authStatus of ["error", "ready"]) {
          expect(
            runInNewContext(`view.${expression}`, {
              view: { ...view, providers },
              account: { provider, authStatus },
            }),
          ).toBe(
            authStatus === "error"
              && [
                "codebuddy",
                "codebuddy-cn",
                "codex",
                "future-provider",
              ].includes(provider),
          )
        }
      }
    }
  })

  test("文案在中英文里都有", () => {
    for (const key of ["accounts.authErrorTitle", "accounts.authErrorHint"]) {
      const hits = i18n.split(`"${key}"`).length - 1
      expect(hits, `${key} 应同时出现在 zh 和 en`).toBe(2)
    }
  })
})

interface WindsurfAccount {
  id: string
  settings?: Record<string, unknown>
}

function windsurfView() {
  const requests: Array<{ action: string; payload: unknown }> = []
  let failUpdate = false
  let timer: (() => Promise<void>) | undefined
  const view = runInNewContext(
    readFileSync(join(ROOT, "pages/js/usage-auto-refresh.js"), "utf8")
      + "\n"
      + readFileSync(join(ROOT, "pages/js/views/accounts.js"), "utf8")
      + "\naccountsView()",
    {
      ViewHelpers: {},
      I18n: { t: (key: string) => key },
      setTimeout: (callback: () => Promise<void>) => {
        timer = callback
      },
      clearTimeout: () => undefined,
      API: {
        accounts: {
          create: (payload: unknown) => {
            requests.push({ action: "create", payload })
            return { status: "complete" }
          },
          update: (
            id: string,
            payload: { settings: Record<string, unknown> },
          ) => {
            requests.push({ action: id, payload })
            if (failUpdate) throw new Error("Synthetic update failure")
            return {
              account: {
                settings: { proxyUrl: "synthetic-proxy", ...payload.settings },
              },
            }
          },
        },
        oauth: {
          start: (_provider: string, payload: unknown) => {
            requests.push({ action: "oauth", payload })
            return { flowId: "synthetic-flow" }
          },
          complete: () => ({ status: "complete", accountId: "synthetic" }),
          poll: () => ({ status: "complete", account: { id: "synthetic" } }),
        },
      },
    },
  ) as {
    newAccount: {
      provider: string
      label: string
      credentials: Record<string, unknown>
      settings: Record<string, unknown>
    }
    providers: Array<{ id: string; authMode: string }>
    reauthAccount: WindsurfAccount | null
    deviceFlowStep: string
    oauthFlowData: { flowId: string }
    oauthCallbackInput: string
    showToast: () => void
    load: () => Promise<void>
    startOAuthFlow: () => Promise<void>
    setAccountFieldValue(
      field: { key: string; type: string },
      value: unknown,
    ): void
    getSubmitButtonText(): string
    submitAccount(): Promise<void>
    submitOAuthCallback(): Promise<void>
    pollOAuthFlow(): void
    setWindsurfCacheKeepalive(
      account: WindsurfAccount,
      enabled: boolean,
    ): Promise<void>
  }
  view.newAccount.provider = "windsurf"
  view.providers = [{ id: "windsurf", authMode: "oauth" }]
  view.showToast = () => undefined
  view.load = () => Promise.resolve()
  return {
    view,
    requests,
    fail: () => {
      failUpdate = true
    },
    poll: async () => {
      await timer?.()
    },
  }
}

test("Windsurf CLI import bypasses OAuth and preserves proxy and explicit keepalive", async () => {
  const { view, requests } = windsurfView()
  view.setAccountFieldValue({ key: "importCli", type: "checkbox" }, true)
  view.setAccountFieldValue({ key: "cacheKeepalive", type: "checkbox" }, true)
  view.newAccount.settings.proxyUrl = "synthetic-proxy"
  expect(view.getSubmitButtonText()).toBe("accounts.saveAndImport")
  await view.submitAccount()
  expect(requests).toEqual([
    {
      action: "create",
      payload: {
        provider: "windsurf",
        label: undefined,
        credentials: { importCli: true },
        settings: {
          importCli: true,
          cacheKeepalive: true,
          proxyUrl: "synthetic-proxy",
        },
      },
    },
  ])
  expect(view.deviceFlowStep).toBe("success")
})

test("Windsurf defaults to OAuth with keepalive off; reauth cannot import CLI", async () => {
  const { view, requests } = windsurfView()
  expect(view.newAccount.settings.cacheKeepalive).toBeUndefined()
  view.newAccount.settings.proxyUrl = "  synthetic-proxy  "
  await view.submitAccount()
  expect(requests[0]?.payload).toMatchObject({ proxyUrl: "synthetic-proxy" })
  view.newAccount.settings.importCli = true
  view.reauthAccount = { id: "synthetic" }
  await view.submitAccount()
  expect(requests.map(({ action }) => action)).toEqual(["oauth", "oauth"])
})

test.each([false, true])(
  "manual and polled OAuth preserve proxy and keepalive (%s)",
  async (keepalive) => {
    for (const manual of [false, true]) {
      const { view, requests, poll } = windsurfView()
      view.newAccount.settings = {
        proxyUrl: "synthetic-proxy",
        cacheKeepalive: keepalive,
        importCli: false,
      }
      view.oauthFlowData = { flowId: "synthetic-flow" }
      view.oauthCallbackInput = "synthetic-callback"
      view.deviceFlowStep = "pending"
      if (manual) await view.submitOAuthCallback()
      else {
        view.pollOAuthFlow()
        await poll()
      }
      expect(requests).toEqual([
        {
          action: "synthetic",
          payload: {
            settings: {
              proxyUrl: "synthetic-proxy",
              cacheKeepalive: keepalive,
            },
          },
        },
      ])
      expect(view.deviceFlowStep).toBe("success")
    }
  },
)

test("existing Windsurf account keepalive is opt-in and failed saves retain settings", async () => {
  const { view, requests, fail } = windsurfView()
  const account: WindsurfAccount = { id: "synthetic" }
  await view.setWindsurfCacheKeepalive(account, true)
  expect(account.settings).toEqual({
    proxyUrl: "synthetic-proxy",
    cacheKeepalive: true,
  })
  await view.setWindsurfCacheKeepalive(account, false)
  expect(account.settings?.cacheKeepalive).toBe(false)
  fail()
  await view.setWindsurfCacheKeepalive(account, true)
  expect(account.settings?.cacheKeepalive).toBe(false)
  expect(requests).toHaveLength(3)
})

test("Windsurf controls render strict opt-in with bilingual safety hints", () => {
  expect(html).toContain(':checked="account.settings?.cacheKeepalive === true"')
  expect(html).toContain(
    "x-text=\"field.descriptionKey ? t(field.descriptionKey) : ''\"",
  )
  for (const suffix of [
    "importCli",
    "importCliHint",
    "cacheKeepalive",
    "cacheKeepaliveHint",
  ]) {
    expect(i18n.split(`"accounts.provider.windsurf.${suffix}"`)).toHaveLength(3)
  }
  expect(i18n).toContain("consume real upstream tokens")
  expect(i18n).toContain("usage is recorded")
})
