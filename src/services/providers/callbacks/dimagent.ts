import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"
import {
  DIMAGENT_CALLBACK_PATH,
  DIMAGENT_CALLBACK_PORT,
} from "~/services/oauth/dimagent"

export const dimagentCallbackConfig: OAuthCallbackConfig = {
  port: DIMAGENT_CALLBACK_PORT,
  hostname: "127.0.0.1",
  callbackPath: DIMAGENT_CALLBACK_PATH,
  providerLabel: "DimAgent",
}
