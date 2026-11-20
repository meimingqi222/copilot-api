import type { WebLoginProvider } from "../types"

/**
 * 百度搭子（DuMate）：百度通行证扫码，拿控制台会话Cookie。
 *
 * 页面依据（2026-11-21 本机只读实测）：`login.bce.baidu.com/?from=oa_dumate&
 * redirect=<console>` 默认展示扫码，二维码是 `img.tang-pass-qrcode-img`
 * （src 指向 `passport.baidu.com/v2/api/qrcode`，265×265）。扫码成功后跳回
 * 控制台，`bce-sessionid` / `bce-user-info` 由 `.bce.baidu.com` 下发。
 *
 * 判据取这两个Cookie：控制台接口真正校验的就是它们（只有 `BDUSS` 会被 302
 * 回登录页）。整组Cookie一并交给 `duMate` 的 accountCreation 校验，缺失时
 * 继续等——扫码后会话是异步下发的，早一步会读到空会话。
 */
const LOGIN_URL =
  "https://login.bce.baidu.com/?from=oa_dumate&redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F"
const QR_SELECTOR = "img.tang-pass-qrcode-img"
const COOKIE_DOMAINS = ["baidu.com", "bce.baidu.com"] as const

export const dumateWebLogin: WebLoginProvider = {
  provider: "dumate",
  loginUrl: LOGIN_URL,
  qrSelector: QR_SELECTOR,
  qrMinSize: 120,
  cookieDomains: COOKIE_DOMAINS,
  credentials(cookies) {
    const names = new Set(cookies.map((cookie) => cookie.name))
    if (!names.has("bce-sessionid") || !names.has("bce-user-info")) {
      return undefined
    }
    return {
      cookie: cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; "),
    }
  },
}
