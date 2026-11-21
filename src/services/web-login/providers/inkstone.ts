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
 * 会话有两条路，主路径是**登录码兑换**（2026-11-22 加）：
 *
 * 1. 扫码后 SSO 把流程带回 `redirect` 指向的控制台，query 带
 *    `code=uaa::code::...`；服务端拦下这次文档导航（不让控制台 SPA 加载），
 *    自己 `POST /api/user-center/v1/users/auth` 换出 JWT。桌面端
 *    （inkstone 0.2.13 的 `AuthApiClient.exchangeCode`）走的就是这条，
 *    换到的 JWT 就是控制台 `uaa-token` Cookie 的同一个值。
 *    ⚠️ 必须拦：console 是个 SPA，落地后会自己消费 code 再路由走（线上实测
 *    落点 `/chat`），兑换大概率一次性——让它加载等于烧掉我们的 code，
 *    纯轮询 `page.url` 也会把登录码整段错过。
 * 2. 兜底是等 `uaa-token` Cookie 下发（拦截没开成 / 回跳弹了新窗口时）。
 *
 * 模型 API key 由 inkstone 的 accountCreation 按需创建（`createApiKey`），
 * 不在这里换。
 */
const CONSOLE_HOME = "https://discovery.intern-ai.org.cn/token-plan/home"
const LOGIN_URL =
  "https://sso.openxlab.org.cn/authentication"
  + "?clientId=dagw07mkg1bazlxzoy31&lang=zh-CN"
  + `&redirect=${encodeURIComponent(CONSOLE_HOME)}`
  + "&source=discovery"
const QR_SELECTOR = "#qrlogin_container"
const COOKIE_DOMAINS = ["intern-ai.org.cn", "openxlab.org.cn"] as const

/** 登录码前缀与兑换端点（桌面端常量 `uaa::code::` / `/users/auth`）。 */
const CODE_PREFIX = "uaa::code::"
const CONSOLE_ORIGIN = "https://discovery.intern-ai.org.cn"
const AUTH_API = `${CONSOLE_ORIGIN}/api/user-center/v1`

/**
 * 回跳登录码判据（依据同桌面端 `readSsoCallbackCode()`）。
 *
 * origin 必须是 console、`code` 只能有一个、以 `uaa::code::` 开头、
 * 长度 ≤ 2048。**路径不限**：console 是 SPA，拿到 code 后会路由走，
 * 按桌面端的 pathname 判据（`/`）会把登录码整段错过——2026-11-22 线上实测
 * 落点是 `/chat`。SSO 中途页 `/wechat?code=...` 带的是**微信侧** code，
 * origin 不符，天然被拒（拿它去兑换只会 `-40132`）。
 */
export function readSsoCode(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return null
  }
  if (parsed.origin !== CONSOLE_ORIGIN || parsed.hash) return null
  const codes = parsed.searchParams.getAll("code")
  if (codes.length !== 1) return null
  const code = codes[0] ?? ""
  return code.startsWith(CODE_PREFIX) && code.length <= 2048 ? code : null
}

/**
 * 登录码换 JWT：`POST /users/auth` `{code}` → `{code:0, data:{token}}`。
 *
 * 无效/已用返回 `-40132`（SSO authentication failed）——那说明这枚 code 被
 * 消费过了（典型原因：拦截没生效、落地页 SPA 已经加载过一次），只能重新扫码。
 */
export async function exchangeCode(
  code: string,
): Promise<Record<string, string>> {
  let response: Response
  try {
    response = await fetch(`${AUTH_API}/users/auth`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    })
  } catch (error) {
    throw new Error(
      `端砚登录码兑换请求失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`端砚登录码兑换响应不是 JSON（HTTP ${response.status}）`)
  }
  const record = body as Record<string, unknown> | null
  const code_text = String(record?.code ?? "")
  const data = record?.data as Record<string, unknown> | undefined
  const token = typeof data?.token === "string" ? data.token.trim() : ""
  if (
    code_text === "-40132"
    || response.status === 401
    || response.status === 403
  ) {
    throw new Error("端砚 SSO 登录码无效或已使用，请重新发起扫码登录")
  }
  if (
    (code_text !== "0" && code_text !== "200")
    || !token
    || token.length > 16384
  ) {
    throw new Error(`端砚登录码兑换失败（业务码 ${code_text || "缺失"}）`)
  }
  return { uaaToken: token }
}

export const inkstoneWebLogin: WebLoginProvider = {
  provider: "inkstone",
  loginUrl: LOGIN_URL,
  qrSelector: QR_SELECTOR,
  qrMinSize: 120,
  cookieDomains: COOKIE_DOMAINS,
  captureCode: readSsoCode,
  exchangeCode,
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
