/**
 * 账号页"代理 URL"编辑入口的回归测试。
 *
 * 账号型连接**不在**端点连接页面里出现（该页显式过滤
 * `isAccountManagedConnection`），此前创建之后就没有任何 UI 入口能改代理：
 * 后端 `account-update` 早就接受 `settings.proxyUrl`，缺的是前端。这里用 vm
 * 直接跑 `pages/js/views/accounts.js`，断言保存走的是 `API.accounts.update`
 * 且把 proxyUrl 放进 settings；空串是"清除/跟随默认"语义。
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const PROXY = "http://127.0.0.1:18090"

interface UpdateRequest {
  id: string
  payload: Record<string, unknown>
}

interface AccountsView {
  saveAccountProxyUrl(
    account: Record<string, unknown>,
    value: string,
  ): Promise<void>
}

function createView(requests: Array<UpdateRequest>): AccountsView {
  const view = runInNewContext(
    readFileSync("pages/js/views/accounts.js", "utf8") + "\naccountsView()",
    {
      ViewHelpers: {},
      I18n: { t: (key: string) => key },
      API: {
        accounts: {
          update: (id: string, payload: Record<string, unknown>) => {
            requests.push({ id, payload })
            const settings = (payload?.settings ?? {}) as Record<
              string,
              unknown
            >
            const sent = String(settings.proxyUrl ?? "")
            return Promise.resolve({
              account: {
                id,
                settings: { ...settings },
                proxyUrl: sent === "" ? null : sent,
              },
            })
          },
        },
      },
    },
  ) as AccountsView & { showToast: () => void }
  view.showToast = () => undefined
  return view
}

test("saving sends settings.proxyUrl for that account", async () => {
  const requests: Array<UpdateRequest> = []
  const view = createView(requests)
  const account: Record<string, unknown> = { id: "acc-1", settings: {} }

  await view.saveAccountProxyUrl(account, `  ${PROXY}  `)

  expect(requests.length).toBe(1)
  expect(requests[0]?.id).toBe("acc-1")
  expect(
    (requests[0]?.payload.settings as Record<string, unknown>).proxyUrl,
  ).toBe(PROXY)
  // 行内回显跟着更新（trim 后写入）
  expect(account.proxyUrl).toBe(PROXY)
})

test("an emptied field clears the proxy so the system default applies", async () => {
  const requests: Array<UpdateRequest> = []
  const view = createView(requests)
  const account: Record<string, unknown> = {
    id: "acc-1",
    settings: { proxyUrl: PROXY },
    proxyUrl: PROXY,
  }

  await view.saveAccountProxyUrl(account, "   ")

  expect(
    (requests[0]?.payload.settings as Record<string, unknown>).proxyUrl,
  ).toBe("")
  expect(account.proxyUrl).toBeNull()
})
