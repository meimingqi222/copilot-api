/**
 * Windsurf Native Protocol Adapter。
 *
 * Phase 2b:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"

import { createOnceAdapter } from "./once-adapter"

export const windsurfNativeAdapter = createOnceAdapter({
  protocol: "windsurf-native",
  resolveDispatchModel: (target) => target.publicModelId,
  chat: createWindsurfChatCompletionsOnce,
})
