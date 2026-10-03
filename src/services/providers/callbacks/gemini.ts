import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"
import {
  GEMINI_CALLBACK_PATH,
  GEMINI_CALLBACK_PORT,
} from "~/services/oauth/gemini"

export const geminiCallbackConfig: OAuthCallbackConfig = {
  port: GEMINI_CALLBACK_PORT,
  hostname: "127.0.0.1",
  callbackPath: GEMINI_CALLBACK_PATH,
  providerLabel: "Gemini CLI",
}
