import type { WebLoginProvider } from "../types"

/**
 * 科大讯飞 AStudio（ Astron Studio ）：通行证微信扫码。
 *
 * 页面依据（2026-11-21 本机只读实测）：`passport.xfyun.cn/login` 默认展示
 * 微信扫码，二维码是 `.sso-qrcode img`（src 指向
 * `mp.weixin.qq.com/cgi-bin/showqrcode`，430×430）。扫码成功后通行证把流程
 * 带去 `agent.xfyun.cn`，会话Cookie落在 `.xfyun.cn` 一族。
 *
 * 会话形状与客户端 `buildAstronCookieHeader()` 一致：`account_id` +
 * `ssoSessionId`（或 `token`）。缺 `account_id` 服务端一定拒，所以这两个
 * 就是「扫码成功」的判据；模型 bearer 由 `studioAccountCreation` 用这组
 * Cookie 现换（`auth/bearer-token`），不需要用户再粘一个 token。
 */
const LOGIN_URL = "https://passport.xfyun.cn/login"
const QR_SELECTOR = ".sso-qrcode img"
const COOKIE_DOMAINS = ["xfyun.cn"] as const

function valueOf(
  cookies: ReadonlyArray<{ name: string; value: string }>,
  name: string,
): string {
  return cookies.find((cookie) => cookie.name === name)?.value ?? ""
}

export const astudioWebLogin: WebLoginProvider = {
  provider: "astudio",
  loginUrl: LOGIN_URL,
  qrSelector: QR_SELECTOR,
  qrMinSize: 120,
  cookieDomains: COOKIE_DOMAINS,
  credentials(cookies) {
    const accountId = valueOf(cookies, "account_id")
    const sessionToken = valueOf(cookies, "token")
    const ssoSessionId =
      valueOf(cookies, "ssoSessionId") || valueOf(cookies, "sso_sessionid")
    if (!accountId || (!sessionToken && !ssoSessionId)) return undefined
    const header = [
      `account_id=${accountId}`,
      ...(sessionToken ? [`token=${sessionToken}`] : []),
      ...(ssoSessionId ?
        [`ssoSessionId=${ssoSessionId}`, `sso_sessionid=${ssoSessionId}`]
      : []),
    ].join("; ")
    return { sessionCookie: header }
  },
}
