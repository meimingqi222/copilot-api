import type { AccountModel, OAuthAccount } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { canonicalNativeModelId } from "~/lib/accounts"

interface CatalogEntry {
  id: string
  name: string
  vendor: string
  supportedEndpoints: Array<string>
  pickerEnabled?: boolean
}

const CLAUDE_CATALOG: Array<CatalogEntry> = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude 4.6 Sonnet",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-opus-4-6",
    name: "Claude 4.6 Opus",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude 4.5 Haiku",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
]

const KIMI_CATALOG: Array<CatalogEntry> = [
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    vendor: "moonshot",
    supportedEndpoints: ["/chat/completions"],
  },
  {
    id: "kimi-k2",
    name: "Kimi K2",
    vendor: "moonshot",
    supportedEndpoints: ["/chat/completions"],
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    vendor: "moonshot",
    supportedEndpoints: ["/chat/completions"],
  },
]

const XAI_CATALOG: Array<CatalogEntry> = [
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-build-0.1",
    name: "Grok Build 0.1",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
]

const CODEX_CATALOG: Array<CatalogEntry> = [
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
]

const ANTIGRAVITY_CATALOG: Array<CatalogEntry> = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    vendor: "antigravity",
    supportedEndpoints: ["/chat/completions", "/v1/messages"],
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    vendor: "antigravity",
    supportedEndpoints: ["/chat/completions", "/v1/messages"],
  },
  {
    id: "gemini-pro-agent",
    name: "Gemini 3.1 Pro (High)",
    vendor: "antigravity",
    supportedEndpoints: ["/chat/completions", "/v1/messages"],
  },
]

const CATALOGS: Record<OAuthProviderId, Array<CatalogEntry>> = {
  claude: CLAUDE_CATALOG,
  kimi: KIMI_CATALOG,
  xai: XAI_CATALOG,
  codex: CODEX_CATALOG,
  antigravity: ANTIGRAVITY_CATALOG,
}

function toAccountModels(
  provider: OAuthProviderId,
  entries: Array<CatalogEntry>,
): Array<AccountModel> {
  return entries.map((entry) => ({
    id: canonicalNativeModelId(entry.id),
    name: entry.name,
    vendor: entry.vendor,
    pickerEnabled: entry.pickerEnabled ?? true,
    supportedEndpoints: entry.supportedEndpoints,
    provider,
  }))
}

export function getOAuthFallbackModels(
  account: OAuthAccount,
): Array<AccountModel> {
  return toAccountModels(account.provider, CATALOGS[account.provider])
}
