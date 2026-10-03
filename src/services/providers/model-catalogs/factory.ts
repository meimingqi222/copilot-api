import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

const FACTORY_CATALOG: Array<CatalogEntry> = (
  [
    // Anthropic Messages wire (/api/llm/a)
    ["claude-fable-5.1", "Fable 5.1", "anthropic", "/v1/messages"],
    ["claude-fable-5", "Fable 5", "anthropic", "/v1/messages"],
    ["claude-opus-5-5", "Opus 5.5", "anthropic", "/v1/messages"],
    ["claude-opus-5", "Opus 5", "anthropic", "/v1/messages"],
    ["claude-opus-4-8", "Opus 4.8", "anthropic", "/v1/messages"],
    ["claude-sonnet-5-5", "Sonnet 5.5", "anthropic", "/v1/messages"],
    ["claude-sonnet-5", "Sonnet 5", "anthropic", "/v1/messages"],
    ["claude-sonnet-4-6", "Sonnet 4.6", "anthropic", "/v1/messages"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5", "anthropic", "/v1/messages"],
    ["minimax-m2.7", "MiniMax M2.7", "minimax", "/v1/messages"],
    // OpenAI Responses wire (/api/llm/o/v1)
    ["gpt-6-sol", "GPT-6 Sol", "openai", "/v1/responses"],
    ["gpt-6-astra", "GPT-6 Astra", "openai", "/v1/responses"],
    ["gpt-6-luna", "GPT-6 Luna", "openai", "/v1/responses"],
    ["gpt-5.6-sol", "GPT-5.6 Sol", "openai", "/v1/responses"],
    ["gpt-5.6-terra", "GPT-5.6 Terra", "openai", "/v1/responses"],
    ["gpt-5.6-luna", "GPT-5.6 Luna", "openai", "/v1/responses"],
    ["gpt-5.5", "GPT-5.5", "openai", "/v1/responses"],
    ["gpt-5.4", "GPT-5.4", "openai", "/v1/responses"],
    ["gpt-5.3-codex", "GPT-5.3-Codex", "openai", "/v1/responses"],
    ["grok-4.7", "Grok 4.7", "xai", "/v1/responses"],
    ["grok-4.6", "Grok 4.6", "xai", "/v1/responses"],
    // Chat Completions wire (/api/llm/o/v1) — Factory 自托管的开源模型
    ["glm-5.3", "GLM-5.3", "zhipu", "/chat/completions"],
    ["glm-5.3-flash", "GLM-5.3-Flash", "zhipu", "/chat/completions"],
    ["glm-5.2", "GLM-5.2", "zhipu", "/chat/completions"],
    ["kimi-k3", "Kimi K3", "moonshot", "/chat/completions"],
    [
      "deepseek-v4.1-flash",
      "DeepSeek V4.1 Flash",
      "deepseek",
      "/chat/completions",
    ],
    ["qwen3.8-max", "Qwen3.8 Max", "qwen", "/chat/completions"],
    ["minimax-m3", "MiniMax M3", "minimax", "/chat/completions"],
    [
      "mistral-medium-3.5",
      "Mistral Medium 3.5",
      "mistral",
      "/chat/completions",
    ],
    ["nemotron-3-ultra", "Nemotron 3 Ultra", "nvidia", "/chat/completions"],
  ] as const
).map(([id, name, vendor, endpoint]) => ({
  id,
  name,
  vendor,
  supportedEndpoints: [endpoint],
}))

export function getFactoryFallbackModels(): Array<ModelMapping> {
  return toModelMappings(FACTORY_CATALOG)
}
