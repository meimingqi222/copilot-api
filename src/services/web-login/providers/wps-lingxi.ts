import type { WebLoginProvider } from "../types"

/**
 * WPS 灵犀：金山办公账号的微信扫码，拿 `wps_sid`。
 *
 * 页面依据（2026-11-21 本机只读实测）：登录页
 * `account.wps.cn/?protocolnames=lingxi_privacy,lingxi_agreements&cb=<业务页>`
 * （protocolnames 是必带的隐私协议清单，cb 是登录成功后的回跳地址），默认展示
 * 微信扫码，二维码是 `.qrcode_img img`（src 指向 `qrcode.qwps.cn`，430×430，
 * 直接就位、没有占位图阶段）。
 *
 * 成功判据是「`wps_sid` 已下发」而不是 URL：没绑手机的账号扫码后会停在
 * 「绑定手机」页，URL 永远到不了 cb 指向的业务页，但那时控制台会话已经可用。
 * 整组 `wps.cn` Cookie 一并交给 lingxi 的 accountCreation 校验。
 */
const BUSINESS_PAGE = "https://lingxi.wps.cn/_desktop/lingxi/index.html"
const LOGIN_URL =
  "https://account.wps.cn/?protocolnames=lingxi_privacy,lingxi_agreements"
  + `&cb=${encodeURIComponent(BUSINESS_PAGE)}`
const QR_SELECTOR = ".qrcode_img img"
const COOKIE_DOMAINS = ["wps.cn"] as const

export const wpsLingxiWebLogin: WebLoginProvider = {
  provider: "wps-lingxi",
  loginUrl: LOGIN_URL,
  qrSelector: QR_SELECTOR,
  qrMinSize: 120,
  cookieDomains: COOKIE_DOMAINS,
  credentials(cookies) {
    const sid = cookies.find((cookie) => cookie.name === "wps_sid")?.value
    if (!sid) return undefined
    return {
      cookie: cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; "),
    }
  },
}
