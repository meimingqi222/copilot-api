/**
 * Kimi Native Protocol Adapter。
 *
 * Phase 2d:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createKimiChatCompletionsOnce } from "~/services/kimi/create-chat-completions-once"

import { createOnceAdapter } from "./once-adapter"

export const kimiNativeAdapter = createOnceAdapter({
  protocol: "kimi-native",
  chat: createKimiChatCompletionsOnce,
})
