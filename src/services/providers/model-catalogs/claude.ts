import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

/**
 * Claude 目录的**离线兜底**。
 *
 * 正常路径由 `services/claude/get-models.ts` 从上游 `GET /v1/models` 实时发现,
 * 这里只在发现失败(网络/上游变更)时兜底,所以它应该与上游保持一致 ——
 * 但不该是唯一真相:写死的列表迟早会落后于上游发版(这份表就曾经停在
 * sonnet-4-6 / opus-4-6 / haiku-4-5,导致新模型在 UI 里完全不可见)。
 */
const CLAUDE_CATALOG: Array<CatalogEntry> = [
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-opus-4-5-20251101",
    name: "Claude Opus 4.5",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
]

export function getClaudeFallbackModels(): Array<ModelMapping> {
  return toModelMappings(CLAUDE_CATALOG)
}
