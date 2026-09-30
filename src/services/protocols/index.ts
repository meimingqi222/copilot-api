/**
 * Protocol Adapter 入口。在应用启动时调用 initializeProtocolAdapters()
 * 注册所有内置 adapter。
 */

import { anthropicCompatibleAdapter } from "./anthropic-compatible"
import { antigravityNativeAdapter } from "./antigravity-native"
import { claudeNativeAdapter } from "./claude-native"
import { codebuddyNativeAdapter } from "./codebuddy-native"
import { codebuffNativeAdapter } from "./codebuff-native"
import { codexNativeAdapter } from "./codex-native"
import { copilotNativeAdapter } from "./copilot-native"
import { geminiCompatibleAdapter } from "./gemini-compatible"
import { kimiNativeAdapter } from "./kimi-native"
import { lobsteraiNativeAdapter } from "./lobsterai-native"
import { mimoNativeAdapter } from "./mimo-native"
import { minimaxNativeAdapter } from "./minimax-native"
import { openAICompatibleAdapter } from "./openai-compatible"
import { openAIResponsesCompatibleAdapter } from "./openai-responses"
import { qoderNativeAdapter } from "./qoder-native"
import { registerProtocolAdapter } from "./registry"
import { windsurfNativeAdapter } from "./windsurf-native"
import { xaiNativeAdapter } from "./xai-native"

let initialized = false

export function initializeProtocolAdapters(): void {
  if (initialized) return
  registerProtocolAdapter(openAICompatibleAdapter)
  registerProtocolAdapter(openAIResponsesCompatibleAdapter)
  registerProtocolAdapter(anthropicCompatibleAdapter)
  registerProtocolAdapter(geminiCompatibleAdapter)
  registerProtocolAdapter(copilotNativeAdapter)
  registerProtocolAdapter(codebuffNativeAdapter)
  registerProtocolAdapter(windsurfNativeAdapter)
  registerProtocolAdapter(mimoNativeAdapter)
  registerProtocolAdapter(minimaxNativeAdapter)
  registerProtocolAdapter(antigravityNativeAdapter)
  registerProtocolAdapter(claudeNativeAdapter)
  registerProtocolAdapter(kimiNativeAdapter)
  registerProtocolAdapter(codexNativeAdapter)
  registerProtocolAdapter(xaiNativeAdapter)
  registerProtocolAdapter(codebuddyNativeAdapter)
  registerProtocolAdapter(lobsteraiNativeAdapter)
  registerProtocolAdapter(qoderNativeAdapter)
  initialized = true
}

export { createChatViaMessages } from "./chat-via-messages"
export { getProtocolAdapter, registerProtocolAdapter } from "./registry"
export { createResponsesViaChat } from "./responses-via-chat"
export type {
  AdapterChatResult,
  AdapterEmbeddingsResult,
  AdapterGeminiResult,
  AdapterMessagesResult,
  AdapterResponsesResult,
  AnthropicMessagesPayload,
  ProtocolAdapter,
} from "./types"
