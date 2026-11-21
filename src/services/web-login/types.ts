import type { ProviderId } from "~/lib/provider-config"

/** A browser cookie as Chrome reports it over CDP. */
export interface WebLoginCookie {
  name: string
  value: string
  domain: string
  path: string
  /** Epoch seconds; `0`/negative means a session cookie. */
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

/**
 * Per-provider sign-in page and session extraction.
 *
 * The credential record returned by `credentials()` is fed straight into the
 * provider's `accountCreation.prepare`, so a scanned sign-in and a pasted one
 * share one validation path (and one place that mints derived tokens).
 */
export interface WebLoginProvider {
  provider: ProviderId
  /** Vendor sign-in page opened in the headless browser. */
  loginUrl: string
  /**
   * Element that renders the QR code; its screenshot is shown to the user.
   * May be a container (an element wrapping an iframe), not only an `<img>`.
   */
  qrSelector: string
  /**
   * Substring the QR image's URL must contain (default `qrcode`).
   *
   * 登录页常先放一张 loading 占位图（尺寸和二维码一样大），只判「图加载完了」
   * 会把占位图截给用户；判 src 里的关键字才不会认错（讯飞/百度/WPS 的二维码
   * 地址都带 qrcode）。嵌 iframe 的提供方用不到这个字段。
   */
  qrSrcHint?: string
  /** Smallest QR edge (CSS pixels) accepted as "rendered". */
  qrMinSize?: number
  /** Cookie domains worth capturing, matched as a domain suffix. */
  cookieDomains: ReadonlyArray<string>
  /**
   * 回跳导航里的登录码判据（可选）。
   *
   * 落地页是会自己消费登录码的 SPA、且登录码一次性时（书生·端砚的
   * `uaa::code::`），必须拦下这次导航自己兑换——让 SPA 加载等于把 code
   * 烧掉（桌面端同款 `preventDefault`）。判据要严：origin + 前缀；SSO
   * 中途页带的**厂商侧** code（端砚的 `/wechat?code=`）拿去兑换只会被拒。
   */
  captureCode?(url: string): string | null
  /**
   * 用拦截到的登录码换凭证（可选）。返回的记录直接进
   * `accountCreation.prepare` 的 credentials，与 Cookie 那条路同一套校验。
   * 失败必须抛错：兑换只跑一次，重试只会再撞一次同样的拒绝。
   */
  exchangeCode?(code: string): Promise<Record<string, string>>
  /** Credential record for `accountCreation.prepare`; `undefined` = not signed in yet. */
  credentials(
    cookies: ReadonlyArray<WebLoginCookie>,
  ): Record<string, string> | undefined
  /**
   * Extra `prepare` **settings** (not credentials), e.g. InkStone's
   * "create an API key with this console session" consent.
   */
  settings?(): Record<string, unknown> | undefined
}

/** Live browser session owned by a pending flow. */
export interface WebLoginBrowser {
  /** Screenshot of the QR element as a data URL. */
  qrImage(): Promise<string>
  /** Cookies captured so far, already filtered to the provider's domains. */
  cookies(): Promise<Array<WebLoginCookie>>
  /**
   * 拦截到的回跳登录码（provider 没有 `captureCode` 或还没出现时为 null）。
   *
   * 拿到码的那次文档导航会被 abort，落地页 SPA 不会加载——所以 Cookie
   * 那条路对拦截型 provider 是兜底而不是主路径。
   */
  code(): string | null
  close(): Promise<void>
}

type WebLoginStatus = "pending" | "complete" | "error" | "expired" | "cancelled"

export interface WebLoginFlow {
  id: string
  provider: ProviderId
  label: string
  status: WebLoginStatus
  expiresAt: number
  /** Seconds between polls; the UI also re-asks on every response. */
  interval: number
  qrImage?: string
  accountId?: string
  error?: string
  /**
   * 终态落定时。多标签页或重试会再 poll 一次，终态流程要能原样返回同一个
   * 结论（OAuth flow 对 complete 也是这个语义），所以不立即从表里删掉。
   */
  settledAt?: number
  /** In-memory only: the browser that stays open while the user scans. */
  browser?: WebLoginBrowser
  /** In-memory only: per-connection proxy chosen when the flow started. */
  proxyUrl?: string
}

/** Everything a provider needs to turn a scanned session into a connection. */
export interface WebLoginStartOptions {
  label: string
  proxyUrl?: string
}
