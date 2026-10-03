import { anthropicCompatibleAdapter } from "~/services/protocols/anthropic-compatible"
import { geminiCompatibleAdapter } from "~/services/protocols/gemini-compatible"
import { openAICompatibleAdapter } from "~/services/protocols/openai-compatible"
import { openAIResponsesCompatibleAdapter } from "~/services/protocols/openai-responses"
import { registerProtocolAdapter } from "~/services/protocols/registry"
import { listBuiltinProviderModules } from "~/services/providers/builtins"
import { validateProviderModules } from "~/services/providers/module"

let initialized = false

export function initializeProtocolAdapters(): void {
  if (initialized) return
  const modules = listBuiltinProviderModules()
  validateProviderModules(modules)
  const adapters = new Set([
    openAICompatibleAdapter,
    openAIResponsesCompatibleAdapter,
    anthropicCompatibleAdapter,
    geminiCompatibleAdapter,
    ...modules.map((module) => module.adapter),
  ])
  for (const adapter of adapters) registerProtocolAdapter(adapter)
  initialized = true
}

export { getProtocolAdapter } from "~/services/protocols/registry"
export type {
  AdapterChatResult,
  AdapterGeminiResult,
  AdapterMessagesResult,
  AdapterResponsesResult,
  AnthropicMessagesPayload,
} from "~/services/protocols/types"
