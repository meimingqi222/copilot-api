import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"

export const codexCallbackConfig: OAuthCallbackConfig = {
  port: 1455,
  callbackPath: "/auth/callback",
  providerLabel: "Codex",
}
