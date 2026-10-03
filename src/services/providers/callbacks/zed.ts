import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"
import {
  ZED_CALLBACK_PORT,
  ZED_SIGNIN_SUCCEEDED_URL,
} from "~/services/oauth/zed"

// Zed returns the user ID and encrypted token on any path, then shows its page.
export const zedCallbackConfig: OAuthCallbackConfig = {
  port: ZED_CALLBACK_PORT,
  hostname: "127.0.0.1",
  callbackPath: "/",
  providerLabel: "Zed",
  anyPath: true,
  queryParams: { code: "access_token", state: "user_id" },
  successRedirect: ZED_SIGNIN_SUCCEEDED_URL,
  skipStateCheck: true,
  combineIntoCode: true,
}
