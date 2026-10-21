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
      readFileSync(join(ROOT, "pages/js/views/accounts.js"), "utf8")
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
