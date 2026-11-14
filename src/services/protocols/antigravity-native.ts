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
  // Keep the client-facing head id in payload.model; the adapter resolves
  // the effort-selected upstream SKU from connection.models (same as
  // Windsurf). Dispatch's default would overwrite it with the head's
  // default-tier upstreamId and lose the client's reasoning_effort.
  resolveDispatchModel: (target) => target.publicModelId,
  chat: createAntigravityChatCompletionsOnce,
})
