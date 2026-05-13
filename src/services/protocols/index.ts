/**
 * Protocol Adapter 入口。在应用启动时调用 initializeProtocolAdapters()
 * 注册所有内置 adapter。Legacy provider(Copilot/Codebuff/Windsurf)继续
 * 使用 `src/services/providers/*` 的 ProviderRuntime,不通过此 registry。
 */

import { anthropicCompatibleAdapter } from "./anthropic-compatible"
import { openAICompatibleAdapter } from "./openai-compatible"
import { registerProtocolAdapter } from "./registry"

let initialized = false

export function initializeProtocolAdapters(): void {
  if (initialized) return
  registerProtocolAdapter(openAICompatibleAdapter)
  registerProtocolAdapter(anthropicCompatibleAdapter)
  initialized = true
}

export {
  getProtocolAdapter,
  listProtocolAdapters,
  registerProtocolAdapter,
  requireProtocolAdapter,
} from "./registry"
export type {
  AdapterChatResult,
  AdapterEmbeddingsResult,
  AdapterMessagesResult,
  AnthropicMessagesPayload,
  ProtocolAdapter,
} from "./types"
