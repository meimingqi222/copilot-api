import { afterEach, expect, spyOn, test } from "bun:test"

import * as browserModule from "~/services/web-login/browser"
import * as builtins from "~/services/providers/builtins"
import * as connections from "~/lib/provider-connections"
import * as utils from "~/lib/utils"
import {
  __resetWebLoginFlowsForTest,
  cancelWebLogin,
  getWebLoginFlow,
  publicWebLoginFlow,
  refreshWebLoginFlow,
  startWebLogin,
} from "~/services/web-login/flow"
import {
  getWebLoginProvider,
  isWebLoginProvider,
  WEB_LOGIN_PROVIDERS,
} from "~/services/web-login"
import type { WebLoginBrowser, WebLoginCookie } from "~/services/web-login"

function cookie(
  name: string,
  value: string,
  domain: string,
  extra: Partial<WebLoginCookie> = {},
): WebLoginCookie {
  return {
    name,
    value,
    domain,
    path: "/",
    expires: 0,
    httpOnly: false,
    secure: false,
    sameSite: "unspecified",
    ...extra,
  }
}

/** 不真起浏览器的替身：只负责给二维码和Cookie。 */
function fakeBrowser(
  cookies: Array<WebLoginCookie>,
  onClose?: () => void,
): WebLoginBrowser {
  return {
    qrImage: () => Promise.resolve("data:image/png;base64,ZmFrZQ=="),
    cookies: () => Promise.resolve(cookies),
    close: () => {
      onClose?.()
      return Promise.resolve()
    },
  }
}

let mocks: Array<{ mockRestore(): unknown }> = []

afterEach(async () => {
  for (const mock of mocks) mock.mockRestore()
  mocks = []
  await __resetWebLoginFlowsForTest()
})

function keep<T extends { mockRestore(): unknown }>(mock: T): T {
  mocks.push(mock)
  return mock
}

function stubSignInPage(page: WebLoginBrowser): void {
  keep(spyOn(browserModule, "openSignInPage").mockResolvedValue(page))
}

function stubProviderPrepare(
  result:
    | { id: string; name: string; provider: string; credentials: object }
    | { error: string },
): void {
  keep(
    spyOn(builtins, "getBuiltinProviderModule").mockReturnValue({
      accountCreation: {
        prepare: () => Promise.resolve(result),
      },
    } as never),
  )
}

function stubConnectionPersistence(): void {
  keep(
    spyOn(utils, "refreshModelsForConnection").mockResolvedValue(
      undefined as never,
    ),
  )
  keep(
    spyOn(connections, "persistProviderConnections").mockResolvedValue(
      undefined,
    ),
  )
}

test("only providers whose vendor has a web session and no OAuth offer scan sign-in", () => {
  expect(WEB_LOGIN_PROVIDERS.map((entry) => entry.provider).sort()).toEqual([
    "astudio",
    "dumate",
    "inkstone",
    "wps-lingxi",
  ])
  for (const entry of WEB_LOGIN_PROVIDERS) {
    expect(entry.loginUrl.startsWith("https://")).toBe(true)
    expect(entry.qrSelector.length).toBeGreaterThan(0)
    expect(entry.cookieDomains.length).toBeGreaterThan(0)
  }
  expect(isWebLoginProvider("dumate")).toBe(true)
  expect(isWebLoginProvider("raccoon")).toBe(false)
  expect(getWebLoginProvider("codearts")).toBeUndefined()
})

test("cookie domain matching accepts subdomains and rejects unrelated hosts", () => {
  const allowed = ["baidu.com", "bce.baidu.com"]
  expect(browserModule.cookieDomainAllowed(".baidu.com", allowed)).toBe(true)
  expect(browserModule.cookieDomainAllowed("passport.baidu.com", allowed)).toBe(
    true,
  )
  expect(
    browserModule.cookieDomainAllowed("console.bce.baidu.com", allowed),
  ).toBe(true)
  expect(
    browserModule.cookieDomainAllowed("bce.baidu.com.evil.example", allowed),
  ).toBe(false)
  expect(browserModule.cookieDomainAllowed("example.com", allowed)).toBe(false)
  expect(browserModule.cookieDomainAllowed("", allowed)).toBe(false)
})

test("astudio scan sign-in needs account_id plus a session cookie", () => {
  const config = getWebLoginProvider("astudio")
  expect(config).toBeDefined()
  if (!config) return
  expect(
    config.credentials([cookie("account_id", "acct", ".xfyun.cn")]),
  ).toBeUndefined()
  expect(
    config.credentials([cookie("ssoSessionId", "sid", ".xfyun.cn")]),
  ).toBeUndefined()
  expect(
    config.credentials([
      cookie("account_id", "acct", ".xfyun.cn"),
      cookie("ssoSessionId", "sid", ".xfyun.cn"),
      cookie("tracking", "ignored", ".xfyun.cn"),
    ]),
  ).toEqual({
    sessionCookie: "account_id=acct; ssoSessionId=sid; sso_sessionid=sid",
  })
  expect(
    config.credentials([
      cookie("account_id", "acct", ".xfyun.cn"),
      cookie("token", "tok", ".xfyun.cn"),
    ]),
  ).toEqual({ sessionCookie: "account_id=acct; token=tok" })
})

test("dumate scan sign-in waits for the console session pair", () => {
  const config = getWebLoginProvider("dumate")
  expect(config).toBeDefined()
  if (!config) return
  expect(
    config.credentials([cookie("BDUSS", "long-term", ".baidu.com")]),
  ).toBeUndefined()
  expect(
    config.credentials([
      cookie("bce-sessionid", "sess", ".bce.baidu.com"),
      cookie("bce-user-info", "info", ".bce.baidu.com"),
      cookie("BDUSS", "long-term", ".baidu.com"),
    ]),
  ).toEqual({
    cookie: "bce-sessionid=sess; bce-user-info=info; BDUSS=long-term",
  })
})

test("inkstone scan sign-in only accepts the console's own uaa-token", () => {
  const config = getWebLoginProvider("inkstone")
  expect(config).toBeDefined()
  if (!config) return
  expect(
    config.credentials([
      cookie("uaa-token", "sso-only", "sso.openxlab.org.cn"),
    ]),
  ).toBeUndefined()
  expect(
    config.credentials([
      cookie("uaa-token", "console", "discovery.intern-ai.org.cn"),
      cookie("other", "x", "sso.openxlab.org.cn"),
    ]),
  ).toEqual({ uaaToken: "console" })
  // 没有 API key 时让账号创建流程用控制台会话建一把（同意项走 settings）。
  expect(config.settings?.()).toEqual({ createApiKey: true })
})

test("wps-lingxi scan sign-in waits for wps_sid and forwards the whole jar", () => {
  const config = getWebLoginProvider("wps-lingxi")
  expect(config).toBeDefined()
  if (!config) return
  expect(config.credentials([cookie("uid", "1", ".wps.cn")])).toBeUndefined()
  expect(
    config.credentials([
      cookie("wps_sid", "sid-value", ".wps.cn"),
      cookie("uid", "1", ".wps.cn"),
    ]),
  ).toEqual({ cookie: "wps_sid=sid-value; uid=1" })
})

test("start returns a flow with the vendor QR image and one active flow per provider", async () => {
  const page = fakeBrowser([])
  stubSignInPage(page)
  const flow = await startWebLogin("dumate", { label: "搭子" })
  const publicFlow = publicWebLoginFlow(flow)
  expect(publicFlow.status).toBe("pending")
  expect(publicFlow.qrImage?.startsWith("data:image/png;base64,")).toBe(true)
  expect(publicFlow.interval).toBe(3)
  expect(publicFlow.expiresIn).toBeGreaterThan(200)
  expect(getWebLoginFlow(flow.id)?.provider).toBe("dumate")
  await expect(startWebLogin("dumate", { label: "again" })).rejects.toThrow(
    /已有登录/,
  )
  await cancelWebLogin(flow.id)
  // 取消后流程不再是 pending，互斥随之解除。
  expect(getWebLoginFlow(flow.id)?.status).toBe("cancelled")
  await expect(
    startWebLogin("dumate", { label: "again" }),
  ).resolves.toMatchObject({ status: "pending" })
})

test("poll keeps waiting until the scanned session appears, then creates the account", async () => {
  const cookies: Array<WebLoginCookie> = []
  const page = fakeBrowser(cookies)
  let opened = 0
  keep(
    spyOn(browserModule, "openSignInPage").mockImplementation(() => {
      opened += 1
      return Promise.resolve(page)
    }),
  )
  stubConnectionPersistence()
  stubProviderPrepare({
    id: "created-1",
    name: "搭子",
    provider: "dumate",
    credentials: { cookie: "bce-sessionid=sess" },
  })
  const flow = await startWebLogin("dumate", { label: "搭子" })
  expect(opened).toBe(1)

  // 没扫码：会话Cookie还没下发，继续等。
  expect((await refreshWebLoginFlow(flow.id)).status).toBe("pending")

  cookies.push(
    cookie("bce-sessionid", "sess", ".bce.baidu.com"),
    cookie("bce-user-info", "info", ".bce.baidu.com"),
  )
  const done = await refreshWebLoginFlow(flow.id)
  expect(done.status).toBe("complete")
  expect(done.accountId).toBe("created-1")
  // 兑换完成后浏览器必须关掉，不能留着进程。
  expect(done.browser).toBeUndefined()
  // 终态保留一小会儿：前端重试/第二个标签页再 poll 也拿到同一个结论。
  expect((await refreshWebLoginFlow(flow.id)).accountId).toBe("created-1")
  // 终态流程不占「该提供方已有登录」的互斥。
  await expect(
    startWebLogin("dumate", { label: "第二个" }),
  ).resolves.toMatchObject({
    provider: "dumate",
  })
})

test("the scanned session reaches prepare with the proxy and provider settings", async () => {
  const bodies: Array<Record<string, unknown>> = []
  stubSignInPage(
    fakeBrowser([cookie("uaa-token", "console", "discovery.intern-ai.org.cn")]),
  )
  stubConnectionPersistence()
  keep(
    spyOn(builtins, "getBuiltinProviderModule").mockReturnValue({
      accountCreation: {
        prepare: (context: { body: Record<string, unknown> }) => {
          bodies.push(context.body)
          return Promise.resolve({
            id: "ink-created",
            name: "端砚",
            provider: "inkstone",
            credentials: { apiKey: "sk-fixture" },
          })
        },
      },
    } as never),
  )
  const flow = await startWebLogin("inkstone", {
    label: "端砚",
    proxyUrl: "http://127.0.0.1:7890",
  })
  const done = await refreshWebLoginFlow(flow.id)
  expect(done.status).toBe("complete")
  expect(done.accountId).toBe("ink-created")
  expect(bodies).toHaveLength(1)
  // 会话本身是凭证；代理与「用会话建 key」的同意项必须走 settings——inkstone 的
  // prepare 正是从 settings 读这两个值的，放错地方会被静默忽略。
  expect(bodies[0].credentials).toEqual({ uaaToken: "console" })
  expect(bodies[0].settings).toEqual({
    proxyUrl: "http://127.0.0.1:7890",
    createApiKey: true,
  })
})

test("a rejected session settles as an error instead of retrying the vendor call", async () => {
  let closed = 0
  stubSignInPage(
    fakeBrowser(
      [
        cookie("bce-sessionid", "sess", ".bce.baidu.com"),
        cookie("bce-user-info", "info", ".bce.baidu.com"),
      ],
      () => {
        closed += 1
      },
    ),
  )
  stubConnectionPersistence()
  let prepares = 0
  keep(
    spyOn(builtins, "getBuiltinProviderModule").mockReturnValue({
      accountCreation: {
        prepare: () => {
          prepares += 1
          return Promise.resolve({
            error: "DuMate rejected the console session",
          })
        },
      },
    } as never),
  )
  const flow = await startWebLogin("dumate", { label: "搭子" })
  const settled = await refreshWebLoginFlow(flow.id)
  expect(settled.status).toBe("error")
  expect(settled.error).toContain("rejected")
  // InkStone 这类提供方的 prepare 会在厂商侧建 key，失败绝不能重试。
  expect(prepares).toBe(1)
  expect(closed).toBe(1)
  expect((await refreshWebLoginFlow(flow.id)).status).toBe("error")
})

test("a QR that never renders ends the flow with a readable reason", async () => {
  keep(
    spyOn(browserModule, "openSignInPage").mockRejectedValue(
      new Error("二维码加载超时，请重试"),
    ),
  )
  await expect(startWebLogin("astudio", { label: "讯飞" })).rejects.toThrow(
    /二维码加载超时/,
  )
})

test("cancelling a flow closes its browser", async () => {
  let closed = 0
  stubSignInPage(fakeBrowser([], () => (closed += 1)))
  const flow = await startWebLogin("wps-lingxi", { label: "灵犀" })
  await cancelWebLogin(flow.id)
  expect(closed).toBe(1)
  expect(publicWebLoginFlow(getWebLoginFlow(flow.id) ?? flow).status).toBe(
    "cancelled",
  )
})

// ── 路由层 ───────────────────────────────────────────────────────────

import { webLoginApiRoutes } from "~/routes/admin/api/web-login"

// ── 二维码就绪判据 ────────────────────────────────────────────────

import { qrBoxExpression } from "~/services/web-login/browser"

test("the QR readiness expression embeds the selector, hint and self-check", () => {
  // 这三条都是实测踩出来的：选择器常常直接指向二维码那张图（要把元素自身也算
  // 候选）、src 必须带关键字（占位图和二维码一样大）、clip 要换算成页面坐标
  // （scrollIntoView 之后视口坐标会偏）。少任何一条都会截到 loading 图。
  const expression = qrBoxExpression(".sso-qrcode img", 120, "qrcode")
  expect(expression).toContain('document.querySelector(".sso-qrcode img")')
  expect(expression).toContain('"qrcode"')
  expect(expression).toContain("el.tagName === 'IMG'")
  expect(expression).toContain("box.x + window.scrollX")
  expect(expression).toContain("box.y + window.scrollY")
  // iframe 容器（书生·端砚）不能要求页面上有 img， readiness 由 frame 判定。
  expect(expression).toContain("frameSrc")
})

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

test("the route rejects providers that have no scan sign-in", async () => {
  const response = await webLoginApiRoutes.request("/raccoon/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "x" }),
  })
  expect(response.status).toBe(400)
  expect((await json(response)).error).toContain("raccoon")
})

test("start returns the QR image and poll/cancel drive the flow", async () => {
  const page = fakeBrowser([
    cookie("wps_sid", "sid-value", ".wps.cn"),
    cookie("uid", "1", ".wps.cn"),
  ])
  stubSignInPage(page)
  stubConnectionPersistence()
  stubProviderPrepare({
    id: "wps-created",
    name: "灵犀",
    provider: "wps-lingxi",
    credentials: { cookie: "wps_sid=sid-value" },
  })

  const started = await webLoginApiRoutes.request("/wps-lingxi/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "灵犀" }),
  })
  expect(started.status).toBe(200)
  const start = await json(started)
  expect(start.ok).toBe(true)
  expect(String(start.qrImage).startsWith("data:image/png;base64,")).toBe(true)
  expect(start.provider).toBe("wps-lingxi")

  const polled = await webLoginApiRoutes.request(
    `/wps-lingxi/poll/${start.flowId}`,
  )
  expect(polled.status).toBe(200)
  const poll = await json(polled)
  expect(poll.status).toBe("complete")
  expect(poll.accountId).toBe("wps-created")
  expect((poll.account as { id?: string })?.id).toBe("wps-created")

  const cancelled = await webLoginApiRoutes.request("/wps-lingxi/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId: "missing" }),
  })
  expect(cancelled.status).toBe(404)
})

test("an unknown flow id reports expired instead of hanging the UI", async () => {
  const response = await webLoginApiRoutes.request("/dumate/poll/not-a-flow")
  expect(response.status).toBe(404)
  expect((await json(response)).status).toBe("expired")
})
