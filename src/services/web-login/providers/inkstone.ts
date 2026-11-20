import type { WebLoginProvider } from "../types"

/**
 * 书生·端砚（InkStone）：OpenXLab 统一登录的微信扫码，拿 `uaa-token`。
 *
 * 页面依据（2026-11-21 本机只读实测）：控制台的 SSO 入口
 * `sso.openxlab.org.cn/authentication?clientId=…&redirect=<控制台>` 会 302 到
 * `/wechat`，二维码是 `#qrlogin_container` 里的微信 iframe
 * （`open.weixin.qq.com/connect/qrconnect`，容器 188×188、iframe 300×400）。
 * 因为二维码在跨域 iframe 里，就绪判据只能看容器与 iframe 的盒子尺寸。
 *
 * 扫码成功后 SSO 把流程带回 `redirect` 指向的控制台，`uaa-token` 由
 * `discovery.intern-ai.org.cn` 下发——所以 `redirect` 必须是控制台地址，
 * 换成别的域名等于登录完拿不到会话。模型 API key 由 inkstone 的
 * accountCreation 按需创建（`createApiKey`），不在这里换。
 */
const CONSOLE_HOME = "https://discovery.intern-ai.org.cn/token-plan/home"
const LOGIN_URL =
  "https://sso.openxlab.org.cn/authentication"
  + "?clientId=dagw07mkg1bazlxzoy31&lang=zh-CN"
  + `&redirect=${encodeURIComponent(CONSOLE_HOME)}`
  + "&source=discovery"
const QR_SELECTOR = "#qrlogin_container"
const COOKIE_DOMAINS = ["intern-ai.org.cn", "openxlab.org.cn"] as const

export const inkstoneWebLogin: WebLoginProvider = {
  provider: "inkstone",
  loginUrl: LOGIN_URL,
  qrSelector: QR_SELECTOR,
  qrMinSize: 120,
  cookieDomains: COOKIE_DOMAINS,
  credentials(cookies) {
    const token = cookies.find(
      (cookie) =>
        cookie.name === "uaa-token"
        && cookie.domain.toLowerCase().replace(/^\./, "")
          === "discovery.intern-ai.org.cn",
    )?.value
    return token ? { uaaToken: token } : undefined
  },
  // 没有 API key 时用控制台会话建一把：账号创建流程自己会查重、不删旧的，
  // 建出来的 key 才是这个连接的主凭证（primaryKey 就是 apiKey）。
  settings: () => ({ createApiKey: true }),
}
