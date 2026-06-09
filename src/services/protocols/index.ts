/**
 * Protocol Adapter 入口。在应用启动时调用 initializeProtocolAdapters()
 * 注册所有内置 adapter。
 */

import { anthropicCompatibleAdapter } from "./anthropic-compatible"
import { codebuffNativeAdapter } from "./codebuff-native"
import { copilotNativeAdapter } from "./copilot-native"
import { mimoNativeAdapter } from "./mimo-native"
import { openAICompatibleAdapter } from "./openai-compatible"
import { registerProtocolAdapter } from "./registry"
import { windsurfNativeAdapter } from "./windsurf-native"

let initialized = false

export function initializeProtocolAdapters(): void {
  if (initialized) return
  registerProtocolAdapter(openAICompatibleAdapter)
  registerProtocolAdapter(anthropicCompatibleAdapter)
  registerProtocolAdapter(copilotNativeAdapter)
  registerProtocolAdapter(codebuffNativeAdapter)
  registerProtocolAdapter(windsurfNativeAdapter)
  registerProtocolAdapter(mimoNativeAdapter)
  initialized = true
}

export { getProtocolAdapter, registerProtocolAdapter } from "./registry"
export type {
  AdapterChatResult,
  AdapterEmbeddingsResult,
  AdapterMessagesResult,
  AnthropicMessagesPayload,
  ProtocolAdapter,
} from "./types"
