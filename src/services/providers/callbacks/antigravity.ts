import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"

export const antigravityCallbackConfig: OAuthCallbackConfig = {
  port: 51121,
  hostname: "localhost",
  callbackPath: "/oauth-callback",
  providerLabel: "Antigravity",
}
