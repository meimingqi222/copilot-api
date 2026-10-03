import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"

export const claudeCallbackConfig: OAuthCallbackConfig = {
  port: 54545,
  callbackPath: "/callback",
  providerLabel: "Claude",
}
