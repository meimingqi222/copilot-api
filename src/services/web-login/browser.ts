/**
 * 内置网页登录（扫码登录）用的临时无头浏览器。
 *
 * 复用 zcode 的 Chromium 定位/安装与极简 CDP 客户端：那里已经解决「服务器上
 * 没有 Chrome 时怎么办」（环境变量 → 安装记录 → 系统路径 → 下载 Chrome for
 * Testing），扫码登录没有理由再养一套浏览器管理层。
 *
 * 与签到的出站策略保持一致：CDP 走本机回环，页面请求由 Chrome 自己发；连接级
 * 代理由各 provider 的 `accountCreation.prepare` 在兑换会话时负责。
 */
import { launchChrome, evaluatePage } from "~/services/zcode/cdp"
import { ensureZcodeBrowser } from "~/services/zcode/browser"

import { logger } from "~/lib/logger"
import type { WebLoginBrowser, WebLoginCookie } from "./types"

/** 同一时刻只开一个登录浏览器：多用户同时点登录要明确失败，不能各起一个。 */
let openBrowsers = 0

/**
 * 跨域 iframe（微信二维码）的 CDP session：targetId → sessionId。
 *
 * `open.weixin.qq.com` 的 iframe 是独立进程（OOPIF），它自己的网络事件只发到
 * 它自己的 session 上。登录码那一次回跳就发生在这一层（SSO 的 redirect_uri
 * 指回 sso.openxlab.org.cn/wechat），只监听页面 session 会把登录码整段漏掉。
 * attach 只做一次：同一 target 重复 attach 会拿到两个 session，两边都开 Fetch
 * 就会把同一个请求暂停两次（只 respond 一次，页面直接挂住）。
 */
const frameSessions = new Map<string, string>()

/** 当前登录流程的拦截解绑器；浏览器关闭时调用，避免监听泄漏到下个流程。 */
let detachInterceptors: (() => void) | null = null

/** 页面加载 + 二维码渲染的等待上限（毫秒）。 */
const QR_TIMEOUT_MS = 60_000
/** 二维码就绪轮询间隔（毫秒）。 */
const QR_POLL_MS = 300
/** 截图外扩的白边（像素）：二维码需要静区才能扫。 */
const QR_PAD_PX = 12
/** 截图为空白时的兜底门槛（base64 字符数）：真二维码远大于这个体积。 */
const MIN_QR_PNG_CHARS = 2_000

interface QrBox {
  x: number
  y: number
  width: number
  height: number
  /** 容器里的 iframe 地址（微信二维码这类跨域场景）。 */
  frameSrc: string
}

/**
 * 二维码盒子判据（页面里执行）。
 *
 * 要在一堆图里挑出**真的二维码**：百度通行证的登录页先放一张 loading 占位图
 * （尺寸和二维码一样大），只判「有图且加载完了」会把占位图截给用户，所以还要
 * 求 URL 里带关键字（HINT）。容器里嵌 iframe 的（书生·端砚的微信二维码来自
 * open.weixin.qq.com）盒子尺寸够不算就绪——iframe 内部是跨域的，要另开 CDP
 * session 去看（见 frameQrReady）。
 */
const QR_BOX_BODY = `{
  const el = document.querySelector(SELECTOR);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  if (box.width < MIN || box.height < MIN) return null;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return null;
  const hint = HINT.toLowerCase();
  // 选择器可能直接指向二维码那张图（讯飞/WPS/百度都是），也可能指向容器
  // （书生·端砚的 iframe 容器）——两种都要能找到候选图。
  const imgs = el.tagName === 'IMG'
    ? [el, ...el.querySelectorAll('img')]
    : [...el.querySelectorAll('img')];
  const frame = el.querySelector('iframe');
  let frameSrc = '';
  if (frame) {
    const inner = frame.getBoundingClientRect();
    if (inner.width < MIN || inner.height < MIN) return null;
    frameSrc = frame.src || '';
  }
  // 没有 iframe 就必须有一张真二维码图：空容器和 loading 占位图都不算就绪
  // （讯飞/百度的登录页都是先渲染容器再换二维码 src）。
  if (!frameSrc) {
    const qr = imgs.find((img) => {
      const src = (img.currentSrc || img.src || '').toLowerCase();
      return src.indexOf(hint) !== -1 && img.complete && img.naturalWidth >= MIN;
    });
    if (!qr) return null;
  }
  return { x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height, frameSrc };
}`

/** CDP 的 evaluate 不接受额外参数，选择器与阈值只能写进表达式。 */
export function qrBoxExpression(
  selector: string,
  minSize: number,
  srcHint: string,
): string {
  return `(() => ${QR_BOX_BODY.replaceAll("SELECTOR", JSON.stringify(selector))
    .replaceAll("MIN", String(minSize))
    .replaceAll("HINT", JSON.stringify(srcHint))})()`
}

/**
 * iframe 内部「有一张够大的二维码图」——微信二维码的就绪判据。
 *
 * 只说「有图」会判早：微信登录页里还有一张 136×136 的默认头像 SVG，尺寸过线但
 * 不是二维码，扫不了；真正的二维码是 `open.weixin.qq.com/connect/qrcode/<id>`。
 * 所以必须连带 src 关键字一起判（和主文档里的 `HINT` 同一个口径）。判早了截出来
 * 就是个白框——2026-11-21 线上实测。
 */
const FRAME_QR_BODY = `(() => {
  const hint = HINT.toLowerCase();
  const img = [...document.images].find((item) => {
    const src = (item.currentSrc || item.src || '').toLowerCase();
    return item.complete
      && item.naturalWidth >= MIN
      && item.naturalHeight >= MIN
      && src.indexOf(hint) !== -1;
  });
  return Boolean(img);
})()`

export function frameQrExpression(minSize: number, srcHint: string): string {
  return FRAME_QR_BODY.replaceAll("MIN", String(minSize)).replaceAll(
    "HINT",
    JSON.stringify(srcHint),
  )
}

function scrollExpression(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' })`
}

/**
 * 找到二维码 iframe 的 CDP session 并等它渲染出二维码。
 *
 * iframe 是跨域的（微信开放平台），页面里读不到它的加载状态，但 CDP 不受
 * 同源策略限制：`Target.setDiscoverTargets` 之后 iframe 会出现在
 * `Target.getTargets` 里，attach 上去就能在它内部求值。session 只建一次，
 * 之后每轮复用——每轮都 attach 会堆积 session。
 */
async function frameQrReady(
  browser: Awaited<ReturnType<typeof launchChrome>>,
  frameSrc: string,
  minSize: number,
  srcHint: string,
  cached: { sessionId?: string },
): Promise<boolean> {
  if (!frameSrc) return true
  let sessionId = cached.sessionId
  if (!sessionId) {
    const targets = await browser.send("Target.getTargets")
    const infos = Array.isArray(targets.targetInfos) ? targets.targetInfos : []
    let origin = ""
    try {
      origin = new URL(frameSrc).origin
    } catch {
      return false
    }
    const target = infos.find(
      (info) =>
        info.type === "iframe" && String(info.url ?? "").startsWith(origin),
    )
    if (!target || typeof target.targetId !== "string") return false
    const known = frameSessions.get(target.targetId)
    if (known) {
      sessionId = known
      cached.sessionId = known
      const ready = await evaluatePage(
        browser,
        frameQrExpression(minSize, srcHint),
        { sessionId, timeoutMs: 8000 },
      ).catch(() => false)
      return ready === true
    }
    const attached = await browser.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })
    if (typeof attached.sessionId !== "string") return false
    sessionId = attached.sessionId
    cached.sessionId = sessionId
    frameSessions.set(target.targetId, sessionId)
  }
  const ready = await evaluatePage(
    browser,
    frameQrExpression(minSize, srcHint),
    {
      sessionId,
      timeoutMs: 8000,
    },
  ).catch(() => false)
  return ready === true
}

/** 等二维码元素就绪并返回它的视口坐标。 */
async function waitForQr(
  browser: Awaited<ReturnType<typeof launchChrome>>,
  sessionId: string,
  selector: string,
  minSize: number,
  srcHint: string,
): Promise<QrBox> {
  const deadline = Date.now() + QR_TIMEOUT_MS
  const expression = qrBoxExpression(selector, minSize, srcHint)
  const frame: { sessionId?: string } = {}
  const readBox = () =>
    evaluatePage(browser, expression, {
      sessionId,
      timeoutMs: 10_000,
    }) as Promise<QrBox | null>
  for (;;) {
    const box = await readBox()
    if (box && box.width > 0 && box.height > 0) {
      // 容器里嵌 iframe 时，盒子尺寸够不代表二维码画完了（书生·端砚实测：
      // 早 1 秒截出来是白框），必须等 iframe 内部出现够大的图。
      if (await frameQrReady(browser, box.frameSrc, minSize, srcHint, frame)) {
        // 滚到视口中央再截：CDP 的 clip 用页面坐标，元素在视口外会截到空白。
        await evaluatePage(browser, scrollExpression(selector), {
          sessionId,
          timeoutMs: 10_000,
        })
        return (await readBox()) ?? box
      }
    }
    if (Date.now() >= deadline) {
      throw new Error("二维码加载超时，请重试")
    }
    await new Promise((resolve) => setTimeout(resolve, QR_POLL_MS))
  }
}

/** CDP 的 cookie 形状 → 本模块的形状（只留要用的字段）。 */
function toCookie(raw: unknown): WebLoginCookie | undefined {
  const item = raw as Record<string, unknown> | undefined
  const name = typeof item?.name === "string" ? item.name : ""
  const value = typeof item?.value === "string" ? item.value : ""
  const domain = typeof item?.domain === "string" ? item.domain : ""
  if (!name || !value || !domain) return undefined
  return {
    name,
    value,
    domain,
    path: typeof item?.path === "string" ? item.path : "/",
    expires: typeof item?.expires === "number" ? item.expires : 0,
    httpOnly: item?.httpOnly === true,
    secure: item?.secure === true,
    sameSite:
      typeof item?.sameSite === "string" ? item.sameSite : "unspecified",
  }
}

/** 域名后缀匹配：`.baidu.com` 与 `baidu.com` 等价，子域算命中。 */
export function cookieDomainAllowed(
  domain: string,
  allowed: ReadonlyArray<string>,
): boolean {
  const host = domain.trim().toLowerCase().replace(/^\./, "")
  if (!host) return false
  return allowed.some((entry) => {
    const suffix = entry.trim().toLowerCase().replace(/^\./, "")
    return host === suffix || host.endsWith(`.${suffix}`)
  })
}

interface OpenSignInPageOptions {
  url: string
  qrSelector: string
  qrSrcHint?: string
  qrMinSize?: number
  cookieDomains: ReadonlyArray<string>
  /**
   * 回跳登录码判据（书生·端砚这类「落地页会烧掉一次性 code」的提供方）。
   * 传了就在导航后立即开启文档导航拦截：命中判据的导航记下 code 并
   * fail 掉，其余放行。
   */
  captureCode?: (url: string) => string | null
}

/** 只留 origin + path，query 只留键名：登录码不能进日志。 */
function describeUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    const keys = [...parsed.searchParams.keys()]
    return `${parsed.origin}${parsed.pathname}${
      keys.length ? `?[${keys.join(",")}]` : ""
    }`
  } catch {
    return "<invalid url>"
  }
}

/** 拦截用的 Fetch 模式：只暂停**文档导航**，子资源照常流，不添延迟。 */
const FETCH_DOCUMENT_PATTERNS = [
  { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
]

/**
 * 开启文档导航拦截，命中 `captureCode` 的导航记下 code 并 abort。
 *
 * 桌面端（inkstone 的 ExternalAuthOverlay）对带 code 的那次导航
 * `preventDefault()`：console 是个 SPA，它自己会拿 code 去兑换，而我们
 * 也要用同一个 code 换令牌——兑换大概率一次性，让它加载就等于烧掉 code。
 * CDP 侧在请求阶段拦（比 Playwright 的 framenavigated 更早），
 * `Fetch.failRequest` 等价于那次 preventDefault。
 *
 * 每个被暂停的请求都必须 continue 或 fail，否则页面会挂住。
 */
async function interceptLoginCode(
  browser: Awaited<ReturnType<typeof launchChrome>>,
  sessionId: string,
  captureCode: (url: string) => string | null,
): Promise<() => string | null> {
  let code: string | null = null
  const stop: Array<() => void> = []
  const armed = new Set<string>()

  const take = (url: string): boolean => {
    if (code) return false
    const captured = captureCode(url)
    if (!captured) return false
    code = captured
    return true
  }

  /** 给一个 CDP session 武装拦截：Fetch 负责 abort，Network 只做兜底捕获。 */
  const arm = async (target: string, where: string) => {
    if (armed.has(target)) return
    armed.add(target)
    try {
      await browser.send(
        "Fetch.enable",
        { patterns: FETCH_DOCUMENT_PATTERNS },
        target,
      )
      logger.info(`[web-login] 导航拦截已开启：${where}`)
    } catch (error) {
      logger.warn(
        `[web-login] 导航拦截开启失败（${where}）: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    await browser.send("Network.enable", {}, target).catch(() => undefined)
  }

  stop.push(
    browser.onEvent("Fetch.requestPaused", (params, eventSessionId) => {
      const requestId =
        typeof params.requestId === "string" ? params.requestId : ""
      const request = (params.request ?? {}) as { url?: unknown }
      const url = typeof request.url === "string" ? request.url : ""
      const respond = (method: string, extra: Record<string, unknown> = {}) => {
        if (!requestId) return
        void browser
          .send(method, { requestId, ...extra }, eventSessionId ?? sessionId)
          .catch(() => undefined)
      }
      logger.info(`[web-login] 文档导航: ${describeUrl(url)}`)
      if (!code && take(url)) {
        logger.info("[web-login] 已拦截回跳登录码，阻止落地页加载")
        respond("Fetch.failRequest", { errorReason: "Aborted" })
        return
      }
      respond("Fetch.continueRequest")
    }),
  )

  // 兜底一：任何 session（含跨域 iframe）发出的请求里带登录码就记下来。
  // Fetch 的暂停事件只回给武装过的那层 session，漏掉时这里是第二道网。
  stop.push(
    browser.onEvent("Network.requestWillBeSent", (params) => {
      const request = (params.request ?? {}) as { url?: unknown }
      const url = typeof request.url === "string" ? request.url : ""
      if (url && take(url)) {
        logger.info("[web-login] 从网络请求里捕获到回跳登录码")
      }
    }),
  )
  // 兜底二：帧导航（iframe 内的回跳不会改顶层 URL）。
  stop.push(
    browser.onEvent("Page.frameNavigated", (params) => {
      const frame = (params.frame ?? {}) as { url?: unknown }
      const url = typeof frame.url === "string" ? frame.url : ""
      if (url && take(url)) {
        logger.info("[web-login] 从帧导航里捕获到回跳登录码")
      }
    }),
  )
  // 跨域 iframe 是独立 target（OOPIF），它的请求不经过页面 session。
  // 自动 attach 之后同样的 Fetch 拦截才能在 iframe 里生效。
  stop.push(
    browser.onEvent("Target.attachedToTarget", (params) => {
      const child = typeof params.sessionId === "string" ? params.sessionId : ""
      if (!child) return
      const info = (params.targetInfo ?? {}) as {
        type?: unknown
        targetId?: unknown
      }
      const targetId = typeof info.targetId === "string" ? info.targetId : ""
      if (targetId) frameSessions.set(targetId, child)
      void arm(child, `auto:${String(info.type ?? "target")}`)
    }),
  )
  try {
    await browser.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    )
  } catch (error) {
    logger.warn(
      `[web-login] iframe 自动 attach 失败，只监听页面 session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  await arm(sessionId, "page")

  // ⚠️ 不能在这里返回「读一次就退订」的闭包：轮询每 3 秒读一次，
  // 第一次读就会把拦截拆掉，等用户真扫码时早已无人值守（线上实测
  // 表现为「扫码成功但服务端一直停在二维码」）。监听活到浏览器关闭。
  detachInterceptors = () => {
    for (const unsubscribe of stop) unsubscribe()
  }
  return () => code
}

/**
 * 打开登录页并等到二维码可截屏。返回的句柄在登录流程结束后必须 `close()`。
 */
export async function openSignInPage(
  options: OpenSignInPageOptions,
): Promise<WebLoginBrowser> {
  if (openBrowsers > 0) {
    throw new Error("另一个账号正在扫码登录，请先完成或取消它")
  }
  const executablePath = await ensureZcodeBrowser()
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined
  try {
    browser = await launchChrome({
      executablePath,
      args: ["--window-size=1280,860"],
    })
    openBrowsers += 1
    const sessionId = await browser.newPage()
    await browser.send("Page.enable", {}, sessionId)
    // 让 Chrome 把 iframe 也报进 Target.getTargets：跨域二维码（微信）只能
    // 靠 attach 到 iframe 才知道它画没画完。
    await browser.send("Target.setDiscoverTargets", { discover: true })
    // Network.getAllCookies 是页面域命令：必须先在该 session 上启用 Network，
    // 否则 Chrome 回 "wasn't found"（-32601）。
    await browser.send("Network.enable", {}, sessionId)
    await browser.send("Page.navigate", { url: options.url }, sessionId)
    const live = browser
    // 拦截型 provider（书生·端砚）：导航后立即武装文档导航拦截。SSO 自己的
    // 重定向链会被暂停后放行（不带登录码），只有命中判据的那次才 fail——
    // 扫码要几秒到几分钟，没必要（也不可能）等到二维码就绪再开。开启失败
    // 不拦登录：Cookie 那条路仍然有效（落地页加载了，Cookie 会来）。
    let readCode: (() => string | null) | null = null
    if (options.captureCode) {
      try {
        readCode = await interceptLoginCode(
          live,
          sessionId,
          options.captureCode,
        )
      } catch (error) {
        logger.warn(
          `[web-login] 回跳登录码拦截开启失败，退回 Cookie 轮询: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
    return {
      qrImage: async () => {
        const minSize = options.qrMinSize ?? 120
        const srcHint = options.qrSrcHint ?? "qrcode"
        const deadline = Date.now() + QR_TIMEOUT_MS
        for (;;) {
          const box = await waitForQr(
            live,
            sessionId,
            options.qrSelector,
            minSize,
            srcHint,
          )
          // 截的时候往外放一圈白边：微信二维码图本身没有静区（quiet zone），
          // 容器又是紧贴 iframe 裁的，边缘不留白扫不出来。
          const pad = QR_PAD_PX
          const shot = await live.send(
            "Page.captureScreenshot",
            {
              format: "png",
              captureBeyondViewport: false,
              clip: {
                x: Math.max(0, box.x - pad),
                y: Math.max(0, box.y - pad),
                width: box.width + pad * 2,
                height: box.height + pad * 2,
                scale: 1,
              },
            },
            sessionId,
          )
          const data = typeof shot.data === "string" ? shot.data : ""
          // 就绪判据过了、截出来还是白框：跨域 iframe 的图层合成比 DOM 慢一拍。
          // 空白 168×168 PNG 只有几百字节，真二维码几 KB 起步——按体积兜底重截，
          // 宁可多等 0.4 秒，也不能把白框甩给用户（2026-11-21 线上实测）。
          if (data.length >= MIN_QR_PNG_CHARS) {
            return `data:image/png;base64,${data}`
          }
          if (Date.now() >= deadline) {
            throw new Error("二维码截图失败，请重试")
          }
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
      },
      cookies: async () => {
        const result = await live.send("Network.getAllCookies", {}, sessionId)
        const list = Array.isArray(result.cookies) ? result.cookies : []
        return list
          .map(toCookie)
          .filter(
            (cookie): cookie is WebLoginCookie =>
              cookie !== undefined
              && cookieDomainAllowed(cookie.domain, options.cookieDomains),
          )
      },
      code: () => readCode?.() ?? null,
      pageUrl: async () => {
        const current = await evaluatePage(live, "location.href", {
          sessionId,
          timeoutMs: 5_000,
        }).catch(() => "")
        return typeof current === "string" ? current : ""
      },
      close: async () => {
        detachInterceptors?.()
        detachInterceptors = null
        frameSessions.clear()
        openBrowsers = Math.max(0, openBrowsers - 1)
        await live.close().catch(() => undefined)
      },
    }
  } catch (error) {
    await browser?.close().catch(() => undefined)
    throw error
  }
}
