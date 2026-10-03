import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"
import {
  WINDSURF_CALLBACK_PATH,
  WINDSURF_CALLBACK_PORT,
} from "~/services/oauth/windsurf"

// Devin requires the same loopback host and port as WINDSURF_REDIRECT_URI.
export const windsurfCallbackConfig: OAuthCallbackConfig = {
  port: WINDSURF_CALLBACK_PORT,
  hostname: "127.0.0.1",
  callbackPath: WINDSURF_CALLBACK_PATH,
  providerLabel: "Devin",
}
