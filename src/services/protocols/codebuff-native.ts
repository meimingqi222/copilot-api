/**
 * Codebuff Native Protocol Adapter。
 *
 * Phase 2b:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createCodebuffChatCompletionsOnce } from "~/services/codebuff/create-chat-completions"

import { createOnceAdapter } from "./once-adapter"

export const codebuffNativeAdapter = createOnceAdapter({
  protocol: "codebuff-native",
  chat: createCodebuffChatCompletionsOnce,
})
