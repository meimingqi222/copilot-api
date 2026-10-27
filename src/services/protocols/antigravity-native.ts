/**
 * Antigravity Native Protocol Adapter。
 *
 * Phase 2d:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createAntigravityChatCompletionsOnce } from "~/services/antigravity/create-chat-completions-once"

import { createOnceAdapter } from "./once-adapter"

export const antigravityNativeAdapter = createOnceAdapter({
  protocol: "antigravity-native",
  chat: createAntigravityChatCompletionsOnce,
})
