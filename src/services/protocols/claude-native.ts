/**
 * Claude Native Protocol Adapter。
 *
 * Phase 2d:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { createClaudeMessagesOnce } from "~/services/claude/create-messages-once"

import { createOnceAdapter } from "./once-adapter"

export const claudeNativeAdapter = createOnceAdapter({
  protocol: "claude-native",
  messages: createClaudeMessagesOnce,
})
