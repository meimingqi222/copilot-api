import { createHash } from "node:crypto"

export const AISTUDIO_ORIGIN = "https://aistudio.google.com"
export const AISTUDIO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0"

const SIGNATURE_COOKIES = [
  ["SAPISID", "SAPISIDHASH"],
  ["__Secure-1PAPISID", "SAPISID1PHASH"],
  ["__Secure-3PAPISID", "SAPISID3PHASH"],
] as const

/** Read stored cookies even after an upstream deletion removed a signing cookie. */
export function readCookieHeader(input: string): Map<string, string> {
  const header = input.trim().replace(/^cookie:\s*/i, "")
  if (
    [...header].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new Error("Paste the complete AI Studio request Cookie header.")
  const cookies = new Map<string, string>()
  for (const item of header.split(";").filter((part) => part.trim())) {
    const at = item.indexOf("=")
    const name = item.slice(0, at).trim()
    const value = item.slice(at + 1).trim()
    if (at < 1 || !/^[\w!#$%&'*+.^`|~-]+$/.test(name))
      throw new Error("Invalid Cookie header format.")
    cookies.set(name, value)
  }
  return cookies
}

/** Accept the browser request's complete Cookie header, never a single token. */
export function parseCookieHeader(input: string): Map<string, string> {
  if (!input.trim())
    throw new Error("Paste the complete AI Studio request Cookie header.")
  const cookies = readCookieHeader(input)
  for (const [name] of SIGNATURE_COOKIES) {
    if (!cookies.get(name))
      throw new Error(`The complete Cookie header must include ${name}.`)
  }
  return cookies
}

export type CookieUpdates = ReadonlyMap<string, string | undefined>

/** Only global Google cookies fit the imported Cookie header's shared scope.
 * Never promote host-only, path-scoped or partitioned cookies to all RPC hosts.
 */
export function responseCookieUpdates(headers: Headers): CookieUpdates {
  const updates = new Map<string, string | undefined>()
  for (const header of headers.getSetCookie()) {
    const cookie = Bun.Cookie.parse(header)
    if (
      !cookie
      || cookie.domain?.replace(/^\./, "").toLowerCase() !== "google.com"
      || cookie.path !== "/"
      || !/;\s*path\s*=\s*\/\s*(?:;|$)/i.test(header)
      || cookie.partitioned
    )
      continue
    const expired =
      cookie.maxAge !== undefined ?
        cookie.maxAge <= 0
      : cookie.expires !== undefined
        && new Date(cookie.expires).getTime() <= Date.now()
    updates.set(cookie.name, expired ? undefined : cookie.value)
  }
  return updates
}

export function cookieHeader(cookies: ReadonlyMap<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
}

export function signAuthorization(
  cookies: ReadonlyMap<string, string>,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  return SIGNATURE_COOKIES.map(([name, label]) => {
    const value = cookies.get(name)
    if (!value) throw new Error(`AI Studio Cookie is missing ${name}.`)
    const digest = createHash("sha1")
      .update(`${timestamp} ${value} ${AISTUDIO_ORIGIN}`)
      .digest("hex")
    return `${label} ${timestamp}_${digest}`
  }).join(" ")
}
