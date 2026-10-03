/** Provider-owned settings for the shared loopback OAuth callback server. */
export interface OAuthCallbackConfig {
  port: number
  hostname?: string
  callbackPath: string
  providerLabel: string
  /** "post" when the provider's page POSTs the result. */
  mode?: "query" | "post"
  corsOrigins?: Array<string>
  /** Some providers return on whichever path their authorization page chose. */
  anyPath?: boolean
  queryParams?: { code: string; state: string }
  successRedirect?: string
  /** Zed sends its own user_id instead of the client's OAuth state. */
  skipStateCheck?: boolean
  /** Deliver both callback values as `<state>\u0000<code>`. */
  combineIntoCode?: boolean
}
