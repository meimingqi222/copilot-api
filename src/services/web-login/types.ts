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
