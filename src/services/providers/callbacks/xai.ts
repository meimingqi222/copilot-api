import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"

export const xaiCallbackConfig: OAuthCallbackConfig = {
  port: 56121,
  hostname: "127.0.0.1",
  callbackPath: "/callback",
  providerLabel: "xAI",
}
