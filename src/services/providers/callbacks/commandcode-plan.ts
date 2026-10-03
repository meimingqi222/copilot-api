import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"
import {
  COMMANDCODE_CALLBACK_PATH,
  COMMANDCODE_CALLBACK_PORT,
} from "~/services/oauth/commandcode"

// Studio POSTs the minted API key instead of redirecting with a code.
export const commandcodePlanCallbackConfig: OAuthCallbackConfig = {
  port: COMMANDCODE_CALLBACK_PORT,
  hostname: "127.0.0.1",
  callbackPath: COMMANDCODE_CALLBACK_PATH,
  providerLabel: "Command Code",
  mode: "post",
  corsOrigins: ["https://commandcode.ai", "https://staging.commandcode.ai"],
}
