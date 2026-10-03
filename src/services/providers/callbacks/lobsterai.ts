import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"
import {
  LOBSTERAI_CALLBACK_PATH,
  LOBSTERAI_CALLBACK_PORT,
} from "~/services/oauth/lobsterai"

export const lobsteraiCallbackConfig: OAuthCallbackConfig = {
  port: LOBSTERAI_CALLBACK_PORT,
  hostname: "127.0.0.1",
  callbackPath: LOBSTERAI_CALLBACK_PATH,
  providerLabel: "LobsterAI",
}
