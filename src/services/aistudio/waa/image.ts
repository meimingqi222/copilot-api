import type { WAAProfile } from "~/services/aistudio/waa/profile"
import type { WAARuntimeState } from "~/services/aistudio/waa/index"
import { withProxyUrl } from "~/services/oauth/fetch"

/** Only Google HTTPS images may receive the caller's already-filtered cookie. */
export async function fetchImage(options: {
  address: string
  state: WAARuntimeState
  profile: WAAProfile
  signal: AbortSignal
}): Promise<boolean> {
  const { address, state, profile, signal } = options
  try {
    const url = new URL(address)
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || !(
        url.hostname === "google.com" || url.hostname.endsWith(".google.com")
      )
    )
      return false
    const response = await fetch(
      url,
      withProxyUrl(
        {
          headers: {
            cookie: state.cookie,
            "user-agent": String(profile.Navigator.userAgent),
            "accept-language": "en-US,en;q=0.5",
            referer: profile.PageURL,
          },
          redirect: "error",
          signal,
        },
        state.proxyUrl,
      ),
    )
    const bytes = await response.arrayBuffer()
    return (
      response.status === 200
      && (response.headers.get("content-type") ?? "").startsWith("image/")
      && bytes.byteLength > 0
    )
  } catch {
    // An image error is an event, not a runtime failure. Never disclose URL/cookie.
    return false
  }
}
